import Foundation
import BasedCore

/// Model Context Protocol server (JSON-RPC 2.0; protocol versions in `supportedVersions`, negotiated in `initialize`).
/// Exposes workspace tools, pages as resources and skills as prompts, so Claude, ChatGPT, Cursor …
/// all see the same brain. Transport-agnostic: feed it request JSON, get response JSON.
public final class MCPServer: @unchecked Sendable {
    public let tools: AgentTools
    public let serverName: String
    public let version: String
    /// Claude Code permission prompts (`--permission-prompt-tool mcp__based__approval`), scoped to a session
    /// by the endpoint path `/mcp/session/<id>`. Receives (session, tool_name, input) and returns the decision JSON.
    public var approval: (@Sendable (String, String, JSONValue) async -> JSONValue)?

    public init(tools: AgentTools, serverName: String = "based", version: String = "0.1.0") {
        self.tools = tools; self.serverName = serverName; self.version = version
    }

    /// BSD-58: protocol versions this server speaks, newest first. `initialize` answers with the client's version
    /// when it is in the list, otherwise with the newest one (the client then decides whether to continue).
    public static let supportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05"]

    public static func negotiate(_ requested: String?) -> String {
        if let r = requested, supportedVersions.contains(r) { return r }
        return supportedVersions[0]
    }

    /// BSD-58: the user's main agent, for `ask_main_agent` (set by the server; nil = tool not offered).
    public var mainAgent: MainAgent?
    /// App variant of `mainAgent`: built per call so it follows the current model and permission settings
    /// (the app's local MCP host). Used when `mainAgent` is nil.
    public var mainAgentProvider: (@MainActor () -> MainAgent?)?

    var offersMainAgent: Bool { mainAgent != nil || mainAgentProvider != nil }

    func resolveMainAgent() async -> MainAgent? {
        if let mainAgent { return mainAgent }
        guard let p = mainAgentProvider else { return nil }
        return await MainActor.run { p() }
    }

    static let askMainAgentSpec = ToolSpec(
        name: "ask_main_agent",
        description: "Hand a task to the user's main agent, which runs it as a sub-agent in the background on a model that fits the kind of work. Returns the run id immediately; follow it with get_run, the result is also posted to the project. Use it for work that takes more than a few tool calls (research, writing, coding, reorganising). Example: ask_main_agent {\"task\": \"Research three competitors of Publit and write a comparison page\", \"kind\": \"research\", \"project\": \"Publit\"}.",
        inputSchema: .schema(["task": .str("Complete, self-contained instructions"),
                              "kind": .str("code | research | write | organize (default organize)"),
                              "project": .str("Optional project id or name"),
                              "compute": .str("Optional: low | auto | high (default auto)")], required: ["task"]))

    static let approvalSpec = ToolSpec(name: "approval", description: "Asks the Based user to approve a tool call (permission prompt). Used by Claude Code.",
                                       inputSchema: .schema(["tool_name": .str("Tool that wants to run"), "input": ["type": "object", "description": "Tool input"],
                                                             "tool_use_id": .str("Tool use id")], required: ["tool_name", "input"]))

    /// Handle one JSON-RPC message (request, notification or batch). Returns nil for notifications.
    public func handle(_ raw: Data, session: String? = nil) async -> Data? {
        guard let msg = try? JSONValue.parse(raw) else {
            return try? error(id: .null, code: -32700, "Parse error").encoded()
        }
        if let batch = msg.array {
            var out: [JSONValue] = []
            for m in batch { if let r = await handle(message: m, session: session) { out.append(r) } }
            return out.isEmpty ? nil : try? JSONValue.array(out).encoded()
        }
        return await handle(message: msg, session: session).flatMap { try? $0.encoded() }
    }

    public func handle(message m: JSONValue, session: String? = nil) async -> JSONValue? {
        let id = m["id"] ?? .null
        guard let method = m["method"]?.string else { return error(id: id, code: -32600, "Invalid request") }
        let params = m["params"] ?? .object([:])
        if m["id"] == nil || id.isNull { // notification
            return nil
        }
        do {
            let result = try await dispatch(method, params, session: session)
            return ["jsonrpc": "2.0", "id": id, "result": result]
        } catch let e as RPCError {
            return error(id: id, code: e.code, e.message)
        } catch let e {
            return error(id: id, code: -32000, "\(e)")
        }
    }

    struct RPCError: Error { let code: Int; let message: String }

    private func error(id: JSONValue, code: Int, _ message: String) -> JSONValue {
        ["jsonrpc": "2.0", "id": id, "error": ["code": .number(Double(code)), "message": .string(message)]]
    }

    private func dispatch(_ method: String, _ p: JSONValue, session: String?) async throws -> JSONValue {
        switch method {
        case "initialize":
            return ["protocolVersion": .string(Self.negotiate(p["protocolVersion"]?.string)),
                    "capabilities": ["tools": ["listChanged": false], "resources": ["subscribe": false, "listChanged": false], "prompts": ["listChanged": false]],
                    "serverInfo": ["name": .string(serverName), "version": .string(version)],
                    "instructions": .string(BasedGuide.instructions)]
        case "ping": return .object([:])
        case "tools/list":
            var specs = await MainActor.run { tools.specs }
            if session != nil, approval != nil { specs.insert(Self.approvalSpec, at: 0) }
            if session == nil, offersMainAgent { specs.append(Self.askMainAgentSpec) }
            return ["tools": .array(specs.map { ["name": .string($0.name), "description": .string($0.description), "inputSchema": $0.inputSchema] })]
        case "tools/call":
            guard let name = p["name"]?.string else { throw RPCError(code: -32602, message: "name required") }
            let args = p["arguments"] ?? .object([:])
            if name == "approval", let session, let approval {
                let decision = await approval(session, args["tool_name"]?.string ?? "tool", args["input"] ?? .object([:]))
                let text = (try? decision.encoded()).map { String(decoding: $0, as: UTF8.self) } ?? "{\"behavior\":\"deny\",\"message\":\"error\"}"
                return ["content": [["type": "text", "text": .string(text)]]]
            }
            // BSD-58: a coding agent (session-scoped endpoint) must not answer the user's inbox — that would let it
            // approve its own permission requests.
            if session != nil, name == "resolve_inbox" {
                return ["content": [["type": "text", "text": "Not permitted: agents can't answer the user's inbox. Ask the user."]], "isError": true]
            }
            if name == Self.askMainAgentSpec.name, session == nil, let mainAgent = await resolveMainAgent() {
                let thread = await MainActor.run { () -> RecordID in
                    tools.brain.ensureMainAgent()
                    return tools.brain.ensureMainThread(machine: "mcp")
                }
                var a = args
                if case .object(var o) = a, o["kind"] == nil { o["kind"] = "organize"; a = .object(o) }
                let r = await mainAgent.delegate(a, thread: thread)
                return ["content": [["type": "text", "text": .string(r.text)]], "isError": .bool(r.isError)]
            }
            var callArgs = args
            // Session-scoped calls (`/mcp/session/<id>`): host tools learn who is calling (sub-agent parent).
            if let session, await MainActor.run(body: { tools.isHost(name) }), case .object(var o) = args {
                o["_caller_session"] = .string(session); callArgs = .object(o)
            }
            let r = await tools.callAsync(name, callArgs)
            return ["content": [["type": "text", "text": .string(r.text)]], "isError": .bool(r.isError)]
        case "resources/list":
            let items: [JSONValue] = await MainActor.run {
                var out: [JSONValue] = [
                    ["uri": "brain://about", "name": "About the user", "mimeType": "text/markdown"],
                    ["uri": "brain://memories", "name": "All memories", "mimeType": "text/markdown"],
                ]
                for t in BasedGuide.topics {
                    out.append(["uri": .string("based://docs/\(t.name)"), "name": .string("Guide: \(t.title)"), "mimeType": "text/markdown"])
                }
                for pg in tools.store.allPages().prefix(500) where !tools.store.isTrashed(pg.id) {
                    out.append(["uri": .string("based://page/\(pg.id)"), "name": .string(pg.title.nonEmpty ?? "Untitled"), "mimeType": "text/markdown"])
                }
                return out
            }
            return ["resources": .array(items)]
        case "resources/templates/list":
            return ["resourceTemplates": [["uriTemplate": "based://page/{id}", "name": "Page as Markdown", "mimeType": "text/markdown"]]]
        case "resources/read":
            guard let uri = p["uri"]?.string else { throw RPCError(code: -32602, message: "uri required") }
            let text: String = try await MainActor.run {
                if uri == "brain://about" { return tools.brain.about }
                if uri.hasPrefix("based://docs/"), let d = BasedGuide.doc(String(uri.dropFirst("based://docs/".count))) { return d }
                if uri == "brain://memories" { return tools.brain.memories().map { "## \($0.title) (\($0.kind.rawValue))\n\($0.body)" }.joined(separator: "\n") }
                if uri.hasPrefix("based://page/") {
                    let id = String(uri.dropFirst("based://page/".count))
                    guard tools.store.blocks[id] != nil else { throw RPCError(code: -32002, message: "Resource not found") }
                    return tools.call("read_page", ["page_id": .string(id)]).text
                }
                throw RPCError(code: -32002, message: "Unknown resource")
            }
            return ["contents": [["uri": .string(uri), "mimeType": "text/markdown", "text": .string(text)]]]
        case "prompts/list":
            let skills = await MainActor.run { tools.brain.skills(enabledOnly: true) }
            return ["prompts": .array(skills.map { ["name": .string($0.name), "description": .string($0.description),
                                                      "arguments": [["name": "input", "description": "What to apply the skill to", "required": false]]] })]
        case "prompts/get":
            guard let name = p["name"]?.string else { throw RPCError(code: -32602, message: "name required") }
            let skill = await MainActor.run { tools.brain.skills().first { $0.name == name } }
            guard let skill else { throw RPCError(code: -32602, message: "Unknown prompt") }
            let input = p["arguments"]?["input"]?.string ?? ""
            let text = "# Skill: \(skill.name)\n\(skill.body)" + (input.isEmpty ? "" : "\n\n# Input\n\(input)")
            return ["description": .string(skill.description), "messages": [["role": "user", "content": ["type": "text", "text": .string(text)]]]]
        case "completion/complete", "logging/setLevel": return .object([:])
        default: throw RPCError(code: -32601, message: "Method not found: \(method)")
        }
    }
}

/// stdio transport: one JSON-RPC message per line (what Claude Desktop, Cursor etc. spawn).
public final class StdioTransport {
    let server: MCPServer
    public init(server: MCPServer) { self.server = server }

    public func run() async {
        while let line = readLine(strippingNewline: true) {
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            if let out = await server.handle(Data(line.utf8)), let s = String(data: out, encoding: .utf8) {
                print(s); fflush(stdout)
            }
        }
    }
}
