import Foundation
import BasedCore

/// Layout and grouping for the agent control room: the Kanban board (sessions by status / project / agent) and the
/// canvas (one swimlane per project, sub-agent trees top-down). Pure value code so it is unit-tested on Linux.
public struct AgentGraph: Sendable, Equatable {
    public struct Node: Sendable, Equatable, Identifiable {
        public var id: RecordID { session.id }
        public var session: AgentSession
        public var status: AgentSession.Status
        public var depth: Int
        public var children: [RecordID]
        public var descendants: Int
        /// Center in canvas coordinates.
        public var x: Double
        public var y: Double
    }
    public struct Edge: Sendable, Equatable, Identifiable {
        public var id: String { from + ">" + to }
        public var from: RecordID
        public var to: RecordID
        /// The child is running — drawn animated.
        public var active: Bool
    }
    public struct Lane: Sendable, Equatable, Identifiable {
        public var id: String { name }
        public var name: String
        public var x: Double, y: Double, width: Double, height: Double
        public var running: Int, waiting: Int, done: Int, failed: Int, total: Int
        public var lastActivity: Date
    }

    public var nodes: [Node]
    public var edges: [Edge]
    public var lanes: [Lane]
    public var width: Double
    public var height: Double

    public static let nodeWidth = 236.0, nodeHeight = 92.0
    public static let columnWidth = 262.0, rowHeight = 136.0
    public static let laneHeader = 44.0, lanePadding = 22.0, laneGap = 28.0

    public func node(_ id: RecordID) -> Node? { nodes.first { $0.id == id } }

    public struct Options: Sendable {
        public var includeChats = false
        /// Only running / waiting sessions (plus their ancestors, for context).
        public var onlyActive = false
        public var since: Date?
        public var project: String?
        public init(includeChats: Bool = false, onlyActive: Bool = false, since: Date? = nil, project: String? = nil) {
            self.includeChats = includeChats; self.onlyActive = onlyActive; self.since = since; self.project = project
        }
    }

    public static func build(_ sessions: [AgentSession], working: Set<RecordID> = [], options: Options = .init()) -> AgentGraph {
        let byID = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func status(_ s: AgentSession) -> AgentSession.Status { s.effectiveStatus(working: working.contains(s.id)) }
        // Which sessions to show.
        var keep = Set<RecordID>()
        for s in sessions {
            // Chats are shown when they started coding agents.
            if s.isChat && !options.includeChats && !sessions.contains(where: { $0.parentID == s.id }) { continue }
            if options.onlyActive && !(status(s) == .running || status(s) == .waiting) { continue }
            if let since = options.since, s.updatedAt < since, !(status(s) == .running || status(s) == .waiting) { continue }
            keep.insert(s.id)
        }
        // Ancestors give context to active sub-agents.
        for id in keep {
            var cur = byID[id]?.parentID, seen: Set<RecordID> = [id]
            while let p = cur, let ps = byID[p], !seen.contains(p) { keep.insert(p); seen.insert(p); cur = ps.parentID }
        }
        var children: [RecordID: [RecordID]] = [:]
        var roots: [AgentSession] = []
        for s in sessions where keep.contains(s.id) {
            if let p = s.parentID, keep.contains(p), p != s.id, !isAncestor(s.id, of: p, byID) { children[p, default: []].append(s.id) }
            else { roots.append(s) }
        }
        for k in children.keys { children[k]!.sort { (byID[$0]?.startedAt ?? .distantPast) < (byID[$1]?.startedAt ?? .distantPast) } }

        // Subtree sizes (in columns) and depths.
        var width: [RecordID: Int] = [:], height: [RecordID: Int] = [:], desc: [RecordID: Int] = [:]
        func measure(_ id: RecordID, _ guardSet: Set<RecordID>) {
            let kids = (children[id] ?? []).filter { !guardSet.contains($0) }
            var w = 0, h = 0, d = 0
            for k in kids { measure(k, guardSet.union([id])); w += width[k]!; h = max(h, height[k]!); d += 1 + desc[k]! }
            width[id] = max(1, w); height[id] = h + 1; desc[id] = d
        }
        for r in roots { measure(r.id, []) }

        // Lanes = projects of the roots, most recently active first.
        func projectName(_ s: AgentSession) -> String {
            if s.isChat { return "AI chats" }
            if !s.project.isEmpty { return s.project }
            let n = URL(fileURLWithPath: s.cwd).lastPathComponent
            return n.isEmpty || s.cwd.isEmpty ? "No folder" : n
        }
        var laneRoots: [String: [AgentSession]] = [:]
        for r in roots { laneRoots[projectName(r), default: []].append(r) }
        if let p = options.project { laneRoots = laneRoots.filter { $0.key == p } }

        var nodes: [Node] = [], edges: [Edge] = [], lanes: [Lane] = []
        var lastActivity: [String: Date] = [:]
        func activity(_ id: RecordID) -> Date {
            var d = byID[id]?.updatedAt ?? .distantPast
            for k in children[id] ?? [] { d = max(d, activity(k)) }
            return d
        }
        for (name, rs) in laneRoots { lastActivity[name] = rs.map { activity($0.id) }.max() ?? .distantPast }
        let laneOrder = laneRoots.keys.sorted { (lastActivity[$0]!, $1) > (lastActivity[$1]!, $0) }

        var y = 0.0, maxWidth = 0.0
        for name in laneOrder {
            let rs = laneRoots[name]!.sorted { activity($0.id) > activity($1.id) }
            let cols = rs.reduce(0) { $0 + width[$1.id]! }
            let rows = rs.map { height[$0.id]! }.max() ?? 1
            let laneW = Double(cols) * columnWidth + 2 * lanePadding
            let laneH = laneHeader + Double(rows) * rowHeight + lanePadding - (rowHeight - nodeHeight)
            var counts = (running: 0, waiting: 0, done: 0, failed: 0, total: 0)
            var col = 0.0
            func place(_ id: RecordID, col0: Double, depth: Int, guardSet: Set<RecordID>) {
                guard let s = byID[id] else { return }
                let w = Double(width[id]!)
                let cx = lanePadding + (col0 + w / 2) * columnWidth
                let cy = y + laneHeader + Double(depth) * rowHeight + nodeHeight / 2
                let st = status(s)
                switch st { case .running: counts.running += 1; case .waiting: counts.waiting += 1; case .done: counts.done += 1; case .failed: counts.failed += 1; case .idle: break }
                counts.total += 1
                let kids = (children[id] ?? []).filter { !guardSet.contains($0) }
                nodes.append(Node(session: s, status: st, depth: depth, children: kids, descendants: desc[id] ?? 0, x: cx, y: cy))
                var c = col0
                for k in kids {
                    if let ks = byID[k] { edges.append(Edge(from: id, to: k, active: status(ks) == .running || status(ks) == .waiting)) }
                    place(k, col0: c, depth: depth + 1, guardSet: guardSet.union([id]))
                    c += Double(width[k]!)
                }
            }
            for r in rs { place(r.id, col0: col, depth: 0, guardSet: []); col += Double(width[r.id]!) }
            lanes.append(Lane(name: name, x: 0, y: y, width: laneW, height: laneH, running: counts.running, waiting: counts.waiting,
                              done: counts.done, failed: counts.failed, total: counts.total, lastActivity: lastActivity[name]!))
            maxWidth = max(maxWidth, laneW)
            y += laneH + laneGap
        }
        // All lanes share the widest width so the canvas reads as a table of swimlanes.
        for i in lanes.indices { lanes[i].width = max(maxWidth, 320) }
        return AgentGraph(nodes: nodes, edges: edges, lanes: lanes, width: max(maxWidth, 320), height: max(y - laneGap, 0))
    }

    static func isAncestor(_ a: RecordID, of b: RecordID, _ byID: [RecordID: AgentSession]) -> Bool {
        var cur = byID[b]?.parentID, seen: Set<RecordID> = []
        while let p = cur, !seen.contains(p) { if p == a { return true }; seen.insert(p); cur = byID[p]?.parentID }
        return false
    }

    // MARK: Board

    public enum Grouping: String, CaseIterable, Sendable { case status = "Status", project = "Project", agent = "Agent" }

    public struct Column: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var status: AgentSession.Status?
        public var sessions: [AgentSession]
    }

    /// Board order of status columns.
    public static let statusOrder: [AgentSession.Status] = [.running, .waiting, .idle, .done, .failed]

    public static func columns(_ sessions: [AgentSession], by grouping: Grouping, working: Set<RecordID> = [],
                               topLevelOnly: Bool = false, includeChats: Bool = false) -> [Column] {
        let shown = sessions.filter { (includeChats || !$0.isChat) && (!topLevelOnly || $0.parentID == nil) }
        switch grouping {
        case .status:
            let g = Dictionary(grouping: shown) { $0.effectiveStatus(working: working.contains($0.id)) }
            return statusOrder.map { st in
                Column(id: st.rawValue, title: st.rawValue, status: st, sessions: (g[st] ?? []).sorted { $0.updatedAt > $1.updatedAt })
            }
        case .project, .agent:
            let g = Dictionary(grouping: shown) { s -> String in
                if grouping == .agent { return s.agentID.isEmpty ? "?" : s.agentID }
                if !s.project.isEmpty { return s.project }
                let n = URL(fileURLWithPath: s.cwd).lastPathComponent
                return n.isEmpty || s.cwd.isEmpty ? "No folder" : n
            }
            return g.map { k, v in
                // Active work first, then newest.
                let sorted = v.sorted { a, b in
                    let ra = statusOrder.firstIndex(of: a.effectiveStatus(working: working.contains(a.id))) ?? 9
                    let rb = statusOrder.firstIndex(of: b.effectiveStatus(working: working.contains(b.id))) ?? 9
                    return ra != rb ? ra < rb : a.updatedAt > b.updatedAt
                }
                return Column(id: k, title: k, status: nil, sessions: sorted)
            }.sorted { ($0.sessions.first?.updatedAt ?? .distantPast) > ($1.sessions.first?.updatedAt ?? .distantPast) }
        }
    }
}

extension AgentSession {
    /// Status to display: a session with a turn in flight counts as running even before its row is updated.
    public func effectiveStatus(working: Bool) -> Status {
        if working && status != .waiting { return .running }
        return status
    }
}
