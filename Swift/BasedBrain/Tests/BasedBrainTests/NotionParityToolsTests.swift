import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Agent tools that mirror Notion's: pages, databases, schema and views.
@Suite struct NotionParityToolsTests {
    @MainActor
    @Test func databaseSchemaViewsAndPageOps() throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let tools = AgentTools(store: store, brain: BrainStore(store: store))
        func ok(_ name: String, _ args: JSONValue) -> String {
            let r = tools.call(name, args); #expect(!r.isError, "\(name): \(r.text)"); return r.text
        }
        let page = store.createPage(title: RichText("Home"), in: .workspace)
        let created = ok("create_database", ["title": "Tasks", "parent_id": .string(page),
                                             "properties": ["Status": "select", "Due": "date", "Points": "number"]])
        let dbID = try #require(created.split(separator: " ").dropFirst(2).first.map(String.init))
        let db = try #require(store.databases[dbID])
        #expect(db.properties.first { $0.name == "Status" && $0.type == .select } != nil)

        _ = ok("update_database", ["database_id": .string(dbID), "add_options": ["Status": ["Todo", "Done"]],
                                   "rename_properties": ["Points": "Estimate"], "delete_properties": ["Due"]])
        let db2 = try #require(store.databases[dbID])
        #expect(db2.properties.first { $0.name == "Due" } == nil)
        #expect(db2.properties.first { $0.name == "Estimate" } != nil)

        _ = ok("add_row", ["database_id": .string(dbID), "title": "A", "properties": ["Status": "Todo"]])
        _ = ok("create_view", ["database_id": .string(dbID), "type": "board", "name": "Open",
                               "filters": [["property": "Status", "op": "equals", "value": "Todo"]],
                               "sorts": [["property": "Estimate", "direction": "descending"]], "group_by": "Status"])
        let views = ok("list_views", ["database_id": .string(dbID)])
        #expect(views.contains("Open"), Comment(rawValue: views))
        #expect(views.contains("Status equals Todo"), Comment(rawValue: views))
        #expect(views.contains("Estimate desc"), Comment(rawValue: views))

        let note = store.createPage(title: RichText("Note"), in: .block(page))
        BrainStore(store: store).appendBody(note, markdown: "Hello world, hello again")
        #expect(ok("find_replace", ["page_id": .string(note), "find": "hello", "replace": "bye", "all": true]).contains("1 match"))
        _ = ok("update_page", ["page_id": .string(note), "title": "Renamed", "icon": "🧪"])
        #expect(store.title(of: note) == "Renamed")
        _ = ok("move_page", ["page_id": .string(note)])
        #expect(store.blocks[note]?.parent == .workspace)
        _ = ok("trash_page", ["page_id": .string(note)])
        #expect(store.isTrashed(note))
        _ = ok("restore_page", ["page_id": .string(note)])
        #expect(!store.isTrashed(note))

        _ = ok("add_button", ["parent_id": .string(page), "label": "New Task", "action": "add_page",
                              "database_id": .string(dbID), "properties": ["Status": "Done"], "position": "start"])
        let button = try #require(store.contentBlocks(of: page).first)
        #expect(button.type == .button)
        #expect(button.props.buttonAction?.targetID == dbID)
        let status = try #require(store.databases[dbID]?.properties.first { $0.name == "Status" })
        #expect(button.props.buttonAction?.values?[status.id] == .select(status.option(named: "Done")!.id))
        #expect(tools.call("add_button", ["parent_id": .string(page), "label": "x", "action": "add_page",
                                                "database_id": .string(dbID), "properties": ["Status": "Nope"]]).isError)
    }
}

@Suite struct DocumentArtifactTests {
    @Test func markdownBlocksBecomeDocuments() {
        let doc = "# Weekly plan\n\n- Mon: gym\n- Tue: write\n- Wed: read\n- Thu: lab\n- Fri: review\n\nDone."
        let a = ChatArtifact.extract("Here you go:\n```markdown\n\(doc)\n```\n")
        #expect(a.first?.kind == .markdown)
        #expect(a.first?.title == "Weekly plan")
        #expect(ChatArtifact.from(language: "md", code: "short\nsnippet") == nil)
    }
}
