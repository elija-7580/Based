import Foundation
import BasedCore

/// Checks whether coding-agent CLIs can actually be launched from Based and explains how to fix it.
public enum AgentDoctor {
    public struct Tool: Sendable, Identifiable, Equatable {
        public var id: String            // "node", "claude", …
        public var name: String
        public var path: String?
        public var version: String?
        public var required: Bool
        public var purpose: String
        public var install: String       // shell command that installs it
        public var docs: String
        public var ok: Bool { path != nil }
    }

    public struct AgentStatus: Sendable, Identifiable, Equatable {
        public enum State: String, Sendable { case ready, missing, needsLogin, unknown }
        public var id: String
        public var name: String
        public var state: State
        public var summary: String
        public var fix: String?          // command to run in a terminal
        public var driver: String        // "Claude Code (native)" / "ACP adapter"
    }

    /// Tool catalogue (versions are probed with `--version`).
    public static let catalog: [(id: String, name: String, required: Bool, purpose: String, install: String, docs: String)] = [
        ("node", "Node.js", true, "Runs npx-based agents and MCP servers", "brew install node", "https://nodejs.org"),
        ("npx", "npx", true, "Starts ACP adapters and MCP servers", "brew install node", "https://docs.npmjs.com/cli/commands/npx"),
        ("claude", "Claude Code", false, "Anthropic's coding agent (uses your Claude subscription)", "npm install -g @anthropic-ai/claude-code", "https://docs.anthropic.com/en/docs/claude-code"),
        ("codex", "Codex CLI", false, "OpenAI's coding agent (ChatGPT login)", "npm install -g @openai/codex", "https://github.com/openai/codex"),
        ("gemini", "Gemini CLI", false, "Google's coding agent", "npm install -g @google/gemini-cli", "https://github.com/google-gemini/gemini-cli"),
        ("opencode", "OpenCode", false, "Open-source coding agent", "npm install -g opencode-ai", "https://opencode.ai"),
        ("git", "Git", false, "Agents commit and diff with git", "xcode-select --install", "https://git-scm.com"),
    ]

    /// Probes every tool (blocking; call off the main thread).
    public static func probeTools() -> [Tool] {
        catalog.map { c in
            let path = ShellEnvironment.which(c.id)
            return Tool(id: c.id, name: c.name, path: path, version: path.flatMap { version(of: $0) }, required: c.required,
                        purpose: c.purpose, install: c.install, docs: c.docs)
        }
    }

    public static func version(of path: String, timeout: TimeInterval = 8) -> String? {
        #if os(macOS) || os(Linux)
        guard let d = ShellEnvironment.run(path, ["--version"], timeout: timeout, environment: ShellEnvironment.environment(), stderrToStdout: true),
              let s = String(data: d, encoding: .utf8) else { return nil }
        let line = s.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? nil : String(line.prefix(60))
        #else
        return nil
        #endif
    }

    /// Status of one configured agent given probed tools.
    public static func status(of def: AgentDefinition, tools: [Tool]) -> AgentStatus {
        func tool(_ id: String) -> Tool? { tools.first { $0.id == id } }
        let cmd = URL(fileURLWithPath: def.command).lastPathComponent
        if def.id == "claude", let c = tool("claude"), c.ok {
            let loggedIn = claudeLoggedIn()
            return AgentStatus(id: def.id, name: def.name, state: loggedIn ? .ready : .needsLogin,
                               summary: loggedIn ? "Claude Code \(c.version ?? "") found — runs natively (no adapter needed)." :
                                "Claude Code found, but no login was detected. Run `claude` once in Terminal and log in.",
                               fix: loggedIn ? nil : "claude", driver: "Claude Code (native)")
        }
        if cmd == "npx" {
            guard tool("node")?.ok == true, tool("npx")?.ok == true else {
                return AgentStatus(id: def.id, name: def.name, state: .missing, summary: "Node.js is required for \(def.name) (started via npx).",
                                   fix: "brew install node", driver: "ACP adapter")
            }
            let cli = def.id == "codex" ? "codex" : def.id
            if let c = tool(cli), !c.ok {
                let install = catalog.first { $0.id == cli }?.install
                return AgentStatus(id: def.id, name: def.name, state: .missing,
                                   summary: "The \(c.name) CLI is not installed — the ACP adapter needs it and its login.", fix: install, driver: "ACP adapter")
            }
            return AgentStatus(id: def.id, name: def.name, state: .ready, summary: "Ready (npx downloads the ACP adapter on first start).", fix: nil, driver: "ACP adapter")
        }
        if ShellEnvironment.which(def.command) != nil {
            return AgentStatus(id: def.id, name: def.name, state: .ready, summary: "\(def.command) found.", fix: nil, driver: "ACP")
        }
        let install = catalog.first { $0.id == cmd }?.install
        return AgentStatus(id: def.id, name: def.name, state: .missing, summary: "`\(def.command)` was not found in your shell PATH.", fix: install, driver: "ACP")
    }

    /// Claude Code stores its login in the keychain (macOS) or ~/.claude/.credentials.json; an API key also works.
    public static func claudeLoggedIn() -> Bool {
        let env = ShellEnvironment.environment()
        if env["ANTHROPIC_API_KEY"]?.isEmpty == false || env["CLAUDE_CODE_OAUTH_TOKEN"]?.isEmpty == false { return true }
        let home = env["HOME"] ?? NSHomeDirectory()
        let fm = FileManager.default
        if fm.fileExists(atPath: "\(home)/.claude/.credentials.json") { return true }
        // macOS keeps the OAuth token in the keychain; ~/.claude.json with an account means a completed login.
        if let d = fm.contents(atPath: "\(home)/.claude.json"), let s = String(data: d, encoding: .utf8),
           s.contains("\"oauthAccount\"") || s.contains("\"userID\"") { return true }
        return false
    }

    /// Launches the agent's ACP adapter and performs `initialize` (with timeout) — proves the whole chain works.
    public static func testACP(_ def: AgentDefinition, cwd: String = NSHomeDirectory(), timeout: TimeInterval = 45) async -> Result<String, Error> {
        let client = ACPClient(definition: def)
        do {
            try client.start(cwd: cwd)
            let ok: Bool = try await withThrowingTaskGroup(of: Bool.self) { g in
                g.addTask { try await client.initialize(); return true }
                g.addTask { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)); return false }
                let first = try await g.next() ?? false
                g.cancelAll()
                return first
            }
            client.stop()
            guard ok else { return .failure(JSONRPCPeer.RPCError(code: -1, message: "No answer within \(Int(timeout)) s (first npx start can take a while — try again).")) }
            let name = client.agentInfo["name"]?.string ?? client.agentInfo["title"]?.string ?? def.name
            return .success("\(name) answered the ACP handshake.")
        } catch {
            client.stop()
            return .failure(error)
        }
    }

    /// Runs `claude -p "Reply with OK" --output-format json` to prove login + model access.
    public static func testClaude(timeout: TimeInterval = 60) -> Result<String, Error> {
        #if os(macOS) || os(Linux)
        guard let exe = ShellEnvironment.which("claude") else { return .failure(JSONRPCPeer.RPCError(code: -1, message: "claude not found")) }
        guard let d = ShellEnvironment.run(exe, ["-p", "Reply with exactly: OK", "--output-format", "json", "--max-turns", "1"], timeout: timeout,
                                           environment: ShellEnvironment.environment(), cwd: NSHomeDirectory(), stderrToStdout: true),
              let s = String(data: d, encoding: .utf8) else {
            return .failure(JSONRPCPeer.RPCError(code: -1, message: "claude did not answer within \(Int(timeout)) s"))
        }
        if let v = try? JSONValue.parse(Data(s.utf8)), v["is_error"]?.bool == false {
            return .success("Claude Code answered: \(v["result"]?.string?.prefix(40) ?? "OK")")
        }
        return .failure(JSONRPCPeer.RPCError(code: -1, message: String(s.prefix(400))))
        #else
        return .failure(JSONRPCPeer.RPCError(code: -1, message: "Not available on this platform"))
        #endif
    }
}
