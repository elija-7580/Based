import Foundation
import Testing
@testable import BasedCore

/// BSD-26: records restored from an archive use origin `.import` — kept stamps, no undo, logged as local.
@MainActor
@Suite struct ImportOriginTests {
    @Test func importIsLoggedLocalWithoutUndoOrRestamp() throws {
        let src = WorkspaceStore(persistence: MemoryPersistence(), node: "src")
        let page = src.createPage(title: RichText("Restored"))
        let archive = try WorkspaceArchive.write(src)

        let p = MemoryPersistence()
        let dst = WorkspaceStore(persistence: p, node: "dst")
        var reported: [RecordKey] = []
        var origins: [ChangeOrigin] = []
        dst.onLocalChange = { reported.append(contentsOf: $0) }
        let token = dst.observe { origins.append($0.origin) }
        defer { token.cancel() }
        let before = p.lastChangeSeq
        let undoBefore = dst.canUndo

        try WorkspaceArchive.importArchive(archive, into: dst)
        #expect(dst.blocks[page]?.stamp == src.blocks[page]?.stamp)
        #expect(dst.canUndo == undoBefore)
        #expect(reported.contains(RecordKey(.block, page)))
        #expect(origins.contains(.import))
        let entry = try p.changes(after: before, limit: 100).first { $0.key == RecordKey(.block, page) }
        #expect(entry?.local == true)
    }

    @Test func remoteStaysNonLocal() throws {
        let p = MemoryPersistence()
        let s = WorkspaceStore(persistence: p, node: "a")
        var b = Block(id: "r1", type: .page, parent: .workspace, sortKey: "a0", text: RichText("Remote"))
        b.stamp = Stamp(millis: 5, counter: 0, node: "z")
        let before = p.lastChangeSeq
        s.applyRemote([.block(b)])
        #expect(try p.changes(after: before, limit: 10).first?.local == false)
        #expect(ChangeOrigin.import.isLocalWrite && !ChangeOrigin.remote.isLocalWrite && !ChangeOrigin.load.isLocalWrite)
    }

    @Test func importIntoReadOnlyStoreThrows() throws {
        let src = WorkspaceStore(persistence: MemoryPersistence(), node: "src")
        _ = src.createPage(title: RichText("X"))
        let archive = try WorkspaceArchive.write(src)
        let dst = WorkspaceStore(persistence: AlwaysFailingPersistence(), node: "dst")
        _ = dst.createPage(title: RichText("Local"))   // fails → store goes read-only
        #expect(dst.isReadOnly)
        #expect(throws: StoreError.self) { try WorkspaceArchive.importArchive(archive, into: dst) }
    }
}

/// Persistence whose writes always fail.
final class AlwaysFailingPersistence: Persistence {
    func loadAll() throws -> [Record] { [] }
    func write(upserts: [Record], deletions: [RecordKey]) throws { throw PersistenceError.sqlite("disk full") }
    func meta(_ key: String) -> Data? { nil }
    func setMeta(_ key: String, _ value: Data?) {}
}
