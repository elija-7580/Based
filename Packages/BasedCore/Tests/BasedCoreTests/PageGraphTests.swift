import XCTest
@testable import BasedCore

@MainActor
final class PageGraphTests: XCTestCase {
    func testHierarchyRelationsMentionsAndTrash() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "g")
        let home = s.createPage(title: "Home")
        let child = s.createPage(title: "Child", in: .block(home))
        // a mention of Child inside Home's content
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("see "), TextRun("Child", mention: .page(child))]), in: .block(home))

        // family database: Parents (two-way → Children)
        let fam = s.createDatabase(title: "Family", in: .block(home), inline: false, sampleRows: 0)
        let parents = s.addProperty(to: fam.databaseID, name: "Parents", type: .relation)!
        s.updateProperty(fam.databaseID, parents) { $0.relation = RelationConfig(databaseID: fam.databaseID) }
        s.makeRelationTwoWay(fam.databaseID, parents)
        let mum = s.addRow(to: fam.databaseID, title: "Mum")
        let kid = s.addRow(to: fam.databaseID, title: "Kid")
        s.setRelation(kid, parents, [mum])

        let gone = s.createPage(title: "Gone", in: .block(home))
        _ = s.trashPages([gone])

        let g = s.pageGraph()
        let ids = Set(g.nodes.map(\.id))
        XCTAssertTrue(ids.isSuperset(of: [home, child, mum, kid, fam.blockID]))
        XCTAssertFalse(ids.contains(gone))

        func has(_ a: RecordID, _ b: RecordID, _ k: String) -> Bool { g.edges.contains { $0.s == a && $0.t == b && $0.k == k } }
        XCTAssertTrue(has(home, child, "child"))
        XCTAssertTrue(has(home, child, "mention"))
        XCTAssertTrue(has(fam.blockID, kid, "child"), "rows hang under their database page")
        let parentKind = "rel:\(fam.databaseID):\(parents)"
        XCTAssertTrue(has(kid, mum, parentKind))
        let kind = g.kinds.first { $0.id == parentKind }
        XCTAssertNotNil(kind?.inverse, "two-way relation knows its other side")
        XCTAssertTrue(g.edges.contains { $0.s == mum && $0.t == kid && $0.k == kind?.inverse }, "synced side is an edge too")
        XCTAssertEqual(g.nodes.first { $0.id == kid }?.db, fam.databaseID)

        // round-trips as JSON (what the web view receives)
        let data = try! JSONEncoder().encode(g)
        XCTAssertEqual(try JSONDecoder().decode(PageGraph.self, from: data).nodes.count, g.nodes.count)
    }
}
