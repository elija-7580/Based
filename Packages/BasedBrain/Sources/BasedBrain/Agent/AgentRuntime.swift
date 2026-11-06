import Foundation
import BasedCore

/// Runs a model with the workspace tools until it stops calling tools.
public final class AgentRuntime: @unchecked Sendable {
    public let registry: ModelRegistry
    public let tools: AgentTools
    public var maxSteps = 24
    public var maxTokensPerReply = 4096
    /// Called after each step with a short progress line (for UI).
    public var onProgress: (@Sendable (String) -> Void)?

    public init(registry: ModelRegistry, tools: AgentTools) { self.registry = registry; self.tools = tools }

    public struct Outcome: Sendable {
        public var text: String
        public var usage: Usage
        public var steps: Int
        public var transcript: [ChatMessage]
    }

    /// `modelRef` like "anthropic/claude-sonnet-4-5"; nil → first registered provider's first model.
    public func run(prompt: String, modelRef: String?, systemExtra: String? = nil, history: [ChatMessage] = []) async throws -> Outcome {
        guard let (provider, model) = registry.resolve(modelRef ?? "") else { throw AIError.unavailable("No AI provider configured. Add an API key in Settings → AI.") }
        let context = await MainActor.run { tools.brain.systemContext(query: prompt) }
        let specs = await MainActor.run { tools.specs }
        var system = """
        You are Based, the user's personal workspace assistant. You work inside their notes (pages and databases) \
        using tools. Prefer reading existing content before creating new pages. Keep answers concise. \
        Save durable facts about the user with memory_save. Today is \(ISO8601DateFormatter().string(from: Date())).

        \(context)
        """
        if let systemExtra { system += "\n\n# Agent instructions\n" + systemExtra }
        var messages: [ChatMessage] = [.system(system)] + history + [.user(prompt)]
        var usage = Usage(), steps = 0
        while steps < maxSteps {
            steps += 1
            let r = try await provider.complete(messages, model: model, tools: specs, maxTokens: maxTokensPerReply)
            usage = usage + r.usage
            messages.append(r.message)
            if r.message.toolCalls.isEmpty { return Outcome(text: r.message.content, usage: usage, steps: steps, transcript: messages) }
            for call in r.message.toolCalls {
                onProgress?("\(call.name) \(call.arguments.text.prefix(80))")
                let res = await MainActor.run { tools.call(call.name, call.arguments) }
                messages.append(ChatMessage(role: .tool, content: String(res.text.prefix(24_000)), toolCallID: call.id))
            }
        }
        return Outcome(text: messages.last(where: { $0.role == .assistant })?.content ?? "", usage: usage, steps: steps, transcript: messages)
    }

    /// Run a stored agent (instructions page) once, logging the run to its page.
    @discardableResult
    public func run(agent: Agent, trigger: String = "manual") async -> Outcome? {
        let brain = tools.brain
        do {
            let o = try await run(prompt: "Trigger: \(trigger). Carry out your instructions now and report briefly what you did.",
                                  modelRef: agent.model, systemExtra: agent.instructions)
            await MainActor.run { brain.markRun(agent.id); brain.logRun(agent.id, summary: o.text, usage: o.usage) }
            return o
        } catch {
            await MainActor.run { brain.markRun(agent.id); brain.logRun(agent.id, summary: "", usage: Usage(), error: "\(error)") }
            return nil
        }
    }
}
