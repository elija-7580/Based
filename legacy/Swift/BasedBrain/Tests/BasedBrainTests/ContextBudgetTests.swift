import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-47: context window management (summaries instead of "prompt too long") and the step limit.
@Suite struct ContextBudgetTests {
    private func long(_ c: Character, _ n: Int) -> String { String(repeating: c, count: n) }

    @Test func estimateAndWindows() {
        #expect(ContextBudget.tokens("1234567") == 2)
        #expect(ContextBudget.tokens(.user(long("x", 350))) == 104)
        var a = ChatMessage.assistant("")
        a.rawContent = [["type": "image"], ["type": "thinking", "thinking": .string(long("t", 35))]]
        #expect(ContextBudget.tokens(a) == 4 + ContextBudget.imageTokens + 10)
        #expect(ContextBudget.window(for: "claude-opus-5-5") == 200_000)
        #expect(ContextBudget.window(for: "anthropic/claude-haiku-4-5") == 200_000)
        #expect(ContextBudget.window(for: "gpt-4.1") == 1_000_000)
        #expect(ContextBudget.window(for: "apple/on-device") == 4_096)
        #expect(ContextBudget.window(for: "llama3.2") == 32_000)
        #expect(ContextBudget(window: 1000).limit == 750)
    }

    @Test func belowThresholdNothingChanges() async {
        let m: [ChatMessage] = [.system("sys"), .user("hi"), .assistant("hello"), .user("more")]
        let (out, r) = await ContextBudget(window: 10_000).fit(m, summarizer: nil)
        #expect(out == m && !r.changed && r.userNotice == nil)
    }

    @Test func oldToolResultsAreShortenedFirst() async {
        var m: [ChatMessage] = [.system("sys"), .user("q1"), ChatMessage(role: .tool, content: long("a", 6000), toolCallID: "o"), .user("q2")]
        for i in 0..<6 { m.append(ChatMessage(role: .tool, content: long("b", 1500), toolCallID: "t\(i)")) }
        let (out, r) = await ContextBudget(window: 4_000).fit(m, summarizer: nil)
        #expect(r.shortenedToolResults == 3, "the old turn's result and the 2 oldest of the current turn")
        #expect(out[2].content.hasSuffix("[… shortened to fit the context window]"))
        #expect(out.suffix(4).allSatisfy { $0.content == long("b", 1500) }, "the last 4 results stay whole")
        #expect(r.summarizedMessages == 0 && r.after <= 3_000)
        #expect(r.userNotice == "Long tool results and messages were shortened to fit the context window.")
    }

    @Test func olderTurnsBecomeASummaryKeepingSystemAndLastSixTurns() async {
        var m: [ChatMessage] = [.system("sys")]
        for i in 0..<10 { m += [.user("q\(i) " + long("u", 1400)), .assistant("a\(i) " + long("v", 1400))] }
        let seen = Locked<String>("")
        let (out, r) = await ContextBudget(window: 8_000).fit(m, summarizer: { text in
            seen.sync { $0 = text }
            return "User asked q0–q3."
        })
        #expect(r.summarizedMessages == 8 && r.summary == "User asked q0–q3.")
        #expect(out.first?.role == .system && out[0].content.hasPrefix("sys"))
        #expect(out[0].content.hasSuffix("# Earlier in this conversation (summary)\nUser asked q0–q3."))
        #expect(out.count == 13 && out[1].content.hasPrefix("q4 ") && out.last?.content.hasPrefix("a9 ") == true)
        #expect(seen.current.hasPrefix("user: q0 ") && seen.current.contains("assistant: a3 ") && !seen.current.contains("q4 "))
        #expect(r.userNotice == "Older messages were summarized to fit the context window.")
    }

    @Test func failingSummarizerDropsWithANote() async {
        var m: [ChatMessage] = [.system("sys")]
        for i in 0..<8 { m += [.user("q\(i) " + long("u", 2000)), .assistant("a\(i)")] }
        struct Boom: Error {}
        let (out, r) = await ContextBudget(window: 4_000).fit(m, summarizer: { _ in throw Boom() })
        #expect(r.droppedMessages == 4 && r.summarizedMessages == 0)
        #expect(out[0].content.contains("(4 older messages were left out to fit the context window.)"))
        #expect(out[1].content.hasPrefix("q2 "))
    }

    @Test func hugePastedTextsAreShortenedButNotTheNewestQuestion() async {
        let m: [ChatMessage] = [.system("sys"), .user(long("p", 40_000)), .assistant("ok"), .user("question " + long("q", 3000))]
        let (out, r) = await ContextBudget(window: 8_000).fit(m, summarizer: nil)
        #expect(r.shortenedMessages == 1)
        #expect(out[1].content.contains("[… shortened to fit the context window …]") && out[1].content.count < 20_000)
        #expect(out[3] == m[3], "the newest user message is never cut")
        #expect(r.after <= 6_000)
    }

    @Test func overflowErrorsAreRecognized() {
        #expect(ContextBudget.isContextOverflow(AIError.http(400, #"{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}"#)))
        #expect(ContextBudget.isContextOverflow(AIError.http(400, "context_length_exceeded")))
        #expect(!ContextBudget.isContextOverflow(AIError.http(400, "invalid model")))
        #expect(!ContextBudget.isContextOverflow(AIError.http(529, "overloaded")))
    }
}

/// Scripted provider: summaries are answered separately; `overflowOnce` fails the first call with "prompt too long";
/// `alwaysTool` keeps calling a tool.
private final class BudgetProvider: AIProvider, @unchecked Sendable {
    let id = "bp", displayName = "BP", models = ["claude-x", "claude-haiku-x"]
    let calls = Locked<[(model: String, messages: [ChatMessage])]>([])
    let overflowOnce: Bool
    let alwaysTool: Bool
    init(overflowOnce: Bool = false, alwaysTool: Bool = false) { self.overflowOnce = overflowOnce; self.alwaysTool = alwaysTool }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let n = calls.sync { $0.append((model, messages)); return $0.count }
        if messages.first?.content.hasPrefix("Summarize this earlier part") == true { return AIResponse(message: .assistant("SUMMARY")) }
        if overflowOnce && n == 1 { throw AIError.http(400, "prompt is too long: 999999 tokens") }
        if alwaysTool {
            var m = ChatMessage.assistant("")
            m.toolCalls = [ToolCall(id: "c\(n)", name: "no_such_tool", arguments: [:])]
            return AIResponse(message: m)
        }
        return AIResponse(message: .assistant("answer"))
    }
}

@MainActor
struct RuntimeBudgetTests {
    private func runtime(_ p: BudgetProvider) -> AgentRuntime {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let registry = ModelRegistry()
        registry.register(p)
        return AgentRuntime(registry: registry, tools: AgentTools(store: store, brain: brain))
    }

    @Test func longHistoryIsSummarizedWithTheCheapModel() async throws {
        let p = BudgetProvider()
        let rt = runtime(p)
        rt.contextWindow = 30_000
        var history: [ChatMessage] = []
        for i in 0..<12 { history += [.user("q\(i) " + String(repeating: "x", count: 8000)), .assistant("a\(i)")] }
        let log = Locked<[ChatEvent]>([])
        let o = try await rt.run(prompt: "next", modelRef: "bp/claude-x", history: history, events: { e in log.sync { $0.append(e) } })
        #expect(o.text == "answer")
        let summaryCall = p.calls.current.first { $0.messages.first?.content.hasPrefix("Summarize") == true }
        #expect(summaryCall?.model == "claude-haiku-x")
        let sent = p.calls.current.last!.messages
        #expect(sent[0].content.contains("# Earlier in this conversation (summary)\nSUMMARY"))
        #expect(sent.filter { $0.role == .user }.count == 6, "5 kept history turns + the new question")
        #expect(log.current.contains(.notice("Older messages were summarized to fit the context window.")))
    }

    @Test func promptTooLongIsCompactedAndRetriedOnce() async throws {
        let p = BudgetProvider(overflowOnce: true)
        let rt = runtime(p)
        rt.contextWindow = 20_000
        var history: [ChatMessage] = []
        for i in 0..<10 { history += [.user("q\(i) " + String(repeating: "x", count: 3000)), .assistant("a\(i)")] }
        let o = try await rt.run(prompt: "next", modelRef: "bp/claude-x", history: history)
        #expect(o.text == "answer")
        let main = p.calls.current.filter { $0.messages.first?.content.hasPrefix("Summarize") != true }
        #expect(main.count == 2)
        #expect(main[1].messages.count < main[0].messages.count)
    }

    @Test func stepLimitEndsWithANotice() async throws {
        let p = BudgetProvider(alwaysTool: true)
        let rt = runtime(p)
        rt.maxSteps = 3
        let log = Locked<[ChatEvent]>([])
        let o = try await rt.run(prompt: "loop", modelRef: "bp/claude-x", events: { e in log.sync { $0.append(e) } })
        #expect(o.hitStepLimit && o.steps == 3)
        #expect(log.current.last == .notice("Stopped after 3 steps (step limit). Reply “continue” to keep going."))
    }
}
