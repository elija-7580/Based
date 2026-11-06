import Foundation

/// OpenAI Chat Completions (also works for OpenAI-compatible servers such as Ollama, LM Studio, OpenRouter).
public struct OpenAIProvider: AIProvider {
    public let id: String
    public let displayName: String
    public let apiKey: String
    public let baseURL: URL
    public let models: [String]

    public init(id: String = "openai", displayName: String = "ChatGPT (OpenAI)", apiKey: String,
                baseURL: URL = URL(string: "https://api.openai.com/v1")!,
                models: [String] = ["gpt-4.1", "gpt-4.1-mini", "o4-mini"]) {
        self.id = id; self.displayName = displayName; self.apiKey = apiKey; self.baseURL = baseURL; self.models = models
    }

    /// Local models through Ollama's OpenAI-compatible endpoint (no key needed).
    public static func ollama(baseURL: URL = URL(string: "http://127.0.0.1:11434/v1")!, models: [String] = ["llama3.1", "qwen2.5"]) -> OpenAIProvider {
        OpenAIProvider(id: "ollama", displayName: "Ollama (local)", apiKey: "ollama", baseURL: baseURL, models: models)
    }

    public func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        guard !apiKey.isEmpty else { throw AIError.missingKey(displayName) }
        var msgs: [JSONValue] = []
        for m in messages {
            switch m.role {
            case .system: msgs.append(["role": "system", "content": .string(m.content)])
            case .user: msgs.append(["role": "user", "content": .string(m.content)])
            case .assistant:
                var o: [String: JSONValue] = ["role": "assistant", "content": m.content.isEmpty ? .null : .string(m.content)]
                if !m.toolCalls.isEmpty {
                    o["tool_calls"] = .array(m.toolCalls.map { ["id": .string($0.id), "type": "function",
                                                                 "function": ["name": .string($0.name), "arguments": .string($0.arguments.text)]] })
                }
                msgs.append(.object(o))
            case .tool: msgs.append(["role": "tool", "tool_call_id": .string(m.toolCallID ?? ""), "content": .string(m.content)])
            }
        }
        var body: [String: JSONValue] = ["model": .string(model), "messages": .array(msgs), "max_completion_tokens": .number(Double(maxTokens))]
        if !tools.isEmpty {
            body["tools"] = .array(tools.map { ["type": "function", "function": ["name": .string($0.name), "description": .string($0.description), "parameters": $0.inputSchema]] })
        }
        let (code, data) = try await HTTP.post(baseURL.appendingPathComponent("chat/completions"),
                                               headers: ["Authorization": "Bearer \(apiKey)"], body: .object(body))
        guard (200..<300).contains(code) else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
        let json = try JSONValue.parse(data)
        guard let choice = json["choices"]?[0], let msg = choice["message"] else { throw AIError.badResponse(json.text) }
        let calls: [ToolCall] = (msg["tool_calls"]?.array ?? []).map { c in
            let args = (try? JSONValue.parse(c["function"]?["arguments"]?.string ?? "{}")) ?? .object([:])
            return ToolCall(id: c["id"]?.string ?? UUID().uuidString, name: c["function"]?["name"]?.string ?? "", arguments: args)
        }
        let usage = Usage(inputTokens: json["usage"]?["prompt_tokens"]?.int ?? 0, outputTokens: json["usage"]?["completion_tokens"]?.int ?? 0)
        return AIResponse(message: ChatMessage(role: .assistant, content: msg["content"]?.string ?? "", toolCalls: calls),
                          usage: usage, stopReason: choice["finish_reason"]?.string)
    }
}
