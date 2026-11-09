import SwiftUI
import BasedCore
import BasedBrain

// BSD-108: agent detail (a run with its main agent and sub-agents) and project detail (two weeks back, one ahead).
// Data comes from `RunTimeline` / `ProjectTimeline` in BasedBrain; these views only draw.

/// Lanes with bars and the "now" line.
struct TimelineLanesView: View {
    let range: TimelineRange
    let lanes: [TimelineLane]
    static let laneHeight: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            ForEach(lanes) { lane in
                HStack(spacing: DS.Space.md) {
                    Text(lane.title).font(DS.Text.small(lane.role == .main ? .semibold : .regular))
                        .foregroundStyle(lane.role == .subagent ? Theme.secondary : Theme.primary)
                        .lineLimit(1).frame(width: 140, alignment: .leading)
                    GeometryReader { geo in
                        let w = geo.size.width
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.primary.opacity(0.04)).frame(height: 6)
                            ForEach(lane.bars) { b in
                                Capsule().fill(Self.color(b.state).opacity(b.state == .planned ? 0.35 : 0.85))
                                    .frame(width: max(6, (b.x1 - b.x0) * w), height: 10)
                                    .offset(x: b.x0 * w)
                                    .help("\(b.title) · \(b.state.rawValue)")
                            }
                            Rectangle().fill(HomeSun.orange).frame(width: 1.5, height: Self.laneHeight)
                                .offset(x: range.nowX * w)
                        }
                        .frame(height: Self.laneHeight)
                    }
                    .frame(height: Self.laneHeight)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Timeline with \(lanes.count) lanes")
    }

    static func color(_ s: TimelineBar.State) -> Color {
        switch s {
        case .done: return .green
        case .running: return Theme.accentBlue
        case .waiting: return HomeSun.orange
        case .planned: return Theme.secondary
        case .failed: return .red
        }
    }
}

private struct Figure: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(DS.Text.body(.semibold)).monospacedDigit()
            Text(label).font(DS.Text.caption()).foregroundStyle(Theme.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func durationText(_ t: TimeInterval) -> String {
    let s = Int(max(0, t))
    if s < 60 { return "\(s) s" }
    if s < 3600 { return "\(s / 60) min" }
    return "\(s / 3600) h \(s % 3600 / 60) min"
}

/// A run: figures, lanes, steps, what it is doing now, where the result goes.
struct AgentRunDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let runID: RecordID
    var openProject: (RecordID) -> Void = { _ in }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { ctx in
            let brain = model.brain.brain
            if let run = brain.run(runID) {
                let t = RunTimeline.make(run: run, parent: run.parentID.flatMap { brain.run($0) }, children: brain.children(ofRun: runID), now: ctx.date)
                content(t)
            } else {
                ContentUnavailableView("Run not found", systemImage: "questionmark.circle")
            }
        }
        .frame(minWidth: 560, minHeight: 440)
        .accessibilityIdentifier("agentDetail")
    }

    @ViewBuilder
    private func content(_ t: RunTimeline) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.xl) {
            HStack {
                VStack(alignment: .leading, spacing: DS.Space.xs) {
                    Text(t.run.title).font(.system(size: 20, weight: .semibold)).lineLimit(2)
                    Text([t.run.status.rawValue, t.run.engine, t.run.model].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(DS.Text.small()).foregroundStyle(Theme.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                Figure(label: "Running time", value: durationText(t.duration))
                Figure(label: "Progress", value: t.progress.map { "\(Int(($0 * 100).rounded())) %" } ?? "–")
                Figure(label: "Cost", value: t.cost.formatted(.currency(code: "EUR")))
                Figure(label: "Tokens", value: t.tokens.formatted())
            }
            Text("Who works here").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
            TimelineLanesView(range: t.range, lanes: t.lanes)
            if !t.steps.isEmpty {
                Text("Steps").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                ForEach(t.steps) { s in
                    Label(s.title, systemImage: s.state == .done ? "checkmark.circle.fill" : s.state == .failed ? "xmark.circle" : s.state == .waiting ? "hand.raised" : "circle.dotted")
                        .foregroundStyle(TimelineLanesView.color(s.state))
                        .font(DS.Text.ui())
                }
            }
            if !t.run.result.isEmpty {
                Text(t.run.status.isTerminal ? "Result" : "Now").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                ScrollView { Text(t.run.result).font(DS.Text.ui()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 140)
            }
            HStack {
                if let page = t.run.resultPageID, model.store.blocks[page] != nil {
                    Button("Result lands in “\(model.store.title(of: page).nonEmptyOr("Untitled"))”") { model.selection = .page(page); dismiss() }
                }
                if let p = t.run.projectID {
                    Button("Project") { openProject(p) }
                }
                Spacer()
                if model.store.blocks[t.run.id] != nil {
                    Button("Open run log") { model.selection = .page(t.run.id); dismiss() }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(DS.Space.xxl)
    }
}

/// A project: status, goal, figures, two-week timeline per agent, pages.
struct ProjectDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let projectID: RecordID

    var body: some View {
        let brain = model.brain.brain
        if let p = brain.project(projectID) {
            let t = ProjectTimeline.make(runs: brain.runs(inProject: projectID), now: Date()) { id in
                model.store.blocks[id].map { model.store.title(of: $0.id) }
            }
            VStack(alignment: .leading, spacing: DS.Space.xl) {
                HStack {
                    VStack(alignment: .leading, spacing: DS.Space.xs) {
                        Text(p.name).font(.system(size: 20, weight: .semibold))
                        Text(p.status.rawValue + (p.goal.isEmpty ? "" : " · " + p.goal)).font(DS.Text.small()).foregroundStyle(Theme.secondary).lineLimit(2)
                    }
                    Spacer()
                    Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
                }
                HStack {
                    Figure(label: "Runs (3 weeks)", value: "\(t.runCount)")
                    Figure(label: "Running", value: "\(t.running)")
                    Figure(label: "Failed", value: "\(t.failed)")
                    Figure(label: "Cost", value: t.cost.formatted(.currency(code: "EUR")))
                }
                Text("Two weeks back · one week ahead").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                if t.lanes.isEmpty {
                    Text("No runs in this period.").font(DS.Text.ui()).foregroundStyle(Theme.secondary)
                } else {
                    TimelineLanesView(range: t.range, lanes: t.lanes)
                }
                if !p.pageIDs.isEmpty {
                    Text("Pages").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                    ForEach(p.pageIDs.filter { model.store.blocks[$0] != nil }, id: \.self) { id in
                        Button(model.store.title(of: id).nonEmptyOr("Untitled")) { model.selection = .page(id); dismiss() }
                            #if os(macOS)
                            .buttonStyle(.link)
                            #else
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                            #endif
                    }
                }
                HStack {
                    Spacer()
                    if model.store.blocks[projectID] != nil {
                        Button("Open project page") { model.selection = .page(projectID); dismiss() }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(DS.Space.xxl)
            .frame(minWidth: 560, minHeight: 420)
            .accessibilityIdentifier("projectDetail")
        } else {
            ContentUnavailableView("Project not found", systemImage: "questionmark.circle")
        }
    }
}
