import Foundation
import BasedCore

// BSD-126: Auto-Routing part 3 — the classifier in the chat (decided when the turn starts, without blocking the
// prompt queue), effort per turn, agents with model "auto", sub-agents without an agent id, the budget forcing
// Low, a fallback chain for engines chosen in the picker, and the engine that actually answered on the meta line.

/// A backend that can say which engine answered the last turn (the meta line shows it, not the planned one).
public protocol ChatBackendReport: ChatBackend {
    var answeredLabel: String? { get }
}

extension FallbackChatBackend: ChatBackendReport {
    /// Label of the candidate that answered the last turn.
    public var answeredLabel: String? { candidates[answeredIndex].label }
}

public extension ChatRouting {
    /// The backend for a decision: the routed engine, followed by the rest of its chain when there is one
    /// (`FallbackChatBackend`). The first engine gets the decision's effort, the others their own defaults.
    static func backend(for decision: RouteDecision, make: (ChatEngineChoice, _ effort: String) -> ChatBackend) -> ChatBackend {
        let first = make(decision.choice, decision.effort)
        guard decision.choice != .none, !decision.fallbacks.isEmpty else { return first }
        return FallbackChatBackend([FallbackChatBackend.Candidate(label: label(decision.choice), backend: first)]
            + decision.fallbacks.map { FallbackChatBackend.Candidate(label: label($0), backend: make($0, "")) })
    }
}

/// Starts at once with the rule-based decision and asks the classifier inside `run`, so the prompt queue still
/// gets its turn handle synchronously. When the classifier picks another route, the backend for it is built
/// (on the main actor) and answers instead; a CLI session of another engine is not resumed.
public final class RoutedChatBackend: ChatBackendReport, @unchecked Sendable {
    public typealias Refine = @Sendable () async -> RouteDecision
    public typealias Make = @MainActor @Sendable (RouteDecision) -> ChatBackend

    private let state: Locked<(decision: RouteDecision, backend: ChatBackend)>
    private let refine: Refine?
    private let make: Make

    public init(decision: RouteDecision, refine: Refine?, make: @escaping Make, initial: ChatBackend) {
        self.state = Locked((decision, initial)); self.refine = refine; self.make = make
    }

    /// The decision this turn ran with (after the classifier, once `run` started).
    public var decision: RouteDecision { state.current.decision }
    public var resumeKind: String? { state.current.backend.resumeKind }
    public var answeredLabel: String? {
        let s = state.current
        return (s.backend as? ChatBackendReport)?.answeredLabel ?? ChatRouting.label(s.decision.choice)
    }

    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        var req = request
        var backend = state.current.backend
        if let refine {
            let before = state.current.decision
            let d = await refine()
            try Task.checkCancellation()
            if d.choice != before.choice || d.fallbacks != before.fallbacks {
                let b = await make(d)
                if b.resumeKind != backend.resumeKind { req.resume = nil }
                backend = b
            }
            let picked = backend
            state.sync { $0 = (d, picked) }
        }
        return try await backend.run(req, session: session, emit: emit)
    }
}

public extension ModelRouter {
    /// Whether the classifier would be asked for `task` (no rule is sure about it).
    func needsClassifier(_ task: RouteTask) -> Bool { ruleRoute(task) == nil }

    /// The classifier for the chat: Apple Intelligence on device when it is set up (free, private), otherwise the
    /// smallest cloud model (tier `@small`). nil when nothing can classify.
    static func classifier(registry: ModelRegistry, defaultModel: String) -> RouteClassifier? {
        if let p = registry.all.first(where: \.isOnDevice), let m = p.models.first {
            return ModelRouteClassifier(provider: p, model: m)
        }
        guard let ref = apiModel("@small", registry: registry, defaultModel: defaultModel),
              let (p, m) = registry.resolve(ref) else { return nil }
        return ModelRouteClassifier(provider: p, model: m)
    }

    /// The compute level of an Agents-database "Model" value `auto`, `auto:low`, `auto:high` (case-insensitive);
    /// nil for an explicit model or an empty value.
    static func autoLevel(_ model: String?) -> ComputeLevel? {
        let m = (model ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        switch m {
        case "auto", "auto:auto": return .auto
        case "auto:low": return .low
        case "auto:high": return .high
        default: return nil
        }
    }

    /// Route for a sub-agent session (`spawn_agent` without an agent): only coding-agent CLIs that are set up here
    /// (`available`) can answer. The session runs with its CLI's own model, so the decision carries the kind only.
    func subAgent(_ task: RouteTask, compute: ComputeLevel, forceLow: Bool = false,
                  available: Set<ChatEngineSpec.Kind>) -> RouteDecision {
        var d = decide(task, compute: compute, forceLow: forceLow, registry: ModelRegistry(), installed: available, defaultModel: "")
        func plain(_ c: ChatEngineChoice) -> ChatEngineChoice? {
            if case .cli(let s) = c { return .cli(ChatEngineSpec(kind: s.kind)) }
            return nil
        }
        var chain: [ChatEngineChoice] = []
        for c in [d.choice] + d.fallbacks { if let p = plain(c), !chain.contains(p) { chain.append(p) } }
        guard let first = chain.first else { return RouteDecision(choice: .none, route: d.route, compute: d.compute, reason: d.reason) }
        d.choice = first; d.effort = ""; d.fallbacks = Array(chain.dropFirst())
        return d
    }
}

public extension ChatEngineSpec.Kind {
    /// Id of the coding-agent definition (`AgentDefinition.id`) for a CLI kind.
    var agentID: String? {
        switch self {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .gemini: return "gemini"
        case .opencode: return "opencode"
        case .auto, .api: return nil
        }
    }

    init?(agentID: String) {
        guard let k = Self.allCases.first(where: { $0.agentID == agentID }) else { return nil }
        self = k
    }
}

public extension AgentBudget {
    /// The router runs this agent on Low from 80 % of its monthly budget or of its daily token budget (BSD-126).
    static func forceLow(_ agent: Agent, runs: [AgentRun], now: Date, calendar: Calendar = .current) -> Bool {
        if let daily = agent.dailyTokenBudget, daily > 0,
           Double(tokensToday(runs, agentID: agent.id, now: now, calendar: calendar)) >= 0.8 * Double(daily) { return true }
        return level(spent: spentThisMonth(runs, agentID: agent.id, now: now, calendar: calendar), budget: agent.monthlyBudget) != .ok
    }
}
