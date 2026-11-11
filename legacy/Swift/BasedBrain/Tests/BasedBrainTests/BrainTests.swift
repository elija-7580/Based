import Foundation
import Testing
import BasedCore
@testable import BasedBrain

@Suite struct ScheduleTests {
    @Test func parsing() {
        #expect(Schedule.parse("every 15m")?.kind == .every(900))
        #expect(Schedule.parse("every 2 hours")?.kind == .every(7200))
        #expect(Schedule.parse("hourly")?.kind == .every(3600))
        #expect(Schedule.parse("daily 07:30")?.kind == .daily(hour: 7, minute: 30, weekdays: nil))
        #expect(Schedule.parse("weekdays 18:00")?.kind == .daily(hour: 18, minute: 0, weekdays: [2, 3, 4, 5, 6]))
        #expect(Schedule.parse("weekly mon,fri 09:00")?.kind == .daily(hour: 9, minute: 0, weekdays: [2, 6]))
        #expect(Schedule.parse("monthly 1 08:00")?.kind == .monthly(day: 1, hour: 8, minute: 0))
        #expect(Schedule.parse("sometimes") == nil)
        if case .cron(let m, let h, _, _, let wd)? = Schedule.parse("*/30 7-9 * * 1-5")?.kind {
            #expect(m == [0, 30]); #expect(h == [7, 8, 9]); #expect(wd == [1, 2, 3, 4, 5])
        } else { Issue.record("cron") }
    }

    @Test func due() {
        let s = Schedule.parse("every 10m")!
        let now = Date()
        #expect(s.isDue(now: now, lastRun: nil))
        #expect(!s.isDue(now: now, lastRun: now.addingTimeInterval(-300)))
        #expect(s.isDue(now: now, lastRun: now.addingTimeInterval(-601)))

        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let d = Schedule.parse("daily 07:00")!
        let t0 = cal.date(from: DateComponents(year: 2026, month: 3, day: 10, hour: 6, minute: 0))!
        #expect(cal.component(.hour, from: d.nextRun(after: t0, lastRun: nil, calendar: cal)) == 7)
        let t1 = cal.date(from: DateComponents(year: 2026, month: 3, day: 10, hour: 8, minute: 0))!
        #expect(cal.component(.day, from: d.nextRun(after: t1, lastRun: nil, calendar: cal)) == 11)
    }
}

@MainActor
@Suite struct MCPTests {
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

    @Test func bootstrapAndTools() async {
        let (store, brain, server) = makeServer()
        #expect(store.title(of: brain.rootID) == "Agent Brain")
        #expect(store.databases[brain.memoriesDB]?.title.plainText == "Memories")

        let init_ = await rpc(server, "initialize", ["protocolVersion": "2025-03-26"])
        #expect(init_["result"]?["serverInfo"]?["name"]?.string == "based")
        let list = await rpc(server, "tools/list")
        let names = list["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        #expect(names.contains("create_page") && names.contains("memory_save") && names.contains("query_database"))

        let created = await rpc(server, "tools/call", ["name": "create_page", "arguments": ["title": "Reading list", "markdown": "# Books\n- Dune\n- [ ] Snow Crash", "icon": "📚"]])
        let text = created["result"]?["content"]?[0]?["text"]?.string ?? ""
        #expect(text.hasPrefix("Created page "))
        let id = String(text.dropFirst("Created page ".count))
        #expect(store.title(of: id) == "Reading list")
        #expect(store.contentBlocks(of: id).count == 3)
        #expect(store.contentBlocks(of: id)[2].type == .todo)

        let read = await rpc(server, "tools/call", ["name": "read_page", "arguments": ["page_id": .string(id)]])
        #expect(read["result"]?["content"]?[0]?["text"]?.string?.contains("Dune") == true)

        let found = await rpc(server, "tools/call", ["name": "search", "arguments": ["query": "Snow Crash"]])
        #expect(found["result"]?["content"]?[0]?["text"]?.string?.contains("Reading list") == true)

        _ = await rpc(server, "tools/call", ["name": "memory_save", "arguments": ["title": "Communication style", "type": "Preference", "markdown": "- Elija prefers short answers."]])
        #expect(brain.memories().count == 1)
        #expect(brain.memories()[0].kind == .Preference)
        let recalled = await rpc(server, "tools/call", ["name": "memory_search", "arguments": ["query": "communication"]])
        #expect(recalled["result"]?["content"]?[0]?["text"]?.string?.contains("short answers") == true)
        #expect(brain.systemContext().contains("short answers"))

        brain.saveSkill(name: "Proofread", description: "Fix typos only", body: "Fix spelling and grammar. Keep the voice.")
        let prompts = await rpc(server, "prompts/list")
        #expect(prompts["result"]?["prompts"]?[0]?["name"]?.string == "Proofread")
        let prompt = await rpc(server, "prompts/get", ["name": "Proofread", "arguments": ["input": "teh cat"]])
        #expect(prompt["result"]?["messages"]?[0]?["content"]?["text"]?.string?.contains("teh cat") == true)

        let res = await rpc(server, "resources/read", ["uri": .string("based://page/\(id)")])
        #expect(res["result"]?["contents"]?[0]?["text"]?.string?.contains("Books") == true)

        let bad = await rpc(server, "nope")
        #expect(bad["error"]?["code"]?.int == -32601)
        // Notification → no response
        let n = await server.handle(Data(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.utf8))
        #expect(n == nil)
    }

    @Test func databaseTools() async {
        let (store, _, server) = makeServer()
        let db = store.createDatabase(title: RichText("Tasks"), in: .workspace, inline: false, sampleRows: 0)
        _ = store.addProperty(to: db.databaseID, name: "Status", type: .select)
        _ = store.addProperty(to: db.databaseID, name: "Due", type: .date)
        let add = await rpc(server, "tools/call", ["name": "add_row", "arguments": ["database_id": .string(db.databaseID), "title": "Ship v1", "properties": ["Status": "Doing", "Due": "2026-05-01"]]])
        #expect(!(add["result"]?["isError"]?.bool ?? true))
        let q = await rpc(server, "tools/call", ["name": "query_database", "arguments": ["database_id": .string(db.databaseID), "filter_text": "doing"]])
        let txt = q["result"]?["content"]?[0]?["text"]?.string ?? ""
        #expect(txt.contains("Ship v1") && txt.contains("Status=Doing") && txt.contains("Due="), Comment(rawValue: txt))
    }
}

@MainActor
@Suite struct SyncTests {
    @Test func pushPullRoundTrip() throws {
        let serverStore = WorkspaceStore(persistence: nil, node: "srv")
        let server = SyncServer(store: serverStore)
        let a = WorkspaceStore(persistence: nil, node: "a")
        let pid = a.createPage(title: RichText("From A"))
        // A pushes everything
        let env = SyncEnvelope(records: a.allRecords(), deletions: [], cursor: .zero)
        let data = try JSONEncoder().encode(env)
        let decoded = try JSONDecoder().decode(SyncEnvelope.self, from: data)
        _ = server.push(decoded)
        #expect(serverStore.title(of: pid) == "From A")
        // B pulls
        let b = WorkspaceStore(persistence: nil, node: "b")
        let pulled = server.pull(since: nil)
        b.applyRemote(pulled.records, deletions: pulled.deletions)
        #expect(b.title(of: pid) == "From A")
        // Nothing new since cursor
        #expect(server.pull(since: pulled.cursor).records.isEmpty)
        // B edits, pushes; A pulls incrementally
        b.setText(pid, RichText("Edited by B"))
        _ = server.push(SyncEnvelope(records: b.allRecords().filter { $0.key.id == pid }, deletions: [], cursor: pulled.cursor))
        let inc = server.pull(since: pulled.cursor)
        #expect(inc.records.count == 1)
        a.applyRemote(inc.records)
        #expect(a.title(of: pid) == "Edited by B")
        // Deletion tombstone
        _ = server.push(SyncEnvelope(records: [], deletions: [RecordKey(.block, pid)], cursor: inc.cursor))
        #expect(serverStore.blocks[pid] == nil)
        #expect(server.pull(since: inc.cursor).deletions == [RecordKey(.block, pid)])
    }
}

@Suite struct NotionMappingTests {
    @Test func blockMapping() throws {
        let json = try JSONValue.parse(#"""
        {"type":"to_do","has_children":false,"to_do":{"checked":true,"color":"default","rich_text":[
          {"plain_text":"Buy ","annotations":{"bold":false,"italic":false,"strikethrough":false,"underline":false,"code":false,"color":"default"},"href":null},
          {"plain_text":"milk","annotations":{"bold":true,"italic":false,"strikethrough":false,"underline":false,"code":false,"color":"red"},"href":"https://x.y"}]}}
        """#)
        let ib = NotionAPIImporter.imported(json, children: [])!
        #expect(ib.type == .todo)
        #expect(ib.props.checked == true)
        #expect(ib.text.plainText == "Buy milk")
        #expect(ib.text.runs.last?.marks.bold == true)
        #expect(ib.text.runs.last?.marks.link == "https://x.y")
        #expect(ib.text.runs.last?.marks.color == .red)
        let code = try JSONValue.parse(#"{"type":"code","code":{"language":"swift","rich_text":[{"plain_text":"let x = 1"}]}}"#)
        let cb = NotionAPIImporter.imported(code, children: [])!
        #expect(cb.type == .code); #expect(cb.props.language == "swift")
        let md = ImportedMarkdown.markdown(of: [ib, cb])
        #expect(md.contains("- [x] Buy **milk**") || md.contains("- [x] Buy"), Comment(rawValue: md))
        #expect(md.contains("```swift"))
    }

    @Test func titleAndProperties() throws {
        let page = try JSONValue.parse(#"{"properties":{"Name":{"type":"title","title":[{"plain_text":"Hello"}]},"Type":{"type":"select","select":{"name":"Preference"}}}}"#)
        #expect(NotionAPIImporter.title(of: page) == "Hello")
        #expect(NotionAPIImporter.propertyText(page["properties"]!["Type"]!) == "Preference")
    }
}

@Suite struct JSONTests {
    @Test func roundTrip() throws {
        let v: JSONValue = ["a": 1, "b": [true, .null, "x"], "c": 1.5]
        let back = try JSONValue.parse(v.encoded())
        #expect(v == back)
        #expect(back["b"]?[2]?.string == "x")
        #expect(v.text == #"{"a":1,"b":[true,null,"x"],"c":1.5}"#)
    }
}
