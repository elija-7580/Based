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
//
// BSD-34 (ADR 0006): the routes live in BasedBrain (Server/ServerRoutes.swift, Server/ShareRoutes.swift) behind one
// router with auth middleware and limits. Without a token the server only listens on 127.0.0.1 (--insecure-public
// opens it anyway, with a warning).

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
    /// BSD-34: listen on all interfaces even without a token (explicit opt-in, logged as a warning).
    var insecurePublic = ProcessInfo.processInfo.environment["BASED_INSECURE_PUBLIC"] == "1"
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
    /// BSD-106: Docker Engine socket for `--sandbox docker-api`.
    var dockerSocket = ProcessInfo.processInfo.environment["BASED_DOCKER_SOCKET"] ?? "/var/run/docker.sock"
    /// BSD-62: OpenAI-compatible embeddings endpoint for semantic search (e.g. Ollama http://127.0.0.1:11434/v1).
    var embeddings = ProcessInfo.processInfo.environment["BASED_EMBEDDINGS_URL"]
    var embeddingModel = ProcessInfo.processInfo.environment["BASED_EMBEDDING_MODEL"] ?? "nomic-embed-text"
    var embeddingKey = ProcessInfo.processInfo.environment["BASED_EMBEDDINGS_KEY"] ?? ""
    /// BSD-110: environment variables approved per coding agent, `id=NAME[,NAME]` (also `BASED_AGENT_ENV`,
    /// several separated by `;`), e.g. `--agent-env claude=ANTHROPIC_API_KEY`.
    var agentEnv: [String] = ProcessInfo.processInfo.environment["BASED_AGENT_ENV"].map { [$0] } ?? []
    /// BSD-72: HLC node of this server's stamps. Two servers syncing the same workspace need different names.
    var node = ProcessInfo.processInfo.environment["BASED_NODE"] ?? "server"

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
            case "--insecure-public": insecurePublic = true
            case "--sandbox": sandbox = it.next() ?? sandbox
            case "--sandbox-image": sandboxImage = it.next() ?? sandboxImage
            case "--sandbox-mount": if let m = it.next() { sandboxMounts.append(m) }
            case "--sandbox-env": if let e = it.next() { sandboxEnv.append(e) }
            case "--agent-env": if let e = it.next() { agentEnv.append(e) }
            case "--node": node = it.next() ?? node
            case "--sandbox-no-network": sandboxNetwork = false
            case "--docker-socket": dockerSocket = it.next() ?? dockerSocket
            case "--embeddings": embeddings = it.next()
            case "--embedding-model": embeddingModel = it.next() ?? embeddingModel
            case "-h", "--help":
                print("usage: based-server [--db path] [--port 8787] [--token secret] [--anthropic-key K] [--openai-key K] [--ollama http://host:11434/v1] [--stdio] [--no-scheduler] [--cipher-key BASE64] [--machine name] [--no-acp] [--insecure-public] [--sandbox local|docker|docker-api] [--docker-socket path] [--sandbox-image img] [--sandbox-mount host:container] [--sandbox-env NAME] [--sandbox-no-network] [--agent-env id=NAME[,NAME]] [--node name] [--embeddings http://host:11434/v1] [--embedding-model nomic-embed-text]")
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
// BSD-110: approvals for agent children (same defaults keys the Mac app's Settings write).
if !opts.agentEnv.isEmpty {
    let parsed = ShellEnvironment.parseAgentEnvSpecs(opts.agentEnv)
    ShellEnvironment.applyAgentEnv(parsed.approvals)
    for bad in parsed.invalid { Log.warning("--agent-env: ignored “\(bad)” (expected id=NAME[,NAME])", category: "server") }
    for (id, names) in parsed.approvals.sorted(by: { $0.key < $1.key }) {
        Log.info("agent env: \(id) may inherit \(names.joined(separator: ", "))", category: "server")
    }
}
func log(_ s: String, category: String = "server") { Log.info(s, category: category) }

@MainActor func boot() throws -> (WorkspaceStore, AgentTools, MCPServer, SyncServer, AgentRuntime, HappierRuntime) {
    // BSD-121: writes go through a background writer (flushed on SIGTERM / SIGINT and before stdio exits).
    let store = try ServerStorage.openStore(url: URL(fileURLWithPath: opts.db), node: opts.node)
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
let terminationSources = await MainActor.run { ServerStorage.flushOnTermination(store) }
_ = terminationSources
// Sharing: people, links and published pages with roles (ShareRoutes.swift, docs/sharing.md).
let share = await MainActor.run { ShareService(store: store) }
// BSD-58: MCP clients can hand work to the main agent (`ask_main_agent`).
mcp.mainAgent = MainAgent(runtime: runtime)
// BSD-116: "code" jobs of the main agent go to a coding session here too (Claude Code / Codex … installed on the
// server), in the main thread.
if let main = mcp.mainAgent {
    main.installed = await ChatEngineSpec.Kind.installedCLIs()
    main.cliLauncher = happier.mainAgentLauncher(thread: { await MainActor.run { tools.brain.mainThread() } })
}

// BSD-62: semantic search over an OpenAI-compatible embeddings endpoint. The index (embeddings.sqlite next to the
// database, never synced) is brought up to date at start and every 5 minutes; only changed pages are re-embedded.
if let u = opts.embeddings, let url = URL(string: u) {
    do {
        let provider = try await OpenAIEmbeddingProvider.probe(baseURL: url, model: opts.embeddingModel, apiKey: opts.embeddingKey)
        let indexURL = URL(fileURLWithPath: opts.db).deletingLastPathComponent().appendingPathComponent("embeddings.sqlite")
        let index = try SemanticIndex(url: indexURL, providerID: provider.id, dimension: provider.dimension)
        let context = SemanticContext(index: index, provider: provider)
        await MainActor.run {
            tools.semantic = context
            let indexer = SemanticIndexer(store: store, context: context, excludedRoots: [tools.brain.rootID])
            Task { @MainActor in
                while !Task.isCancelled {
                    let r = await indexer.update()
                    if r.embedded + r.removed + r.failed > 0 {
                        log("Semantic index: \(r.embedded) pages embedded, \(r.removed) removed, \(r.failed) failed", category: "search")
                    }
                    try? await Task.sleep(nanoseconds: 300_000_000_000)
                }
            }
        }
        log("Semantic search on (\(provider.id), \(provider.dimension) dimensions)", category: "search")
    } catch {
        Log.warning("Semantic search off: embeddings endpoint \(u) not usable (\(error))", category: "search")
    }
}
// BSD-98: deny rules of Agent Brain → Permissions also hold for MCP clients (they ask their user themselves).
mcp.permissions = { [tools] in tools.brain.permissions(mode: .bypass) }

if opts.stdio {
    await StdioTransport(server: mcp).run()
    let saved = await MainActor.run { ServerStorage.flush(store, reason: "stdio closed") }
    exit(saved ? 0 : 1)
}

let exposure = ServerExposure.binding(token: opts.token, insecurePublic: opts.insecurePublic)
if let w = exposure.warning { Log.warning(w, category: "server") }
if !opts.noACP {
    await happier.connections?.reload()
    log("connections: \(await MainActor.run { tools.brain.connections().filter(\.enabled).count }) enabled")
}

/// BSD-53: sandbox provider from the options. Secrets never enter the sandbox through the environment; logins come
/// from read-only mounts (see deploy/README.md).
@MainActor func configureSandbox(_ happier: HappierRuntime) {
    let snapshots = URL(fileURLWithPath: opts.db).deletingLastPathComponent().appendingPathComponent("sandbox-snapshots").path
    switch opts.sandbox {
    case "docker", "docker-api":
        let cli = DockerSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: snapshots)
        // BSD-106: "docker-api" talks to the Engine socket (no docker CLI needed except for interactive agents).
        happier.sandbox = opts.sandbox == "docker-api"
            ? DockerEngineSandboxProvider(api: UnixSocketHTTPTransport(socketPath: opts.dockerSocket), cli: cli) : cli
        let mounts: [(host: String, container: String)] = opts.sandboxMounts.compactMap { m in
            let parts = m.split(separator: ":", maxSplits: 1).map(String.init)
            return parts.count == 2 ? (host: parts[0], container: parts[1]) : nil
        }
        happier.sandboxTemplate = SandboxSpec(project: "", hostWorkspace: "", image: opts.sandboxImage, cpus: opts.sandboxCPUs,
                                              memoryMB: opts.sandboxMemoryMB, network: opts.sandboxNetwork, readOnlyMounts: mounts)
        happier.sandboxEnvironment.allow.formUnion(opts.sandboxEnv)
        log("sandbox: \(opts.sandbox) (\(opts.sandboxImage), \(opts.sandboxCPUs) CPU, \(opts.sandboxMemoryMB) MB, network \(opts.sandboxNetwork ? "on" : "off"))")
    case "local":
        happier.sandbox = LocalSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: snapshots,
                                               baseEnvironment: DockerSandboxProvider.cliEnvironment())
    default:
        FileHandle.standardError.write(Data("unknown sandbox \(opts.sandbox) (local|docker|docker-api)\n".utf8)); exit(2)
    }
}

let router = await MainActor.run {
    BasedServerRoutes.router(BasedServerServices(store: store, tools: tools, mcp: mcp, sync: sync, runtime: runtime, happier: happier, share: share),
                             ownerToken: opts.token, allowedOrigin: ServerExposure.allowedOrigin(publicURL: ProcessInfo.processInfo.environment["BASED_PUBLIC_URL"]))
}
let server = HTTPServer(port: opts.port, loopbackOnly: exposure.loopbackOnly,
                        bodyLimit: { method, path in router.bodyLimit(method: method, path: path) }) { req in await router.handle(req) }
try server.start()
log("based-server listening on \(exposure.loopbackOnly ? "127.0.0.1" : "*"):\(opts.port) · \(router.routes.count) routes · db \(opts.db) · providers: \(runtime.registry.all.map(\.id).joined(separator: ", ").nonEmptyOrNone)")

if !opts.noScheduler {
    let scheduler = AgentScheduler(runtime: runtime, node: "server")
    scheduler.onEvent = { log($0, category: "scheduler") }
    scheduler.start()
    log("scheduler started (tick 60s)")
}

// BSD-104: tombstones older than 90 days are compacted at start and then hourly (clients that were offline for
// longer see `oldestSeq` in /sync/v2/info and pull everything again).
while true {
    let n = await MainActor.run { sync.compactTombstones() }
    if n > 0 { log("sync: compacted \(n) tombstones older than \(SyncServer.tombstoneRetentionDays) days") }
    try await Task.sleep(nanoseconds: 3_600_000_000_000)
}

extension String { var nonEmptyOrNone: String { isEmpty ? "none" : self } }
