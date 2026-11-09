import Foundation
import BasedCore
import BasedBrain

// based-server: always-on home for your workspace.
//   • HTTP sync endpoint for the Mac/iPhone apps      v2: GET /sync/v2/pull, POST /sync/v2/push (v1: /sync/push, /sync/pull)
//   • MCP server for Claude / ChatGPT / Cursor …      POST /mcp   (Streamable HTTP)  or  --stdio
//   • Agent scheduler (runs agents on their schedule)
//   • Health                                          GET /health
//   • Logs (JSONL, same format as the apps)           GET /logs?level=warning&limit=200
//   • Claude Code / Codex chats on this machine       GET /cli-sessions, GET /cli-sessions/{id}/transcript
//   • Agent setup check                               GET /doctor
//   • Sharing: links, invites, published pages        /s/<secret>, /p/<id>, /share/v1/…  (ShareRoutes.swift)
// Configuration via flags or env: BASED_DB, BASED_PORT, BASED_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_URL

struct Options {
    var db = ProcessInfo.processInfo.environment["BASED_DB"] ?? "based.sqlite"
    var port = UInt16(ProcessInfo.processInfo.environment["BASED_PORT"] ?? "") ?? 8787
    var token = ProcessInfo.processInfo.environment["BASED_TOKEN"] ?? ""
    var anthropic = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"]
    var openai = ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
    var ollama = ProcessInfo.processInfo.environment["OLLAMA_URL"]
    var stdio = false
    var noScheduler = false
    var cipherKey = ProcessInfo.processInfo.environment["BASED_CIPHER_KEY"]
    var machine = ProcessInfo.processInfo.environment["BASED_MACHINE"] ?? (ProcessInfo.processInfo.hostName)
    var noACP = false
    // BSD-53: where coding agents run – "docker" (one container per run) or "local" (directly in the folder).
    var sandbox = ProcessInfo.processInfo.environment["BASED_SANDBOX"] ?? "local"
    var sandboxImage = ProcessInfo.processInfo.environment["BASED_SANDBOX_IMAGE"] ?? SandboxSpec.defaultImage
    var sandboxCPUs = Double(ProcessInfo.processInfo.environment["BASED_SANDBOX_CPUS"] ?? "") ?? 2
    var sandboxMemoryMB = Int(ProcessInfo.processInfo.environment["BASED_SANDBOX_MEMORY_MB"] ?? "") ?? 4096
    var sandboxNetwork = ProcessInfo.processInfo.environment["BASED_SANDBOX_NETWORK"] != "none"
    /// "host:container" pairs mounted read-only (agent CLI logins), e.g. /home/based/.claude:/root/.claude
    var sandboxMounts: [String] = (ProcessInfo.processInfo.environment["BASED_SANDBOX_MOUNTS"] ?? "").split(separator: ",").map(String.init)
    /// Extra environment variable names that may enter the sandbox (allowlist).
    var sandboxEnv: [String] = (ProcessInfo.processInfo.environment["BASED_SANDBOX_ENV"] ?? "").split(separator: ",").map(String.init)

    init() {
        var it = CommandLine.arguments.dropFirst().makeIterator()
        while let a = it.next() {
            switch a {
            case "--db": db = it.next() ?? db
            case "--port": port = UInt16(it.next() ?? "") ?? port
            case "--token": token = it.next() ?? token
            case "--anthropic-key": anthropic = it.next()
            case "--openai-key": openai = it.next()
            case "--ollama": ollama = it.next()
            case "--stdio": stdio = true
            case "--no-scheduler": noScheduler = true
            case "--cipher-key": cipherKey = it.next()
            case "--machine": machine = it.next() ?? machine
            case "--no-acp": noACP = true
            case "--sandbox": sandbox = it.next() ?? sandbox
            case "--sandbox-image": sandboxImage = it.next() ?? sandboxImage
            case "--sandbox-mount": if let m = it.next() { sandboxMounts.append(m) }
            case "--sandbox-env": if let e = it.next() { sandboxEnv.append(e) }
            case "--sandbox-no-network": sandboxNetwork = false
            case "-h", "--help":
                print("usage: based-server [--db path] [--port 8787] [--token secret] [--anthropic-key K] [--openai-key K] [--ollama http://host:11434/v1] [--stdio] [--no-scheduler] [--cipher-key BASE64] [--machine name] [--no-acp] [--sandbox local|docker] [--sandbox-image img] [--sandbox-mount host:container] [--sandbox-env NAME] [--sandbox-no-network]")
                exit(0)
            default: FileHandle.standardError.write(Data("unknown option \(a)\n".utf8)); exit(2)
            }
        }
    }
}

let opts = Options()
// Structured logs: JSONL files next to the database + stderr (journald / docker logs pick it up).
Log.shared.subsystem = "com.based.server"
Log.shared.configure(directory: URL(fileURLWithPath: opts.db).deletingLastPathComponent().appendingPathComponent("logs"), name: "based-server")
Log.shared.echoToStderr = true
if let lvl = ProcessInfo.processInfo.environment["BASED_LOG_LEVEL"].flatMap(LogLevel.init(name:)) { Log.shared.minimumLevel = lvl }
func log(_ s: String, category: String = "server") { Log.info(s, category: category) }

@MainActor func boot() throws -> (WorkspaceStore, AgentTools, MCPServer, SyncServer, AgentRuntime, HappierRuntime) {
    let persistence = try SQLitePersistence(url: URL(fileURLWithPath: opts.db))
    let store = WorkspaceStore(persistence: persistence, node: "server")
    let brain = BrainStore(store: store)
    let tools = AgentTools(store: store, brain: brain)
    let registry = ModelRegistry()
    if let k = opts.anthropic, !k.isEmpty { registry.register(AnthropicProvider(apiKey: k)) }
    if let k = opts.openai, !k.isEmpty { registry.register(OpenAIProvider(apiKey: k)) }
    if let u = opts.ollama, let url = URL(string: u) { registry.register(OpenAIProvider.ollama(baseURL: url)) }
    let runtime = AgentRuntime(registry: registry, tools: tools)
    // Happier-style control room: MCP connections + ACP coding agents, transcripts in the Brain.
    let env = ProcessInfo.processInfo.environment
    let connections = ConnectionManager(tools: tools, secret: { key in
        env[key] ?? env[key.uppercased()] ?? env[key.uppercased().replacingOccurrences(of: ".", with: "_").replacingOccurrences(of: "-", with: "_")]
    })
    let happier = HappierRuntime(brain: brain, connections: connections, machineName: opts.machine)
    if let k = opts.cipherKey { happier.cipher = SessionCipher(base64: k) }
    let exe = CommandLine.arguments.first ?? "based-server"
    happier.basedMCPServer = MCPServerConfig(name: "based", command: exe, args: ["--stdio", "--db", opts.db])
    happier.onLog = { Log.debug($0, category: "acp") }
    let publicURL = ProcessInfo.processInfo.environment["BASED_PUBLIC_URL"] ?? "http://127.0.0.1:\(opts.port)"
    happier.mcpEndpoint = (publicURL, opts.token)
    happier.mcpSessionTokens = MCPSessionTokens()   // BSD-33: agents get per-session tokens, never the master token
    tools.hostSpecs = HappierRuntime.subAgentSpecs
    configureSandbox(happier)
    tools.hostCall = { [happier] name, args in await happier.hostTool(name, args) }
    let mcp = MCPServer(tools: tools)
    mcp.approval = { [happier] session, tool, input in await happier.claudeApproval(session: session, tool: tool, input: input) }
    return (store, tools, mcp, SyncServer(store: store), runtime, happier)
}

let (store, tools, mcp, sync, runtime, happier) = try await MainActor.run { try boot() }
_ = store
// Sharing: people, links and published pages with roles (ShareRoutes.swift, docs/sharing.md).
let share = await MainActor.run { ShareService(store: store) }
// BSD-58: MCP clients can hand work to the main agent (`ask_main_agent`).
mcp.mainAgent = MainAgent(runtime: runtime)

if opts.stdio {
    await StdioTransport(server: mcp).run()
    exit(0)
}

if opts.token.isEmpty { log("WARNING: no --token set; the server is open to anyone who can reach it.") }
if !opts.noACP {
    await happier.connections?.reload()
    log("connections: \(await MainActor.run { tools.brain.connections().filter(\.enabled).count }) enabled")
}

/// BSD-53: sandbox provider from the options. Secrets never enter the sandbox through the environment; logins come
/// from read-only mounts (see deploy/README.md).
@MainActor func configureSandbox(_ happier: HappierRuntime) {
    let snapshots = URL(fileURLWithPath: opts.db).deletingLastPathComponent().appendingPathComponent("sandbox-snapshots").path
    switch opts.sandbox {
    case "docker":
        happier.sandbox = DockerSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: snapshots)
        let mounts: [(host: String, container: String)] = opts.sandboxMounts.compactMap { m in
            let parts = m.split(separator: ":", maxSplits: 1).map(String.init)
            return parts.count == 2 ? (host: parts[0], container: parts[1]) : nil
        }
        happier.sandboxTemplate = SandboxSpec(project: "", hostWorkspace: "", image: opts.sandboxImage, cpus: opts.sandboxCPUs,
                                              memoryMB: opts.sandboxMemoryMB, network: opts.sandboxNetwork, readOnlyMounts: mounts)
        happier.sandboxEnvironment.allow.formUnion(opts.sandboxEnv)
        log("sandbox: docker (\(opts.sandboxImage), \(opts.sandboxCPUs) CPU, \(opts.sandboxMemoryMB) MB, network \(opts.sandboxNetwork ? "on" : "off"))")
    case "local":
        happier.sandbox = LocalSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: snapshots,
                                               baseEnvironment: DockerSandboxProvider.cliEnvironment())
    default:
        FileHandle.standardError.write(Data("unknown sandbox \(opts.sandbox) (local|docker)\n".utf8)); exit(2)
    }
}

func sandboxJSON(_ sid: RecordID, _ h: SandboxHandle) -> JSONValue {
    .object(["session": .string(sid), "provider": .string(h.provider), "id": .string(h.id), "reference": .string(h.reference),
             "project": .string(h.project), "workdir": .string(h.workdir), "image": .string(h.image),
             "snapshots": .array(h.snapshots.map { .object(["name": .string($0.name), "image": .string($0.image),
                                                             "created": .string(ISO8601DateFormatter().string(from: $0.createdAt))]) })])
}

/// Path matcher for "/sessions/{id}/prompt"‑style routes.
func match(_ path: String, _ pattern: String) -> [String]? {
    let p = path.split(separator: "/"), q = pattern.split(separator: "/")
    guard p.count == q.count else { return nil }
    var caps: [String] = []
    for (a, b) in zip(p, q) { if b == "*" { caps.append(String(a)) } else if a != b { return nil } }
    return caps
}

func sessionJSON(_ s: AgentSession) -> JSONValue {
    .object(["id": .string(s.id), "title": .string(s.title), "agent": .string(s.agentID), "status": .string(s.status.rawValue),
             "machine": .string(s.machine), "cwd": .string(s.cwd), "tokens": .number(Double(s.tokens)),
             "started": .string(ISO8601DateFormatter().string(from: s.startedAt)), "encrypted": .bool(s.encrypted),
             "live": .bool(happier.liveSessionIDs.contains(s.id)), "project": .string(s.project),
             "parent": s.parentID.map(JSONValue.string) ?? .null, "task": .string(s.task), "result": .string(String(s.result.suffix(2000))),
             "working": .bool(happier.isWorking(s.id))])
}
func inboxJSON(_ i: InboxItem) -> JSONValue {
    .object(["id": .string(i.id), "title": .string(i.title), "kind": .string(i.kind.rawValue), "status": .string(i.status.rawValue),
             "session": i.sessionID.map(JSONValue.string) ?? .null, "detail": .string(i.detail),
             "options": .array(i.options.map(JSONValue.string)), "decision": i.decision.map(JSONValue.string) ?? .null])
}

let server = HTTPServer(port: opts.port) { req in
    func authorized() -> Bool { opts.token.isEmpty || req.bearerToken == opts.token }
    if req.method == "OPTIONS" {
        return HTTPServer.Response(status: 204, headers: ["Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id"])
    }
    if let shared = await ShareRoutes.handle(req, share: share, sync: sync, store: store, ownerToken: opts.token) { return shared }
    switch (req.method, req.path) {
    case ("GET", "/health"), ("GET", "/"):
        return .json(["ok": true, "name": "based-server", "time": .string(ISO8601DateFormatter().string(from: Date()))])
    case ("POST", "/mcp"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        guard let out = await mcp.handle(req.body) else { return HTTPServer.Response(status: 202) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
    case ("GET", "/mcp"):
        return .text("SSE streaming is not supported; use POST /mcp (Streamable HTTP, JSON responses).", status: 405)
    case ("POST", _) where match(req.path, "/mcp/session/*") != nil:
        let sid = match(req.path, "/mcp/session/*")![0]
        // BSD-33: the owner token, or this session's own token (only valid here, not for /mcp or /sync).
        guard authorized() || happier.mcpSessionTokens?.isValid(req.bearerToken ?? "", session: sid) == true else {
            return .json(["error": "unauthorized"], status: 401)
        }
        guard let out = await mcp.handle(req.body, session: sid) else { return HTTPServer.Response(status: 202) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
    case ("GET", "/logs"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let level = req.query["level"].flatMap(LogLevel.init(name:)) ?? .debug
        let limit = Int(req.query["limit"] ?? "") ?? 300
        let entries = Log.shared.recent(limit: limit, minLevel: level, category: req.query["category"], search: req.query["q"])
        if req.query["format"] == "text" { return .text(entries.map(\.line).joined(separator: "\n")) }
        let data = (try? JSONEncoder().encode(entries)) ?? Data("[]".utf8)
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: data)
    case ("GET", "/cli-sessions"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let list = CLISessionIndex.scan(limit: Int(req.query["limit"] ?? "") ?? 200)
        let f = ISO8601DateFormatter()
        return .json(["sessions": .array(list.map { s in
            .object(["id": .string(s.id), "tool": .string(s.tool), "title": .string(s.title), "cwd": .string(s.cwd), "project": .string(s.project),
                     "updated": .string(f.string(from: s.updatedAt)), "branch": s.gitBranch.map(JSONValue.string) ?? .null,
                     "resume": .string(s.resumeCommand)]) })])
    case ("GET", _) where match(req.path, "/cli-sessions/*/transcript") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let id = match(req.path, "/cli-sessions/*/transcript")![0]
        guard let s = CLISessionIndex.scan(limit: 2000).first(where: { $0.id == id }) else { return .json(["error": "not found"], status: 404) }
        return .json(["messages": .array(CLISessionIndex.transcript(of: s).map { m in
            .object(["role": .string(m.role.rawValue), "text": .string(m.text), "tool": m.toolName.map(JSONValue.string) ?? .null]) })])
    case ("GET", "/doctor"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let tools = AgentDoctor.probeTools()
        return .json(["environment": .string(ShellEnvironment.note),
                      "tools": .array(tools.map { t in .object(["id": .string(t.id), "name": .string(t.name), "path": t.path.map(JSONValue.string) ?? .null,
                                                                 "version": t.version.map(JSONValue.string) ?? .null, "install": .string(t.install)]) }),
                      "agents": .array(happier.agents.map { a in let st = AgentDoctor.status(of: a, tools: tools)
                          return .object(["id": .string(a.id), "state": .string(st.state.rawValue), "summary": .string(st.summary), "fix": st.fix.map(JSONValue.string) ?? .null]) })])
    case ("GET", "/sync/pull"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let since = req.query["since"].flatMap { try? JSONDecoder().decode(Stamp.self, from: Data($0.utf8)) }
        let env = await MainActor.run { sync.pull(since: since) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(env)) ?? Data())
    case ("POST", "/sync/push"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        guard let env = try? JSONDecoder().decode(SyncEnvelope.self, from: req.body) else { return .json(["error": "bad envelope"], status: 400) }
        let reply = await MainActor.run { sync.push(env) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(reply)) ?? Data())
    case ("GET", "/sync/v2/pull"):
        // Sync v2 (docs/sync-protocol.md): page through the server's change log.
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let after = req.query["after"].flatMap { Int64($0) } ?? 0
        let limit = req.query["limit"].flatMap { Int($0) } ?? 500
        let page = await MainActor.run { sync.pullPage(after: after, limit: limit) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(page)) ?? Data())
    case ("POST", "/sync/v2/push"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        guard let p = try? JSONDecoder().decode(SyncPush.self, from: req.body) else { return .json(["error": "bad push"], status: 400) }
        let reply = await MainActor.run { sync.pushV2(p) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(reply)) ?? Data())
    case ("POST", "/api/blocks/insert-after"):
        // Web client: new text block after `after` (the server computes the sort key with BasedCore).
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        guard let after = body["after"]?.string else { return .json(["error": "missing after"], status: 400) }
        let text = body["text"]?.string ?? ""
        let id: String? = await MainActor.run { store.insertBlock(.text, after: after, text: RichText(text)) }
        guard let id else { return .json(["error": "no such block"], status: 404) }
        return .json(["id": .string(id)])
    case ("GET", "/app"), ("GET", "/app/"):
        // Web client (read-only for now): loads the workspace through /sync/v2/pull. The token is entered in the page.
        return WebSecurity.page(WebApp.html)   // BSD-35: nonce CSP
    case ("GET", "/sync/v2/wait"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let after = req.query["after"].flatMap { Int64($0) } ?? 0
        let timeout = req.query["timeout"].flatMap { Double($0) } ?? 25
        let seq = await sync.waitForChanges(after: after, timeout: timeout)
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(SyncWait(seq: seq))) ?? Data())
    case ("GET", "/sync/v2/info"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let seq = await MainActor.run { (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0 }
        return .json(["protocol": 2, "seq": .number(Double(seq))])
    case ("POST", "/agents/run"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let name = (try? JSONValue.parse(req.body))?["agent"]?.string ?? ""
        guard let agent = await MainActor.run(body: { tools.brain.agents().first { $0.name == name } }) else { return .json(["error": "no such agent"], status: 404) }
        let o = await runtime.run(agent: agent, trigger: "api")
        return .json(["ok": .bool(o != nil), "text": .string(o?.text ?? ""), "tokens": .number(Double(o?.usage.total ?? 0))])
    case ("POST", "/ask"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        do {
            let o = try await runtime.run(prompt: body["prompt"]?.string ?? "", modelRef: body["model"]?.string)
            return .json(["text": .string(o.text), "tokens": .number(Double(o.usage.total)), "steps": .number(Double(o.steps))])
        } catch { return .json(["error": .string("\(error)")], status: 500) }
    // MARK: Happier‑style control room (ACP agents, inbox, connections)
    case ("GET", "/acp/agents"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        return .json(["agents": .array(happier.agents.map { a in
            .object(["id": .string(a.id), "name": .string(a.name), "command": .string(a.command), "enabled": .bool(a.enabled),
                     "installed": .bool(FileManager.default.isExecutableFile(atPath: ProcessTransport.resolve(a.command)))]) })])
    case ("GET", "/sessions"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let list = await MainActor.run { tools.brain.sessions() }
        return .json(["sessions": .array(list.map(sessionJSON))])
    case ("POST", "/sessions"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        let agent = body["agent"]?.string ?? "claude"
        let cwd = body["cwd"]?.string ?? FileManager.default.currentDirectoryPath
        do {
            let prompt = body["prompt"]?.string ?? ""
            if let parent = body["parent"]?.string, !parent.isEmpty, !prompt.isEmpty {
                // Sub-agent: inherits directory/project, obeys depth and fan-out limits.
                let sid = try await happier.spawn(agentID: agent, prompt: prompt, title: body["title"]?.string, cwd: body["cwd"]?.string,
                                                  project: body["project"]?.string, parentID: parent)
                return .json(["id": .string(sid)])
            }
            let sid = try await happier.startSession(agentID: agent, cwd: cwd, title: body["title"]?.string,
                                                     project: body["project"]?.string, parentID: body["parent"]?.string)
            if !prompt.isEmpty {
                Task { _ = try? await happier.prompt(sid, prompt) }
            }
            return .json(["id": .string(sid)])
        } catch { return .json(["error": .string("\(error)")], status: 500) }
    case ("POST", _) where match(req.path, "/sessions/*/prompt") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sessions/*/prompt")![0]
        let text = (try? JSONValue.parse(req.body))?["prompt"]?.string ?? ""
        do {
            if happier.connection(for: sid) == nil { try await happier.attach(sid) }
            let stop = try await happier.prompt(sid, text)
            return .json(["stop": .string(stop.rawValue)])
        } catch { return .json(["error": .string("\(error)")], status: 500) }
    case ("GET", _) where match(req.path, "/sessions/*/transcript") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sessions/*/transcript")![0]
        let md = await MainActor.run { tools.brain.transcript(sid, cipher: happier.cipher) }
        return .json(["markdown": .string(md)])
    case ("POST", _) where match(req.path, "/sessions/*/cancel") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        happier.cancel(match(req.path, "/sessions/*/cancel")![0]); return .json(["ok": true])
    case ("POST", _) where match(req.path, "/sessions/*/stop") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        happier.stop(match(req.path, "/sessions/*/stop")![0]); return .json(["ok": true])
    case ("POST", _) where match(req.path, "/sessions/*/switch") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sessions/*/switch")![0]
        let agent = (try? JSONValue.parse(req.body))?["agent"]?.string ?? "codex"
        do { try await happier.switchAgent(sid, to: agent); return .json(["ok": true]) }
        catch { return .json(["error": .string("\(error)")], status: 500) }
    case ("GET", "/inbox"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let pending = req.query["pending"] != "false"
        let items = await MainActor.run { tools.brain.inbox(pendingOnly: pending) }
        return .json(["items": .array(items.map(inboxJSON))])
    case ("POST", _) where match(req.path, "/inbox/*/resolve") != nil:
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let iid = match(req.path, "/inbox/*/resolve")![0]
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        let decision = body["decision"]?.string ?? "reject_once"
        let approved = decision.hasPrefix("allow") || decision == "approve" || body["approved"]?.bool == true
        let device = body["device"]?.string ?? "server"
        let first = await MainActor.run { tools.brain.resolveInbox(iid, decision: decision, status: approved ? .approved : .rejected, device: device) }
        // BSD-50: the first answer wins; a second device gets 409 instead of overwriting it.
        return first ? .json(["ok": true]) : .json(["ok": false, "error": "already answered"], status: 409)
    // BSD-53: sandboxes – owner only (a configured token is required; an open server never exposes them).
    case ("GET", "/sandboxes"):
        guard !opts.token.isEmpty, authorized() else { return .json(["error": "unauthorized"], status: 401) }
        return .json(["sandbox": .string(happier.sandbox?.kind ?? "none"),
                      "sandboxes": .array(happier.sandboxes.sorted { $0.key < $1.key }.map { sandboxJSON($0.key, $0.value) })])
    case ("POST", _) where match(req.path, "/sandboxes/*/snapshot") != nil:
        guard !opts.token.isEmpty, authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sandboxes/*/snapshot")![0]
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        let name = body["name"]?.string ?? "snap-\(Int(Date().timeIntervalSince1970))"
        do { return .json(sandboxJSON(sid, try await happier.snapshotSandbox(sid, name: name))) }
        catch SandboxError.invalidName(let n) { return .json(["error": .string("invalid name \(n)")], status: 400) }
        catch { return .json(["error": .string("\(error)")], status: 500) }
    case ("POST", _) where match(req.path, "/sandboxes/*/restore") != nil:
        guard !opts.token.isEmpty, authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sandboxes/*/restore")![0]
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        guard let name = body["snapshot"]?.string else { return .json(["error": "snapshot missing"], status: 400) }
        do { return .json(sandboxJSON(sid, try await happier.restoreSandbox(sid, snapshot: name))) }
        catch SandboxError.unknownSnapshot(let n) { return .json(["error": .string("unknown snapshot \(n)")], status: 404) }
        catch { return .json(["error": .string("\(error)")], status: 500) }
    case ("POST", _) where match(req.path, "/sandboxes/*/destroy") != nil:
        guard !opts.token.isEmpty, authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let sid = match(req.path, "/sandboxes/*/destroy")![0]
        happier.stop(sid)
        await happier.destroySandbox(sid)
        return .json(["ok": true])
    case ("GET", "/connections"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        let list = await MainActor.run { tools.brain.connections() }
        return .json(["connections": .array(list.map { c in
            .object(["id": .string(c.id), "name": .string(c.name), "transport": .string(c.transport.rawValue), "command": .string(c.command),
                     "enabled": .bool(c.enabled), "exposeToAgents": .bool(c.exposeToAgents), "status": .string(c.status)]) })])
    case ("POST", "/connections/reload"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        await happier.connections?.reload(); return .json(["ok": true])
    default:
        return .json(["error": "not found"], status: 404)
    }
}
try server.start()
log("based-server listening on :\(opts.port) · db \(opts.db) · providers: \(runtime.registry.all.map(\.id).joined(separator: ", ").nonEmptyOrNone)")

if !opts.noScheduler {
    let scheduler = AgentScheduler(runtime: runtime, node: "server")
    scheduler.onEvent = { log($0, category: "scheduler") }
    scheduler.start()
    log("scheduler started (tick 60s)")
}

while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }

extension String { var nonEmptyOrNone: String { isEmpty ? "none" : self } }
