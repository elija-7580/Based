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
        @Bindable var model = model
        VStack(spacing: 0) {
            modeBar
            Divider()
            switch model.agentsMode {
            case .sessions:
                HStack(spacing: 0) {
                    sessionList
                        .frame(width: 290)
                    Divider()
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .board:
                AgentBoardView()
            case .canvas:
                AgentCanvasView()
            }
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

    /// Sessions | Board | Canvas, live counts, setup and "new session".
    private var modeBar: some View {
        @Bindable var model = model
        let running = happier.runningCount
        let waiting = happier.agentSessions.filter { happier.status(of: $0) == .waiting }.count
        return HStack(spacing: 10) {
            Text("Agents").font(.system(size: 14, weight: .semibold))
            Picker("", selection: $model.agentsMode) {
                Label("Sessions", systemImage: "terminal").tag(AppModel.AgentsMode.sessions)
                Label("Board", systemImage: "rectangle.split.3x1").tag(AppModel.AgentsMode.board)
                Label("Canvas", systemImage: "point.3.connected.trianglepath.dotted").tag(AppModel.AgentsMode.canvas)
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            .accessibilityIdentifier("agents.mode")
            if running > 0 {
                HStack(spacing: 4) { StatusDot(status: .running, size: 6); Text("\(running) running") }
                    .font(.system(size: 12)).foregroundStyle(Color.blue)
            }
            if waiting > 0 || happier.pendingCount > 0 {
                Button { model.selection = .inbox } label: {
                    Label("\(max(waiting, happier.pendingCount)) waiting for you", systemImage: "hand.raised.fill")
                }
                .buttonStyle(.hoverFill).font(.system(size: 12)).foregroundStyle(.orange)
            }
            Spacer()
            Button { showDoctor = true } label: { Image(systemName: "stethoscope") }
                .help("Agent setup & diagnosis").accessibilityIdentifier("agents.doctor")
            Button { model.showNewSession = true } label: { Label("New session", systemImage: "plus") }
                .help("New session (Claude Code, Codex …)").accessibilityIdentifier("sessions.new")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 14).padding(.vertical, 7)
    }

    private var sessionList: some View {
        VStack(spacing: 0) {
            TextField("Filter sessions", text: $filter)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
            List(selection: selection) {
                Label("Overview", systemImage: "square.grid.2x2").tag("overview")
                ForEach(groups, id: \.name) { g in
                    Section(g.name) {
                        ForEach(Self.treeOrder(g.sessions), id: \.session.id) { e in
                            AgentSessionRow(session: e.session, depth: e.depth).tag("s:" + e.session.id)
                                .contextMenu { AgentSessionMenu(session: e.session) }
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

    /// Parents first, each followed by its sub-agents (indented); orphans (parent elsewhere) stay top-level.
    static func treeOrder(_ list: [AgentSession]) -> [(session: AgentSession, depth: Int)] {
        let ids = Set(list.map(\.id))
        var kids: [RecordID: [AgentSession]] = [:]
        for s in list { if let p = s.parentID, ids.contains(p), p != s.id { kids[p, default: []].append(s) } }
        var out: [(AgentSession, Int)] = [], seen: Set<RecordID> = []
        func walk(_ s: AgentSession, _ d: Int) {
            guard !seen.contains(s.id) else { return }
            seen.insert(s.id); out.append((s, d))
            for k in (kids[s.id] ?? []).sorted(by: { $0.startedAt < $1.startedAt }) { walk(k, min(d + 1, 4)) }
        }
        for s in list where s.parentID == nil || !ids.contains(s.parentID!) { walk(s, 0) }
        for s in list where !seen.contains(s.id) { walk(s, 0) }   // cycles
        return out.map { (session: $0.0, depth: $0.1) }
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
    var depth = 0

    var body: some View {
        let st = happier.status(of: session)
        HStack(spacing: 8) {
            if depth > 0 {
                Image(systemName: "arrow.turn.down.right").font(.system(size: 9)).foregroundStyle(Theme.secondary)
                    .padding(.leading, CGFloat(depth - 1) * 12)
            }
            AgentIcon(icon: happier.agent(session.agentID)?.icon ?? "terminal", size: 13).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.nonEmptyOr("Untitled session")).lineLimit(1)
                HStack(spacing: 4) {
                    Circle().fill(st.color).frame(width: 6, height: 6)
                    Text(st.rawValue)
                    Text("·")
                    Text(session.updatedAt.formatted(.relative(presentation: .named)))
                }
                .font(.system(size: 10.5)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if happier.isWorking(session.id) { ProgressView().controlSize(.mini) }
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
                            Button { model.agentSessionID = s.id } label: { AgentSessionRow(session: s) }.buttonStyle(.hoverFill)
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
                        .buttonStyle(.hoverFill)
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
    /// `/clear` hides everything before this item (the transcript itself stays in the session page).
    @State private var clearedBefore = 0
    @State private var notes: [LocalNote] = []
    @State private var selection = 0
    @State private var dismissedInput: String?
    @State private var fileIndex: [String] = []
    @State private var fileIndexRoot = ""
    @FocusState private var focused: Bool

    static let mono = Font.system(size: 12.5, design: .monospaced)
    /// Claude Code's orange.
    static let accent = Color(red: 0.84, green: 0.47, blue: 0.34)

    /// Output of local slash commands (/help, /status, /cost …), shown in the console only.
    struct LocalNote: Identifiable, Equatable {
        let id = UUID()
        var command: String
        var lines: [String]
    }

    enum Completion: Identifiable {
        case command(ConsoleCompletion.Command)
        case file(String)
        var id: String {
            switch self {
            case .command(let c): return "/" + c.name
            case .file(let f): return "@" + f
            }
        }
    }

    private var session: AgentSession? { happier.sessions.first { $0.id == sessionID } }
    private var busy: Bool { happier.isWorking(sessionID) }
    private var pending: [InboxItem] { happier.pendingInbox(for: sessionID) }
    private var visibleItems: [TranscriptItem] { Array(items.dropFirst(clearedBefore)) }
    private var modelName: String? { ConsoleCompletion.model(fromNotices: items.filter { $0.kind == .notice }.map(\.text)) }

    private var completions: [Completion] {
        guard input != dismissedInput else { return [] }
        let cmds = ConsoleCompletion.commandMatches(input)
        if !cmds.isEmpty { return cmds.map { .command($0) } }
        if let q = ConsoleCompletion.mentionQuery(input), !fileIndex.isEmpty {
            return ConsoleCompletion.rank(fileIndex, query: q).map { .file($0) }
        }
        return []
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let s = session, !happier.children(of: s.id).isEmpty {
                Divider()
                subAgentStrip(s)
            }
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
        .task(id: sessionID) { await happier.loadSandbox(sessionID) }
        .onChange(of: busy) { _, b in if b { turnStart = Date() } }
        .onChange(of: sessionID) { _, _ in clearedBefore = 0; notes = []; input = "" }
        .onChange(of: input) { _, new in
            selection = 0
            if new != dismissedInput { dismissedInput = nil }
            if ConsoleCompletion.mentionQuery(new) != nil { loadFileIndex() }
        }
        .onAppear { focused = true }
        .accessibilityIdentifier("session.console")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            AgentIcon(icon: happier.agent(session?.agentID ?? "")?.icon ?? "terminal", size: 16)
            VStack(alignment: .leading, spacing: 1) {
                if let s = session, let p = happier.parent(of: s) {
                    Button { model.openSession(p.id) } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.turn.left.up")
                            Text(p.title.nonEmptyOr("Parent session")).lineLimit(1)
                        }
                        .font(.system(size: 10.5)).foregroundStyle(Theme.secondary)
                    }
                    .buttonStyle(.hoverFill)
                    .help("Sub-agent of \(p.title) — open the parent session")
                    .accessibilityIdentifier("session.parent")
                }
                Text(session?.title.nonEmptyOr("Untitled session") ?? "Session").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text(session?.cwd ?? "").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary)
                    .lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: 12)
            if let s = session {
                let st = happier.status(of: s)
                HStack(spacing: 5) {
                    StatusDot(status: st, size: 7)
                    Text(st.rawValue)
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
                    Button("New sub-agent…", systemImage: "arrow.triangle.branch") { model.newSubAgent(of: sessionID) }
                    Button("Show on canvas", systemImage: "point.3.connected.trianglepath.dotted") { model.agentsMode = .canvas }
                    Divider()
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
                    // BSD-106: save / restore the sandbox (container image + workspace) of this session.
                    if let snaps = happier.sandboxSnapshots[sessionID] {
                        Menu("Sandbox") {
                            Button("Save snapshot", systemImage: "camera") { happier.saveSnapshot(sessionID) }
                            if !snaps.isEmpty {
                                Divider()
                                ForEach(snaps.reversed(), id: \.self) { name in
                                    Button("Restore “\(name)”", systemImage: "clock.arrow.circlepath") { happier.restoreSnapshot(sessionID, name: name) }
                                }
                            }
                        }
                    }
                    Button("Stop agent", systemImage: "power") { happier.stop(sessionID) }.disabled(!happier.isLive(sessionID))
                    Divider()
                    Button("Delete session", systemImage: "trash", role: .destructive) {
                        model.agentSessionID = nil
                        happier.deleteSession(sessionID)
                    }
                }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityIdentifier("session.menu")
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
    }

    /// Chips for the session's sub-agents: live status, click to open.
    private func subAgentStrip(_ s: AgentSession) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.secondary)
                Text("Sub-agents").foregroundStyle(Theme.secondary)
                ForEach(happier.children(of: s.id)) { c in
                    Button { model.openSession(c.id) } label: {
                        HStack(spacing: 5) {
                            StatusDot(status: happier.status(of: c), size: 6)
                            Text(c.title.nonEmptyOr("Sub-agent")).lineLimit(1)
                            if !happier.children(of: c.id).isEmpty {
                                Text("+\(happier.children(of: c.id).count)").foregroundStyle(Theme.secondary)
                            }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.primary.opacity(0.06)))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(c.task.isEmpty ? c.title : c.task)
                }
                Button { model.newSubAgent(of: s.id) } label: { Image(systemName: "plus") }
                    .buttonStyle(.quiet).foregroundStyle(Theme.secondary).help("New sub-agent…")
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
        .accessibilityIdentifier("session.subagents")
    }

    // MARK: Transcript

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                (Text("✻ ").foregroundStyle(Self.accent) + Text("Welcome to \(happier.agent(session?.agentID ?? "")?.name ?? "the agent")!").fontWeight(.semibold))
                Text("  /help for help, /status for your current setup").italic().foregroundStyle(Theme.secondary)
                Text("  cwd: \(session?.cwd ?? "")").foregroundStyle(Theme.secondary)
                if let s = session, let p = happier.parent(of: s) {
                    Text("  ↳ sub-agent of \(p.title.nonEmptyOr("a session"))").foregroundStyle(Theme.secondary)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Self.accent.opacity(0.75)))
            if visibleItems.isEmpty && !busy {
                VStack(alignment: .leading, spacing: 4) {
                    Text(" Tips for getting started:").foregroundStyle(Theme.secondary)
                    Text(" 1. Ask the agent to explain, fix or build something in this folder")
                    Text(" 2. Mention files with @, e.g. \"refactor @Sources/App.swift\"")
                    Text(" 3. /spawn <task> starts a sub-agent; /agents shows all of them on the canvas")
                    Text(" 4. Run /init to create instructions for the agent in this project")
                }
                .foregroundStyle(Theme.secondary.opacity(0.9))
                Text(" ※ Tip: shift+tab switches permission modes · esc interrupts").foregroundStyle(Theme.secondary)
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if clearedBefore == 0 { welcome }
                    // BSD-96 (ADR 0005): replies render with the chat's part views (thinking, tool cards, to-dos, diffs).
                    ForEach(SessionTranscript.segments(visibleItems)) { seg in
                        switch seg {
                        case .user(let item), .line(let item): ConsoleItemView(item: item)
                        case .reply(_, let parts):
                            AssistantMessageView(turn: ChatTurn(role: .assistant, text: "", reply: Self.reply(parts)))
                                .font(.system(size: 13))
                        }
                    }
                    if busy, let live = happier.live[sessionID], !live.parts.isEmpty {
                        AssistantMessageView(turn: ChatTurn(role: .assistant, text: "", reply: live, isRunning: true))
                            .font(.system(size: 13))
                    }
                    ForEach(notes) { n in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(">").foregroundStyle(Theme.secondary)
                                Text(n.command)
                            }
                            ConsoleLine(bullet: "⎿", bulletColor: Theme.secondary) {
                                ForEach(Array(n.lines.enumerated()), id: \.offset) { _, l in
                                    Text(l.isEmpty ? " " : l).foregroundStyle(Theme.secondary).textSelection(.enabled)
                                }
                            }
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
            .onChange(of: notes.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: happier.liveText[sessionID]?.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: happier.live[sessionID]?.parts.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: pending.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
        .background(Color.primary.opacity(0.015))
    }

    /// Saved parts of one reply as a finished turn.
    static func reply(_ parts: [ChatPart]) -> ChatTurnBuilder {
        var b = ChatTurnBuilder()
        for p in parts { b.restore(p) }
        return b
    }

    // MARK: Composer

    private var composer: some View {
        let list = completions
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(">").foregroundStyle(Theme.secondary)
                TextField("", text: $input, prompt: Text(busy ? "Queue a follow-up…" : "Try \"explain this codebase\" · / for commands · @ for files").foregroundStyle(.tertiary), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...10)
                    .focused($focused)
                    .onSubmit(send)
                    .onKeyPress(keys: [.tab, KeyEquivalent("\u{19}")], phases: .down) { press in
                        guard press.modifiers.contains(.shift) || press.key == KeyEquivalent("\u{19}") else { return .ignored }
                        happier.cycleMode(sessionID)
                        return .handled
                    }
                    .onKeyPress(keys: [.upArrow, .downArrow, .tab, .return], phases: [.down, .repeat]) { press in
                        let list = completions
                        guard !list.isEmpty else { return .ignored }
                        if press.key == .upArrow { selection = (min(selection, list.count - 1) - 1 + list.count) % list.count; return .handled }
                        if press.key == .downArrow { selection = (min(selection, list.count - 1) + 1) % list.count; return .handled }
                        accept(list[min(selection, list.count - 1)], submit: press.key == .return)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        if !completions.isEmpty { dismissedInput = input; return .handled }
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
                        .buttonStyle(.quiet).foregroundStyle(Theme.secondary).help("Interrupt (esc)")
                } else {
                    Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 16)) }
                        .buttonStyle(.hoverFill).foregroundStyle(input.isEmpty ? Theme.secondary : Theme.accentBlue)
                        .disabled(input.isEmpty)
                        .accessibilityIdentifier("session.send")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.secondary.opacity(focused ? 0.7 : 0.35)))
            if !list.isEmpty {
                completionList(list)
            } else {
                statusLine
            }
        }
        .font(Self.mono)
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
    }

    /// "⏵⏵ accept edits on · Claude Code · claude-sonnet-4 · 12.3k tokens"
    private var statusLine: some View {
        HStack(spacing: 6) {
            let mode = HappierModel.claudeModes.first { $0.id == happier.mode(sessionID) }
            Text(mode?.footer ?? "? for shortcuts")
                .foregroundStyle(happier.mode(sessionID) == "default" ? Theme.secondary : (happier.mode(sessionID) == "plan" ? Color.teal : Color.purple))
            Spacer()
            if busy {
                Text("esc to interrupt").foregroundStyle(Theme.secondary)
            } else if let s = session {
                Text(statusSummary(s)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.horizontal, 4)
        .accessibilityIdentifier("session.statusLine")
    }

    private func statusSummary(_ s: AgentSession) -> String {
        var parts = [happier.agent(s.agentID)?.name ?? s.agentID]
        if let m = modelName { parts.append(m) }
        if s.tokens > 0 { parts.append(AgentCard.tokens(s.tokens)) }
        let kids = happier.children(of: s.id)
        if !kids.isEmpty {
            let running = kids.filter { happier.isWorking($0.id) }.count
            parts.append(running > 0 ? "\(running)/\(kids.count) sub-agents running" : "\(kids.count) sub-agent\(kids.count == 1 ? "" : "s")")
        }
        return parts.joined(separator: " · ")
    }

    private func completionList(_ list: [Completion]) -> some View {
        let current = min(selection, list.count - 1)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, c in
                Button { accept(c, submit: false) } label: {
                    HStack(spacing: 10) {
                        switch c {
                        case .command(let cmd):
                            Text("/" + cmd.name + (cmd.argument.map { " " + $0 } ?? ""))
                                .frame(minWidth: 160, alignment: .leading)
                            Text(cmd.summary + (cmd.local ? "" : " (sent to the agent)")).foregroundStyle(Theme.secondary).lineLimit(1)
                        case .file(let f):
                            Image(systemName: f.hasSuffix("/") ? "folder" : "doc.text").foregroundStyle(Theme.secondary)
                            Text(f).lineLimit(1).truncationMode(.head)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(i == current ? Self.accent : Theme.primary)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(i == current ? Self.accent.opacity(0.1) : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { if $0 { selection = i } }
            }
            Text("↑↓ to select · tab to complete · enter to run · esc to dismiss")
                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Theme.secondary.opacity(0.8))
                .padding(.horizontal, 8).padding(.top, 3)
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.vertical, 2)
        .accessibilityIdentifier("session.completions")
    }

    // MARK: Actions

    private func accept(_ c: Completion, submit: Bool) {
        switch c {
        case .command(let cmd):
            if cmd.argument == nil && submit {
                input = ""
                run(cmd.name, "")
            } else {
                input = "/" + cmd.name + " "
            }
        case .file(let f):
            input = ConsoleCompletion.applyMention(f, to: input)
        }
        focused = true
    }

    private func send() {
        let list = completions
        if !list.isEmpty {
            accept(list[min(selection, list.count - 1)], submit: true)
            return
        }
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        input = ""
        if let c = ConsoleCompletion.parseCommand(t), let cmd = ConsoleCompletion.commands.first(where: { $0.name == c.name }), cmd.local {
            run(cmd.name, c.argument)
            return
        }
        happier.send(sessionID, t)
    }

    /// Local slash commands; unknown ones are sent to the agent as typed.
    private func run(_ name: String, _ arg: String) {
        let typed = "/" + name + (arg.isEmpty ? "" : " " + arg)
        func note(_ lines: [String]) { notes.append(LocalNote(command: typed, lines: lines)) }
        guard let s = session else { return }
        switch name {
        case "help":
            note(ConsoleCompletion.commands.map { c in
                let n = "/" + c.name + (c.argument.map { " " + $0 } ?? "")
                return n.padding(toLength: max(n.count, 18), withPad: " ", startingAt: 0) + "  " + c.summary
            } + ["", "Shortcuts: shift+tab permission mode · esc interrupt · @ mention a file · 1–3 answer a permission prompt",
                 "Other /commands are sent to the agent as typed."])
        case "status":
            var lines = [
                "Agent: \(happier.agent(s.agentID)?.name ?? s.agentID)",
                "Model: \(modelName ?? "default")",
                "cwd: \(s.cwd)",
                "Project: \(s.project.isEmpty ? "—" : s.project)",
                "Permission mode: \(HappierModel.claudeModes.first { $0.id == happier.mode(sessionID) }?.title ?? happier.mode(sessionID))",
                "Status: \(happier.status(of: s).rawValue)\(happier.isLive(sessionID) ? " (process running)" : "")",
                "Session: \(s.id)",
            ]
            if let a = s.acpSessionID { lines.append("Agent session: \(a)") }
            if let c = s.claudeSessionID { lines.append("Claude session: \(c)") }
            if let p = happier.parent(of: s) { lines.append("Parent: \(p.title) (\(p.id))") }
            let kids = happier.children(of: s.id)
            if !kids.isEmpty { lines.append("Sub-agents: \(kids.count) (\(kids.filter { happier.isWorking($0.id) }.count) running)") }
            lines.append("Based MCP: \(happier.mcpBaseURL ?? "off")")
            note(lines)
        case "cost":
            let kids = happier.children(of: s.id)
            let sub = kids.reduce(0) { $0 + $1.tokens }
            note(["Total tokens: \(s.tokens)"] + (kids.isEmpty ? [] : ["Sub-agents: \(sub) tokens across \(kids.count) session\(kids.count == 1 ? "" : "s")", "Together: \(s.tokens + sub)"]))
        case "clear":
            clearedBefore = items.count
            notes = []
        case "spawn":
            guard !arg.isEmpty else { note(["Usage: /spawn <task> — starts a sub-agent in \(s.cwd)"]); return }
            happier.spawnSubAgent(parent: sessionID, agentID: s.agentID, prompt: arg, title: nil)
            note(["Starting a \(happier.agent(s.agentID)?.name ?? s.agentID) sub-agent in \(s.cwd)…"])
        case "subagent":
            model.newSubAgent(of: sessionID)
        case "agents":
            model.agentsMode = .canvas
        case "board":
            model.agentsMode = .board
        case "mode":
            if arg.isEmpty { happier.cycleMode(sessionID) }
            else if let m = HappierModel.claudeModes.first(where: { $0.id.lowercased().hasPrefix(arg.lowercased()) || $0.title.lowercased().hasPrefix(arg.lowercased()) }) {
                happier.setMode(sessionID, m.id)
            } else {
                note(["Unknown mode \"\(arg)\". Modes: " + HappierModel.claudeModes.map(\.id).joined(separator: ", ")])
                return
            }
            note(["Permission mode: \(HappierModel.claudeModes.first { $0.id == happier.mode(sessionID) }?.title ?? happier.mode(sessionID))"])
        case "terminal":
            #if os(macOS) && canImport(SwiftTerm)
            showTerminal.toggle()
            #else
            note(["The interactive terminal is available in the Mac app."])
            #endif
        case "stop":
            happier.stop(sessionID)
            note(["Agent process stopped. Your next message starts it again."])
        default:
            happier.send(sessionID, typed)
        }
    }

    private func loadFileIndex() {
        guard let cwd = session?.cwd, cwd.hasPrefix("/"), cwd != fileIndexRoot else { return }
        fileIndexRoot = cwd
        Task {
            let files = await Task.detached(priority: .utility) { ConsoleCompletion.files(in: cwd) }.value
            if fileIndexRoot == cwd { fileIndex = files }
        }
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
    @Environment(AppModel.self) private var model
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
            let h = ConsoleCompletion.toolHeader(kind: item.toolKind, text: item.text)
            ConsoleLine(bullet: "⏺", bulletColor: item.failed ? .red : .green) {
                (Text(h.name).fontWeight(.bold) + Text(h.argument.isEmpty ? "" : "(\(h.argument))"))
                    .lineLimit(expanded ? nil : 2)
                if let out = item.output, !out.isEmpty { output(out) }
            }
        case .diff:
            DiffBlock(path: item.text, diff: item.output ?? "")
        case .plan:
            ConsoleLine(bullet: "⏺") {
                Text("Update Todos").fontWeight(.bold)
                ForEach(Array(item.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    let done = line.contains("[x]") || line.contains("✓") || line.contains("☒")
                    let clean = line.replacingOccurrences(of: "- [ ] ", with: "").replacingOccurrences(of: "- [x] ", with: "")
                        .replacingOccurrences(of: "☐ ", with: "").replacingOccurrences(of: "☒ ", with: "")
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
            ConsoleLine(bullet: "⎿", bulletColor: Theme.secondary) {
                Text(Self.markdown(item.text)).foregroundStyle(Theme.secondary).font(.system(size: 11.5, design: .monospaced))
                    .lineLimit(expanded ? nil : 8).textSelection(.enabled)
                if let sid = ConsoleCompletion.sessionReference(in: item.text), sid != model.agentSessionID {
                    Button { model.openSession(sid) } label: {
                        Label("Open sub-agent", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.hoverFill).foregroundStyle(Theme.accentBlue).font(.system(size: 11))
                }
            }
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
                        .buttonStyle(.hoverFill).foregroundStyle(Theme.secondary.opacity(0.8))
                }
            }
        }
        .font(.system(size: 11.5, design: .monospaced))
    }

    static func toolName(_ kind: String?) -> String { ConsoleCompletion.toolName(kind) }
}

/// Claude Code's edit preview: "⎿ Updated path with 2 additions and 1 removal" and numbered red/green lines.
struct DiffBlock: View {
    let path: String
    let diff: String
    @State private var expanded = false
    static let limit = 40

    var body: some View {
        let lines = LineDiff.parse(diff)
        let added = lines.filter { $0.kind == .added }.count
        let removed = lines.filter { $0.kind == .removed }.count
        let isNew = removed == 0 && !lines.contains { $0.kind == .same }
        let shown = expanded || lines.count <= Self.limit ? lines : Array(lines.prefix(Self.limit - 10))
        HStack(alignment: .top, spacing: 6) {
            Text("⎿").foregroundStyle(Theme.secondary)
            VStack(alignment: .leading, spacing: 0) {
                Group {
                    if isNew {
                        Text("Wrote ") + Text("\(added)").fontWeight(.bold) + Text(" line\(added == 1 ? "" : "s") to ") + Text(path.isEmpty ? "file" : path).fontWeight(.bold)
                    } else {
                        Text("Updated ") + Text(path.isEmpty ? "file" : path).fontWeight(.bold)
                            + Text(" with \(added) addition\(added == 1 ? "" : "s") and \(removed) removal\(removed == 1 ? "" : "s")")
                    }
                }
                .foregroundStyle(Theme.secondary)
                .padding(.bottom, 3)
                ForEach(shown) { DiffLineRow(line: $0) }
                if lines.count > Self.limit {
                    Button(expanded ? "collapse" : "… +\(lines.count - shown.count) lines (click to expand)") { expanded.toggle() }
                        .buttonStyle(.hoverFill).foregroundStyle(Theme.secondary.opacity(0.8)).padding(.top, 2)
                }
            }
        }
        .font(.system(size: 11.5, design: .monospaced))
        .padding(.leading, 22)
        .accessibilityIdentifier("session.diff")
    }
}

struct DiffLineRow: View {
    let line: LineDiff.Line

    var body: some View {
        if line.kind == .hunk {
            Text(line.text).foregroundStyle(Color.teal.opacity(0.85)).padding(.vertical, 1)
        } else {
            HStack(spacing: 0) {
                Text(number).foregroundStyle(Theme.secondary).frame(width: 42, alignment: .trailing)
                Text(sign).foregroundStyle(signColor).frame(width: 20, alignment: .center)
                Text(line.text.isEmpty ? " " : line.text).foregroundStyle(Theme.primary).textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .background(background)
        }
    }

    private var number: String { (line.kind == .removed ? line.oldNumber : (line.newNumber ?? line.oldNumber)).map(String.init) ?? "" }
    private var sign: String { line.kind == .added ? "+" : (line.kind == .removed ? "-" : " ") }
    private var signColor: Color { line.kind == .added ? .green : (line.kind == .removed ? .red : Theme.secondary) }
    private var background: Color {
        switch line.kind {
        case .added: return Color.green.opacity(0.14)
        case .removed: return Color.red.opacity(0.14)
        default: return Color.clear
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
                        Text(i == (hovered ?? 0) ? "❯" : " ").foregroundStyle(Theme.accentBlue)
                        Text("\(i + 1). \(o.label)")
                            .foregroundStyle(i == (hovered ?? 0) ? Theme.accentBlue : Theme.primary)
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
        await ShellEnvironment.reload()   // BSD-37: re-asks the login shell off the main thread
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
