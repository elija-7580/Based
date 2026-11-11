import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Fake engine: as the main agent it delegates once; as a sub-agent it answers with `subAnswer`.
private final class Part2Provider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake"
    let models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
    let delegateArgs: JSONValue
    let subAnswer: String
    private let log = Locked<[(model: String, role: String)]>([])
    var calls: [(model: String, role: String)] { log.current }
    init(delegateArgs: JSONValue, subAnswer: String = "Done.") { self.delegateArgs = delegateArgs; self.subAnswer = subAnswer }

    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let isMain = (messages.first?.content ?? "").contains("# Main agent")
        log.sync { $0.append((model, isMain ? "main" : "sub")) }
        if isMain {
            if let last = messages.last, last.role == .tool { return AIResponse(message: .assistant("Started: " + last.content)) }
            var m = ChatMessage.assistant("")
            m.toolCalls = [ToolCall(id: "d1", name: "delegate", arguments: delegateArgs)]
            return AIResponse(message: m)
        }
        return AIResponse(message: .assistant(subAnswer), usage: Usage(inputTokens: 10, outputTokens: 10))
    }
}

/// BSD-105: coding sub-agents through a launcher, budget in the chat, result pages, ⌘J target.
@MainActor
struct MainAgentPart2Tests {
    private func make(_ args: JSONValue, subAnswer: String = "Done.") -> (BrainStore, Part2Provider, MainAgent) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let reg = ModelRegistry(); let p = Part2Provider(delegateArgs: args, subAnswer: subAnswer); reg.register(p)
        let rt = AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))
        return (brain, p, MainAgent(runtime: rt))
    }

    private static let codeArgs: JSONValue = ["task": "Fix the sidebar bug", "kind": "code", "project": "Based"]

    /// Spends `euros` for the main agent this month (a finished run with that cost).
    private func spend(_ brain: BrainStore, _ euros: Double) {
        let main = brain.ensureMainAgent()
        let r = brain.startRun(title: "earlier", kind: .subagent, agentID: main.id)
        brain.finish(run: r, status: .done, result: "x", cost: euros)
    }

    @Test func codeJobGoesToTheLauncherWithParentRun() async {
        let (brain, provider, main) = make(Self.codeArgs)
        let project = brain.createProject(name: "Based", folder: "/tmp/based")
        _ = brain.ensureMainAgent()
        let thread = brain.ensureMainThread()
        let seen = Locked<[DelegatedJob]>([])
        main.installed = [.claudeCode]
        main.cliLauncher = { job in seen.sync { $0.append(job) }; return "Fixed in commit abc." }
        let r = await main.delegate(Self.codeArgs, thread: thread)
        #expect(!r.isError && r.text.contains("claude"))
        await main.waitForDelegations()
        let jobs = seen.current
        #expect(jobs.count == 1)
        guard case .cli(let spec)? = jobs.first?.choice else { Issue.record("not a CLI job"); return }
        #expect(spec.kind == .claudeCode && MainAgent.sessionAgentID(for: spec.kind) == "claude")
        #expect(jobs[0].projectID == project && jobs[0].parentRunID == brain.latestRun(forSession: thread)?.id)
        let run = brain.delegatedRuns().first
        #expect(run?.status == .done && run?.result == "Fixed in commit abc." && run?.engine == "claudeCode")
        #expect(!provider.calls.contains { $0.role == "sub" }, "no API model for the coding job")

        // Without a launcher the same job falls back to an API model (as before).
        let (b2, p2, m2) = make(Self.codeArgs)
        _ = b2.createProject(name: "Based"); _ = b2.ensureMainAgent()
        m2.installed = [.claudeCode]
        _ = await m2.delegate(Self.codeArgs, thread: b2.ensureMainThread())
        await m2.waitForDelegations()
        #expect(p2.calls.contains { $0.role == "sub" })
    }

    @Test func exhaustedBudgetStopsTheMainThreadWithoutAModelCall() async {
        let (brain, provider, main) = make(Self.codeArgs)
        _ = brain.createProject(name: "Based")
        let agent = brain.ensureMainAgent()
        brain.setMonthlyBudget(agent: agent.id, 1)
        spend(brain, 1.5)
        #expect(brain.mainAgentBudget().level == .exhausted)
        let thread = brain.ensureMainThread()
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "fix it", displayPrompt: "fix it"),
                                                session: thread, via: MainAgentChatBackend(agent: main, modelRef: main.modelRef()!))
        await turn.finished()
        #expect(provider.calls.isEmpty, "no model call at 100 %")
        #expect(brain.transcript(thread).contains("budget is used up"))
        let d = await main.delegate(Self.codeArgs, thread: thread)
        #expect(d.isError && d.text.contains("budget is used up"))
        #expect(brain.delegatedRuns().allSatisfy { $0.title == "earlier" }, "no new sub-agent run")
    }

    @Test func budgetAt80PercentForcesLowCompute() async {
        let args: JSONValue = ["task": "Write the launch post", "kind": "write", "project": "Based", "compute": "high"]
        let (brain, provider, main) = make(args)
        _ = brain.createProject(name: "Based")
        let agent = brain.ensureMainAgent()
        brain.setMonthlyBudget(agent: agent.id, 10)
        spend(brain, 8.5)
        #expect(brain.mainAgentBudget().level == .warning)
        _ = await main.delegate(args, thread: brain.ensureMainThread())
        await main.waitForDelegations()
        let sub = provider.calls.first { $0.role == "sub" }
        #expect(sub?.model == "claude-haiku-5-5", "forced to low compute although high was asked")
        #expect(brain.mainAgentBudget().warningNotice.contains("85 %"))
    }

    @Test func longResultBecomesAPageUnderTheProjectAndIsLinked() async {
        let long = "## Findings\n\n" + String(repeating: "A long line of research. ", count: 80)
        let args: JSONValue = ["task": "Research competitors", "kind": "research", "project": "Based"]
        let (brain, _, main) = make(args, subAnswer: long)
        let project = brain.createProject(name: "Based")
        _ = brain.ensureMainAgent()
        let thread = brain.ensureMainThread()
        _ = await main.delegate(args, thread: thread)
        await main.waitForDelegations()
        let run = brain.delegatedRuns().first!
        let page = try! #require(run.resultPageID)
        #expect(brain.store.blocks[page]?.parent == .block(project))
        #expect(brain.store.title(of: page) == "Result: Research competitors")
        #expect(brain.body(of: page).contains("A long line of research."))
        #expect(brain.mainHeartbeat(lastBeat: nil) == 1)
        let update = brain.latestUpdates(ofProject: project).first ?? ""
        #expect(update.contains("Research competitors") && update.contains("Result"))
        #expect(MainAgent.updateLine(run).contains(PageLink.url(page)))
        #expect(!MainAgent.updateLine(run).contains(String(repeating: "A long line of research. ", count: 10)), "the long text stays on the page")

        // Short results stay inline; no project → no page.
        let (b2, _, m2) = make(["task": "Quick look", "kind": "research"], subAnswer: long)
        _ = b2.ensureMainAgent()
        _ = await m2.delegate(["task": "Quick look", "kind": "research"], thread: b2.ensureMainThread())
        await m2.waitForDelegations()
        #expect(b2.delegatedRuns().first?.resultPageID == nil)
    }

    @Test func chatShortcutTarget() {
        var asked = 0
        let main: () -> RecordID = { asked += 1; return "M" }
        #expect(ChatShortcutTarget.mainAgent.chatToOpen(current: "C", currentIsRunning: false, mainThread: main) == "M")
        #expect(ChatShortcutTarget.mainAgent.chatToOpen(current: "C", currentIsRunning: true, mainThread: main) == "C", "a running chat stays")
        #expect(ChatShortcutTarget.mainAgent.chatToOpen(current: nil, currentIsRunning: false, mainThread: main) == "M")
        #expect(ChatShortcutTarget.lastChat.chatToOpen(current: "C", currentIsRunning: false, mainThread: main) == "C")
        #expect(asked == 2)
        #expect(MainAgent.sessionAgentID(for: .codex) == "codex" && MainAgent.sessionAgentID(for: .api) == nil)
    }
}
