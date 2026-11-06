import XCTest
@testable import BasedBrain
@testable import BasedCore

/// Answers Notion API requests from an in-memory route table.
final class FakeNotion: NotionTransport, @unchecked Sendable {
    var routes: [String: JSONValue] = [:]
    var failFirst: [String: Int] = [:]          // route → number of 429 answers before success
    var files: [String: Data] = [:]
    private(set) var calls: [String] = []
    private let lock = NSLock()

    func send(method: String, url: URL, headers: [String: String], body: Data?) async throws -> (status: Int, headers: [String: String], data: Data) {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if comps.host != "api.notion.com" {
            sync { calls.append("FILE \(comps.path)") }
            if let d = files[comps.path] { return (200, [:], d) }
            return (404, [:], Data())
        }
        var path = comps.percentEncodedPath
        if path.hasPrefix("/v1/") { path.removeFirst(4) }
        var key = "\(method) \(path)"
        if let db = comps.queryItems?.first(where: { $0.name == "database_id" })?.value { key += "?database_id=\(db)" }
        let fail: Int = sync {
            calls.append(key)
            let n = failFirst[key] ?? 0
            if n > 0 { failFirst[key] = n - 1 }
            return n
        }
        if fail > 0 { return (429, ["retry-after": "0"], Data(#"{"code":"rate_limited","message":"slow down"}"#.utf8)) }
        XCTAssertEqual(headers["Notion-Version"], NotionClient.version)
        if let r = routes[key] { return (200, [:], try r.encoded()) }
        return (404, [:], Data(#"{"object":"error","code":"object_not_found","message":"Could not find \#(key)"}"#.utf8))
    }

    private func sync<T>(_ f: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return f() }
    func count(_ key: String) -> Int { sync { calls.filter { $0 == key }.count } }
}

@MainActor
final class NotionAPIImportTests: XCTestCase {
    // Ids
    let hub = "11111111-1111-4111-8111-111111111111"
    let sub = "22222222-2222-4222-8222-222222222222"
    let tasksDB = "33333333-3333-4333-8333-333333333333"
    let tasksDS = "44444444-4444-4444-8444-444444444444"
    let row1 = "55555555-5555-4555-8555-000000000001"
    let row2 = "55555555-5555-4555-8555-000000000002"
    let projDS = "66666666-6666-4666-8666-666666666666"
    let projDB = "77777777-7777-4777-8777-777777777777"
    let proj1 = "88888888-8888-4888-8888-000000000001"
    let viewAll = "99999999-9999-4999-8999-000000000001"
    let viewBoard = "99999999-9999-4999-8999-000000000002"
    let user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    func b(_ n: Int) -> String { String(format: "bbbbbbbb-bbbb-4bbb-8bbb-%012d", n) }

    func rt(_ s: String, bold: Bool = false, color: String = "default", link: String? = nil) -> JSONValue {
        var text: [String: JSONValue] = ["content": .string(s)]
        if let link { text["link"] = ["url": .string(link)] }
        return ["type": "text", "text": .object(text), "plain_text": .string(s), "href": link.map(JSONValue.string) ?? .null,
                "annotations": ["bold": .bool(bold), "italic": false, "strikethrough": false, "underline": false, "code": false, "color": .string(color)]]
    }

    func block(_ id: String, _ type: String, _ body: JSONValue, children: Bool = false) -> JSONValue {
        ["object": "block", "id": .string(id), "type": .string(type), .init(stringLiteral: type): body, "has_children": .bool(children),
         "created_time": "2024-03-01T10:00:00.000Z", "last_edited_time": "2024-03-02T11:00:00.000Z",
         "created_by": ["object": "user", "id": .string(user)], "last_edited_by": ["object": "user", "id": .string(user)]]
    }

    func list(_ items: [JSONValue]) -> JSONValue { ["object": "list", "results": .array(items), "has_more": false, "next_cursor": .null] }

    func page(_ id: String, title: String, parent: JSONValue, props: [String: JSONValue] = [:], icon: JSONValue = .null) -> JSONValue {
        var p = props
        p["Name"] = ["id": "title", "type": "title", "title": [rt(title)]]
        return ["object": "page", "id": .string(id), "parent": parent, "icon": icon, "cover": .null, "properties": .object(p),
                "created_time": "2024-01-05T09:30:00.000Z", "last_edited_time": "2024-02-06T08:00:00.000Z",
                "created_by": ["object": "user", "id": .string(user)], "last_edited_by": ["object": "user", "id": .string(user)], "in_trash": false]
    }

    func makeFake() -> FakeNotion {
        let f = FakeNotion()
        f.routes["GET users"] = list([["object": "user", "id": .string(user), "name": "Elija", "type": "person"]])
        // Hub page
        f.routes["GET pages/\(hub)"] = page(hub, title: "Project Hub", parent: ["type": "workspace", "workspace": true], icon: ["type": "emoji", "emoji": "🚀"])
        let para: JSONValue = ["rich_text": [rt("Read "), rt("this", bold: true), rt(" and ", color: "red_background"),
                                             rt("the spec", link: "/\(sub.replacingOccurrences(of: "-", with: ""))"),
                                             ["type": "mention", "mention": ["type": "page", "page": ["id": .string(sub)]], "plain_text": "Spec", "href": "https://www.notion.so/x",
                                              "annotations": ["bold": false, "italic": false, "strikethrough": false, "underline": false, "code": false, "color": "default"]],
                                             ["type": "equation", "equation": ["expression": "E=mc^2"], "plain_text": "E=mc^2",
                                              "annotations": ["bold": false, "italic": false, "strikethrough": false, "underline": false, "code": false, "color": "default"]]],
                               "color": "default"]
        f.routes["GET blocks/\(hub)/children"] = list([
            block(b(1), "heading_1", ["rich_text": [rt("Overview")], "color": "blue", "is_toggleable": false]),
            block(b(2), "paragraph", para),
            block(b(3), "to_do", ["rich_text": [rt("Ship it")], "checked": true, "color": "default"]),
            block(b(4), "toggle", ["rich_text": [rt("Details")], "color": "default"], children: true),
            block(b(5), "callout", ["rich_text": [rt("Tip")], "icon": ["type": "emoji", "emoji": "💡"], "color": "yellow_background"]),
            block(b(6), "code", ["rich_text": [rt("let x = 1")], "language": "Swift", "caption": [rt("Example")]]),
            block(b(7), "image", ["type": "file", "file": ["url": "https://files.example.com/secure/img.png?X-Amz-Signature=abc", "expiry_time": "2024-01-01T00:00:00Z"], "caption": []]),
            block(b(8), "table", ["table_width": 2, "has_column_header": true, "has_row_header": false], children: true),
            block(b(9), "column_list", [:], children: true),
            block(sub, "child_page", ["title": "Spec"]),
            block(tasksDB, "child_database", ["title": "Tasks"]),
            block(b(20), "synced_block", ["synced_from": .null], children: true),
            block(b(21), "synced_block", ["synced_from": ["type": "block_id", "block_id": .string(b(20))]], children: true),
            block(b(22), "ai_block", [:]),
            block(b(23), "link_to_page", ["type": "page_id", "page_id": .string(sub)]),
            block(b(24), "heading_2", ["rich_text": [rt("Folded")], "color": "default", "is_toggleable": true], children: true),
        ])
        f.routes["GET blocks/\(b(4))/children"] = list([block(b(40), "paragraph", ["rich_text": [rt("Hidden text")], "color": "gray"])])
        f.routes["GET blocks/\(b(8))/children"] = list([
            block(b(80), "table_row", ["cells": [[rt("Name")], [rt("Value")]]]),
            block(b(81), "table_row", ["cells": [[rt("A")], [rt("1", bold: true)]]]),
        ])
        f.routes["GET blocks/\(b(9))/children"] = list([
            block(b(90), "column", ["width_ratio": 0.3], children: true),
            block(b(91), "column", ["width_ratio": 0.7], children: true),
        ])
        f.routes["GET blocks/\(b(90))/children"] = list([block(b(92), "paragraph", ["rich_text": [rt("Left")]])])
        f.routes["GET blocks/\(b(91))/children"] = list([block(b(93), "paragraph", ["rich_text": [rt("Right")]])])
        f.routes["GET blocks/\(b(20))/children"] = list([block(b(200), "paragraph", ["rich_text": [rt("Shared")]])])
        f.routes["GET blocks/\(b(21))/children"] = list([block(b(200), "paragraph", ["rich_text": [rt("Shared")]])])
        f.routes["GET blocks/\(b(24))/children"] = list([block(b(240), "paragraph", ["rich_text": [rt("Inside")]])])
        // Sub page (rate limited once)
        f.routes["GET pages/\(sub)"] = page(sub, title: "Spec", parent: ["type": "page_id", "page_id": .string(hub)])
        f.failFirst["GET pages/\(sub)"] = 1
        f.routes["GET blocks/\(sub)/children"] = list([block(b(100), "quote", ["rich_text": [rt("Quoted")], "color": "default"])])
        f.files["/secure/img.png"] = Data("PNGDATA".utf8)

        // Tasks database
        f.routes["GET databases/\(tasksDB)"] = ["object": "database", "id": .string(tasksDB), "title": [rt("Tasks")], "description": [rt("All the work")],
                                                "is_inline": true, "parent": ["type": "page_id", "page_id": .string(hub)],
                                                "data_sources": [["id": .string(tasksDS), "name": "Tasks"]], "icon": .null, "cover": .null]
        let tagOpts: JSONValue = ["options": [["id": "t-urgent", "name": "Urgent", "color": "red"], ["id": "t-later", "name": "Later", "color": "blue"]]]
        f.routes["GET data_sources/\(tasksDS)"] = ["object": "data_source", "id": .string(tasksDS), "title": [rt("Tasks")],
            "parent": ["type": "database_id", "database_id": .string(tasksDB)],
            "properties": [
                "Name": ["id": "title", "name": "Name", "type": "title", "title": [:]],
                "Status": ["id": "st%3A1", "name": "Status", "type": "status", "status": [
                    "options": [["id": "s-todo", "name": "Not started", "color": "default"], ["id": "s-doing", "name": "In progress", "color": "blue"], ["id": "s-done", "name": "Done", "color": "green"]],
                    "groups": [["id": "g1", "name": "To-do", "color": "gray", "option_ids": ["s-todo"]], ["id": "g2", "name": "In progress", "color": "blue", "option_ids": ["s-doing"]], ["id": "g3", "name": "Complete", "color": "green", "option_ids": ["s-done"]]]]],
                "Tags": ["id": "tg", "name": "Tags", "type": "multi_select", "multi_select": tagOpts],
                "Due": ["id": "du", "name": "Due", "type": "date", "date": [:]],
                "Points": ["id": "pt", "name": "Points", "type": "number", "number": ["format": "euro"]],
                "Done": ["id": "dn", "name": "Done", "type": "checkbox", "checkbox": [:]],
                "Owner": ["id": "ow", "name": "Owner", "type": "people", "people": [:]],
                "Project": ["id": "rl", "name": "Project", "type": "relation", "relation": ["data_source_id": .string(projDS), "type": "dual_property", "dual_property": ["synced_property_id": "back", "synced_property_name": "Tasks"]]],
                "Score": ["id": "fm", "name": "Score", "type": "formula", "formula": ["expression": "{{notion:block_property:pt:00000000-0000-0000-0000-000000000000:abc}} * 2"]],
                "Label": ["id": "fx", "name": "Label", "type": "formula", "formula": ["expression": "notionOnly({{notion:block_property:pt:00000000-0000-0000-0000-000000000000:abc}})"]],
                "Count": ["id": "ru", "name": "Count", "type": "rollup", "rollup": ["relation_property_id": "rl", "relation_property_name": "Project", "rollup_property_id": "title", "rollup_property_name": "Name", "function": "count"]],
                "Key": ["id": "id", "name": "Key", "type": "unique_id", "unique_id": ["prefix": "TSK"]],
            ]]
        func rowProps(status: String, tags: [String], due: String, points: Double, project: [String], key: Int) -> [String: JSONValue] {
            [
                "Status": ["id": "st%3A1", "type": "status", "status": ["id": .string(status), "name": "x", "color": "blue"]],
                "Tags": ["id": "tg", "type": "multi_select", "multi_select": .array(tags.map { ["id": .string($0), "name": "x", "color": "red"] })],
                "Due": ["id": "du", "type": "date", "date": ["start": .string(due), "end": .null, "time_zone": .null]],
                "Points": ["id": "pt", "type": "number", "number": .number(points)],
                "Done": ["id": "dn", "type": "checkbox", "checkbox": false],
                "Owner": ["id": "ow", "type": "people", "people": [["object": "user", "id": .string(user)]]],
                "Project": ["id": "rl", "type": "relation", "relation": .array(project.map { ["id": .string($0)] }), "has_more": false],
                "Score": ["id": "fm", "type": "formula", "formula": ["type": "number", "number": .number(points * 2)]],
                "Label": ["id": "fx", "type": "formula", "formula": ["type": "string", "string": .string("L\(Int(points))")]],
                "Count": ["id": "ru", "type": "rollup", "rollup": ["type": "number", "number": .number(Double(project.count)), "function": "count"]],
                "Key": ["id": "id", "type": "unique_id", "unique_id": ["number": .number(Double(key)), "prefix": "TSK"]],
            ]
        }
        let r1 = page(row1, title: "Write docs", parent: ["type": "data_source_id", "data_source_id": .string(tasksDS)],
                      props: rowProps(status: "s-doing", tags: ["t-urgent"], due: "2024-05-01", points: 3, project: [proj1], key: 1))
        let r2 = page(row2, title: "Fix bug", parent: ["type": "data_source_id", "data_source_id": .string(tasksDS)],
                      props: rowProps(status: "s-done", tags: [], due: "2024-05-03T14:00:00.000+00:00", points: 5, project: [], key: 2))
        f.routes["POST data_sources/\(tasksDS)/query"] = list([r2, r1])
        f.routes["GET blocks/\(row1)/children"] = list([block(b(300), "paragraph", ["rich_text": [rt("Row body")]])])
        f.routes["GET blocks/\(row2)/children"] = list([])
        f.routes["GET views?database_id=\(tasksDB)"] = list([["object": "view", "id": .string(viewAll)], ["object": "view", "id": .string(viewBoard)]])
        f.routes["GET views/\(viewAll)"] = ["object": "view", "id": .string(viewAll), "name": "All tasks", "type": "table", "data_source_id": .string(tasksDS),
            "parent": ["type": "database_id", "database_id": .string(tasksDB)], "filter": .null, "sorts": [],
            "configuration": ["type": "table", "wrap_cells": true, "properties": [
                ["property_id": "title", "visible": true, "width": 280], ["property_id": "st%3A1", "visible": true], ["property_id": "du", "visible": true],
                ["property_id": "pt", "visible": true], ["property_id": "tg", "visible": false]]]]
        f.routes["GET views/\(viewBoard)"] = ["object": "view", "id": .string(viewBoard), "name": "Board", "type": "board", "data_source_id": .string(tasksDS),
            "parent": ["type": "database_id", "database_id": .string(tasksDB)],
            "filter": ["and": [["property": "Tags", "multi_select": ["contains": "Urgent"]], ["or": [["property": "Due", "date": ["past_week": [:]]], ["property": "pt", "number": ["greater_than": 2]]]]]],
            "sorts": [["property": "pt", "direction": "descending"], ["timestamp": "created_time", "direction": "ascending"]],
            "configuration": ["type": "board", "group_by": ["type": "status", "property_id": "st%3A1", "group_by": "option", "sort": ["type": "manual"], "hide_empty_groups": true],
                              "cover": ["type": "page_cover"], "cover_size": "large", "properties": [["property_id": "pt", "visible": true]]]]
        f.routes["POST views/\(viewAll)/queries"] = ["object": "view_query", "id": "q1", "results": [["object": "page", "id": .string(row1)], ["object": "page", "id": .string(row2)]], "has_more": false]
        f.routes["DELETE views/\(viewAll)/queries/q1"] = ["object": "view_query", "deleted": true]

        // Related database living elsewhere
        f.routes["GET data_sources/\(projDS)"] = ["object": "data_source", "id": .string(projDS), "title": [rt("Projects")],
            "parent": ["type": "database_id", "database_id": .string(projDB)],
            "properties": ["Name": ["id": "title", "name": "Name", "type": "title", "title": [:]],
                           "Tasks": ["id": "back", "name": "Tasks", "type": "relation", "relation": ["data_source_id": .string(tasksDS), "type": "dual_property", "dual_property": ["synced_property_id": "rl"]]]]]
        f.routes["GET databases/\(projDB)"] = ["object": "database", "id": .string(projDB), "title": [rt("Projects")], "is_inline": false,
                                               "parent": ["type": "workspace", "workspace": true], "data_sources": [["id": .string(projDS), "name": "Projects"]]]
        f.routes["POST data_sources/\(projDS)/query"] = list([page(proj1, title: "Website", parent: ["type": "data_source_id", "data_source_id": .string(projDS)],
                                                                   props: ["Tasks": ["id": "back", "type": "relation", "relation": [["id": .string(row1)]], "has_more": false]])])
        f.routes["GET blocks/\(proj1)/children"] = list([])
        f.routes["GET views?database_id=\(projDB)"] = list([])
        return f
    }

    func importer(_ f: FakeNotion) -> NotionWorkspaceImport {
        NotionWorkspaceImport(client: NotionClient(token: "secret_x", transport: f, requestsPerSecond: 0), options: NotionImportOptions())
    }

    func testFullImportFromAPI() async throws {
        let f = makeFake()
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let assets = FileAssetStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("na-" + UUID().uuidString))
        let report = try await importer(f).run([NotionTarget("https://www.notion.so/Project-Hub-\(hub.replacingOccurrences(of: "-", with: ""))?pvs=4")!], into: store, assets: assets)
        XCTAssertEqual(f.count("GET pages/\(sub)"), 2, "429 is retried")
        XCTAssertEqual(report.assets, 1)

        // Page and blocks
        let p = try XCTUnwrap(store.blocks[hub])
        XCTAssertEqual(p.title, "Project Hub")
        XCTAssertEqual(p.props.icon, .emoji("🚀"))
        XCTAssertEqual(p.parent, .workspace)
        XCTAssertEqual(p.createdBy, "Elija")
        let kids = store.childBlocks(of: .block(hub))
        XCTAssertEqual(kids.map(\.type), [.heading1, .text, .todo, .toggle, .callout, .code, .image, .table, .columnList, .page, .databaseInline,
                                          .syncedBlock, .syncedBlock, .callout, .linkToPage, .heading2])
        XCTAssertEqual(kids[0].props.color, .blue)
        let runs = kids[1].text.runs
        XCTAssertTrue(runs[1].marks.bold)
        XCTAssertEqual(runs[2].marks.color, .redBackground)
        XCTAssertEqual(runs[3].marks.link, "based://page/\(sub)")
        XCTAssertEqual(runs[4].mention, .page(sub))
        XCTAssertEqual(runs[5].equation, "E=mc^2")
        XCTAssertEqual(kids[2].props.checked, true)
        XCTAssertEqual(store.childBlocks(of: .block(b(4))).first?.title, "Hidden text")
        XCTAssertEqual(kids[4].props.icon, .emoji("💡"))
        XCTAssertEqual(kids[4].props.color, .yellowBackground)
        XCTAssertEqual(kids[5].title, "let x = 1")
        XCTAssertEqual(kids[5].props.language, "swift")
        XCTAssertEqual(kids[5].props.caption?.plainText, "Example")
        let img = try XCTUnwrap(kids[6].props.asset)
        XCTAssertFalse(img.id.hasPrefix("pending-"))
        XCTAssertNil(kids[6].props.url, "expiring Notion URLs aren't kept")
        XCTAssertEqual(kids[7].props.tableColumns, 2)
        XCTAssertEqual(kids[7].props.tableHeaderRow, true)
        XCTAssertEqual(store.childBlocks(of: .block(b(8))).map { $0.props.cells?.map(\.plainText) ?? [] }, [["Name", "Value"], ["A", "1"]])
        XCTAssertEqual(store.childBlocks(of: .block(b(9))).map { $0.props.ratio }, [0.3, 0.7])
        XCTAssertEqual(kids[9].title, "Spec")
        XCTAssertEqual(store.childBlocks(of: .block(sub)).first?.type, .quote)
        XCTAssertNil(kids[11].props.syncSource)
        XCTAssertEqual(store.childBlocks(of: .block(b(20))).first?.title, "Shared")
        XCTAssertEqual(kids[12].props.syncSource, b(20))
        XCTAssertTrue(store.childBlocks(of: .block(b(21))).isEmpty)
        XCTAssertEqual(kids[13].props.icon, .emoji("⚠️"))
        XCTAssertEqual(kids[14].props.linkTarget, sub)
        XCTAssertEqual(kids[15].props.toggleable, true)
        XCTAssertEqual(store.childBlocks(of: .block(b(24))).first?.title, "Inside")
        XCTAssertTrue(report.warnings.contains { $0.contains("ai block") || $0.contains("ai_block") })

        // Database schema
        let container = kids[10]
        XCTAssertEqual(container.id, tasksDB)
        XCTAssertEqual(container.props.databaseID, tasksDS)
        let db = try XCTUnwrap(store.databases[tasksDS])
        XCTAssertEqual(db.blockID, tasksDB)
        XCTAssertEqual(db.title.plainText, "Tasks")
        XCTAssertEqual(db.summary?.plainText, "All the work")
        XCTAssertEqual(Array(db.properties.map(\.name).prefix(5)), ["Name", "Status", "Due", "Points", "Tags"], "view order")
        func prop(_ n: String) -> PropertySchema? { db.properties.first { $0.name == n } }
        XCTAssertEqual(prop("Status")?.type, .status)
        XCTAssertEqual(prop("Status")?.statusGroups?.map(\.name), ["To-do", "In progress", "Complete"])
        XCTAssertEqual(prop("Points")?.numberFormat, .euro)
        XCTAssertEqual(prop("Project")?.type, .relation)
        XCTAssertEqual(prop("Project")?.relation?.databaseID, projDS)
        XCTAssertEqual(prop("Project")?.relation?.syncedPropertyID, NotionAPIMapper.propertyID(projDS, "back"))
        XCTAssertEqual(prop("Score")?.type, .formula)
        XCTAssertEqual(prop("Score")?.formula, "prop(\"Points\") * 2")
        XCTAssertEqual(prop("Label")?.type, .text)
        XCTAssertTrue(prop("Label")?.description?.contains("notionOnly(prop(\"Points\"))") ?? false)
        XCTAssertEqual(prop("Count")?.type, .rollup)
        XCTAssertEqual(prop("Count")?.rollup?.function, .countAll)
        XCTAssertEqual(prop("Key")?.idPrefix, "TSK")
        XCTAssertEqual(db.nextUniqueID, 3)

        // Rows: main view order, values, content, timestamps
        let rows = store.rows(of: tasksDS).sorted { $0.sortKey < $1.sortKey }
        XCTAssertEqual(rows.map(\.id), [row1, row2])
        let r1 = rows[0]
        XCTAssertEqual(r1.title, "Write docs")
        XCTAssertEqual(r1.values[prop("Status")!.id], .status("s-doing"))
        XCTAssertEqual(r1.values[prop("Tags")!.id], .multiSelect(["t-urgent"]))
        XCTAssertEqual(r1.values[prop("Points")!.id], .number(3))
        XCTAssertEqual(r1.values[prop("Owner")!.id], .person(["Elija"]))
        XCTAssertEqual(r1.values[prop("Project")!.id], .relation([proj1]))
        XCTAssertEqual(r1.values[prop("Label")!.id], .text("L3"))
        XCTAssertNil(r1.values[prop("Score")!.id], "live formula")
        let engine = QueryEngine(store: store)
        XCTAssertEqual(engine.value(row1, prop("Score")!.id).number, 6)
        XCTAssertEqual(engine.value(row1, prop("Count")!.id).number, 1)
        XCTAssertEqual(r1.values[prop("Key")!.id], .uniqueID(1))
        if case .date(let d)? = r1.values[prop("Due")!.id] { XCTAssertFalse(d.includeTime) } else { XCTFail("date") }
        if case .date(let d)? = rows[1].values[prop("Due")!.id] { XCTAssertTrue(d.includeTime) } else { XCTFail("date time") }
        XCTAssertEqual(store.childBlocks(of: .block(row1)).first?.title, "Row body")
        let created = ISO8601DateFormatter().date(from: "2024-01-05T09:30:00Z")!
        XCTAssertEqual(r1.createdAt.timeIntervalSince1970, created.timeIntervalSince1970, accuracy: 1)

        // Views
        let views = (container.props.viewIDs ?? []).compactMap { store.views[$0] }
        XCTAssertEqual(views.map(\.name), ["All tasks", "Board"])
        XCTAssertEqual(views[0].wrapCells, true)
        XCTAssertEqual(views[0].properties?.first?.width, 280)
        XCTAssertEqual(views[0].properties?.first { $0.id == prop("Tags")!.id }?.visible, false)
        let board = views[1]
        XCTAssertEqual(board.type, .board)
        XCTAssertEqual(board.groupBy?.propertyID, prop("Status")!.id)
        XCTAssertEqual(board.groupBy?.hideEmptyGroups, true)
        XCTAssertEqual(board.cardCover, .pageCover)
        XCTAssertEqual(board.cardSize, .large)
        let filter = try XCTUnwrap(board.filter)
        XCTAssertEqual(filter.combinator, .and)
        guard case .condition(let c0) = filter.items[0], case .group(let g1) = filter.items[1] else { return XCTFail("filter shape") }
        XCTAssertEqual(c0.propertyID, prop("Tags")!.id)
        XCTAssertEqual(c0.op, .contains)
        XCTAssertEqual(c0.value, .options(["t-urgent"]))
        XCTAssertEqual(g1.combinator, .or)
        guard case .condition(let c1) = g1.items[0], case .condition(let c2) = g1.items[1] else { return XCTFail("or group") }
        XCTAssertEqual(c1.op, .within); XCTAssertEqual(c1.value, .relative(.pastWeek))
        XCTAssertEqual(c2.op, .greater); XCTAssertEqual(c2.value, .number(2))
        let createdProp = try XCTUnwrap(db.properties.first { $0.type == .createdTime })
        XCTAssertEqual(board.sorts?.map(\.propertyID), [prop("Points")!.id, createdProp.id])
        XCTAssertEqual(board.sorts?.map(\.ascending), [false, true])
        // The engine shows the board's rows: Urgent + (past week or points > 2) → only row1
        let shown = QueryEngine(store: store).run(board).rows
        XCTAssertEqual(shown.map(\.id), [row1])

        // The related database is imported as its own page, with the two-way relation
        let projContainer = try XCTUnwrap(store.blocks[projDB])
        XCTAssertEqual(projContainer.type, .databasePage)
        XCTAssertEqual(projContainer.parent, .workspace)
        let projDBRec = try XCTUnwrap(store.databases[projDS])
        XCTAssertEqual(projDBRec.properties.first { $0.name == "Tasks" }?.relation?.databaseID, tasksDS)
        XCTAssertEqual(store.rows(of: projDS).map(\.title), ["Website"])
    }

    func testDashboardImport() async throws {
        let f = makeFake()
        let dash = "99999999-9999-4999-8999-000000000003", w1 = "99999999-9999-4999-8999-000000000004"
        let w2 = "99999999-9999-4999-8999-000000000005", w3 = "99999999-9999-4999-8999-000000000006"
        f.routes["GET views?database_id=\(tasksDB)"] = list([["object": "view", "id": .string(viewAll)], ["object": "view", "id": .string(viewBoard)],
                                                             ["object": "view", "id": .string(dash)], ["object": "view", "id": .string(w1)]])
        f.routes["GET views/\(dash)"] = ["object": "view", "id": .string(dash), "name": "Overview", "type": "dashboard", "data_source_id": .null,
            "parent": ["type": "database_id", "database_id": .string(tasksDB)],
            "configuration": ["type": "dashboard", "rows": [
                ["id": "r1", "height": 320, "widgets": [["id": "x1", "view_id": .string(w1), "width": 4, "row_index": 0],
                                                        ["id": "x2", "view_id": .string(w2), "width": 8, "row_index": 0]]],
                ["id": "r2", "widgets": [["id": "x3", "view_id": .string(w3), "row_index": 1]]]]]]
        f.routes["GET views/\(w1)"] = ["object": "view", "id": .string(w1), "name": "Total", "type": "chart", "data_source_id": .string(tasksDS),
            "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(tasksDB)],
            "configuration": ["type": "chart", "chart_type": "number", "caption": "All tasks", "color_theme": "green", "height": "small"]]
        f.routes["GET views/\(w2)"] = ["object": "view", "id": .string(w2), "name": "Projects", "type": "table", "data_source_id": .string(projDS),
            "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(projDB)]]
        f.routes["GET views/\(w3)"] = ["object": "view", "id": .string(w3), "name": "By status", "type": "chart", "data_source_id": .string(tasksDS),
            "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(tasksDB)],
            "configuration": ["type": "chart", "chart_type": "column", "x_axis": ["type": "status", "property_id": "st%3A1", "group_by": "option"]]]
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let assets = FileAssetStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("nd-" + UUID().uuidString))
        let report = try await importer(f).run([NotionTarget("https://www.notion.so/\(hub.replacingOccurrences(of: "-", with: ""))")!], into: store, assets: assets)
        XCTAssertEqual(f.count("GET views/\(w2)"), 1, "widget views missing from the list are fetched")

        let container = try XCTUnwrap(store.blocks.values.first { $0.props.databaseID == tasksDS && $0.type == .databaseInline })
        let tabs = store.views(forBlock: container.id)
        XCTAssertEqual(tabs.map(\.name), ["All tasks", "Board", "Overview"], "widgets aren't tabs")
        let d = try XCTUnwrap(store.views[dash])
        XCTAssertEqual(d.type, .dashboard)
        let rows = try XCTUnwrap(d.dashboard?.rows)
        XCTAssertEqual(rows.map { $0.widgets.map(\.width) }, [[4, 8], [12]])
        XCTAssertEqual(rows.first?.height, 320)
        XCTAssertEqual(rows.flatMap { $0.widgets.map(\.viewID) }, [w1, w2, w3])
        let total = try XCTUnwrap(store.views[w1])
        XCTAssertEqual(total.widgetOf, dash)
        XCTAssertEqual(total.chart?.kind, .number)
        XCTAssertEqual(total.chart?.caption, "All tasks")
        XCTAssertEqual(total.chart?.colorTheme, "green")
        XCTAssertEqual(total.chart?.height, "small")
        XCTAssertEqual(store.views[w2]?.databaseID, projDS, "widget over another database")
        XCTAssertEqual(store.views[w3]?.chart?.kind, .bar)
        XCTAssertNotNil(store.views[w3]?.chart?.xPropertyID)
        XCTAssertFalse(report.warnings.contains { $0.contains("Dashboard") }, report.warnings.joined(separator: "\n"))
    }

    func testReimportUpdatesInPlace() async throws {
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let target = [NotionTarget(hub)!]
        _ = try await importer(makeFake()).run(target, into: store, assets: nil)
        let count = store.blocks.count
        let views = store.views.count
        let dbs = store.databases.count
        // Local edit, then the page changes in Notion: a block is removed.
        let f = makeFake()
        var kids = f.routes["GET blocks/\(hub)/children"]!["results"]!.array!
        kids.removeAll { $0["id"]?.string == b(3) }
        f.routes["GET blocks/\(hub)/children"] = list(kids)
        let r = try await importer(f).run(target, into: store, assets: nil)
        XCTAssertEqual(store.databases.count, dbs)
        XCTAssertEqual(store.views.count, views)
        XCTAssertEqual(store.blocks.values.filter { $0.trashedAt == nil }.count, count - 1)
        XCTAssertNil(store.blocks[b(3)].flatMap { $0.trashedAt == nil ? $0 : nil })
        XCTAssertEqual(store.children(of: .workspace).filter { store.blocks[$0]?.trashedAt == nil }.count, 2, "hub + Projects, no duplicates")
        XCTAssertTrue(r.warnings.contains { $0.contains("existing") })
    }

    func testSearchModeAndTargets() async throws {
        let f = makeFake()
        f.routes["POST search"] = list([
            f.routes["GET pages/\(hub)"]!,
            ["object": "data_source", "id": .string(tasksDS), "parent": ["type": "database_id", "database_id": .string(tasksDB)],
             "database_parent": ["type": "page_id", "page_id": .string(hub)]],
        ])
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        _ = try await importer(f).run([], into: store, assets: nil)
        // The database lives inside the hub page, so the hub is the only shared root (plus the related Projects database).
        let roots = store.childBlocks(of: .workspace).map(\.id)
        XCTAssertEqual(Set(roots), [hub, projDB])
        XCTAssertEqual(store.blocks[tasksDB]?.parent, .block(hub))

        XCTAssertEqual(NotionTarget("https://app.notion.com/p/25afa757a99a4c998c1fa9ec4a6051eb")?.id, "25afa757-a99a-4c99-8c1f-a9ec4a6051eb")
        XCTAssertEqual(NotionTarget("https://www.notion.so/team/Tasks-33333333333343338333333333333333?v=99999999999949998999000000000001")?.id, tasksDB)
        XCTAssertEqual(NotionTarget.parseList("\(hub)\n\(hub), \(sub)").map(\.id), [hub, sub])
        XCTAssertNil(NotionTarget("hello"))
    }

    func testUnauthorizedStops() async throws {
        let f = FakeNotion()
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        final class Deny: NotionTransport, @unchecked Sendable {
            func send(method: String, url: URL, headers: [String: String], body: Data?) async throws -> (status: Int, headers: [String: String], data: Data) {
                (401, [:], Data(#"{"code":"unauthorized","message":"API token is invalid."}"#.utf8))
            }
        }
        _ = f
        do {
            _ = try await NotionWorkspaceImport(client: NotionClient(token: "bad", transport: Deny(), requestsPerSecond: 0), options: NotionImportOptions())
                .run([NotionTarget(hub)!], into: store, assets: nil)
            XCTFail("should throw")
        } catch let e as NotionAPIError {
            if case .unauthorized = e {} else { XCTFail("\(e)") }
        }
    }

    func testFormulaConversion() {
        let names = ["a": "Price", "b": "Qty", "c%3A": "Odd \"Name\""]
        XCTAssertEqual(NotionAPIMapper.convertFormula("{{notion:block_property:a:x:y}} * {{notion:block_property:b:x:y}}", names: names), "prop(\"Price\") * prop(\"Qty\")")
        XCTAssertEqual(NotionAPIMapper.convertFormula("if({{notion:block_property:a:x:y}} > 3, \"big\", \"small\")", names: names), "if(prop(\"Price\") > 3, \"big\", \"small\")")
        XCTAssertNil(NotionAPIMapper.convertFormula("{{notion:block_property:zz:x:y}} + 1", names: names), "unknown property")
        XCTAssertNil(NotionAPIMapper.convertFormula("unknownFn({{notion:block_property:a:x:y}})", names: names))
        XCTAssertEqual(NotionAPIMapper.readableFormula("{{notion:block_property:b:x:y}} + 1", names: names), "prop(\"Qty\") + 1")
        XCTAssertEqual(NotionAPIMapper.color("purple_background"), .purpleBackground)
        XCTAssertNil(NotionAPIMapper.color("default"))
    }
}
