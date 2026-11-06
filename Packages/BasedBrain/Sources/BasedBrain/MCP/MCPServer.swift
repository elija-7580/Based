import Foundation
import BasedCore

/// Model Context Protocol server (JSON-RPC 2.0, protocol 2025-03-26).
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
            return ["protocolVersion": .string(p["protocolVersion"]?.string ?? "2025-03-26"),
                    "capabilities": ["tools": ["listChanged": false], "resources": ["subscribe": false, "listChanged": false], "prompts": ["listChanged": false]],
                    "serverInfo": ["name": .string(serverName), "version": .string(version)],
                    "instructions": "Based is the user's personal workspace (pages, databases, memories, skills). Use search/read_page before writing. Save durable facts with memory_save. Load a skill with load_skill before following it."]
        case "ping": return .object([:])
        case "tools/list":
            var specs = await MainActor.run { tools.specs }
            if session != nil, approval != nil { specs.insert(Self.approvalSpec, at: 0) }
            return ["tools": .array(specs.map { ["name": .string($0.name), "description": .string($0.description), "inputSchema": $0.inputSchema] })]
        case "tools/call":
            guard let name = p["name"]?.string else { throw RPCError(code: -32602, message: "name required") }
            let args = p["arguments"] ?? .object([:])
            if name == "approval", let session, let approval {
                let decision = await approval(session, args["tool_name"]?.string ?? "tool", args["input"] ?? .object([:]))
                let text = (try? decision.encoded()).map { String(decoding: $0, as: UTF8.self) } ?? "{\"behavior\":\"deny\",\"message\":\"error\"}"
                return ["content": [["type": "text", "text": .string(text)]]]
            }
            let r = await tools.callAsync(name, args)
            return ["content": [["type": "text", "text": .string(r.text)]], "isError": .bool(r.isError)]
        case "resources/list":
            let items: [JSONValue] = await MainActor.run {
                var out: [JSONValue] = [
                    ["uri": "brain://about", "name": "About the user", "mimeType": "text/markdown"],
                    ["uri": "brain://memories", "name": "All memories", "mimeType": "text/markdown"],
                ]
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
