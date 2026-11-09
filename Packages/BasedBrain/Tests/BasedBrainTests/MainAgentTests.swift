import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Fake engine: as the main agent it delegates once, as a sub-agent it "builds" and reports.
private final class OrchestraProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake"
    let models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
    let delegateArgs: JSONValue
    var subagentFails = false
    struct Boom: Error {}
    private let log = Locked<[(model: String, role: String, tools: [String])]>([])
    var calls: [(model: String, role: String, tools: [String])] { log.current }
    init(delegateArgs: JSONValue) { self.delegateArgs = delegateArgs }

    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let system = messages.first?.content ?? ""
        let isMain = system.contains("# Main agent")
        log.sync { $0.append((model, isMain ? "main" : "sub", tools.map(\.name))) }
        if isMain {
            if let last = messages.last, last.role == .tool { return AIResponse(message: .assistant("On it — a sub-agent is building X.")) }
            var m = ChatMessage.assistant("")
            m.toolCalls = [ToolCall(id: "d1", name: "delegate", arguments: delegateArgs)]
            return AIResponse(message: m, usage: Usage(inputTokens: 100, outputTokens: 20))
        }
        if subagentFails { throw Boom() }
        return AIResponse(message: .assistant("Built X on page P-1."), usage: Usage(inputTokens: 2000, outputTokens: 400))
    }
}

/// BSD-52: one main agent that delegates to sub-agents and reports.
@MainActor
struct MainAgentTests {
    private func make(_ args: JSONValue) -> (WorkspaceStore, BrainStore, OrchestraProvider, MainAgent) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let reg = ModelRegistry(); let p = OrchestraProvider(delegateArgs: args); reg.register(p)
        let rt = AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))
        return (store, brain, p, MainAgent(runtime: rt))
    }

    private static let buildArgs: JSONValue = .object(["task": .string("Baue X im Repo Based"), "kind": .string("code"), "project": .string("Based")])

    @Test func mainAgentRowAndThreadAreCreatedOnceAndProtected() {
        let (store, brain, _, _) = make(.object([:]))
        let a = brain.ensureMainAgent()
        #expect(a.isMain && a.name == "Main agent" && a.schedule == "every 2h")
        #expect(brain.ensureMainAgent().id == a.id)
        #expect(brain.agents().filter(\.isMain).count == 1)
        #expect(store.protectedIDs.contains(a.id))
        #expect(store.trashPages([a.id]).isEmpty, "the main agent can't be trashed")
        let t = brain.ensureMainThread()
        #expect(brain.ensureMainThread() == t)
        #expect(brain.isMainThread(t))
        #expect(brain.latestRun(forSession: t)?.kind == .main)
        #expect(brain.latestRun(forSession: t)?.agentID == a.id, "main runs are charged to the main agent (BSD-51)")
    }

    @Test func promptContainsActiveProjectsWithLatestUpdates() {
        let (_, brain, _, _) = make(.object([:]))
        let p = brain.createProject(name: "Based", goal: "Notion alternative")
        _ = brain.createProject(name: "Old", status: .done)
        for i in 1...4 { brain.postProjectUpdate(p, "update \(i)", at: Date(timeIntervalSince1970: 1_800_000_000 + Double(i) * 60)) }
        let briefs = brain.projectBriefs()
        #expect(briefs.map(\.name) == ["Based"])
        #expect(briefs[0].updates.count == 3)
        #expect(briefs[0].updates[0].hasSuffix("update 4"), "newest first")
        let prompt = MainAgent.systemPrompt(instructions: "", projects: briefs)
        #expect(prompt.contains("# Main agent") && prompt.contains("Based (id \(p))") && prompt.contains("Notion alternative"))
        #expect(prompt.contains("update 4") && !prompt.contains("update 1"))
        #expect(!prompt.contains("Old"))
    }

    @Test func delegateCreatesSubagentRunWithParentAndProject() async {
        let (_, brain, provider, main) = make(Self.buildArgs)
        let project = brain.createProject(name: "Based", goal: "Notion alternative")
        let agent = brain.ensureMainAgent()
        let thread = brain.ensureMainThread()
        let model = main.modelRef()
        #expect(model == "fake/claude-haiku-5-5", "the main agent runs on low compute")
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "baue X in Projekt Based", displayPrompt: "baue X in Projekt Based"),
                                                session: thread, via: MainAgentChatBackend(agent: main, modelRef: model!))
        await turn.finished()
        await main.waitForDelegations()
        // The main turn had the delegation tools; the sub-agent did not.
        let mainCall = provider.calls.first { $0.role == "main" }!
        #expect(mainCall.tools.contains("delegate") && mainCall.tools.contains("check_runs") && mainCall.tools.contains("report"))
        let subCall = provider.calls.first { $0.role == "sub" }!
        #expect(!subCall.tools.contains("delegate"))
        #expect(subCall.model != "claude-haiku-5-5", "code work is routed to a stronger model than the main agent's")
        // Sub-agent run: parent = the thread's run, project, charged to the main agent, finished with result + cost.
        let mainRun = brain.runs(RunFilter(kinds: [.main], sessionID: thread)).first!
        let subs = brain.delegatedRuns()
        #expect(subs.count == 1)
        let sub = subs[0]
        #expect(sub.parentID == mainRun.id && sub.projectID == project && sub.agentID == agent.id)
        #expect(sub.status == .done && sub.result == "Built X on page P-1." && sub.cost > 0)
        #expect(brain.children(ofRun: mainRun.id).map(\.id) == [sub.id])
        #expect(brain.transcript(thread).contains("On it"))
    }

    @Test func heartbeatWritesUpdateIntoProjectAndThread() async {
        let (_, brain, provider, main) = make(Self.buildArgs)
        let project = brain.createProject(name: "Based")
        let agent = brain.ensureMainAgent()
        let thread = brain.ensureMainThread()
        let before = Date().addingTimeInterval(-1)
        _ = await main.delegate(Self.buildArgs, thread: thread)
        await main.waitForDelegations()
        let calls = provider.calls.count
        // Through the scheduler: the main agent's scheduled run is the heartbeat.
        let scheduler = AgentScheduler(runtime: main.runtime, node: "server")
        brain.markRun(agent.id, at: before)
        await scheduler.runDue(now: before.addingTimeInterval(3 * 3600))
        #expect(provider.calls.count == calls, "the heartbeat makes no model call")
        let updates = brain.latestUpdates(ofProject: project)
        #expect(updates.count == 1 && updates[0].contains("✓ Baue X im Repo Based — Built X on page P-1."))
        #expect(brain.transcript(thread).contains("✓ Baue X im Repo Based"))
        #expect(brain.runs(RunFilter(kinds: [.main], agentID: agent.id)).contains { $0.title == "Heartbeat" })
        // Nothing changed since → no update, no heartbeat run.
        let heartbeats = brain.runs(RunFilter(kinds: [.main])).filter { $0.title == "Heartbeat" }.count
        await scheduler.runDue(now: before.addingTimeInterval(6 * 3600))
        #expect(brain.latestUpdates(ofProject: project).count == 1)
        #expect(brain.runs(RunFilter(kinds: [.main])).filter { $0.title == "Heartbeat" }.count == heartbeats)
        #expect(provider.calls.count == calls)
    }

    @Test func failedSubagentLandsInInbox() async {
        let (_, brain, provider, main) = make(Self.buildArgs)
        _ = brain.createProject(name: "Based")
        _ = brain.ensureMainAgent()
        let thread = brain.ensureMainThread()
        provider.subagentFails = true
        _ = await main.delegate(Self.buildArgs, thread: thread)
        await main.waitForDelegations()
        #expect(brain.delegatedRuns().first?.status == .failed)
        #expect(brain.mainHeartbeat(lastBeat: nil) == 1)
        #expect(brain.inbox().contains { $0.title == "Sub-agent failed: Baue X im Repo Based" })
    }

    @Test func heartbeatNeededIsPure() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func run(_ id: String, kind: AgentRun.Kind, agent: String?, status: AgentRun.Status, end: Date?) -> AgentRun {
            AgentRun(id: id, title: id, status: status, kind: kind, agentID: agent, parentID: nil, sessionID: nil, engine: "", model: "",
                     compute: nil, startedAt: now - 7200, endedAt: end, tokens: 0, cost: 0, result: "", resultPageID: nil)
        }
        let runs = [run("a", kind: .subagent, agent: "M", status: .done, end: now - 600),
                    run("b", kind: .subagent, agent: "M", status: .running, end: nil),
                    run("c", kind: .subagent, agent: "X", status: .done, end: now - 60),
                    run("d", kind: .chat, agent: "M", status: .done, end: now - 60)]
        let o = RunOverview(runs: runs)
        #expect(MainAgent.heartbeatNeeded(overview: o, mainAgentID: "M", lastBeat: now - 3600))
        #expect(!MainAgent.heartbeatNeeded(overview: o, mainAgentID: "M", lastBeat: now - 300), "only other agents' or unfinished runs since")
        #expect(MainAgent.heartbeatNeeded(overview: o, mainAgentID: "M", lastBeat: nil))
    }

    @Test func delegateRejectsUnknownProjectAndEmptyTask() async {
        let (_, brain, _, main) = make(.object([:]))
        _ = brain.createProject(name: "Based")
        let thread = brain.ensureMainThread()
        let r1 = await main.delegate(.object(["task": .string("x"), "kind": .string("write"), "project": .string("Nope")]), thread: thread)
        #expect(r1.isError && r1.text.contains("Projects: Based"))
        let r2 = await main.delegate(.object(["kind": .string("write")]), thread: thread)
        #expect(r2.isError)
        let r3 = await main.report(.object(["project": .string("Based"), "text": .string("Shipped the sidebar.")]))
        #expect(!r3.isError)
        #expect(brain.latestUpdates(ofProject: brain.project(named: "Based")!.id).first?.hasSuffix("Shipped the sidebar.") == true)
        #expect(brain.delegatedRuns().isEmpty)
    }
}
