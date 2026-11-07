import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A chat message in provider-neutral form.
public struct ChatMessage: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable { case system, user, assistant, tool }
    public var role: Role
    public var content: String
    /// Tool calls requested by the assistant (role == .assistant).
    public var toolCalls: [ToolCall] = []
    /// For role == .tool: the call this message answers.
    public var toolCallID: String?
    /// Anthropic: the assistant's content blocks exactly as returned (thinking blocks with signatures, text,
    /// tool_use). Sent back unchanged inside a tool loop — the API needs thinking blocks replayed as-is.
    public var rawContent: JSONValue?

    public init(role: Role, content: String, toolCalls: [ToolCall] = [], toolCallID: String? = nil) {
        self.role = role; self.content = content; self.toolCalls = toolCalls; self.toolCallID = toolCallID
    }
    public static func system(_ s: String) -> ChatMessage { .init(role: .system, content: s) }
    public static func user(_ s: String) -> ChatMessage { .init(role: .user, content: s) }
    public static func assistant(_ s: String) -> ChatMessage { .init(role: .assistant, content: s) }
}

public struct ToolCall: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// JSON-encoded arguments object.
    public var arguments: JSONValue
    public init(id: String, name: String, arguments: JSONValue) { self.id = id; self.name = name; self.arguments = arguments }
}

/// Tool description shared by the agent runtime and the MCP server.
public struct ToolSpec: Codable, Sendable, Equatable {
    public var name: String
    public var description: String
    /// JSON Schema for the arguments object.
    public var inputSchema: JSONValue
    public init(name: String, description: String, inputSchema: JSONValue) {
        self.name = name; self.description = description; self.inputSchema = inputSchema
    }
}

public struct Usage: Codable, Sendable, Equatable {
    public var inputTokens: Int
    public var outputTokens: Int
    public init(inputTokens: Int = 0, outputTokens: Int = 0) { self.inputTokens = inputTokens; self.outputTokens = outputTokens }
    public var total: Int { inputTokens + outputTokens }
    public static func + (a: Usage, b: Usage) -> Usage { Usage(inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens) }
}

public struct AIResponse: Sendable, Equatable {
    public var message: ChatMessage
    public var usage: Usage
    public var stopReason: String?
    /// Readable thinking summary (Anthropic `display: "summarized"`), empty when the model didn't think.
    public var thinking: String = ""
    public init(message: ChatMessage, usage: Usage = Usage(), stopReason: String? = nil, thinking: String = "") {
        self.message = message; self.usage = usage; self.stopReason = stopReason; self.thinking = thinking
    }
}

public enum AIError: Error, CustomStringConvertible, Sendable {
    case missingKey(String), http(Int, String), badResponse(String), unavailable(String)
    public var description: String {
        switch self {
        case .missingKey(let p): return "No API key configured for \(p)."
        case .http(let code, let body): return "HTTP \(code): \(body.prefix(400))"
        case .badResponse(let m): return "Unexpected response: \(m)"
        case .unavailable(let m): return m
        }
    }
}

/// A model provider. Implementations: Anthropic, OpenAI-compatible, Apple Intelligence (on device).
public protocol AIProvider: Sendable {
    var id: String { get }
    var displayName: String { get }
    var models: [String] { get }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse
}

public extension AIProvider {
    /// The on-device model (Apple Intelligence): no tools, small context window.
    var isOnDevice: Bool { id == "apple" }
}

/// Known providers keyed by id; the app and server register the ones with keys.
public final class ModelRegistry: @unchecked Sendable {
    private var providers: [String: AIProvider] = [:]
    private let lock = NSLock()
    public init() {}

    public func register(_ p: AIProvider) { lock.lock(); providers[p.id] = p; lock.unlock() }
    public func provider(_ id: String) -> AIProvider? { lock.lock(); defer { lock.unlock() }; return providers[id] }
    public var all: [AIProvider] { lock.lock(); defer { lock.unlock() }; return providers.values.sorted { $0.id < $1.id } }

    /// Providers ordered for chat: cloud / server models first, the small on-device model last
    /// (it has no tool calling and a ~4k token window, so it is only a fallback).
    public var byChatPreference: [AIProvider] { all.sorted { ($0.isOnDevice ? 1 : 0, $0.id) < ($1.isOnDevice ? 1 : 0, $1.id) } }

    /// At least one provider that can call tools (anything but the on-device model).
    public var hasToolCapableProvider: Bool { all.contains { !$0.isOnDevice } }

    /// "anthropic/claude-opus-5-5" → provider + model. A bare model name is looked up across providers.
    public func resolve(_ ref: String) -> (AIProvider, String)? {
        if let slash = ref.firstIndex(of: "/") {
            let pid = String(ref[..<slash]), model = String(ref[ref.index(after: slash)...])
            return provider(pid).map { ($0, model) }
        }
        for p in all where p.models.contains(ref) { return (p, ref) }
        return byChatPreference.first.map { ($0, ref.isEmpty ? ($0.models.first ?? "") : ref) }
    }
}

// MARK: - HTTP helper

enum HTTP {
    static func post(_ url: URL, headers: [String: String], body: JSONValue) async throws -> (Int, Data) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = try body.encoded()
        req.timeoutInterval = 180
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    static func get(_ url: URL, headers: [String: String]) async throws -> (Int, Data) {
        var req = URLRequest(url: url)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.timeoutInterval = 60
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}
