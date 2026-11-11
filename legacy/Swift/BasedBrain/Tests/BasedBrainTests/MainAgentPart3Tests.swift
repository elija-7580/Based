import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Main agent: delegates a code job on the first turn, then reports.
private final class AskProvider: AIProvider, @unchecked Sendable {
    let id = "anthropic", displayName = "A"
    let models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        if let last = messages.last, last.role == .tool { return AIResponse(message: .assistant("Started it: " + last.content)) }
        var m = ChatMessage.assistant("")
        m.toolCalls = [ToolCall(id: "d1", name: "delegate", arguments: ["task": "Fix the sidebar bug", "kind": "code"])]
        return AIResponse(message: m)
    }
}

/// BSD-116: POST /main/ask, heartbeat presets, coding jobs on the server.
@MainActor
struct MainAgentPart3Tests {
    private func server() throws -> (BrainStore, MainAgent, ServerRouter, Locked<[DelegatedJob]>) {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "server")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let reg = ModelRegistry(); reg.register(AskProvider())
        let runtime = AgentRuntime(registry: reg, tools: tools)
        let happier = HappierRuntime(brain: brain, connections: nil, agents: [], machineName: "server")
        let mcp = MCPServer(tools: tools)
        let main = MainAgent(runtime: runtime)
        // As based-server wires it: coding jobs go to a launcher (here a fake one).
        let seen = Locked<[DelegatedJob]>([])
        main.installed = [.claudeCode]
        main.cliLauncher = { job in seen.sync { $0.append(job) }; return "Fixed." }
        mcp.mainAgent = main
        let services = BasedServerServices(store: store, tools: tools, mcp: mcp, sync: SyncServer(store: store), runtime: runtime,
                                           happier: happier, share: ShareService(store: store))
        return (brain, main, BasedServerRoutes.router(services, ownerToken: ServerRouterTests.owner, allowedOrigin: nil), seen)
    }

    @Test func askMainAgentOverTheServer() async throws {
        let (brain, main, router, seen) = try server()
        let routes = ServerRouterTests()
        let body = try JSONValue.object(["text": "Please fix the sidebar bug", "device": "iPhone"]).encoded()
        let denied = await router.handle(routes.req("POST", "/main/ask", body: body))
        #expect(denied.status == 401)
        let r = await router.handle(routes.req("POST", "/main/ask", bearer: ServerRouterTests.owner, body: body))
        #expect(r.status == 200)
        let reply = try JSONValue.parse(r.body)
        let thread = try #require(reply["thread"]?.string)
        #expect(thread == brain.mainThread())
        #expect(reply["text"]?.string?.contains("Started it") == true, Comment(rawValue: reply["text"]?.string ?? ""))
        let md = brain.transcript(thread)
        #expect(md.contains("Please fix the sidebar bug") && md.contains("Started it"))
        await main.waitForDelegations()
        #expect(seen.current.count == 1, "the code job went to the launcher")
        if case .cli(let spec)? = seen.current.first?.choice { #expect(spec.kind == .claudeCode) } else { Issue.record("not a CLI job") }
        let empty = await router.handle(routes.req("POST", "/main/ask", bearer: ServerRouterTests.owner, body: Data("{}".utf8)))
        #expect(empty.status == 400)
    }

    @Test func heartbeatPresetsWriteTheSchedule() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        #expect(brain.mainAgentHeartbeat == "every 2h")
        #expect(MainAgentHeartbeat(schedule: brain.mainAgentHeartbeat) == .every2h)
        brain.setMainAgentHeartbeat(MainAgentHeartbeat.every30m.rawValue)
        #expect(brain.mainAgent()?.schedule == "every 30m")
        brain.setMainAgentHeartbeat(MainAgentHeartbeat.off.rawValue)
        #expect(brain.mainAgent()?.schedule == nil && MainAgentHeartbeat(schedule: nil) == .off)
        #expect(MainAgentHeartbeat(schedule: "hourly") == .every1h)
        #expect(MainAgentHeartbeat(schedule: "every 6h") == .every6h)
        #expect(MainAgentHeartbeat(schedule: "daily 07:00") == nil, "custom schedules stay custom")
        #expect(MainAgentHeartbeat(schedule: "nonsense") == nil)
    }
}
