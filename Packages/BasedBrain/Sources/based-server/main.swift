import Foundation
import BasedCore
import BasedBrain

// based-server: always-on home for your workspace.
//   • HTTP sync endpoint for the Mac/iPhone apps      POST /sync/push, GET /sync/pull
//   • MCP server for Claude / ChatGPT / Cursor …      POST /mcp   (Streamable HTTP)  or  --stdio
//   • Agent scheduler (runs agents on their schedule)
//   • Health                                          GET /health
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
            case "-h", "--help":
                print("usage: based-server [--db path] [--port 8787] [--token secret] [--anthropic-key K] [--openai-key K] [--ollama http://host:11434/v1] [--stdio] [--no-scheduler]")
                exit(0)
            default: FileHandle.standardError.write(Data("unknown option \(a)\n".utf8)); exit(2)
            }
        }
    }
}

let opts = Options()
func log(_ s: String) { if !opts.stdio { print("[\(ISO8601DateFormatter().string(from: Date()))] \(s)"); fflush(stdout) } else { FileHandle.standardError.write(Data((s + "\n").utf8)) } }

@MainActor func boot() throws -> (WorkspaceStore, AgentTools, MCPServer, SyncServer, AgentRuntime) {
    let persistence = try SQLitePersistence(url: URL(fileURLWithPath: opts.db))
    let store = WorkspaceStore(persistence: persistence, node: "server")
    let brain = BrainStore(store: store)
    let tools = AgentTools(store: store, brain: brain)
    let registry = ModelRegistry()
    if let k = opts.anthropic, !k.isEmpty { registry.register(AnthropicProvider(apiKey: k)) }
    if let k = opts.openai, !k.isEmpty { registry.register(OpenAIProvider(apiKey: k)) }
    if let u = opts.ollama, let url = URL(string: u) { registry.register(OpenAIProvider.ollama(baseURL: url)) }
    let runtime = AgentRuntime(registry: registry, tools: tools)
    return (store, tools, MCPServer(tools: tools), SyncServer(store: store), runtime)
}

let (store, tools, mcp, sync, runtime) = try await MainActor.run { try boot() }
_ = store; _ = tools

if opts.stdio {
    await StdioTransport(server: mcp).run()
    exit(0)
}

if opts.token.isEmpty { log("WARNING: no --token set; the server is open to anyone who can reach it.") }

let server = HTTPServer(port: opts.port) { req in
    func authorized() -> Bool { opts.token.isEmpty || req.bearerToken == opts.token }
    if req.method == "OPTIONS" {
        return HTTPServer.Response(status: 204, headers: ["Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id"])
    }
    switch (req.method, req.path) {
    case ("GET", "/health"), ("GET", "/"):
        return .json(["ok": true, "name": "based-server", "time": .string(ISO8601DateFormatter().string(from: Date()))])
    case ("POST", "/mcp"):
        guard authorized() else { return .json(["error": "unauthorized"], status: 401) }
        guard let out = await mcp.handle(req.body) else { return HTTPServer.Response(status: 202) }
        return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
    case ("GET", "/mcp"):
        return .text("SSE streaming is not supported; use POST /mcp (Streamable HTTP, JSON responses).", status: 405)
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
    default:
        return .json(["error": "not found"], status: 404)
    }
}
try server.start()
log("based-server listening on :\(opts.port) · db \(opts.db) · providers: \(runtime.registry.all.map(\.id).joined(separator: ", ").nonEmptyOrNone)")

if !opts.noScheduler {
    let scheduler = AgentScheduler(runtime: runtime)
    scheduler.onEvent = { log("scheduler: \($0)") }
    scheduler.start()
    log("scheduler started (tick 60s)")
}

while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }

extension String { var nonEmptyOrNone: String { isEmpty ? "none" : self } }
