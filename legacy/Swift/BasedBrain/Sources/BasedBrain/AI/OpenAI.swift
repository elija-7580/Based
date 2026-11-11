import Foundation

/// OpenAI Chat Completions (also works for OpenAI-compatible servers such as Ollama, LM Studio, OpenRouter).
public struct OpenAIProvider: AIProvider {
    public let id: String
    public let displayName: String
    public let apiKey: String
    public let baseURL: URL
    public let models: [String]
    /// Which field carries the answer limit (BSD-46): OpenAI wants `max_completion_tokens`, older compatible
    /// servers (Ollama, LM Studio, …) only know `max_tokens`.
    public var tokenField: TokenField
    public var retry: RetryPolicy = .standard
    public var transport: HTTPStreamTransport = URLSessionStreamTransport()

    public enum TokenField: String, Sendable, CaseIterable {
        /// `max_completion_tokens` on openai.com, `max_tokens` everywhere else.
        case auto
        case maxTokens = "max_tokens"
        case maxCompletionTokens = "max_completion_tokens"
    }

    public init(id: String = "openai", displayName: String = "ChatGPT (OpenAI)", apiKey: String,
                baseURL: URL = URL(string: "https://api.openai.com/v1")!,
                models: [String] = ["gpt-4.1", "gpt-4.1-mini", "o4-mini"], tokenField: TokenField = .auto) {
        self.id = id; self.displayName = displayName; self.apiKey = apiKey; self.baseURL = baseURL; self.models = models
        self.tokenField = tokenField
    }

    /// The field name actually sent.
    public var resolvedTokenField: String {
        switch tokenField {
        case .auto: return (baseURL.host ?? "").hasSuffix("openai.com") ? TokenField.maxCompletionTokens.rawValue : TokenField.maxTokens.rawValue
        default: return tokenField.rawValue
        }
    }

    /// Local models through Ollama's OpenAI-compatible endpoint (no key needed).
    public static func ollama(baseURL: URL = URL(string: "http://127.0.0.1:11434/v1")!, models: [String] = ["llama3.1", "qwen2.5"]) -> OpenAIProvider {
        OpenAIProvider(id: "ollama", displayName: "Ollama (local)", apiKey: "ollama", baseURL: baseURL, models: models)
    }

    public func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let body = try requestBody(messages, model: model, tools: tools, maxTokens: maxTokens)
        let (code, data) = try await retry.run {
            let (code, data) = try await HTTP.post(baseURL.appendingPathComponent("chat/completions"),
                                                   headers: ["Authorization": "Bearer \(apiKey)"], body: body)
            guard (200..<300).contains(code) else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
            return (code, data)
        }
        _ = code
        let json = try JSONValue.parse(data)
        guard let choice = json["choices"]?[0], let msg = choice["message"] else { throw AIError.badResponse(json.text) }
        let calls: [ToolCall] = (msg["tool_calls"]?.array ?? []).map { c in
            let args = (try? JSONValue.parse(c["function"]?["arguments"]?.string ?? "{}")) ?? .object([:])
            return ToolCall(id: c["id"]?.string ?? UUID().uuidString, name: c["function"]?["name"]?.string ?? "", arguments: args)
        }
        let usage = Usage(inputTokens: json["usage"]?["prompt_tokens"]?.int ?? 0, outputTokens: json["usage"]?["completion_tokens"]?.int ?? 0)
        return AIResponse(message: ChatMessage(role: .assistant, content: msg["content"]?.string ?? "", toolCalls: calls),
                          usage: usage, stopReason: choice["finish_reason"]?.string,
                          thinking: msg["reasoning_content"]?.string ?? "")
    }

    /// Streamed Chat Completions: `delta.content` (and `reasoning_content` of compatible reasoning models) as
    /// deltas; tool calls are assembled from their fragments.
    public func stream(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int,
                       onEvent: @escaping @Sendable (ChatEvent) -> Void) async throws -> AIResponse {
        guard case .object(var body) = try requestBody(messages, model: model, tools: tools, maxTokens: maxTokens) else { throw AIError.badResponse("body") }
        body["stream"] = true
        if resolvedTokenField == TokenField.maxCompletionTokens.rawValue { body["stream_options"] = ["include_usage": true] }
        let req = try HTTP.streamRequest(baseURL.appendingPathComponent("chat/completions"),
                                         headers: ["Authorization": "Bearer \(apiKey)"], body: .object(body))
        let acc = try await HTTP.streamSSE(req, transport: transport, policy: retry, makeState: { OpenAIStream() }) { acc, e in
            try acc.apply(e, onEvent: onEvent)
        }
        return acc.response()
    }

    func requestBody(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) throws -> JSONValue {
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
        var body: [String: JSONValue] = ["model": .string(model), "messages": .array(msgs), resolvedTokenField: .number(Double(maxTokens))]
        if !tools.isEmpty {
            body["tools"] = .array(tools.map { ["type": "function", "function": ["name": .string($0.name), "description": .string($0.description), "parameters": $0.inputSchema]] })
        }
        return .object(body)
    }
}

/// Folds a Chat Completions stream into the response `complete` returns.
struct OpenAIStream {
    private var text = ""
    private var reasoning = ""
    private var calls: [Int: (id: String, name: String, args: String)] = [:]
    private var finish: String?
    private var usage = Usage()

    mutating func apply(_ e: SSEEvent, onEvent: (ChatEvent) -> Void) throws -> Bool {
        let d = e.data.trimmingCharacters(in: .whitespaces)
        guard d != "[DONE]", let v = try? JSONValue.parse(d) else { return false }
        if let err = v["error"], !err.isNull {
            throw HTTPFailure(status: err["code"]?.int ?? 500, body: err["message"]?.string ?? err.text, retryAfter: nil)
        }
        if let u = v["usage"], !u.isNull {
            usage = Usage(inputTokens: u["prompt_tokens"]?.int ?? 0, outputTokens: u["completion_tokens"]?.int ?? 0)
        }
        guard let choice = v["choices"]?[0] else { return false }
        if let f = choice["finish_reason"]?.string { finish = f }
        guard let delta = choice["delta"] else { return false }
        var shown = false
        if let r = delta["reasoning_content"]?.string ?? delta["reasoning"]?.string, !r.isEmpty {
            reasoning += r; onEvent(.thinkingDelta(r)); shown = true
        }
        if let t = delta["content"]?.string, !t.isEmpty {
            text += t; onEvent(.textDelta(t)); shown = true
        }
        for c in delta["tool_calls"]?.array ?? [] {
            let i = c["index"]?.int ?? 0
            var cur = calls[i] ?? (id: "", name: "", args: "")
            if let id = c["id"]?.string, !id.isEmpty { cur.id = id }
            if let n = c["function"]?["name"]?.string, !n.isEmpty { cur.name += n }
            cur.args += c["function"]?["arguments"]?.string ?? ""
            calls[i] = cur
        }
        return shown
    }

    func response() -> AIResponse {
        let toolCalls = calls.keys.sorted().compactMap { i -> ToolCall? in
            guard let c = calls[i] else { return nil }
            let args = (try? JSONValue.parse(c.args.isEmpty ? "{}" : c.args)) ?? .object([:])
            return ToolCall(id: c.id.isEmpty ? UUID().uuidString : c.id, name: c.name, arguments: args)
        }
        return AIResponse(message: ChatMessage(role: .assistant, content: text, toolCalls: toolCalls), usage: usage,
                          stopReason: finish, thinking: reasoning)
    }
}
