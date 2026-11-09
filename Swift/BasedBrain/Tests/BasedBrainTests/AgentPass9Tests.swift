import Foundation
import Testing
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import BasedBrain

@Suite struct ClaudeStreamTests {
    @Test func parsesInitTextToolsAndResult() {
        let lines = [
            #"{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4","cwd":"/tmp/p","permissionMode":"default","tools":["Bash","Read"]}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]},"session_id":"abc-123"}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a.txt\nb.txt"}],"is_error":false}]}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"TodoWrite","input":{"todos":[{"content":"Read files","status":"completed"},{"content":"Fix bug","status":"in_progress"}]}}]}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"abc-123","total_cost_usd":0.01,"num_turns":2,"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":7}}"#,
        ]
        let events = lines.flatMap { ClaudeStream.parse(line: $0) }
        #expect(events.first == .initialized(sessionID: "abc-123", model: "claude-sonnet-4", cwd: "/tmp/p", permissionMode: "default", tools: ["Bash", "Read"]))
        #expect(events.contains(.text("Let me look.")))
        #expect(events.contains(.toolResult(id: "t1", output: "a.txt\nb.txt", isError: false)))
        guard case .result(let sid, let err, let text, let input, let output, _, let turns)? = events.last else { Issue.record(); return }
        #expect(sid == "abc-123"); #expect(!err); #expect(text == "Done")
        #expect(input == 15); #expect(output == 7); #expect(turns == 2)
        let updates = events.flatMap(ClaudeStream.updates)
        #expect(updates.contains(.toolCall(id: "t1", title: "Bash(ls -la)", kind: "execute", status: "in_progress")))
        #expect(updates.contains(.plan(["☒ Read files", "◐ Fix bug"])))
        #expect(updates.contains(.usage(input: 15, output: 7)))
    }

    @Test func titlesAndArguments() {
        #expect(ClaudeStream.title(of: "Edit", input: ["file_path": "/a/b.swift"]) == "Edit(/a/b.swift)")
        #expect(ClaudeStream.title(of: "mcp__based__search", input: ["query": "x"]) == "based:search(x)")
        #expect(ClaudeStream.kind(of: "Grep") == "search")
        let d = ClaudeCodeDriver(options: .init(executable: "/usr/bin/claude", cwd: "/tmp", resume: "s1", permissionMode: "plan",
                                                mcpConfig: ["mcpServers": [:]], permissionPromptTool: "mcp__based__approval"))
        let a = d.arguments()
        #expect(Array(a.prefix(6)) == ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        #expect(a.contains("--resume") && a.contains("s1") && a.contains("plan") && a.contains("mcp__based__approval"))
    }
}

@Suite struct TranscriptParserTests {
    @Test func parsesRolesAndMergesToolResults() {
        let md = """
        **You**

        Fix the build

        **Agent**

        Looking at **errors** now.

        **Tool**

        `execute` Bash(swift build)

        **Tool result**

        ```
        Build complete!
        ```

        **Plan**

        - ☐ Run tests

        **Agent**

        All green.
        """
        let items = TranscriptParser.parse(md)
        #expect(items.map(\.kind) == [.user, .agent, .tool, .plan, .agent])
        #expect(items[1].text == "Looking at **errors** now.")
        #expect(items[2].toolKind == "execute")
        #expect(items[2].text == "Bash(swift build)")
        #expect(items[2].output == "Build complete!")
    }
}

@Suite struct CLISessionIndexTests {
    @Test func scansClaudeAndCodexSessions() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("home-" + UUID().uuidString)
        let claudeDir = home.appendingPathComponent(".claude/projects/-Users-me-code-app")
        let codexDir = home.appendingPathComponent(".codex/sessions/2025/01/02")
        try FileManager.default.createDirectory(at: claudeDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: codexDir, withIntermediateDirectories: true)
        let claude = [
            #"{"type":"user","isMeta":true,"sessionId":"s-1","cwd":"/Users/me/code/app","timestamp":"2025-01-01T10:00:00.000Z","message":{"role":"user","content":"Caveat: meta"}}"#,
            #"{"type":"user","sessionId":"s-1","cwd":"/Users/me/code/app","gitBranch":"main","timestamp":"2025-01-01T10:00:01.000Z","message":{"role":"user","content":"Add dark mode to the settings screen"}}"#,
            #"{"type":"assistant","sessionId":"s-1","timestamp":"2025-01-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Sure."},{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"/Users/me/code/app/Settings.swift"}}]}}"#,
            #"{"type":"user","sessionId":"s-1","timestamp":"2025-01-01T10:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"struct Settings {}"}]}}"#,
        ].joined(separator: "\n") + "\n"
        try claude.write(to: claudeDir.appendingPathComponent("s-1.jsonl"), atomically: true, encoding: .utf8)
        let codex = [
            #"{"timestamp":"2025-01-02T09:00:00.000Z","type":"session_meta","payload":{"id":"c-9","cwd":"/Users/me/code/api","timestamp":"2025-01-02T09:00:00.000Z"}}"#,
            #"{"timestamp":"2025-01-02T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
            #"{"timestamp":"2025-01-02T09:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Write API tests"}]}}"#,
            #"{"timestamp":"2025-01-02T09:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls\"]}"}}"#,
        ].joined(separator: "\n") + "\n"
        try codex.write(to: codexDir.appendingPathComponent("rollout-2025-01-02T09-00-00-c-9.jsonl"), atomically: true, encoding: .utf8)

        let all = CLISessionIndex.scan(home: home.path)
        #expect(all.count == 2)
        guard let c = all.first(where: { $0.tool == "claude" }), let x = all.first(where: { $0.tool == "codex" }) else { Issue.record(); return }
        #expect(c.id == "s-1"); #expect(c.title == "Add dark mode to the settings screen")
        #expect(c.project == "app"); #expect(c.gitBranch == "main")
        #expect(c.resumeCommand == "cd '/Users/me/code/app' && claude --resume s-1")
        #expect(x.id == "c-9"); #expect(x.title == "Write API tests"); #expect(x.cwd == "/Users/me/code/api")
        let t = CLISessionIndex.transcript(of: c)
        #expect(t.map(\.role) == [.user, .assistant, .tool, .toolResult])
        #expect(t[2].text == "Read(/Users/me/code/app/Settings.swift)")
        let tx = CLISessionIndex.transcript(of: x)
        #expect(tx.map(\.role) == [.user, .tool])
        #expect(tx[1].text == "bash -lc ls")
        #expect(CLISessionIndex.byProject(all).count == 2)
    }
}

@Suite struct Pass9RuntimeTests {
    @Test func shellEnvironmentHasPath() {
        let env = ShellEnvironment.environment()
        #expect(env["PATH"] != nil)
        #expect(ShellEnvironment.which("sh") != nil)
        #expect(ShellEnvironment.which("definitely-not-a-command-xyz") == nil)
    }

    @MainActor
    @Test func sessionsCarryProjectAndParent() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let parent = brain.createSession(title: "Parent", agentID: "based", machine: "m", cwd: "/x/app", encrypted: false)
        let child = brain.createSession(title: "Child", agentID: "claude", machine: "m", cwd: "/x/app", encrypted: false, project: "App", parentID: parent)
        let list = brain.sessions()
        #expect(list.first { $0.id == parent }?.project == "app")
        #expect(list.first { $0.id == parent }?.isChat == true)
        #expect(list.first { $0.id == child }?.parentID == parent)
        #expect(list.first { $0.id == child }?.project == "App")
        brain.updateSession(child, title: "Renamed")
        #expect(brain.sessions().first { $0.id == child }?.title == "Renamed")
    }

    @Test func mcpApprovalToolIsSessionScoped() async throws {
        let tools = await MainActor.run { () -> AgentTools in
            let store = WorkspaceStore(persistence: nil, node: "t")
            return AgentTools(store: store, brain: BrainStore(store: store))
        }
        let mcp = MCPServer(tools: tools)
        mcp.approval = { session, tool, input in
            ["behavior": "allow", "updatedInput": input, "session": .string(session), "tool": .string(tool)]
        }
        let list = try JSONValue.parse(await mcp.handle(Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.utf8), session: "S1")!)
        #expect(list["result"]?["tools"]?[0]?["name"]?.string == "approval")
        let plain = try JSONValue.parse(await mcp.handle(Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.utf8))!)
        #expect(!((plain["result"]?["tools"]?.array ?? []).contains { $0["name"]?.string == "approval" }))
        let call = try JSONValue.parse(await mcp.handle(Data(#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"approval","arguments":{"tool_name":"Bash","input":{"command":"ls"}}}}"#.utf8), session: "S1")!)
        let text = call["result"]?["content"]?[0]?["text"]?.string ?? ""
        let decision = try JSONValue.parse(text)
        #expect(decision["behavior"]?.string == "allow")
        #expect(decision["session"]?.string == "S1")
        #expect(decision["updatedInput"]?["command"]?.string == "ls")
    }

    @Test func loopbackHTTPServerRandomPort() async throws {
        let server = HTTPServer(port: 0, loopbackOnly: true) { req in .text("pong \(req.path)") }
        try server.start()
        defer { server.stop() }
        #expect(server.boundPort > 0)
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(server.boundPort)/ping")!)
        #expect(String(decoding: data, as: UTF8.self) == "pong /ping")
    }
}
