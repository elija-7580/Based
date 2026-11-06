import XCTest
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import BasedBrain

/// Pass 12: sub-agents, board/canvas graph, diffs and the Claude-Code-style console helpers.
final class LineDiffTests: XCTestCase {
    func testUnifiedDiffAndParse() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj"
        let new = "a\nb\nc\nD\ne\nf\ng\nh\ni\nj\nk"
        let u = LineDiff.unified(old: old, new: new, context: 1)
        XCTAssertEqual(u, "@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n@@ -10,1 +10,2 @@\n j\n+k")
        let lines = LineDiff.parse(u)
        XCTAssertEqual(lines.filter { $0.kind == .hunk }.count, 2)
        let removed = lines.first { $0.kind == .removed }!
        XCTAssertEqual(removed.oldNumber, 4); XCTAssertEqual(removed.text, "d")
        let added = lines.filter { $0.kind == .added }
        XCTAssertEqual(added.map(\.newNumber), [4, 11])
        XCTAssertEqual(LineDiff.counts(LineDiff.ops(old: old, new: new)).added, 2)
        XCTAssertEqual(LineDiff.counts(LineDiff.ops(old: old, new: new)).removed, 1)
        XCTAssertEqual(LineDiff.unified(old: "same", new: "same"), "")
    }

    func testNewFileAndFileOffsets() throws {
        let u = LineDiff.unified(old: "", new: "x\ny")
        XCTAssertEqual(u, "@@ -1,0 +1,2 @@\n+x\n+y")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ld-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("a.swift")
        try "one\ntwo\nthree\nfour\n".write(to: f, atomically: true, encoding: .utf8)
        XCTAssertEqual(LineDiff.firstLine(of: "three\nfour", inFile: f.path), 3)
        XCTAssertNil(LineDiff.firstLine(of: "zzz", inFile: f.path))
        XCTAssertNil(LineDiff.firstLine(of: "one", inFile: "relative/path"))
        let shifted = LineDiff.unified(old: "three", new: "THREE", firstLine: 3)
        XCTAssertTrue(shifted.hasPrefix("@@ -3,1 +3,1 @@"))
    }

    func testTranscriptDiffAndToolSources() {
        let md = "**Tool**\n\n`edit` Edit(/x/a.txt)\n\n**Diff**\n\n`/x/a.txt`\n```diff\n@@ -1,1 +1,1 @@\n-a\n+b\n```\n"
        let items = TranscriptParser.parse(md)
        let d = items.first { $0.kind == .diff }
        XCTAssertEqual(d?.text, "/x/a.txt")
        XCTAssertEqual(d?.output, "@@ -1,1 +1,1 @@\n-a\n+b")
        // Claude Code tool inputs → diffs
        let edit = ClaudeStream.diffs("Edit", ["file_path": "/x/a.txt", "old_string": "a", "new_string": "b"])
        XCTAssertEqual(edit, [.diff(path: "/x/a.txt", old: "a", new: "b")])
        XCTAssertEqual(ClaudeStream.diffs("MultiEdit", ["file_path": "f", "edits": [["old_string": "1", "new_string": "2"], ["old_string": "3", "new_string": "4"]]]).count, 2)
        XCTAssertEqual(ClaudeStream.diffs("Write", ["file_path": "f", "content": "new"]), [.diff(path: "f", old: "", new: "new")])
        XCTAssertTrue(ClaudeStream.diffs("Bash", ["command": "ls"]).isEmpty)
    }

    func testToolTitlesForOrchestrationTools() {
        XCTAssertEqual(ClaudeStream.title(of: "mcp__based__spawn_agent", input: ["prompt": "Fix tests", "title": "Tests"]), "Agent(Tests)")
        XCTAssertEqual(ClaudeStream.title(of: "mcp__based__wait_for_agents", input: [:]), "Wait(all sub-agents)")
        XCTAssertEqual(ClaudeStream.title(of: "mcp__based__search", input: ["query": "x"]), "based:search(x)")
        XCTAssertEqual(ClaudeStream.title(of: "mcp__github__create_issue", input: ["title": "Bug"]), "github:create_issue(Bug)")
    }
}

final class ConsoleCompletionTests: XCTestCase {
    func testSlashCommands() {
        XCTAssertEqual(ConsoleCompletion.commandMatches("/").count, ConsoleCompletion.commands.count)
        XCTAssertEqual(Array(ConsoleCompletion.commandMatches("/st").map(\.name).prefix(2)), ["status", "stop"])   // prefix matches first
        XCTAssertEqual(Set(ConsoleCompletion.commandMatches("/gent").map(\.name)), ["agents", "subagent"])
        XCTAssertTrue(ConsoleCompletion.commandMatches("/spawn x").isEmpty)
        XCTAssertTrue(ConsoleCompletion.commandMatches("hello").isEmpty)
        XCTAssertEqual(ConsoleCompletion.parseCommand("/spawn fix the tests")?.name, "spawn")
        XCTAssertEqual(ConsoleCompletion.parseCommand("/spawn fix the tests")?.argument, "fix the tests")
        XCTAssertEqual(ConsoleCompletion.parseCommand("  /HELP ")?.name, "help")
        XCTAssertNil(ConsoleCompletion.parseCommand("/usr/bin is a path"))
        XCTAssertNil(ConsoleCompletion.parseCommand("// comment"))
        XCTAssertNil(ConsoleCompletion.parseCommand("no command"))
        XCTAssertFalse(ConsoleCompletion.commands.first { $0.name == "compact" }!.local)
    }

    func testMentions() throws {
        XCTAssertEqual(ConsoleCompletion.mentionQuery("look at @Sou"), "Sou")
        XCTAssertEqual(ConsoleCompletion.mentionQuery("@"), "")
        XCTAssertNil(ConsoleCompletion.mentionQuery("mail me@example.com"))
        XCTAssertNil(ConsoleCompletion.mentionQuery("look at @Sources/a.swift now"))
        XCTAssertEqual(ConsoleCompletion.applyMention("Sources/App.swift", to: "fix @app"), "fix @Sources/App.swift ")

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cc-\(UUID().uuidString)")
        let fm = FileManager.default
        for p in ["Sources/App", "node_modules/x", ".git", "Tests"] { try fm.createDirectory(at: dir.appendingPathComponent(p), withIntermediateDirectories: true) }
        for p in ["Sources/App/AppModel.swift", "Sources/App/RootView.swift", "node_modules/x/index.js", "Tests/AppTests.swift", "README.md", ".git/HEAD"] {
            try "x".write(to: dir.appendingPathComponent(p), atomically: true, encoding: .utf8)
        }
        defer { try? fm.removeItem(at: dir) }
        let files = ConsoleCompletion.files(in: dir.path)
        XCTAssertTrue(files.contains("Sources/App/AppModel.swift"))
        XCTAssertTrue(files.contains("Sources/"))
        XCTAssertFalse(files.contains { $0.hasPrefix("node_modules") || $0.hasPrefix(".git") })
        XCTAssertEqual(ConsoleCompletion.rank(files, query: "appmodel").first, "Sources/App/AppModel.swift")
        XCTAssertEqual(ConsoleCompletion.rank(files, query: "read").first, "README.md")
        XCTAssertTrue(ConsoleCompletion.rank(files, query: "rvw").contains("Sources/App/RootView.swift"))   // fuzzy
        XCTAssertEqual(Set(ConsoleCompletion.rank(files, query: "")), Set(["README.md", "Sources/", "Tests/"]))
    }

    func testToolHeadersAndReferences() {
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "execute", text: "Bash(ls -la)").name, "Bash")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "execute", text: "Bash(ls -la)").argument, "ls -la")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "read", text: "Sources/a.swift").name, "Read")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "read", text: "Sources/a.swift").argument, "Sources/a.swift")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "other", text: "TodoWrite").name, "TodoWrite")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: "execute", text: "`git status` (in repo)").name, "Bash")
        XCTAssertEqual(ConsoleCompletion.toolHeader(kind: nil, text: "based:search(x)").name, "based:search")
        XCTAssertEqual(ConsoleCompletion.sessionReference(in: "Started sub-agent **Tests** (Claude Code, session 3F2A-91BC-77)."), "3F2A-91BC-77")
        XCTAssertNil(ConsoleCompletion.sessionReference(in: "No session here"))
        XCTAssertEqual(ConsoleCompletion.model(fromNotices: ["Model: claude-sonnet-4-5", "other"]), "claude-sonnet-4-5")
        XCTAssertNil(ConsoleCompletion.model(fromNotices: ["nothing"]))
    }
}

final class AgentGraphTests: XCTestCase {
    func session(_ id: String, parent: String? = nil, project: String = "Based", status: AgentSession.Status = .done,
                 agent: String = "claude", age: TimeInterval = 0) -> AgentSession {
        let t = Date(timeIntervalSince1970: 1_000_000 - age)
        return AgentSession(id: id, title: id, agentID: agent, status: status, machine: "m", cwd: "/src/\(project)", acpSessionID: nil,
                            tokens: 0, startedAt: t, updatedAt: t, encrypted: false, project: project, parentID: parent)
    }

    func testLanesTreeAndEdges() {
        let all = [
            session("root", status: .running),
            session("a", parent: "root", status: .running, age: -1),
            session("b", parent: "root", status: .done, age: -2),
            session("a1", parent: "a", status: .waiting, age: -3),
            session("other", project: "Site", status: .idle, age: 500),
            session("chat", agent: "based"),
        ]
        let g = AgentGraph.build(all)
        XCTAssertEqual(g.lanes.map(\.name), ["Based", "Site"])            // most recently active first, chats hidden
        XCTAssertEqual(g.nodes.count, 5)
        XCTAssertEqual(g.node("a1")?.depth, 2)
        XCTAssertEqual(g.node("root")?.descendants, 3)
        XCTAssertEqual(g.node("root")?.children, ["a", "b"])
        XCTAssertEqual(Set(g.edges.map(\.id)), ["root>a", "root>b", "a>a1"])
        XCTAssertTrue(g.edges.first { $0.to == "a" }!.active)
        XCTAssertFalse(g.edges.first { $0.to == "b" }!.active)
        // Children sit below their parent, the root is centred over its two columns.
        let root = g.node("root")!, a = g.node("a")!, b = g.node("b")!
        XCTAssertEqual(root.x, (a.x + b.x) / 2, accuracy: 0.001)
        XCTAssertGreaterThan(a.y, root.y)
        let lane = g.lanes[0]
        XCTAssertEqual(lane.running, 2); XCTAssertEqual(lane.waiting, 1); XCTAssertEqual(lane.done, 1); XCTAssertEqual(lane.total, 4)
        XCTAssertGreaterThan(g.lanes[1].y, lane.y + lane.height - 1)
        XCTAssertTrue(AgentGraph.build(all, options: .init(includeChats: true)).lanes.contains { $0.name == "AI chats" })
    }

    func testOnlyActiveKeepsAncestorsAndSurvivesCycles() {
        var all = [session("root", status: .done), session("mid", parent: "root", status: .done), session("leaf", parent: "mid", status: .done),
                   session("idle", status: .idle)]
        let g = AgentGraph.build(all, working: ["leaf"], options: .init(onlyActive: true))
        XCTAssertEqual(Set(g.nodes.map(\.id)), ["root", "mid", "leaf"])
        XCTAssertEqual(g.node("leaf")?.status, .running)
        // A corrupt parent cycle must not hang or crash.
        all = [session("x", parent: "y"), session("y", parent: "x")]
        let c = AgentGraph.build(all)
        XCTAssertEqual(c.nodes.count, 2)
    }

    func testBoardColumns() {
        let all = [session("r", status: .running), session("d", status: .done), session("w", status: .idle), session("k", parent: "r", status: .done),
                   session("c", status: .idle, agent: "based")]
        let cols = AgentGraph.columns(all, by: .status, working: ["w"])
        XCTAssertEqual(cols.map(\.title), AgentGraph.statusOrder.map(\.rawValue))
        XCTAssertEqual(Set(cols[0].sessions.map(\.id)), ["r", "w"])
        XCTAssertEqual(AgentGraph.columns(all, by: .status, topLevelOnly: true).flatMap(\.sessions).count, 3)
        XCTAssertEqual(AgentGraph.columns(all, by: .agent).map(\.title), ["claude"])
        XCTAssertEqual(AgentGraph.columns(all, by: .project, includeChats: true).flatMap(\.sessions).count, 5)
    }
}

/// End-to-end sub-agents against a tiny fake ACP agent (python3, newline-delimited JSON-RPC).
final class SubAgentTests: XCTestCase {
    static let fakeAgent = #"""
    import sys, json, time
    def send(o):
        sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        m = json.loads(line); meth = m.get("method"); mid = m.get("id")
        if meth == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}})
        elif meth == "session/new":
            send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "fake-1"}})
        elif meth == "session/prompt":
            text = "".join(b.get("text", "") for b in m["params"]["prompt"] if b.get("type") == "text")
            sid = m["params"]["sessionId"]
            last = [l for l in text.strip().split("\n") if l.strip()][-1]
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "t1",
                  "title": "Edit a.txt", "kind": "edit", "status": "completed", "content": [{"type": "diff", "path": "a.txt", "oldText": "a\nb", "newText": "a\nc"}]}}})
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk",
                  "content": {"type": "text", "text": "Done: " + last[-60:]}}}})
            time.sleep(0.3 if "SLOW" not in text else 1.5)
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
    """#

    var dir: URL!
    override func setUpWithError() throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/env"), ShellEnvironment.which("python3") != nil else { throw XCTSkip("python3 not available") }
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("sub-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Self.fakeAgent.write(to: dir.appendingPathComponent("fake_acp.py"), atomically: true, encoding: .utf8)
    }
    override func tearDown() { if let dir { try? FileManager.default.removeItem(at: dir) } }

    @MainActor
    func makeRuntime() throws -> (BrainStore, HappierRuntime) {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let fake = AgentDefinition(id: "fake", name: "Fake", command: "/usr/bin/env", arguments: ["python3", dir.appendingPathComponent("fake_acp.py").path])
        let runtime = HappierRuntime(brain: brain, connections: nil, agents: [fake], machineName: "test")
        runtime.permissionPolicy = .allowAll
        return (brain, runtime)
    }

    @MainActor
    func testSpawnInheritsFolderAndReportsBack() async throws {
        let (brain, runtime) = try makeRuntime()
        let parent = try await runtime.startSession(agentID: "fake", cwd: dir.path, title: "Parent", project: "Proj")
        let r = await runtime.hostTool("spawn_agent", ["agent": "fake", "prompt": "Fix the flaky tests. TASK-42", "wait": true,
                                                       "_caller_session": .string(parent)])
        XCTAssertEqual(r?.isError, false)
        XCTAssertTrue(r?.text.contains("Done:") == true, r?.text ?? "")
        let kids = brain.children(of: parent)
        XCTAssertEqual(kids.count, 1)
        let kid = try XCTUnwrap(kids.first)
        XCTAssertEqual(kid.cwd, dir.path)
        XCTAssertEqual(kid.project, "Proj")
        XCTAssertEqual(kid.task, "Fix the flaky tests. TASK-42")
        XCTAssertEqual(kid.title, "Fix the flaky tests")
        XCTAssertTrue(kid.result.contains("TASK-42"), kid.result)
        XCTAssertEqual(brain.depth(of: kid.id), 1)
        // The child's edit shows up as a diff; the parent got "started" and "finished" notices.
        let items = TranscriptParser.parse(brain.transcript(kid.id))
        XCTAssertTrue(items.contains { $0.kind == .diff && $0.text == "a.txt" && ($0.output ?? "").contains("+c") })
        var md = ""
        for _ in 0..<20 { md = brain.transcript(parent); if md.contains("finished") { break }; try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertTrue(md.contains("Started sub-agent"))
        XCTAssertTrue(md.contains("finished"), md)
        XCTAssertEqual(ConsoleCompletion.sessionReference(in: md.components(separatedBy: "\n").first { $0.contains("Started sub-agent") } ?? ""), kid.id)
        // agent_sessions from the parent lists only its sub-agents.
        let list = await runtime.hostTool("agent_sessions", ["_caller_session": .string(parent)])
        XCTAssertTrue(list?.text.contains(kid.id) == true)
        XCTAssertFalse(list?.text.contains("· Parent ·") == true)
        runtime.stop(kid.id); runtime.stop(parent)
    }

    @MainActor
    func testBackgroundSpawnAndWaitForAgents() async throws {
        let (brain, runtime) = try makeRuntime()
        let parent = try await runtime.startSession(agentID: "fake", cwd: dir.path, title: "Parent")
        let a = await runtime.hostTool("spawn_agent", ["agent": "fake", "prompt": "SLOW job one", "_caller_session": .string(parent)])
        let b = await runtime.hostTool("spawn_agent", ["agent": "fake", "prompt": "job two", "title": "Second", "_caller_session": .string(parent)])
        XCTAssertTrue(a?.text.hasPrefix("Started sub-agent session") == true)
        XCTAssertTrue(b?.text.hasPrefix("Started sub-agent session") == true)
        XCTAssertEqual(brain.children(of: parent).count, 2)
        XCTAssertTrue(runtime.isWorking(brain.children(of: parent).first { $0.task.hasPrefix("SLOW") }!.id))
        let w = await runtime.hostTool("wait_for_agents", ["timeout_seconds": 20, "_caller_session": .string(parent)])
        let text = w?.text ?? ""
        XCTAssertTrue(text.contains("Done: SLOW job one"), text)
        XCTAssertTrue(text.contains("## Second"), text)
        XCTAssertFalse(text.contains("still running"))
        XCTAssertTrue(runtime.workingSessionIDs.isEmpty)
        for k in brain.children(of: parent) { runtime.stop(k.id) }
        runtime.stop(parent)
    }

    @MainActor
    func testDepthAndFanOutLimits() async throws {
        let (brain, runtime) = try makeRuntime()
        var parent: RecordID? = nil
        for i in 0...runtime.maxSubAgentDepth {
            parent = brain.createSession(title: "L\(i)", agentID: "fake", machine: "m", cwd: dir.path, encrypted: false, parentID: parent)
        }
        do {
            _ = try await runtime.spawn(agentID: "fake", prompt: "too deep", parentID: parent)
            XCTFail("expected depth limit")
        } catch let e as HappierRuntime.SpawnError {
            if case .tooDeep = e {} else { XCTFail("\(e)") }
        }
        let busy = brain.createSession(title: "Busy", agentID: "fake", machine: "m", cwd: dir.path, encrypted: false)
        for i in 0..<runtime.maxActiveChildren {
            let k = brain.createSession(title: "K\(i)", agentID: "fake", machine: "m", cwd: dir.path, encrypted: false, parentID: busy)
            brain.updateSession(k, status: .running)
        }
        let r = await runtime.hostTool("spawn_agent", ["agent": "fake", "prompt": "one more", "_caller_session": .string(busy)])
        XCTAssertEqual(r?.isError, true)
        XCTAssertTrue(r?.text.contains("already running") == true, r?.text ?? "")
        let unknown = await runtime.hostTool("spawn_agent", ["agent": "nope", "prompt": "x"])
        XCTAssertEqual(unknown?.isError, true)
        XCTAssertEqual(brain.sessions().count, runtime.maxSubAgentDepth + 2 + runtime.maxActiveChildren)
    }

    @MainActor
    func testMCPSessionEndpointPassesTheCaller() async throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "test")
        let host = LocalMCPHost(tools: tools, runtime: runtime)
        let base = try host.start(runtime: runtime)
        defer { host.stop() }
        let parent = brain.createSession(title: "Parent", agentID: "claude", machine: "m", cwd: "/tmp", encrypted: false)
        _ = brain.createSession(title: "Unrelated", agentID: "claude", machine: "m", cwd: "/tmp", encrypted: false)
        func call(_ path: String) async throws -> String {
            var req = URLRequest(url: URL(string: base + path)!)
            req.httpMethod = "POST"
            req.httpBody = Data(#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_sessions","arguments":{}}}"#.utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(host.token)", forHTTPHeaderField: "Authorization")
            let (d, _) = try await URLSession.shared.data(for: req)
            return String(decoding: d, as: UTF8.self)
        }
        let scoped = try await call("/mcp/session/\(parent)")
        XCTAssertTrue(scoped.contains("no sub-agents yet"), scoped)
        let global = try await call("/mcp")
        XCTAssertTrue(global.contains("Unrelated"), global)
    }
}
