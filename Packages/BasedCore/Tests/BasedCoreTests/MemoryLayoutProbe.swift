import Foundation
import Testing
@testable import BasedCore

struct MemoryLayoutProbe {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BASED_PROBE"] != nil)) func sizes() {
        print("PROBE Block \(MemoryLayout<Block>.size) · BlockProps \(MemoryLayout<BlockProps>.size) · RichText \(MemoryLayout<RichText>.size) · Stamp \(MemoryLayout<Stamp>.size) · ParentRef \(MemoryLayout<ParentRef>.size) · PageFormat? \(MemoryLayout<PageFormat?>.size)")
    }
}

struct PropsStorageTests {
    @Test func valueSemanticsAndSharing() throws {
        var a = Block(type: .text, parent: .workspace, sortKey: "a")
        let b0 = a
        a.props.color = .red
        #expect(b0.props.color == nil)            // the copy is untouched
        #expect(a.props.color == .red)
        var c = a
        c.props.color = .blue
        #expect(a.props.color == .red && c.props.color == .blue)
        // Equality / hashing by value.
        var d = Block(id: a.id, type: .text, parent: .workspace, sortKey: "a", createdAt: a.createdAt)
        d.props.color = .red
        d.updatedAt = a.updatedAt
        #expect(d == a)
        #expect(Set([a, d]).count == 1)
        // Clearing goes back to the shared empty storage; Codable round trip unchanged.
        a.props = BlockProps()
        #expect(a.props == BlockProps())
        let data = try JSONEncoder().encode(c)
        let back = try JSONDecoder().decode(Block.self, from: data)
        #expect(back == c)
        #expect(!String(decoding: try JSONEncoder().encode(a), as: UTF8.self).contains("\"props\""))
    }
}

struct WorkspaceArchiveTests {
    @Test @MainActor func losslessRoundTrip() throws {
        let a = WorkspaceStore(persistence: nil, node: "a")
        let page = a.createPage(title: RichText("Plans"))
        a.setPageCover(page, .gradient(3))
        _ = a.insertBlock(.todo, text: RichText("Ship it"), in: .block(page), at: .end)
        let db = a.createDatabase(title: RichText("Tasks"), in: .block(page), inline: true, viewType: .board, sampleRows: 2)
        _ = a.addView(to: db.blockID, type: .table, name: "All")

        let data = try WorkspaceArchive.write(a)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.hasPrefix("{"))
        #expect(text.contains("\"format\":\"based-archive\""))

        let b = WorkspaceStore(persistence: nil, node: "b")
        let r = try WorkspaceArchive.importArchive(data, into: b)
        #expect(r.skipped == 0 && r.keptNewer == 0)
        // Every record arrives unchanged.
        for rec in a.allRecords() where rec.key.kind != .workspace {
            #expect(b.record(rec.key) == rec)
        }
        #expect(b.children(of: .block(page)) == a.children(of: .block(page)))
        #expect(b.viewIDs(forBlock: db.blockID).count == 2)
    }

    @Test func rejectsOtherFiles() {
        #expect(throws: WorkspaceArchive.ArchiveError.self) { try WorkspaceArchive.read(Data("hello\nworld".utf8)) }
    }
}
