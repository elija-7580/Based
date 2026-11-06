import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Agent icons are SF Symbols or emoji ("✴️").
struct AgentIcon: View {
    let icon: String
    var size: CGFloat = 14
    var body: some View {
        if icon.allSatisfy({ $0.isASCII }) {
            Image(systemName: icon.isEmpty ? "terminal" : icon).font(.system(size: size))
        } else {
            Text(icon).font(.system(size: size))
        }
    }
}

extension AgentSession {
    /// Project name shown in lists (explicit project, else the folder name).
    var projectName: String {
        if !project.isEmpty { return project }
        let name = URL(fileURLWithPath: cwd).lastPathComponent
        return name.isEmpty || cwd.isEmpty ? "No folder" : name
    }

    /// Claude Code session id for `claude --resume` (native sessions store "claude:<id>").
    var claudeSessionID: String? {
        guard let a = acpSessionID, a.hasPrefix("claude:") else { return nil }
        return String(a.dropFirst(7))
    }
}

extension AgentSession.Status {
    var color: Color {
        switch self {
        case .idle: return .gray
        case .running: return .blue
        case .waiting: return .orange
        case .done: return .green
        case .failed: return .red
        }
    }
}

// MARK: - Agents screen

/// "Agents": sessions grouped by project (left), the selected session as a Claude-Code-style console (right),
/// plus your local Claude Code / Codex CLI history and an overview with setup status and pending approvals.
struct AgentsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    @State private var cli: [CLISession] = []
    @State private var cliLoading = false
    @State private var selectedCLI: CLISession?
    @State private var showDoctor = false
    @State private var filter = ""

    var body: some View {
        HStack(spacing: 0) {
            sessionList
                .frame(width: 290)
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await loadCLI() }
        .sheet(isPresented: $showDoctor) {
            AgentDoctorView().environment(happier).environment(model)
        }
        .alert("Agent error", isPresented: Binding(get: { happier.lastError != nil }, set: { if !$0 { happier.lastError = nil } })) {
            Button("Open setup") { happier.lastError = nil; showDoctor = true }
            Button("OK", role: .cancel) { happier.lastError = nil }
        } message: { Text(happier.lastError ?? "") }
    }

    // MARK: List

    private var groups: [(name: String, sessions: [AgentSession])] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        let s = happier.agentSessions.filter { q.isEmpty || $0.title.localizedCaseInsensitiveContains(q) || $0.projectName.localizedCaseInsensitiveContains(q) }
        let byProject = Dictionary(grouping: s, by: \.projectName)
        return byProject.map { ($0.key, $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { ($0.sessions.first?.updatedAt ?? .distantPast) > ($1.sessions.first?.updatedAt ?? .distantPast) }
    }

    private var cliGroups: [(cwd: String, sessions: [CLISession])] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        let s = q.isEmpty ? cli : cli.filter { $0.title.localizedCaseInsensitiveContains(q) || $0.project.localizedCaseInsensitiveContains(q) }
        return CLISessionIndex.byProject(s)
    }

    private var selection: Binding<String?> {
        Binding(get: {
            if let id = model.agentSessionID { return "s:" + id }
            if let c = selectedCLI { return "c:" + c.id }
            return "overview"
        }, set: { v in
            guard let v else { return }
            if v.hasPrefix("s:") { model.agentSessionID = String(v.dropFirst(2)); selectedCLI = nil }
            else if v.hasPrefix("c:") { let id = String(v.dropFirst(2)); selectedCLI = cli.first { $0.id == id }; model.agentSessionID = nil }
            else { model.agentSessionID = nil; selectedCLI = nil }
        })
    }

    private var sessionList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Agents").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button { showDoctor = true } label: { Image(systemName: "stethoscope") }
                    .help("Agent setup & diagnosis").accessibilityIdentifier("agents.doctor")
                Button { model.showNewSession = true } label: { Image(systemName: "plus") }
                    .help("New session").accessibilityIdentifier("sessions.new")
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
            TextField("Filter sessions", text: $filter)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
                .padding(.horizontal, 12).padding(.bottom, 6)
            List(selection: selection) {
                Label("Overview", systemImage: "square.grid.2x2").tag("overview")
                if happier.pendingCount > 0 {
                    Button { model.selection = .inbox } label: {
                        Label("\(happier.pendingCount) waiting for you", systemImage: "hand.raised.fill").foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(groups, id: \.name) { g in
                    Section(g.name) {
                        ForEach(g.sessions) { s in
                            AgentSessionRow(session: s).tag("s:" + s.id)
                                .contextMenu {
                                    Button("Stop agent", systemImage: "power") { happier.stop(s.id) }.disabled(!happier.isLive(s.id))
                                    if let c = s.claudeSessionID {
                                        Button("Copy resume command", systemImage: "doc.on.doc") { Clipboard.copy("cd '\(s.cwd)' && claude --resume \(c)") }
                                    }
                                    Divider()
                                    Button("Delete", systemImage: "trash", role: .destructive) {
                                        if model.agentSessionID == s.id { model.agentSessionID = nil }
                                        happier.deleteSession(s.id)
                                    }
                                }
                        }
                    }
                }
                Section {
                    if cliLoading && cli.isEmpty {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Scanning ~/.claude and ~/.codex…") }
                            .font(.caption).foregroundStyle(Theme.secondary)
                    } else if cli.isEmpty {
                        Text("No Claude Code / Codex history found").font(.caption).foregroundStyle(Theme.secondary)
                    }
                    ForEach(cliGroups.prefix(40), id: \.cwd) { g in
                        DisclosureGroup {
                            ForEach(g.sessions.prefix(30)) { c in CLISessionRow(session: c).tag("c:" + c.id) }
                        } label: {
                            Label(URL(fileURLWithPath: g.cwd).lastPathComponent.nonEmptyOr(g.cwd), systemImage: "folder")
                                .badge(g.sessions.count)
                        }
                    }
                } header: {
                    HStack {
                        Text("Claude Code & Codex history")
                        Spacer()
                        Button { Task { await loadCLI(force: true) } } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.borderless).help("Rescan")
                    }
                }
            }
            .listStyle(.sidebar)
            .accessibilityIdentifier("sessions.list")
        }
    }

    // MARK: Detail

    @ViewBuilder
    private var detail: some View {
        if let sid = model.agentSessionID, happier.sessions.contains(where: { $0.id == sid }) {
            SessionConsole(sessionID: sid).id(sid)
        } else if let c = selectedCLI {
            CLISessionView(session: c).id(c.id)
        } else {
            AgentsOverview(showDoctor: $showDoctor, cliCount: cli.count)
        }
    }

    private func loadCLI(force: Bool = false) async {
        guard force || cli.isEmpty, !cliLoading else { return }
        cliLoading = true
        let found = await Task.detached(priority: .utility) {
            Log.measure("cli-session-scan", category: "agents", warnAfter: 1.5) { CLISessionIndex.scan() }
        }.value
        cli = found
        cliLoading = false
        Log.info("CLI history: \(found.count) sessions", category: "agents")
    }
}

struct AgentSessionRow: View {
    @Environment(HappierModel.self) private var happier
    let session: AgentSession

    var body: some View {
        HStack(spacing: 8) {
            AgentIcon(icon: happier.agent(session.agentID)?.icon ?? "terminal", size: 13).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.nonEmptyOr("Untitled session")).lineLimit(1)
                HStack(spacing: 4) {
                    Circle().fill(session.status.color).frame(width: 6, height: 6)
                    Text(session.status.rawValue)
                    Text("·")
                    Text(session.updatedAt.formatted(.relative(presentation: .named)))
                }
                .font(.system(size: 10.5)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if happier.busy.contains(session.id) { ProgressView().controlSize(.mini) }
            else if !happier.pendingInbox(for: session.id).isEmpty { Image(systemName: "hand.raised.fill").foregroundStyle(.orange).font(.caption) }
        }
        .padding(.vertical, 1)
    }
}

struct CLISessionRow: View {
    let session: CLISession
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(session.title.nonEmptyOr("Untitled")).lineLimit(1)
            HStack(spacing: 4) {
                Text(session.tool == "codex" ? "Codex" : "Claude Code")
                if let b = session.gitBranch, !b.isEmpty { Text("· \(b)") }
                Text("· " + session.updatedAt.formatted(.relative(presentation: .named)))
            }
            .font(.system(size: 10.5)).foregroundStyle(Theme.secondary).lineLimit(1)
        }
    }
}

// MARK: - Overview

struct AgentsOverview: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    @Binding var showDoctor: Bool
    let cliCount: Int
    @State private var statuses: [AgentDoctor.AgentStatus] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Agents").font(.system(size: 28, weight: .bold))
                    Text("Run Claude Code, Codex and other coding agents in your project folders. They can read and write this workspace through the built-in MCP server; approvals show up inline and in your Inbox.")
                        .foregroundStyle(Theme.secondary)
                }
                if AppDiagnostics.isSandboxed {
                    Label {
                        Text("This build runs in the App Sandbox, so local agents can't start processes. Build with `BASED_AGENTS_SUFFIX = -Agents` in Config/Local.xcconfig, or connect a Based server in Settings → Agents.")
                    } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.1)))
                }
                setupCard
                HStack(spacing: 10) {
                    Button { model.showNewSession = true } label: { Label("New session", systemImage: "plus") }
                        .buttonStyle(.borderedProminent)
                    Button { model.openChat(nil, fullPage: true) } label: { Label("New AI chat", systemImage: "bubble.left") }
                    Button { model.selection = .brain } label: { Label("Agent Brain", systemImage: "brain") }
                }
                let running = happier.agentSessions.filter { happier.busy.contains($0.id) || happier.isLive($0.id) }
                if !running.isEmpty {
                    section("Running now") {
                        ForEach(running) { s in
                            Button { model.agentSessionID = s.id } label: { AgentSessionRow(session: s) }.buttonStyle(.plain)
                        }
                    }
                }
                let pending = happier.inbox.filter { $0.status == .pending }
                if !pending.isEmpty {
                    section("Waiting for you") {
                        ForEach(pending.prefix(5)) { InboxRow(item: $0) }
                    }
                }
                section("Recent sessions") {
                    if happier.agentSessions.isEmpty {
                        Text("No sessions yet. Start one in a project folder — or pick a Claude Code session from your history on the left to read or resume it (\(cliCount) found).")
                            .foregroundStyle(Theme.secondary)
                    }
                    ForEach(happier.agentSessions.prefix(8)) { s in
                        Button { model.agentSessionID = s.id } label: {
                            HStack { AgentSessionRow(session: s); Text(s.projectName).font(.caption).foregroundStyle(Theme.secondary) }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(32)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .task { await probe() }
    }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Setup").font(.headline)
                Spacer()
                Button("Open setup & diagnosis") { showDoctor = true }.controlSize(.small)
            }
            if statuses.isEmpty {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Checking installed agents…").foregroundStyle(Theme.secondary) }
            }
            ForEach(statuses) { s in
                HStack(spacing: 8) {
                    Image(systemName: s.state == .ready ? "checkmark.circle.fill" : (s.state == .needsLogin ? "person.crop.circle.badge.exclamationmark" : "xmark.circle"))
                        .foregroundStyle(s.state == .ready ? Color.green : (s.state == .needsLogin ? Color.orange : Color.secondary))
                    Text(s.name).fontWeight(.medium)
                    Text(s.summary).foregroundStyle(Theme.secondary).lineLimit(1)
                    Spacer()
                    if s.state != .ready, s.fix != nil {
                        Button("Fix…") { showDoctor = true }.controlSize(.small)
                    }
                }
                .font(.system(size: 13))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.035)))
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
            c()
        }
    }

    private func probe() async {
        let defs = happier.agents.filter(\.enabled)
        statuses = await Task.detached(priority: .utility) {
            let tools = AgentDoctor.probeTools()
            return defs.map { AgentDoctor.status(of: $0, tools: tools) }
        }.value
    }
}

// MARK: - Session console (Claude Code look)

/// One session rendered like Claude Code in a terminal: `>` prompts, ⏺ bullets, ⎿ tool output, inline
/// permission prompts, a bordered prompt box and the mode footer (shift+tab cycles modes).
struct SessionConsole: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let sessionID: RecordID
    @State private var items: [TranscriptItem] = []
    @State private var input = ""
    @State private var showTerminal = false
    @State private var turnStart = Date()
    @FocusState private var focused: Bool

    static let mono = Font.system(size: 12.5, design: .monospaced)

    private var session: AgentSession? { happier.sessions.first { $0.id == sessionID } }
    private var busy: Bool { happier.busy.contains(sessionID) }
    private var pending: [InboxItem] { happier.pendingInbox(for: sessionID) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            #if os(macOS) && canImport(SwiftTerm)
            if showTerminal, let s = session {
                AgentTerminalView(key: sessionID, cwd: s.cwd, command: terminalCommand(s))
                    .background(Color(nsColor: .textBackgroundColor))
            } else {
                transcript
                composer
            }
            #else
            transcript
            composer
            #endif
        }
        .task(id: happier.transcriptRevision[sessionID] ?? 0) { await reload() }
        .onChange(of: busy) { _, b in if b { turnStart = Date() } }
        .onAppear { focused = true }
        .accessibilityIdentifier("session.console")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            AgentIcon(icon: happier.agent(session?.agentID ?? "")?.icon ?? "terminal", size: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(session?.title.nonEmptyOr("Untitled session") ?? "Session").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text(session?.cwd ?? "").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary)
                    .lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: 12)
            if let s = session {
                HStack(spacing: 4) {
                    Circle().fill(s.status.color).frame(width: 7, height: 7)
                    Text(s.status.rawValue)
                }
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            Menu {
                ForEach(HappierModel.claudeModes, id: \.id) { m in
                    Button { happier.setMode(sessionID, m.id) } label: {
                        if happier.mode(sessionID) == m.id { Label(m.title, systemImage: "checkmark") } else { Text(m.title) }
                    }
                }
            } label: { Text(HappierModel.claudeModes.first { $0.id == happier.mode(sessionID) }?.title ?? "Mode") }
            .menuStyle(.borderlessButton).fixedSize()
            .help("Permission mode (shift+tab in the prompt cycles)")
            .accessibilityIdentifier("session.mode")
            #if os(macOS) && canImport(SwiftTerm)
            Picker("", selection: $showTerminal) {
                Text("Transcript").tag(false)
                Text("Terminal").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            .help("Terminal runs the agent CLI interactively in this folder")
            .accessibilityIdentifier("session.viewMode")
            #endif
            Menu {
                if let s = session {
                    Menu("Switch agent") {
                        ForEach(happier.agents.filter(\.enabled)) { a in
                            Button(a.name) { happier.switchAgent(sessionID, to: a.id) }.disabled(a.id == s.agentID)
                        }
                    }
                    if let c = s.claudeSessionID {
                        Button("Copy resume command", systemImage: "doc.on.doc") { Clipboard.copy("cd '\(s.cwd)' && claude --resume \(c)") }
                    }
                    #if os(macOS)
                    if s.cwd.hasPrefix("/") {
                        Button("Show folder in Finder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: s.cwd)]) }
                    }
                    #endif
                    Button("Stop agent", systemImage: "power") { happier.stop(sessionID) }.disabled(!happier.isLive(sessionID))
                    Divider()
                    Button("Delete session", systemImage: "trash", role: .destructive) {
                        model.agentSessionID = nil
                        happier.deleteSession(sessionID)
                    }
                }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if items.isEmpty && !busy {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("✻ Welcome to \(happier.agent(session?.agentID ?? "")?.name ?? "the agent")!").fontWeight(.semibold)
                            Text("  cwd: \(session?.cwd ?? "")").foregroundStyle(Theme.secondary)
                            Text("  Tip: shift+tab switches permission modes · esc interrupts").foregroundStyle(Theme.secondary)
                        }
                        .padding(12)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.6)))
                    }
                    ForEach(items) { ConsoleItemView(item: $0) }
                    if busy {
                        ForEach((happier.events[sessionID] ?? []).filter { $0.time >= turnStart }.suffix(12)) { e in
                            ConsoleLine(bullet: "⏺", bulletColor: e.status == "failed" ? .red : .green) {
                                Text(e.text).lineLimit(4)
                            }
                        }
                        if let th = happier.thoughts[sessionID], !th.isEmpty {
                            ConsoleLine(bullet: "✻", bulletColor: Theme.secondary) {
                                Text(th.suffix(600)).italic().foregroundStyle(Theme.secondary).lineLimit(4)
                            }
                        }
                        if let live = happier.liveText[sessionID], !live.isEmpty {
                            ConsoleLine(bullet: "⏺", bulletColor: Theme.primary) { Text(ConsoleItemView.markdown(live)).textSelection(.enabled) }
                        }
                    }
                    ForEach(pending) { PermissionPrompt(item: $0) }
                    if busy { WorkingIndicator(since: turnStart) }
                    Color.clear.frame(height: 1).id("end")
                }
                .font(Self.mono)
                .padding(.horizontal, 18).padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: items.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: happier.liveText[sessionID]?.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: pending.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
        .background(Color.primary.opacity(0.015))
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(">").foregroundStyle(Theme.secondary)
                TextField("", text: $input, prompt: Text(busy ? "Queue a follow-up…" : "Try \"explain this codebase\"").foregroundStyle(.tertiary), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...10)
                    .focused($focused)
                    .onSubmit(send)
                    .onKeyPress(keys: [.tab, KeyEquivalent("\u{19}")], phases: .down) { press in
                        guard press.modifiers.contains(.shift) || press.key == KeyEquivalent("\u{19}") else { return .ignored }
                        happier.cycleMode(sessionID)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        guard busy else { return .ignored }
                        happier.cancel(sessionID)
                        return .handled
                    }
                    .onKeyPress(characters: .decimalDigits, phases: .down) { press in
                        guard input.isEmpty, let item = pending.first, let n = Int(press.characters) else { return .ignored }
                        let opts = PermissionPrompt.options(item)
                        guard opts.indices.contains(n - 1) else { return .ignored }
                        happier.resolve(item, decision: opts[n - 1].id)
                        return .handled
                    }
                    .accessibilityIdentifier("session.input")
                if busy {
                    Button { happier.cancel(sessionID) } label: { Image(systemName: "stop.fill") }
                        .buttonStyle(.plain).foregroundStyle(Theme.secondary).help("Interrupt (esc)")
                } else {
                    Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 16)) }
                        .buttonStyle(.plain).foregroundStyle(input.isEmpty ? Theme.secondary : Color.accentColor)
                        .disabled(input.isEmpty)
                        .accessibilityIdentifier("session.send")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.secondary.opacity(focused ? 0.7 : 0.35)))
            HStack {
                let mode = HappierModel.claudeModes.first { $0.id == happier.mode(sessionID) }
                Text(mode?.footer ?? "? for shortcuts")
                    .foregroundStyle(happier.mode(sessionID) == "default" ? Theme.secondary : (happier.mode(sessionID) == "plan" ? Color.teal : Color.purple))
                Spacer()
                if busy { Text("esc to interrupt").foregroundStyle(Theme.secondary) }
                else if let s = session { Text(happier.agent(s.agentID)?.name ?? s.agentID).foregroundStyle(Theme.secondary) }
            }
            .font(.system(size: 11, design: .monospaced))
            .padding(.horizontal, 4)
        }
        .font(Self.mono)
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
    }

    private func send() {
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        input = ""
        happier.send(sessionID, t)
    }

    private func reload() async {
        let md = happier.transcript(sessionID)
        let parsed = await Task.detached(priority: .userInitiated) {
            Log.measure("transcript-parse", category: "agents", warnAfter: 0.15) { TranscriptParser.parse(md) }
        }.value
        if parsed != items { items = parsed }
    }

    private func terminalCommand(_ s: AgentSession) -> String {
        switch s.agentID {
        case "codex": return "codex"
        case "gemini": return "gemini"
        default:
            if let c = s.claudeSessionID { return "claude --resume \(c)" }
            return "claude"
        }
    }
}

/// "⏺ text" with a hanging indent.
struct ConsoleLine<Content: View>: View {
    let bullet: String
    var bulletColor: Color = Theme.primary
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(bullet).foregroundStyle(bulletColor).frame(width: 14, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ConsoleItemView: View {
    let item: TranscriptItem
    @State private var expanded = false

    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    var body: some View {
        switch item.kind {
        case .user:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(">").foregroundStyle(Theme.secondary)
                Text(item.text).textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.06)))
        case .agent:
            ConsoleLine(bullet: "⏺") { Text(Self.markdown(item.text)).textSelection(.enabled) }
        case .thought:
            ConsoleLine(bullet: "✻", bulletColor: Theme.secondary) {
                Text(item.text).italic().foregroundStyle(Theme.secondary).lineLimit(expanded ? nil : 2)
                    .onTapGesture { expanded.toggle() }
            }
        case .tool:
            ConsoleLine(bullet: "⏺", bulletColor: item.failed ? .red : .green) {
                (Text(Self.toolName(item.toolKind)).fontWeight(.bold) + Text(item.text.isEmpty ? "" : "(\(item.text))"))
                    .lineLimit(expanded ? nil : 2)
                if let out = item.output, !out.isEmpty { output(out) }
            }
        case .plan:
            ConsoleLine(bullet: "⏺") {
                Text("Update Todos").fontWeight(.bold)
                ForEach(Array(item.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    let done = line.contains("[x]") || line.contains("✓")
                    let clean = line.replacingOccurrences(of: "- [ ] ", with: "").replacingOccurrences(of: "- [x] ", with: "")
                        .trimmingCharacters(in: .whitespaces)
                    if !clean.isEmpty {
                        HStack(spacing: 6) {
                            Text(done ? "☒" : "☐")
                            Text(clean).strikethrough(done)
                        }
                        .foregroundStyle(done ? Theme.secondary : Theme.primary)
                        .padding(.leading, 12)
                    }
                }
            }
        case .notice, .system:
            ConsoleLine(bullet: "⎿", bulletColor: Theme.secondary) { Text(item.text).foregroundStyle(Theme.secondary).font(.system(size: 11.5, design: .monospaced)) }
        case .error:
            ConsoleLine(bullet: "⏺", bulletColor: .red) { Text("Error: " + item.text).foregroundStyle(.red).textSelection(.enabled) }
        }
    }

    @ViewBuilder
    private func output(_ out: String) -> some View {
        let lines = out.components(separatedBy: "\n")
        let shown = expanded ? lines : Array(lines.prefix(4))
        HStack(alignment: .top, spacing: 6) {
            Text("⎿").foregroundStyle(Theme.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(shown.joined(separator: "\n")).foregroundStyle(item.failed ? Color.red.opacity(0.9) : Theme.secondary)
                    .textSelection(.enabled)
                if lines.count > 4 {
                    Button(expanded ? "collapse" : "… +\(lines.count - 4) lines (click to expand)") { expanded.toggle() }
                        .buttonStyle(.plain).foregroundStyle(Theme.secondary.opacity(0.8))
                }
            }
        }
        .font(.system(size: 11.5, design: .monospaced))
    }

    static func toolName(_ kind: String?) -> String {
        switch kind {
        case "execute"?: return "Bash"
        case "edit"?: return "Update"
        case "read"?: return "Read"
        case "search"?: return "Search"
        case "fetch"?: return "Fetch"
        case "delete"?: return "Delete"
        case "move"?: return "Move"
        case "think"?: return "Think"
        case let k?: return k.prefix(1).uppercased() + k.dropFirst()
        case nil: return "Tool"
        }
    }
}

/// Claude Code's "Do you want to proceed?" box, answering the matching Inbox item.
struct PermissionPrompt: View {
    @Environment(HappierModel.self) private var happier
    let item: InboxItem
    @State private var hovered: Int?

    static func options(_ item: InboxItem) -> [(id: String, label: String)] {
        let parsed: [(id: String, label: String)] = item.options.map { o in
            let parts = o.split(separator: "=", maxSplits: 1).map(String.init)
            return (parts.first ?? o, parts.count > 1 ? parts[1] : o)
        }
        if !parsed.isEmpty { return parsed }
        return [("allow_once", "Yes"), ("allow_always", "Yes, and don't ask again this session"), ("reject_once", "No, and tell the agent what to do differently")]
    }

    var body: some View {
        let opts = Self.options(item)
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title).fontWeight(.bold)
            if !item.detail.isEmpty {
                Text(item.detail).foregroundStyle(Theme.secondary).lineLimit(12).textSelection(.enabled)
                    .padding(.leading, 12)
            }
            Text("Do you want to proceed?").padding(.top, 2)
            ForEach(Array(opts.enumerated()), id: \.offset) { i, o in
                Button { happier.resolve(item, decision: o.id) } label: {
                    HStack(spacing: 6) {
                        Text(i == (hovered ?? 0) ? "❯" : " ").foregroundStyle(Color.accentColor)
                        Text("\(i + 1). \(o.label)")
                            .foregroundStyle(i == (hovered ?? 0) ? Color.accentColor : Theme.primary)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { if $0 { hovered = i } }
                .accessibilityIdentifier("permission.option\(i + 1)")
            }
            Text("Press 1–\(opts.count) in the prompt box, or click").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Theme.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.7)))
        .accessibilityIdentifier("permission.prompt")
    }
}

/// "✶ Working… (12s · esc to interrupt)" with Claude Code's spinner glyphs.
struct WorkingIndicator: View {
    let since: Date
    static let glyphs = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.12)) { ctx in
            let t = ctx.date.timeIntervalSince(since)
            HStack(spacing: 6) {
                Text(Self.glyphs[Int(t / 0.12) % Self.glyphs.count]).foregroundStyle(.orange)
                Text("Working…").foregroundStyle(.orange)
                Text("(\(Int(t))s · esc to interrupt)").foregroundStyle(Theme.secondary)
            }
        }
        .accessibilityIdentifier("session.working")
    }
}

// MARK: - CLI history

/// Read-only transcript of a Claude Code / Codex CLI session from disk, with "Resume".
struct CLISessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    let session: CLISession
    @State private var messages: [CLIMessage] = []
    @State private var loading = true
    @State private var terminal = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                AgentIcon(icon: session.tool == "codex" ? "🅾️" : "✴️", size: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title.nonEmptyOr("Untitled")).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Text(session.cwd).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.head)
                }
                Spacer()
                Button { Clipboard.copy(session.resumeCommand) } label: { Label("Copy command", systemImage: "doc.on.doc") }
                #if os(macOS) && canImport(SwiftTerm)
                Button { terminal.toggle() } label: { Label(terminal ? "Transcript" : "Resume in terminal", systemImage: terminal ? "text.alignleft" : "terminal") }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("cli.resume")
                #endif
            }
            .controlSize(.small)
            .padding(.horizontal, 16).padding(.vertical, 9)
            Divider()
            #if os(macOS) && canImport(SwiftTerm)
            if terminal {
                AgentTerminalView(key: "cli-" + session.id, cwd: session.cwd,
                                  command: session.tool == "codex" ? "codex resume \(session.id)" : "claude --resume \(session.id)")
            } else {
                transcript
            }
            #else
            transcript
            #endif
        }
        .task { await load() }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if loading { ProgressView().controlSize(.small) }
                ForEach(messages) { m in
                    switch m.role {
                    case .user:
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(">").foregroundStyle(Theme.secondary)
                            Text(m.text).textSelection(.enabled)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.06)))
                    case .assistant:
                        ConsoleLine(bullet: "⏺") { Text(ConsoleItemView.markdown(m.text)).textSelection(.enabled) }
                    case .tool:
                        ConsoleLine(bullet: "⏺", bulletColor: .green) {
                            (Text(m.toolName ?? "Tool").fontWeight(.bold) + Text("(\(m.text.prefix(160)))")).lineLimit(2)
                        }
                    case .toolResult:
                        HStack(alignment: .top, spacing: 6) {
                            Text("⎿").foregroundStyle(Theme.secondary)
                            Text(m.text.components(separatedBy: "\n").prefix(4).joined(separator: "\n")).foregroundStyle(Theme.secondary)
                        }
                        .font(.system(size: 11.5, design: .monospaced))
                        .padding(.leading, 22)
                    case .thinking:
                        ConsoleLine(bullet: "✻", bulletColor: Theme.secondary) { Text(m.text).italic().foregroundStyle(Theme.secondary).lineLimit(3) }
                    case .summary:
                        ConsoleLine(bullet: "⎿", bulletColor: Theme.secondary) { Text(m.text).foregroundStyle(Theme.secondary) }
                    }
                }
            }
            .font(SessionConsole.mono)
            .padding(.horizontal, 18).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func load() async {
        let s = session
        messages = await Task.detached(priority: .userInitiated) {
            Log.measure("cli-transcript", category: "agents", warnAfter: 0.5) { CLISessionIndex.transcript(of: s) }
        }.value
        loading = false
    }
}

// MARK: - Setup & diagnosis

/// Agent setup made simple: what's installed, what's missing (with the exact command), login state, and
/// one-click tests for Claude Code and every ACP agent.
struct AgentDoctorView: View {
    @Environment(HappierModel.self) private var happier
    @Environment(\.dismiss) private var dismiss
    @State private var tools: [AgentDoctor.Tool] = []
    @State private var statuses: [AgentDoctor.AgentStatus] = []
    @State private var probing = false
    @State private var testOutput: [String: String] = [:]
    @State private var testing: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Agent setup").font(.title2.bold())
                Spacer()
                Button { Task { await probe() } } label: { Label("Check again", systemImage: "arrow.clockwise") }.disabled(probing)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(18)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if AppDiagnostics.isSandboxed {
                        Label("Sandboxed build: agents can't launch local processes. Set `BASED_AGENTS_SUFFIX = -Agents` in Config/Local.xcconfig and rebuild, or use a Based server.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    if !ShellEnvironment.note.isEmpty {
                        Text(ShellEnvironment.note).font(.caption).foregroundStyle(Theme.secondary)
                    }
                    group("Tools") {
                        if probing && tools.isEmpty { ProgressView().controlSize(.small) }
                        ForEach(tools) { t in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: t.ok ? "checkmark.circle.fill" : (t.required ? "xmark.octagon.fill" : "circle.dashed"))
                                    .foregroundStyle(t.ok ? Color.green : (t.required ? Color.red : Color.secondary))
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(t.name).fontWeight(.medium)
                                        if let v = t.version { Text(v).font(.caption.monospaced()).foregroundStyle(Theme.secondary) }
                                    }
                                    Text(t.purpose).font(.caption).foregroundStyle(Theme.secondary)
                                    if let p = t.path { Text(p).font(.caption.monospaced()).foregroundStyle(Theme.secondary) }
                                    if !t.ok { CommandRow(command: t.install) }
                                }
                            }
                        }
                    }
                    group("Agents") {
                        ForEach(statuses) { s in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Circle().fill(s.state == .ready ? Color.green : (s.state == .needsLogin ? Color.orange : Color.red)).frame(width: 8, height: 8)
                                    Text(s.name).fontWeight(.medium)
                                    Text(s.driver).font(.caption).foregroundStyle(Theme.secondary)
                                    Spacer()
                                    Button(testing.contains(s.id) ? "Testing…" : "Test") { test(s.id) }
                                        .disabled(testing.contains(s.id) || s.state == .missing)
                                        .controlSize(.small)
                                        .accessibilityIdentifier("doctor.test.\(s.id)")
                                }
                                Text(s.summary).font(.caption).foregroundStyle(Theme.secondary)
                                if let fix = s.fix { CommandRow(command: fix) }
                                if let out = testOutput[s.id] {
                                    Text(out).font(.caption.monospaced()).textSelection(.enabled)
                                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(Theme.codeBackground)))
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    group("Workspace access for agents") {
                        if let url = happier.mcpBaseURL {
                            Label("Built-in MCP server running at \(url)/mcp (loopback only, token-protected).", systemImage: "checkmark.shield")
                                .font(.callout)
                        } else {
                            Label("The built-in MCP server is not running (it starts with the app unless UI testing).", systemImage: "exclamationmark.circle")
                                .font(.callout).foregroundStyle(Theme.secondary)
                        }
                        Text("Claude Code sessions and chats get it automatically via --mcp-config, so agents can search, read and edit pages, memories and skills.")
                            .font(.caption).foregroundStyle(Theme.secondary)
                    }
                }
                .padding(18)
            }
        }
        .frame(minWidth: 620, minHeight: 560)
        .task { await probe() }
        .accessibilityIdentifier("doctor")
    }

    private func group<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            c()
        }
    }

    private func probe() async {
        probing = true
        ShellEnvironment.refresh()
        let defs = happier.agents.filter(\.enabled)
        let (t, s) = await Task.detached(priority: .userInitiated) {
            let tools = AgentDoctor.probeTools()
            return (tools, defs.map { AgentDoctor.status(of: $0, tools: tools) })
        }.value
        tools = t; statuses = s; probing = false
        for x in s where x.state != .ready { Log.notice("agent \(x.id): \(x.state.rawValue) — \(x.summary)", category: "agents") }
    }

    private func test(_ id: String) {
        guard let def = happier.agent(id) else { return }
        testing.insert(id)
        testOutput[id] = nil
        Task {
            let r: Result<String, Error>
            if id == "claude" {
                r = await Task.detached { AgentDoctor.testClaude() }.value
            } else {
                r = await AgentDoctor.testACP(def, cwd: happier.defaultDirectory)
            }
            switch r {
            case .success(let s): testOutput[id] = "✓ " + s
            case .failure(let e): testOutput[id] = "✗ \(e)"; Log.warning("agent test \(id) failed: \(e)", category: "agents")
            }
            testing.remove(id)
        }
    }
}

/// A shell command with a copy button (install / login fixes).
struct CommandRow: View {
    let command: String
    var body: some View {
        HStack(spacing: 6) {
            Text(command).font(.caption.monospaced()).textSelection(.enabled).lineLimit(2)
            Spacer(minLength: 4)
            Button { Clipboard.copy(command) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless).help("Copy command")
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(Theme.codeBackground)))
    }
}
