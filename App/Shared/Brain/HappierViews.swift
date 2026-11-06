import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Sessions

/// Happier‑style list of coding‑agent sessions (Claude Code, Codex, Gemini …) with live status.
struct SessionsView: View {
    @Environment(HappierModel.self) private var happier
    @State private var showNew = false
    @State private var selected: RecordID?

    var body: some View {
        @Bindable var happier = happier
        NavigationStack {
            Group {
                if happier.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No sessions yet", systemImage: "terminal")
                    } description: {
                        Text("Start Claude Code, Codex or Gemini in a folder and control it from any device. Approvals land in your Inbox.")
                    } actions: {
                        Button("New session") { showNew = true }.buttonStyle(.borderedProminent)
                    }
                } else {
                    List(happier.sessions, selection: $selected) { s in
                        NavigationLink(value: s.id) { SessionRow(session: s) }
                            .contextMenu {
                                Button("Stop agent") { happier.stop(s.id) }
                                Button("Delete", role: .destructive) { happier.deleteSession(s.id) }
                            }
                    }
                    .listStyle(.inset)
                }
            }
            .navigationTitle("Sessions")
            .navigationDestination(for: RecordID.self) { SessionDetailView(sessionID: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Label("New session", systemImage: "plus") }
                        .accessibilityIdentifier("sessions.new")
                }
            }
            .sheet(isPresented: $showNew) { NewSessionSheet().environment(happier) }
            .alert("Agent error", isPresented: Binding(get: { happier.lastError != nil }, set: { if !$0 { happier.lastError = nil } })) {
                Button("OK") { happier.lastError = nil }
            } message: { Text(happier.lastError ?? "") }
        }
        .accessibilityIdentifier("sessions.list")
    }
}

struct SessionRow: View {
    @Environment(HappierModel.self) private var happier
    let session: AgentSession
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: happier.agent(session.agentID)?.icon ?? "terminal").frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).lineLimit(1)
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                    Text(session.status.rawValue)
                    Text("·").foregroundStyle(.tertiary)
                    Text(session.machine).lineLimit(1)
                    if session.encrypted { Image(systemName: "lock.fill").font(.caption2) }
                }
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            Spacer()
            if happier.busy.contains(session.id) { ProgressView().controlSize(.small) }
            else if session.tokens > 0 { Text("\(session.tokens / 1000)k").font(.caption.monospacedDigit()).foregroundStyle(.tertiary) }
        }
        .padding(.vertical, 2)
    }
    var statusColor: Color {
        switch session.status {
        case .idle: return .gray
        case .running: return .blue
        case .waiting: return .orange
        case .done: return .green
        case .failed: return .red
        }
    }
}

/// One session: transcript, live stream, tool‑call feed and the prompt box; switch agents mid‑session.
struct SessionDetailView: View {
    @Environment(HappierModel.self) private var happier
    let sessionID: RecordID
    @State private var input = ""
    @State private var showEvents = true
    @FocusState private var focused: Bool

    var session: AgentSession? { happier.sessions.first { $0.id == sessionID } }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(turns) { TranscriptTurnView(turn: $0) }
                        if let live = happier.liveText[sessionID], !live.isEmpty {
                            TranscriptTurnView(turn: .init(role: "agent", text: live))
                        }
                        if let th = happier.thoughts[sessionID], !th.isEmpty {
                            DisclosureGroup("Thinking…") { Text(th).font(.caption).foregroundStyle(Theme.secondary) }.font(.caption)
                        }
                        if happier.busy.contains(sessionID) { ProgressView().controlSize(.small).id("end") } else { Color.clear.frame(height: 1).id("end") }
                    }
                    .padding(16)
                }
                .onChange(of: happier.liveText[sessionID]) { _, _ in proxy.scrollTo("end") }
            }
            if showEvents, let ev = happier.events[sessionID], !ev.isEmpty {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(ev.suffix(30)) { e in
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: e.icon).frame(width: 14)
                                Text(e.text).lineLimit(3)
                                Spacer()
                                if !e.status.isEmpty { Text(e.status).foregroundStyle(.tertiary) }
                            }
                            .font(.caption.monospaced())
                        }
                    }
                    .padding(10)
                }
                .frame(maxHeight: 140)
                .background(Color(Theme.codeBackground))
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message the agent… (⏎ to send)", text: $input, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...8).focused($focused)
                    .onSubmit { send() }
                    .accessibilityIdentifier("session.input")
                if happier.busy.contains(sessionID) {
                    Button { happier.cancel(sessionID) } label: { Image(systemName: "stop.circle").font(.title2) }.buttonStyle(.plain)
                } else {
                    Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.plain).disabled(input.isEmpty).foregroundStyle(Color.accentColor)
                        .accessibilityIdentifier("session.send")
                }
            }
            .padding(12)
        }
        .navigationTitle(session?.title ?? "Session")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let s = session {
                    Menu {
                        ForEach(happier.agents.filter(\.enabled)) { a in
                            Button { happier.switchAgent(sessionID, to: a.id) } label: {
                                Label(a.name, systemImage: a.icon)
                            }.disabled(a.id == s.agentID)
                        }
                    } label: { Label(happier.agent(s.agentID)?.name ?? s.agentID, systemImage: happier.agent(s.agentID)?.icon ?? "terminal") }
                    .help("Switch agent (the transcript is handed over)")
                    Toggle(isOn: $showEvents) { Image(systemName: "list.bullet.rectangle") }.help("Tool calls")
                    Button { happier.stop(sessionID) } label: { Image(systemName: "power") }.help("Stop the agent process").disabled(!happier.isLive(sessionID))
                    if s.cwd.hasPrefix("/") {
                        Text(s.cwd).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                    }
                }
            }
        }
        .onAppear { focused = true }
    }

    struct Turn: Identifiable { var id = UUID(); var role: String; var text: String }

    /// Parses the stored transcript ("**role**\n\ntext" blocks) back into turns.
    var turns: [Turn] {
        let md = happier.transcript(sessionID)
        var out: [Turn] = []
        for chunk in md.components(separatedBy: "\n**") {
            var c = chunk
            if c.hasPrefix("**") { c.removeFirst(2) }
            guard let end = c.range(of: "**") else { if !c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(Turn(role: "note", text: c)) }; continue }
            let role = String(c[..<end.lowerBound])
            let text = String(c[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { out.append(Turn(role: role, text: text)) }
        }
        return out
    }

    func send() {
        let t = input; input = ""
        happier.send(sessionID, t)
    }
}

struct TranscriptTurnView: View {
    let turn: SessionDetailView.Turn
    var body: some View {
        if turn.role == "user" {
            Text(turn.text).padding(10).background(RoundedRectangle(cornerRadius: 10).fill(Color(Theme.codeBackground)))
                .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(turn.role.capitalized).font(.caption2).foregroundStyle(.tertiary)
                Text(markdown(turn.text)).textSelection(.enabled)
            }
        }
    }
    func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// Agent picker + working directory + first prompt.
struct NewSessionSheet: View {
    @Environment(HappierModel.self) private var happier
    @Environment(\.dismiss) private var dismiss
    @State private var agentID = "claude"
    @State private var cwd = ""
    @State private var title = ""
    @State private var prompt = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("Agent", selection: $agentID) {
                    ForEach(happier.agents.filter(\.enabled)) { a in Label(a.name, systemImage: a.icon).tag(a.id) }
                }
                .accessibilityIdentifier("session.agent")
                HStack {
                    TextField("Working directory", text: $cwd).accessibilityIdentifier("session.cwd")
                    #if os(macOS)
                    Button("Choose…") {
                        let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
                        if p.runModal() == .OK, let u = p.url { cwd = u.path }
                    }
                    #endif
                }
                TextField("Title (optional)", text: $title)
                TextField("First message", text: $prompt, axis: .vertical).lineLimit(3...8)
                if happier.useServer {
                    Label("Runs on the Based server daemon", systemImage: "server.rack").font(.caption).foregroundStyle(Theme.secondary)
                } else {
                    Label("Runs on this Mac · approvals go to your Inbox on every device", systemImage: "desktopcomputer").font(.caption).foregroundStyle(Theme.secondary)
                }
                if let a = happier.agent(agentID), !a.note.isEmpty { Text(a.note).font(.caption).foregroundStyle(Theme.secondary) }
            }
            .formStyle(.grouped)
            .navigationTitle("New session")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        happier.defaultDirectory = cwd
                        happier.startSession(agentID: agentID, cwd: cwd, title: title.isEmpty ? nil : title, prompt: prompt)
                        dismiss()
                    }
                    .disabled(cwd.isEmpty)
                    .accessibilityIdentifier("session.start")
                }
            }
        }
        .frame(minWidth: 420, minHeight: 360)
        .onAppear { cwd = happier.defaultDirectory; if let first = happier.agents.first(where: \.enabled) { agentID = first.id } }
    }
}

// MARK: - Inbox

/// Permission requests, questions and notices from agents — approve or reject from any device.
struct InboxView: View {
    @Environment(HappierModel.self) private var happier
    @State private var showResolved = false

    var items: [InboxItem] { showResolved ? happier.inbox : happier.inbox.filter { $0.status == .pending } }

    var body: some View {
        NavigationStack {
            Group {
                if items.isEmpty {
                    ContentUnavailableView("Inbox zero", systemImage: "tray", description: Text("Agents ask here before doing anything sensitive."))
                } else {
                    List(items) { item in InboxRow(item: item) }
                        .listStyle(.inset)
                }
            }
            .navigationTitle("Inbox")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Toggle("Show resolved", isOn: $showResolved).toggleStyle(.switch).controlSize(.small) }
            }
        }
        .accessibilityIdentifier("inbox.list")
    }
}

struct InboxRow: View {
    @Environment(HappierModel.self) private var happier
    let item: InboxItem

    var options: [(id: String, label: String)] {
        item.options.map { o in
            let parts = o.split(separator: "=", maxSplits: 1).map(String.init)
            return (parts.first ?? o, parts.count > 1 ? parts[1] : o)
        }
    }
    var sessionTitle: String? { item.sessionID.flatMap { id in happier.sessions.first { $0.id == id }?.title } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundStyle(item.status == .pending ? Color.orange : Theme.secondary)
                Text(item.title).fontWeight(.medium)
                Spacer()
                Text(item.createdAt, style: .relative).font(.caption).foregroundStyle(.tertiary)
            }
            if let s = sessionTitle { Text(s).font(.caption).foregroundStyle(Theme.secondary) }
            if !item.detail.isEmpty {
                Text(item.detail).font(.callout.monospaced()).lineLimit(8).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(Theme.codeBackground)))
            }
            if item.status == .pending {
                HStack {
                    if options.isEmpty {
                        Button("Approve") { happier.resolve(item, decision: "allow_once") }.buttonStyle(.borderedProminent).accessibilityIdentifier("inbox.approve")
                        Button("Reject") { happier.resolve(item, decision: "reject_once") }.accessibilityIdentifier("inbox.reject")
                    } else {
                        ForEach(options, id: \.id) { o in
                            Button(o.label) { happier.resolve(item, decision: o.id) }
                                .buttonStyle(o.id.hasPrefix("allow") ? AnyPrimitiveButtonStyle(.borderedProminent) : AnyPrimitiveButtonStyle(.bordered))
                                .tint(o.id.hasPrefix("reject") ? Color.red : nil)
                        }
                    }
                }
                .controlSize(.small)
            } else {
                Label("\(item.status.rawValue)\(item.decision.map { " · \($0)" } ?? "")", systemImage: item.status == .approved ? "checkmark.circle" : "xmark.circle")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 6)
    }
    var icon: String {
        switch item.kind {
        case .permission: return "hand.raised"
        case .question: return "questionmark.bubble"
        case .notice: return "bell"
        case .review: return "eye"
        }
    }
}

/// Type‑erased primitive button style so one ForEach can mix prominent/bordered buttons.
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ s: S) { make = { AnyView(s.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

// MARK: - Connections (Settings)

/// Settings → Connections: MCP servers Based talks to (and hands to every coding agent).
struct ConnectionsSettingsView: View {
    @Environment(HappierModel.self) private var happier
    @State private var showAdd = false
    @State private var secretFor: Connection?

    var body: some View {
        Section {
            if happier.connectionList.isEmpty {
                Text("No connections yet. Add GitHub, Slack, Google Drive, Linear, Notion … once — every agent gets them.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(happier.connectionList) { c in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Toggle(isOn: Binding(get: { c.enabled }, set: { happier.setConnection(c, enabled: $0) })) {
                            Text(c.name).fontWeight(.medium)
                        }
                        Spacer()
                        Text(happier.connectionStatus[c.id] ?? c.status).font(.caption).foregroundStyle(statusColor(happier.connectionStatus[c.id] ?? c.status))
                    }
                    HStack(spacing: 10) {
                        Text(c.transport.rawValue).font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color(Theme.codeBackground)))
                        Text(c.command).font(.caption.monospaced()).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Toggle("Agents", isOn: Binding(get: { c.exposeToAgents }, set: { happier.setConnection(c, expose: $0) })).toggleStyle(.button).controlSize(.mini).font(.caption).help("Pass to Claude Code / Codex sessions as MCP server")
                        Button(happier.hasSecret(c) ? "Secret ✓" : "Secret…") { secretFor = c }.font(.caption)
                        Button(role: .destructive) { happier.deleteConnection(c) } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
            HStack {
                Menu("Add connection") {
                    ForEach(Array(BrainStore.connectionCatalog.enumerated()), id: \.offset) { i, c in
                        Button(c.name) { let id = happier.addFromCatalog(i); secretFor = happier.connectionList.first { $0.id == id } }
                    }
                    Divider()
                    Button("Custom MCP server…") { showAdd = true }
                }
                .accessibilityIdentifier("connections.add")
                Spacer()
                Button("Reconnect all") { happier.reloadConnections() }
            }
        } header: { Text("Connections (MCP)") } footer: {
            Text("Stdio servers run locally (npx/uvx); HTTP servers are remote. Secrets stay in the Keychain and are injected as env vars or bearer tokens.").font(.caption)
        }
        .sheet(isPresented: $showAdd) { CustomConnectionSheet().environment(happier) }
        .sheet(item: $secretFor) { c in ConnectionSecretSheet(connection: c).environment(happier) }
    }
    func statusColor(_ s: String) -> Color { s.hasPrefix("connected") ? .green : s.hasPrefix("error") || s.hasPrefix("failed") ? .red : Theme.secondary }
}

struct ConnectionSecretSheet: View {
    @Environment(HappierModel.self) private var happier
    @Environment(\.dismiss) private var dismiss
    let connection: Connection
    @State private var secret = ""
    var hint: String { BrainStore.connectionCatalog.first { $0.name == connection.name }?.hint ?? (connection.transport == .http ? "Bearer token" : "Secret for \(connection.envName.isEmpty ? "the server" : connection.envName)") }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(connection.name) secret").font(.headline)
            Text(hint).font(.caption).foregroundStyle(Theme.secondary)
            SecureField(hint, text: $secret).textFieldStyle(.roundedBorder).accessibilityIdentifier("connection.secret")
            HStack {
                Button("Remove", role: .destructive) { Secrets.set(connection.secretKey, nil); happier.reloadConnections(); dismiss() }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save & connect") { Secrets.set(connection.secretKey, secret); happier.reloadConnections(); dismiss() }.buttonStyle(.borderedProminent).disabled(secret.isEmpty)
            }
        }
        .padding(20).frame(width: 420)
        .onAppear { secret = Secrets.get(connection.secretKey) ?? "" }
    }
}

struct CustomConnectionSheet: View {
    @Environment(HappierModel.self) private var happier
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var transport: Connection.Transport = .stdio
    @State private var command = ""
    @State private var envName = ""
    @State private var secret = ""
    @State private var expose = true
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Picker("Transport", selection: $transport) { ForEach(Connection.Transport.allCases, id: \.self) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
                TextField(transport == .stdio ? "Command (npx -y @scope/server …)" : "URL (https://…/mcp)", text: $command).font(.body.monospaced())
                if transport == .stdio { TextField("Env var for the secret (e.g. API_TOKEN)", text: $envName) }
                SecureField(transport == .stdio ? "Secret (optional)" : "Bearer token (optional)", text: $secret)
                Toggle("Expose to coding agents", isOn: $expose)
            }
            .formStyle(.grouped)
            .navigationTitle("Custom MCP server")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        happier.saveConnection(name: name, transport: transport, command: command, envName: envName, enabled: true, expose: expose, secret: secret)
                        happier.reloadConnections(); dismiss()
                    }.disabled(name.isEmpty || command.isEmpty)
                }
            }
        }
        .frame(minWidth: 440, minHeight: 320)
    }
}

// MARK: - Agents (Settings)

/// Settings → Coding agents: which ACP agents exist, how they launch, permission policy, E2E key.
struct AgentsSettingsView: View {
    @Environment(HappierModel.self) private var happier
    @State private var editing: AgentDefinition?
    @State private var keyVisible = false
    @State private var pasteKey = ""

    var body: some View {
        Section {
            ForEach(happier.agents) { a in
                HStack {
                    Toggle(isOn: Binding(get: { a.enabled }, set: { v in var all = happier.agents; if let i = all.firstIndex(where: { $0.id == a.id }) { all[i].enabled = v }; happier.agents = all })) {
                        Label(a.name, systemImage: a.icon)
                    }
                    Spacer()
                    Text(([a.command] + a.arguments).joined(separator: " ")).font(.caption.monospaced()).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
                    Button("Edit") { editing = a }.font(.caption)
                }
            }
            HStack {
                Button("Add agent") { editing = AgentDefinition(id: "custom-\(Int(Date().timeIntervalSince1970))", name: "Custom agent", command: "", icon: "terminal") }
                Button("Reset to defaults") { happier.resetAgents() }
                Spacer()
            }
        } header: { Text("Coding agents (ACP)") } footer: {
            Text("Agents speak the Agent Client Protocol over stdio. Claude Code and Codex are installed on first use via npx; Gemini CLI / OpenCode / Pi need their own install.").font(.caption)
        }
        .sheet(item: $editing) { a in AgentEditSheet(agent: a).environment(happier) }

        Section("Permissions & run location") {
            Picker("When an agent asks for permission", selection: Binding(get: { happier.permissionPolicy }, set: { happier.permissionPolicy = $0 })) {
                Text("Ask me in the Inbox").tag(HappierRuntime.PermissionPolicy.ask)
                Text("Auto‑allow reads, ask for writes").tag(HappierRuntime.PermissionPolicy.allowReads)
                Text("Allow everything (YOLO)").tag(HappierRuntime.PermissionPolicy.allowAll)
            }
            #if os(macOS)
            Toggle("Run agents on the Based server instead of this Mac", isOn: Binding(get: { happier.useServer }, set: { happier.useServer = $0 }))
            #else
            LabeledContent("Run location", value: "Based server daemon")
            #endif
            TextField("Default working directory", text: Binding(get: { happier.defaultDirectory }, set: { happier.defaultDirectory = $0 })).font(.body.monospaced())
        }

        Section {
            HStack {
                if keyVisible { Text(happier.cipherKey).font(.caption.monospaced()).textSelection(.enabled) } else { Text(String(repeating: "•", count: 24)) }
                Spacer()
                Button(keyVisible ? "Hide" : "Show") { keyVisible.toggle() }
                Button("Copy") {
                    #if os(macOS)
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(happier.cipherKey, forType: .string)
                    #else
                    UIPasteboard.general.string = happier.cipherKey
                    #endif
                }
                Button("New key") { happier.cipherKey = SessionCipher.generate().base64 }
            }
            HStack {
                SecureField("Paste key from another device / server", text: $pasteKey)
                Button("Use") { if SessionCipher(base64: pasteKey) != nil { happier.cipherKey = pasteKey; pasteKey = "" } }.disabled(SessionCipher(base64: pasteKey) == nil)
            }
            Text("Transcripts are encrypted with ChaCha20‑Poly1305 before they sync. Start the daemon with --cipher-key <this key> so it can read them too.").font(.caption).foregroundStyle(Theme.secondary)
        } header: { Text("End‑to‑end encryption") }
    }
}

struct AgentEditSheet: View {
    @Environment(HappierModel.self) private var happier
    @Environment(\.dismiss) private var dismiss
    @State var agent: AgentDefinition
    @State private var args = ""
    @State private var env = ""
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $agent.name)
                TextField("Command", text: $agent.command).font(.body.monospaced())
                TextField("Arguments", text: $args).font(.body.monospaced())
                TextField("Environment (KEY=value per line)", text: $env, axis: .vertical).lineLimit(2...5).font(.body.monospaced())
                TextField("SF Symbol", text: $agent.icon)
                TextField("Note", text: $agent.note)
                Toggle("Enabled", isOn: $agent.enabled)
            }
            .formStyle(.grouped)
            .navigationTitle(agent.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) { Button("Delete", role: .destructive) { happier.agents = happier.agents.filter { $0.id != agent.id }; dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var a = agent
                        a.arguments = splitCommandLine("x " + args).1
                        a.environment = Dictionary(env.split(separator: "\n").compactMap { l -> (String, String)? in
                            let p = l.split(separator: "=", maxSplits: 1); return p.count == 2 ? (String(p[0]).trimmingCharacters(in: .whitespaces), String(p[1])) : nil }, uniquingKeysWith: { $1 })
                        var all = happier.agents
                        if let i = all.firstIndex(where: { $0.id == a.id }) { all[i] = a } else { all.append(a) }
                        happier.agents = all; dismiss()
                    }.disabled(agent.command.isEmpty)
                }
            }
        }
        .frame(minWidth: 440, minHeight: 360)
        .onAppear { args = agent.arguments.joined(separator: " "); env = agent.environment.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: "\n") }
    }
}
