import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Answers every call with a short report (the sub-agent of `ask_main_agent`).
private final class ReportProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake"
    let models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        AIResponse(message: .assistant("Researched it."), usage: Usage(inputTokens: 10, outputTokens: 5))
    }
}

/// BSD-58: MCP covers projects, runs, inbox and the main agent; versions are negotiated; docs list every tool.
@MainActor
struct MCPServerTests {
    private func make(mainAgent: Bool = false) -> (BrainStore, MCPServer) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let mcp = MCPServer(tools: tools)
        if mainAgent {
            let reg = ModelRegistry(); reg.register(ReportProvider())
            mcp.mainAgent = MainAgent(runtime: AgentRuntime(registry: reg, tools: tools))
        }
        return (brain, mcp)
    }

    private func rpc(_ mcp: MCPServer, _ method: String, _ params: JSONValue = .object([:]), session: String? = nil) async -> JSONValue {
        let msg: JSONValue = ["jsonrpc": "2.0", "id": 1, "method": .string(method), "params": params]
        return await mcp.handle(message: msg, session: session) ?? .null
    }

    private func call(_ mcp: MCPServer, _ name: String, _ args: JSONValue = .object([:]), session: String? = nil) async -> (text: String, error: Bool) {
        let r = await rpc(mcp, "tools/call", ["name": .string(name), "arguments": args], session: session)
        return (r["result"]?["content"]?[0]?["text"]?.string ?? "", r["result"]?["isError"]?.bool ?? false)
    }

    @Test(arguments: [("2025-06-18", "2025-06-18"), ("2025-03-26", "2025-03-26"), ("2024-11-05", "2024-11-05"),
                      ("2099-01-01", "2025-06-18"), ("", "2025-06-18")])
    func versionNegotiation(_ asked: String, _ answered: String) async {
        let (_, mcp) = make()
        let params: JSONValue = asked.isEmpty ? .object([:]) : ["protocolVersion": .string(asked)]
        let r = await rpc(mcp, "initialize", params)
        #expect(r["result"]?["protocolVersion"]?.string == answered)
        #expect(r["result"]?["instructions"]?.string?.contains("ask_main_agent") == true)
    }

    @Test func toolsListHasAgentToolsWithSchemas() async {
        let (_, plain) = make()
        var names = (await rpc(plain, "tools/list"))["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        for n in ["inbox", "resolve_inbox", "list_runs", "get_run", "list_projects", "get_project", "create_project", "update_project_status"] {
            #expect(names.contains(n), "\(n) missing")
        }
        #expect(!names.contains("ask_main_agent"), "only offered when a main agent is wired")
        let (_, server) = make(mainAgent: true)
        let tools = (await rpc(server, "tools/list"))["result"]?["tools"]?.array ?? []
        names = tools.compactMap { $0["name"]?.string }
        #expect(names.contains("ask_main_agent"))
        for t in tools {
            #expect(t["inputSchema"]?["type"]?.string == "object", "\(t["name"]?.string ?? "?") has no schema")
            #expect((t["description"]?.string ?? "").count > 20)
        }
        let sessionNames = (await rpc(server, "tools/list", session: "s1"))["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        #expect(!sessionNames.contains("ask_main_agent"), "coding sessions don't get the main agent")
    }

    @Test func projectsRoundTrip() async {
        let (brain, mcp) = make()
        var r = await call(mcp, "list_projects")
        #expect(r.text.contains("No projects yet"))
        r = await call(mcp, "create_project", ["name": "Publit", "goal": "Launch the beta"])
        #expect(!r.error && r.text.contains("Created project [Publit](based://page/"))
        r = await call(mcp, "create_project", ["name": "publit"])
        #expect(r.text.contains("already exists"))
        #expect(brain.projects().count == 1)
        _ = await call(mcp, "create_project", ["name": "Old", "status": "Done"])
        r = await call(mcp, "list_projects", ["status": "active"])
        #expect(r.text.contains("Publit") && !r.text.contains("Old"))
        r = await call(mcp, "get_project", ["project": "Publit"])
        #expect(r.text.contains("# Publit") && r.text.contains("Goal: Launch the beta") && r.text.contains("Latest updates"))
        r = await call(mcp, "update_project_status", ["project": "Publit", "update": "Beta shipped", "status": "Done"])
        #expect(!r.error)
        #expect(brain.project(named: "Publit")?.status == .done)
        r = await call(mcp, "create_project", ["name": "X", "status": "Someday"])
        #expect(r.error && r.text.contains("Unknown status"))
    }

    @Test func listsArePaged() async {
        let (brain, mcp) = make()
        for i in 1...5 { brain.createProject(name: "P\(i)") }
        var r = await call(mcp, "list_projects", ["limit": 2])
        #expect(r.text.split(separator: "\n").filter { $0.hasPrefix("- ") }.count == 2)
        #expect(r.text.hasSuffix("… 3 more (offset: 2)"))
        r = await call(mcp, "list_projects", ["limit": 2, "offset": 4])
        #expect(r.text.split(separator: "\n").count == 1 && !r.text.contains("more"))
        let rid = brain.startRun(title: "Build", kind: .subagent)
        r = await call(mcp, "list_runs", ["limit": 1])
        #expect(r.text.contains(rid))
        r = await call(mcp, "get_run", ["run_id": .string(rid)])
        #expect(r.text.contains("Build"))
    }

    @Test func inboxAnswerWithOptionsFirstAnswerWins() async {
        let (brain, mcp) = make()
        let sid = brain.createSession(title: "Fix tests", agentID: "codex", machine: "m", cwd: "/tmp", encrypted: false)
        let item = brain.addInbox(title: "Run npm test", kind: .permission, sessionID: sid, detail: "npm test",
                                  options: [("allow_once", "Allow"), ("allow_always", "Always"), ("reject_once", "Deny")])
        var r = await call(mcp, "inbox")
        #expect(r.text.contains("[Permission] Run npm test (id: \(item))") && r.text.contains("allow_once=Allow") && r.text.contains("session Fix tests"))
        r = await call(mcp, "resolve_inbox", ["item_id": .string(item), "option": "maybe"])
        #expect(r.error && r.text.contains("Unknown option"))
        r = await call(mcp, "resolve_inbox", ["item_id": .string(item), "answer": "sure"])
        #expect(r.error, "permission requests need an option")
        // A coding agent can't answer the inbox through its session endpoint.
        r = await call(mcp, "resolve_inbox", ["item_id": .string(item), "option": "allow_once"], session: sid)
        #expect(r.error && r.text.contains("Not permitted"))
        #expect(brain.inbox(pendingOnly: true).count == 1)
        r = await call(mcp, "resolve_inbox", ["item_id": .string(item), "option": "allow_once"])
        #expect(!r.error && r.text.contains("Approved"))
        let done = brain.inbox().first { $0.id == item }
        #expect(done?.status == .approved && done?.decision == "allow_once · mcp")
        r = await call(mcp, "resolve_inbox", ["item_id": .string(item), "option": "reject_once"])
        #expect(r.text.contains("Already answered"))
        #expect(brain.inbox().first { $0.id == item }?.status == .approved)
        r = await call(mcp, "inbox")
        #expect(r.text.contains("inbox is empty"))
        r = await call(mcp, "inbox", ["all": true])
        #expect(r.text.contains("Approved: allow_once"))
        // Rejecting option → rejected; question → free text.
        let i2 = brain.addInbox(title: "Push?", kind: .permission, sessionID: nil, detail: "", options: [("allow_once", "Allow"), ("reject_once", "Deny")])
        _ = await call(mcp, "resolve_inbox", ["item_id": .string(i2), "option": "reject_once"])
        #expect(brain.inbox().first { $0.id == i2 }?.status == .rejected)
        let q = brain.addInbox(title: "Which colour?", kind: .question, sessionID: nil, detail: "")
        _ = await call(mcp, "resolve_inbox", ["item_id": .string(q), "answer": "Blue"])
        #expect(brain.inbox().first { $0.id == q }?.decision?.hasPrefix("Blue") == true)
    }

    @Test func resolvingTheInboxAlwaysAsksInAppAgents() {
        let c = PermissionCall.based("resolve_inbox", ["item_id": "x"])
        #expect(c.alwaysAsks)
        for mode in PermissionMode.allCases {
            #expect(AgentPermissions(mode: mode).decide(c).effect != .allow, "\(mode) must not let an agent answer the inbox")
        }
        #expect(AgentPermissions(mode: .bypass, rules: [PermissionRule(.allow, tool: "based.resolve_inbox")]).decide(c).effect == .allow,
                "an explicit allow rule still works")
        #expect(PermissionCall.based("create_project", .object([:])).category == .edit)
    }

    @Test func askMainAgentStartsASubagentRun() async {
        let (brain, mcp) = make(mainAgent: true)
        brain.createProject(name: "Publit")
        let r = await call(mcp, "ask_main_agent", ["task": "Research three competitors", "kind": "research", "project": "Publit"])
        #expect(!r.error && r.text.contains("Started sub-agent run"))
        await mcp.mainAgent?.waitForDelegations()
        let runs = brain.delegatedRuns()
        #expect(runs.count == 1)
        #expect(runs.first?.projectID == brain.project(named: "Publit")?.id)
        #expect(runs.first?.status == .done && runs.first?.result == "Researched it.")
        #expect(brain.mainThread() != nil, "the main thread exists so the result can be posted there")
        let bad = await call(mcp, "ask_main_agent", ["task": "x", "project": "Nope"])
        #expect(bad.error && bad.text.contains("Unknown project"))
    }

    /// BSD-58 follow-up: the app's local MCP host offers `ask_main_agent` through a provider (built per call).
    @Test func localHostOffersTheMainAgentThroughAProvider() async {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let host = LocalMCPHost(tools: tools, runtime: nil)
        func names(_ session: String? = nil) async -> [String] {
            (await rpc(host.mcp, "tools/list", session: session))["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        }
        #expect(!(await names()).contains("ask_main_agent"), "no provider, no tool")
        let reg = ModelRegistry(); reg.register(ReportProvider())
        var built = 0
        var last: MainAgent?
        host.setMainAgent {
            built += 1
            let m = MainAgent(runtime: AgentRuntime(registry: reg, tools: tools)); last = m; return m
        }
        #expect((await names()).contains("ask_main_agent"))
        #expect(!(await names("s1")).contains("ask_main_agent"), "coding sessions don't get the main agent")
        #expect(built == 0, "listing does not build the agent")
        let r = await call(host.mcp, "ask_main_agent", ["task": "Summarise the week"])
        #expect(!r.error && r.text.contains("Started sub-agent run"))
        #expect(built == 1)
        await last?.waitForDelegations()
        #expect(brain.delegatedRuns().first?.result == "Researched it.")
        let denied = await call(host.mcp, "ask_main_agent", ["task": "x"], session: "s1")
        #expect(denied.error, "not callable on a session endpoint")
        host.setMainAgent(nil)
        #expect(!(await names()).contains("ask_main_agent"))
    }

    @Test func docsListEveryTool() async throws {
        let (_, mcp) = make(mainAgent: true)
        let docs = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("docs/mcp.md"), encoding: .utf8)
        var names = (await rpc(mcp, "tools/list"))["result"]?["tools"]?.array?.compactMap { $0["name"]?.string } ?? []
        names += HappierRuntime.subAgentSpecs.map(\.name) + ["approval"]
        for n in names { #expect(docs.contains("`\(n)`"), "docs/mcp.md does not mention \(n)") }
        for t in BasedGuide.topics { #expect(docs.contains(t.name)) }
        #expect(BasedGuide.doc("agents")?.contains("resolve_inbox") == true)
    }
}
