import SwiftUI
import BasedCore
import BasedBrain

/// BSD-55: AI home – a rising sun (the main agent) with orbits. The outer ring is a clock (now at the top, past
/// left, future right); finished runs, questions and planned agents sit at their time, running agents on the inner
/// ring. All positions come from `HomeLayout` in BasedBrain; this view only draws and forwards taps.
struct AgentHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact }
    #else
    private let compact = false
    #endif
    @AppStorage("home.range") private var rangeRaw = HomeRange.today.rawValue
    /// auto (by time of day) · morning · evening · off
    @AppStorage("home.sun") private var sunStyle = "auto"
    @AppStorage("home.lastSeen") private var lastSeen: Double = 0
    @State private var seenAtOpen: Date?
    /// BSD-108: detail sheets (a running agent, a project).
    @State private var detailRun: RecordID?
    @State private var detailProject: RecordID?

    private var range: HomeRange { HomeRange(rawValue: rangeRaw) ?? .today }

    var body: some View {
        // Observed so the screen refreshes when sessions, inbox or projects change.
        let _ = (happier.inbox, happier.activeProjectIDs, happier.projects)
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let snap = model.brain.brain.homeSnapshot(now: ctx.date, range: range, userName: Self.firstName, lastSeen: seenAtOpen)
            Group {
                if compact {
                    AgentHomeList(snapshot: snap, range: $rangeRaw, open: open, answer: answer)
                } else {
                    orbit(snap, now: ctx.date)
                }
            }
            .safeAreaInset(edge: .bottom) { MainAgentInput().padding(.horizontal, DS.Space.xxl).padding(.bottom, DS.Space.xl) }
        }
        .sheet(item: Binding(get: { detailRun.map(DetailID.init) }, set: { detailRun = $0?.id })) { d in
            AgentRunDetailView(runID: d.id) { p in detailRun = nil; detailProject = p }
        }
        .sheet(item: Binding(get: { detailProject.map(DetailID.init) }, set: { detailProject = $0?.id })) { d in
            ProjectDetailView(projectID: d.id)
        }
        .onAppear {
            seenAtOpen = lastSeen > 0 ? Date(timeIntervalSince1970: lastSeen) : nil
            lastSeen = Date().timeIntervalSince1970
        }
        .accessibilityIdentifier("agentHome")
    }

    private static var firstName: String {
        #if os(macOS)
        return NSFullUserName().split(separator: " ").first.map(String.init) ?? ""
        #else
        return ""
        #endif
    }

    // MARK: Orbit (Mac / iPad)

    @ViewBuilder
    private func orbit(_ snap: HomeSnapshot, now: Date) -> some View {
        GeometryReader { geo in
            let header: Double = 92
            let g = HomeGeometry(width: Double(geo.size.width), height: max(320, Double(geo.size.height) - header - 80))
            let layout = HomeLayout.place(snap.items, geometry: g, scale: TimeScale(range: range, now: now))
            VStack(spacing: 0) {
                HomeHeader(snapshot: snap, range: $rangeRaw, openPage: openPage).frame(height: header)
                ZStack(alignment: .topLeading) {
                    HomeSun(center: g.center, radius: g.clockRadius, tone: sunTone(now))
                    HomeRings(geometry: g, ticks: layout.ticks)
                    ForEach(layout.cards) { c in
                        if let a = c.anchor {
                            Path { p in p.move(to: CGPoint(x: a.x, y: a.y)); p.addLine(to: CGPoint(x: c.center.x, y: c.center.y)) }
                                .stroke(Theme.secondary.opacity(0.25), lineWidth: 1)
                            Circle().fill(c.item.lane == .needsYou ? HomeSun.orange : Theme.secondary.opacity(0.6))
                                .frame(width: 7, height: 7).position(x: a.x, y: a.y)
                        }
                    }
                    ForEach(layout.cards) { c in
                        AgentHomeCard(item: c.item, open: open, answer: answer)
                            .frame(width: g.cardWidth, height: g.cardHeight)
                            .position(x: c.center.x, y: c.center.y)
                            .transition(.scale(scale: 0.6, anchor: .bottom).combined(with: .opacity))
                    }
                    ForEach(layout.overflow, id: \.lane) { b in
                        Text("+\(b.count)").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                            .padding(.horizontal, DS.Space.md).padding(.vertical, DS.Space.xs)
                            .background(Capsule().fill(Theme.primary.opacity(DS.Fill.rest)))
                            .position(x: b.center.x, y: b.center.y)
                            .help("\(b.count) more · Agents shows all runs")
                            .onTapGesture { model.selection = b.lane == .planned ? .brain : .projects }
                    }
                }
                .frame(width: g.width, height: g.height)
                .clipped()
                .animation(DS.Motion.reorder, value: layout.cards.map(\.id))
                .animation(DS.Motion.reorder, value: range)
                Spacer(minLength: 0)
            }
        }
    }

    private func sunTone(_ now: Date) -> HomeSun.Tone {
        switch sunStyle {
        case "morning": return .morning
        case "evening": return .evening
        case "off": return .off
        default:
            let h = Calendar.current.component(.hour, from: now)
            return (5..<12).contains(h) ? .morning : .evening
        }
    }

    // MARK: Actions

    private func openPage(_ id: RecordID) {
        if model.store.blocks[id] != nil { model.selection = .page(id) }
    }

    private struct DetailID: Identifiable { let id: RecordID }

    private func open(_ item: HomeItem) {
        // Running agents open their detail (lanes, steps, cost); finished ones their result.
        if item.lane == .running, let run = item.runID, model.brain.brain.run(run) != nil { detailRun = run; return }
        if let page = item.resultPageID, model.store.blocks[page] != nil { model.selection = .page(page); return }
        if let run = item.runID, model.store.blocks[run] != nil { model.selection = .page(run); return }
        if let agent = item.agentID, model.store.blocks[agent] != nil { model.selection = .page(agent); return }
        model.selection = .inbox
    }

    private func answer(_ item: HomeItem, _ option: HomeItem.Option) {
        guard let id = item.inboxID, let inbox = happier.inbox.first(where: { $0.id == id }) else { return }
        happier.resolve(inbox, decision: option.id)
    }
}

/// Greeting, "while you were away", range switch and today's cost.
private struct HomeHeader: View {
    let snapshot: HomeSnapshot
    @Binding var range: String
    var openPage: (RecordID) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .top, spacing: DS.Space.xl) {
            VStack(alignment: .leading, spacing: DS.Space.xs) {
                Text(snapshot.greeting).font(.system(size: 26, weight: .semibold))
                // BSD-57: today's brief (tap opens its page in Briefs).
                if !snapshot.brief.isEmpty, let page = snapshot.briefPageID {
                    Button { openPage(page) } label: {
                        Label("Today's brief: \(snapshot.brief)", systemImage: "sun.horizon")
                            .font(DS.Text.ui()).lineLimit(1)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.secondary)
                    .accessibilityIdentifier("home.brief")
                }
                if !snapshot.summary.isEmpty {
                    Text(snapshot.summary).font(DS.Text.ui()).foregroundStyle(Theme.secondary).lineLimit(2)
                } else if !snapshot.lastUpdate.isEmpty {
                    Text(snapshot.lastUpdate).font(DS.Text.ui()).foregroundStyle(Theme.secondary).lineLimit(2)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: DS.Space.sm) {
                Picker("Range", selection: $range) {
                    ForEach(HomeRange.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 220)
                Text("Today \(snapshot.costToday, format: .currency(code: "EUR"))").font(DS.Text.small()).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.horizontal, DS.Space.xxl).padding(.top, DS.Space.xl)
    }
}

/// The abstract rising sun behind everything.
struct HomeSun: View {
    enum Tone { case morning, evening, off }
    static let orange = Color(red: 0.914, green: 0.463, blue: 0.169)   // #E9762B
    let center: HomePoint
    let radius: Double
    let tone: Tone

    var body: some View {
        let colors: [Color] = switch tone {
        case .morning: [Color(red: 1, green: 0.84, blue: 0.55).opacity(0.95), Color(red: 1, green: 0.78, blue: 0.47).opacity(0.5), .clear]
        case .evening: [Color(red: 0.96, green: 0.59, blue: 0.31).opacity(0.85), Color(red: 0.96, green: 0.67, blue: 0.43).opacity(0.42), .clear]
        case .off: [.clear, .clear]
        }
        Circle()
            .fill(RadialGradient(colors: colors, center: .center, startRadius: 0, endRadius: radius * 0.7))
            .frame(width: radius * 1.4, height: radius * 1.4)
            .position(x: center.x, y: center.y)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// Clock ring with ticks and the inner ring.
private struct HomeRings: View {
    let geometry: HomeGeometry
    let ticks: [(tick: TimeScale.Tick, point: HomePoint)]

    var body: some View {
        let c = CGPoint(x: geometry.center.x, y: geometry.center.y)
        ZStack(alignment: .topLeading) {
            ForEach([geometry.clockRadius, geometry.innerRadius], id: \.self) { r in
                Circle().stroke(HomeSun.orange.opacity(0.22), lineWidth: 1)
                    .frame(width: r * 2, height: r * 2).position(c)
            }
            ForEach(ticks, id: \.tick.offset) { t in
                Circle().fill(t.tick.isNow ? HomeSun.orange : HomeSun.orange.opacity(0.45))
                    .frame(width: t.tick.isNow ? 10 : 6, height: t.tick.isNow ? 10 : 6)
                    .position(x: t.point.x, y: t.point.y)
                Text(t.tick.label).font(DS.Text.caption(t.tick.isNow ? .bold : .medium))
                    .foregroundStyle(t.tick.isNow ? HomeSun.orange : Theme.secondary)
                    .position(x: t.point.x, y: t.point.y - 16)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// One card: running · needs you · done · planned.
struct AgentHomeCard: View {
    let item: HomeItem
    let open: (HomeItem) -> Void
    let answer: (HomeItem, HomeItem.Option) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            HStack(spacing: DS.Space.sm) {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                Text(laneTitle).font(DS.Text.caption(.semibold)).foregroundStyle(dotColor)
                Spacer(minLength: 0)
                Text(item.date, style: .relative).font(DS.Text.caption()).foregroundStyle(Theme.secondary)
            }
            Text(item.title).font(DS.Text.body(.semibold)).lineLimit(1)
            if item.lane == .needsYou, !item.options.isEmpty {
                HStack(spacing: DS.Space.xs) {
                    ForEach(item.options.prefix(3), id: \.id) { o in
                        Button(o.label) { answer(item, o) }.controlSize(.small)
                    }
                }
            } else {
                Text(secondLine).font(DS.Text.small()).foregroundStyle(Theme.secondary).lineLimit(1)
            }
        }
        .padding(DS.Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous).stroke(Theme.dividerColor, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { open(item) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(laneTitle): \(item.title)")
    }

    private var laneTitle: String {
        switch item.lane {
        case .running: return item.subagents > 0 ? "Running · \(item.subagents) sub-agents" : "Running"
        case .needsYou: return "Needs you"
        case .done: return item.failed ? "Failed" : "Done"
        case .planned: return "Planned"
        }
    }

    private var dotColor: Color {
        switch item.lane {
        case .running: return Theme.accentBlue
        case .needsYou: return HomeSun.orange
        case .done: return item.failed ? .red : .green
        case .planned: return Theme.secondary
        }
    }

    private var secondLine: String {
        let parts = [item.subtitle, item.detail.isEmpty ? item.model : item.detail].filter { !$0.isEmpty }
        return parts.joined(separator: " · ")
    }
}

/// iPhone: the same data as a stack (needs you, running, done, planned).
struct AgentHomeList: View {
    let snapshot: HomeSnapshot
    @Binding var range: String
    let open: (HomeItem) -> Void
    let answer: (HomeItem, HomeItem.Option) -> Void
    private static let lanes: [HomeItem.Lane] = [.needsYou, .running, .done, .planned]

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: DS.Space.xs) {
                    Text(snapshot.greeting).font(.title2.weight(.semibold))
                    if !snapshot.summary.isEmpty { Text(snapshot.summary).foregroundStyle(Theme.secondary) }
                }
                Picker("Range", selection: $range) {
                    ForEach(HomeRange.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }.pickerStyle(.segmented)
            }
            ForEach(Self.lanes, id: \.self) { lane in
                let items = snapshot.items(in: lane).sorted { $0.date > $1.date }
                if !items.isEmpty {
                    Section(lane == .needsYou ? "Needs you" : lane == .running ? "Running" : lane == .done ? "Done" : "Planned") {
                        ForEach(items) { AgentHomeCard(item: $0, open: open, answer: answer).frame(minHeight: 72).listRowInsets(EdgeInsets()) }
                    }
                }
            }
        }
    }
}

/// Message field to the main agent: opens its thread in the chat panel and sends there.
struct MainAgentInput: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""

    var body: some View {
        HStack(spacing: DS.Space.md) {
            TextField("Message the main agent", text: $text, axis: .vertical)
                .textFieldStyle(.plain).font(DS.Text.ui()).lineLimit(1...4)
                .onSubmit(send)
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 22)) }
                .buttonStyle(.plain).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send to the main agent")
        }
        .padding(DS.Space.lg)
        .frame(maxWidth: 720)
        .background(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous).stroke(Theme.dividerColor, lineWidth: 1))
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("agentHome.input")
    }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        text = ""
        model.openChat(model.brain.mainThreadID(), fullPage: false)
        model.brain.ask(t)
    }
}
