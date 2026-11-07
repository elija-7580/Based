import Foundation
#if canImport(SQLite3)
import SQLite3
#endif
import Testing
@testable import BasedCore

/// Real-workspace load benchmark. Runs only when BASED_BENCH_DB points at a copy of a based.sqlite.
struct LoadBenchmarkTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BASED_BENCH_DB"] != nil))
    @MainActor func loadPhases() throws {
        let path = ProcessInfo.processInfo.environment["BASED_BENCH_DB"]!
        let p = try SQLitePersistence(url: URL(fileURLWithPath: path))
        var t = Date()
        let records = try p.loadAll()
        let load = Date().timeIntervalSince(t)
        t = Date()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "bench")
        let index = Date().timeIntervalSince(t)
        t = Date()
        var bytes = 0
        for r in records { bytes += (try? r.encoded().count) ?? 0 }
        let encode = Date().timeIntervalSince(t)
        print("BENCH records \(records.count) · loadAll(read+decode) \(Int(load * 1000)) ms · store build (incl. MemoryPersistence) \(Int(index * 1000)) ms · encode all \(Int(encode * 1000)) ms · \(bytes / 1024) KB")
        #expect(store.blocks.count > 0)
    }
}

struct BulkLoadTests {
    /// The startup bulk path must give every parent the same child order as inserting block by block.
    @Test @MainActor func bulkLoadMatchesIncrementalIndex() {
        var records: [Record] = [.workspace(Workspace())]
        let parents = (0..<20).map { _ in RecordIDs.make() }
        var rng = SystemRandomNumberGenerator()
        for i in 0..<3_000 {
            let p = parents[Int.random(in: 0..<parents.count, using: &rng)]
            // Some equal sort keys so the id tie-break matters.
            let sk = ["a", "b", "b", "c", "d0", "d1", "z"][i % 7] + String(Int.random(in: 0..<50, using: &rng))
            records.append(.block(Block(type: .text, parent: .block(p), sortKey: sk)))
        }
        let bulk = WorkspaceStore(persistence: MemoryPersistence(records.shuffled()), node: "a")
        let incremental = WorkspaceStore(persistence: nil, node: "b")
        var ignored = Set<String>()
        for r in records.shuffled() { if case .block(let b) = r { incremental._setBlock(b, &ignored) } }
        for p in parents {
            #expect(bulk.children(of: .block(p)) == incremental.children(of: .block(p)))
        }
        #expect(bulk.blocks.count == 3_000)
    }
}

struct ChangeLogTests {
    @Test @MainActor func existingDatabaseGetsBackfilledLog() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cl-\(UUID().uuidString).sqlite")
        // A database written by an older build: no `changes` table.
        do {
            let p = try SQLitePersistence(url: url)
            let s = WorkspaceStore(persistence: p, node: "x")
            _ = s.createPage(title: RichText("Old page"))
        }
        // Simulate the old schema by dropping the log, then reopen.
        do {
            var db: OpaquePointer?
            #expect(sqlite3_open(url.path, &db) == SQLITE_OK)
            sqlite3_exec(db, "DROP TABLE changes", nil, nil, nil)
            sqlite3_close(db)
        }
        let p = try SQLitePersistence(url: url)
        let entries = try p.changes(after: 0, limit: 100)
        #expect(entries.count >= 2)                       // workspace + page
        #expect(entries.allSatisfy { $0.local && !$0.deleted })
        let s = WorkspaceStore(persistence: p, node: "x")
        let before = p.lastChangeSeq
        let id = s.createPage(title: RichText("New"))
        let after = try p.changes(after: before, limit: 100)
        #expect(after.contains { $0.key.id == id && $0.local })
        // Remote writes are logged but not as local.
        var b = s.blocks[id]!; b.text = RichText("Remote edit"); b.stamp = Stamp(millis: b.stamp.millis + 10_000, counter: 0, node: "zz")
        s.applyRemote([.block(b)])
        #expect(try p.changes(after: before, limit: 100).first { $0.key.id == id }?.local == false)
        // One row per record: the latest change.
        #expect(try p.changes(after: 0, limit: 1000).filter { $0.key.id == id }.count == 1)
    }
}

struct RealArchiveTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BASED_ARCHIVE"] != nil))
    @MainActor func importsRealArchive() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: ProcessInfo.processInfo.environment["BASED_ARCHIVE"]!))
        let t = Date()
        let store = WorkspaceStore(persistence: nil, node: "restore")
        let r = try WorkspaceArchive.importArchive(data, into: store)
        print("ARCHIVE imported \(r.imported) kept \(r.keptNewer) skipped \(r.skipped) in \(Int(Date().timeIntervalSince(t) * 1000)) ms; blocks \(store.blocks.count)")
        #expect(r.skipped == 0)
    }
}
