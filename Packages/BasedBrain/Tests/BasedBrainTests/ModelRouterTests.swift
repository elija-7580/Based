import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-49: Auto-Routing — rule routes, classifier, compute columns, fallback chain, budget force, explicit choice,
/// keeping a chat on its engine family, and the run note.
private struct TierProvider: AIProvider {
    var id: String
    var displayName: String { id }
    var models: [String]
    var reply = "ok"
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        AIResponse(message: ChatMessage(role: .assistant, content: reply))
    }
}

private struct FakeClassifier: RouteClassifier {
    var answer: String?
    func classify(_ task: RouteTask, routes: [Route]) async -> String? { answer }
}

@Suite struct ModelRouterTests {
    private func registry(_ ps: [TierProvider]) -> ModelRegistry {
        let r = ModelRegistry()
        for p in ps { r.register(p) }
        return r
    }
    private var anthropic: ModelRegistry {
        registry([TierProvider(id: "anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])])
    }
    private let router = ModelRouter()

    @Test func ruleRoutes() {
        #expect(router.ruleRoute(RouteTask(text: "Fix the crash in the sidebar", folder: "/Users/e/Based"))?.id == "code")
        #expect(router.ruleRoute(RouteTask(text: "Implementiere BSD-49 im repo"))?.id == "code")
        #expect(router.ruleRoute(RouteTask(text: "Fasse diese Seite zusammen"))?.id == "quick")
        #expect(router.ruleRoute(RouteTask(text: "Summarize this page please"))?.id == "quick")
        #expect(router.ruleRoute(RouteTask(text: "Recherchiere die aktuellen Preise für Mac minis"))?.id == "research")
        #expect(router.ruleRoute(RouteTask(text: "Schreib einen Brief an die Hausverwaltung"))?.id == "write")
        #expect(router.ruleRoute(RouteTask(text: "Was steht morgen an?"))?.id == "quick")
        #expect(router.ruleRoute(RouteTask(text: "x", attachmentChars: 150_000))?.id == "long")
        #expect(router.ruleRoute(RouteTask(text: "Schreib den Code", scheduled: true))?.id == "background", "scheduled wins")
        #expect(router.ruleRoute(RouteTask(text: "Let's plan the next quarter for the team and think about hiring")) == nil)
    }

    @Test func computeColumnsPickTiers() {
        let r = anthropic
        let quick = RouteTask(text: "Fasse diese Seite zusammen")
        #expect(router.decide(quick, compute: .auto, registry: r, installed: [], defaultModel: "").choice == .model("anthropic/claude-haiku-5-5"))
        #expect(router.decide(quick, compute: .high, registry: r, installed: [], defaultModel: "").choice == .model("anthropic/claude-sonnet-5-5"))
        let write = RouteTask(text: "Schreib einen Blogartikel über Based")
        #expect(router.decide(write, compute: .low, registry: r, installed: [], defaultModel: "").choice == .model("anthropic/claude-haiku-5-5"))
        #expect(router.decide(write, compute: .auto, registry: r, installed: [], defaultModel: "").choice == .model("anthropic/claude-sonnet-5-5"))
        let high = router.decide(write, compute: .high, registry: r, installed: [], defaultModel: "")
        #expect(high.choice == .model("anthropic/claude-opus-5-5"))
        #expect(high.route?.id == "write" && high.routeLabel == "Route: Writing" && high.compute == .high)
    }

    @Test func codeGoesToCodingAgentsWithFallbackChain() {
        let task = RouteTask(text: "Baue X im Repo Based", folder: "/Users/e/Based")
        let d = router.decide(task, compute: .auto, registry: anthropic, installed: [.claudeCode, .codex], defaultModel: "")
        #expect(d.choice == .cli(ChatEngineSpec(kind: .claudeCode)))
        #expect(d.fallbacks == [.cli(ChatEngineSpec(kind: .codex)), .model("anthropic/claude-opus-5-5")])
        let noClaude = router.decide(task, compute: .high, registry: anthropic, installed: [.codex], defaultModel: "")
        #expect(noClaude.choice == .cli(ChatEngineSpec(kind: .codex, effort: "high")), "missing CLI → next in chain")
        #expect(noClaude.effort == "high")
        let high = router.decide(task, compute: .high, registry: ModelRegistry(), installed: [.claudeCode], defaultModel: "")
        #expect(high.choice == .cli(ChatEngineSpec(kind: .claudeCode, model: "opus", effort: "high")))
    }

    @Test func generalAutoKeepsTheOldAutoOrder() {
        let plan = RouteTask(text: "Let's plan the next quarter for the team and think about hiring")
        let r = anthropic
        for (installed, model) in [(Set<ChatEngineSpec.Kind>(), ""), ([.claudeCode], "anthropic/claude-sonnet-5-5")] {
            let d = router.decide(plan, compute: .auto, registry: r, installed: installed, defaultModel: model)
            #expect(d.choice == ChatRouting.resolve(.auto, registry: r, installed: installed, defaultModel: model))
        }
        let cliOnly = router.decide(plan, compute: .auto, registry: ModelRegistry(), installed: [.codex], defaultModel: "")
        #expect(cliOnly.choice == .cli(ChatEngineSpec(kind: .codex)))
        #expect(router.decide(plan, compute: .auto, registry: ModelRegistry(), installed: [], defaultModel: "").choice == .none)
    }

    @Test func tiersFallBackToNearestAndPreferDefaultProvider() {
        let openaiOnly = registry([TierProvider(id: "openai", models: ["gpt-4.1"])])
        let quick = RouteTask(text: "Summarize this")
        #expect(router.decide(quick, compute: .auto, registry: openaiOnly, installed: [], defaultModel: "").choice == .model("openai/gpt-4.1"),
                "no small model → nearest tier")
        let both = registry([TierProvider(id: "anthropic", models: ["claude-haiku-5-5"]), TierProvider(id: "openai", models: ["gpt-4.1-mini"])])
        #expect(router.decide(quick, compute: .auto, registry: both, installed: [], defaultModel: "openai/gpt-4.1-mini").choice == .model("openai/gpt-4.1-mini"))
        #expect(ModelTier.of("claude-haiku-5-5") == .small && ModelTier.of("gpt-5") == .strong && ModelTier.of("claude-sonnet-5-5") == .balanced)
        // On device only appears where a route lists it, never as a tier.
        let onDevice = registry([TierProvider(id: "apple", models: ["on-device"])])
        #expect(router.decide(quick, compute: .low, registry: onDevice, installed: [], defaultModel: "").choice == .model("apple/on-device"))
    }

    @Test func budgetForcesLow() {
        let write = RouteTask(text: "Write a long article")
        let d = router.decide(write, compute: .high, forceLow: true, registry: anthropic, installed: [], defaultModel: "")
        #expect(d.compute == .low && d.choice == .model("anthropic/claude-haiku-5-5"))
        #expect(d.reason.contains("budget"))
    }

    @Test func classifierOnlyWhenNoRuleMatches() async {
        let plan = RouteTask(text: "Let's plan the next quarter for the team and think about hiring")
        let d = await router.route(plan, compute: .auto, classifier: FakeClassifier(answer: "research"),
                                   registry: anthropic, installed: [.claudeCode], defaultModel: "")
        #expect(d.route?.id == "research" && d.reason == "classified")
        #expect(d.choice == .cli(ChatEngineSpec(kind: .claudeCode, model: "sonnet")))
        let unknown = await router.route(plan, compute: .auto, classifier: FakeClassifier(answer: "nonsense"),
                                         registry: anthropic, installed: [], defaultModel: "")
        #expect(unknown.route?.id == "general")
        let ruled = await router.route(RouteTask(text: "Fasse zusammen"), compute: .auto, classifier: FakeClassifier(answer: "code"),
                                       registry: anthropic, installed: [], defaultModel: "")
        #expect(ruled.route?.id == "quick", "rules win over the classifier")
        // The model classifier parses JSON, fenced JSON or a bare id.
        let routes = ModelRouter.defaultRoutes
        #expect(ModelRouteClassifier.parse("```json\n{\"route\": \"write\"}\n```", routes: routes) == "write")
        #expect(ModelRouteClassifier.parse("code", routes: routes) == "code")
        #expect(ModelRouteClassifier.parse("{\"route\":\"bogus\"}", routes: routes) == nil)
        let viaModel = await ModelRouteClassifier(provider: TierProvider(id: "anthropic", models: ["h"], reply: "{\"route\":\"long\"}"), model: "h")
            .classify(plan, routes: routes)
        #expect(viaModel == "long")
    }

    @Test func explicitChoiceOverridesTheRouter() {
        let task = RouteTask(text: "Baue X im Repo Based", folder: "/p")
        let spec = ChatEngineSpec(kind: .api, model: "anthropic/claude-haiku-5-5")
        let d = ChatRouting.route(spec, task: task, compute: .high, registry: anthropic, installed: [.claudeCode], defaultModel: "")
        #expect(d.choice == .model("anthropic/claude-haiku-5-5") && d.route == nil && d.routeLabel.isEmpty)
        #expect(d.reason == "chosen in the picker")
        let missing = ChatRouting.route(ChatEngineSpec(kind: .gemini), task: task, compute: .auto, registry: anthropic, installed: [], defaultModel: "")
        #expect(missing.reason.contains("not available"))
        let auto = ChatRouting.route(.auto, task: task, compute: .auto, registry: anthropic, installed: [.claudeCode], defaultModel: "")
        #expect(auto.route?.id == "code" && auto.choice == .cli(ChatEngineSpec(kind: .claudeCode)))
    }

    @Test func ongoingChatStaysOnItsEngineFamily() {
        let r = anthropic
        // Previous turn ran in Claude Code: a writing task stays there (Sonnet) instead of moving to the API.
        let write = router.decide(RouteTask(text: "Schreib einen Brief"), compute: .auto, registry: r, installed: [.claudeCode], defaultModel: "")
        #expect(write.choice == .model("anthropic/claude-sonnet-5-5"))
        let kept = write.keepingConversation(resumeKey: "claude:abc", hasHistory: true)
        #expect(kept.choice == .cli(ChatEngineSpec(kind: .claudeCode, model: "sonnet")))
        #expect(kept.fallbacks.first == .model("anthropic/claude-sonnet-5-5") && kept.reason.contains("keep the conversation"))
        // Previous turns on the API: a coding task stays on the API (it gets the history).
        let code = router.decide(RouteTask(text: "Fix the bug in main.swift"), compute: .auto, registry: r, installed: [.claudeCode], defaultModel: "")
        #expect(code.choice == .cli(ChatEngineSpec(kind: .claudeCode)))
        #expect(code.keepingConversation(resumeKey: nil, hasHistory: true).choice == .model("anthropic/claude-opus-5-5"))
        // New chat: unchanged.
        #expect(code.keepingConversation(resumeKey: nil, hasHistory: false) == code)
        // Nothing of the family available: unchanged.
        let apiOnly = router.decide(RouteTask(text: "Schreib einen Brief"), compute: .auto, registry: r, installed: [], defaultModel: "")
        #expect(apiOnly.keepingConversation(resumeKey: "codex:1", hasHistory: true) == apiOnly)
    }

    @MainActor @Test func decisionIsNotedOnTheRun() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "test", cwd: "", encrypted: false)
        brain.updateSession(sid, status: .running)
        let d = router.decide(RouteTask(text: "Fasse zusammen"), compute: .low, registry: anthropic, installed: [], defaultModel: "")
        brain.noteRoute(session: sid, d)
        let run = brain.latestRun(forSession: sid)
        #expect(run?.model == "anthropic/claude-haiku-5-5")
        #expect(run?.compute == .low)
        let body = run.map { MarkdownExporter(store: store).export(page: $0.id, includeTitle: false) } ?? ""
        #expect(body.contains("Route") && body.contains("Quick"))
    }
}
