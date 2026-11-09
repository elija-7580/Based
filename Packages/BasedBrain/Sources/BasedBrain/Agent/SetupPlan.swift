import Foundation
import BasedCore

// BSD-56: "Set up in a minute" — connect ChatGPT or Claude and be done. Everything the assistant decides lives here
// (pure, testable under Linux): what is installed and logged in, which steps are still missing for the account the
// user picks, and the defaults that make the main agent, routing, permissions and the Agent Brain useful at once.
// The app's SetupAssistantView only shows these steps and calls `apply`.

/// What the user wants to work with (step 1 of the assistant).
public enum SetupAccount: String, CaseIterable, Codable, Sendable, Identifiable {
    /// ChatGPT subscription through the Codex CLI login.
    case chatgpt
    /// Claude subscription through the Claude Code login.
    case claude
    /// An Anthropic or OpenAI API key.
    case apiKey
    /// No account: on-device model (Apple Intelligence) or a local server only.
    case localOnly

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .chatgpt: return "ChatGPT"
        case .claude: return "Claude"
        case .apiKey: return "API key"
        case .localOnly: return "Only on this device"
        }
    }

    public var subtitle: String {
        switch self {
        case .chatgpt: return "Use your ChatGPT plan (Plus, Pro, Team) through the Codex app."
        case .claude: return "Use your Claude plan (Pro, Max, Team) through Claude Code."
        case .apiKey: return "Pay per use with an Anthropic or OpenAI key."
        case .localOnly: return "Apple Intelligence or a local model — private, fewer abilities."
        }
    }

    public var symbol: String {
        switch self {
        case .chatgpt: return "bubble.left.and.text.bubble.right"
        case .claude: return "sparkle"
        case .apiKey: return "key"
        case .localOnly: return "lock.laptopcomputer"
        }
    }
}

/// Everything detection looks at, injectable so tests run against a fake machine.
public struct SetupProbe: Sendable {
    public var environment: [String: String]
    public var home: String
    public var fileExists: @Sendable (String) -> Bool
    public var readFile: @Sendable (String) -> String?
    public var which: @Sendable (String) -> String?
    /// Keychain items that have a value ("anthropic", "openai", …) — names only, never values.
    public var secrets: Set<String>
    public var serverURL: String
    public var serverToken: Bool
    /// An on-device or local model is available (Apple Intelligence, Ollama URL).
    public var localModel: Bool

    public init(environment: [String: String] = [:], home: String, fileExists: @escaping @Sendable (String) -> Bool,
                readFile: @escaping @Sendable (String) -> String?, which: @escaping @Sendable (String) -> String?,
                secrets: Set<String> = [], serverURL: String = "", serverToken: Bool = false, localModel: Bool = false) {
        self.environment = environment; self.home = home; self.fileExists = fileExists; self.readFile = readFile
        self.which = which; self.secrets = secrets; self.serverURL = serverURL; self.serverToken = serverToken
        self.localModel = localModel
    }

    /// This machine. BSD-37: waits for the login shell's PATH without blocking the caller's thread (was called on
    /// the main actor at launch and could hang it for up to 12 s).
    public static func live(secrets: Set<String>, serverURL: String, serverToken: Bool, localModel: Bool) async -> SetupProbe {
        let env = await ShellEnvironment.load()
        return SetupProbe(environment: env, home: env["HOME"] ?? NSHomeDirectory(),
                          fileExists: { FileManager.default.fileExists(atPath: $0) },
                          readFile: { FileManager.default.contents(atPath: $0).flatMap { String(data: $0, encoding: .utf8) } },
                          which: { ShellEnvironment.which($0) },
                          secrets: secrets, serverURL: serverURL, serverToken: serverToken, localModel: localModel)
    }
}

/// What is there (result of `SetupPlan.detect`).
public struct SetupState: Equatable, Sendable {
    public struct CLI: Equatable, Sendable {
        public var path: String?
        public var loggedIn: Bool
        public var installed: Bool { path != nil }
        public var ready: Bool { installed && loggedIn }
        public init(path: String? = nil, loggedIn: Bool = false) { self.path = path; self.loggedIn = loggedIn }
    }

    public var node: Bool
    public var codex: CLI
    public var claude: CLI
    public var anthropicKey: Bool
    public var openAIKey: Bool
    public var localModel: Bool
    public var serverURL: String
    public var serverToken: Bool

    public init(node: Bool = false, codex: CLI = CLI(), claude: CLI = CLI(), anthropicKey: Bool = false, openAIKey: Bool = false,
                localModel: Bool = false, serverURL: String = "", serverToken: Bool = false) {
        self.node = node; self.codex = codex; self.claude = claude; self.anthropicKey = anthropicKey
        self.openAIKey = openAIKey; self.localModel = localModel; self.serverURL = serverURL; self.serverToken = serverToken
    }

    public var serverConfigured: Bool { !serverURL.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Whether the account can answer right now.
    public func ready(_ a: SetupAccount) -> Bool {
        switch a {
        case .chatgpt: return codex.ready
        case .claude: return claude.ready
        case .apiKey: return anthropicKey || openAIKey
        case .localOnly: return localModel
        }
    }

    public var readyAccounts: [SetupAccount] { SetupAccount.allCases.filter(ready) }

    /// At least one account with tools (an on-device model alone is not "set up" — it cannot use tools).
    public var isReady: Bool { readyAccounts.contains { $0 != .localOnly } }

    /// What to preselect in step 1: what already works, else what is half there (installed CLI, then a key), else ChatGPT.
    public var recommended: SetupAccount {
        if let a = [SetupAccount.claude, .chatgpt, .apiKey].first(where: ready) { return a }
        if claude.installed { return .claude }
        if codex.installed { return .chatgpt }
        return .chatgpt
    }
}

/// One thing still to do for the chosen account (step 2 of the assistant).
public struct SetupStep: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case install, login, apiKey, info }
    public var kind: Kind
    public var title: String
    public var detail: String
    /// Command to run in the embedded terminal (install / login).
    public var command: String?
    /// Keychain names the key field may fill ("anthropic", "openai").
    public var secretKeys: [String]
    public var done: Bool
    public var id: String { kind.rawValue + ":" + title }

    public init(kind: Kind, title: String, detail: String, command: String? = nil, secretKeys: [String] = [], done: Bool) {
        self.kind = kind; self.title = title; self.detail = detail; self.command = command; self.secretKeys = secretKeys; self.done = done
    }
}

/// The defaults the assistant sets (step 3).
public struct SetupDefaults: Equatable, Sendable {
    public var account: SetupAccount
    /// The chat's engine (the picker's selection).
    public var engine: ChatEngineSpec
    /// Compute level for Auto routing in the chat.
    public var compute: ComputeLevel
    /// The main agent runs low; sub-agents use `compute`.
    public var mainAgentCompute: ComputeLevel
    public var permissionMode: PermissionMode
    /// The main agent's heartbeat (its schedule).
    public var heartbeat: String
    /// The daily brief agent's schedule (nil = no daily brief, e.g. on-device only).
    public var dailyBrief: String?
    /// Route ids of the routing table that is active (the built-in table).
    public var routes: [String]
}

/// What `apply` changed in the Agent Brain.
public struct SetupApplied: Equatable, Sendable {
    public var mainAgent: RecordID
    public var mainAgentCreated: Bool
    public var dailyBrief: RecordID?
    public var dailyBriefCreated: Bool
}

public enum SetupPlan {
    public static let dailyBriefName = "Daily brief"
    public static let dailyBriefInstructions = """
    Every morning, write a short brief for the user: what the agents finished and what failed since yesterday, \
    open questions in the Inbox, and what is planned today. Keep it under ten lines, most important first. \
    Based hands you the facts (runs, Inbox, schedules, project updates) — write only from them; do not start new work.
    """

    /// BSD-56's text (rows created with it are adopted as the shipped brief).
    static let legacyDailyBriefInstructions = """
    Every morning, write a short brief for the user: what the agents finished and what failed since yesterday, \
    open questions in the Inbox, and what is planned today. Keep it under ten lines, most important first. \
    Use check_runs and the projects' latest updates; do not start new work.
    """

    // MARK: Detection

    public static func detect(_ p: SetupProbe) -> SetupState {
        let codexPath = p.which("codex"), claudePath = p.which("claude")
        return SetupState(
            node: p.which("node") != nil && p.which("npx") != nil,
            codex: .init(path: codexPath, loggedIn: codexPath != nil && codexLoggedIn(p)),
            claude: .init(path: claudePath, loggedIn: claudePath != nil && claudeLoggedIn(p)),
            anthropicKey: p.secrets.contains("anthropic") || nonEmpty(p.environment["ANTHROPIC_API_KEY"]),
            openAIKey: p.secrets.contains("openai") || nonEmpty(p.environment["OPENAI_API_KEY"]),
            localModel: p.localModel,
            serverURL: p.serverURL, serverToken: p.serverToken)
    }

    /// Codex keeps its login in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); an API key in the
    /// environment works too.
    public static func codexLoggedIn(_ p: SetupProbe) -> Bool {
        if nonEmpty(p.environment["CODEX_API_KEY"]) { return true }
        let dir = p.environment["CODEX_HOME"].flatMap { nonEmpty($0) ? $0 : nil } ?? p.home + "/.codex"
        guard let s = p.readFile(dir + "/auth.json") else { return false }
        // A logged-out file has neither tokens nor a key.
        return s.contains("\"tokens\"") || s.contains("\"access_token\"") || s.range(of: #""OPENAI_API_KEY"\s*:\s*""#, options: .regularExpression) != nil
    }

    /// Claude Code: OAuth token or API key in the environment, `~/.claude/.credentials.json` (Linux), or an account
    /// in `~/.claude.json` (macOS keeps the token itself in the keychain). Same rules as `AgentDoctor`.
    public static func claudeLoggedIn(_ p: SetupProbe) -> Bool {
        if nonEmpty(p.environment["ANTHROPIC_API_KEY"]) || nonEmpty(p.environment["CLAUDE_CODE_OAUTH_TOKEN"]) { return true }
        if p.fileExists(p.home + "/.claude/.credentials.json") { return true }
        if let s = p.readFile(p.home + "/.claude.json"), s.contains("\"oauthAccount\"") || s.contains("\"userID\"") { return true }
        return false
    }

    // MARK: Steps

    /// What is still missing for `account`, in order. All `done` → the account is ready.
    public static func steps(for account: SetupAccount, state s: SetupState) -> [SetupStep] {
        switch account {
        case .chatgpt:
            return cliSteps(name: "Codex", cli: s.codex, node: s.node, install: "npm install -g @openai/codex",
                            login: "codex login", loginDetail: "Opens the browser — sign in with your ChatGPT account.")
        case .claude:
            return cliSteps(name: "Claude Code", cli: s.claude, node: s.node, install: "npm install -g @anthropic-ai/claude-code",
                            login: "claude", loginDetail: "Starts Claude Code — choose “Claude account”, sign in, then type /exit.")
        case .apiKey:
            return [SetupStep(kind: .apiKey, title: "Paste an API key",
                              detail: "Anthropic (console.anthropic.com) or OpenAI (platform.openai.com). Stored in the Keychain.",
                              secretKeys: ["anthropic", "openai"], done: s.anthropicKey || s.openAIKey)]
        case .localOnly:
            return [SetupStep(kind: .info, title: s.localModel ? "On-device model found" : "No on-device model",
                              detail: s.localModel ? "Chats stay on this device. Agents that need tools will ask for an account later."
                                                   : "Turn on Apple Intelligence in System Settings, or add a local model server in Settings → AI.",
                              done: s.localModel)]
        }
    }

    private static func cliSteps(name: String, cli: SetupState.CLI, node: Bool, install: String, login: String, loginDetail: String) -> [SetupStep] {
        var out: [SetupStep] = []
        if !cli.installed && !node {
            out.append(SetupStep(kind: .install, title: "Install Node.js", detail: "Needed to install \(name).",
                                 command: "brew install node", done: false))
        }
        out.append(SetupStep(kind: .install, title: "Install \(name)", detail: cli.installed ? "Found at \(cli.path ?? "")." : "One command, about a minute.",
                             command: cli.installed ? nil : install, done: cli.installed))
        out.append(SetupStep(kind: .login, title: "Sign in", detail: loginDetail, command: cli.loggedIn ? nil : login, done: cli.loggedIn))
        return out
    }

    /// The first step that is not done (what the assistant shows next), nil when everything is done.
    public static func nextStep(for account: SetupAccount, state: SetupState) -> SetupStep? {
        steps(for: account, state: state).first { !$0.done }
    }

    // MARK: Defaults

    public static func defaults(for account: SetupAccount, state: SetupState) -> SetupDefaults {
        let engine: ChatEngineSpec
        switch account {
        case .chatgpt: engine = ChatEngineSpec(kind: .codex)
        case .claude: engine = ChatEngineSpec(kind: .claudeCode)
        case .apiKey, .localOnly: engine = .auto      // the router picks the model for the task
        }
        return SetupDefaults(account: account, engine: engine, compute: .auto, mainAgentCompute: .low,
                             permissionMode: .ask, heartbeat: "every 2h",
                             dailyBrief: account == .localOnly ? nil : "daily 06:30",
                             routes: ModelRouter.defaultRoutes.map(\.id))
    }

    /// Whether to show the assistant: never twice once finished; otherwise only while nothing works yet.
    public static func needsAssistant(state: SetupState, completed: Bool) -> Bool {
        !completed && !state.isReady
    }

    // MARK: Apply (Agent Brain)

    /// Creates the main agent (with its heartbeat) and the daily brief agent if they are missing. Existing agents
    /// keep the user's schedule and instructions — running the assistant again changes nothing that was edited.
    @MainActor @discardableResult
    public static func apply(_ d: SetupDefaults, brain: BrainStore) -> SetupApplied {
        let hadMain = brain.mainAgent() != nil
        let main = brain.ensureMainAgent()
        if !hadMain, main.schedule != d.heartbeat {
            _ = brain.saveAgent(name: main.name, instructions: main.instructions, schedule: d.heartbeat, model: main.model)
        }
        var briefID: RecordID?, briefCreated = false
        if let sched = d.dailyBrief {
            let all = brain.agents()
            if let existing = all.first(where: BrainStore.isDailyBrief) ?? all.first(where: { $0.name == dailyBriefName }) {
                briefID = existing.id
                // BSD-57: a row from BSD-56 (before the Kind marker) with untouched instructions is the shipped brief.
                if !BrainStore.isDailyBrief(existing), existing.kind.isEmpty,
                   [dailyBriefInstructions, legacyDailyBriefInstructions].map(plain).contains(plain(existing.instructions)) {
                    brain.markDailyBrief(existing.id)
                }
            } else {
                let id = brain.saveAgent(name: dailyBriefName, instructions: dailyBriefInstructions, schedule: sched, model: nil)
                brain.markDailyBrief(id)
                briefID = id
                briefCreated = true
            }
        }
        return SetupApplied(mainAgent: main.id, mainAgentCreated: !hadMain, dailyBrief: briefID, dailyBriefCreated: briefCreated)
    }

    /// Instructions as stored in the page body come back with Markdown escapes ("check\\_runs").
    private static func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func nonEmpty(_ s: String?) -> Bool { !(s?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }
}
