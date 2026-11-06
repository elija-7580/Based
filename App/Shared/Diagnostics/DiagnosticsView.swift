import SwiftUI
import UniformTypeIdentifiers
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Help ▸ Diagnostics (and Settings ▸ Diagnostics): live log, hangs, layout audit and system info.
struct DiagnosticsView: View {
    enum Tab: String, CaseIterable, Identifiable { case logs = "Log", hangs = "Hangs", layout = "Layout", system = "System"; var id: String { rawValue } }

    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .logs
    @State private var level: LogLevel = .info
    @State private var category = ""
    @State private var search = ""
    @State private var entries: [LogEntry] = []
    @State private var live = true
    @State private var issues: [LayoutAuditor.Issue] = LayoutAuditor.shared.lastIssues
    @State private var autoAudit = LayoutAuditor.autoAuditEnabled
    @State private var exporting = false
    @State private var exportText = ""
    @State private var tick = 0

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $tab) { ForEach(Tab.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 360)
                Spacer()
                Button { exportText = AppDiagnostics.reportHeader() + "\n" + Log.shared.exportText(); exporting = true } label: {
                    Label("Export logs…", systemImage: "square.and.arrow.up")
                }
                #if os(macOS)
                Button { if let d = Log.shared.directory { NSWorkspace.shared.activateFileViewerSelecting([d]) } } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                #endif
            }
            .padding(12)
            Divider()
            switch tab {
            case .logs: logs
            case .hangs: hangs
            case .layout: layout
            case .system: system
            }
        }
        #if os(iOS)
        .navigationTitle("Diagnostics")
        #endif
        .onAppear(perform: reload)
        .onReceive(timer) { _ in if live && tab == .logs { reload() }; tick += 1 }
        .onChange(of: level) { _, _ in reload() }
        .onChange(of: category) { _, _ in reload() }
        .onChange(of: search) { _, _ in reload() }
        .fileExporter(isPresented: $exporting, document: TextDocument(text: exportText), contentType: .plainText,
                      defaultFilename: "Based-diagnostics-\(Int(Date().timeIntervalSince1970)).txt") { _ in }
        .accessibilityIdentifier("diagnostics.root")
    }

    private func reload() {
        entries = Log.shared.recent(limit: 800, minLevel: level, category: category.isEmpty ? nil : category, search: search.isEmpty ? nil : search)
    }

    // MARK: Log

    private var logs: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Picker("Level", selection: $level) {
                    ForEach(LogLevel.allCases, id: \.self) { Text("\($0.symbol) \($0.name)").tag($0) }
                }
                .fixedSize()
                Picker("Category", selection: $category) {
                    Text("All categories").tag("")
                    ForEach(Log.shared.categories, id: \.self) { Text($0).tag($0) }
                }
                .fixedSize()
                TextField("Search", text: $search).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                Toggle("Live", isOn: $live).toggleStyle(.switch).controlSize(.small)
                Spacer()
                Text("\(entries.count) entries").font(.caption).foregroundStyle(Theme.secondary)
            }
            .font(.system(size: 12))
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(entries.reversed()) { e in LogRow(entry: e) }
                }
                .padding(8)
            }
            .accessibilityIdentifier("diagnostics.log")
        }
    }

    // MARK: Hangs

    private var hangs: some View {
        let list = HangWatchdog.shared.hangs.reversed()
        return Group {
            if list.isEmpty {
                ContentUnavailableView("No hangs recorded", systemImage: "checkmark.seal",
                                       description: Text("The main thread is watched every 250 ms. Blocks longer than 0.5 s appear here with what you were doing."))
            } else {
                List(Array(list)) { h in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("\(Int(h.seconds * 1000)) ms").font(.system(size: 13, weight: .semibold).monospacedDigit())
                                .foregroundStyle(h.seconds > 2 ? .red : .orange)
                            Text(h.date.formatted(date: .omitted, time: .standard)).foregroundStyle(Theme.secondary)
                        }
                        Text(h.breadcrumbs.suffix(5).joined(separator: " → ")).font(.caption).foregroundStyle(Theme.secondary).lineLimit(3)
                    }
                }
            }
        }
    }

    // MARK: Layout

    private var layout: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button { issues = LayoutAuditor.shared.run() } label: { Label("Run layout audit", systemImage: "rectangle.dashed.badge.record") }
                    .accessibilityIdentifier("diagnostics.runAudit")
                Toggle("Audit automatically after navigation and resizing", isOn: $autoAudit)
                    .onChange(of: autoAudit) { _, v in LayoutAuditor.autoAuditEnabled = v }
                Spacer()
                if let d = LayoutAuditor.shared.lastRun {
                    Text("\(LayoutAuditor.shared.lastElementCount) elements · \(d.formatted(date: .omitted, time: .standard))")
                        .font(.caption).foregroundStyle(Theme.secondary)
                }
            }
            .padding(12)
            Divider()
            if issues.isEmpty {
                ContentUnavailableView("No layout issues", systemImage: "rectangle.on.rectangle",
                                       description: Text("Checks every window for clipped, overlapping, out-of-bounds and too-small controls."))
            } else {
                List(issues) { i in
                    HStack(alignment: .top) {
                        Text(i.kind.rawValue).font(.caption.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(i.kind == .overlap ? Color.orange : i.kind == .tiny ? Color.gray : Color.red))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(i.element + (i.other.map { " ↔ " + $0 } ?? "")).font(.system(size: 13, weight: .medium))
                            Text(i.detail).font(.caption).foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        Text("\(Int(i.frame.minX)),\(Int(i.frame.minY)) · \(Int(i.frame.width))×\(Int(i.frame.height))")
                            .font(.caption.monospaced()).foregroundStyle(Theme.secondary)
                    }
                }
            }
        }
    }

    // MARK: System

    private var system: some View {
        Form {
            Section("App") {
                LabeledContent("Version", value: AppDiagnostics.versionString)
                LabeledContent("System", value: ProcessInfo.processInfo.operatingSystemVersionString)
                LabeledContent("App Sandbox", value: AppDiagnostics.isSandboxed ? "On — local agents need the “-Agents” build or a Based server" : "Off")
                LabeledContent("Log folder", value: Log.shared.directory?.path ?? "–")
                LabeledContent("Hangs this session", value: "\(HangWatchdog.shared.hangCount)")
                if let c = CrashReporter.previousCrash {
                    LabeledContent("Previous run", value: c.summary)
                }
            }
            Section("Workspace") {
                LabeledContent("Blocks", value: "\(model.store.blocks.count)")
                LabeledContent("Databases", value: "\(model.store.databases.count)")
                LabeledContent("Tabs", value: "\(model.tabs.count)")
            }
            Section("Agents") {
                LabeledContent("Local MCP endpoint", value: model.brain.happier.mcpBaseURL ?? "not running")
                LabeledContent("Shell environment", value: ShellEnvironment.note.isEmpty ? "loading…" : ShellEnvironment.note)
                LabeledContent("claude", value: ShellEnvironment.which("claude") ?? "not found")
                LabeledContent("node", value: ShellEnvironment.which("node") ?? "not found")
            }
            Section("Recent breadcrumbs") {
                Text(Log.shared.breadcrumbs.suffix(20).joined(separator: "\n")).font(.caption.monospaced()).textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .id(tick / 5)
    }
}

struct LogRow: View {
    let entry: LogEntry
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(entry.date.formatted(.dateTime.hour().minute().second())).foregroundStyle(Theme.secondary)
            Text(entry.level.symbol)
            Text(entry.category).foregroundStyle(color).frame(width: 70, alignment: .leading).lineLimit(1)
            Text(entry.message + (entry.metadata.map { " " + $0.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ") } ?? ""))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.vertical, 1)
    }
    private var color: Color {
        switch entry.level {
        case .fault, .error: return .red
        case .warning: return .orange
        case .notice: return .blue
        default: return Theme.secondary
        }
    }
}
