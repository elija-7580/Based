import SwiftUI
import BasedCore
import BasedBrain

// Agent control room visualisations: a Kanban board of sessions (by status / project / agent) and a canvas showing
// every project as a swimlane with its agent trees (sub-agents below their parent), live status and activity.

extension AgentSession.Status {
    var symbol: String {
        switch self {
        case .idle: return "pause.circle"
        case .running: return "bolt.circle.fill"
        case .waiting: return "hand.raised.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        }
    }
}

extension View {
    /// Checkbox on macOS, small switch on iOS.
    @ViewBuilder func compactToggle() -> some View {
        #if os(macOS)
        self.toggleStyle(.checkbox)
        #else
        self.toggleStyle(.switch).fixedSize()
        #endif
    }
}

/// Status dot that pulses while the agent works.
struct StatusDot: View {
    let status: AgentSession.Status
    var size: CGFloat = 8
    @State private var pulse = false
    var body: some View {
        ZStack {
            if status == .running || status == .waiting {
                Circle().fill(status.color.opacity(0.35))
                    .frame(width: size * 2.2, height: size * 2.2)
                    .scaleEffect(pulse ? 1 : 0.4)
                    .opacity(pulse ? 0 : 0.9)
                    .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulse)
            }
            Circle().fill(status.color).frame(width: size, height: size)
        }
        .frame(width: size * 2.2, height: size * 2.2)
        .onAppear { pulse = true }
    }
}

/// Shared context menu for a session on the board / canvas.
struct AgentSessionMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let session: AgentSession
    var body: some View {
        Button("Open console", systemImage: "terminal") { model.openSession(session.id) }
        Button("New sub-agent…", systemImage: "arrow.turn.down.right") { model.newSubAgent(of: session.id) }
        if let p = happier.parent(of: session) {
            Button("Open parent “\(p.title.nonEmptyOr("Untitled"))”", systemImage: "arrow.turn.left.up") { model.openSession(p.id) }
        }
        Divider()
        Button("Interrupt", systemImage: "stop.circle") { happier.cancel(session.id) }.disabled(!happier.isWorking(session.id))
        Button("Stop agent", systemImage: "power") { happier.stop(session.id) }.disabled(!happier.isLive(session.id) && !happier.isWorking(session.id))
        if let c = session.claudeSessionID {
            Button("Copy resume command", systemImage: "doc.on.doc") { Clipboard.copy("cd '\(session.cwd)' && claude --resume \(c)") }
        }
        Divider()
        Button("Delete session", systemImage: "trash", role: .destructive) {
            if model.agentSessionID == session.id { model.agentSessionID = nil }
            happier.deleteSession(session.id)
        }
    }
}

// MARK: - Board

struct AgentBoardView: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    @AppStorage("agents.board.group") private var groupingRaw = AgentGraph.Grouping.status.rawValue
    @AppStorage("agents.board.topLevel") private var topLevelOnly = false
    @AppStorage("agents.board.chats") private var includeChats = false
    @State private var filter = ""
    @State private var dropTarget: String?

    private var grouping: AgentGraph.Grouping { AgentGraph.Grouping(rawValue: groupingRaw) ?? .status }

    private var columns: [AgentGraph.Column] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        let s = happier.sessions.filter { q.isEmpty || $0.title.localizedCaseInsensitiveContains(q) || $0.projectName.localizedCaseInsensitiveContains(q) || $0.task.localizedCaseInsensitiveContains(q) }
        return AgentGraph.columns(s, by: grouping, working: happier.workingSet, topLevelOnly: topLevelOnly, includeChats: includeChats)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Picker("Group by", selection: $groupingRaw) {
                    ForEach(AgentGraph.Grouping.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
                .pickerStyle(.menu).fixedSize()
                Toggle("Top-level only", isOn: $topLevelOnly).compactToggle()
                Toggle("AI chats", isOn: $includeChats).compactToggle()
                Spacer()
                TextField("Filter", text: $filter).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
            }
            .controlSize(.small)
            .padding(.horizontal, 16).padding(.vertical, 8)
            Divider()
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(columns) { column(for: $0) }
                    if columns.isEmpty || columns.allSatisfy({ $0.sessions.isEmpty }) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("No agent sessions yet").font(.headline)
                            Text("Start a session — agents can start sub-agents, which show up here and on the canvas.").foregroundStyle(Theme.secondary)
                            Button { model.showNewSession = true } label: { Label("New session", systemImage: "plus") }
                        }
                        .frame(width: 280, alignment: .leading)
                        .padding(.top, 20)
                    }
                }
                .padding(16)
            }
        }
        .accessibilityIdentifier("agents.board")
    }

    private func column(for c: AgentGraph.Column) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let st = c.status {
                    Image(systemName: st.symbol).foregroundStyle(st.color)
                } else if grouping == .agent {
                    AgentIcon(icon: happier.agent(c.id)?.icon ?? "terminal", size: 12)
                } else {
                    Image(systemName: "folder").foregroundStyle(Theme.secondary)
                }
                Text(grouping == .agent ? (happier.agent(c.id)?.name ?? c.title) : c.title).font(.system(size: 13, weight: .semibold))
                Text("\(c.sessions.count)").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                Spacer()
                if c.status == nil || c.status == .running {
                    Button { model.showNewSession = true } label: { Image(systemName: "plus") }
                        .buttonStyle(.quiet).foregroundStyle(Theme.secondary).help("New session")
                }
            }
            .padding(.horizontal, 4)
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    ForEach(c.sessions) { s in
                        AgentCard(session: s)
                            .draggable(s.id)
                    }
                }
                .padding(.bottom, 12)
            }
        }
        .padding(8)
        .frame(width: 290)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 10).fill((c.status?.color ?? Color.primary).opacity(dropTarget == c.id ? 0.14 : 0.045)))
        .dropDestination(for: String.self) { ids, _ in
            guard let st = c.status else { return false }
            for id in ids { happier.move(id, to: st, model: model) }
            return true
        } isTargeted: { dropTarget = $0 ? c.id : (dropTarget == c.id ? nil : dropTarget) }
    }
}

/// One session on the board: task, live activity or result, pending approval, sub-agents and parent.
struct AgentCard: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let session: AgentSession
    @State private var hover = false

    var body: some View {
        let st = happier.status(of: session)
        let kids = happier.children(of: session.id)
        let pending = happier.pendingInbox(for: session.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 7) {
                AgentIcon(icon: happier.agent(session.agentID)?.icon ?? "terminal", size: 13).frame(width: 16).padding(.top, 1)
                Text(session.title.nonEmptyOr("Untitled session")).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                Spacer(minLength: 4)
                StatusDot(status: st, size: 7)
            }
            if let p = happier.parent(of: session) {
                Button { model.openSession(p.id, console: false) } label: {
                    Label(p.title.nonEmptyOr("Untitled"), systemImage: "arrow.turn.left.up").lineLimit(1)
                }
                .buttonStyle(.hoverFill).font(.system(size: 11)).foregroundStyle(Theme.secondary)
                .help("Started by this session")
            }
            if !session.task.isEmpty {
                Text(session.task).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(3)
            }
            if st == .running, let a = happier.activity(session.id) {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    Text(a).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                }
                .foregroundStyle(Color.blue)
            } else if (st == .done || st == .failed), !session.result.isEmpty {
                Text(session.result).font(.system(size: 12)).lineLimit(3)
                    .padding(6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 5).fill(st.color.opacity(0.08)))
            }
            if let item = pending.first {
                VStack(alignment: .leading, spacing: 5) {
                    Label(item.title, systemImage: "hand.raised.fill").font(.system(size: 12, weight: .medium)).foregroundStyle(.orange).lineLimit(2)
                    HStack(spacing: 6) {
                        let opts = PermissionPrompt.options(item)
                        if let allow = opts.first(where: { $0.id.hasPrefix("allow") }) {
                            Button("Allow") { happier.resolve(item, decision: allow.id) }.buttonStyle(.borderedProminent).tint(.orange)
                        }
                        if let deny = opts.first(where: { $0.id.hasPrefix("reject") }) {
                            Button("Deny") { happier.resolve(item, decision: deny.id) }
                        }
                        if pending.count > 1 { Text("+\(pending.count - 1)").foregroundStyle(Theme.secondary) }
                    }
                    .controlSize(.small)
                }
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.orange.opacity(0.1)))
            }
            HStack(spacing: 6) {
                Text(session.projectName).lineLimit(1)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.primary.opacity(0.06)))
                if !kids.isEmpty {
                    let active = kids.filter { happier.status(of: $0) == .running || happier.status(of: $0) == .waiting }.count
                    Label("\(kids.count)\(active > 0 ? " · \(active) active" : "")", systemImage: "arrow.turn.down.right")
                        .help("Sub-agents")
                }
                Spacer()
                if session.tokens > 0 { Text(Self.tokens(session.tokens)) }
                Text(session.updatedAt.formatted(.relative(presentation: .numeric)))
            }
            .font(.system(size: 10.5)).foregroundStyle(Theme.secondary).lineLimit(1)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Chrome.appBackground).shadow(color: .black.opacity(hover ? 0.14 : 0.07), radius: hover ? 5 : 2, y: 1))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(st == .waiting ? Color.orange.opacity(0.7) : Color(Theme.divider)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.openSession(session.id) }
        .contextMenu { AgentSessionMenu(session: session) }
        .accessibilityIdentifier("agents.card")
    }

    static func tokens(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM tok", Double(n) / 1_000_000) : n >= 1000 ? String(format: "%.1fk tok", Double(n) / 1000) : "\(n) tok"
    }
}

extension HappierModel {
    /// Board drag & drop: Done stops the agent, Idle interrupts it, Running opens the console to continue.
    func move(_ sid: RecordID, to status: AgentSession.Status, model: AppModel) {
        guard let s = sessions.first(where: { $0.id == sid }), self.status(of: s) != status else { return }
        switch status {
        case .done:
            if isWorking(sid) { cancel(sid) }
            stop(sid)
            // runtime.stop() resets the row to Idle on the main actor; mark it Done after that.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 80_000_000)
                self.brain.updateSession(sid, status: .done)
                self.refresh()
            }
        case .idle:
            if isWorking(sid) { cancel(sid) }
            brain.updateSession(sid, status: .idle)
        case .running:
            model.openSession(sid)
        case .waiting, .failed:
            return
        }
        refresh()
    }
}

// MARK: - Canvas

/// Swimlanes per project with agent trees; pan by scrolling/dragging, zoom with pinch or the buttons; click a
/// node for details, double-click to open its console.
struct AgentCanvasView: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    @AppStorage("agents.canvas.zoom") private var zoom = 1.0
    @AppStorage("agents.canvas.active") private var onlyActive = false
    @AppStorage("agents.canvas.range") private var range = "7d"
    @AppStorage("agents.canvas.chats") private var includeChats = false
    @State private var pinch: CGFloat = 1
    @State private var selected: RecordID?
    @State private var viewport: CGSize = .zero

    private static let margin: CGFloat = 40

    private var graph: AgentGraph {
        let since: Date? = {
            switch range {
            case "24h": return Date().addingTimeInterval(-86_400)
            case "7d": return Date().addingTimeInterval(-7 * 86_400)
            case "30d": return Date().addingTimeInterval(-30 * 86_400)
            default: return nil
            }
        }()
        return AgentGraph.build(happier.sessions, working: happier.workingSet,
                                options: .init(includeChats: includeChats, onlyActive: onlyActive, since: since))
    }

    private var scheduled: [Agent] { happier.brain.agents().filter { $0.enabled && ($0.schedule?.isEmpty == false) } }

    var body: some View {
        let g = graph
        let z = CGFloat(zoom) * pinch
        HStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                GeometryReader { geo in
                    ScrollView([.horizontal, .vertical]) {
                        canvasContent(g)
                            .frame(width: g.width, height: g.height, alignment: .topLeading)
                            .padding(Self.margin)
                            .scaleEffect(z, anchor: .topLeading)
                            .frame(width: (g.width + 2 * Self.margin) * z, height: (g.height + 2 * Self.margin) * z, alignment: .topLeading)
                    }
                    .background(CanvasGrid().opacity(0.6))
                    .onAppear { viewport = geo.size }
                    .onChange(of: geo.size) { _, s in viewport = s }
                }
                .gesture(MagnifyGesture()
                    .onChanged { pinch = $0.magnification }
                    .onEnded { v in zoom = Double(min(2.0, max(0.25, CGFloat(zoom) * v.magnification))); pinch = 1 })
                .onTapGesture { selected = nil }
                toolbar(g)
                if g.nodes.isEmpty { emptyState }
            }
            if let sid = selected, let s = happier.sessions.first(where: { $0.id == sid }) {
                Divider()
                AgentInspector(session: s, select: { selected = $0 }, close: { selected = nil })
                    .frame(width: 330)
            }
        }
        .accessibilityIdentifier("agents.canvas")
    }

    @ViewBuilder
    private func canvasContent(_ g: AgentGraph) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(g.lanes) { lane in
                LaneBackground(lane: lane, cwd: g.nodes.first { $0.depth == 0 && laneName($0.session) == lane.name }?.session.cwd)
                    .frame(width: lane.width, height: lane.height)
                    .offset(x: lane.x, y: lane.y)
            }
            EdgeShape(graph: g, active: false).stroke(Theme.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            TimelineView(.periodic(from: .now, by: 0.06)) { ctx in
                let phase = CGFloat(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2) * 16
                EdgeShape(graph: g, active: true)
                    .stroke(Color.blue.opacity(0.85), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 10], dashPhase: -phase))
            }
            ForEach(g.nodes) { n in
                CanvasNode(node: n, selected: selected == n.id)
                    .frame(width: AgentGraph.nodeWidth, height: AgentGraph.nodeHeight)
                    .position(x: n.x, y: n.y)
                    .onTapGesture(count: 2) { model.openSession(n.id) }
                    .onTapGesture { selected = n.id }
            }
        }
    }

    private func laneName(_ s: AgentSession) -> String { s.isChat ? "AI chats" : s.projectName }

    private func toolbar(_ g: AgentGraph) -> some View {
        HStack(spacing: 8) {
            Picker("", selection: $range) {
                Text("24 h").tag("24h"); Text("7 days").tag("7d"); Text("30 days").tag("30d"); Text("All").tag("all")
            }
            .pickerStyle(.menu).labelsHidden().fixedSize()
            Toggle("Only active", isOn: $onlyActive).compactToggle()
            Toggle("AI chats", isOn: $includeChats).compactToggle()
            Divider().frame(height: 16)
            Button { zoom = max(0.25, zoom / 1.25) } label: { Image(systemName: "minus.magnifyingglass") }.help("Zoom out")
            Text("\(Int(zoom * 100))%").monospacedDigit().frame(width: 40)
            Button { zoom = min(2, zoom * 1.25) } label: { Image(systemName: "plus.magnifyingglass") }.help("Zoom in")
            Button { fit(g) } label: { Image(systemName: "arrow.up.left.and.down.right.magnifyingglass") }.help("Fit to window")
            Divider().frame(height: 16)
            legend
            if !scheduled.isEmpty {
                Menu {
                    ForEach(scheduled) { a in
                        let next = a.schedule.flatMap(Schedule.parse)?.nextRun(after: Date(), lastRun: a.lastRun)
                        Button("\(a.name) · \(a.schedule ?? "")\(next.map { " · next " + $0.formatted(date: .abbreviated, time: .shortened) } ?? "")") {
                            model.selection = .brain
                        }
                    }
                } label: { Label("\(scheduled.count) scheduled", systemImage: "clock") }
                .menuStyle(.borderlessButton).fixedSize()
            }
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .font(.system(size: 12))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(.regularMaterial).shadow(color: .black.opacity(0.08), radius: 4, y: 1))
        .padding(10)
    }

    private var legend: some View {
        HStack(spacing: 8) {
            ForEach(AgentGraph.statusOrder, id: \.self) { s in
                HStack(spacing: 3) { Circle().fill(s.color).frame(width: 7, height: 7); Text(s == .waiting ? "Waiting" : s.rawValue) }
            }
        }
        .foregroundStyle(Theme.secondary)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 34)).foregroundStyle(Theme.secondary)
            Text(onlyActive ? "Nothing is running right now" : "No agent sessions in this time range").font(.headline)
            Text("Sessions appear here per project. Sub-agents an agent starts are drawn below it, connected by a line that animates while they work.")
                .multilineTextAlignment(.center).foregroundStyle(Theme.secondary).frame(maxWidth: 420)
            HStack {
                Button { model.showNewSession = true } label: { Label("New session", systemImage: "plus") }.buttonStyle(.borderedProminent)
                if onlyActive { Button("Show all") { onlyActive = false } }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func fit(_ g: AgentGraph) {
        guard g.width > 0, g.height > 0, viewport.width > 0 else { zoom = 1; return }
        let zx = (viewport.width - 20) / (g.width + 2 * Self.margin), zy = (viewport.height - 60) / (g.height + 2 * Self.margin)
        zoom = Double(min(1.5, max(0.25, min(zx, zy))))
    }
}

/// Dotted background like a whiteboard.
struct CanvasGrid: View {
    var body: some View {
        GeometryReader { geo in
            Path { p in
                let step: CGFloat = 22
                var y: CGFloat = 0
                while y < geo.size.height {
                    var x: CGFloat = 0
                    while x < geo.size.width { p.addRect(CGRect(x: x, y: y, width: 1.2, height: 1.2)); x += step }
                    y += step
                }
            }
            .fill(Theme.secondary.opacity(0.25))
        }
    }
}

/// Parent → child connectors (bezier from the parent's bottom edge to the child's top edge).
struct EdgeShape: Shape {
    let graph: AgentGraph
    let active: Bool
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let pos = Dictionary(graph.nodes.map { ($0.id, CGPoint(x: $0.x, y: $0.y)) }, uniquingKeysWith: { a, _ in a })
        let h = AgentGraph.nodeHeight / 2
        for e in graph.edges where e.active == active {
            guard let a = pos[e.from], let b = pos[e.to] else { continue }
            let start = CGPoint(x: a.x, y: a.y + h), end = CGPoint(x: b.x, y: b.y - h)
            let mid = (end.y - start.y) / 2
            p.move(to: start)
            p.addCurve(to: end, control1: CGPoint(x: start.x, y: start.y + mid), control2: CGPoint(x: end.x, y: end.y - mid))
        }
        return p
    }
}

/// Project swimlane: name, counts, and "new session here".
struct LaneBackground: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let lane: AgentGraph.Lane
    let cwd: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: lane.name == "AI chats" ? "bubble.left.and.bubble.right" : "folder.fill").foregroundStyle(Theme.secondary)
                Text(lane.name).font(.system(size: 14, weight: .semibold))
                if lane.running > 0 { chip("\(lane.running) running", .blue) }
                if lane.waiting > 0 { chip("\(lane.waiting) waiting", .orange) }
                if lane.failed > 0 { chip("\(lane.failed) failed", .red) }
                Text("\(lane.total) sessions · \(lane.lastActivity.formatted(.relative(presentation: .named)))").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                Spacer()
                if let cwd, !cwd.isEmpty {
                    Button {
                        happier.defaultDirectory = cwd
                        model.showNewSession = true
                    } label: { Label("New session here", systemImage: "plus") }
                    .buttonStyle(.borderless).font(.system(size: 11.5))
                }
            }
            .padding(.horizontal, 14).frame(height: AgentGraph.laneHeader)
            Spacer(minLength: 0)
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(Theme.divider), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
    }
    private func chip(_ t: String, _ c: Color) -> some View {
        Text(t).font(.system(size: 10.5, weight: .medium)).foregroundStyle(c)
            .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(c.opacity(0.12)))
    }
}

/// One agent on the canvas.
struct CanvasNode: View {
    @Environment(HappierModel.self) private var happier
    let node: AgentGraph.Node
    let selected: Bool
    @State private var hover = false

    var body: some View {
        let s = node.session
        let pending = happier.pendingInbox(for: s.id).count
        HStack(spacing: 0) {
            Rectangle().fill(node.status.color).frame(width: 4)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AgentIcon(icon: s.isChat ? "bubble.left" : (happier.agent(s.agentID)?.icon ?? "terminal"), size: 12)
                    Text(s.title.nonEmptyOr("Untitled session")).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 2)
                    StatusDot(status: node.status, size: 6)
                }
                Group {
                    if node.status == .running, let a = happier.activity(s.id) {
                        Text(a).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Color.blue)
                    } else if node.status == .waiting {
                        Text(pending > 0 ? "Waiting for your approval" : "Waiting for you").foregroundStyle(.orange)
                    } else if !s.result.isEmpty {
                        Text(s.result)
                    } else {
                        Text(s.task.isEmpty ? s.cwd : s.task).foregroundStyle(Theme.secondary)
                    }
                }
                .font(.system(size: 11)).lineLimit(2)
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    Text(happier.agent(s.agentID)?.name ?? (s.isChat ? "AI chat" : s.agentID))
                    if node.descendants > 0 { Label("\(node.descendants)", systemImage: "arrow.turn.down.right") }
                    if pending > 0 { Label("\(pending)", systemImage: "hand.raised.fill").foregroundStyle(.orange) }
                    Spacer()
                    if s.tokens > 0 { Text(AgentCard.tokens(s.tokens)) }
                    Text(s.updatedAt.formatted(.relative(presentation: .numeric)))
                }
                .font(.system(size: 9.5)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            .padding(.horizontal, 9).padding(.vertical, 7)
        }
        .background(RoundedRectangle(cornerRadius: 9).fill(Chrome.appBackground))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(selected ? Theme.accentBlue : (node.status == .running ? Color.blue.opacity(0.55) : Color(Theme.divider)), lineWidth: selected ? 2 : 1))
        .shadow(color: node.status == .running ? Color.blue.opacity(0.25) : .black.opacity(hover ? 0.15 : 0.06), radius: node.status == .running ? 8 : (hover ? 6 : 2), y: 1)
        .onHover { hover = $0 }
        .contextMenu { AgentSessionMenu(session: s) }
        .help(s.task.isEmpty ? s.title : s.task)
        .accessibilityIdentifier("canvas.node")
    }
}

/// Side panel for the selected canvas node: task, live activity, result, approvals, sub-agents, message box.
struct AgentInspector: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let session: AgentSession
    let select: (RecordID) -> Void
    let close: () -> Void
    @State private var message = ""

    var body: some View {
        let st = happier.status(of: session)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 8) {
                    AgentIcon(icon: happier.agent(session.agentID)?.icon ?? "terminal", size: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title.nonEmptyOr("Untitled session")).font(.system(size: 15, weight: .semibold))
                        HStack(spacing: 4) { StatusDot(status: st, size: 6); Text(st.rawValue) }.font(.caption).foregroundStyle(Theme.secondary)
                    }
                    Spacer()
                    Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.hoverFill).foregroundStyle(Theme.secondary)
                }
                Text(session.cwd).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(2).truncationMode(.head)
                HStack {
                    Button { model.openSession(session.id) } label: { Label("Open console", systemImage: "terminal") }.buttonStyle(.borderedProminent)
                    Button { model.newSubAgent(of: session.id) } label: { Label("Sub-agent", systemImage: "arrow.turn.down.right") }
                    Menu { AgentSessionMenu(session: session) } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
                }
                .controlSize(.small)
                if let p = happier.parent(of: session) {
                    section("Started by") {
                        Button { select(p.id) } label: { Label(p.title.nonEmptyOr("Untitled"), systemImage: "arrow.turn.left.up") }.buttonStyle(.plain)
                    }
                }
                if !session.task.isEmpty {
                    section("Task") { Text(session.task).font(.system(size: 12.5)).textSelection(.enabled) }
                }
                let pending = happier.pendingInbox(for: session.id)
                if !pending.isEmpty {
                    section("Waiting for you") { ForEach(pending) { InboxRow(item: $0) } }
                }
                if st == .running {
                    section("Now") {
                        ForEach((happier.events[session.id] ?? []).suffix(6)) { e in
                            Label(e.text.components(separatedBy: "\n").first ?? e.text, systemImage: e.icon)
                                .font(.system(size: 11.5, design: .monospaced)).lineLimit(2)
                                .foregroundStyle(e.status == "failed" ? Color.red : Theme.primary)
                        }
                        if let live = happier.liveText[session.id], !live.isEmpty {
                            Text(String(live.suffix(400))).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                        }
                    }
                }
                if !session.result.isEmpty {
                    section(st == .failed ? "Error" : "Result") {
                        Text(ConsoleItemView.markdown(String(session.result.prefix(3000)))).font(.system(size: 12.5)).textSelection(.enabled)
                    }
                }
                let kids = happier.children(of: session.id)
                if !kids.isEmpty {
                    section("Sub-agents (\(kids.count))") {
                        ForEach(kids) { k in
                            Button { select(k.id) } label: {
                                HStack(spacing: 6) {
                                    StatusDot(status: happier.status(of: k), size: 6)
                                    Text(k.title.nonEmptyOr("Untitled")).lineLimit(1)
                                    Spacer()
                                    Text(happier.agent(k.agentID)?.name ?? k.agentID).font(.caption).foregroundStyle(Theme.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.hoverFill)
                        }
                    }
                }
                section("Message") {
                    TextField(happier.isWorking(session.id) ? "Queue a follow-up…" : "Send a message…", text: $message, axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(1...5)
                        .onSubmit(send)
                    HStack {
                        Spacer()
                        Button("Send", action: send).disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                HStack(spacing: 10) {
                    Text(happier.agent(session.agentID)?.name ?? session.agentID)
                    if session.tokens > 0 { Text(AgentCard.tokens(session.tokens)) }
                    Text("started " + session.startedAt.formatted(.relative(presentation: .named)))
                }
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            .padding(14)
        }
        .background(Chrome.appBackground)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.secondary)
            c()
        }
    }

    private func send() {
        let t = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        message = ""
        happier.send(session.id, t)
    }
}
