import Foundation
import Testing
import BasedCore
@testable import BasedBrain

private let now = Date(timeIntervalSince1970: 1_800_000_000)   // fixed clock
private var vienna: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Europe/Vienna")!; return c }

private func run(_ id: String, _ status: AgentRun.Status, kind: AgentRun.Kind = .session, started: TimeInterval, ended: TimeInterval? = nil,
                 project: RecordID? = nil, parent: RecordID? = nil, session: RecordID? = nil, cost: Double = 0, result: String = "") -> AgentRun {
    AgentRun(id: id, title: "Run \(id)", status: status, kind: kind, agentID: nil, parentID: parent, sessionID: session, engine: "codex",
             model: "Opus", compute: nil, startedAt: now.addingTimeInterval(started), endedAt: ended.map { now.addingTimeInterval($0) },
             tokens: 0, cost: cost, result: result, resultPageID: nil, projectID: project)
}

private func item(_ id: String, _ lane: HomeItem.Lane, _ offset: TimeInterval) -> HomeItem {
    HomeItem(id: id, lane: lane, title: id, subtitle: "", detail: "", date: now.addingTimeInterval(offset))
}

@Suite struct TimeScaleTests {
    @Test func nowIsTopPastLeftFutureRightWithSquareRootStretch() {
        let s = TimeScale(range: .today, now: now)
        #expect(s.angle(for: now) == 90)
        #expect(abs(s.angle(for: now.addingTimeInterval(-12 * 3600)) - 142) < 1e-9)
        #expect(abs(s.angle(for: now.addingTimeInterval(12 * 3600)) - 38) < 1e-9)
        // Mockup ticks: −1 h ≈ 105°, −3 h = 116°, +6 h ≈ 53°.
        #expect(abs(s.angle(for: now.addingTimeInterval(-3600)) - 105) < 0.5)
        #expect(abs(s.angle(for: now.addingTimeInterval(-3 * 3600)) - 116) < 1e-9)
        #expect(abs(s.angle(for: now.addingTimeInterval(6 * 3600)) - 53.2) < 0.1)
        #expect(s.angle(for: now.addingTimeInterval(-40 * 3600)) == 142, "clamped beyond the range")
        // Stretched near now: the first hour takes more angle than the twelfth.
        #expect(s.angle(for: now.addingTimeInterval(-3600)) - 90 > 142 - s.angle(for: now.addingTimeInterval(-11 * 3600)))
        for off in stride(from: -12.0 * 3600, through: 12 * 3600, by: 1800) {
            let d = now.addingTimeInterval(off)
            #expect(abs(s.date(forAngle: s.angle(for: d)).timeIntervalSince(d)) < 0.01)
        }
    }

    @Test func rangesChangeTheScaleAndTicks() {
        let week = TimeScale(range: .week, now: now), month = TimeScale(range: .month, now: now)
        #expect(abs(week.angle(for: now.addingTimeInterval(-7 * 86400)) - 142) < 1e-9)
        #expect(week.angle(for: now.addingTimeInterval(-86400)) > TimeScale(range: .month, now: now).angle(for: now.addingTimeInterval(-86400)))
        #expect(TimeScale(range: .today, now: now).ticks.map(\.label) == ["−12 h", "−6 h", "−3 h", "−1 h", "now", "+1 h", "+3 h", "+6 h", "+12 h"])
        #expect(week.ticks.map(\.label) == ["−7 d", "−3 d", "−1 d", "−6 h", "now", "+6 h", "+1 d", "+3 d", "+7 d"])
        #expect(month.ticks.map(\.label).first == "−30 d" && month.ticks.map(\.label).last == "+30 d")
        let angles = week.ticks.map(\.angle)
        #expect(angles == angles.sorted(by: >), "ticks run from left (past) to right (future)")
        #expect(week.ticks.filter(\.isNow).map(\.angle) == [90])
    }
}

@Suite struct HomeSnapshotTests {
    @Test func lanesComeFromRunsInboxAndAgents() {
        let proj = AgentProject(id: "p1", name: "Based", status: .active, goal: "", folder: "", pageIDs: [], agentID: nil, updatedAt: now)
        let runs = [
            run("r1", .running, started: -1800, project: "p1", session: "s1", result: "4 of 7 suites"),
            run("r1a", .running, kind: .subagent, started: -600, project: "p1", parent: "r1"),
            run("r2", .done, started: -7200, ended: -1200, project: "p1", cost: 0.4, result: "14 sources"),
            run("r3", .failed, kind: .schedule, started: -5000, ended: -4000),
            run("r4", .cancelled, started: -3000, ended: -2900),
            run("r5", .done, kind: .chat, started: -100, ended: -50),
            run("r6", .done, started: -20 * 3600, ended: -19 * 3600),
            run("r7", .waiting, started: -900, session: "s7"),
        ]
        let inbox = [InboxItem(id: "i1", title: "Run swift test in the sandbox?", kind: .permission, status: .pending, sessionID: "s7",
                               detail: "swift test", options: ["allow_once=Allow", "allow_always=Always", "reject_once=No"], decision: nil,
                               createdAt: now.addingTimeInterval(-120)),
                     InboxItem(id: "i2", title: "Budget at 80 %", kind: .notice, status: .pending, sessionID: nil, detail: "", options: [],
                               decision: nil, createdAt: now)]
        let agents = [Agent(id: "a1", name: "Daily brief", instructions: "", schedule: "daily 15:00", model: nil, enabled: true, lastRun: nil, dailyTokenBudget: nil),
                      Agent(id: "a2", name: "Main agent", instructions: "", schedule: "every 2h", model: nil, enabled: true, lastRun: nil, dailyTokenBudget: nil, isMain: true),
                      Agent(id: "a3", name: "Monthly review", instructions: "", schedule: "monthly 1", model: nil, enabled: true, lastRun: now, dailyTokenBudget: nil)]
        let snap = HomeSnapshot.make(overview: RunOverview(runs: runs, inbox: inbox, agents: agents), projects: [proj], lastUpdate: "Based: tests green",
                                     userName: "Elija", now: now, range: .today, calendar: vienna)
        #expect(Set(snap.items(in: .running).map(\.id)) == ["run:r1", "run:r1a"])
        let r1 = snap.items(in: .running).first { $0.id == "run:r1" }
        #expect(r1?.subagents == 1)
        #expect(r1?.subtitle == "Based")
        #expect(r1?.detail == "4 of 7 suites")
        let ask = snap.items(in: .needsYou)
        #expect(ask.map(\.id) == ["inbox:i1"], "notices are not questions; the waiting run is shown once, as its question")
        #expect(ask.first?.options.map(\.label) == ["Allow", "Always", "No"])
        #expect(ask.first?.runID == "r7")
        #expect(snap.items(in: .done).map(\.id) == ["run:r2", "run:r3"], "chat turns, cancelled and out-of-range runs are no cards")
        #expect(snap.items(in: .done).last?.failed == true)
        #expect(snap.items(in: .planned).map(\.title) == ["Daily brief"], "main agent heartbeat and runs beyond 12 h are not shown")
        #expect(snap.costToday == 0.4)
        #expect(snap.lastUpdate == "Based: tests green")
        #expect(snap.summary == "While you were away: Run r2 finished, 1 run failed, 2 agents are working on Based, 1 approval is waiting.")
        // 1_800_000_000 = 2027-01-15 08:00 UTC = 09:00 in Vienna.
        #expect(snap.greeting == "Good morning, Elija.")
    }

    @Test func greetingAndEmptySummary() {
        var cal = vienna
        cal.timeZone = TimeZone(identifier: "America/Los_Angeles")!   // 00:00 there
        let snap = HomeSnapshot.make(overview: RunOverview(runs: []), now: now, range: .week, calendar: cal)
        #expect(snap.greeting == "Good evening.")
        #expect(snap.summary.isEmpty && snap.items.isEmpty)
        let since = HomeSnapshot.summary([item("a", .done, -3600)], since: now.addingTimeInterval(-60), projectNames: [:])
        #expect(since.isEmpty, "only what happened since the last visit")
    }

    @Test @MainActor func brainStoreBuildsTheSnapshotFromItsDatabases() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        #expect(brain.homeSnapshot(now: now, range: .today).items.isEmpty)
        let p = brain.createProject(name: "Publit", goal: "Launch")
        let r = brain.startRun(title: "Market analysis", kind: .subagent, projectID: p, at: now.addingTimeInterval(-3600))
        brain.finish(run: r, status: .done, result: "14 sources", at: now.addingTimeInterval(-1200))
        brain.startRun(title: "Fix tests", kind: .session, projectID: p, at: now.addingTimeInterval(-600))
        brain.postProjectUpdate(p, "Market analysis done", at: now.addingTimeInterval(-1000))
        let snap = brain.homeSnapshot(now: now, range: .today, userName: "Elija")
        #expect(snap.items(in: .done).map(\.title) == ["Market analysis"])
        #expect(snap.items(in: .done).first?.subtitle == "Publit")
        #expect(snap.items(in: .running).map(\.title) == ["Fix tests"])
        #expect(snap.lastUpdate.hasPrefix("Publit: ") && snap.lastUpdate.contains("Market analysis done"))
    }
}

@Suite struct HomeLayoutTests {
    let g = HomeGeometry(width: 1200, height: 820)
    var scale: TimeScale { TimeScale(range: .today, now: now) }

    private func distance(_ a: HomePoint, _ b: HomePoint) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }

    private func mixed(_ n: Int) -> [HomeItem] {
        let lanes: [HomeItem.Lane] = [.done, .planned, .running, .needsYou, .done, .planned, .done, .running, .planned, .done, .needsYou, .running]
        let offsets: [TimeInterval] = [-1800, 3600, -600, -120, -7200, 10800, -300, -2400, 900, -36000, -60, -100]
        return (0..<n).map { item("i\($0)", lanes[$0], offsets[$0]) }
    }

    private func assertNoOverlap(_ r: HomeLayoutResult) {
        for (i, a) in r.cards.enumerated() {
            #expect(a.center.x - g.cardWidth / 2 >= 0 && a.center.x + g.cardWidth / 2 <= g.width, "inside horizontally: \(a.id)")
            #expect(a.center.y - g.cardHeight / 2 >= 0 && a.center.y + g.cardHeight / 2 <= g.height, "inside vertically: \(a.id)")
            for b in r.cards.dropFirst(i + 1) {
                let apart = abs(a.center.x - b.center.x) >= g.cardWidth || abs(a.center.y - b.center.y) >= g.cardHeight
                #expect(apart, "\(a.id) overlaps \(b.id)")
            }
        }
    }

    @Test func cardsLieOnTheirRingsAndAnchorsOnTheClock() {
        let r = HomeLayout.place(mixed(6), geometry: g, scale: scale)
        #expect(r.cards.count == 6)
        for c in r.cards {
            let radius = c.ring == .inner ? g.innerRadius : g.outerCardRadius
            #expect(abs(distance(c.center, g.center) - radius) < 0.5)
            #expect(c.ring == (c.item.lane == .running ? .inner : .outer))
            if c.ring == .outer {
                let a = try! #require(c.anchor)
                #expect(abs(distance(a, g.center) - g.clockRadius) < 0.5)
                #expect(abs(c.timeAngle - scale.angle(for: c.item.date)) < 1e-9)
                #expect(c.item.lane == .planned ? c.timeAngle < 90 : c.timeAngle >= 90, "future right, past left")
            } else { #expect(c.anchor == nil) }
        }
        #expect(r.ticks.count == 9 && r.ticks.allSatisfy { abs(distance($0.point, g.center) - g.clockRadius) < 0.5 })
    }

    @Test(arguments: 1...12) func noOverlapForOneToTwelveCards(_ n: Int) {
        let r = HomeLayout.place(mixed(n), geometry: g, scale: scale)
        assertNoOverlap(r)
        #expect(r.cards.count + r.overflow.reduce(0) { $0 + $1.count } == n, "every item is a card or counted in +N")
    }

    @Test func overflowBecomesPlusN() {
        let many = (0..<7).map { item("run\($0)", .running, Double(-60 * ($0 + 1))) } + (0..<14).map { item("done\($0)", .done, Double(-300 * ($0 + 1))) }
        let r = HomeLayout.place(many, geometry: g, scale: scale, maxInner: 4, maxOuter: 8)
        assertNoOverlap(r)
        #expect(r.cards.filter { $0.ring == .inner }.count == 4)
        let badges = Dictionary(uniqueKeysWithValues: r.overflow.map { ($0.lane, $0) })
        #expect(badges[.running]?.count == 3)
        #expect(badges[.running]?.itemIDs == ["run0", "run1", "run2"], "the newest runs wait behind +N, the oldest stay on the ring")
        #expect((badges[.done]?.count ?? 0) >= 6)
        #expect(r.cards.filter { $0.ring == .outer }.count + (badges[.done]?.count ?? 0) == 14)
        // Closest to now win a spot.
        #expect(r.cards.contains { $0.id == "done0" })
        #expect(!r.cards.contains { $0.id == "done13" })
    }

    @Test func positionsAreStableAcrossInputOrderAndUpdates() {
        let items = mixed(10)
        let a = HomeLayout.place(items, geometry: g, scale: scale)
        let b = HomeLayout.place(items.reversed(), geometry: g, scale: scale)
        #expect(a == b)
        var updated = items
        updated[2].detail = "5 of 7 suites"
        updated[0].title = "Renamed"
        let c = HomeLayout.place(updated, geometry: g, scale: scale)
        #expect(a.cards.map(\.center) == c.cards.map(\.center), "a progress update does not move cards")
        #expect(a.cards.map(\.id) == c.cards.map(\.id))
    }

    @Test func runningCardsOldestLeftAndNeedsYouWins() {
        let items = [item("new", .running, -60), item("old", .running, -3000), item("mid", .running, -600)]
        let r = HomeLayout.place(items, geometry: g, scale: scale)
        let xs = Dictionary(uniqueKeysWithValues: r.cards.map { ($0.id, $0.center.x) })
        #expect(xs["old"]! < xs["mid"]! && xs["mid"]! < xs["new"]!)
        // A question near "now" keeps its spot even when finished runs crowd the same time.
        let crowd = (0..<8).map { item("d\($0)", .done, Double(-30 * ($0 + 1))) } + [item("ask", .needsYou, -90)]
        let r2 = HomeLayout.place(crowd, geometry: g, scale: scale, maxOuter: 8)
        let ask = try! #require(r2.cards.first { $0.id == "ask" })
        #expect(abs(ask.angle - ask.timeAngle) < 0.5)
    }

    @Test func smallWindowStillHasNoOverlap() {
        let small = HomeGeometry(width: 700, height: 560, cardWidth: 200, cardHeight: 72)
        let r = HomeLayout.place(mixed(12), geometry: small, scale: scale)
        for (i, a) in r.cards.enumerated() {
            for b in r.cards.dropFirst(i + 1) {
                #expect(abs(a.center.x - b.center.x) >= small.cardWidth || abs(a.center.y - b.center.y) >= small.cardHeight)
            }
        }
        #expect(r.cards.count + r.overflow.reduce(0) { $0 + $1.count } == 12)
    }
}
