import Foundation

// BSD-49: Auto-Routing. The chat (and later the main agent / spawn_agent) picks engine and model from the task:
// a small set of routes described in words (Arch-Router / claude-code-router style: scenario + described
// preference, no external proxy), each with an ordered candidate chain per compute level (Low / Auto / High).
// Rules classify first; an optional classifier (a small model) can pick a route when no rule matches.
// An explicit model choice in the picker always wins over the router.

/// How much compute the user wants for Auto: the column of a route's candidate table.
public enum ComputeLevel: String, Codable, CaseIterable, Sendable {
    case low, auto, high

    public var title: String {
        switch self {
        case .low: return "Low"
        case .auto: return "Auto"
        case .high: return "High"
        }
    }

    /// The same level as stored in the Runs database.
    public var runCompute: AgentRun.Compute {
        switch self {
        case .low: return .low
        case .auto: return .auto
        case .high: return .high
        }
    }
}

/// One candidate of a route: an engine with model and effort.
/// For `.api`, `model` is either an exact ref ("anthropic/claude-haiku-4-5") or a tier token:
/// `@small`, `@balanced`, `@strong`, `@default` (the configured default model) or `@onDevice`.
public struct RouteTarget: Codable, Hashable, Sendable {
    public var kind: ChatEngineSpec.Kind
    public var model: String
    public var effort: String

    public init(_ kind: ChatEngineSpec.Kind, _ model: String = "", effort: String = "") {
        self.kind = kind; self.model = model; self.effort = effort
    }

    public static func api(_ tier: String, effort: String = "") -> RouteTarget { RouteTarget(.api, tier, effort: effort) }
    public static func claude(_ model: String = "", effort: String = "") -> RouteTarget { RouteTarget(.claudeCode, model, effort: effort) }
    public static func codex(effort: String = "") -> RouteTarget { RouteTarget(.codex, "", effort: effort) }
    public static let onDevice = RouteTarget(.api, "@onDevice")
}

/// A route: what kind of task it is (in words, also shown to a classifier) and its candidates per compute level.
public struct Route: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    /// Ordered candidates per level: the first available one answers, the rest are the fallback chain.
    public var low: [RouteTarget]
    public var auto: [RouteTarget]
    public var high: [RouteTarget]

    public init(id: String, name: String, description: String, low: [RouteTarget], auto: [RouteTarget], high: [RouteTarget]) {
        self.id = id; self.name = name; self.description = description
        self.low = low; self.auto = auto; self.high = high
    }

    public func candidates(_ level: ComputeLevel) -> [RouteTarget] {
        switch level {
        case .low: return low
        case .auto: return auto
        case .high: return high
        }
    }
}

/// What the router is asked to route.
public struct RouteTask: Sendable, Equatable {
    /// What the user typed.
    public var text: String
    /// Characters of attached / pasted documents.
    public var attachmentChars: Int
    /// The project / working folder, when the task has one (nil for a plain chat in the home folder).
    public var folder: String?
    /// A scheduled or background run.
    public var scheduled: Bool

    public init(text: String, attachmentChars: Int = 0, folder: String? = nil, scheduled: Bool = false) {
        self.text = text; self.attachmentChars = attachmentChars; self.folder = folder; self.scheduled = scheduled
    }
}

/// The router's answer: engine for this turn, why, and what comes next if it fails.
public struct RouteDecision: Sendable, Equatable {
    public var choice: ChatEngineChoice
    /// Effort for the chosen engine ("" = its default).
    public var effort: String
    /// The route that matched (nil for an explicit model choice).
    public var route: Route?
    public var compute: ComputeLevel
    /// Short reason, shown on "why?" and logged in the run.
    public var reason: String
    /// The remaining available candidates of the chain, in order.
    public var fallbacks: [ChatEngineChoice]

    public init(choice: ChatEngineChoice, effort: String = "", route: Route? = nil, compute: ComputeLevel = .auto,
                reason: String = "", fallbacks: [ChatEngineChoice] = []) {
        self.choice = choice; self.effort = effort; self.route = route; self.compute = compute
        self.reason = reason; self.fallbacks = fallbacks
    }

    /// "Route: Writing" for the meta line; empty for an explicit choice.
    public var routeLabel: String { route.map { "Route: " + $0.name } ?? "" }
}

/// Picks a route when no rule matches (a small model on device or the cheapest API model). Returns a route id.
public protocol RouteClassifier: Sendable {
    func classify(_ task: RouteTask, routes: [Route]) async -> String?
}

/// Asks a model to pick a route from their descriptions; expects `{"route": "<id>"}`.
public struct ModelRouteClassifier: RouteClassifier {
    public let provider: AIProvider
    public let model: String

    public init(provider: AIProvider, model: String) { self.provider = provider; self.model = model }

    public func classify(_ task: RouteTask, routes: [Route]) async -> String? {
        let list = routes.map { "- \($0.id): \($0.description)" }.joined(separator: "\n")
        let system = "You route requests to the right kind of model. Pick exactly one route id from the list. Reply with JSON only: {\"route\": \"<id>\"}."
        let user = "Routes:\n\(list)\n\nRequest:\n\(String(task.text.prefix(2000)))"
        guard let r = try? await provider.complete([ChatMessage(role: .system, content: system), ChatMessage(role: .user, content: user)],
                                                  model: model, tools: [], maxTokens: 50) else { return nil }
        return Self.parse(r.message.content, routes: routes)
    }

    /// `{"route":"code"}`, possibly inside a code fence or with surrounding text; also a bare id.
    public static func parse(_ text: String, routes: [Route]) -> String? {
        let ids = Set(routes.map(\.id))
        if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
           let v = try? JSONValue.parse(Data(text[start...end].utf8)), let id = v["route"]?.string, ids.contains(id) {
            return id
        }
        let bare = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "`\"'.")))
        return ids.contains(bare) ? bare : nil
    }
}

/// Model tiers guessed from model names (no provider tells us).
public enum ModelTier: Int, Sendable, Comparable {
    case small = 0, balanced = 1, strong = 2

    public static func < (a: ModelTier, b: ModelTier) -> Bool { a.rawValue < b.rawValue }

    public static func of(_ model: String) -> ModelTier {
        let m = model.lowercased()
        if ["haiku", "mini", "nano", "flash", "lite", "small", "8b", "3b", "1b"].contains(where: m.contains) { return .small }
        if ["opus", "-pro", "ultra", "large", "o3", "o1"].contains(where: m.contains) || m.hasPrefix("gpt-5") { return .strong }
        return .balanced
    }

    init?(token: String) {
        switch token {
        case "@small": self = .small
        case "@balanced": self = .balanced
        case "@strong": self = .strong
        default: return nil
        }
    }
}

public struct ModelRouter: Sendable {
    public var routes: [Route]

    public init(routes: [Route] = ModelRouter.defaultRoutes) { self.routes = routes }

    // MARK: Default routes

    /// Sensible defaults; the user's Routing database (follow-up) can replace them.
    /// Every chain ends with entries that keep the old Auto order (API → Claude Code → Codex → on device).
    public static let defaultRoutes: [Route] = [
        Route(id: "code", name: "Code",
              description: "Write code, fix bugs or change files in a repository or project folder",
              low: [.claude("sonnet", effort: "low"), .codex(effort: "low"), .api("@balanced")],
              auto: [.claude(), .codex(), .api("@strong")],
              high: [.claude("opus", effort: "high"), .codex(effort: "high"), .api("@strong", effort: "high")]),
        Route(id: "quick", name: "Quick",
              description: "Short questions, sorting, summarizing, translating, small edits",
              low: [.api("@small"), .claude("haiku"), .codex(effort: "low"), .onDevice],
              auto: [.api("@small"), .claude("haiku"), .codex(effort: "low"), .api("@default")],
              high: [.api("@balanced"), .claude("sonnet"), .codex(), .api("@default")]),
        Route(id: "write", name: "Writing",
              description: "Write or rewrite longer text: drafts, letters, documents, page content",
              low: [.api("@small"), .claude("haiku"), .codex(effort: "low")],
              auto: [.api("@balanced"), .claude("sonnet"), .codex()],
              high: [.api("@strong", effort: "high"), .claude("opus", effort: "high"), .codex(effort: "high")]),
        Route(id: "research", name: "Research",
              description: "Research with the web: look things up, compare sources, current information",
              low: [.claude("haiku"), .api("@small"), .codex(effort: "low")],
              auto: [.claude("sonnet"), .api("@balanced"), .codex()],
              high: [.claude("opus", effort: "high"), .api("@strong", effort: "high"), .codex(effort: "high")]),
        Route(id: "long", name: "Long document",
              description: "Read or analyse a long document or a large pasted text",
              low: [.api("@balanced"), .claude("sonnet"), .codex(effort: "low")],
              auto: [.api("@balanced"), .claude("sonnet"), .codex()],
              high: [.api("@strong"), .claude("opus"), .codex(effort: "high")]),
        Route(id: "background", name: "Background",
              description: "Scheduled or background work nobody is waiting for",
              low: [.api("@small"), .claude("haiku"), .codex(effort: "low"), .onDevice],
              auto: [.api("@small"), .claude("haiku"), .codex(effort: "low")],
              high: [.api("@balanced"), .claude("sonnet"), .codex()]),
        Route(id: "general", name: "General",
              description: "Everything else: questions about the workspace, planning, conversation",
              low: [.api("@small"), .claude("haiku"), .codex(effort: "low"), .onDevice],
              auto: [.api("@default"), .claude(), .codex(), .onDevice],
              high: [.api("@strong", effort: "high"), .claude("opus", effort: "high"), .codex(effort: "high")]),
    ]

    /// Attachments above this size make it a long-document task.
    public static let longDocumentChars = 100_000

    // MARK: Classification

    /// Rule-based route for `task`, or nil when no rule is sure (then a classifier or "general" decides).
    public func ruleRoute(_ task: RouteTask) -> (id: String, reason: String)? {
        let t = " " + task.text.lowercased() + " "
        func has(_ words: [String]) -> Bool { words.contains { t.contains($0) } }
        if task.scheduled { return ("background", "scheduled run") }
        if task.attachmentChars > Self.longDocumentChars || task.text.count > Self.longDocumentChars {
            return ("long", "attachment of \(max(task.attachmentChars, task.text.count) / 1000)k characters")
        }
        let codeVerbs = ["implement", "fix ", "fixe", "refactor", "debug", "compile", "build ", "baue", "commit", "merge",
                         "pull request", " pr ", "unit test", "write a test", "schreib einen test", "bug", "stack trace",
                         "stacktrace", "function", "funktion", "programmier", "code"]
        let codeNouns = ["repo", "repository", "```", ".swift", ".py", ".ts", ".js", "xcode", "git ", "npm ", "swift test",
                         "compiler", "api endpoint"]
        if has(codeVerbs), task.folder != nil || has(codeNouns) {
            return ("code", task.folder != nil ? "coding task in a project folder" : "coding task")
        }
        if has(codeNouns), has(["implement", "fix", "build", "baue", "änder", "change", "add ", "füg"]) {
            return ("code", "coding task")
        }
        if has(["recherch", "research", "look up", "search the web", "im internet", "im web", "on the web", "latest news",
                "aktuelle", "current price", "neueste", "sources", "quellen"]) {
            return ("research", "needs the web")
        }
        if has(["zusammenfass", "summar", "tl;dr", "tldr", "übersetz", "translate", "sortier", "sort ", "classify",
                "kategorisier", "rechtschreib", "spell", "fasse "]) {
            return ("quick", "summary / sorting / translation")
        }
        if has(["schreib", "write ", "draft", "entwurf", "entwirf", "formulier", "rewrite", "umschreib", "letter", "brief",
                "essay", "blog", "artikel", "article", "e-mail an", "email to"]) {
            return ("write", "writing task")
        }
        let words = task.text.split(whereSeparator: { $0 == " " || $0 == "\n" })
        if words.count <= 12, task.attachmentChars == 0, task.text.contains("?") {
            return ("quick", "short question")
        }
        return nil
    }

    // MARK: Decision

    /// Synchronous decision: rules only, unknown tasks go to "general". `forceLow` (budget exceeded) forces Low.
    public func decide(_ task: RouteTask, compute: ComputeLevel, forceLow: Bool = false, registry: ModelRegistry,
                       installed: Set<ChatEngineSpec.Kind>, defaultModel: String) -> RouteDecision {
        let (id, why) = ruleRoute(task) ?? ("general", "no specific route matched")
        return decision(routeID: id, reason: why, compute: compute, forceLow: forceLow, registry: registry,
                        installed: installed, defaultModel: defaultModel)
    }

    /// Like `decide`, but asks `classifier` when no rule matches (its answer must be a known route id).
    public func route(_ task: RouteTask, compute: ComputeLevel, forceLow: Bool = false, classifier: RouteClassifier?,
                      registry: ModelRegistry, installed: Set<ChatEngineSpec.Kind>, defaultModel: String) async -> RouteDecision {
        var picked = ruleRoute(task)
        if picked == nil, let classifier, let id = await classifier.classify(task, routes: routes), routes.contains(where: { $0.id == id }) {
            picked = (id, "classified")
        }
        let (id, why) = picked ?? ("general", "no specific route matched")
        return decision(routeID: id, reason: why, compute: compute, forceLow: forceLow, registry: registry,
                        installed: installed, defaultModel: defaultModel)
    }

    func decision(routeID: String, reason: String, compute: ComputeLevel, forceLow: Bool, registry: ModelRegistry,
                  installed: Set<ChatEngineSpec.Kind>, defaultModel: String) -> RouteDecision {
        let level: ComputeLevel = forceLow ? .low : compute
        var why = reason
        if forceLow && compute != .low { why += "; budget exceeded → Low" }
        guard let route = routes.first(where: { $0.id == routeID }) ?? routes.first(where: { $0.id == "general" }) ?? routes.first else {
            return RouteDecision(choice: ChatRouting.resolve(.auto, registry: registry, installed: installed, defaultModel: defaultModel),
                                 compute: level, reason: why)
        }
        var available: [(ChatEngineChoice, String)] = []
        for t in route.candidates(level) {
            guard let c = Self.resolve(t, registry: registry, installed: installed, defaultModel: defaultModel) else { continue }
            if !available.contains(where: { $0.0 == c }) { available.append((c, t.effort)) }
        }
        // Nothing of the chain is set up: the plain Auto order, so routing never answers worse than before.
        let plain = ChatRouting.resolve(.auto, registry: registry, installed: installed, defaultModel: defaultModel)
        if available.isEmpty {
            if plain == .none { return RouteDecision(choice: .none, route: route, compute: level, reason: why) }
            return RouteDecision(choice: plain, route: route, compute: level, reason: why + "; no route candidate available")
        }
        if !available.contains(where: { $0.0 == plain }), plain != .none { available.append((plain, "")) }
        return RouteDecision(choice: available[0].0, effort: available[0].1, route: route, compute: level, reason: why,
                             fallbacks: available.dropFirst().map(\.0))
    }

    /// A candidate as an engine choice, or nil when it is not available here (CLI missing, no provider, no such tier).
    public static func resolve(_ t: RouteTarget, registry: ModelRegistry, installed: Set<ChatEngineSpec.Kind>,
                               defaultModel: String) -> ChatEngineChoice? {
        switch t.kind {
        case .claudeCode, .codex, .gemini, .opencode:
            guard installed.contains(t.kind) else { return nil }
            return .cli(ChatEngineSpec(kind: t.kind, model: t.model, effort: t.effort))
        case .api:
            return apiModel(t.model, registry: registry, defaultModel: defaultModel).map(ChatEngineChoice.model)
        case .auto:
            return nil
        }
    }

    /// Resolves a tier token or exact ref against the configured providers (cloud models only for tiers).
    static func apiModel(_ token: String, registry: ModelRegistry, defaultModel: String) -> String? {
        let cloud = registry.byChatPreference.filter { !$0.isOnDevice }
        let defaultIsCloud = !defaultModel.isEmpty && registry.resolve(defaultModel).map { !$0.0.isOnDevice } == true
        switch token {
        case "@onDevice":
            return registry.all.first(where: \.isOnDevice).map { "\($0.id)/\($0.models.first ?? "")" }
        case "@default":
            if defaultIsCloud { return defaultModel }
            return cloud.first.map { "\($0.id)/\($0.models.first ?? "")" }
        default:
            guard let tier = ModelTier(token: token) else {
                guard let (p, _) = registry.resolve(token), token.contains("/") else { return nil }
                return p.isOnDevice && !token.hasPrefix("apple/") ? nil : token
            }
            // The default model's provider first (the user's preferred account), then the others.
            let preferred = defaultIsCloud ? String(defaultModel.split(separator: "/").first ?? "") : ""
            let ordered = cloud.filter { $0.id == preferred } + cloud.filter { $0.id != preferred }
            let all: [(String, String)] = ordered.flatMap { p in p.models.map { (p.id, $0) } }
            guard !all.isEmpty else { return nil }
            if let exact = all.first(where: { ModelTier.of($0.1) == tier }) { return "\(exact.0)/\(exact.1)" }
            // Nearest tier: for small prefer balanced, for strong prefer balanced, for balanced prefer the default.
            if tier == .balanced, defaultIsCloud { return defaultModel }
            let near = all.min { abs(ModelTier.of($0.1).rawValue - tier.rawValue) < abs(ModelTier.of($1.1).rawValue - tier.rawValue) }
            return near.map { "\($0.0)/\($0.1)" }
        }
    }
}

// MARK: - Keeping a conversation on its engine

public extension RouteDecision {
    /// Auto in an ongoing chat: CLIs only see their own session and API models only get the chat history, so
    /// switching between them mid-chat loses context. Prefers a candidate of the same family as the previous turn
    /// (`resumeKey` "<kind>:<id>" of a CLI; no key but earlier turns = API); keeps the decision when none is
    /// available. Changing the model within the family (Haiku → Sonnet, small → strong API model) stays allowed.
    func keepingConversation(resumeKey: String?, hasHistory: Bool) -> RouteDecision {
        guard route != nil, choice != .none else { return self }
        let wantsCLI: String? = resumeKey.flatMap { k in k.split(separator: ":").first.map(String.init) }
        func matches(_ c: ChatEngineChoice) -> Bool {
            switch c {
            case .cli(let s):
                guard let wantsCLI else { return false }
                let kind = s.kind == .claudeCode ? "claude" : s.kind.rawValue
                return kind == wantsCLI
            case .model(let r):
                return wantsCLI == nil && hasHistory && !r.hasPrefix("apple/")
            case .none:
                return false
            }
        }
        guard wantsCLI != nil || hasHistory, !matches(choice) else { return self }
        guard let i = fallbacks.firstIndex(where: matches) else { return self }
        var d = self
        let picked = fallbacks[i]
        d.fallbacks.remove(at: i)
        d.fallbacks.insert(choice, at: 0)
        d.choice = picked
        if case .cli(let s) = picked { d.effort = s.effort } else { d.effort = "" }
        d.reason += "; stays on " + ChatRouting.label(picked) + " to keep the conversation"
        return d
    }
}
