import Foundation
import BasedCore

/// The app's private MCP endpoint for local coding agents (Claude Code, Codex …).
///
/// Binds a random port on 127.0.0.1, protects every request with a random bearer token and routes
/// `POST /mcp` and `POST /mcp/session/<sid>` to `MCPServer`. Session-scoped requests expose the
/// `approval` tool (Claude Code's `--permission-prompt-tool`) and the sub-agent host tools, so agents
/// started from Based can read/write the workspace, ask for permission through the Inbox and spawn
/// sub-agents — without any manual MCP setup.
public final class LocalMCPHost: @unchecked Sendable {
    public let token: String
    /// BSD-33: agents get a per-session token (valid only for their `/mcp/session/<sid>`), never `token`.
    public let sessionTokens = MCPSessionTokens()
    public let mcp: MCPServer
    public private(set) var server: HTTPServer?
    public private(set) var requestCount = 0
    private let lock = NSLock()

    /// `http://127.0.0.1:<port>` once started.
    public var baseURL: String? {
        guard let s = server, s.isRunning else { return nil }
        return "http://127.0.0.1:\(s.boundPort)"
    }

    @MainActor
    public init(tools: AgentTools, runtime: HappierRuntime?, token: String? = nil) {
        self.token = token ?? (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        if let runtime {
            tools.hostSpecs = HappierRuntime.subAgentSpecs
            tools.hostCall = { [runtime] name, args in await runtime.hostTool(name, args) }
        }
        mcp = MCPServer(tools: tools)
        if let runtime {
            mcp.approval = { [runtime] session, tool, input in await runtime.claudeApproval(session: session, tool: tool, input: input) }
        }
    }

    /// Starts listening (port 0 = random free port) and publishes the endpoint to the runtime.
    @discardableResult
    public func start(port: UInt16 = 0, runtime: HappierRuntime? = nil) throws -> String {
        if let b = baseURL { return b }
        let token = self.token
        let mcp = self.mcp
        let sessionTokens = self.sessionTokens
        let s = HTTPServer(port: port, loopbackOnly: true) { [weak self] req in
            self?.countRequest()
            let path = req.path
            guard Self.authorized(bearer: req.bearerToken ?? "", path: path, master: token, sessions: sessionTokens) else {
                return .json(["error": "unauthorized"], status: 401)
            }
            switch (req.method, path) {
            case ("GET", "/health"):
                return .json(["ok": true, "server": "based-app"])
            case ("POST", "/mcp"):
                guard let out = await mcp.handle(req.body) else { return HTTPServer.Response(status: 202) }
                return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
            case ("POST", _) where path.hasPrefix("/mcp/session/"):
                let sid = String(path.dropFirst("/mcp/session/".count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                guard !sid.isEmpty else { return .json(["error": "missing session"], status: 400) }
                guard let out = await mcp.handle(req.body, session: sid) else { return HTTPServer.Response(status: 202) }
                return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
            default:
                return .json(["error": "not found"], status: 404)
            }
        }
        try s.start()
        server = s
        let base = "http://127.0.0.1:\(s.boundPort)"
        runtime?.mcpEndpoint = (base, token)
        runtime?.mcpSessionTokens = sessionTokens
        Log.notice("Local MCP endpoint listening on \(base)", category: "mcp")
        return base
    }

    public func stop() { server?.stop(); server = nil }

    /// BSD-58: offers `ask_main_agent` on the plain `/mcp` route (never on session routes). The provider is
    /// asked on every call, so the app's current model and permission settings apply.
    public func setMainAgent(_ provider: (@MainActor () -> MainAgent?)?) { mcp.mainAgentProvider = provider }

    /// BSD-98: deny rules / Plan mode for every `tools/call` on this endpoint (asked per call).
    public func setPermissions(_ provider: (@MainActor () -> AgentPermissions?)?) { mcp.permissions = provider }

    /// The master token opens every route; a session token only its own `/mcp/session/<sid>`.
    static func authorized(bearer: String, path: String, master: String, sessions: MCPSessionTokens) -> Bool {
        if !master.isEmpty, SecureToken.equal(bearer, master) { return true }
        guard path.hasPrefix("/mcp/session/") else { return false }
        let sid = String(path.dropFirst("/mcp/session/".count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return !sid.isEmpty && sessions.isValid(bearer, session: sid)
    }

    private func countRequest() { lock.lock(); requestCount += 1; lock.unlock() }

    /// `mcpServers` entry for a session (Claude Code `--mcp-config` format).
    public func claudeConfig(session: String) -> JSONValue? {
        guard let b = baseURL else { return nil }
        return ["mcpServers": ["based": ["type": "http", "url": .string("\(b)/mcp/session/\(session)"),
                                         "headers": ["Authorization": .string("Bearer \(sessionTokens.token(for: session))")]]]]
    }
}
