import Foundation
import Testing
import BasedCore
@testable import BasedBrain

private final class FixedProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    var fail = false
    struct Boom: Error {}
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        if fail { throw Boom() }
        return AIResponse(message: .assistant("Did the thing."), usage: Usage(inputTokens: 10, outputTokens: 5))
    }
}

/// BSD-43: every agent run is a row of the Runs database.
@MainActor
struct RunStoreTests {
    private func make() -> (WorkspaceStore, BrainStore) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        return (store, BrainStore(store: store))
    }

    @Test func runsDatabaseIsCreatedOnceAndProtected() {
        let (store, brain) = make()
        #expect(brain.runs().isEmpty, "reading never creates the database")
        let db = brain.ensureRuns()
        #expect(brain.ensureRuns() == db)
        #expect(store.databases[db]?.title.plainText == "Runs")
        let host = store.databases[db]!.blockID
        #expect(store.protectedIDs.contains(host))
        #expect(brain.coreIDs.contains(host))
        #expect(store.trashPages([host]).isEmpty, "can't be trashed like the other Brain databases")
        // Relations point at the right databases.
        let props = store.databases[db]!.properties
        #expect(props.first { $0.name == "Agent" }?.relation?.databaseID == brain.agentsDB)
        #expect(props.first { $0.name == "Parent run" }?.relation?.databaseID == db)
        // Trashed by an older build → repair restores it.
        store.protectedIDs = []
        store.trash([host])
        #expect(brain.repair())
        #expect(!store.isTrashed(host))
    }

    @Test func existingRunsDatabaseGetsMissingColumns() {
        let (store, brain) = make()
        // A Runs database from an older/other build with only some columns.
        let db = store.createDatabase(title: "Runs", in: .block(brain.rootID), inline: true, sampleRows: 0).databaseID
        _ = store.addProperty(to: db, name: "Status", type: .select)
        let old = store.addRow(to: db, title: "Old run")
        #expect(brain.ensureRuns() == db, "adopted by title, not duplicated")
        #expect(store.databases[db]!.properties.contains { $0.name == "Cost" })
        let r = brain.run(old)
        #expect(r?.title == "Old run")
        #expect(r?.status == .planned && r?.kind == .session && r?.tokens == 0)
    }

    @Test func statusFlowUsageAndResult() {
        let (_, brain) = make()
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let id = brain.startRun(title: "Write summary", kind: .main, engine: "based", model: "anthropic/m", compute: .high, at: t0)
        var r = brain.run(id)!
        #expect(r.status == .running && r.kind == .main && r.compute == .high && r.startedAt == t0 && r.endedAt == nil)
        brain.update(run: id, status: .needsYou, progress: "Asked for approval")
        #expect(brain.run(id)?.status == .needsYou && brain.run(id)?.result == "Asked for approval")
        brain.addUsage(run: id, tokens: 100, cost: 0.25)
        brain.addUsage(run: id, tokens: 50)
        brain.finish(run: id, result: "Done: 3 pages", usage: Usage(inputTokens: 5, outputTokens: 5), cost: 0.05, at: t0.addingTimeInterval(60))
        r = brain.run(id)!
        #expect(r.status == .done && r.result == "Done: 3 pages" && r.tokens == 160)
        #expect(abs(r.cost - 0.30) < 1e-9)
        #expect(r.endedAt == t0.addingTimeInterval(60))
        brain.logRun(id, "Step 1 ok")
        #expect(brain.body(of: id).contains("Step 1 ok"))
        // Back to active clears the end time.
        brain.update(run: id, status: .running)
        #expect(brain.run(id)?.endedAt == nil)
    }

    @Test func runWritesAreNotUndoable() {
        let (store, brain) = make()
        brain.ensureRuns()
        let before = store.undoActionName
        let id = brain.startRun(title: "Agent", kind: .schedule)
        brain.update(run: id, progress: "step")
        brain.finish(run: id)
        #expect(store.undoActionName == before, "run writes don't land on the user's undo stack")
    }

    @Test func chatTurnSessionAndSubagentCreateRuns() {
        let (_, brain) = make()
        // Chat: one run per turn.
        let chat = brain.createSession(title: "Hi", agentID: "based", machine: "mac", cwd: "", encrypted: false)
        brain.updateSession(chat, status: .running)
        brain.updateSession(chat, status: .done, result: "Hello!")
        brain.updateSession(chat, status: .running)
        brain.updateSession(chat, addTokens: 42)
        let chatRuns = brain.runs(RunFilter(sessionID: chat))
        #expect(chatRuns.count == 2)
        #expect(chatRuns.allSatisfy { $0.kind == .chat })
        #expect(chatRuns.contains { $0.status == .done && $0.result == "Hello!" && $0.endedAt != nil })
        #expect(chatRuns.contains { $0.status == .running && $0.tokens == 42 })

        // Coding session: one run that follows the session, waiting for the user → needs you.
        let sess = brain.createSession(title: "Fix bug", agentID: "claude", machine: "mac", cwd: "/x", encrypted: false)
        #expect(brain.latestRun(forSession: sess)?.status == .waiting)
        brain.updateSession(sess, status: .running)
        brain.updateSession(sess, status: .waiting)
        #expect(brain.latestRun(forSession: sess)?.status == .needsYou)
        brain.updateSession(sess, status: .running)
        brain.updateSession(sess, status: .done, result: "Fixed")
        brain.updateSession(sess, status: .running)   // next prompt continues the same run
        #expect(brain.runs(RunFilter(sessionID: sess)).count == 1)
        #expect(brain.latestRun(forSession: sess)?.kind == .session)
        brain.updateSession(sess, status: .idle)     // stopped while running
        #expect(brain.latestRun(forSession: sess)?.status == .cancelled)

        // Sub-agent: own run under the parent's run.
        let sub = brain.createSession(title: "Write tests", agentID: "codex", machine: "mac", cwd: "/x", encrypted: false, parentID: sess)
        let subRun = brain.latestRun(forSession: sub)!
        #expect(subRun.kind == .subagent)
        #expect(subRun.parentID == brain.latestRun(forSession: sess)?.id)
        #expect(brain.children(ofRun: subRun.parentID!).map(\.id) == [subRun.id])
        brain.updateSession(sub, status: .failed, result: "Error: x")
        #expect(brain.latestRun(forSession: sub)?.status == .failed)
    }

    @Test func sessionsWithoutRunGetOneOnNextStatusChange() {
        let (store, brain) = make()
        // A session from before BSD-43: row exists, no run.
        let db = brain.sessionsDB
        let old = store.addRow(to: db, title: RichText("Old session"))
        brain.updateSession(old, addTokens: 5)
        #expect(brain.latestRun(forSession: old) == nil, "token-only updates don't create runs for old sessions")
        brain.updateSession(old, status: .running)
        #expect(brain.latestRun(forSession: old)?.status == .running)
    }

    @Test func scheduledAgentRunIsRecorded() async {
        let (store, brain) = make()
        let agentID = brain.saveAgent(name: "Daily brief", instructions: "Summarise.", schedule: "daily 07:00", model: nil)
        let reg = ModelRegistry()
        let p = FixedProvider()
        reg.register(p)
        let rt = AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))
        let agent = brain.agents().first { $0.id == agentID }!
        _ = await rt.run(agent: agent, trigger: "schedule daily 07:00")
        var rs = brain.runs(RunFilter(kinds: [.schedule]))
        #expect(rs.count == 1)
        #expect(rs[0].agentID == agentID && rs[0].status == .done && rs[0].result == "Did the thing." && rs[0].tokens == 15)
        #expect(brain.body(of: rs[0].id).contains("schedule daily 07:00"))
        p.fail = true
        _ = await rt.run(agent: agent)
        rs = brain.runs(RunFilter(agentID: agentID))
        #expect(rs.count == 2)
        #expect(rs.contains { $0.status == .failed && $0.result.hasPrefix("Error") })
    }

    @Test func mcpToolsListAndGetRuns() {
        let (store, brain) = make()
        let tools = AgentTools(store: store, brain: brain)
        #expect(tools.call("list_runs", [:]).text == "No runs.")
        let parent = brain.startRun(title: "Main", kind: .main)
        let child = brain.startRun(title: "Child", kind: .subagent, parentID: parent)
        brain.finish(run: child, result: "ok")
        let all = tools.call("list_runs", [:]).text
        #expect(all.contains("Main") && all.contains("Child"))
        let done = tools.call("list_runs", ["status": "done"]).text
        #expect(done.contains("Child") && !done.contains("Main ·"))
        #expect(tools.call("list_runs", ["kind": "nope"]).isError)
        let got = tools.call("get_run", ["run_id": .string(parent)]).text
        #expect(got.contains("Sub-runs") && got.contains(child))
        #expect(tools.call("get_run", ["run_id": "missing"]).isError)
        #expect(Set(tools.specs.map(\.name)).isSuperset(of: ["list_runs", "get_run"]))
    }
}

/// BSD-43: pure derivations for the start page.
struct RunOverviewTests {
    private func run(_ id: String, _ status: AgentRun.Status, start: Date, end: Date? = nil, session: String? = nil,
                     tokens: Int = 0, cost: Double = 0) -> AgentRun {
        AgentRun(id: id, title: id, status: status, kind: .session, agentID: nil, parentID: nil, sessionID: session,
                 engine: "", model: "", compute: nil, startedAt: start, endedAt: end, tokens: tokens, cost: cost,
                 result: "", resultPageID: nil)
    }

    @Test func listsForAFixedState() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Vienna")!
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 8, minute: 0))!
        let h: TimeInterval = 3600
        let runs = [
            run("a", .running, start: now - h, tokens: 100, cost: 0.10),
            run("b", .running, start: now - 2 * h, session: "s1"),
            run("c", .needsYou, start: now - 3 * h),
            run("d", .done, start: now - 4 * h, end: now - 3.5 * h, cost: 0.50),
            run("e", .failed, start: now - 30 * h, end: now - 29 * h, cost: 2.0),
            run("f", .done, start: now - 5 * h, end: now - 0.5 * h, session: "s2"),
        ]
        let inbox = [
            InboxItem(id: "i1", title: "Allow rm?", kind: .permission, status: .pending, sessionID: "s1", detail: "", options: [], decision: nil, createdAt: now),
            InboxItem(id: "i2", title: "Old", kind: .question, status: .approved, sessionID: "s2", detail: "", options: [], decision: "ok", createdAt: now),
        ]
        let agents = [
            Agent(id: "g1", name: "Brief", instructions: "", schedule: "daily 09:00", model: nil, enabled: true, lastRun: nil, dailyTokenBudget: nil),
            Agent(id: "g2", name: "Off", instructions: "", schedule: "daily 08:30", model: nil, enabled: false, lastRun: nil, dailyTokenBudget: nil),
            Agent(id: "g3", name: "Hourly", instructions: "", schedule: "every 15m", model: nil, enabled: true, lastRun: now - 600, dailyTokenBudget: nil),
            Agent(id: "g4", name: "Manual", instructions: "", schedule: nil, model: nil, enabled: true, lastRun: nil, dailyTokenBudget: nil),
        ]
        let o = RunOverview(runs: runs, inbox: inbox, agents: agents)
        #expect(o.running.map(\.id) == ["a", "b"])
        #expect(o.needsYou.map(\.id) == ["b", "c"])
        #expect(o.pendingInbox(for: runs[1]).map(\.id) == ["i1"])
        #expect(o.pendingInbox(for: runs[5]).isEmpty)
        #expect(o.finishedSince(now - 4 * h).map(\.id) == ["f", "d"])
        let up = o.upcoming(now: now, calendar: cal)
        #expect(up.map(\.agent.id) == ["g3", "g1"])
        #expect(up[0].at == now + 300)
        #expect(cal.component(.hour, from: up[1].at) == 9)
        #expect(abs(o.costToday(now: now, calendar: cal) - 0.60) < 1e-9)
        #expect(o.tokensToday(now: now, calendar: cal) == 100)
    }
}
