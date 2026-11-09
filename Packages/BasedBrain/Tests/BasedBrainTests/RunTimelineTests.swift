import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-108: timelines for the agent detail and the project detail.
@Suite struct RunTimelineTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func run(_ id: String, _ title: String, kind: AgentRun.Kind = .session, status: AgentRun.Status, start: TimeInterval, end: TimeInterval? = nil,
             agent: RecordID? = nil, engine: String = "", cost: Double = 0, tokens: Int = 0) -> AgentRun {
        AgentRun(id: id, title: title, status: status, kind: kind, agentID: agent, parentID: nil, sessionID: nil, engine: engine, model: "",
                 compute: nil, startedAt: now.addingTimeInterval(start), endedAt: end.map { now.addingTimeInterval($0) },
                 tokens: tokens, cost: cost, result: "", resultPageID: nil)
    }

    @Test func agentDetailLanesBarsAndNowLine() {
        let main = run("m", "Main", kind: .main, status: .running, start: -3600)
        let r = run("r", "Fix login", status: .running, start: -1800, cost: 0.5, tokens: 100)
        let kids = [run("b", "Write tests", kind: .subagent, status: .running, start: -600, cost: 0.1, tokens: 10),
                    run("a", "Read code", kind: .subagent, status: .done, start: -1500, end: -900, cost: 0.2, tokens: 20),
                    run("c", "Ask user", kind: .subagent, status: .needsYou, start: -300)]
        let t = RunTimeline.make(run: r, parent: main, children: kids, now: now)
        #expect(t.lanes.map(\.title) == ["Main agent", "Fix login", "Read code", "Write tests", "Ask user"])
        #expect(t.lanes.map(\.role) == [.main, .agent, .subagent, .subagent, .subagent])
        #expect(t.steps.map(\.state) == [.done, .running, .waiting])
        #expect(t.progress == 1.0 / 3.0)
        #expect(abs(t.cost - 0.8) < 1e-9 && t.tokens == 130)
        #expect(t.duration == 1800)
        // Range covers the main agent's start and now (with padding); bars inside 0…1, running bars end at now.
        #expect(t.range.start < main.startedAt && t.range.end > now)
        #expect(t.range.nowX > 0.9 && t.range.nowX < 1)
        for l in t.lanes { for b in l.bars { #expect(0 <= b.x0 && b.x0 <= b.x1 && b.x1 <= 1) } }
        let done = t.lanes[2].bars[0]
        #expect(done.end == now.addingTimeInterval(-900) && done.x1 < t.range.nowX)
        #expect(t.lanes[1].bars[0].end == now && abs(t.lanes[1].bars[0].x1 - t.range.nowX) < 1e-9)
    }

    @Test func finishedRunWithoutSubagents() {
        let r = run("r", "Brief", kind: .schedule, status: .failed, start: -7200, end: -7000)
        let t = RunTimeline.make(run: r, children: [], now: now)
        #expect(t.lanes.count == 1 && t.progress == nil && t.duration == 200)
        #expect(t.lanes[0].bars[0].state == .failed)
    }

    @Test func projectTimelineTwoWeeksBackOneAhead() {
        let day: TimeInterval = 86_400
        let runs = [
            run("old", "Too old", status: .done, start: -20 * day, end: -19 * day),
            run("m1", "Plan week", kind: .main, status: .done, start: -3 * day, end: -3 * day + 600, cost: 0.1),
            run("x1", "Nightly sync", kind: .schedule, status: .done, start: -2 * day, end: -2 * day + 60, agent: "agentA", cost: 0.2, tokens: 5),
            run("x2", "Nightly sync", kind: .schedule, status: .failed, start: -1 * day, end: -1 * day + 60, agent: "agentA"),
            run("p1", "Nightly sync", kind: .schedule, status: .planned, start: 1 * day, agent: "agentA"),
            run("c1", "Chat", kind: .chat, status: .running, start: -60, engine: "Claude Code"),
            run("far", "Far future", kind: .schedule, status: .planned, start: 30 * day, agent: "agentA"),
        ]
        let t = ProjectTimeline.make(runs: runs, now: now) { $0 == "agentA" ? "Sync agent" : nil }
        #expect(t.range.start == now.addingTimeInterval(-14 * day) && t.range.end == now.addingTimeInterval(7 * day))
        #expect(abs(t.range.nowX - 14.0 / 21.0) < 1e-9)
        #expect(t.lanes.map(\.title) == ["Main agent", "Sync agent", "Claude Code"])
        #expect(t.lanes[1].bars.map(\.state) == [.done, .failed, .planned])
        #expect(t.lanes[1].bars[2].x0 > t.range.nowX, "planned runs sit right of now")
        #expect(t.runCount == 5 && t.running == 1 && t.failed == 1)
        #expect(abs(t.cost - 0.3) < 1e-9 && t.tokens == 5)
    }
}
