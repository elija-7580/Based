import Foundation
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
