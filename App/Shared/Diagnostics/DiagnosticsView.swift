import SwiftUI
import UniformTypeIdentifiers
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Help ▸ Diagnostics (and Settings ▸ Diagnostics): live log, hangs, layout audit and system info.
struct DiagnosticsView: View {
    @MainActor static var secretsSummary: String {
        let s = SecretsStatus.shared
        guard s.loaded else { return "loading in the background…" }
        return "\(Secrets.cachedCount) key(s) loaded" + (s.pending.isEmpty ? "" : " · \(s.pending.count) need permission (Settings → AI)")
    }
    enum Tab: String, CaseIterable, Identifiable { case logs = "Log", hangs = "Hangs", layout = "Layout", system = "System"; var id: String { rawValue } }

    @Environment(AppModel.self) private var model
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
    @State private var copiedNote: String?

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// The tab lives in the model so the sidebar's Developer rows (Logs, Hangs, Layout, System) can pick it.
    private var tab: Tab { model.diagnosticsTab }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $model.diagnosticsTab) { ForEach(Tab.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 360)
                Spacer()
                if let copiedNote {
                    Text(copiedNote).font(.caption).foregroundStyle(Theme.secondary).transition(.opacity)
                }
                Menu {
                    Button("Copy report (recommended)") { copy(.report) }
                    Button("Copy shown log entries (\(entries.count))") { copy(.shown) }
                    Button("Copy full log files") { copy(.full) }
                } label: {
                    Label(copiedNote == nil ? "Copy logs" : "Copied", systemImage: copiedNote == nil ? "doc.on.doc" : "checkmark")
                } primaryAction: {
                    copy(.report)
                }
                .fixedSize()
                .help("Copies a compact report — app & system info, previous run, hangs with the main thread's stack, breadcrumbs and the latest log lines — ready to paste into a chat or issue.")
                .accessibilityIdentifier("diagnostics.copy")
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
        // Fill the pane and pin the toolbar to the top (an empty tab used to centre everything vertically).
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        #if os(iOS)
        .navigationTitle("Diagnostics")
        #endif
        .onAppear(perform: reload)
        // Errors seen here no longer count on the sidebar's Logs row.
        .onDisappear { model.logsSeenAt = Date() }
        .onReceive(timer) { _ in if live && tab == .logs { reload() }; tick += 1 }
        .onChange(of: level) { _, _ in reload() }
        .onChange(of: category) { _, _ in reload() }
        .onChange(of: search) { _, _ in reload() }
        .fileExporter(isPresented: $exporting, document: TextDocument(text: exportText), contentType: .plainText,
                      defaultFilename: "Based-diagnostics-\(Int(Date().timeIntervalSince1970)).txt") { _ in }
        .accessibilityIdentifier("diagnostics.root")
    }

    enum CopyKind { case report, shown, full }

    private func copy(_ kind: CopyKind) {
        let size: Int
        switch kind {
        case .report:
            size = AppDiagnostics.copyReport(model: model)
        case .shown:
            var note = "\(entries.count) shown entries, \(level.name) and above"
            if !category.isEmpty { note += ", category \(category)" }
            if !search.isEmpty { note += ", matching “\(search)”" }
            size = AppDiagnostics.copyReport(model: model, entries: entries, entriesNote: note)
        case .full:
            let text = AppDiagnostics.reportHeader() + "\n" + Log.shared.exportText()
            Clipboard.copy(text)
            size = text.count
        }
        let kb = max(1, size / 1024)
        withAnimation { copiedNote = "Copied \(kb) KB — paste it anywhere" }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            withAnimation { copiedNote = nil }
        }
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
                                       description: Text("The main thread is watched every 100 ms. Blocks longer than 0.25 s appear here with what you were doing and where the main thread was stuck."))
            } else {
                List(Array(list)) { h in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("\(Int(h.seconds * 1000)) ms").font(.system(size: 13, weight: .semibold).monospacedDigit())
                                .foregroundStyle(h.seconds > 2 ? .red : .orange)
                            Text(h.date.formatted(date: .omitted, time: .standard)).foregroundStyle(Theme.secondary)
                            Spacer()
                            Button { Clipboard.copy(hangText(h)) } label: { Image(systemName: "doc.on.doc") }
                                .buttonStyle(.borderless)
                                .help("Copy this hang with its stack")
                        }
                        Text(h.breadcrumbs.suffix(5).joined(separator: " → ")).font(.caption).foregroundStyle(Theme.secondary).lineLimit(3)
                        if let c = StackSymbols.culprit(h.frames) {
                            Text("in " + (c.symbol ?? c.line)).font(.system(size: 11, design: .monospaced)).lineLimit(2).textSelection(.enabled)
                        }
                        if h.frames.isEmpty {
                            Text(HangWatchdog.shared.samplingAvailable ? "No stack sample (the hang ended before it was sampled)" : "Stack sampling is unavailable on this platform")
                                .font(.caption).foregroundStyle(Theme.secondary)
                        } else {
                            DisclosureGroup("Main thread stack · \(h.frames.count) frames") {
                                Text(h.frames.prefix(60).enumerated().map { "\($0.offset)  \($0.element.line)" }.joined(separator: "\n"))
                                    .font(.system(size: 10, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.caption)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func hangText(_ h: HangWatchdog.Hang) -> String {
        var lines = ["Based hang — \(Int(h.seconds * 1000)) ms at \(h.date.formatted(date: .abbreviated, time: .standard)) · Based \(AppDiagnostics.versionString) · \(AppDiagnostics.buildConfiguration)"]
        if !h.breadcrumbs.isEmpty { lines.append("After: " + h.breadcrumbs.suffix(5).joined(separator: " → ")) }
        if let c = StackSymbols.culprit(h.frames) { lines.append("In: " + (c.symbol ?? c.line)) }
        lines += h.frames.prefix(60).enumerated().map { "  \($0.offset)  \($0.element.line)" }
        if h.frames.isEmpty { lines.append("(no stack sample)") }
        return lines.joined(separator: "\n") + "\n"
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
                LabeledContent("Version", value: AppDiagnostics.versionString + " · " + AppDiagnostics.buildConfiguration)
                LabeledContent("System", value: ProcessInfo.processInfo.operatingSystemVersionString)
                LabeledContent("App Sandbox", value: AppDiagnostics.isSandboxed ? "On — local agents need the “-Agents” build or a Based server" : "Off")
                LabeledContent("Log folder", value: Log.shared.directory?.path ?? "–")
                LabeledContent("Debugger", value: DebuggerCheck.isAttached ? "Attached (Xcode)" : "Not attached")
                LabeledContent("Hangs this session", value: "\(HangWatchdog.shared.hangCount)")
                LabeledContent("Hang stack sampling", value: HangWatchdog.shared.samplingAvailable ? "On" : "Unavailable")
                LabeledContent("Keychain", value: Self.secretsSummary)
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
                // BSD-37: never ask the login shell from the view body; show "resolving…" until the warm-up is done.
                LabeledContent("Shell environment", value: ShellEnvironment.isReady ? ShellEnvironment.note : "resolving…")
                LabeledContent("claude", value: ShellEnvironment.whichIfReady("claude").map { $0 ?? "not found" } ?? "resolving…")
                LabeledContent("node", value: ShellEnvironment.whichIfReady("node").map { $0 ?? "not found" } ?? "resolving…")
            }
            .task { ShellEnvironment.warmUp() }
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
        .contextMenu {
            Button("Copy line") { Clipboard.copy(entry.line) }
            Button("Copy message") { Clipboard.copy(entry.message) }
        }
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
