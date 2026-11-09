import Foundation
import Testing
@testable import BasedCore

/// BSD-16: rows this version can't decode are kept byte-for-byte and never treated as deleted.
@MainActor
@Suite struct UndecodableRecordTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("undecodable-\(UUID().uuidString)")

    /// A block row this version can't decode (a required field changed shape). Unknown block types and fields
    /// decode since BSD-25 (ForwardCompatibilityTests), so the row breaks the parent reference instead.
    static func futureBlockData(_ b: Block) throws -> Data {
        let json = String(decoding: try Record.block(b).encoded(), as: UTF8.self)
        let replaced = json.replacingOccurrences(of: "\"type\":\"\(b.type.rawValue)\"", with: "\"type\":{\"v\":2}")
        #expect(replaced != json)
        return Data(replaced.utf8)
    }

    @Test func undecodableRowsAreFrozenAndKept() throws {
        let url = dir.appendingPathComponent("w.sqlite")
        var pageID = ""
        let garbageID = "garbage-row"
        let garbage = Data("{not json".utf8)
        var future = Data()
        var futureID = ""
        do {
            let p = try SQLitePersistence(url: url)
            let s = WorkspaceStore(persistence: p, node: "a")
            pageID = s.createPage(title: "Page")
            let child = s.insertBlock(.text, text: "will be from the future", in: .block(pageID), at: .end)
            futureID = child
            future = try Self.futureBlockData(s.blocks[child]!)
            try p.writeRawRow(kind: .block, id: child, data: future)
            try p.writeRawRow(kind: .block, id: garbageID, data: garbage)
        }
        let p = try SQLitePersistence(url: url)
        let loaded = try p.loadAllReporting()
        #expect(loaded.undecodable.count == 2)
        let s = WorkspaceStore(persistence: p, node: "a")
        #expect(s.blocks[pageID] != nil)
        #expect(s.blocks[futureID] == nil)
        #expect(s.frozenKeys == [RecordKey(.block, futureID), RecordKey(.block, garbageID)])

        // Editing and deleting around the frozen rows never touches them.
        s.setText(pageID, "Edited")
        s.deleteBlocks([pageID])
        s.purgeTrash(olderThan: 0, now: Date().addingTimeInterval(3600))
        #expect(p.rawRow(RecordKey(.block, futureID)) == future)
        #expect(p.rawRow(RecordKey(.block, garbageID)) == garbage)
        // The change log has no deletion entry for them.
        let entries = try p.changes(after: 0, limit: 1000)
        #expect(!entries.contains { $0.deleted && ($0.key.id == futureID || $0.key.id == garbageID) })
    }

    @Test func decodableRemoteCopyUnfreezes() throws {
        let url = dir.appendingPathComponent("w2.sqlite")
        let p = try SQLitePersistence(url: url)
        let s = WorkspaceStore(persistence: p, node: "a")
        let page = s.createPage(title: "P")
        let b = s.blocks[page]!
        try p.writeRawRow(kind: .block, id: "x1", data: Data("??".utf8))
        let reopened = WorkspaceStore(persistence: try SQLitePersistence(url: url), node: "a")
        #expect(reopened.frozenKeys.contains(RecordKey(.block, "x1")))

        var copy = b
        copy.id = "x1"
        copy.stamp = reopened.clock.now()
        reopened.applyRemote([.block(copy)])
        #expect(reopened.blocks["x1"] != nil)
        #expect(!reopened.frozenKeys.contains(RecordKey(.block, "x1")))
    }

    @Test func parallelDecodeKeepsOrderAndReportsFailures() throws {
        // Above the 2 000-row threshold the decoder runs in parallel chunks.
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "a")
        let page = s.createPage(title: "P")
        let data = try Record.block(s.blocks[page]!).encoded()
        var raw: [(RecordKind, Data)] = Array(repeating: (.block, data), count: 2_500)
        raw[1_234] = (.block, Data("bad".utf8))
        let out = SQLitePersistence.decodeParallel(raw)
        #expect(out.count == 2_500)
        #expect(out.filter { if case .failure = $0 { return true }; return false }.count == 1)
        if case .success = out[1_234] { Issue.record("row 1234 should fail") }
    }
}
