import SwiftUI
import Observation
import BasedCore
import BasedBrain
#if canImport(UIKit)
import UIKit
#endif

/// Happier‑style control room state for the app: coding‑agent sessions (ACP), the approval inbox and
/// service connections (MCP). On macOS agents run locally as child processes; on iOS (or when the user
/// prefers it) the same operations are forwarded to the Based server daemon, which owns the processes.
@MainActor @Observable
final class HappierModel {
    let store: WorkspaceStore
    let brain: BrainStore
    let tools: AgentTools
    @ObservationIgnored let connections: ConnectionManager
    @ObservationIgnored private(set) var runtime: HappierRuntime
    @ObservationIgnored private var token: ObservationToken?

    var sessions: [AgentSession] = []
    var inbox: [InboxItem] = []
    var connectionList: [Connection] = []
    /// Projects (BSD-44) and the ones with a session that is running or waiting right now.
    var projects: [AgentProject] = []
    var activeProjectIDs: Set<RecordID> = []
    var liveText: [RecordID: String] = [:]          // streaming agent text per session
    var thoughts: [RecordID: String] = [:]
    var events: [RecordID: [SessionEvent]] = [:]    // tool calls / notices / plan
    var busy: Set<RecordID> = []
    /// Sessions with a turn in flight, including sub-agents the runtime started itself.
    var working: Set<RecordID> = []
    var lastError: String?
    var connectionStatus: [RecordID: String] = [:]
    /// Bumped when a session's transcript (its page body) changes — views read this instead of the whole store.
    var transcriptRevision: [RecordID: Int] = [:]
    /// Claude Code permission mode per session (default / acceptEdits / plan / bypassPermissions).
    var modes: [RecordID: String] = [:]
    /// The app's private MCP endpoint (agents started here get the workspace tools + Inbox approvals).
    @ObservationIgnored private var mcpHost: LocalMCPHost?
    /// BSD-36: stops agent processes when Based quits.
    @ObservationIgnored private var quitObserver: NSObjectProtocol?
    var mcpBaseURL: String?
    @ObservationIgnored private var happierIDs: Set<RecordID> = []
    @ObservationIgnored private var sessionIDSet: Set<RecordID> = []

    struct SessionEvent: Identifiable, Hashable {
        var id = UUID()
        var icon: String
        var text: String
        var status: String
        var time = Date()
    }

    // MARK: Settings (UserDefaults / Keychain)

    static let agentsKey = "acp.agents"
    static func loadAgents() -> [AgentDefinition] {
        if let d = UserDefaults.standard.data(forKey: agentsKey), var a = try? JSONDecoder().decode([AgentDefinition].self, from: d), !a.isEmpty {
            // Pass 18: OpenCode's `acp` subcommand is confirmed — turn on the untouched old default.
            if let i = a.firstIndex(where: { $0.id == "opencode" }), !a[i].enabled, a[i].note.hasPrefix("Install opencode; verify"),
               let fresh = AgentDefinition.defaults.first(where: { $0.id == "opencode" }) { a[i] = fresh }
            return a
        }
        return AgentDefinition.defaults
    }
    var agents: [AgentDefinition] = HappierModel.loadAgents() {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(agents), forKey: Self.agentsKey); runtime.agents = agents }
    }
    func resetAgents() { UserDefaults.standard.removeObject(forKey: Self.agentsKey); agents = AgentDefinition.defaults }

    var permissionPolicy: HappierRuntime.PermissionPolicy = HappierRuntime.PermissionPolicy(rawValue: UserDefaults.standard.string(forKey: "acp.permissions") ?? "") ?? .ask {
        didSet { UserDefaults.standard.set(permissionPolicy.rawValue, forKey: "acp.permissions"); runtime.permissionPolicy = permissionPolicy }
    }
    /// macOS: run agents on this Mac (default) or through the server daemon. iOS always uses the daemon.
    var useServer: Bool = {
        #if os(iOS)
        return true
        #else
        return UserDefaults.standard.bool(forKey: "acp.useServer")
        #endif
    }() {
        didSet { UserDefaults.standard.set(useServer, forKey: "acp.useServer") }
    }
    var defaultDirectory: String = UserDefaults.standard.string(forKey: "acp.cwd") ?? NSHomeDirectory() {
        didSet { UserDefaults.standard.set(defaultDirectory, forKey: "acp.cwd") }
    }
    /// End‑to‑end key (base64, 32 bytes) shared between devices and the daemon; stored in the Keychain
    /// (read in the background at launch — `secretsLoaded()` applies it when it arrives).
    var cipherKey: String = Secrets.get("session.key") ?? "" {
        didSet { Secrets.set("session.key", cipherKey.isEmpty ? nil : cipherKey); runtime.cipher = SessionCipher(base64: cipherKey) }
    }
    var machineName: String {
        #if os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return UIDevice.current.name
        #endif
    }

    init(store: WorkspaceStore, brain: BrainStore, tools: AgentTools) {
        self.store = store; self.brain = brain; self.tools = tools
        connections = ConnectionManager(tools: tools, secret: { key in Secrets.get(key) })
        runtime = HappierRuntime(brain: brain, connections: connections, machineName: "device")
        runtime.machineName = machineName
        runtime.agents = agents
        runtime.permissionPolicy = permissionPolicy
        // BSD-50: allow / ask / deny rules from Agent Brain → Permissions, read fresh for every request.
        runtime.permissionRules = { [weak brain] in brain?.permissions(mode: .ask) }
        ensureSessionKey()
        runtime.cipher = SessionCipher(base64: cipherKey)
        // BSD-94: one ordered queue instead of a Task per update (fast updates could arrive swapped).
        // Turn start/end goes through the same queue, so a turn's first text is not wiped by a late "started".
        let queue = MainActorQueue()
        runtime.onUpdate = { [weak self] sid, update in queue.send { self?.handle(sid, update) } }
        runtime.onTurn = { [weak self] sid, started in
            queue.send {
                guard let self else { return }
                if started { self.working.insert(sid); if !self.busy.contains(sid) { self.liveText[sid] = ""; self.thoughts[sid] = nil } }
                else { self.working.remove(sid); if !self.busy.contains(sid) { self.liveText[sid] = nil } }
                self.refresh()
            }
        }
        runtime.onLog = { [weak self] line in Task { @MainActor in self?.addEvent(":log", .init(icon: "terminal", text: line, status: "")) } }
        connections.onStatus = { [weak self] id, status in Task { @MainActor in self?.connectionStatus[id] = status; self?.brain.setConnectionStatus(id, status) } }
        refresh()
        token = store.observe { [weak self] change in self?.storeChanged(change) }
        Task { await connections.reload() }
        #if os(macOS)
        // Resolve the login-shell PATH early (claude / node / npx live in ~/.local/bin, Homebrew, nvm …).
        Task.detached(priority: .utility) {
            let env = ShellEnvironment.environment()
            Log.info("Shell environment ready (\(env["PATH"]?.split(separator: ":").count ?? 0) PATH entries) — \(ShellEnvironment.note)", category: "agents")
        }
        if !AppDiagnostics.isUITesting { startLocalMCP() }
        // BSD-36: ⌘Q ends every agent session and its process tree (npx adapters, claude …), SIGKILL after 3 s;
        // then any other child (chat CLIs, MCP servers). iOS has no local agent processes.
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.runtime.stopAll(timeout: 3)
                self?.mcpHost?.stop()
            }
            ProcessSupervisor.terminateAllChildren(timeout: 1)
        }
        #endif
    }

    /// BSD-36: session event lists keep the newest 2000 entries.
    private func addEvent(_ sid: RecordID, _ e: SessionEvent) {
        BoundedLog.append(e, to: &events[sid, default: []])
    }

    /// A fresh session key — but only once the Keychain load finished and no existing key is waiting for
    /// permission (replacing it would cut this device off from sessions encrypted with the old one).
    private func ensureSessionKey() {
        guard cipherKey.isEmpty, Secrets.isLoaded, !Secrets.isPending("session.key") else { return }
        let k = SessionCipher.generate().base64
        // Property observers don't fire inside init: persist + apply explicitly.
        cipherKey = k; Secrets.set("session.key", k); runtime.cipher = SessionCipher(base64: k)
    }

    /// Called by `BrainModel` when keys arrived from the Keychain.
    func secretsLoaded() {
        let k = Secrets.get("session.key") ?? ""
        if !k.isEmpty, k != cipherKey { cipherKey = k } else { ensureSessionKey() }
        // Reconnect only when a connection actually has a secret now (reload drops live clients).
        if brain.connections().contains(where: { $0.enabled && Secrets.get($0.secretKey) != nil }) { reloadConnections() }
    }

    /// Starts the loopback MCP server agents use to reach the workspace, the Inbox and sub-agents.
    func startLocalMCP() {
        guard mcpHost == nil else { return }
        let host = LocalMCPHost(tools: tools, runtime: runtime)
        do {
            mcpBaseURL = try host.start(runtime: runtime)
            mcpHost = host
        } catch {
            Log.error("Local MCP endpoint failed to start: \(error)", category: "mcp")
        }
    }

    /// Only Sessions / Inbox / Connections changes (and session transcripts) refresh this model —
    /// typing in a normal page no longer re-reads every session row.
    private func storeChanged(_ change: ChangeSet) {
        var relevant = false
        for p in change.parents {
            let id = String(p.dropFirst(2))
            if p.hasPrefix("d:"), happierIDs.contains(id) { relevant = true }
            if p.hasPrefix("b:"), sessionIDSet.contains(id) { transcriptRevision[id, default: 0] += 1; relevant = true }
        }
        for key in change.keys {
            switch key.kind {
            case .database where happierIDs.contains(key.id): relevant = true
            case .block:
                if let b = store.blocks[key.id] {
                    switch b.parent {
                    case .database(let d) where happierIDs.contains(d): relevant = true
                    case .block(let p) where sessionIDSet.contains(p): transcriptRevision[p, default: 0] += 1
                    // Inbox details are written right after the row is created — reload so they show up.
                    case .block(let p) where inbox.contains(where: { $0.id == p }): relevant = true
                    default: break
                    }
                } else if sessionIDSet.contains(key.id) { relevant = true }
            default: break
            }
        }
        if relevant { refresh() }
    }

    func refresh() {
        Log.measure("HappierModel.refresh", warnAfter: 0.05) {
            let ids = brain.ensureHappier()
            let projectsDB = brain.ensureProjects()
            happierIDs = [ids.sessions, ids.inbox, ids.connections, projectsDB]
            let s = brain.sessions().sorted { $0.updatedAt > $1.updatedAt }
            if s != sessions { sessions = s; sessionIDSet = Set(s.map(\.id)) }
            let p = brain.projects()
            if p != projects { projects = p }
            let active = Set(s.filter(\.isActive).compactMap(\.projectID))
            if active != activeProjectIDs { activeProjectIDs = active }
            let i = brain.inbox().sorted { $0.createdAt > $1.createdAt }
            if i != inbox { inbox = i }
            let c = brain.connections()
            if c != connectionList { connectionList = c }
        }
    }

    /// `--mcp-config` JSON giving Claude Code the workspace tools for one session/chat.
    func mcpConfig(session: RecordID) -> JSONValue? { mcpHost?.claudeConfig(session: session) }

    /// Chats with the built-in assistant (agent id "based"), newest first.
    var chats: [AgentSession] { sessions.filter(\.isChat) }
    /// Coding-agent sessions (Claude Code, Codex …).
    var agentSessions: [AgentSession] { sessions.filter { !$0.isChat } }
    func pendingInbox(for sid: RecordID) -> [InboxItem] { inbox.filter { $0.sessionID == sid && $0.status == .pending } }

    func mode(_ sid: RecordID) -> String { modes[sid] ?? runtime.claudeModes.sync { $0[sid] } ?? "default" }
    func setMode(_ sid: RecordID, _ mode: String) {
        modes[sid] = mode
        runtime.setClaudeMode(sid, mode)
        Log.breadcrumb("mode \(mode) for session \(sid.prefix(6))")
    }
    static let claudeModes: [(id: String, title: String, footer: String)] = [
        ("default", "Ask before edits", "? for shortcuts"),
        ("acceptEdits", "Accept edits", "⏵⏵ accept edits on (shift+tab to cycle)"),
        ("plan", "Plan mode", "⏸ plan mode on (shift+tab to cycle)"),
        ("bypassPermissions", "Bypass permissions", "⏵⏵ bypass permissions on (shift+tab to cycle)"),
    ]
    func cycleMode(_ sid: RecordID) {
        let ids = Self.claudeModes.map(\.id)
        let i = ids.firstIndex(of: mode(sid)) ?? 0
        setMode(sid, ids[(i + 1) % ids.count])
    }

    var pendingCount: Int { inbox.filter { $0.status == .pending }.count }

    // MARK: Hierarchy (sub-agents)

    /// Running right now (a prompt from this device, a sub-agent turn, or a status synced from another device).
    func isWorking(_ sid: RecordID) -> Bool { busy.contains(sid) || working.contains(sid) }
    var workingSet: Set<RecordID> { busy.union(working) }
    func status(of s: AgentSession) -> AgentSession.Status { s.effectiveStatus(working: isWorking(s.id)) }
    func children(of sid: RecordID) -> [AgentSession] { sessions.filter { $0.parentID == sid }.sorted { $0.startedAt < $1.startedAt } }
    func parent(of s: AgentSession) -> AgentSession? { s.parentID.flatMap { p in sessions.first { $0.id == p } } }
    var runningCount: Int { agentSessions.filter { status(of: $0) == .running }.count }
    /// Latest tool call / notice of a session (live activity line on board and canvas cards).
    func activity(_ sid: RecordID) -> String? {
        if let e = events[sid]?.last { return e.text.components(separatedBy: "\n").first }
        if let t = liveText[sid], !t.isEmpty { return String(t.suffix(140)) }
        return nil
    }

    /// Starts a sub-agent of `parent` (same folder and project unless given) with a task.
    func spawnSubAgent(parent: RecordID, agentID: String, prompt: String, title: String?, cwd: String? = nil) {
        lastError = nil
        Task {
            do {
                if useServer {
                    let r = try await serverCall("POST", "/sessions", ["agent": .string(agentID), "prompt": .string(prompt), "parent": .string(parent),
                                                                     "title": title.map(JSONValue.string) ?? .null, "cwd": cwd.map(JSONValue.string) ?? .null])
                    if let e = r["error"]?.string { throw ServerError(e) }
                } else {
                    let sid = try await runtime.spawn(agentID: agentID, prompt: prompt, title: title, cwd: cwd, parentID: parent)
                    Log.info("Spawned sub-agent \(sid) under \(parent)", category: "agents")
                }
                refresh()
            } catch { lastError = "\(error)" }
        }
    }
    func isLive(_ sid: RecordID) -> Bool { runtime.liveSessionIDs.contains(sid) }
    func agent(_ id: String) -> AgentDefinition? { agents.first { $0.id == id } }
    func transcript(_ sid: RecordID) -> String { brain.transcript(sid, cipher: runtime.cipher) }

    private func handle(_ sid: RecordID, _ u: ACPUpdate) {
        switch u {
        case .agentText(let t): liveText[sid, default: ""] += t
        case .agentThought(let t): thoughts[sid, default: ""] += t
        case .userText: break
        case .toolCall(_, let title, let kind, let status): addEvent(sid, .init(icon: Self.icon(forToolKind: kind), text: title, status: status))
        case .toolCallUpdate(_, let status, let output):
            if var last = events[sid]?.last { last.status = status; if let o = output, !o.isEmpty { last.text += " — " + o.prefix(200) }; events[sid]![events[sid]!.count - 1] = last }
        case .plan(let steps): addEvent(sid, .init(icon: "list.bullet.clipboard", text: steps.joined(separator: "\n"), status: "plan"))
        case .usage: break
        case .notice(let n): addEvent(sid, .init(icon: "info.circle", text: n, status: ""))
        case .modeChanged(let m): addEvent(sid, .init(icon: "switch.2", text: "Mode: \(m)", status: ""))
        case .other(let s): addEvent(sid, .init(icon: "ellipsis.circle", text: s, status: ""))
        case .diff(let path, let old, let new):
            let c = LineDiff.counts(LineDiff.ops(old: old, new: new))
            addEvent(sid, .init(icon: "pencil.line", text: "Update(\(path)) +\(c.added) -\(c.removed)", status: "completed"))
        }
    }

    static func icon(forToolKind kind: String) -> String {
        switch kind {
        case "read": return "doc.text.magnifyingglass"
        case "edit": return "pencil"
        case "delete": return "trash"
        case "move": return "arrow.right.doc.on.clipboard"
        case "search": return "magnifyingglass"
        case "execute": return "terminal"
        case "think": return "brain"
        case "fetch": return "network"
        default: return "wrench"
        }
    }

    // MARK: Sessions

    func startSession(agentID: String, cwd: String, title: String?, prompt: String, parent: RecordID? = nil) {
        if let parent, !prompt.isEmpty { spawnSubAgent(parent: parent, agentID: agentID, prompt: prompt, title: title, cwd: cwd); return }
        lastError = nil
        Task {
            do {
                if useServer {
                    let r = try await serverCall("POST", "/sessions", ["agent": .string(agentID), "cwd": .string(cwd), "title": title.map(JSONValue.string) ?? .null, "prompt": .string(prompt)])
                    if let e = r["error"]?.string { throw ServerError(e) }
                } else {
                    let sid = try await runtime.startSession(agentID: agentID, cwd: cwd, title: title)
                    Log.info("Started \(agentID) session \(sid) in \(cwd)", category: "agents")
                    refresh()
                    onSessionStarted?(sid)
                    if !prompt.isEmpty { send(sid, prompt) }
                }
                refresh()
            } catch { lastError = "\(error)" }
        }
    }

    /// Called with the new session id (the app opens it).
    @ObservationIgnored var onSessionStarted: ((RecordID) -> Void)?

    func send(_ sid: RecordID, _ text: String) {
        guard !text.isEmpty else { return }
        Log.breadcrumb("prompt → session \(sid.prefix(6))")
        busy.insert(sid); liveText[sid] = ""; thoughts[sid] = nil; lastError = nil
        Task {
            defer { busy.remove(sid); liveText[sid] = nil; refresh() }
            do {
                if useServer {
                    let r = try await serverCall("POST", "/sessions/\(sid)/prompt", ["prompt": .string(text)])
                    if let e = r["error"]?.string { throw ServerError(e) }
                } else {
                    if !isLive(sid) { try await runtime.attach(sid) }
                    _ = try await runtime.prompt(sid, text)
                }
            } catch { lastError = "\(error)"; Log.error("Session \(sid) failed: \(error)", category: "agents") }
        }
    }

    func cancel(_ sid: RecordID) {
        if useServer { Task { _ = try? await serverCall("POST", "/sessions/\(sid)/cancel") } } else { runtime.cancel(sid) }
    }
    func stop(_ sid: RecordID) {
        if useServer { Task { _ = try? await serverCall("POST", "/sessions/\(sid)/stop") } } else { runtime.stop(sid) }
        refresh()
    }
    func switchAgent(_ sid: RecordID, to agentID: String) {
        Task {
            do {
                if useServer { _ = try await serverCall("POST", "/sessions/\(sid)/switch", ["agent": .string(agentID)]) }
                else { try await runtime.switchAgent(sid, to: agentID) }
                refresh()
            } catch { lastError = "\(error)" }
        }
    }
    func deleteSession(_ sid: RecordID) { stop(sid); store.trash([sid]); refresh() }

    // MARK: Inbox

    func resolve(_ item: InboxItem, decision: String) {
        let approved = decision.hasPrefix("allow") || decision == "approve"
        brain.resolveInbox(item.id, decision: decision, status: approved ? .approved : .rejected, device: machineName)
        if useServer { Task { _ = try? await serverCall("POST", "/inbox/\(item.id)/resolve", ["decision": .string(decision), "device": .string(machineName)]) } }
        refresh()
    }

    // MARK: Connections

    func addFromCatalog(_ index: Int) -> RecordID {
        let c = BrainStore.connectionCatalog[index]
        let id = brain.saveConnection(name: c.name, transport: c.transport, command: c.command, envName: c.envName, enabled: true, exposeToAgents: true)
        refresh(); return id
    }
    func saveConnection(name: String, transport: Connection.Transport, command: String, envName: String, enabled: Bool, expose: Bool, secret: String?) {
        let id = brain.saveConnection(name: name, transport: transport, command: command, envName: envName, enabled: enabled, exposeToAgents: expose)
        if let secret, let c = brain.connections().first(where: { $0.id == id }) { Secrets.set(c.secretKey, secret.isEmpty ? nil : secret) }
        refresh()
    }
    func setConnection(_ c: Connection, enabled: Bool? = nil, expose: Bool? = nil) {
        _ = brain.saveConnection(name: c.name, transport: c.transport, command: c.command, envName: c.envName, enabled: enabled ?? c.enabled, exposeToAgents: expose ?? c.exposeToAgents)
        refresh()
    }
    func deleteConnection(_ c: Connection) { Secrets.set(c.secretKey, nil); brain.deleteConnection(c.id); refresh() }
    func reloadConnections() { Task { await connections.reload(); refresh() } }
    func hasSecret(_ c: Connection) -> Bool { !(Secrets.get(c.secretKey) ?? "").isEmpty }

    // MARK: Server transport

    struct ServerError: Error, CustomStringConvertible { let description: String; init(_ d: String) { description = d } }

    private func serverCall(_ method: String, _ path: String, _ body: [String: JSONValue]? = nil) async throws -> JSONValue {
        guard let base = UserDefaults.standard.string(forKey: "server.url"), let url = URL(string: base + path) else { throw ServerError("No Based server configured (Settings → Based server).") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = Secrets.get("server.token"), !t.isEmpty { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONValue.object(body).encoded() }
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401 { throw ServerError("Server token rejected") }
        return (try? JSONValue.parse(data)) ?? .object([:])
    }
}
