import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Records the effort it was asked for (via `withEffort`) and the models it answered with.
private final class EffortProvider: AIProvider, @unchecked Sendable {
    let id: String
    let displayName = "Effort"
    let models: [String]
    let effort: String
    let log: Locked<[(model: String, effort: String)]>
    init(id: String = "anthropic", models: [String] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
         effort: String = "", log: Locked<[(model: String, effort: String)]> = Locked([])) {
        self.id = id; self.models = models; self.effort = effort; self.log = log
    }
    func withEffort(_ effort: String) -> AIProvider {
        effort.isEmpty ? self : EffortProvider(id: id, models: models, effort: effort, log: log)
    }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        log.sync { $0.append((model, effort)) }
        return AIResponse(message: .assistant("ok"), usage: Usage(inputTokens: 10, outputTokens: 5))
    }
}

/// A backend that answers with its name (or fails before any output).
private struct NamedBackend: ChatBackend {
    var name: String
    var kind: String?
    var fails = false
    let seenResume: Locked<[String?]>
    var resumeKind: String? { kind }
    func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        seenResume.sync { $0.append(request.resume) }
        if fails { throw ClaudePrint.Failure(description: "overloaded") }
        emit(.textDelta(name))
        return ChatReply(text: name)
    }
}

private struct FixedClassifier: RouteClassifier {
    var answer: String?
    func classify(_ task: RouteTask, routes: [Route]) async -> String? { answer }
}

/// BSD-126: Auto-Routing part 3.
@Suite struct RoutingPart3Tests {
    private func anthropic(_ log: Locked<[(model: String, effort: String)]> = Locked([])) -> ModelRegistry {
        let r = ModelRegistry(); r.register(EffortProvider(log: log)); return r
    }

    // MARK: Effort per turn

    @MainActor
    @Test func routeEffortReachesTheProviderCall() async throws {
        let log = Locked<[(model: String, effort: String)]>([])
        let reg = anthropic(log)
        let d = ModelRouter().decide(RouteTask(text: "Schreib einen Blogartikel über Based"), compute: .high, registry: reg,
                                     installed: [], defaultModel: "")
        #expect(d.choice == .model("anthropic/claude-opus-5-5") && d.effort == "high")
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let rt = AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))
        guard case .model(let ref) = d.choice else { Issue.record("no model"); return }
        let backend = ChatRouting.backend(for: d) { c, effort in
            if case .model(let r) = c { return ModelChatBackend(runtime: rt, modelRef: r, effort: effort) }
            return UnavailableChatBackend("x")
        }
        _ = try await ChatEngine.text(from: backend, ChatRequest(prompt: "Schreib einen Blogartikel über Based"))
        #expect(log.current.first?.model == String(ref.dropFirst("anthropic/".count)))
        #expect(log.current.allSatisfy { $0.effort == "high" })
        // Without an effort the provider keeps its own setting.
        log.sync { $0 = [] }
        _ = try await ChatEngine.text(from: ModelChatBackend(runtime: rt, modelRef: ref), ChatRequest(prompt: "hi"))
        #expect(log.current.allSatisfy { $0.effort == "" })
    }

    @Test func anthropicEffortPerTurnLandsInTheRequest() throws {
        let p = AnthropicProvider(apiKey: "k", effort: "low")
        let high = try #require(p.withEffort("high") as? AnthropicProvider)
        let (_, _, body) = try high.request([.user("x")], model: "claude-opus-5-5", tools: [], maxTokens: 100)
        #expect(body["output_config"]?["effort"]?.string == "high")
        #expect((p.withEffort("") as? AnthropicProvider)?.effort == "low", "empty keeps the configured effort")
    }

    // MARK: Budget

    @Test func budgetForcesLow() {
        let now = Date(timeIntervalSince1970: 1_794_200_000)
        var agent = Agent(id: "a1", name: "Digest", instructions: "", schedule: nil, model: "auto", enabled: true, lastRun: nil,
                          dailyTokenBudget: nil)
        func run(cost: Double, tokens: Int) -> AgentRun {
            AgentRun(id: UUID().uuidString, title: "r", status: .done, kind: .schedule, agentID: "a1", parentID: nil, sessionID: nil,
                     engine: "based", model: "m", compute: nil, startedAt: now.addingTimeInterval(-60), endedAt: now,
                     tokens: tokens, cost: cost, result: "", resultPageID: nil)
        }
        #expect(!AgentBudget.forceLow(agent, runs: [run(cost: 9, tokens: 100)], now: now), "no budget set")
        agent.monthlyBudget = 10
        #expect(!AgentBudget.forceLow(agent, runs: [run(cost: 5, tokens: 100)], now: now))
        #expect(AgentBudget.forceLow(agent, runs: [run(cost: 8.5, tokens: 100)], now: now), "80 % of the monthly budget")
        agent.monthlyBudget = nil; agent.dailyTokenBudget = 1000
        #expect(AgentBudget.forceLow(agent, runs: [run(cost: 0, tokens: 850)], now: now), "80 % of the daily tokens")
        #expect(!AgentBudget.forceLow(agent, runs: [run(cost: 0, tokens: 100)], now: now))
        // The router then answers on Low.
        let d = ModelRouter().decide(RouteTask(text: "Schreib einen Brief"), compute: .high, forceLow: true, registry: anthropic(),
                                     installed: [], defaultModel: "")
        #expect(d.compute == .low && d.choice == .model("anthropic/claude-haiku-5-5") && d.reason.contains("budget"))
    }

    // MARK: Agents with model "auto"

    @Test func autoLevels() {
        #expect(ModelRouter.autoLevel("auto") == .auto)
        #expect(ModelRouter.autoLevel(" Auto:High ") == .high)
        #expect(ModelRouter.autoLevel("auto:low") == .low)
        #expect(ModelRouter.autoLevel("anthropic/claude-haiku-5-5") == nil)
        #expect(ModelRouter.autoLevel(nil) == nil)
    }

    @MainActor
    @Test func scheduledAgentWithAutoIsRoutedAndNoted() async throws {
        let log = Locked<[(model: String, effort: String)]>([])
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let rt = AgentRuntime(registry: anthropic(log), tools: AgentTools(store: store, brain: brain))
        let id = brain.saveAgent(name: "Digest", instructions: "Collect what changed today.", schedule: nil, model: "auto:high")
        let agent = try #require(brain.agents().first { $0.id == id })
        _ = await rt.run(agent: agent, trigger: "schedule daily 07:00")
        // Scheduled → route Background; High → @balanced (Sonnet).
        #expect(log.current.first?.model == "claude-sonnet-5-5")
        let run = try #require(brain.runs(RunFilter(agentID: id)).first)
        #expect(run.compute == .high)
        #expect(run.model == "anthropic/claude-sonnet-5-5")
        #expect(MarkdownExporter(store: store).export(page: run.id, includeTitle: false).contains("Route **Background**"))
        // From 80 % of the monthly budget the next run is Low (Haiku).
        brain.setMonthlyBudget(agent: id, 0.000001)
        let again = try #require(brain.agents().first { $0.id == id })
        log.sync { $0 = [] }
        _ = await rt.run(agent: again, trigger: "manual")
        #expect(log.current.first?.model == "claude-haiku-5-5")
    }

    // MARK: Sub-agents

    @Test func subAgentRouteUsesOnlyAvailableCLIs() {
        let task = RouteTask(text: "Fix the failing build", folder: "/p")
        let both = ModelRouter().subAgent(task, compute: .auto, available: [.claudeCode, .codex])
        #expect(both.choice == .cli(ChatEngineSpec(kind: .claudeCode)) && both.route?.id == "code")
        #expect(both.fallbacks == [.cli(ChatEngineSpec(kind: .codex))])
        let codexOnly = ModelRouter().subAgent(task, compute: .high, available: [.codex])
        #expect(codexOnly.choice == .cli(ChatEngineSpec(kind: .codex)) && codexOnly.effort.isEmpty)
        #expect(ModelRouter().subAgent(task, compute: .auto, available: []).choice == .none)
        #expect(ChatEngineSpec.Kind(agentID: "claude") == .claudeCode && ChatEngineSpec.Kind.codex.agentID == "codex")
        #expect(ChatEngineSpec.Kind(agentID: "pi") == nil)
    }

    // MARK: Explicit choice falls back on the Auto chain

    @Test func explicitChoiceGetsTheAutoChainAsFallback() {
        let task = RouteTask(text: "Baue X im Repo Based", folder: "/p")
        let spec = ChatEngineSpec(kind: .claudeCode, model: "opus")
        let d = ChatRouting.route(spec, task: task, compute: .auto, registry: anthropic(), installed: [.claudeCode, .codex], defaultModel: "")
        #expect(d.choice == .cli(spec) && d.route == nil && d.reason == "chosen in the picker")
        #expect(d.fallbacks.first == .cli(ChatEngineSpec(kind: .claudeCode)))
        #expect(d.fallbacks.contains(.cli(ChatEngineSpec(kind: .codex))))
        #expect(!d.fallbacks.contains(d.choice))
        let none = ChatRouting.route(spec, task: task, compute: .auto, registry: ModelRegistry(), installed: [], defaultModel: "")
        #expect(none.choice == .none && none.fallbacks.isEmpty)
    }

    // MARK: Classifier in the chat

    @Test func classifierPrefersOnDeviceThenSmallModel() {
        let reg = anthropic()
        let c = ModelRouter.classifier(registry: reg, defaultModel: "") as? ModelRouteClassifier
        #expect(c?.model == "claude-haiku-5-5" && c?.provider.id == "anthropic")
        reg.register(EffortProvider(id: "apple", models: ["on-device"]))
        let onDevice = ModelRouter.classifier(registry: reg, defaultModel: "") as? ModelRouteClassifier
        #expect(onDevice?.provider.id == "apple")
        #expect(ModelRouter.classifier(registry: ModelRegistry(), defaultModel: "") == nil)
        #expect(ModelRouter().needsClassifier(RouteTask(text: "Let's plan the next quarter and think about hiring")))
        #expect(!ModelRouter().needsClassifier(RouteTask(text: "Fasse das zusammen")))
    }

    @MainActor
    @Test func routedBackendSwitchesToTheClassifiedRoute() async throws {
        let seen = Locked<[String?]>([])
        let reg = anthropic()
        let router = ModelRouter()
        let task = RouteTask(text: "Let's plan the next quarter and think about hiring")
        let initial = router.decide(task, compute: .auto, registry: reg, installed: [.claudeCode], defaultModel: "")
        #expect(initial.route?.id == "general")
        let make: RoutedChatBackend.Make = { d in
            ChatRouting.backend(for: d) { c, _ in
                NamedBackend(name: ChatRouting.label(c), kind: c.isCLI ? "claude" : nil, seenResume: seen)
            }
        }
        let backend = RoutedChatBackend(
            decision: initial,
            refine: { await router.route(task, compute: .auto, classifier: FixedClassifier(answer: "code"), registry: reg,
                                         installed: [.claudeCode], defaultModel: "") },
            make: make, initial: make(initial))
        #expect(backend.resumeKind == nil, "General answers with the API model first")
        let text = try await ChatEngine.text(from: backend, ChatRequest(prompt: "x", resume: "abc"))
        #expect(backend.decision.route?.id == "code" && backend.decision.reason == "classified")
        #expect(text == "Claude Code")
        #expect(backend.answeredLabel == "Claude Code")
        #expect(backend.resumeKind == "claude")
        #expect(seen.current == [nil], "another engine than planned: no resume")
        // Same decision after classifying: nothing rebuilt, the resume id stays.
        let same = RoutedChatBackend(decision: initial, refine: { initial }, make: make, initial: make(initial))
        seen.sync { $0 = [] }
        _ = try await ChatEngine.text(from: same, ChatRequest(prompt: "x", resume: "abc"))
        #expect(seen.current == ["abc"])
    }

    @Test func fallbackReportsTheEngineThatAnswered() async throws {
        let seen = Locked<[String?]>([])
        let fb = FallbackChatBackend([
            .init(label: "Claude Code", backend: NamedBackend(name: "cc", kind: "claude", fails: true, seenResume: seen)),
            .init(label: "Codex", backend: NamedBackend(name: "codex", kind: "codex", seenResume: seen)),
        ])
        let text = try await ChatEngine.text(from: fb, ChatRequest(prompt: "x"))
        #expect(text == "codex")
        #expect(fb.answeredLabel == "Codex")
    }
}

extension SubAgentTests {
    @MainActor
    @Test func spawnWithoutAgentIsRoutedAndNotedInTheRun() async throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        // The fake ACP agent stands in for Claude Code.
        let claude = AgentDefinition(id: "claude", name: "Claude Code", command: "/usr/bin/env",
                                     arguments: ["python3", dir.appendingPathComponent("fake_acp.py").path])
        let runtime = HappierRuntime(brain: brain, connections: nil, agents: [claude], machineName: "test")
        runtime.permissionPolicy = .allowAll
        let parent = try await runtime.startSession(agentID: "claude", cwd: dir.path, title: "Parent", project: "Proj")
        let r = await runtime.hostTool("spawn_agent", ["prompt": "Fix the flaky tests in the repo. TASK-7", "wait": true,
                                                       "_caller_session": .string(parent)])
        #expect(r?.isError == false, Comment(rawValue: r?.text ?? ""))
        let kid = try #require(brain.children(of: parent).first)
        #expect(kid.agentID == "claude")
        let run = try #require(brain.latestRun(forSession: kid.id))
        #expect(run.compute == .auto)
        #expect(run.model == "Claude Code")
        #expect(MarkdownExporter(store: store).export(page: run.id, includeTitle: false).contains("Route **Code**"))
        runtime.stop(kid.id); runtime.stop(parent)
    }
}
