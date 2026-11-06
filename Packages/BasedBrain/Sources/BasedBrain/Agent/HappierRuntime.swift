import Foundation
import BasedCore

/// Keeps MCP client connections alive and publishes their tools into `AgentTools` (for the model-API agent) and as
/// `MCPServerConfig`s for ACP coding agents — configured once, available to every agent.
public final class ConnectionManager: @unchecked Sendable {
    public let tools: AgentTools
    public let secret: @Sendable (String) -> String?
    private let clientsBox = Locked<[RecordID: MCPClient]>([:])
    public var onStatus: (@Sendable (RecordID, String) -> Void)?

    public init(tools: AgentTools, secret: @escaping @Sendable (String) -> String?) { self.tools = tools; self.secret = secret }

    /// (Re)connect every enabled connection and republish tools.
    public func reload() async {
        let conns = await MainActor.run { tools.brain.connections() }
        let old = clientsBox.sync { v -> [String: MCPClient] in let o = v; v.removeAll(); return o }
        for c in old.values { c.disconnect() }
        var specs: [ToolSpec] = []
        for c in conns where c.enabled {
            let client = MCPClient(name: c.name, transport: transport(for: c))
            do {
                try await client.connect()
                clientsBox.sync { $0[c.id] = client }
                let slug = AgentTools.slug(c.name)
                specs += client.tools.map { ToolSpec(name: "\(slug)__\($0.name)", description: "[\(c.name)] \($0.description)", inputSchema: $0.inputSchema) }
                await status(c.id, "Connected · \(client.tools.count) tools")
            } catch {
                await status(c.id, "Error: \(String(describing: error).prefix(120))")
            }
        }
        let final = specs
        await MainActor.run {
            tools.externalSpecs = final
            tools.externalCall = { [weak self] name, args in await self?.call(name, args) }
        }
    }

    private func status(_ id: RecordID, _ s: String) async {
        await MainActor.run { tools.brain.setConnectionStatus(id, s) }
        onStatus?(id, s)
    }

    func transport(for c: Connection) -> MCPClient.Transport {
        let token = secret(c.secretKey)
        switch c.transport {
        case .http: return .http(url: URL(string: c.command) ?? URL(string: "http://localhost")!, bearer: token)
        case .stdio:
            let (cmd, args) = splitCommandLine(c.command)
            var env: [String: String] = [:]
            if let token, !c.envName.isEmpty { env[c.envName] = token }
            return .stdio(command: cmd, args: args, env: env)
        }
    }

    public func call(_ name: String, _ args: JSONValue) async -> AgentTools.ToolResult? {
        guard let sep = name.range(of: "__") else { return nil }
        let slug = String(name[..<sep.lowerBound]), tool = String(name[sep.upperBound...])
        let conns = await MainActor.run { tools.brain.connections() }
        guard let c = conns.first(where: { AgentTools.slug($0.name) == slug }) else { return nil }
        let client = clientsBox.sync { $0[c.id] }
        guard let client else { return AgentTools.ToolResult(text: "Connection \(c.name) is not connected", isError: true) }
        do { let (text, err) = try await client.call(tool, args); return AgentTools.ToolResult(text: text, isError: err) }
        catch { return AgentTools.ToolResult(text: "\(error)", isError: true) }
    }

    /// Stdio connections handed to ACP agents (HTTP ones are bridged through Based's own MCP server).
    public func mcpServers(for conns: [Connection]) -> [MCPServerConfig] {
        conns.filter { $0.enabled && $0.exposeToAgents && $0.transport == .stdio }.map { c in
            let (cmd, args) = splitCommandLine(c.command)
            var env: [String: String] = [:]
            if let t = secret(c.secretKey), !c.envName.isEmpty { env[c.envName] = t }
            return MCPServerConfig(name: AgentTools.slug(c.name), command: ProcessTransport.resolve(cmd), args: args, env: env)
        }
    }
}

/// Happier-style orchestration of coding agents: sessions persisted in Based, streaming transcript, permission
/// requests routed to the Inbox (answer from any device), switch agent mid-session with a hand-off summary,
/// sub-agents reporting back to their parent. Claude Code runs natively (stream-json) when installed; every other
/// agent speaks ACP.
public final class HappierRuntime: @unchecked Sendable {
    public enum PermissionPolicy: String, CaseIterable, Sendable { case ask, allowReads, allowAll }

    public let brain: BrainStore
    public let connections: ConnectionManager?
    public var agents: [AgentDefinition]
    public var machineName: String
    public var cipher: SessionCipher?
    public var permissionPolicy: PermissionPolicy = .ask
    /// Command that exposes Based itself as an MCP server to the agents (so they can read/write the workspace).
    public var basedMCPServer: MCPServerConfig?
    /// HTTP MCP endpoint of this process (app: 127.0.0.1 random port; server: its public port). Enables the
    /// `approval` tool Claude Code uses for permission prompts, scoped per session: `<base>/mcp/session/<id>`.
    public var mcpEndpoint: (base: String, token: String)?
    /// Prefer the real `claude` CLI (stream-json) over the ACP adapter for the "claude" agent.
    public var preferNativeClaude = true
    /// Claude Code permission mode per session ("default", "acceptEdits", "plan", "bypassPermissions").
    public var claudeModes = Locked<[RecordID: String]>([:])
    public var inboxTimeout: TimeInterval = 3600
    public var onUpdate: (@Sendable (RecordID, ACPUpdate) -> Void)?
    public var onLog: (@Sendable (String) -> Void)?

    private let liveBox = Locked<[RecordID: AgentConnection]>([:])
    private let pendingBox = Locked<[RecordID: String]>([:])
    private let lastTextBox = Locked<[RecordID: String]>([:])
    private let alwaysAllowed = Locked<[RecordID: Set<String>]>([:])

    public init(brain: BrainStore, connections: ConnectionManager?, agents: [AgentDefinition] = AgentDefinition.defaults, machineName: String) {
        self.brain = brain; self.connections = connections; self.agents = agents; self.machineName = machineName
    }

    public func connection(for session: RecordID) -> AgentConnection? { liveBox.sync { $0[session] } }
    public func client(for session: RecordID) -> ACPClient? { connection(for: session) as? ACPClient }
    public var liveSessionIDs: [RecordID] { liveBox.sync { Array($0.keys) } }
    public func isNative(_ session: RecordID) -> Bool { connection(for: session) is ClaudeCodeDriver }

    /// Start a new session with an agent in a working directory and persist it.
    @discardableResult
    public func startSession(agentID: String, cwd: String, title: String? = nil, project: String? = nil, parentID: RecordID? = nil) async throws -> RecordID {
        guard let def = agents.first(where: { $0.id == agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(agentID)") }
        let name = title ?? "\(def.name) · \(URL(fileURLWithPath: cwd).lastPathComponent)"
        let proj = project ?? URL(fileURLWithPath: cwd).lastPathComponent
        let sid = await MainActor.run {
            brain.createSession(title: name, agentID: agentID, machine: machineName, cwd: cwd, encrypted: cipher != nil, project: proj, parentID: parentID)
        }
        Log.info("Session \(sid) started: \(def.name) in \(cwd)", category: "agents")
        do {
            try await attach(session: sid, def: def, cwd: cwd, resume: nil)
        } catch {
            await MainActor.run {
                brain.updateSession(sid, status: .failed)
                brain.appendTranscript(sid, role: "Error", markdown: "Could not start \(def.name): \(error)", cipher: cipher)
            }
            Log.error("Could not start \(def.name): \(error)", category: "agents")
            throw error
        }
        return sid
    }

    /// Re-attach a persisted session (e.g. after a restart): relaunches the agent and resumes its conversation when known.
    public func attach(_ sid: RecordID) async throws {
        guard let s = await MainActor.run(body: { brain.sessions().first { $0.id == sid } }) else { throw JSONRPCPeer.RPCError.internalError("Unknown session \(sid)") }
        guard let def = agents.first(where: { $0.id == s.agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(s.agentID)") }
        try await attach(session: sid, def: def, cwd: s.cwd, resume: s.acpSessionID)
    }

    private func useNative(_ def: AgentDefinition) -> String? {
        guard preferNativeClaude, def.id == "claude" else { return nil }
        return ShellEnvironment.which("claude")
    }

    private func attach(session sid: RecordID, def: AgentDefinition, cwd: String, resume: String?) async throws {
        let conns = await MainActor.run { brain.connections() }
        var servers = connections.map { $0.mcpServers(for: conns) } ?? []
        if let exe = useNative(def) {
            // Native Claude Code: our session ids are stored as "claude:<uuid>".
            let resumeID = resume.flatMap { $0.hasPrefix("claude:") ? String($0.dropFirst(7)) : nil }
            var mcp: [String: JSONValue] = [:]
            var promptTool: String?
            if let ep = mcpEndpoint {
                mcp["based"] = ["type": "http", "url": .string("\(ep.base)/mcp/session/\(sid)"), "headers": ["Authorization": .string("Bearer \(ep.token)")]]
                promptTool = "mcp__based__approval"
            } else if let b = basedMCPServer {
                mcp["based"] = ["command": .string(b.command), "args": .array(b.args.map(JSONValue.string))]
            }
            for sv in servers {
                mcp[sv.name] = ["command": .string(sv.command), "args": .array(sv.args.map(JSONValue.string)),
                                "env": .object(sv.env.mapValues(JSONValue.string))]
            }
            var mode = claudeModes.sync { $0[sid] } ?? "default"
            if permissionPolicy == .allowAll && mode == "default" { mode = "bypassPermissions" }
            if promptTool == nil && mode == "default" { mode = "acceptEdits" }
            let context = await MainActor.run { brain.systemContext(query: "") }
            let driver = ClaudeCodeDriver(options: .init(executable: exe, cwd: cwd, resume: resumeID, permissionMode: mode,
                                                         mcpConfig: .object(["mcpServers": .object(mcp)]), permissionPromptTool: promptTool,
                                                         appendSystemPrompt: context.isEmpty ? nil : "Context from the user's Based workspace (use the based MCP tools for more):\n" + String(context.prefix(6000))))
            driver.onUpdate = { [weak self] u in self?.handle(sid, u) }
            driver.onLog = { [weak self] line in self?.onLog?("[claude] \(line)") }
            let brain = self.brain
            driver.onEvent = { e in
                if case .initialized(let csid, _, _, _, _) = e, !csid.isEmpty {
                    Task { await MainActor.run { brain.updateSession(sid, acpSessionID: "claude:" + csid) } }
                }
            }
            try driver.start()
            liveBox.sync { $0[sid] = driver }
            await MainActor.run { brain.updateSession(sid, status: .idle, agentID: def.id) }
            return
        }
        let client = ACPClient(definition: def)
        client.allowedRoots = [cwd]
        client.onLog = { [weak self] in self?.onLog?("[\(def.id)] \($0)") }
        client.onUpdate = { [weak self] u in self?.handle(sid, u) }
        client.onPermission = { [weak self] req in await self?.decide(sid, req) }
        try client.start(cwd: cwd)
        try await client.initialize()
        if let b = basedMCPServer { servers.insert(b, at: 0) }
        let acpID: String
        if let resume, !resume.hasPrefix("claude:") {
            try await client.loadSession(resume, cwd: cwd, mcpServers: servers)
            acpID = resume
        } else {
            acpID = try await client.newSession(cwd: cwd, mcpServers: servers)
        }
        liveBox.sync { $0[sid] = client }
        await MainActor.run { brain.updateSession(sid, status: .idle, acpSessionID: acpID, agentID: def.id) }
    }

    /// Send a user prompt to a session (starting the agent process again if needed).
    public func prompt(_ sid: RecordID, _ text: String) async throws -> ACPStopReason {
        var conn = self.connection(for: sid)
        if conn == nil || conn?.isRunning == false && !(conn is ClaudeCodeDriver) {
            try await attach(sid)
            conn = self.connection(for: sid)
        }
        guard let conn else { throw JSONRPCPeer.RPCError.internalError("No agent") }
        await MainActor.run { brain.appendTranscript(sid, role: "You", markdown: text, cipher: cipher); brain.updateSession(sid, status: .running) }
        let context = conn is ClaudeCodeDriver ? "" : await MainActor.run { brain.systemContext(query: text) }
        do {
            let stop = try await conn.prompt(text, resources: context.isEmpty ? [] : [("based://brain", context)])
            flush(sid)
            await MainActor.run { brain.updateSession(sid, status: stop == .cancelled ? .idle : .done) }
            await reportToParent(sid)
            return stop
        } catch {
            flush(sid)
            await MainActor.run { brain.updateSession(sid, status: .failed); brain.appendTranscript(sid, role: "Error", markdown: "\(error)", cipher: cipher) }
            Log.error("Prompt failed in \(sid): \(error)", category: "agents")
            throw error
        }
    }

    public func cancel(_ sid: RecordID) { connection(for: sid)?.cancel() }

    public func stop(_ sid: RecordID) {
        let c = liveBox.sync { $0.removeValue(forKey: sid) }
        c?.stop()
        Task { await MainActor.run { brain.updateSession(sid, status: .idle) } }
    }

    /// Changes Claude Code's permission mode (default / acceptEdits / plan / bypassPermissions); applies from the next turn.
    public func setClaudeMode(_ sid: RecordID, _ mode: String) {
        claudeModes.sync { $0[sid] = mode }
        if let d = connection(for: sid) as? ClaudeCodeDriver, d.options.permissionMode != mode {
            liveBox.sync { _ = $0.removeValue(forKey: sid) }
            d.stop()   // relaunched with --resume and the new mode on the next prompt
        }
    }

    /// Switch a running session to another agent: the new agent receives the transcript so far as context.
    public func switchAgent(_ sid: RecordID, to agentID: String) async throws {
        guard let def = agents.first(where: { $0.id == agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(agentID)") }
        let s = await MainActor.run { brain.sessions().first { $0.id == sid } }
        guard let s else { throw JSONRPCPeer.RPCError.internalError("Session not found") }
        stop(sid)
        try await attach(session: sid, def: def, cwd: s.cwd, resume: nil)
        let history = await MainActor.run { brain.transcript(sid, cipher: cipher) }
        await MainActor.run { brain.appendTranscript(sid, role: "System", markdown: "Switched to \(def.name).", cipher: cipher) }
        if let c = connection(for: sid) {
            _ = try await c.prompt("You are taking over an ongoing session from another agent. Here is the transcript so far; acknowledge briefly and continue when the user speaks.",
                                   resources: [("based://session/\(sid)/transcript", String(history.suffix(60_000)))])
            flush(sid)
        }
    }

    // MARK: Sub-agents

    /// When a child session finishes a turn, its last answer is posted to the parent session.
    private func reportToParent(_ sid: RecordID) async {
        let info = await MainActor.run { () -> (RecordID, String)? in
            guard let s = brain.sessions().first(where: { $0.id == sid }), let parent = s.parentID else { return nil }
            return (parent, s.title)
        }
        guard let (parent, title) = info else { return }
        let last = lastTextBox.sync { $0[sid] } ?? "(no answer)"
        await MainActor.run {
            brain.appendTranscript(parent, role: "Notice", markdown: "Sub-agent **\(title)** finished:\n\n\(String(last.suffix(3000)))", cipher: cipher)
        }
    }

    /// Tools that let an agent (the built-in AI, or any MCP client) spawn and steer coding agents.
    public static let subAgentSpecs: [ToolSpec] = [
        ToolSpec(name: "spawn_agent", description: "Start a coding-agent session (Claude Code, Codex, Gemini …) in a directory with a task. Runs in the background; its answer is reported back to the parent session. Returns the session id.",
                 inputSchema: .schema(["agent": .str("Agent id: claude | codex | gemini | opencode"), "cwd": .str("Absolute working directory"), "prompt": .str("Task for the agent"), "title": .str("Short session title"), "parent_session_id": .str("Optional parent session id")], required: ["agent", "cwd", "prompt"])),
        ToolSpec(name: "agent_sessions", description: "List coding-agent sessions with status, directory and parent.", inputSchema: .schema([:])),
        ToolSpec(name: "read_agent_session", description: "Read the latest transcript of a coding-agent session.",
                 inputSchema: .schema(["session_id": .str("Session id"), "max_chars": .num("Default 6000")], required: ["session_id"])),
        ToolSpec(name: "message_agent", description: "Send a follow-up prompt to a running coding-agent session (runs in the background).",
                 inputSchema: .schema(["session_id": .str("Session id"), "prompt": .str("Message")], required: ["session_id", "prompt"])),
    ]

    public func hostTool(_ name: String, _ args: JSONValue) async -> AgentTools.ToolResult? {
        switch name {
        case "spawn_agent":
            let agent = args["agent"]?.string ?? "claude", cwd = args["cwd"]?.string ?? NSHomeDirectory(), prompt = args["prompt"]?.string ?? ""
            do {
                let sid = try await startSession(agentID: agent, cwd: cwd, title: args["title"]?.string, parentID: args["parent_session_id"]?.string)
                Task { _ = try? await self.prompt(sid, prompt) }
                return .init(text: "Started session \(sid) (\(agent) in \(cwd)). Use read_agent_session to follow it.", isError: false)
            } catch { return .init(text: "Could not start \(agent): \(error)", isError: true) }
        case "agent_sessions":
            let list = await MainActor.run { brain.sessions() }
            let live = liveSessionIDs
            let text = list.prefix(50).map { s in
                "- \(s.id) · \(s.title) · \(s.agentID) · \(s.status.rawValue)\(live.contains(s.id) ? " · live" : "") · \(s.cwd)" + (s.parentID.map { " · parent \($0)" } ?? "")
            }.joined(separator: "\n")
            return .init(text: text.isEmpty ? "No sessions." : text, isError: false)
        case "read_agent_session":
            guard let sid = args["session_id"]?.string else { return .init(text: "session_id required", isError: true) }
            let n = Int(args["max_chars"]?.number ?? 6000)
            let md = await MainActor.run { brain.transcript(sid, cipher: cipher) }
            return .init(text: String(md.suffix(n)), isError: false)
        case "message_agent":
            guard let sid = args["session_id"]?.string, let p = args["prompt"]?.string else { return .init(text: "session_id and prompt required", isError: true) }
            Task { _ = try? await self.prompt(sid, p) }
            return .init(text: "Sent.", isError: false)
        default: return nil
        }
    }

    // MARK: Updates & permissions

    private func handle(_ sid: RecordID, _ u: ACPUpdate) {
        onUpdate?(sid, u)
        switch u {
        case .agentText(let t): pendingBox.sync { $0[sid, default: ""] += t }
        case .agentThought(let t):
            flush(sid); append(sid, role: "Thought", t)
        case .toolCall(_, let title, let kind, _):
            flush(sid); append(sid, role: "Tool", "`\(kind)` \(title)")
        case .toolCallUpdate(_, let status, let output):
            if status == "completed" || status == "failed" {
                append(sid, role: status == "failed" ? "Tool failed" : "Tool result", "```\n\((output ?? "").prefix(4000))\n```")
            }
        case .plan(let items): flush(sid); append(sid, role: "Plan", items.map { "- \($0)" }.joined(separator: "\n"))
        case .usage(let i, let o): Task { await MainActor.run { brain.updateSession(sid, addTokens: i + o) } }
        case .notice(let n): append(sid, role: "Notice", n)
        default: break
        }
    }

    private func flush(_ sid: RecordID) {
        let t = pendingBox.sync { $0.removeValue(forKey: sid) }
        if let t, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lastTextBox.sync { $0[sid] = t }
            append(sid, role: "Agent", t)
        }
    }

    private func append(_ sid: RecordID, role: String, _ md: String) {
        let cipher = self.cipher
        Task { await MainActor.run { brain.appendTranscript(sid, role: role, markdown: md, cipher: cipher) } }
    }

    /// Routes a permission request to the Inbox and waits for a decision from any device.
    /// Returns the chosen option id (nil = timeout / rejected without option).
    public func requestApproval(_ sid: RecordID, title: String, kind: String, detail: String,
                                options: [(id: String, label: String)]) async -> (approved: Bool, option: String?) {
        flush(sid)
        let item = await MainActor.run {
            brain.updateSession(sid, status: .waiting)
            return brain.addInbox(title: title, kind: .permission, sessionID: sid,
                                  detail: "Agent wants to run **\(kind)**: \(title)\n\n```\n\(detail.prefix(6000))\n```", options: options)
        }
        Log.info("Permission requested in \(sid): \(title)", category: "agents")
        let deadline = Date().addingTimeInterval(inboxTimeout)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 700_000_000)
            let decided = await MainActor.run { brain.inbox().first { $0.id == item } }
            if let d = decided, d.status != .pending {
                await MainActor.run { brain.updateSession(sid, status: .running) }
                return (d.status == .approved, d.decision)
            }
        }
        await MainActor.run { brain.resolveInbox(item, decision: "timeout", status: .rejected); brain.updateSession(sid, status: .running) }
        return (false, nil)
    }

    private func decide(_ sid: RecordID, _ req: ACPPermissionRequest) async -> String? {
        func option(_ kinds: [String]) -> String? { kinds.lazy.compactMap { k in req.options.first { $0.kind == k }?.id }.first }
        let allow = option(["allow_once", "allow_always"]) ?? req.options.first?.id
        let reject = option(["reject_once", "reject_always"])
        switch permissionPolicy {
        case .allowAll: return allow
        case .allowReads where req.toolKind == "read" || req.toolKind == "search" || req.toolKind == "fetch": return allow
        default: break
        }
        let r = await requestApproval(sid, title: req.toolTitle, kind: req.toolKind, detail: req.detail, options: req.options.map { ($0.id, $0.name) })
        if !r.approved { return reject }
        return r.option.flatMap { dec in req.options.first { $0.id == dec }?.id } ?? allow
    }

    /// Claude Code `--permission-prompt-tool` handler (MCP tool `approval` on `/mcp/session/<id>`).
    /// Returns the JSON Claude Code expects: `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.
    public func claudeApproval(session sid: RecordID, tool: String, input: JSONValue) async -> JSONValue {
        let kind = ClaudeStream.kind(of: tool)
        let allow: JSONValue = ["behavior": "allow", "updatedInput": input]
        if permissionPolicy == .allowAll { return allow }
        if permissionPolicy == .allowReads, ["read", "search", "fetch"].contains(kind) { return allow }
        if alwaysAllowed.sync({ $0[sid]?.contains(tool) ?? false }) { return allow }
        let detail: String
        if tool == "Bash" { detail = input["command"]?.string ?? "" }
        else if let d = try? input.encoded(pretty: true) { detail = String(decoding: d, as: UTF8.self) }
        else { detail = "" }
        let r = await requestApproval(sid, title: ClaudeStream.title(of: tool, input: input), kind: kind, detail: detail,
                                      options: [("allow_once", "Allow"), ("allow_always", "Always allow \(tool) in this session"), ("reject_once", "Deny")])
        if r.approved {
            if r.option == "allow_always" { alwaysAllowed.sync { $0[sid, default: []].insert(tool) } }
            return allow
        }
        return ["behavior": "deny", "message": .string(r.option == "timeout" ? "No answer from the user in time." : "The user denied this action.")]
    }
}
