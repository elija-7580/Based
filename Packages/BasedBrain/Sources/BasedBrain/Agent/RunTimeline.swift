import Foundation

// BSD-108: data for the agent detail (one run, its parent main agent and sub-agents) and the project detail
// (two weeks back, one ahead, one lane per agent). Positions are fractions 0…1 of the visible range so the views only
// multiply by their width.

/// A bar on a timeline lane.
public struct TimelineBar: Sendable, Equatable, Identifiable {
    public enum State: String, Sendable { case done, running, waiting, planned, failed }
    public var id: RecordID
    public var title: String
    public var start: Date
    public var end: Date
    public var state: State
    /// Position in the visible range, 0…1 (clipped).
    public var x0: Double
    public var x1: Double

    public static func state(of r: AgentRun) -> State {
        switch r.status {
        case .done: return .done
        case .running: return .running
        case .waiting, .needsYou: return .waiting
        case .planned: return .planned
        case .failed, .cancelled: return .failed
        }
    }
}

/// One participant (main agent, agent, sub-agent) with its bars.
public struct TimelineLane: Sendable, Equatable, Identifiable {
    public enum Role: String, Sendable { case main, agent, subagent }
    public var id: String
    public var title: String
    public var role: Role
    public var bars: [TimelineBar]
}

/// Visible range and the "now" line.
public struct TimelineRange: Sendable, Equatable {
    public var start: Date
    public var end: Date
    public var now: Date
    public init(start: Date, end: Date, now: Date) {
        self.start = start; self.end = max(end, start.addingTimeInterval(1)); self.now = now
    }
    public var span: TimeInterval { end.timeIntervalSince(start) }
    public func x(_ d: Date) -> Double { min(1, max(0, d.timeIntervalSince(start) / span)) }
    public var nowX: Double { x(now) }
    public func overlaps(_ a: Date, _ b: Date) -> Bool { b >= start && a <= end }

    func bar(_ r: AgentRun, title: String? = nil) -> TimelineBar {
        let state = TimelineBar.state(of: r)
        // Running / waiting bars reach "now"; planned ones get a nominal hour so they are visible.
        let end: Date = r.endedAt ?? (state == .planned ? r.startedAt.addingTimeInterval(3600) : max(now, r.startedAt))
        return TimelineBar(id: r.id, title: title ?? r.title, start: r.startedAt, end: end, state: state, x0: x(r.startedAt), x1: x(end))
    }
}

/// The agent detail: key figures, one lane per participant, the steps.
public struct RunTimeline: Sendable, Equatable {
    public var run: AgentRun
    public var range: TimelineRange
    public var lanes: [TimelineLane]
    /// Running time so far (or in total when finished).
    public var duration: TimeInterval
    /// Finished sub-agents / all sub-agents (nil without sub-agents).
    public var progress: Double?
    /// Cost of the run and its sub-agents (euros).
    public var cost: Double
    public var tokens: Int
    /// Steps in start order: the sub-agents (title, state).
    public var steps: [TimelineBar]

    public static func make(run: AgentRun, parent: AgentRun? = nil, children: [AgentRun], now: Date) -> RunTimeline {
        let all = [run] + children + (parent.map { [$0] } ?? [])
        let first = all.map(\.startedAt).min() ?? run.startedAt
        let last = all.map { $0.endedAt ?? now }.max().map { max($0, now) } ?? now
        let pad = max(60, last.timeIntervalSince(first) * 0.05)
        let range = TimelineRange(start: first.addingTimeInterval(-pad), end: last.addingTimeInterval(pad), now: now)
        var lanes: [TimelineLane] = []
        if let parent {
            lanes.append(TimelineLane(id: "main", title: parent.kind == .main ? "Main agent" : parent.title,
                                      role: parent.kind == .main ? .main : .agent, bars: [range.bar(parent)]))
        }
        lanes.append(TimelineLane(id: "run", title: run.title, role: run.kind == .main ? .main : .agent, bars: [range.bar(run)]))
        let sorted = children.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
        for c in sorted {
            lanes.append(TimelineLane(id: c.id, title: c.title, role: .subagent, bars: [range.bar(c)]))
        }
        let finished = sorted.filter { $0.status.isTerminal }.count
        return RunTimeline(run: run, range: range, lanes: lanes,
                           duration: (run.endedAt ?? now).timeIntervalSince(run.startedAt),
                           progress: sorted.isEmpty ? nil : Double(finished) / Double(sorted.count),
                           cost: run.cost + children.reduce(0) { $0 + $1.cost }, tokens: run.tokens + children.reduce(0) { $0 + $1.tokens },
                           steps: sorted.map { range.bar($0) })
    }
}

/// The project detail: two weeks back, one week ahead, one lane per agent.
public struct ProjectTimeline: Sendable, Equatable {
    public var range: TimelineRange
    public var lanes: [TimelineLane]
    public var runCount: Int
    public var running: Int
    public var failed: Int
    public var cost: Double
    public var tokens: Int

    public static let back: TimeInterval = 14 * 86_400
    public static let ahead: TimeInterval = 7 * 86_400

    /// `agentName` gives the lane title of an agent row (nil → the run's engine or "Chat").
    public static func make(runs: [AgentRun], now: Date, agentName: (RecordID) -> String? = { _ in nil }) -> ProjectTimeline {
        let range = TimelineRange(start: now.addingTimeInterval(-back), end: now.addingTimeInterval(ahead), now: now)
        var lanes: [TimelineLane] = []
        var index: [String: Int] = [:]
        let visible = runs.filter { r in
            let b = range.bar(r)
            return range.overlaps(b.start, b.end)
        }.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
        for r in visible {
            let key: String, title: String, role: TimelineLane.Role
            if r.kind == .main { key = "main"; title = "Main agent"; role = .main }
            else if let a = r.agentID { key = "agent:" + a; title = agentName(a) ?? "Agent"; role = .agent }
            else if r.kind == .subagent { key = "sub"; title = "Sub-agents"; role = .subagent }
            else { key = "engine:" + (r.engine.isEmpty ? r.kind.rawValue : r.engine); title = r.engine.isEmpty ? r.kind.rawValue : r.engine; role = .agent }
            if index[key] == nil { index[key] = lanes.count; lanes.append(TimelineLane(id: key, title: title, role: role, bars: [])) }
            lanes[index[key]!].bars.append(range.bar(r))
        }
        // Main agent first, then by first activity.
        lanes = lanes.filter { $0.role == .main } + lanes.filter { $0.role != .main }
        return ProjectTimeline(range: range, lanes: lanes, runCount: visible.count,
                               running: visible.filter { $0.status == .running }.count,
                               failed: visible.filter { $0.status == .failed }.count,
                               cost: visible.reduce(0) { $0 + $1.cost }, tokens: visible.reduce(0) { $0 + $1.tokens })
    }
}
