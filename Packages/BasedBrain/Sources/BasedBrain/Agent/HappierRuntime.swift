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

/// Happier-style orchestration of ACP coding agents: sessions persisted in Based, streaming transcript, permission
/// requests routed to the Inbox (answer from any device), switch agent mid-session with a hand-off summary.
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
    public var inboxTimeout: TimeInterval = 3600
    public var onUpdate: (@Sendable (RecordID, ACPUpdate) -> Void)?
    public var onLog: (@Sendable (String) -> Void)?

    private let liveBox = Locked<[RecordID: ACPClient]>([:])
    private let pendingBox = Locked<[RecordID: String]>([:])

    public init(brain: BrainStore, connections: ConnectionManager?, agents: [AgentDefinition] = AgentDefinition.defaults, machineName: String) {
        self.brain = brain; self.connections = connections; self.agents = agents; self.machineName = machineName
    }

    public func client(for session: RecordID) -> ACPClient? { liveBox.sync { $0[session] } }
    public var liveSessionIDs: [RecordID] { liveBox.sync { Array($0.keys) } }

    /// Start a new session with an agent in a working directory and persist it.
    @discardableResult
    public func startSession(agentID: String, cwd: String, title: String? = nil) async throws -> RecordID {
        guard let def = agents.first(where: { $0.id == agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(agentID)") }
        let sid = await MainActor.run { brain.createSession(title: title ?? "\(def.name) · \(URL(fileURLWithPath: cwd).lastPathComponent)", agentID: agentID, machine: machineName, cwd: cwd, encrypted: cipher != nil) }
        try await attach(session: sid, def: def, cwd: cwd, resume: nil)
        return sid
    }

    /// Re-attach a persisted session (e.g. after a restart): relaunches the agent and `session/load`s the ACP session when known.
    public func attach(_ sid: RecordID) async throws {
        guard let s = await MainActor.run(body: { brain.sessions().first { $0.id == sid } }) else { throw JSONRPCPeer.RPCError.internalError("Unknown session \(sid)") }
        guard let def = agents.first(where: { $0.id == s.agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(s.agentID)") }
        try await attach(session: sid, def: def, cwd: s.cwd, resume: s.acpSessionID)
    }

    private func attach(session sid: RecordID, def: AgentDefinition, cwd: String, resume: String?) async throws {
        let client = ACPClient(definition: def)
        client.allowedRoots = [cwd]
        client.onLog = { [weak self] in self?.onLog?("[\(def.id)] \($0)") }
        client.onUpdate = { [weak self] u in self?.handle(sid, u) }
        client.onPermission = { [weak self] req in await self?.decide(sid, req) }
        try client.start(cwd: cwd)
        try await client.initialize()
        let conns = await MainActor.run { brain.connections() }
        var servers = connections.map { $0.mcpServers(for: conns) } ?? []
        if let b = basedMCPServer { servers.insert(b, at: 0) }
        let acpID: String
        if let resume {
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
        var client = self.client(for: sid)
        if client == nil {
            guard let s = await MainActor.run(body: { brain.sessions().first { $0.id == sid } }), let def = agents.first(where: { $0.id == s.agentID }) else {
                throw JSONRPCPeer.RPCError.internalError("Session not found")
            }
            try await attach(session: sid, def: def, cwd: s.cwd, resume: s.acpSessionID)
            client = self.client(for: sid)
        }
        guard let client else { throw JSONRPCPeer.RPCError.internalError("No agent") }
        await MainActor.run { brain.appendTranscript(sid, role: "You", markdown: text, cipher: cipher); brain.updateSession(sid, status: .running) }
        let context = await MainActor.run { brain.systemContext(query: text) }
        do {
            let stop = try await client.prompt(text, resources: [("based://brain", context)])
            flush(sid)
            await MainActor.run { brain.updateSession(sid, status: stop == .cancelled ? .idle : .done) }
            return stop
        } catch {
            flush(sid)
            await MainActor.run { brain.updateSession(sid, status: .failed); brain.appendTranscript(sid, role: "Error", markdown: "\(error)", cipher: cipher) }
            throw error
        }
    }

    public func cancel(_ sid: RecordID) { client(for: sid)?.cancel() }

    public func stop(_ sid: RecordID) {
        let c = liveBox.sync { $0.removeValue(forKey: sid) }
        c?.stop()
        Task { await MainActor.run { brain.updateSession(sid, status: .idle) } }
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
        if let c = client(for: sid) {
            _ = try await c.prompt("You are taking over an ongoing session from another agent. Here is the transcript so far; acknowledge briefly and continue when the user speaks.",
                                   resources: [("based://session/\(sid)/transcript", String(history.suffix(60_000)))])
            flush(sid)
        }
    }

    // MARK: Updates & permissions

    private func handle(_ sid: RecordID, _ u: ACPUpdate) {
        onUpdate?(sid, u)
        switch u {
        case .agentText(let t): pendingBox.sync { $0[sid, default: ""] += t }
        case .toolCall(_, let title, let kind, _):
            flush(sid); append(sid, role: "Tool", "`\(kind)` \(title)")
        case .toolCallUpdate(_, let status, let output):
            if let output, status == "completed" { append(sid, role: "Tool result", "```\n\(output.prefix(4000))\n```") }
        case .plan(let items): flush(sid); append(sid, role: "Plan", items.map { "- \($0)" }.joined(separator: "\n"))
        case .usage(let i, let o): Task { await MainActor.run { brain.updateSession(sid, addTokens: i + o) } }
        case .notice(let n): append(sid, role: "Notice", n)
        default: break
        }
    }

    private func flush(_ sid: RecordID) {
        let t = pendingBox.sync { $0.removeValue(forKey: sid) }
        if let t, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { append(sid, role: "Agent", t) }
    }

    private func append(_ sid: RecordID, role: String, _ md: String) {
        let cipher = self.cipher
        Task { await MainActor.run { brain.appendTranscript(sid, role: role, markdown: md, cipher: cipher) } }
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
        // Route to the Inbox and wait for a decision from any device.
        flush(sid)
        let item = await MainActor.run {
            brain.updateSession(sid, status: .waiting)
            return brain.addInbox(title: "\(req.toolTitle)", kind: .permission, sessionID: sid,
                                  detail: "Agent wants to run **\(req.toolKind)**: \(req.toolTitle)\n\n```\n\(req.detail)\n```",
                                  options: req.options.map { ($0.id, $0.name) })
        }
        let deadline = Date().addingTimeInterval(inboxTimeout)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            let decided = await MainActor.run { brain.inbox().first { $0.id == item } }
            if let d = decided, d.status != .pending {
                await MainActor.run { brain.updateSession(sid, status: .running) }
                if d.status == .rejected { return reject ?? nil }
                return d.decision.flatMap { dec in req.options.first { $0.id == dec }?.id } ?? allow
            }
        }
        await MainActor.run { brain.resolveInbox(item, decision: "timeout", status: .rejected); brain.updateSession(sid, status: .running) }
        return reject
    }
}
