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
