import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Based as an MCP *client*: attach any MCP server (GitHub, Slack, Google, Linear, filesystem …) over stdio or Streamable HTTP
/// and expose its tools to the in-app agent, scheduled agents and ACP coding agents alike.
public final class MCPClient: @unchecked Sendable {
    public enum Transport: Sendable, Equatable {
        case stdio(command: String, args: [String], env: [String: String])
        case http(url: URL, bearer: String?)
    }
    public struct Tool: Sendable, Equatable { public var name: String; public var description: String; public var inputSchema: JSONValue }

    public let name: String
    public let transport: Transport
    public private(set) var tools: [Tool] = []
    public private(set) var serverInfo: JSONValue = .null
    public private(set) var lastError: String?
    private var process: ProcessTransport?
    private var httpSession: String?
    public var log: (@Sendable (String) -> Void)?

    public init(name: String, transport: Transport) { self.name = name; self.transport = transport }

    public func connect() async throws {
        switch transport {
        case .stdio(let cmd, let args, let env):
            let p = try ProcessTransport(command: cmd, arguments: args, environment: env)
            p.stderrLog = { [weak self] in self?.log?($0) }
            process = p
        case .http: break
        }
        let init_ = try await rpc("initialize", ["protocolVersion": "2025-03-26", "capabilities": [:], "clientInfo": ["name": "Based", "version": "0.2.0"]])
        serverInfo = init_["serverInfo"] ?? .null
        notify("notifications/initialized")
        try await refreshTools()
    }

    public func refreshTools() async throws {
        var all: [Tool] = []; var cursor: String? = nil
        repeat {
            var params: [String: JSONValue] = [:]
            if let cursor { params["cursor"] = .string(cursor) }
            let r = try await rpc("tools/list", .object(params))
            for t in r["tools"]?.array ?? [] {
                guard let n = t["name"]?.string else { continue }
                all.append(Tool(name: n, description: t["description"]?.string ?? "", inputSchema: t["inputSchema"] ?? .schema([:])))
            }
            cursor = r["nextCursor"]?.string
        } while cursor != nil
        tools = all
    }

    /// Returns (text, isError).
    public func call(_ tool: String, _ args: JSONValue) async throws -> (String, Bool) {
        let r = try await rpc("tools/call", ["name": .string(tool), "arguments": args])
        let text = r["content"]?.array?.compactMap { c -> String? in
            switch c["type"]?.string {
            case "text": return c["text"]?.string
            case "image": return "[image \(c["mimeType"]?.string ?? "")]"
            case "resource": return c["resource"]?["text"]?.string ?? c["resource"]?["uri"]?.string
            default: return c.text
            }
        }.joined(separator: "\n") ?? r.text
        return (text, r["isError"]?.bool ?? false)
    }

    public func disconnect() { process?.terminate(); process = nil }

    // MARK: Transport glue

    private func notify(_ method: String) {
        switch transport {
        case .stdio: process?.peer.notify(method)
        case .http(let url, let bearer):
            Task { _ = try? await post(url: url, bearer: bearer, body: ["jsonrpc": "2.0", "method": .string(method)]) }
        }
    }

    private func rpc(_ method: String, _ params: JSONValue?) async throws -> JSONValue {
        switch transport {
        case .stdio:
            guard let process else { throw JSONRPCPeer.RPCError.internalError("not connected") }
            return try await process.peer.request(method, params)
        case .http(let url, let bearer):
            var body: [String: JSONValue] = ["jsonrpc": "2.0", "id": .number(Double(Int.random(in: 1...1_000_000))), "method": .string(method)]
            if let params { body["params"] = params }
            let r = try await post(url: url, bearer: bearer, body: .object(body))
            if let e = r["error"] { throw JSONRPCPeer.RPCError(code: e["code"]?.int ?? -1, message: e["message"]?.string ?? "error") }
            return r["result"] ?? .null
        }
    }

    private func post(url: URL, bearer: String?, body: JSONValue) async throws -> JSONValue {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let bearer, !bearer.isEmpty { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let httpSession { req.setValue(httpSession, forHTTPHeaderField: "Mcp-Session-Id") }
        req.httpBody = try body.encoded()
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let h = resp as? HTTPURLResponse {
            if let sid = h.value(forHTTPHeaderField: "Mcp-Session-Id") { httpSession = sid }
            guard (200..<300).contains(h.statusCode) else { throw JSONRPCPeer.RPCError(code: h.statusCode, message: String(decoding: data.prefix(300), as: UTF8.self)) }
        }
        if data.isEmpty { return .null }
        // Streamable HTTP may answer with SSE; take the last data: line.
        if let s = String(data: data, encoding: .utf8), s.hasPrefix("event:") || s.hasPrefix("data:") {
            let lines = s.split(separator: "\n").filter { $0.hasPrefix("data:") }
            if let last = lines.last { return try JSONValue.parse(String(last.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
        }
        return try JSONValue.parse(data)
    }
}
