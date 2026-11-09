import Foundation
import BasedCore

// BSD-55: the AI home screen – a rising sun (the main agent) with orbits. The outer ring is a clock: "now" at the
// top, the past to the left, the future to the right, stretched near "now" (square-root scale). Finished runs,
// questions and planned agents sit on it at the angle of their time; running agents sit on the inner ring.
// Everything here is pure (data in, positions out) and tested on Linux; the SwiftUI view only draws.

/// Today · Week · Month: how much time the clock ring covers on each side of "now".
public enum HomeRange: String, CaseIterable, Sendable {
    case today = "Today", week = "Week", month = "Month"

    /// Time covered on each side of "now".
    public var span: TimeInterval {
        switch self {
        case .today: return 12 * 3600
        case .week: return 7 * 86400
        case .month: return 30 * 86400
        }
    }

    /// Tick offsets (seconds, past negative) drawn on the ring.
    public var tickOffsets: [TimeInterval] {
        let h = 3600.0, d = 86400.0
        switch self {
        case .today: return [-12 * h, -6 * h, -3 * h, -1 * h, 0, h, 3 * h, 6 * h, 12 * h]
        case .week: return [-7 * d, -3 * d, -d, -6 * h, 0, 6 * h, d, 3 * d, 7 * d]
        case .month: return [-30 * d, -14 * d, -7 * d, -2 * d, 0, 2 * d, 7 * d, 14 * d, 30 * d]
        }
    }
}

/// Time ↔ angle on the clock ring. Angles in degrees: 90 = now (top), larger = past (left), smaller = future.
public struct TimeScale: Sendable, Equatable {
    public var range: HomeRange
    public var now: Date
    /// Degrees from "now" to either end of the range.
    public var maxSpan: Double

    public init(range: HomeRange, now: Date, maxSpan: Double = 52) {
        self.range = range; self.now = now; self.maxSpan = maxSpan
    }

    /// Angle for a time; times beyond the range are clamped to the ends.
    public func angle(for date: Date) -> Double {
        let dt = date.timeIntervalSince(now)
        let f = (min(abs(dt), range.span) / range.span).squareRoot()
        return 90 - (dt < 0 ? -1 : 1) * maxSpan * f
    }

    /// Inverse of `angle(for:)` (inside the range).
    public func date(forAngle angle: Double) -> Date {
        let off = max(-1, min(1, (90 - angle) / maxSpan))
        let dt = off * off * range.span * (off < 0 ? -1 : 1)
        return now.addingTimeInterval(dt)
    }

    public func contains(_ date: Date) -> Bool { abs(date.timeIntervalSince(now)) <= range.span }

    public struct Tick: Sendable, Equatable {
        public var offset: TimeInterval
        public var angle: Double
        public var label: String
        public var isNow: Bool { offset == 0 }
    }

    public var ticks: [Tick] {
        range.tickOffsets.map { off in Tick(offset: off, angle: angle(for: now.addingTimeInterval(off)), label: Self.label(off)) }
    }

    /// "−12 h", "now", "+3 d".
    public static func label(_ offset: TimeInterval) -> String {
        if offset == 0 { return "now" }
        let sign = offset < 0 ? "−" : "+"
        let a = abs(offset)
        if a >= 86400, a.truncatingRemainder(dividingBy: 86400) == 0 { return "\(sign)\(Int(a / 86400)) d" }
        if a >= 3600 { return "\(sign)\(Int((a / 3600).rounded())) h" }
        return "\(sign)\(Int((a / 60).rounded())) min"
    }
}

/// One card on the home screen.
public struct HomeItem: Sendable, Identifiable, Equatable {
    public enum Lane: String, CaseIterable, Sendable { case running, needsYou, done, planned }
    public struct Option: Sendable, Equatable { public var id: String; public var label: String }

    public var id: String
    public var lane: Lane
    public var title: String
    /// Project or agent name.
    public var subtitle: String
    /// Current step, result or question.
    public var detail: String
    /// The time the card belongs to: start (running), question (needs you), end (done), next run (planned).
    public var date: Date
    public var model: String = ""
    public var failed: Bool = false
    /// Running sub-agents (dots on a running card).
    public var subagents: Int = 0
    public var runID: RecordID? = nil
    public var inboxID: RecordID? = nil
    public var agentID: RecordID? = nil
    public var projectID: RecordID? = nil
    public var resultPageID: RecordID? = nil
    /// Answers for a question/permission card (Allow · Always · No).
    public var options: [Option] = []
}

/// Everything the home screen shows, built from the Runs/Inbox/Agents/Projects data (pure, clock injected).
public struct HomeSnapshot: Sendable, Equatable {
    public var items: [HomeItem]
    public var greeting: String
    /// "While you were away: …" (empty when nothing happened).
    public var summary: String
    /// Latest update the main agent wrote into a project ("Latest updates").
    public var lastUpdate: String
    public var costToday: Double
    /// BSD-57: today's daily brief (its headline and page), empty when it has not run yet.
    public var brief: String = ""
    public var briefPageID: RecordID? = nil

    public func items(in lane: HomeItem.Lane) -> [HomeItem] { items.filter { $0.lane == lane } }

    /// Kinds that appear as cards: chat turns and the main agent's own turns are the conversation, not work items.
    static let cardKinds: Set<AgentRun.Kind> = [.session, .schedule, .subagent]

    public static func make(overview: RunOverview, projects: [AgentProject] = [], lastUpdate: String = "", userName: String = "",
                            lastSeen: Date? = nil, now: Date, range: HomeRange, calendar: Calendar = .current) -> HomeSnapshot {
        let scale = TimeScale(range: range, now: now)
        let projectNames = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        let agentNames = Dictionary(overview.agents.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        func subtitle(_ r: AgentRun) -> String {
            r.projectID.flatMap { projectNames[$0] } ?? r.agentID.flatMap { agentNames[$0] } ?? r.engine
        }
        var items: [HomeItem] = []
        var seenRuns = Set<RecordID>()

        // Needs you: every pending question/permission is its own card (answerable on the card).
        let runsBySession = Dictionary(overview.runs.compactMap { r in r.sessionID.map { ($0, r) } }, uniquingKeysWith: { a, b in a.startedAt >= b.startedAt ? a : b })
        for i in overview.inbox where i.status == .pending && i.kind != .notice {
            let run = i.sessionID.flatMap { runsBySession[$0] }
            if let run { seenRuns.insert(run.id) }
            items.append(HomeItem(id: "inbox:" + i.id, lane: .needsYou, title: i.title, subtitle: run.map(subtitle) ?? "",
                                  detail: i.detail, date: i.createdAt, model: run?.model ?? "", runID: run?.id, inboxID: i.id,
                                  agentID: run?.agentID, projectID: run?.projectID,
                                  options: i.options.compactMap { o in
                                      let p = o.split(separator: "=", maxSplits: 1).map(String.init)
                                      return p.count == 2 ? HomeItem.Option(id: p[0], label: p[1]) : HomeItem.Option(id: o, label: o)
                                  }))
        }
        for r in overview.needsYou where !seenRuns.contains(r.id) && cardKinds.contains(r.kind) {
            seenRuns.insert(r.id)
            items.append(HomeItem(id: "run:" + r.id, lane: .needsYou, title: r.title, subtitle: subtitle(r), detail: r.result,
                                  date: r.startedAt, model: r.model, runID: r.id, agentID: r.agentID, projectID: r.projectID))
        }
        // Running: inner ring.
        let running = overview.running
        for r in running where !seenRuns.contains(r.id) && cardKinds.contains(r.kind) {
            let subs = running.filter { $0.parentID == r.id }.count
            items.append(HomeItem(id: "run:" + r.id, lane: .running, title: r.title, subtitle: subtitle(r), detail: r.result,
                                  date: r.startedAt, model: r.model, subagents: subs, runID: r.id, agentID: r.agentID, projectID: r.projectID))
        }
        // Done (and failed) within the range.
        for r in overview.finishedSince(now.addingTimeInterval(-range.span)) where cardKinds.contains(r.kind) && r.status != .cancelled {
            items.append(HomeItem(id: "run:" + r.id, lane: .done, title: r.title, subtitle: subtitle(r), detail: r.result,
                                  date: r.endedAt ?? r.startedAt, model: r.model, failed: r.status == .failed, runID: r.id,
                                  agentID: r.agentID, projectID: r.projectID, resultPageID: r.resultPageID))
        }
        // Planned: next scheduled run of each agent inside the range (the main agent's heartbeat is not a card).
        let mainIDs = Set(overview.agents.filter(\.isMain).map(\.id))
        for u in overview.upcoming(now: now, limit: 50, calendar: calendar) where !mainIDs.contains(u.agent.id) && scale.contains(u.at) {
            items.append(HomeItem(id: "agent:" + u.agent.id, lane: .planned, title: u.agent.name, subtitle: "", detail: "",
                                  date: u.at, model: u.agent.model ?? "", agentID: u.agent.id))
        }

        let hour = calendar.component(.hour, from: now)
        let part = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
        let greeting = userName.isEmpty ? "\(part)." : "\(part), \(userName)."
        return HomeSnapshot(items: items, greeting: greeting, summary: summary(items, since: lastSeen, projectNames: projectNames),
                            lastUpdate: lastUpdate, costToday: overview.costToday(now: now, calendar: calendar))
    }

    /// "While you were away: Market analysis finished, 2 agents are working on Based, 1 approval is waiting."
    static func summary(_ items: [HomeItem], since: Date?, projectNames: [RecordID: String]) -> String {
        var parts: [String] = []
        let isNew: (HomeItem) -> Bool = { item in since.map { item.date >= $0 } ?? true }
        let done = items.filter { $0.lane == .done && !$0.failed && isNew($0) }
        if let first = done.max(by: { $0.date < $1.date }) {
            parts.append(done.count == 1 ? "\(first.title) finished" : "\(first.title) and \(done.count - 1) more finished")
        }
        let failed = items.filter { $0.lane == .done && $0.failed && isNew($0) }.count
        if failed > 0 { parts.append(failed == 1 ? "1 run failed" : "\(failed) runs failed") }
        let running = items.filter { $0.lane == .running }
        if !running.isEmpty {
            let projects = Set(running.compactMap { $0.projectID.flatMap { projectNames[$0] } })
            let agents = running.count == 1 ? "1 agent is" : "\(running.count) agents are"
            parts.append(projects.count == 1 ? "\(agents) working on \(projects.first!)" : "\(agents) working")
        }
        let waiting = items.filter { $0.lane == .needsYou }.count
        if waiting > 0 { parts.append(waiting == 1 ? "1 approval is waiting" : "\(waiting) approvals are waiting") }
        guard !parts.isEmpty else { return "" }
        return "While you were away: " + parts.joined(separator: ", ") + "."
    }
}

public extension BrainStore {
    /// The home screen's data from the Brain databases (reads only; never creates them).
    func homeSnapshot(now: Date = Date(), range: HomeRange, userName: String = "", lastSeen: Date? = nil) -> HomeSnapshot {
        let overview = RunOverview(runs: runs(), inbox: inbox(pendingOnly: true), agents: agents())
        let projects = existingProjectsDB == nil ? [] : self.projects()
        let update = projects.filter { $0.status == .active }.sorted { $0.updatedAt > $1.updatedAt }
            .lazy.compactMap { p in self.latestUpdates(ofProject: p.id, limit: 1).first.map { "\(p.name): \($0)" } }.first ?? ""
        var snap = HomeSnapshot.make(overview: overview, projects: projects, lastUpdate: update, userName: userName, lastSeen: lastSeen,
                                     now: now, range: range)
        if let b = todaysBrief(now: now) { snap.brief = b.summary; snap.briefPageID = b.page }
        return snap
    }
}

// MARK: - Layout

public struct HomePoint: Sendable, Equatable {
    public var x: Double, y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// Where sun and rings sit in a view of the given size.
public struct HomeGeometry: Sendable, Equatable {
    public var width: Double, height: Double
    public var cardWidth: Double, cardHeight: Double
    public var gap: Double

    public init(width: Double, height: Double, cardWidth: Double = 240, cardHeight: Double = 84, gap: Double = 10) {
        self.width = width; self.height = height; self.cardWidth = cardWidth; self.cardHeight = cardHeight; self.gap = gap
    }

    /// Sun centre: horizontally centred, just below the bottom edge (a rising sun).
    public var center: HomePoint { HomePoint(x: width / 2, y: height * 1.08) }
    /// Clock ring (time ticks and dots).
    public var clockRadius: Double { max(120, min(width * 0.47, center.y - 70)) }
    /// Cards for finished / waiting / planned items sit just inside the clock ring.
    public var outerCardRadius: Double { clockRadius * 0.80 }
    /// Running agents.
    public var innerRadius: Double { clockRadius * 0.52 }

    public func point(angle: Double, radius: Double) -> HomePoint {
        let r = angle * .pi / 180
        return HomePoint(x: center.x + radius * cos(r), y: center.y - radius * sin(r))
    }
}

public struct PlacedCard: Sendable, Equatable, Identifiable {
    public enum Ring: String, Sendable { case inner, outer }
    public var id: String { item.id }
    public var item: HomeItem
    public var ring: Ring
    /// Angle the card was placed at (may be nudged away from `timeAngle` to avoid overlaps).
    public var angle: Double
    /// Angle of the item's time on the clock ring (the dot the card is connected to).
    public var timeAngle: Double
    public var center: HomePoint
    /// Dot on the clock ring (outer cards) – nil for running cards.
    public var anchor: HomePoint?
}

/// "+N" for cards that did not fit.
public struct OverflowBadge: Sendable, Equatable {
    public var lane: HomeItem.Lane
    public var count: Int
    public var center: HomePoint
    public var itemIDs: [String]
}

public struct HomeLayoutResult: Sendable, Equatable {
    public var cards: [PlacedCard]
    public var overflow: [OverflowBadge]
    public var ticks: [(tick: TimeScale.Tick, point: HomePoint)]

    public static func == (a: HomeLayoutResult, b: HomeLayoutResult) -> Bool {
        a.cards == b.cards && a.overflow == b.overflow && a.ticks.map(\.tick) == b.ticks.map(\.tick) && a.ticks.map(\.point) == b.ticks.map(\.point)
    }
}

public enum HomeLayout {
    /// Places the cards: running on the inner ring (oldest left), the rest at the angle of their time on the
    /// outer ring, nudged sideways until no two cards overlap. What doesn't fit (more than `maxInner`/`maxOuter`,
    /// or no free spot) becomes a "+N" badge per lane. Deterministic: the same items give the same positions,
    /// whatever their input order.
    public static func place(_ items: [HomeItem], geometry g: HomeGeometry, scale: TimeScale,
                             maxInner: Int = 4, maxOuter: Int = 8) -> HomeLayoutResult {
        var placed: [PlacedCard] = []
        var overflow: [HomeItem.Lane: [String]] = [:]

        func overlaps(_ c: HomePoint) -> Bool {
            placed.contains { abs($0.center.x - c.x) < g.cardWidth + g.gap && abs($0.center.y - c.y) < g.cardHeight + g.gap }
        }
        func inside(_ c: HomePoint) -> Bool {
            c.x - g.cardWidth / 2 >= 0 && c.x + g.cardWidth / 2 <= g.width && c.y - g.cardHeight / 2 >= 0 && c.y + g.cardHeight / 2 <= g.height
        }
        /// Nearest free angle to `desired` (1° steps, both directions) within [lo, hi].
        func freeAngle(_ desired: Double, radius: Double, lo: Double, hi: Double) -> Double? {
            let start = max(lo, min(hi, desired))
            for k in 0...Int(hi - lo) {
                for a in (k == 0 ? [start] : [start + Double(k), start - Double(k)]) where a >= lo && a <= hi {
                    let p = g.point(angle: a, radius: radius)
                    if inside(p) && !overlaps(p) { return a }
                }
            }
            return nil
        }

        // Inner ring: running, oldest on the left; evenly spread around "now".
        let running = items.filter { $0.lane == .running }.sorted { ($0.date, $0.id) < ($1.date, $1.id) }
        let shown = Array(running.prefix(maxInner))
        let step = shown.count > 1 ? min(34, 110 / Double(shown.count - 1)) : 0
        for (i, item) in shown.enumerated() {
            let desired = 90 + (Double(shown.count - 1) / 2 - Double(i)) * step
            if let a = freeAngle(desired, radius: g.innerRadius, lo: 20, hi: 160) {
                placed.append(PlacedCard(item: item, ring: .inner, angle: a, timeAngle: scale.angle(for: item.date),
                                         center: g.point(angle: a, radius: g.innerRadius), anchor: nil))
            } else { overflow[.running, default: []].append(item.id) }
        }
        overflow[.running, default: []] += running.dropFirst(maxInner).map(\.id)

        // Outer ring: needs you first, then closest to now; ties by id.
        let lo = 90 - scale.maxSpan - 14, hi = 90 + scale.maxSpan + 14
        let priority: [HomeItem.Lane: Int] = [.needsYou: 0, .done: 1, .planned: 1, .running: 2]
        let outer = items.filter { $0.lane != .running && ($0.lane == .needsYou || scale.contains($0.date)) }
            .sorted {
                let pa = priority[$0.lane]!, pb = priority[$1.lane]!
                if pa != pb { return pa < pb }
                let da = abs($0.date.timeIntervalSince(scale.now)), db = abs($1.date.timeIntervalSince(scale.now))
                return da != db ? da < db : $0.id < $1.id
            }
        var outerCount = 0
        for item in outer {
            let t = scale.angle(for: item.date)
            if outerCount < maxOuter, let a = freeAngle(t, radius: g.outerCardRadius, lo: lo, hi: hi) {
                placed.append(PlacedCard(item: item, ring: .outer, angle: a, timeAngle: t,
                                         center: g.point(angle: a, radius: g.outerCardRadius), anchor: g.point(angle: t, radius: g.clockRadius)))
                outerCount += 1
            } else {
                overflow[item.lane, default: []].append(item.id)
            }
        }

        // Badges: done/needs-you at the left end, planned at the right end, running under the inner ring.
        var badges: [OverflowBadge] = []
        for lane in HomeItem.Lane.allCases {
            guard let ids = overflow[lane], !ids.isEmpty else { continue }
            let at: HomePoint
            switch lane {
            case .running: at = g.point(angle: 90, radius: g.innerRadius * 0.62)
            case .planned: at = g.point(angle: lo - 4, radius: g.clockRadius * 0.95)
            case .done: at = g.point(angle: hi + 4, radius: g.clockRadius * 0.95)
            case .needsYou: at = g.point(angle: hi + 4, radius: g.clockRadius * 0.80)
            }
            badges.append(OverflowBadge(lane: lane, count: ids.count, center: at, itemIDs: ids.sorted()))
        }
        let cards = placed.sorted { ($0.ring.rawValue, $0.angle, $0.id) > ($1.ring.rawValue, $1.angle, $1.id) }
        let ticks = scale.ticks.map { ($0, g.point(angle: $0.angle, radius: g.clockRadius)) }
        return HomeLayoutResult(cards: cards, overflow: badges, ticks: ticks)
    }
}
