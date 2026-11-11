import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

private final class CountingProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    private let lock = NSLock()
    private var _calls = 0
    var calls: Int { lock.withLock { _calls } }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        lock.withLock { _calls += 1 }
        try? await Task.sleep(nanoseconds: 20_000_000)
        return AIResponse(message: .assistant("Done."), usage: Usage(inputTokens: 1000, outputTokens: 500))
    }
}

/// BSD-51: budget per agent and schedules without double runs.
@MainActor
struct AgentBudgetTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Europe/Vienna")!; return c }
    private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    private func make() -> (WorkspaceStore, BrainStore, CountingProvider, AgentRuntime) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let reg = ModelRegistry(); let p = CountingProvider(); reg.register(p)
        let rt = AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain))
        return (store, brain, p, rt)
    }

    // MARK: Schedule fixes

    @Test func newAgentIsDueFromItsNextFireTimeOnly() {
        let s = Schedule.parse("daily 09:00")!
        let created = date(2026, 11, 9, 10)
        // Created after today's 09:00: not due right away (it used to be), but tomorrow at 09:00.
        #expect(!s.isDue(now: date(2026, 11, 9, 10, 5), lastRun: nil, since: created, calendar: cal))
        #expect(!s.isDue(now: date(2026, 11, 10, 8, 59), lastRun: nil, since: created, calendar: cal))
        #expect(s.isDue(now: date(2026, 11, 10, 9, 0), lastRun: nil, since: created, calendar: cal))
        // Interval schedules still start at once.
        #expect(Schedule.parse("every 1h")!.isDue(now: created, lastRun: nil, since: created, calendar: cal))
        // Through the scheduler: the agent row's creation time is used.
        let a = Agent(id: "a", name: "A", instructions: "", schedule: "daily 09:00", model: nil, enabled: true, lastRun: nil,
                      dailyTokenBudget: nil, createdAt: created)
        #expect(AgentScheduler.due([a], now: date(2026, 11, 9, 10, 5), calendar: cal).isEmpty)
        #expect(AgentScheduler.due([a], now: date(2026, 11, 10, 9, 1), calendar: cal).count == 1)
    }

    @Test func monthly31ClampsToMonthEnd() {
        let s = Schedule.parse("monthly 31 08:00")!
        let n1 = s.nextRun(after: date(2026, 11, 2, 0), lastRun: nil, calendar: cal)
        #expect(cal.dateComponents([.month, .day, .hour], from: n1) == DateComponents(month: 11, day: 30, hour: 8))
        let n2 = s.nextRun(after: date(2027, 2, 1, 0), lastRun: nil, calendar: cal)
        #expect(cal.dateComponents([.month, .day], from: n2) == DateComponents(month: 2, day: 28))
        let n3 = s.nextRun(after: date(2026, 12, 31, 9), lastRun: nil, calendar: cal)
        #expect(cal.dateComponents([.year, .month, .day], from: n3) == DateComponents(year: 2027, month: 1, day: 31))
        // Not due twice: after the run on Nov 30 the next one is Dec 31.
        #expect(!s.isDue(now: date(2026, 12, 15, 8), lastRun: date(2026, 11, 30, 8), calendar: cal))
    }

    @Test func cronDayAndWeekdayAreOr() {
        // "On the 1st and on every Monday at 07:00" (standard cron), Nov 2026: Mon 2, 9, 16 … and Dec 1 (Tue).
        let s = Schedule.parse("0 7 1 * 1")!
        let n1 = s.nextRun(after: date(2026, 11, 1, 8), lastRun: nil, calendar: cal)
        #expect(cal.component(.day, from: n1) == 2)
        let n2 = s.nextRun(after: date(2026, 11, 30, 8), lastRun: nil, calendar: cal)
        #expect(cal.dateComponents([.month, .day], from: n2) == DateComponents(month: 12, day: 1))
        // Only one restricted → AND as before.
        let w = Schedule.parse("0 7 * * 1-5")!
        let n3 = w.nextRun(after: date(2026, 11, 7, 8), lastRun: nil, calendar: cal) // Saturday
        #expect(cal.component(.weekday, from: n3) == 2)
        // */15
        let q = Schedule.parse("*/15 * * * *")!
        let n4 = q.nextRun(after: date(2026, 11, 9, 10, 1), lastRun: nil, calendar: cal)
        #expect(cal.component(.minute, from: n4) == 15)
    }

    @Test func cronDoesNotFireTwiceWhenClocksFallBack() {
        // Vienna, 2026-10-25: 03:00 CEST → 02:00 CET; 02:30 happens twice.
        let s = Schedule.parse("30 2 * * *")!
        let first = s.nextRun(after: date(2026, 10, 25, 1), lastRun: nil, calendar: cal)
        #expect(cal.component(.hour, from: first) == 2)
        let next = s.nextRun(after: first, lastRun: first, calendar: cal)
        #expect(cal.component(.day, from: next) == 26, "the repeated 02:30 is skipped")
        #expect(!s.isDue(now: first.addingTimeInterval(3600 + 60), lastRun: first, calendar: cal))
    }

    // MARK: Pure budget rules

    @Test func budgetLevelsAndSpending() {
        #expect(AgentBudget.level(spent: 3.9, budget: 5) == .ok)
        #expect(AgentBudget.level(spent: 4, budget: 5) == .warning)
        #expect(AgentBudget.level(spent: 5, budget: 5) == .exhausted)
        #expect(AgentBudget.level(spent: 100, budget: nil) == .ok)
        let now = date(2026, 11, 9, 10)
        func run(_ agent: String, _ start: Date, cost: Double, tokens: Int = 0, model: String = "") -> AgentRun {
            AgentRun(id: UUID().uuidString, title: "r", status: .done, kind: .schedule, agentID: agent, parentID: nil, sessionID: nil,
                     engine: "based", model: model, compute: nil, startedAt: start, endedAt: start + 60, tokens: tokens, cost: cost,
                     result: "", resultPageID: nil)
        }
        let runs = [run("a", date(2026, 11, 1, 0, 30), cost: 1.5), run("a", date(2026, 11, 9, 9), cost: 0, tokens: 1_000_000, model: "anthropic/claude-haiku-5-5"),
                    run("a", date(2026, 10, 31, 23), cost: 9), run("b", now, cost: 4), run("a", date(2026, 11, 9, 9), cost: 0, tokens: 500, model: "ollama/llama")]
        // 1.5 + estimate (1M input tokens of a small model = €1) — October and agent b don't count, local models are free.
        #expect(abs(AgentBudget.spentThisMonth(runs, agentID: "a", now: now, calendar: cal) - 2.5) < 1e-9)
        #expect(AgentBudget.tokensToday(runs, agentID: "a", now: now, calendar: cal) == 1_000_500)
        #expect(ModelPricing.estimate(model: "anthropic/claude-opus-5-5", usage: Usage(inputTokens: 1_000_000, outputTokens: 1_000_000)) == 30)
        // Lease TTL: twice the usual run time (60 s → 2 min floor), 10 min default → 20 min, at most 1 h.
        #expect(AgentBudget.leaseTTL(runs, agentID: "a") == 120)
        #expect(AgentBudget.leaseTTL([], agentID: "x") == 1200)
        let long = [run("l", now, cost: 0)].map { r -> AgentRun in var r = r; r.endedAt = r.startedAt + 7200; return r }
        #expect(AgentBudget.leaseTTL(long, agentID: "l") == 3600)
    }

    @Test func leaseRules() {
        let now = date(2026, 11, 9, 10)
        var a = Agent(id: "a", name: "A", instructions: "", schedule: "every 15m", model: nil, enabled: true, lastRun: nil, dailyTokenBudget: nil)
        #expect(AgentBudget.decide(a, runs: [], now: now, calendar: cal) == .run(warning: false))
        a.runningSince = now - 300; a.runningNode = "server"
        #expect(AgentBudget.decide(a, runs: [], now: now, calendar: cal) == .skipLeased(node: "server", since: now - 300))
        a.runningSince = now - 3 * 3600   // stale lease from a crashed node
        #expect(AgentBudget.decide(a, runs: [], now: now, calendar: cal) == .run(warning: false))
        a.runningSince = nil; a.runningNode = nil
        a.monthlyBudget = 0
        if case .skipBudget = AgentBudget.decide(a, runs: [], now: now, calendar: cal) {} else { Issue.record("budget 0 stops") }
    }

    // MARK: Store + scheduler

    @Test func twoNodesOnOneStoreRunOnce() async {
        let (_, brain, provider, rt) = make()
        let id = brain.saveAgent(name: "Brief", instructions: "Say hi.", schedule: "every 15m", model: nil)
        let mac = AgentScheduler(runtime: rt, node: "Mac"), server = AgentScheduler(runtime: rt, node: "server")
        let now = Date()
        async let x: Void = mac.runDue(now: now)
        async let y: Void = server.runDue(now: now)
        _ = await (x, y)
        #expect(provider.calls == 1, "exactly one node ran the agent")
        let runs = brain.runs(RunFilter(agentID: id))
        #expect(runs.count == 1)
        #expect(runs[0].cost > 0, "cost estimated from the model")
        let a = brain.agents().first { $0.id == id }!
        #expect(a.runningSince == nil && a.runningNode == nil, "lease released")
        #expect(a.lastRun != nil)
        // A tick later on the other node: not due again.
        await mac.runDue(now: now.addingTimeInterval(60))
        #expect(provider.calls == 1)
    }

    @Test func freshLeaseFromAnotherNodeIsRespected() async {
        let (_, brain, provider, rt) = make()
        let id = brain.saveAgent(name: "Brief", instructions: "", schedule: "every 15m", model: nil)
        let now = Date()
        // The server took the lease (synced in) but its Last run is old, e.g. the run is still going.
        #expect(brain.beginScheduledRun(brain.agents()[0], node: "server", now: now) == .run(warning: false))
        brain.markRun(id, at: now.addingTimeInterval(-3600))
        await AgentScheduler(runtime: rt, node: "Mac").runDue(now: now.addingTimeInterval(30))
        #expect(provider.calls == 0)
        // The Mac can't release the server's lease.
        brain.releaseLease(agent: id, node: "Mac")
        #expect(brain.agents()[0].runningNode == "server")
        brain.releaseLease(agent: id, node: "server")
        #expect(brain.agents()[0].runningNode == nil)
    }

    @Test func overBudgetSkipsAndWritesInboxOnce() async {
        let (_, brain, provider, rt) = make()
        let id = brain.saveAgent(name: "Research", instructions: "", schedule: "every 15m", model: nil)
        brain.setMonthlyBudget(agent: id, 1.0)
        let now = Date()
        let r = brain.startRun(title: "earlier", kind: .schedule, agentID: id, at: now)
        brain.finish(run: r, cost: 0.85, at: now)
        let s = AgentScheduler(runtime: rt, node: "server")
        // 85 % → runs, with a notice.
        await s.runDue(now: now)
        #expect(provider.calls == 1)
        #expect(brain.inbox().filter { $0.title.hasPrefix("Budget at 80 %: Research") }.count == 1)
        // Now over 100 % → skipped, notice once, also on the next tick.
        let r2 = brain.startRun(title: "big", kind: .schedule, agentID: id, at: now)
        brain.finish(run: r2, cost: 1.0, at: now)
        await s.runDue(now: now.addingTimeInterval(3600))
        await s.runDue(now: now.addingTimeInterval(7200))
        #expect(provider.calls == 1)
        #expect(brain.inbox().filter { $0.title.hasPrefix("Budget used up: Research") }.count == 1)
        #expect(brain.agents()[0].monthlyBudget == 1.0)
        // Raised budget → runs again.
        brain.setMonthlyBudget(agent: id, 10)
        await s.runDue(now: now.addingTimeInterval(3 * 3600))
        #expect(provider.calls == 2)
    }

    @Test func dailyTokenBudgetComesFromRuns() async {
        let (store, brain, provider, rt) = make()
        let id = brain.saveAgent(name: "Daily", instructions: "", schedule: "every 15m", model: nil)
        if let p = brain.propID(brain.agentsDB, "Daily token budget") { store.setValue(id, p, .number(1000)) }
        let now = Date()
        let r = brain.startRun(title: "earlier", kind: .schedule, agentID: id, at: now)
        brain.finish(run: r, usage: Usage(inputTokens: 1200, outputTokens: 0), at: now)
        // A fresh scheduler (e.g. after a restart) still sees today's tokens.
        await AgentScheduler(runtime: rt, node: "server").runDue(now: now)
        #expect(provider.calls == 0)
    }

    @Test func olderAgentsDatabaseGetsColumnsOnFirstUse() {
        let (store, brain, _, _) = make()
        // An Agents database from before BSD-51: drop the new columns.
        for name in ["Monthly budget", "Spent this month", "Running since", "Node"] {
            if let p = brain.propID(brain.agentsDB, name) { store.deleteProperty(brain.agentsDB, p) }
        }
        let id = brain.saveAgent(name: "Old", instructions: "", schedule: "every 1h", model: nil)
        #expect(brain.agents()[0].monthlyBudget == nil && brain.agents()[0].runningNode == nil)
        #expect(brain.beginScheduledRun(brain.agents()[0], node: "server") == .run(warning: false))
        #expect(brain.agents().first { $0.id == id }?.runningNode == "server")
    }

    @Test func scheduleHostSetting() {
        #expect(ScheduleHost.stored(nil, legacyLocal: nil) == .auto)
        #expect(ScheduleHost.stored(nil, legacyLocal: true) == .thisDevice)
        #expect(ScheduleHost.stored(nil, legacyLocal: false) == .server)
        #expect(ScheduleHost.stored("server", legacyLocal: true) == .server)
        #expect(ScheduleHost.auto.runsOnThisDevice(serverConfigured: false))
        #expect(!ScheduleHost.auto.runsOnThisDevice(serverConfigured: true))
        #expect(!ScheduleHost.server.runsOnThisDevice(serverConfigured: false))
        #expect(ScheduleHost.thisDevice.runsOnThisDevice(serverConfigured: true))
    }
}
