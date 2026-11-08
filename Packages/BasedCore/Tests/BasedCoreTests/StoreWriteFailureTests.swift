import Foundation
import Testing
@testable import BasedCore

/// Persistence whose writes fail while `failing` is set (disk full, permissions, …).
final class FailingPersistence: ChangeLogging {
    let inner: MemoryPersistence
    var failing = false
    var failLoad = false
    struct DiskFull: Error, CustomStringConvertible { var description: String { "disk full" } }

    init(_ initial: [Record] = []) { inner = MemoryPersistence(initial) }
    func loadAll() throws -> [Record] {
        if failLoad { throw DiskFull() }
        return try inner.loadAll()
    }
    func write(upserts: [Record], deletions: [RecordKey]) throws { try write(upserts: upserts, deletions: deletions, local: true) }
    func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {
        if failing { throw DiskFull() }
        try inner.write(upserts: upserts, deletions: deletions, local: local)
    }
    func changes(after: Int64, limit: Int) throws -> [ChangeEntry] { try inner.changes(after: after, limit: limit) }
    var lastChangeSeq: Int64 { inner.lastChangeSeq }
    func meta(_ key: String) -> Data? { inner.meta(key) }
    func setMeta(_ key: String, _ value: Data?) { inner.setMeta(key, value) }
}

/// BSD-15: a failed write is visible, rolled back and blocks further changes until a retry succeeds.
@MainActor
@Suite struct StoreWriteFailureTests {
    @Test func failedWriteRollsBackAndBlocks() {
        let p = FailingPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        let page = s.createPage(title: "Kept")
        let blocksBefore = s.blocks
        let undoBefore = s.undoActionName
        var observed = 0
        let token = s.observe { _ in observed += 1 }
        var localChanges = 0
        s.onLocalChange = { _ in localChanges += 1 }
        var notified = 0
        s.onWriteFailureChanged = { notified += 1 }

        p.failing = true
        s.setText(page, "Lost?")
        #expect(s.blocks == blocksBefore)
        #expect(s.blocks[page]?.text.plainText == "Kept")
        #expect(s.undoActionName == undoBefore)
        #expect(observed == 0)
        #expect(localChanges == 0)
        #expect(s.writeFailure != nil)
        #expect(s.writeFailure?.message == "disk full")
        #expect(s.isReadOnly)
        #expect(notified == 1)
        _ = token
    }

    @Test func readOnlyUntilRetrySucceeds() throws {
        let p = FailingPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        let page = s.createPage(title: "A")
        p.failing = true
        s.setText(page, "B")
        #expect(s.isReadOnly)

        // Disk works again, but the store stays read-only until someone retries.
        p.failing = false
        #expect(throws: StoreError.self) { try s.tryTransact("Edit") { tx in tx.update(page) { $0.text = "C" } } }
        s.setText(page, "D")
        #expect(s.blocks[page]?.text.plainText == "A")
        let created = s.createPage(title: "New")
        #expect(s.blocks[created] == nil)
        #expect((s.writeFailure?.rejected ?? 0) >= 3)

        // Retry fails while the disk still fails.
        p.failing = true
        #expect(s.retryWrites() == false)
        #expect(s.isReadOnly)

        p.failing = false
        #expect(s.retryWrites())
        #expect(!s.isReadOnly)
        try s.tryTransact("Edit") { tx in tx.update(page) { $0.text = "E" } }
        #expect(s.blocks[page]?.text.plainText == "E")
        #expect(p.inner.records[RecordKey(.block, page)].map { if case .block(let b) = $0 { return b.text.plainText } else { return "" } } == "E")
    }

    @Test func undoIsKeptWhenItCannotBeSaved() {
        let p = FailingPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        let page = s.createPage(title: "A")
        s.breakUndoCoalescing()
        s.setText(page, "B")
        p.failing = true
        s.undo()
        #expect(s.blocks[page]?.text.plainText == "B")
        #expect(s.canUndo)
        p.failing = false
        #expect(s.retryWrites())
        s.undo()
        #expect(s.blocks[page]?.text.plainText == "A")
    }

    @Test func remoteChangesArePausedAndAppliedAfterRetry() {
        let p = FailingPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        let other = WorkspaceStore(persistence: MemoryPersistence(), node: "b")
        let remotePage = other.createPage(title: "From elsewhere")
        let record = other.record(RecordKey(.block, remotePage))!

        p.failing = true
        _ = s.createPage(title: "x")      // fails → read-only
        #expect(s.isReadOnly)
        p.failing = false
        let stale = s.applyRemote([record])
        #expect(stale.isEmpty)
        #expect(s.blocks[remotePage] == nil)
        #expect(p.inner.records[RecordKey(.block, remotePage)] == nil)

        #expect(s.retryWrites())
        #expect(s.blocks[remotePage]?.text.plainText == "From elsewhere")
        #expect(p.inner.records[RecordKey(.block, remotePage)] != nil)
    }

    @Test func failingRemoteWriteIsQueuedNotLost() {
        let p = FailingPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        let other = WorkspaceStore(persistence: MemoryPersistence(), node: "b")
        let remotePage = other.createPage(title: "R")
        p.failing = true
        s.applyRemote([other.record(RecordKey(.block, remotePage))!])
        #expect(s.isReadOnly)
        #expect(s.blocks[remotePage] == nil)
        p.failing = false
        #expect(s.retryWrites())
        #expect(s.blocks[remotePage] != nil)
    }

    @Test func loadFailureStartsReadOnlyWithoutWriting() {
        let seed = WorkspaceStore(persistence: MemoryPersistence(), node: "s")
        let page = seed.createPage(title: "On disk")
        let p = FailingPersistence(seed.allRecords())
        p.failLoad = true
        let writesBefore = p.inner.writes
        let s = WorkspaceStore(persistence: p, node: "a")
        #expect(s.isReadOnly)
        #expect(s.blocks.isEmpty)
        #expect(p.inner.writes == writesBefore)   // no "Create workspace" written over the unread data
        _ = s.createPage(title: "ignored")
        #expect(p.inner.writes == writesBefore)

        p.failLoad = false
        #expect(s.retryWrites())
        #expect(s.blocks[page]?.text.plainText == "On disk")
        #expect(s.workspace.id == seed.workspace.id)
    }

    @Test func sqliteCheckWritable() throws {
        let p = try SQLitePersistence(url: nil)
        #expect(!p.isReadOnly)
        try p.checkWritable()
    }
}

/// BSD-15: opening the workspace file never falls back silently.
@Suite struct WorkspaceOpenerTests {
    func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("opener-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func opensAndCreatesFile() throws {
        let d = tempDir().appendingPathComponent("Based", isDirectory: true)
        let r = WorkspaceOpener.open(directory: d)
        let p = try r.get()
        #expect(!p.isReadOnly)
        #expect(FileManager.default.fileExists(atPath: d.appendingPathComponent("based.sqlite").path))
    }

    @Test func directoryThatCannotBeCreatedFails() throws {
        let root = tempDir()
        let blocker = root.appendingPathComponent("file")
        try Data("x".utf8).write(to: blocker)
        let d = blocker.appendingPathComponent("Based", isDirectory: true)
        guard case .failure(let e) = WorkspaceOpener.open(directory: d) else { Issue.record("expected failure"); return }
        if case .cannotCreateDirectory = e {} else { Issue.record("wrong error \(e)") }
        // Also a file in place of the folder itself.
        guard case .failure = WorkspaceOpener.open(directory: blocker) else { Issue.record("expected failure"); return }
        #expect(try Data(contentsOf: blocker) == Data("x".utf8))   // untouched
    }

    @Test func fileThatIsNotADatabaseFailsAndIsKept() throws {
        let d = tempDir()
        let file = d.appendingPathComponent("based.sqlite")
        let garbage = Data(repeating: 0x42, count: 4096)
        try garbage.write(to: file)
        guard case .failure(let e) = WorkspaceOpener.open(directory: d) else { Issue.record("expected failure"); return }
        #expect(e.path == file.path)
        #expect(try Data(contentsOf: file) == garbage)   // never deleted or replaced
    }

    @Test(.enabled(if: getuid() != 0, "root ignores file permissions"))
    func readOnlyDirectoryFails() throws {
        let d = tempDir()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: d.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: d.path) }
        guard case .failure = WorkspaceOpener.open(directory: d) else { Issue.record("expected failure"); return }
        #expect(!FileManager.default.fileExists(atPath: d.appendingPathComponent("based.sqlite").path))
    }
}
