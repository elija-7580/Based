import XCTest
import BasedCore
@testable import BasedBrain

final class ScheduleTests: XCTestCase {
    func testParsing() {
        XCTAssertEqual(Schedule.parse("every 15m")?.kind, .every(900))
        XCTAssertEqual(Schedule.parse("every 2 hours")?.kind, .every(7200))
        XCTAssertEqual(Schedule.parse("hourly")?.kind, .every(3600))
        XCTAssertEqual(Schedule.parse("daily 07:30")?.kind, .daily(hour: 7, minute: 30, weekdays: nil))
        XCTAssertEqual(Schedule.parse("weekdays 18:00")?.kind, .daily(hour: 18, minute: 0, weekdays: [2, 3, 4, 5, 6]))
        XCTAssertEqual(Schedule.parse("weekly mon,fri 09:00")?.kind, .daily(hour: 9, minute: 0, weekdays: [2, 6]))
        XCTAssertEqual(Schedule.parse("monthly 1 08:00")?.kind, .monthly(day: 1, hour: 8, minute: 0))
        XCTAssertNil(Schedule.parse("sometimes"))
        if case .cron(let m, let h, _, _, let wd)? = Schedule.parse("*/30 7-9 * * 1-5")?.kind {
            XCTAssertEqual(m, [0, 30]); XCTAssertEqual(h, [7, 8, 9]); XCTAssertEqual(wd, [1, 2, 3, 4, 5])
        } else { XCTFail("cron") }
    }

    func testDue() {
        let s = Schedule.parse("every 10m")!
        let now = Date()
        XCTAssertTrue(s.isDue(now: now, lastRun: nil))
        XCTAssertFalse(s.isDue(now: now, lastRun: now.addingTimeInterval(-300)))
        XCTAssertTrue(s.isDue(now: now, lastRun: now.addingTimeInterval(-601)))

        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let d = Schedule.parse("daily 07:00")!
        let t0 = cal.date(from: DateComponents(year: 2026, month: 3, day: 10, hour: 6, minute: 0))!
        XCTAssertEqual(cal.component(.hour, from: d.nextRun(after: t0, lastRun: nil, calendar: cal)), 7)
        let t1 = cal.date(from: DateComponents(year: 2026, month: 3, day: 10, hour: 8, minute: 0))!
        XCTAssertEqual(cal.component(.day, from: d.nextRun(after: t1, lastRun: nil, calendar: cal)), 11)
    }
}

@MainActor
final class MCPTests: XCTestCase {
    func makeServer() -> (WorkspaceStore, BrainStore, MCPServer) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        return (store, brain, MCPServer(tools: AgentTools(store: store, brain: brain)))
    }

    func rpc(_ server: MCPServer, _ method: String, _ params: JSONValue = .object([:]), id: Int = 1) async -> JSONValue {
        let req: JSONValue = ["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params]
        let out = await server.handle(try! req.encoded())!
        return try! JSONValue.parse(out)
    }

    func testBootstrapAndTools() async {
        let (store, brain, server) = makeServer()
        XCTAssertEqual(store.title(of: brain.rootID), "Agent Brain")
        XCTAssertEqual(store.databases[brain.memoriesDB]?.title.plainText, "Memories")

        let init_ = await rpc(server, "initialize", ["protocolVersion": "2025-03-26"])
        XCTAssertEqual(init_["result"]?["serverInfo"]?["name"]?.string, "based")
        let list = await rpc(server, "tools/list")
        let names = list["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        XCTAssertTrue(names.contains("create_page") && names.contains("memory_save") && names.contains("query_database"))

        let created = await rpc(server, "tools/call", ["name": "create_page", "arguments": ["title": "Reading list", "markdown": "# Books\n- Dune\n- [ ] Snow Crash", "icon": "📚"]])
        let text = created["result"]?["content"]?[0]?["text"]?.string ?? ""
        XCTAssertTrue(text.hasPrefix("Created page "))
        let id = String(text.dropFirst("Created page ".count))
        XCTAssertEqual(store.title(of: id), "Reading list")
        XCTAssertEqual(store.contentBlocks(of: id).count, 3)
        XCTAssertEqual(store.contentBlocks(of: id)[2].type, .todo)

        let read = await rpc(server, "tools/call", ["name": "read_page", "arguments": ["page_id": .string(id)]])
        XCTAssertTrue(read["result"]?["content"]?[0]?["text"]?.string?.contains("Dune") == true)

        let found = await rpc(server, "tools/call", ["name": "search", "arguments": ["query": "Snow Crash"]])
        XCTAssertTrue(found["result"]?["content"]?[0]?["text"]?.string?.contains("Reading list") == true)

        _ = await rpc(server, "tools/call", ["name": "memory_save", "arguments": ["title": "Communication style", "type": "Preference", "markdown": "- Elija prefers short answers."]])
        XCTAssertEqual(brain.memories().count, 1)
        XCTAssertEqual(brain.memories()[0].kind, .Preference)
        let recalled = await rpc(server, "tools/call", ["name": "memory_search", "arguments": ["query": "communication"]])
        XCTAssertTrue(recalled["result"]?["content"]?[0]?["text"]?.string?.contains("short answers") == true)
        XCTAssertTrue(brain.systemContext().contains("short answers"))

        brain.saveSkill(name: "Proofread", description: "Fix typos only", body: "Fix spelling and grammar. Keep the voice.")
        let prompts = await rpc(server, "prompts/list")
        XCTAssertEqual(prompts["result"]?["prompts"]?[0]?["name"]?.string, "Proofread")
        let prompt = await rpc(server, "prompts/get", ["name": "Proofread", "arguments": ["input": "teh cat"]])
        XCTAssertTrue(prompt["result"]?["messages"]?[0]?["content"]?["text"]?.string?.contains("teh cat") == true)

        let res = await rpc(server, "resources/read", ["uri": .string("based://page/\(id)")])
        XCTAssertTrue(res["result"]?["contents"]?[0]?["text"]?.string?.contains("Books") == true)

        let bad = await rpc(server, "nope")
        XCTAssertEqual(bad["error"]?["code"]?.int, -32601)
        // Notification → no response
        let n = await server.handle(Data(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.utf8))
        XCTAssertNil(n)
    }

    func testDatabaseTools() async {
        let (store, _, server) = makeServer()
        let db = store.createDatabase(title: RichText("Tasks"), in: .workspace, inline: false, sampleRows: 0)
        _ = store.addProperty(to: db.databaseID, name: "Status", type: .select)
        _ = store.addProperty(to: db.databaseID, name: "Due", type: .date)
        let add = await rpc(server, "tools/call", ["name": "add_row", "arguments": ["database_id": .string(db.databaseID), "title": "Ship v1", "properties": ["Status": "Doing", "Due": "2026-05-01"]]])
        XCTAssertFalse(add["result"]?["isError"]?.bool ?? true)
        let q = await rpc(server, "tools/call", ["name": "query_database", "arguments": ["database_id": .string(db.databaseID), "filter_text": "doing"]])
        let txt = q["result"]?["content"]?[0]?["text"]?.string ?? ""
        XCTAssertTrue(txt.contains("Ship v1") && txt.contains("Status=Doing") && txt.contains("Due="), txt)
    }
}

@MainActor
final class SyncTests: XCTestCase {
    func testPushPullRoundTrip() throws {
        let serverStore = WorkspaceStore(persistence: nil, node: "srv")
        let server = SyncServer(store: serverStore)
        let a = WorkspaceStore(persistence: nil, node: "a")
        let pid = a.createPage(title: RichText("From A"))
        // A pushes everything
        let env = SyncEnvelope(records: a.allRecords(), deletions: [], cursor: .zero)
        let data = try JSONEncoder().encode(env)
        let decoded = try JSONDecoder().decode(SyncEnvelope.self, from: data)
        _ = server.push(decoded)
        XCTAssertEqual(serverStore.title(of: pid), "From A")
        // B pulls
        let b = WorkspaceStore(persistence: nil, node: "b")
        let pulled = server.pull(since: nil)
        b.applyRemote(pulled.records, deletions: pulled.deletions)
        XCTAssertEqual(b.title(of: pid), "From A")
        // Nothing new since cursor
        XCTAssertTrue(server.pull(since: pulled.cursor).records.isEmpty)
        // B edits, pushes; A pulls incrementally
        b.setText(pid, RichText("Edited by B"))
        _ = server.push(SyncEnvelope(records: b.allRecords().filter { $0.key.id == pid }, deletions: [], cursor: pulled.cursor))
        let inc = server.pull(since: pulled.cursor)
        XCTAssertEqual(inc.records.count, 1)
        a.applyRemote(inc.records)
        XCTAssertEqual(a.title(of: pid), "Edited by B")
        // Deletion tombstone
        _ = server.push(SyncEnvelope(records: [], deletions: [RecordKey(.block, pid)], cursor: inc.cursor))
        XCTAssertNil(serverStore.blocks[pid])
        XCTAssertEqual(server.pull(since: inc.cursor).deletions, [RecordKey(.block, pid)])
    }
}

final class NotionMappingTests: XCTestCase {
    func testBlockMapping() throws {
        let json = try JSONValue.parse(#"""
        {"type":"to_do","has_children":false,"to_do":{"checked":true,"color":"default","rich_text":[
          {"plain_text":"Buy ","annotations":{"bold":false,"italic":false,"strikethrough":false,"underline":false,"code":false,"color":"default"},"href":null},
          {"plain_text":"milk","annotations":{"bold":true,"italic":false,"strikethrough":false,"underline":false,"code":false,"color":"red"},"href":"https://x.y"}]}}
        """#)
        let ib = NotionAPIImporter.imported(json, children: [])!
        XCTAssertEqual(ib.type, .todo)
        XCTAssertEqual(ib.props.checked, true)
        XCTAssertEqual(ib.text.plainText, "Buy milk")
        XCTAssertEqual(ib.text.runs.last?.marks.bold, true)
        XCTAssertEqual(ib.text.runs.last?.marks.link, "https://x.y")
        XCTAssertEqual(ib.text.runs.last?.marks.color, .red)
        let code = try JSONValue.parse(#"{"type":"code","code":{"language":"swift","rich_text":[{"plain_text":"let x = 1"}]}}"#)
        let cb = NotionAPIImporter.imported(code, children: [])!
        XCTAssertEqual(cb.type, .code); XCTAssertEqual(cb.props.language, "swift")
        let md = ImportedMarkdown.markdown(of: [ib, cb])
        XCTAssertTrue(md.contains("- [x] Buy **milk**") || md.contains("- [x] Buy"), md)
        XCTAssertTrue(md.contains("```swift"))
    }

    func testTitleAndProperties() throws {
        let page = try JSONValue.parse(#"{"properties":{"Name":{"type":"title","title":[{"plain_text":"Hello"}]},"Type":{"type":"select","select":{"name":"Preference"}}}}"#)
        XCTAssertEqual(NotionAPIImporter.title(of: page), "Hello")
        XCTAssertEqual(NotionAPIImporter.propertyText(page["properties"]!["Type"]!), "Preference")
    }
}

final class JSONTests: XCTestCase {
    func testRoundTrip() throws {
        let v: JSONValue = ["a": 1, "b": [true, .null, "x"], "c": 1.5]
        let back = try JSONValue.parse(v.encoded())
        XCTAssertEqual(v, back)
        XCTAssertEqual(back["b"]?[2]?.string, "x")
        XCTAssertEqual(v.text, #"{"a":1,"b":[true,null,"x"],"c":1.5}"#)
    }
}
