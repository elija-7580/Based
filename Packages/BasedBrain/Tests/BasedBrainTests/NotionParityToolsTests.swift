import XCTest
import BasedCore
@testable import BasedBrain

/// Agent tools that mirror Notion's: pages, databases, schema and views.
final class NotionParityToolsTests: XCTestCase {
    @MainActor
    func testDatabaseSchemaViewsAndPageOps() throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let tools = AgentTools(store: store, brain: BrainStore(store: store))
        func ok(_ name: String, _ args: JSONValue) -> String {
            let r = tools.call(name, args); XCTAssertFalse(r.isError, "\(name): \(r.text)"); return r.text
        }
        let page = store.createPage(title: RichText("Home"), in: .workspace)
        let created = ok("create_database", ["title": "Tasks", "parent_id": .string(page),
                                             "properties": ["Status": "select", "Due": "date", "Points": "number"]])
        let dbID = try XCTUnwrap(created.split(separator: " ").dropFirst(2).first.map(String.init))
        let db = try XCTUnwrap(store.databases[dbID])
        XCTAssertNotNil(db.properties.first { $0.name == "Status" && $0.type == .select })

        _ = ok("update_database", ["database_id": .string(dbID), "add_options": ["Status": ["Todo", "Done"]],
                                   "rename_properties": ["Points": "Estimate"], "delete_properties": ["Due"]])
        let db2 = try XCTUnwrap(store.databases[dbID])
        XCTAssertNil(db2.properties.first { $0.name == "Due" })
        XCTAssertNotNil(db2.properties.first { $0.name == "Estimate" })

        _ = ok("add_row", ["database_id": .string(dbID), "title": "A", "properties": ["Status": "Todo"]])
        _ = ok("create_view", ["database_id": .string(dbID), "type": "board", "name": "Open",
                               "filters": [["property": "Status", "op": "equals", "value": "Todo"]],
                               "sorts": [["property": "Estimate", "direction": "descending"]], "group_by": "Status"])
        let views = ok("list_views", ["database_id": .string(dbID)])
        XCTAssertTrue(views.contains("Open"), views)
        XCTAssertTrue(views.contains("Status equals Todo"), views)
        XCTAssertTrue(views.contains("Estimate desc"), views)

        let note = store.createPage(title: RichText("Note"), in: .block(page))
        BrainStore(store: store).appendBody(note, markdown: "Hello world, hello again")
        XCTAssertTrue(ok("find_replace", ["page_id": .string(note), "find": "hello", "replace": "bye", "all": true]).contains("1 match"))
        _ = ok("update_page", ["page_id": .string(note), "title": "Renamed", "icon": "🧪"])
        XCTAssertEqual(store.title(of: note), "Renamed")
        _ = ok("move_page", ["page_id": .string(note)])
        XCTAssertEqual(store.blocks[note]?.parent, .workspace)
        _ = ok("trash_page", ["page_id": .string(note)])
        XCTAssertTrue(store.isTrashed(note))
        _ = ok("restore_page", ["page_id": .string(note)])
        XCTAssertFalse(store.isTrashed(note))
    }
}
