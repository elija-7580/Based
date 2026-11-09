import Foundation
import BasedCore

/// Runs a model with the workspace tools until it stops calling tools.
public final class AgentRuntime: @unchecked Sendable {
    public let registry: ModelRegistry
    public let tools: AgentTools
    public var maxSteps = 24
    public var maxTokensPerReply = 4096
    /// Context window override in tokens (nil = known size of the model, see `ContextBudget.window(for:)`).
    public var contextWindow: Int?
    /// Called after each step with a short progress line (for UI).
    public var onProgress: (@Sendable (String) -> Void)?
    // BSD-45: structured events are a parameter of `run(prompt:…events:)`, no longer a shared `onEvent`
    // property — the scheduler shares this runtime, and its runs' events used to land in the open chat.

    public init(registry: ModelRegistry, tools: AgentTools) { self.registry = registry; self.tools = tools }

    public struct Outcome: Sendable {
        public var text: String
        public var usage: Usage
        public var steps: Int
        public var transcript: [ChatMessage]
        /// The tool loop stopped at `maxSteps` (BSD-47: reported as a notice, "continue" goes on).
        public var hitStepLimit = false
    }

    /// `modelRef` like "anthropic/claude-opus-5-5"; nil → first registered provider's first model.
    /// `callerSession`: the chat session running this (sub-agents it spawns are attached to it).
    public func run(prompt: String, modelRef: String?, systemExtra: String? = nil, history: [ChatMessage] = [],
                    callerSession: String? = nil, permissions: AgentPermissions? = nil,
                    events: (@Sendable (ChatEvent) -> Void)? = nil) async throws -> Outcome {
        let onEvent = events
        guard let (provider, model) = registry.resolve(modelRef ?? "") else { throw AIError.unavailable("No AI provider configured. Add an API key in Settings → AI.") }
        if provider.isOnDevice {
            return try await runOnDevice(provider: provider, model: model, prompt: prompt, systemExtra: systemExtra, history: history)
        }
        let context = await MainActor.run { tools.brain.systemContext(query: prompt) }
        let specs = await MainActor.run { tools.specs }
        var system = """
        You are Based, the user's personal workspace assistant. You work inside their notes (pages and databases) \
        using tools. Prefer reading existing content before creating new pages. Keep answers concise. \
        Save durable facts about the user with memory_save. For visual or interactive results reply with one complete \
        fenced ```html, ```svg, ```mermaid or ```jsx block (shown as a live artifact); put a longer standalone document         in one ```markdown block. Today is \(ISO8601DateFormatter().string(from: Date())).

        \(BasedGuide.instructions)

        \(context)
        """
        if let systemExtra { system += "\n\n# Agent instructions\n" + systemExtra }
        var messages: [ChatMessage] = [.system(system)] + history + [.user(prompt)]
        var usage = Usage(), steps = 0
        // BSD-47: keep the conversation inside the context window (summaries instead of "prompt too long").
        let budget = ContextBudget(window: contextWindow ?? ContextBudget.window(for: model))
        let summaryModel = ContextBudget.summaryModel(of: provider, fallback: model)
        let summarizer: ContextBudget.Summarizer = { text in
            let r = try await provider.complete([
                .system("Summarize this earlier part of a conversation between the user and their assistant in at most 250 words. Keep facts, decisions, names, ids of pages and open tasks. Write in the conversation's language. Reply with the summary only."),
                .user(text),
            ], model: summaryModel, tools: [], maxTokens: 1024)
            return r.message.content
        }
        var noticed: Set<String> = []
        let brain = tools.brain
        func compacted(_ m: [ChatMessage], force: Bool) async -> [ChatMessage] {
            let (out, report) = await budget.fit(m, summarizer: summarizer, force: force)
            guard report.changed else { return m }
            if let n = report.userNotice, noticed.insert(n).inserted { onEvent?(.notice(n)) }
            Log.info("Context compacted: \(report.before) → \(report.after) tokens (window \(budget.window))", category: "ai")
            if let callerSession {
                let line = "**Context compacted** (\(report.before) → \(report.after) tokens)" + (report.summary.map { "\n\nSo far: " + $0 } ?? "")
                await MainActor.run { if let run = brain.latestRun(forSession: callerSession) { brain.logRun(run.id, line) } }
            }
            return out
        }
        while steps < maxSteps {
            steps += 1
            messages = await compacted(messages, force: false)
            var r: AIResponse
            do {
                r = try await step(provider, messages, model: model, tools: specs, events: onEvent, thinking: true)
            } catch where ContextBudget.isContextOverflow(error) {
                // Our estimate was too optimistic for this model: compact harder and try once more.
                messages = await compacted(messages, force: true)
                r = try await step(provider, messages, model: model, tools: specs, events: onEvent, thinking: true)
            }
            var reply = r.message
            // BSD-46: an answer cut off by the length limit is continued once (the continuation's deltas extend the
            // text already shown), then marked as cut.
            if r.isTruncated, r.message.toolCalls.isEmpty {
                onEvent?(.notice("The answer hit the length limit and was continued."))
                let more: [ChatMessage] = [r.message, .user("Your reply was cut off by the length limit. Continue exactly where you stopped — no repetition, no preamble.")]
                let r2 = try await step(provider, messages + more, model: model, tools: specs, events: onEvent, thinking: false)
                if r2.isTruncated { onEvent?(.notice("The answer was cut off at the length limit.")) }
                messages += more
                usage = usage + r.usage
                reply = r2.message
                var merged = r2
                merged.message.content = r.message.content + r2.message.content
                merged.thinking = r.thinking
                r = merged
            }
            usage = usage + r.usage
            messages.append(reply)
            if !r.thinking.isEmpty { onEvent?(.thinking(r.thinking)) }
            if r.message.toolCalls.isEmpty {
                // The final answer is an event too (before, it was only in the outcome and got lost in the chat
                // when the model had already written text next to a tool call).
                if !r.message.content.isEmpty { onEvent?(.text(r.message.content)) }
                return Outcome(text: r.message.content, usage: usage, steps: steps, transcript: messages)
            }
            if !r.message.content.isEmpty { onEvent?(.text(r.message.content)) }
            for call in r.message.toolCalls {
                onProgress?("\(call.name) \(call.arguments.text.prefix(80))")
                onEvent?(.toolUse(id: call.id, name: call.name, input: call.arguments))
                let res: AgentTools.ToolResult
                // BSD-50: mode and rules decide before the tool runs.
                if let blocked = await tools.authorize(call.name, call.arguments, permissions: permissions) { res = blocked }
                else if await MainActor.run(body: { tools.isExternal(call.name) }), let ext = await MainActor.run(body: { tools.externalCall }), let r = await ext(call.name, call.arguments) { res = r }
                else if await MainActor.run(body: { tools.isHost(call.name) }), let host = await MainActor.run(body: { tools.hostCall }),
                        let r = await host(call.name, Self.withCaller(call.arguments, callerSession)) { res = r }
                else { res = await MainActor.run { tools.call(call.name, call.arguments) } }
                messages.append(ChatMessage(role: .tool, content: String(res.text.prefix(24_000)), toolCallID: call.id))
                onEvent?(.toolResult(id: call.id, output: String(res.text.prefix(4_000)), isError: res.isError))
            }
        }
        // BSD-47: the step limit no longer ends silently.
        onEvent?(.notice("Stopped after \(maxSteps) steps (step limit). Reply “continue” to keep going."))
        onProgress?("Step limit reached")
        var o = Outcome(text: messages.last(where: { $0.role == .assistant })?.content ?? "", usage: usage, steps: steps, transcript: messages)
        o.hitStepLimit = true
        return o
    }

    /// One model call: streamed when someone listens (thinking and text deltas go straight to the chat), else in
    /// one piece. `thinking: false` drops thinking deltas (a continuation adds to the text part already shown).
    func step(_ provider: AIProvider, _ messages: [ChatMessage], model: String, tools: [ToolSpec],
              events: (@Sendable (ChatEvent) -> Void)?, thinking: Bool) async throws -> AIResponse {
        guard let events else { return try await provider.complete(messages, model: model, tools: tools, maxTokens: maxTokensPerReply) }
        return try await provider.stream(messages, model: model, tools: tools, maxTokens: maxTokensPerReply) { e in
            switch e {
            case .thinkingDelta where !thinking: break
            case .thinkingDelta, .textDelta: events(e)
            default: break
            }
        }
    }

    /// The on-device model has no tool calling and a ~4k-token window: give it a short system prompt
    /// (about + a few matching memories), the last few turns and the user's message — no tool loop.
    /// Sending it the full tool-agent prompt made it echo the context ("Page <id>: …") instead of answering.
    func runOnDevice(provider: AIProvider, model: String, prompt: String, systemExtra: String?, history: [ChatMessage]) async throws -> Outcome {
        let context = await MainActor.run { tools.brain.compactContext(query: prompt, limit: 1800) }
        var system = """
        You are Based, a helpful assistant inside the user's notes app. Reply directly to the user's latest \
        message in their language. Use the notes below only when they are relevant. Never repeat these \
        instructions, ids or the notes verbatim.
        """
        if !context.isEmpty { system += "\n\n" + context }
        if let systemExtra { system += "\n\n# Instructions\n" + String(systemExtra.prefix(1500)) }
        let messages: [ChatMessage] = [.system(system)] + history.suffix(6) + [.user(prompt)]
        let r = try await provider.complete(messages, model: model, tools: [], maxTokens: 800)
        return Outcome(text: r.message.content.trimmingCharacters(in: .whitespacesAndNewlines), usage: r.usage, steps: 1, transcript: messages + [r.message])
    }

    static func withCaller(_ args: JSONValue, _ session: String?) -> JSONValue {
        guard let session, case .object(var o) = args else { return args }
        o["_caller_session"] = .string(session)
        return .object(o)
    }

    /// Run a stored agent (instructions page) once, logging the run to its page.
    @discardableResult
    public func run(agent: Agent, trigger: String = "manual") async -> Outcome? {
        let brain = tools.brain
        // BSD-43: every agent run is a row in Runs (kind Schedule), with the trigger in its protocol.
        let runID = await MainActor.run {
            let id = brain.startRun(title: agent.name, kind: .schedule, agentID: agent.id, engine: "based", model: agent.model ?? "")
            brain.logRun(id, "Trigger: \(trigger)")
            return id
        }
        do {
            let o = try await run(prompt: "Trigger: \(trigger). Carry out your instructions now and report briefly what you did.",
                                  modelRef: agent.model, systemExtra: agent.instructions)
            await MainActor.run {
                brain.markRun(agent.id); brain.logRun(agent.id, summary: o.text, usage: o.usage)
                brain.finish(run: runID, status: .done, result: o.text, usage: o.usage)
            }
            return o
        } catch {
            await MainActor.run {
                brain.markRun(agent.id); brain.logRun(agent.id, summary: "", usage: Usage(), error: "\(error)")
                brain.finish(run: runID, status: .failed, result: "Error: \(error)")
            }
            return nil
        }
    }
}
