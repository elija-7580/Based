import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Creates a page with its first answer, then says "done"; records model and effort of every call.
private final class HomeProvider: AIProvider, @unchecked Sendable {
    let id = "anthropic", displayName = "A"
    let models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    let effort: String
    let log: Locked<[(model: String, effort: String)]>
    init(effort: String = "", log: Locked<[(model: String, effort: String)]> = Locked([])) { self.effort = effort; self.log = log }
    func withEffort(_ effort: String) -> AIProvider { effort.isEmpty ? self : HomeProvider(effort: effort, log: log) }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        log.sync { $0.append((model, effort)) }
        if messages.last?.role == .user {
            var m = ChatMessage.assistant("")
            m.toolCalls = [ToolCall(id: "c1", name: "create_page", arguments: ["title": "From home", "markdown": "x"])]
            return AIResponse(message: m)
        }
        return AIResponse(message: .assistant("done"))
    }
}

/// BSD-128: per-message compute, model and permission mode from the home screen's field.
@MainActor
struct MainAgentTurnTests {
    private func make() -> (BrainStore, Locked<[(model: String, effort: String)]>, MainAgent) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let log = Locked<[(model: String, effort: String)]>([])
        let reg = ModelRegistry(); reg.register(HomeProvider(log: log))
        return (brain, log, MainAgent(runtime: AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))))
    }

    @Test func optionsPickModelAndEffort() {
        let (_, _, main) = make()
        let low = main.turn(.default)
        #expect(low.modelRef == "anthropic/claude-haiku-5-5" && low.compute == .low)
        let high = main.turn(MainTurnOptions(compute: .high))
        #expect(high.modelRef == "anthropic/claude-opus-5-5" && high.effort == "high" && high.compute == .high)
        let exact = main.turn(MainTurnOptions(compute: .low, model: "anthropic/claude-sonnet-5-5"))
        #expect(exact.modelRef == "anthropic/claude-sonnet-5-5" && exact.effort.isEmpty)
        #expect(main.turn(MainTurnOptions(model: "nope/model")).modelRef == "anthropic/claude-haiku-5-5", "unknown model → by level")
        #expect(MainTurnOptions(compute: .high, permission: .plan).label == "High · Plan mode")
        #expect(MainTurnOptions(model: "anthropic/claude-sonnet-5-5").label == "claude-sonnet-5-5")
        #expect(MainTurnOptions.default.label == "Low")
    }

    @Test func optionsReachTheTurn() async throws {
        let (brain, log, main) = make()
        main.permissions = AgentPermissions(mode: .bypass)
        let sid = brain.createSession(title: "Main", agentID: "based", machine: "t", cwd: "", encrypted: false)
        // Plan mode for this message: the model is called with High's model and effort, the page is not created.
        let t = main.turn(MainTurnOptions(compute: .high, permission: .plan))
        let plan = MainAgentChatBackend(agent: main, modelRef: try #require(t.modelRef), effort: t.effort,
                                        permissions: AgentPermissions(mode: .plan))
        _ = try await plan.run(ChatRequest(prompt: "Make a page"), session: sid, emit: { _ in })
        #expect(log.current.first?.model == "claude-opus-5-5" && log.current.allSatisfy { $0.effort == "high" })
        #expect(!brain.store.blocks.values.contains { brain.store.title(of: $0.id) == "From home" })
        // Without options the agent's own permissions (bypass) hold and the page is created.
        log.sync { $0 = [] }
        let plain = MainAgentChatBackend(agent: main, modelRef: try #require(main.turn(.default).modelRef))
        _ = try await plain.run(ChatRequest(prompt: "Make a page"), session: sid, emit: { _ in })
        #expect(log.current.first?.model == "claude-haiku-5-5" && log.current.allSatisfy { $0.effort.isEmpty })
        #expect(brain.store.blocks.values.contains { brain.store.title(of: $0.id) == "From home" })
    }
}
