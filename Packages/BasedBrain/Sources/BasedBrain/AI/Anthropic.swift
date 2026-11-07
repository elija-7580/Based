import Foundation

/// Anthropic Messages API (API key). Not streamed; tool use in a loop (AgentRuntime).
///
/// Current models think adaptively; Based asks for readable summaries (`display: "summarized"`) so the chat
/// can show "Thinking…", and replays the assistant's blocks unchanged within a tool loop. Refusals from the
/// safety classifiers are retried server-side on a suitable model (`fallbacks: "default"`).
public struct AnthropicProvider: AIProvider {
    public let id = "anthropic"
    public let displayName = "Claude (Anthropic)"
    public let apiKey: String
    public let baseURL: URL
    public let models: [String]
    /// low · medium · high · xhigh · max (nil = the model's default).
    public var effort: String?

    public static let defaultModels = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]

    public init(apiKey: String, baseURL: URL = URL(string: "https://api.anthropic.com")!,
                models: [String] = AnthropicProvider.defaultModels, effort: String? = nil) {
        self.apiKey = apiKey; self.baseURL = baseURL; self.models = models; self.effort = effort
    }

    /// Server-side fallback on refusals is offered for these models (Claude API).
    static func supportsFallbacks(_ model: String) -> Bool {
        ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"].contains(model)
    }

    /// Models before the 4.6 generation don't take adaptive thinking.
    static func supportsAdaptiveThinking(_ model: String) -> Bool {
        !(model.hasPrefix("claude-3") || model.contains("-4-5") || model.contains("-4-1") || model.contains("-4-0")
          || model == "claude-opus-4" || model == "claude-sonnet-4")
    }

    /// Retired ids saved in settings or agent pages keep working on the current model of their line.
    static func current(_ model: String) -> String {
        switch model {
        case "claude-opus-4-1", "claude-opus-4-1-20250805": return "claude-opus-5-5"
        default: return model
        }
    }

    public func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        guard !apiKey.isEmpty else { throw AIError.missingKey(displayName) }
        let model = Self.current(model)
        var body: [String: JSONValue] = ["model": .string(model), "max_tokens": .number(Double(maxTokens))]
        let system = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n\n")
        if !system.isEmpty { body["system"] = .string(system) }
        var out: [JSONValue] = []
        for m in messages where m.role != .system {
            switch m.role {
            case .user: out.append(["role": "user", "content": .string(m.content)])
            case .assistant:
                if let raw = m.rawContent { out.append(["role": "assistant", "content": raw]); continue }
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
        var headers = ["x-api-key": apiKey, "anthropic-version": "2023-06-01"]
        if Self.supportsAdaptiveThinking(model) {
            body["thinking"] = ["type": "adaptive", "display": "summarized"]
            // Thinking shares max_tokens with the answer: leave room for both.
            body["max_tokens"] = .number(Double(max(maxTokens, 16_000)))
            if let effort, !effort.isEmpty { body["output_config"] = ["effort": .string(effort)] }
        }
        if Self.supportsFallbacks(model) {
            headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
            body["fallbacks"] = "default"
        }
        let (code, data) = try await HTTP.post(baseURL.appendingPathComponent("v1/messages"), headers: headers, body: .object(body))
        guard (200..<300).contains(code) else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
        return try Self.parse(data)
    }

    /// Message response → text, tool calls, thinking summary, raw blocks (for replay) and usage.
    static func parse(_ data: Data) throws -> AIResponse {
        let json = try JSONValue.parse(data)
        var text = "", thinking = "", calls: [ToolCall] = []
        let content = json["content"]?.array ?? []
        for part in content {
            switch part["type"]?.string {
            case "text": text += part["text"]?.string ?? ""
            case "thinking":
                if let t = part["thinking"]?.string, !t.isEmpty { thinking += (thinking.isEmpty ? "" : "\n\n") + t }
            case "tool_use": calls.append(ToolCall(id: part["id"]?.string ?? UUID().uuidString, name: part["name"]?.string ?? "", arguments: part["input"] ?? .object([:])))
            default: break
            }
        }
        let stop = json["stop_reason"]?.string
        if stop == "refusal" {
            let why = json["stop_details"]?["explanation"]?.string ?? json["stop_details"]?["category"]?.string
            text = text.isEmpty ? "Claude declined this request" + (why.map { " (\($0))" } ?? "") + "." : text
        }
        let usage = Usage(inputTokens: json["usage"]?["input_tokens"]?.int ?? 0, outputTokens: json["usage"]?["output_tokens"]?.int ?? 0)
        var msg = ChatMessage(role: .assistant, content: text, toolCalls: calls)
        msg.rawContent = .array(content)
        return AIResponse(message: msg, usage: usage, stopReason: stop, thinking: thinking)
    }
}
