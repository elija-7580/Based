import Foundation

/// Anthropic Messages API (API key). Streaming is not used; tool use is.
public struct AnthropicProvider: AIProvider {
    public let id = "anthropic"
    public let displayName = "Claude (Anthropic)"
    public let apiKey: String
    public let baseURL: URL
    public let models: [String]

    public init(apiKey: String, baseURL: URL = URL(string: "https://api.anthropic.com")!,
                models: [String] = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]) {
        self.apiKey = apiKey; self.baseURL = baseURL; self.models = models
    }

    public func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        guard !apiKey.isEmpty else { throw AIError.missingKey(displayName) }
        var body: [String: JSONValue] = ["model": .string(model), "max_tokens": .number(Double(maxTokens))]
        let system = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n\n")
        if !system.isEmpty { body["system"] = .string(system) }
        var out: [JSONValue] = []
        for m in messages where m.role != .system {
            switch m.role {
            case .user: out.append(["role": "user", "content": .string(m.content)])
            case .assistant:
                var parts: [JSONValue] = []
                if !m.content.isEmpty { parts.append(["type": "text", "text": .string(m.content)]) }
                for c in m.toolCalls { parts.append(["type": "tool_use", "id": .string(c.id), "name": .string(c.name), "input": c.arguments]) }
                out.append(["role": "assistant", "content": .array(parts)])
            case .tool:
                let part: JSONValue = ["type": "tool_result", "tool_use_id": .string(m.toolCallID ?? ""), "content": .string(m.content)]
                // Merge consecutive tool results into one user turn (API requirement).
                if case .object(var last)? = out.last, last["role"] == "user", case .array(var arr)? = last["content"],
                   arr.first?["type"] == "tool_result" {
                    arr.append(part); last["content"] = .array(arr); out[out.count - 1] = .object(last)
                } else {
                    out.append(["role": "user", "content": .array([part])])
                }
            case .system: break
            }
        }
        body["messages"] = .array(out)
        if !tools.isEmpty {
            body["tools"] = .array(tools.map { ["name": .string($0.name), "description": .string($0.description), "input_schema": $0.inputSchema] })
        }
        let (code, data) = try await HTTP.post(baseURL.appendingPathComponent("v1/messages"),
                                               headers: ["x-api-key": apiKey, "anthropic-version": "2023-06-01"], body: .object(body))
        guard (200..<300).contains(code) else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
        let json = try JSONValue.parse(data)
        var text = "", calls: [ToolCall] = []
        for part in json["content"]?.array ?? [] {
            switch part["type"]?.string {
            case "text": text += part["text"]?.string ?? ""
            case "tool_use": calls.append(ToolCall(id: part["id"]?.string ?? UUID().uuidString, name: part["name"]?.string ?? "", arguments: part["input"] ?? .object([:])))
            default: break
            }
        }
        let usage = Usage(inputTokens: json["usage"]?["input_tokens"]?.int ?? 0, outputTokens: json["usage"]?["output_tokens"]?.int ?? 0)
        return AIResponse(message: ChatMessage(role: .assistant, content: text, toolCalls: calls), usage: usage, stopReason: json["stop_reason"]?.string)
    }
}
