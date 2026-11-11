import Foundation
import Testing
@testable import BasedCore

/// Thread-safe persistence whose writes fail while `failing` is set (the writer calls it on its own queue).
final class LockedFailingPersistence: ChangeLogging, @unchecked Sendable {
    private let lock = NSLock()
    private let inner = MemoryPersistence()
    private var _failing = false
    struct DiskFull: Error, CustomStringConvertible { var description: String { "disk full" } }

    var failing: Bool {
        get { lock.withLock { _failing } }
        set { lock.withLock { _failing = newValue } }
    }
    var records: [RecordKey: Record] { lock.withLock { inner.records } }
    var writes: Int { lock.withLock { inner.writes } }

    func loadAll() throws -> [Record] { try lock.withLock { try inner.loadAll() } }
    func write(upserts: [Record], deletions: [RecordKey]) throws { try write(upserts: upserts, deletions: deletions, local: true) }
    func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {
        try write(upserts: upserts, deletions: deletions, tombstones: [:], local: local)
    }
    func write(upserts: [Record], deletions: [RecordKey], tombstones: [RecordKey: Stamp], local: Bool) throws {
        try lock.withLock {
            if _failing { throw DiskFull() }
            try inner.write(upserts: upserts, deletions: deletions, tombstones: tombstones, local: local)
        }
    }
    func checkWritable() throws { if failing { throw DiskFull() } }
    func changes(after: Int64, limit: Int) throws -> [ChangeEntry] { try lock.withLock { try inner.changes(after: after, limit: limit) } }
    var lastChangeSeq: Int64 { lock.withLock { inner.lastChangeSeq } }
    func tombstone(_ key: RecordKey) -> Stamp? { lock.withLock { inner.tombstone(key) } }
    func meta(_ key: String) -> Data? { lock.withLock { inner.meta(key) } }
    func setMeta(_ key: String, _ value: Data?) { lock.withLock { inner.setMeta(key, value) } }
}

/// BSD-42: commits enqueue their records; a background writer saves them in order.
@MainActor
@Suite struct PersistenceWriterTests {
    private func tempDB() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("writer-\(UUID().uuidString)/based.sqlite")
    }

    @Test func tenThousandTransactionsAreAllSavedAfterFlush() async throws {
        let url = tempDB()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var ids: [RecordID] = []
        var lastText: [RecordID: String] = [:]
        do {
            let writer = PersistenceWriter(try SQLitePersistence(url: url))
            let s = WorkspaceStore(persistence: writer, node: "a")
            let page = s.createPage(title: "Bulk")
            for i in 0..<100 { ids.append(s.insertBlock(.text, text: RichText("block \(i)"), in: .block(page))) }
            // 10 000 transactions: typing into the 100 blocks, round robin.
            for i in 0..<9_899 {
                let id = ids[i % ids.count]
                let text = "block \(i % ids.count) edit \(i)"
                s.setText(id, RichText(text))
                lastText[id] = text
            }
            #expect(await s.flush())
            #expect(s.unsavedChangeCount == 0)
            #expect(!s.isReadOnly)
            // Coalescing: far fewer SQLite transactions than commits is fine, but never more.
            #expect(writer.writtenBatches <= 10_001)
            ids.append(page)
        }
        // Reopen the file: everything is there.
        let reopened = try SQLitePersistence(url: url)
        let s2 = WorkspaceStore(persistence: reopened, node: "a")
        for (id, text) in lastText { #expect(s2.blocks[id]?.text.plainText == text) }
        #expect(s2.blocks[ids.last!]?.type == .page)
        // The change log has exactly one (newest) entry per record, without gaps in coverage.
        let log = try reopened.changes(after: 0, limit: 100_000)
        let logged = Set(log.map(\.key))
        for r in s2.allRecords() { #expect(logged.contains(r.key)) }
        #expect(log.count == logged.count)
        #expect(log.map(\.seq) == log.map(\.seq).sorted())
        #expect(reopened.lastChangeSeq == log.last?.seq)
    }

    @Test func readsWaitForQueuedWrites() throws {
        let writer = PersistenceWriter(MemoryPersistence())
        let s = WorkspaceStore(persistence: writer, node: "a")
        let before = writer.lastChangeSeq
        let page = s.createPage(title: "Seen by sync")
        // No explicit flush: the log read drains the queue first.
        let entries = try writer.changes(after: before, limit: 100)
        #expect(entries.contains { $0.key == RecordKey(.block, page) })
        #expect(writer.lastChangeSeq > before)
    }

    @Test func metaWritesKeepOrderWithRecords() throws {
        let base = MemoryPersistence()
        let writer = PersistenceWriter(base)
        let s = WorkspaceStore(persistence: writer, node: "a")
        let page = s.createPage(title: "A")
        writer.setMeta("cursor", Data("1".utf8))
        #expect(writer.meta("cursor") == Data("1".utf8))
        #expect(writer.flushNow())
        #expect(base.records[RecordKey(.block, page)] != nil)
        #expect(base.metaValues["cursor"] == Data("1".utf8))
        // The node id written in the store's init went through the writer too.
        #expect(base.metaValues["node"] == nil || base.metaValues["node"] == Data("a".utf8))
    }

    @Test func coalescingKeepsTheLastChangePerKey() {
        let a = Block(type: .text, parent: .workspace, sortKey: "a", text: "one")
        var a2 = a; a2.text = "two"
        let b = Block(type: .text, parent: .workspace, sortKey: "b", text: "b")
        let stamp = Stamp(millis: 5, counter: 0, node: "x")
        typealias B = PersistenceWriter.Batch
        // Upsert, then upsert again, then delete b; a's last version wins, b ends as a stamped deletion.
        let merged = PersistenceWriter.merge(
            PersistenceWriter.merge(B(upserts: [.block(a), .block(b)], deletions: [], tombstones: [:], local: true),
                                    B(upserts: [.block(a2)], deletions: [], tombstones: [:], local: true)),
            B(upserts: [], deletions: [RecordKey(.block, b.id)], tombstones: [RecordKey(.block, b.id): stamp], local: true))
        #expect(merged.upserts == [Record.block(a2)])
        #expect(merged.deletions == [RecordKey(.block, b.id)])
        #expect(merged.tombstones[RecordKey(.block, b.id)] == stamp)
        // Delete, then recreate: only the upsert remains.
        let revived = PersistenceWriter.merge(
            B(upserts: [], deletions: [RecordKey(.block, a.id)], tombstones: [RecordKey(.block, a.id): stamp], local: true),
            B(upserts: [.block(a2)], deletions: [], tombstones: [:], local: true))
        #expect(revived.upserts == [Record.block(a2)])
        #expect(revived.deletions.isEmpty)
        #expect(revived.tombstones.isEmpty)
        // Batches with a different `local` flag are never merged into one run.
        let run = PersistenceWriter.takeRun([
            .records(B(upserts: [.block(a)], deletions: [], tombstones: [:], local: true)),
            .records(B(upserts: [.block(b)], deletions: [], tombstones: [:], local: true)),
            .records(B(upserts: [.block(a2)], deletions: [], tombstones: [:], local: false)),
        ])
        #expect(run.count == 2)
        // A meta value is its own run.
        #expect(PersistenceWriter.takeRun([.meta("k", nil), .records(B(upserts: [.block(a)], deletions: [], tombstones: [:], local: true))]).count == 1)
    }

    @Test func failedBackgroundWriteMakesStoreReadOnlyAndRetrySavesEverything() {
        let base = LockedFailingPersistence()
        let writer = PersistenceWriter(base)
        let s = WorkspaceStore(persistence: writer, node: "a")
        let page = s.createPage(title: "A")
        #expect(s.flushWrites())
        var notified = 0
        s.onWriteFailureChanged = { notified += 1 }

        base.failing = true
        s.setText(page, "B")                       // enqueued; visible in memory, can't be rolled back any more
        #expect(s.blocks[page]?.text.plainText == "B")
        #expect(s.flushWrites() == false)          // the write failed in the background
        #expect(writer.failure != nil)
        #expect(s.unsavedChangeCount == 1)

        // The next commit notices the failure: store read-only, this edit rejected (rolled back).
        s.setText(page, "C")
        #expect(s.isReadOnly)
        #expect(s.writeFailure?.message == "disk full")
        #expect(s.blocks[page]?.text.plainText == "B")
        #expect(notified == 1)
        #expect(base.records[RecordKey(.block, page)].flatMap { if case .block(let b) = $0 { b.text.plainText } else { nil } } == "A")

        // Retry fails while the disk still fails, keeps the unsaved change.
        #expect(s.retryWrites() == false)
        #expect(s.unsavedChangeCount == 1)

        base.failing = false
        #expect(s.retryWrites())
        #expect(!s.isReadOnly)
        #expect(s.unsavedChangeCount == 0)
        #expect(writer.failure == nil)
        #expect(base.records[RecordKey(.block, page)].flatMap { if case .block(let b) = $0 { b.text.plainText } else { nil } } == "B")
        // Writes go through again.
        s.setText(page, "D")
        #expect(s.flushWrites())
        #expect(base.records[RecordKey(.block, page)].flatMap { if case .block(let b) = $0 { b.text.plainText } else { nil } } == "D")
    }

    @Test func lateFailureNotificationAfterRetryIsIgnored() async {
        let base = LockedFailingPersistence()
        let writer = PersistenceWriter(base)
        let s = WorkspaceStore(persistence: writer, node: "a")
        let page = s.createPage(title: "A")
        base.failing = true
        s.setText(page, "B")
        _ = s.flushWrites()
        base.failing = false
        s.backgroundWriteFailed(LockedFailingPersistence.DiskFull())
        #expect(s.isReadOnly)
        #expect(s.retryWrites())
        // The Task the writer scheduled on failure runs now: it must not flip the store back to read-only.
        await Task.yield()
        s.backgroundWriteFailed(LockedFailingPersistence.DiskFull())
        #expect(!s.isReadOnly)
    }

    @Test func flushSyncReturnsWhenSaved() {
        let writer = PersistenceWriter(MemoryPersistence())
        let s = WorkspaceStore(persistence: writer, node: "a")
        for i in 0..<200 { _ = s.createPage(title: RichText("P\(i)")) }
        #expect(s.flushSync(timeout: 5))
        #expect(writer.pendingCount == 0)
    }

    /// Main-thread cost of one keystroke in a 50k-record workspace with the writer (encoding + SQLite run on the
    /// writer's queue). Target (BSD-42): < 0.2 ms in release; Debug + CI machines get a loose bound.
    @Test func keystrokeCommitCostOnMainIsSmall() async throws {
        let url = tempDB()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let sqlite = try SQLitePersistence(url: url)
        var records: [Record] = [.workspace(Workspace())]
        let parent = Block(type: .page, parent: .workspace, sortKey: "a", text: "Big")
        records.append(.block(parent))
        for i in 0..<50_000 {
            records.append(.block(Block(type: .text, parent: .block(parent.id), sortKey: String(format: "b%06d", i),
                                        text: RichText("Paragraph \(i) with some text to encode"))))
        }
        try sqlite.write(upserts: records, deletions: [])
        let s = WorkspaceStore(persistence: PersistenceWriter(sqlite), node: "a")
        let target = records.last!.key.id
        var text = "Paragraph"
        let n = 500
        let start = DispatchTime.now().uptimeNanoseconds
        for i in 0..<n {
            text.append(Character(UnicodeScalar(97 + i % 26)!))
            s.setText(target, RichText(text))
        }
        let perCommit = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 / Double(n)
        print("BENCH keystroke commit on main with PersistenceWriter, 50k workspace: \(String(format: "%.3f", perCommit)) ms")
        #expect(await s.flush())
        #expect(perCommit < 2.0)
        #expect(try SQLitePersistence(url: url).rawRow(RecordKey(.block, target)) != nil)
    }
}
