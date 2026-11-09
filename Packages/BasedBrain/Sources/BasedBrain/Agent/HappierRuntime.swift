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
    /// BSD-50: allow / ask / deny rules (Agent Brain → Permissions), checked before `permissionPolicy`:
    /// an allow rule answers without the Inbox, a deny rule refuses, an ask rule always goes to the Inbox.
    public var permissionRules: (@MainActor @Sendable () -> AgentPermissions?)?
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
    /// A turn started (true) or ended (false) — also for turns the runtime starts itself (sub-agents).
    public var onTurn: (@Sendable (RecordID, Bool) -> Void)?
    public var onLog: (@Sendable (String) -> Void)?

    /// BSD-94: every main-actor write (transcript lines, status, tokens) goes through one ordered queue, so
    /// 1000 fast updates of a session land in the transcript in the order the agent sent them.
    public let mainQueue = MainActorQueue()

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
    public func startSession(agentID: String, cwd: String, title: String? = nil, project: String? = nil, parentID: RecordID? = nil,
                             task: String? = nil) async throws -> RecordID {
        guard let def = agents.first(where: { $0.id == agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(agentID)") }
        let name = title ?? "\(def.name) · \(URL(fileURLWithPath: cwd).lastPathComponent)"
        let proj = project ?? URL(fileURLWithPath: cwd).lastPathComponent
        let sid = await mainQueue.run {
            self.brain.createSession(title: name, agentID: agentID, machine: self.machineName, cwd: cwd, encrypted: self.cipher != nil, project: proj,
                                parentID: parentID, task: task)
        }
        Log.info("Session \(sid) started: \(def.name) in \(cwd)", category: "agents")
        do {
            try await attach(session: sid, def: def, cwd: cwd, resume: nil)
        } catch {
            await mainQueue.run {
                self.brain.updateSession(sid, status: .failed)
                self.brain.appendTranscript(sid, role: "Error", markdown: "Could not start \(def.name): \(error)", cipher: self.cipher)
            }
            Log.error("Could not start \(def.name): \(error)", category: "agents")
            throw error
        }
        return sid
    }

    /// Re-attach a persisted session (e.g. after a restart): relaunches the agent and resumes its conversation when known.
    public func attach(_ sid: RecordID) async throws {
        guard let s = await mainQueue.run({ self.brain.sessions().first { $0.id == sid } }) else { throw JSONRPCPeer.RPCError.internalError("Unknown session \(sid)") }
        guard let def = agents.first(where: { $0.id == s.agentID }) else { throw JSONRPCPeer.RPCError.internalError("Unknown agent \(s.agentID)") }
        try await attach(session: sid, def: def, cwd: s.cwd, resume: s.acpSessionID)
    }

    private func useNative(_ def: AgentDefinition) -> String? {
        guard preferNativeClaude, def.id == "claude" else { return nil }
        return ShellEnvironment.which("claude")
    }

    private func attach(session sid: RecordID, def: AgentDefinition, cwd: String, resume: String?) async throws {
        let conns = await mainQueue.run { self.brain.connections() }
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
            let context = await mainQueue.run { self.brain.systemContext(query: "") }
            var system = mcp["based"] != nil ? await orchestrationPrompt(for: sid) : ""
            if !context.isEmpty { system += "\n\nContext from the user's Based workspace (use the based MCP tools for more):\n" + String(context.prefix(6000)) }
            let driver = ClaudeCodeDriver(options: .init(executable: exe, cwd: cwd, resume: resumeID, permissionMode: mode,
                                                         mcpConfig: .object(["mcpServers": .object(mcp)]), permissionPromptTool: promptTool,
                                                         appendSystemPrompt: system.isEmpty ? nil : system))
            driver.onUpdate = { [weak self] u in self?.handle(sid, u) }
            driver.onLog = { [weak self] line in self?.onLog?("[claude] \(line)") }
            let brain = self.brain, queue = self.mainQueue
            driver.onEvent = { e in
                if case .initialized(let csid, _, _, _, _) = e, !csid.isEmpty {
                    queue.send { brain.updateSession(sid, acpSessionID: "claude:" + csid) }
                }
            }
            try driver.start()
            liveBox.sync { $0[sid] = driver }
            await mainQueue.run { brain.updateSession(sid, status: .idle, agentID: def.id) }
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
        await mainQueue.run { self.brain.updateSession(sid, status: .idle, acpSessionID: acpID, agentID: def.id) }
    }

    /// Send a user prompt to a session (starting the agent process again if needed).
    public func prompt(_ sid: RecordID, _ text: String) async throws -> ACPStopReason {
        // BSD-48: a follow-up sent while the session works waits for the running turn (FIFO), so its "You" line,
        // the answer and the status land after the previous turn.
        let gate = turnGate(sid)
        guard await gate.enter() else { return .cancelled }
        defer { gate.leave() }
        var conn = self.connection(for: sid)
        if conn == nil || conn?.isRunning == false && !(conn is ClaudeCodeDriver) {
            do { try await attach(sid) } catch { inFlight.sync { _ = $0.remove(sid) }; throw error }
            conn = self.connection(for: sid)
        }
        guard let conn else { inFlight.sync { _ = $0.remove(sid) }; throw JSONRPCPeer.RPCError.internalError("No agent") }
        inFlight.sync { _ = $0.insert(sid) }
        onTurn?(sid, true)
        lastTextBox.sync { _ = $0.removeValue(forKey: sid) }
        await mainQueue.run {
            // The first prompt of a session doubles as its task (board / canvas cards).
            let first = self.brain.sessions().first { $0.id == sid }?.task.isEmpty ?? false
            self.brain.appendTranscript(sid, role: "You", markdown: text, cipher: self.cipher)
            self.brain.updateSession(sid, status: .running, task: first ? text : nil)
        }
        var context = conn is ClaudeCodeDriver ? "" : await mainQueue.run { self.brain.systemContext(query: text) }
        if !(conn is ClaudeCodeDriver), mcpEndpoint != nil || basedMCPServer != nil { context = await orchestrationPrompt(for: sid) + "\n\n" + context }
        do {
            let stop = try await conn.prompt(text, resources: context.isEmpty ? [] : [("based://brain", context)])
            flush(sid)
            let answer = lastTextBox.sync { $0[sid] }
            await mainQueue.run { self.brain.updateSession(sid, status: stop == .cancelled ? .idle : .done, result: answer) }
            inFlight.sync { _ = $0.remove(sid) }
            onTurn?(sid, false)
            await reportToParent(sid)
            return stop
        } catch {
            flush(sid)
            await mainQueue.run {
                self.brain.updateSession(sid, status: .failed, result: "Error: \(error)")
                self.brain.appendTranscript(sid, role: "Error", markdown: "\(error)", cipher: self.cipher)
            }
            inFlight.sync { _ = $0.remove(sid) }
            onTurn?(sid, false)
            await reportToParent(sid, failed: true)
            Log.error("Prompt failed in \(sid): \(error)", category: "agents")
            throw error
        }
    }

    public func cancel(_ sid: RecordID) { connection(for: sid)?.cancel() }

    private let gates = Locked<[RecordID: AsyncTurnGate]>([:])
    func turnGate(_ sid: RecordID) -> AsyncTurnGate {
        gates.sync { g in if let x = g[sid] { return x }; let x = AsyncTurnGate(); g[sid] = x; return x }
    }
    /// Follow-ups waiting for the running turn of a session.
    public func queuedPrompts(_ sid: RecordID) -> Int { turnGate(sid).waitingCount }

    public func stop(_ sid: RecordID) {
        turnGate(sid).cancelWaiting()
        let c = liveBox.sync { $0.removeValue(forKey: sid) }
        c?.stop()
        mainQueue.send { self.brain.updateSession(sid, status: .idle) }
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
        let s = await mainQueue.run { self.brain.sessions().first { $0.id == sid } }
        guard let s else { throw JSONRPCPeer.RPCError.internalError("Session not found") }
        stop(sid)
        try await attach(session: sid, def: def, cwd: s.cwd, resume: nil)
        let history = await mainQueue.run { self.brain.transcript(sid, cipher: self.cipher) }
        await mainQueue.run { self.brain.appendTranscript(sid, role: "System", markdown: "Switched to \(def.name).", cipher: self.cipher) }
        if let c = connection(for: sid) {
            _ = try await c.prompt("You are taking over an ongoing session from another agent. Here is the transcript so far; acknowledge briefly and continue when the user speaks.",
                                   resources: [("based://session/\(sid)/transcript", String(history.suffix(60_000)))])
            flush(sid)
        }
    }

    // MARK: Sub-agents

    /// Sub-agents may spawn sub-agents up to this nesting level (0 = top-level session).
    public var maxSubAgentDepth = 3
    /// At most this many sub-agents of one parent may run at the same time.
    public var maxActiveChildren = 8
    /// Sessions with a turn in flight (spawned but not finished yet) — what `wait_for_agents` waits on.
    private let inFlight = Locked<Set<RecordID>>([])
    public func isWorking(_ sid: RecordID) -> Bool { inFlight.sync { $0.contains(sid) } }
    public var workingSessionIDs: Set<RecordID> { inFlight.sync { $0 } }

    /// When a child session finishes a turn, its final answer is stored on the child and posted to the parent session.
    private func reportToParent(_ sid: RecordID, failed: Bool = false) async {
        let info = await mainQueue.run { () -> (RecordID, String)? in
            guard let s = self.brain.sessions().first(where: { $0.id == sid }), let parent = s.parentID else { return nil }
            return (parent, s.title)
        }
        guard let (parent, title) = info else { return }
        let last = lastTextBox.sync { $0[sid] } ?? "(no answer)"
        await mainQueue.run {
            self.brain.appendTranscript(parent, role: "Notice",
                                   markdown: "Sub-agent **\(title)** \(failed ? "failed" : "finished") (session \(sid)):\n\n\(String(last.suffix(3000)))", cipher: self.cipher)
        }
        onLog?("sub-agent \(sid) reported to \(parent)")
    }

    /// Text added to a native Claude Code session's system prompt so it knows how to delegate.
    public func orchestrationPrompt(for sid: RecordID) async -> String {
        let (depth, project) = await mainQueue.run { (self.brain.depth(of: sid), self.brain.sessions().first { $0.id == sid }?.project ?? "") }
        guard depth < maxSubAgentDepth else {
            return "You are a sub-agent (Based session \(sid), level \(depth)). Finish your task yourself and answer with a concise report — it is sent back to the agent that started you."
        }
        let ids = agents.filter(\.enabled).map(\.id).joined(separator: ", ")
        var text = """
        You are running inside Based (session id \(sid)\(project.isEmpty ? "" : ", project \(project)")). You can delegate work to parallel \
        sub-agents with the `based` MCP tools: spawn_agent (agent: \(ids); cwd defaults to yours; returns a session id), \
        wait_for_agents (blocks until they finish and returns their final answers), read_agent_session, message_agent and stop_agent. \
        Give every sub-agent a self-contained task and a short title. Use sub-agents for independent work (research, separate \
        modules, reviews, tests); do small things yourself. At most \(maxActiveChildren) may run at once.
        """
        if depth > 0 { text += " You are a sub-agent yourself (level \(depth) of \(maxSubAgentDepth)); your final answer is reported to your parent." }
        return text
    }

    /// Tools that let an agent (the built-in AI, or any MCP client) spawn and steer coding agents. Calls made through a
    /// session-scoped MCP endpoint (`/mcp/session/<id>`) carry `_caller_session`, which becomes the default parent.
    public static let subAgentSpecs: [ToolSpec] = [
        ToolSpec(name: "spawn_agent", description: "Start a sub-agent (a coding-agent session: Claude Code, Codex, Gemini …) with a self-contained task. Runs in the background unless wait=true; its final answer is reported back to you. Returns the session id.",
                 inputSchema: .schema(["agent": .str("Agent id: claude | codex | gemini | opencode (default: claude)"), "prompt": .str("Self-contained task for the sub-agent"),
                                       "title": .str("Short title shown on the board/canvas"), "cwd": .str("Absolute working directory (default: the parent's)"),
                                       "project": .str("Project name (default: the parent's)"), "wait": .boolean("Block until it finishes and return its answer (default false)"),
                                       "parent_session_id": .str("Parent session id (default: the calling session)")], required: ["prompt"])),
        ToolSpec(name: "wait_for_agents", description: "Wait until sub-agents finish and return their final answers. Without session_ids, waits for all of your running sub-agents.",
                 inputSchema: .schema(["session_ids": .str("Comma-separated session ids (optional)"), "timeout_seconds": .num("Default 300, max 1800")])),
        ToolSpec(name: "agent_sessions", description: "List coding-agent sessions (yours and your sub-agents' by default) with status, directory, parent and task.",
                 inputSchema: .schema(["scope": .str("children (default when called from a session) | all")])),
        ToolSpec(name: "read_agent_session", description: "Read the latest transcript of a coding-agent session.",
                 inputSchema: .schema(["session_id": .str("Session id"), "max_chars": .num("Default 6000")], required: ["session_id"])),
        ToolSpec(name: "message_agent", description: "Send a follow-up prompt to a coding-agent session (runs in the background; use wait_for_agents for the answer).",
                 inputSchema: .schema(["session_id": .str("Session id"), "prompt": .str("Message")], required: ["session_id", "prompt"])),
        ToolSpec(name: "stop_agent", description: "Stop a sub-agent session (interrupts its current turn and ends the process).",
                 inputSchema: .schema(["session_id": .str("Session id")], required: ["session_id"])),
    ]

    public enum SpawnError: Error, CustomStringConvertible {
        case tooDeep(Int), tooManyChildren(Int), unknownAgent(String)
        public var description: String {
            switch self {
            case .tooDeep(let m): return "Sub-agents can only be nested \(m) levels deep. Do this task yourself."
            case .tooManyChildren(let m): return "\(m) sub-agents are already running for this session. Wait for some to finish (wait_for_agents) first."
            case .unknownAgent(let a): return "Unknown or disabled agent '\(a)'."
            }
        }
    }

    /// Starts a sub-agent under `parentID` (inheriting directory and project) and sends it `prompt` in the background.
    @discardableResult
    public func spawn(agentID: String, prompt: String, title: String? = nil, cwd: String? = nil, project: String? = nil,
                      parentID: RecordID?) async throws -> RecordID {
        guard let def = agents.first(where: { $0.id == agentID }), def.enabled else { throw SpawnError.unknownAgent(agentID) }
        let (parent, depth, activeKids) = await mainQueue.run { () -> (AgentSession?, Int, Int) in
            guard let p = parentID, let ps = self.brain.sessions().first(where: { $0.id == p }) else { return (nil, 0, 0) }
            let working = self.inFlight.sync { $0 }
            let kids = self.brain.children(of: p).filter { $0.isActive || working.contains($0.id) }.count
            return (ps, self.brain.depth(of: p) + 1, kids)
        }
        if parent != nil {
            guard depth <= maxSubAgentDepth else { throw SpawnError.tooDeep(maxSubAgentDepth) }
            guard activeKids < maxActiveChildren else { throw SpawnError.tooManyChildren(maxActiveChildren) }
        }
        let dir = (cwd?.isEmpty == false ? cwd : nil) ?? parent?.cwd ?? NSHomeDirectory()
        let proj = (project?.isEmpty == false ? project : nil) ?? parent?.project
        let name = (title?.isEmpty == false ? title! : Self.titleFrom(prompt: prompt, agent: def.name))
        let sid = try await startSession(agentID: def.id, cwd: dir, title: name, project: proj, parentID: parent?.id, task: prompt)
        inFlight.sync { _ = $0.insert(sid) }
        await mainQueue.run { self.brain.updateSession(sid, status: .running) }
        if let p = parent?.id {
            await mainQueue.run {
                self.brain.appendTranscript(p, role: "Notice", markdown: "Started sub-agent **\(name)** (\(def.name), session \(sid)).", cipher: self.cipher)
            }
        }
        Task { _ = try? await self.prompt(sid, prompt) }
        return sid
    }

    static func titleFrom(prompt: String, agent: String) -> String {
        let first = prompt.split(whereSeparator: { $0 == "\n" || $0 == "." }).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if first.isEmpty { return agent }
        return first.count > 60 ? String(first.prefix(57)) + "…" : first
    }

    /// Waits until none of `ids` has a turn in flight (or is waiting for approval), up to `timeout`.
    /// Returns (id, finished, status, answer) per session.
    public func waitFor(_ ids: [RecordID], timeout: TimeInterval) async -> [(id: RecordID, finished: Bool, session: AgentSession?)] {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let busy = inFlight.sync { set in ids.filter { set.contains($0) } }
            if busy.isEmpty || Date() >= deadline { break }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        let all = await mainQueue.run { Dictionary(self.brain.sessions().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
        return ids.map { id in (id, !isWorking(id), all[id]) }
    }

    public func hostTool(_ name: String, _ args: JSONValue) async -> AgentTools.ToolResult? {
        let caller = args["_caller_session"]?.string
        switch name {
        case "spawn_agent":
            let agent = args["agent"]?.string ?? "claude", prompt = args["prompt"]?.string ?? ""
            guard !prompt.isEmpty else { return .init(text: "prompt required", isError: true) }
            let parent = args["parent_session_id"]?.string ?? caller
            do {
                let sid = try await spawn(agentID: agent, prompt: prompt, title: args["title"]?.string, cwd: args["cwd"]?.string,
                                          project: args["project"]?.string, parentID: parent)
                if args["wait"]?.bool == true {
                    let r = await waitFor([sid], timeout: 1800)
                    return .init(text: Self.report(r), isError: false)
                }
                return .init(text: "Started sub-agent session \(sid) (\(agent)). Call wait_for_agents to collect its answer.", isError: false)
            } catch { return .init(text: "Could not start \(agent): \(error)", isError: true) }
        case "wait_for_agents":
            var ids = (args["session_ids"]?.string ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if let arr = args["session_ids"]?.array { ids = arr.compactMap(\.string) }
            if ids.isEmpty, let caller {
                let kids = await mainQueue.run { self.brain.children(of: caller).map(\.id) }
                ids = kids.filter { isWorking($0) }
                if ids.isEmpty { ids = Array(kids.prefix(8)) }
            }
            guard !ids.isEmpty else { return .init(text: "No sub-agents to wait for.", isError: false) }
            let timeout = min(max(args["timeout_seconds"]?.number ?? 300, 1), 1800)
            return .init(text: Self.report(await waitFor(ids, timeout: timeout)), isError: false)
        case "agent_sessions":
            let list = await mainQueue.run { self.brain.sessions() }
            let scopeAll = args["scope"]?.string == "all" || caller == nil
            let all = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let shown = scopeAll ? list : list.filter { s in
                // the caller's descendants
                var cur = s.parentID, seen: Set<RecordID> = []
                while let p = cur, !seen.contains(p) { if p == caller { return true }; seen.insert(p); cur = all[p]?.parentID }
                return false
            }
            let live = liveSessionIDs
            let text = shown.prefix(50).map { s in
                "- \(s.id) · \(s.title) · \(s.agentID) · \(isWorking(s.id) ? "Running" : s.status.rawValue)\(live.contains(s.id) ? " · live" : "") · \(s.cwd)"
                    + (s.parentID.map { " · parent \($0)" } ?? "") + (s.task.isEmpty ? "" : " · task: \(s.task.prefix(80))")
            }.joined(separator: "\n")
            return .init(text: text.isEmpty ? (scopeAll ? "No sessions." : "You have no sub-agents yet.") : text, isError: false)
        case "read_agent_session":
            guard let sid = args["session_id"]?.string else { return .init(text: "session_id required", isError: true) }
            let n = Int(args["max_chars"]?.number ?? 6000)
            let md = await mainQueue.run { self.brain.transcript(sid, cipher: self.cipher) }
            return .init(text: String(md.suffix(n)), isError: false)
        case "message_agent":
            guard let sid = args["session_id"]?.string, let p = args["prompt"]?.string else { return .init(text: "session_id and prompt required", isError: true) }
            inFlight.sync { _ = $0.insert(sid) }
            Task { _ = try? await self.prompt(sid, p) }
            return .init(text: "Sent. Call wait_for_agents with session_ids=\(sid) for the answer.", isError: false)
        case "stop_agent":
            guard let sid = args["session_id"]?.string else { return .init(text: "session_id required", isError: true) }
            cancel(sid); stop(sid)
            inFlight.sync { _ = $0.remove(sid) }
            return .init(text: "Stopped \(sid).", isError: false)
        default: return nil
        }
    }

    static func report(_ r: [(id: RecordID, finished: Bool, session: AgentSession?)]) -> String {
        r.map { e in
            let title = e.session?.title ?? e.id
            guard e.finished else { return "## \(title) (\(e.id)) — still running\nCall wait_for_agents again later." }
            let status = e.session?.status.rawValue ?? "Unknown"
            let answer = (e.session?.result).flatMap { $0.isEmpty ? nil : $0 } ?? "(no answer)"
            return "## \(title) (\(e.id)) — \(status)\n\(answer.suffix(6000))"
        }.joined(separator: "\n\n")
    }

    // MARK: Updates & permissions

    /// Feeds an update as if the agent had sent it (tests, bridges).
    func ingest(_ sid: RecordID, _ u: ACPUpdate) { handle(sid, u) }
    /// Writes buffered agent text (tests).
    func flushPending(_ sid: RecordID) { flush(sid) }

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
        case .diff(let path, let old, let new):
            // Edits arrive before they are applied: the old snippet's position gives real file line numbers.
            let start = LineDiff.firstLine(of: old, inFile: path) ?? LineDiff.firstLine(of: new, inFile: path) ?? 1
            append(sid, role: "Diff", "`\(path)`\n```diff\n\(LineDiff.unified(old: old, new: new, context: 3, firstLine: start).prefix(12_000))\n```")
        case .usage(let i, let o): mainQueue.send { self.brain.updateSession(sid, addTokens: i + o) }
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
        mainQueue.send { self.brain.appendTranscript(sid, role: role, markdown: md, cipher: cipher) }
    }

    /// Routes a permission request to the Inbox and waits for a decision from any device.
    /// Returns the chosen option id (nil = timeout / rejected without option).
    public func requestApproval(_ sid: RecordID, title: String, kind: String, detail: String,
                                options: [(id: String, label: String)]) async -> (approved: Bool, option: String?) {
        flush(sid)
        let item = await mainQueue.run {
            self.brain.updateSession(sid, status: .waiting)
            return self.brain.addInbox(title: title, kind: .permission, sessionID: sid,
                                  detail: "Agent wants to run **\(kind)**: \(title)\n\n```\n\(detail.prefix(6000))\n```", options: options)
        }
        Log.info("Permission requested in \(sid): \(title)", category: "agents")
        let deadline = Date().addingTimeInterval(inboxTimeout)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 700_000_000)
            let decided = await mainQueue.run { self.brain.inbox().first { $0.id == item } }
            if let d = decided, d.status != .pending {
                await mainQueue.run { self.brain.updateSession(sid, status: .running) }
                return (d.status == .approved, d.decision)
            }
        }
        await mainQueue.run { self.brain.resolveInbox(item, decision: "timeout", status: .rejected); self.brain.updateSession(sid, status: .running) }
        return (false, nil)
    }

    private func decide(_ sid: RecordID, _ req: ACPPermissionRequest) async -> String? {
        func option(_ kinds: [String]) -> String? { kinds.lazy.compactMap { k in req.options.first { $0.kind == k }?.id }.first }
        let allow = option(["allow_once", "allow_always"]) ?? req.options.first?.id
        let reject = option(["reject_once", "reject_always"])
        let call = PermissionCall.acp(kind: req.toolKind, title: req.toolTitle, detail: req.detail)
        let ruled = await ruleVerdict(call)
        if ruled?.effect == .allow { return allow }
        if ruled?.effect == .deny { Log.info("Permission denied by rule in \(sid): \(req.toolTitle)", category: "agents"); return reject }
        if ruled == nil { switch permissionPolicy {
        case .allowAll: return allow
        case .allowReads where req.toolKind == "read" || req.toolKind == "search" || req.toolKind == "fetch": return allow
        default: break
        } }
        let r = await requestApproval(sid, title: req.toolTitle, kind: req.toolKind, detail: req.detail, options: req.options.map { ($0.id, $0.name) })
        if !r.approved { return reject }
        return r.option.flatMap { dec in req.options.first { $0.id == dec }?.id } ?? allow
    }

    private func ruleVerdict(_ call: PermissionCall) async -> PermissionVerdict? {
        guard let provider = permissionRules else { return nil }
        return await mainQueue.run { provider()?.ruleVerdict(call) }
    }

    /// Claude Code `--permission-prompt-tool` handler (MCP tool `approval` on `/mcp/session/<id>`).
    /// Returns the JSON Claude Code expects: `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.
    public func claudeApproval(session sid: RecordID, tool: String, input: JSONValue) async -> JSONValue {
        let kind = ClaudeStream.kind(of: tool)
        let allow: JSONValue = ["behavior": "allow", "updatedInput": input]
        let ruled = await ruleVerdict(PermissionCall.claude(tool, input))
        if ruled?.effect == .deny { return ["behavior": "deny", "message": .string("Blocked by the permission rules (\(ruled!.reason)).")] }
        if ruled?.effect == .allow { return allow }
        if ruled == nil {
            if permissionPolicy == .allowAll { return allow }
            if permissionPolicy == .allowReads, ["read", "search", "fetch"].contains(kind) { return allow }
            if alwaysAllowed.sync({ $0[sid]?.contains(tool) ?? false }) { return allow }
        }
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
