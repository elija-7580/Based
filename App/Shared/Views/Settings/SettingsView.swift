import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Notion‑style settings: a sidebar with Account and Workspace sections, detail on the right.
/// Opens as the macOS Settings window and as a sidebar destination on iOS.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var page: SettingsPage = .myAccount

    enum SettingsPage: String, CaseIterable, Identifiable {
        case myAccount, mySettings, myNotifications, myConnections, languageRegion
        case workspace, people, teamspaces, security, agents, connections, importData, sync, billing, updates, diagnostics, about
        var id: String { rawValue }
        var title: String {
            switch self {
            case .myAccount: return "My account"
            case .mySettings: return "My settings"
            case .myNotifications: return "My notifications"
            case .myConnections: return "My connections"
            case .languageRegion: return "Language & region"
            case .workspace: return "Settings"
            case .people: return "People"
            case .teamspaces: return "Teamspaces"
            case .security: return "Security"
            case .agents: return "Agents & AI"
            case .connections: return "Connections"
            case .importData: return "Import"
            case .sync: return "Sync & server"
            case .billing: return "Billing"
            case .updates: return "Updates"
            case .diagnostics: return "Diagnostics"
            case .about: return "About"
            }
        }
        var symbol: String {
            switch self {
            case .myAccount: return "person.crop.circle"
            case .mySettings: return "slider.horizontal.3"
            case .myNotifications: return "bell"
            case .myConnections: return "link"
            case .languageRegion: return "globe"
            case .workspace: return "gearshape"
            case .people: return "person.2"
            case .teamspaces: return "person.3"
            case .security: return "lock.shield"
            case .agents: return "sparkles"
            case .connections: return "puzzlepiece.extension"
            case .importData: return "square.and.arrow.down"
            case .sync: return "arrow.triangle.2.circlepath.icloud"
            case .billing: return "creditcard"
            case .updates: return "arrow.down.circle"
            case .diagnostics: return "stethoscope"
            case .about: return "info.circle"
            }
        }
        static let accountPages: [SettingsPage] = [.myAccount, .mySettings, .myNotifications, .myConnections, .languageRegion]
        static let workspacePages: [SettingsPage] = [.workspace, .people, .teamspaces, .security, .agents, .connections, .importData, .sync, .billing, .updates, .diagnostics, .about]
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 210)
                .background(Color(Theme.codeBackground).opacity(0.6))
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                Text(page.title).font(.title3.bold()).padding([.top, .horizontal], 20).padding(.bottom, 6)
                Divider().padding(.horizontal, 20)
                detail
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .navigationTitle("Settings")
        .accessibilityIdentifier("settings.root")
        .onAppear(perform: applyPageRequest)
        .onChange(of: model.settingsPageRequest) { _, _ in applyPageRequest() }
    }

    private func applyPageRequest() {
        guard let raw = model.settingsPageRequest else { return }
        model.settingsPageRequest = nil
        if let p = SettingsPage(rawValue: raw) { page = p }
    }

    private var sidebar: some View {
        // Notion-style rows (quiet grey selection) instead of a List whose selection used the accent colour —
        // that drew a hard black bar in this app's monochrome accent.
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                SettingsSectionLabel("Account")
                ForEach(SettingsPage.accountPages) { p in SettingsNavRow(page: p, selected: page == p) { page = p } }
                SettingsSectionLabel("Workspace").padding(.top, 10)
                ForEach(SettingsPage.workspacePages) { p in SettingsNavRow(page: p, selected: page == p) { page = p } }
            }
            .padding(.horizontal, 8).padding(.vertical, 10)
        }
    }

    @ViewBuilder
    private var detail: some View {
        Form {
            switch page {
            case .myAccount: MyAccountSettings()
            case .mySettings: MySettings()
            case .myNotifications: NotificationSettings()
            case .myConnections: ConnectionsSettingsView().environment(model.brain.happier)
            case .languageRegion: LanguageRegionSettings()
            case .workspace: WorkspaceSettings()
            case .people: PeopleSettings()
            case .teamspaces: TeamspacesSettings()
            case .security: SecuritySettings()
            case .agents:
                AgentSetupSection().environment(model.brain.happier)
                AgentsSettingsView().environment(model.brain.happier)
                AISettingsView()
            case .connections: ConnectionsSettingsView().environment(model.brain.happier)
            case .importData: ImportSettings()
            case .sync: SyncSettings()
            case .billing: BillingSettings()
            case .updates: UpdatesSettings()
            case .diagnostics: DiagnosticsSettings()
            case .about: AboutSettings()
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }
}

// MARK: - Account

struct MyAccountSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("account.name") private var name = ""
    @AppStorage("account.email") private var email = ""
    @AppStorage("account.initials") private var initials = ""

    var body: some View {
        Section("Profile") {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(Theme.accentBlue.opacity(0.2)).frame(width: 56, height: 56)
                    Text(initials.isEmpty ? String(name.prefix(1)).uppercased() : initials).font(.title2.bold())
                }
                VStack(alignment: .leading) {
                    TextField("Preferred name", text: $name).textFieldStyle(.roundedBorder)
                    Text("Shown on pages you edit and in agent transcripts.").font(.caption).foregroundStyle(Theme.secondary)
                }
            }
            TextField("Initials (avatar)", text: $initials)
        }
        Section("Account security") {
            TextField("Email (for the Based server account)", text: $email)
            LabeledContent("Password", value: "Set on the Based server")
            LabeledContent("2‑step verification", value: "Device keychain + passkey (planned)")
        }
        Section("Devices") {
            LabeledContent("This device", value: model.brain.happier.machineName)
            Text("Sessions, encryption key and secrets live in this device's Keychain.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Support") {
            Button("Export my data…") { model.showExportAll = true }
            Button("Delete my account", role: .destructive) { }.disabled(true)
                .help("Based is local‑first; remove the app's data folder to delete everything.")
        }
    }
}

struct MySettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue
    @AppStorage(Prefs.startPage) private var startPage = "last"
    @AppStorage(Prefs.openLinksInApp) private var openLinksInApp = true
    @AppStorage(Prefs.cursorOnOpen) private var cursorOnOpen = "title"
    @AppStorage(Prefs.spellCheck) private var spellCheck = true
    @AppStorage(Prefs.compactMode) private var compact = false
    @AppStorage(Prefs.fontFamily) private var font = "default"
    @AppStorage(Prefs.smallText) private var smallText = false
    @AppStorage(Prefs.fullWidth) private var fullWidth = false

    var body: some View {
        Section("Appearance") {
            Picker("Appearance", selection: $appearance) { ForEach(Appearance.allCases) { a in Text(a.title).tag(a.rawValue) } }
                .accessibilityIdentifier("settings.appearance")
            Picker("Default font", selection: $font) { Text("Default").tag("default"); Text("Serif").tag("serif"); Text("Mono").tag("mono") }
            Toggle("Small text by default", isOn: $smallText)
            Toggle("Full width by default", isOn: $fullWidth)
            Toggle("Compact sidebar", isOn: $compact)
        }
        Section("Home") {
            Picker("Home page", selection: Binding(get: { model.homePageID ?? "" }, set: { model.setHome($0.isEmpty ? nil : $0) })) {
                Text("None (choose on Home)").tag("")
                if let h = model.homePageID, !model.store.topLevelPages().contains(where: { $0.id == h }) {
                    Text(model.store.title(of: h).nonEmptyOr("Untitled")).tag(h)
                }
                ForEach(model.store.topLevelPages(), id: \.id) { Text(model.store.title(of: $0.id).nonEmptyOr("Untitled")).tag($0.id) }
            }
            .accessibilityIdentifier("settings.homePage")
            Text("Home (⇧⌘H) opens this page. The overview with recent pages and favorites is at the top of Library.")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Startup") {
            Picker("Open on start", selection: $startPage) {
                Text("Last visited page").tag("last")
                Text("Home").tag("home")
                ForEach(model.store.topLevelPages(), id: \.id) { Text(model.store.title(of: $0.id)).tag($0.id) }
            }
            Toggle("Open links in desktop app", isOn: $openLinksInApp)
            Picker("Cursor on page open", selection: $cursorOnOpen) { Text("Title").tag("title"); Text("Body").tag("body"); Text("Don't focus").tag("none") }
        }
        Section("Editing") {
            Toggle("Spell‑check", isOn: $spellCheck)
            Toggle("Autocorrect", isOn: .constant(true)).disabled(true)
        }
        MeetingVoiceSettings()
        Section("Privacy") {
            Toggle("Cookie / analytics", isOn: .constant(false)).disabled(true)
            Text("Based never sends telemetry. AI requests go only to the providers you configured.").font(.caption).foregroundStyle(Theme.secondary)
        }
    }
}

/// Meeting notes: recognising voices across meetings (opt-in, stored only on this device).
struct MeetingVoiceSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.meetingRememberVoices) private var remember = false
    @State private var profiles: [VoiceProfile] = []
    @State private var confirmForget = false

    var body: some View {
        Section("Meeting notes") {
            Toggle("Recognise voices across meetings", isOn: Binding(get: { remember }, set: { on in
                remember = on
                if !on { MeetingService.shared.voices(model).forgetAll(); profiles = [] }
            }))
            Text("When you name a speaker, Based remembers their voice and labels them in later meetings. Voice prints stay on this device only — they are never synced or uploaded. Turning this off deletes them.")
                .font(.caption).foregroundStyle(Theme.secondary)
            if remember {
                ForEach(profiles) { p in
                    HStack {
                        Image(systemName: "waveform")
                        Text(p.name)
                        Spacer()
                        Text("\(Int(p.weight / 60)) min").font(.caption).foregroundStyle(Theme.secondary)
                        Button("Forget") { MeetingService.shared.voices(model).forget(p.id); reload() }
                    }
                }
                if !profiles.isEmpty {
                    Button("Forget all voices", role: .destructive) { confirmForget = true }
                }
            }
        }
        .onAppear(perform: reload)
        .confirmationDialog("Forget all voices?", isPresented: $confirmForget) {
            Button("Forget all", role: .destructive) { MeetingService.shared.voices(model).forgetAll(); reload() }
        }
    }

    private func reload() { profiles = MeetingService.shared.voices(model).profiles.sorted { $0.name < $1.name } }
}

struct NotificationSettings: View {
    @AppStorage(Prefs.notifyMobile) private var mobile = true
    @AppStorage(Prefs.notifyEmailActivity) private var emailActivity = false
    @AppStorage(Prefs.notifyEmailDigest) private var digest = false
    @AppStorage(Prefs.notifyAnnouncements) private var announcements = false
    @AppStorage(Prefs.notifyAgents) private var agents = true
    var body: some View {
        Section("Push") {
            Toggle("Mobile push notifications", isOn: $mobile)
            Toggle("Agent approvals (Inbox)", isOn: $agents)
            Text("When an agent asks for permission you get a notification on every device with this workspace.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Email (via Based server)") {
            Toggle("Activity in your workspace", isOn: $emailActivity)
            Toggle("Email digests", isOn: $digest)
            Toggle("Announcements and update emails", isOn: $announcements)
        }
        Section("Slack") {
            Text("Connect Slack under My connections to receive notifications there.").font(.caption).foregroundStyle(Theme.secondary)
        }
    }
}

struct LanguageRegionSettings: View {
    @AppStorage(Prefs.language) private var language = "system"
    @AppStorage(Prefs.weekStartMonday) private var monday = false
    @AppStorage(Prefs.autoTimezone) private var autoTZ = true
    @AppStorage(Prefs.timezone) private var tz = TimeZone.current.identifier
    @AppStorage(Prefs.dateFormat) private var dateFormat = "system"
    @AppStorage(Prefs.timeFormat24h) private var h24 = true
    var body: some View {
        Section("Language") {
            Picker("Language", selection: $language) { ForEach(Prefs.languages, id: \.code) { Text($0.name).tag($0.code) } }
            Text("Changes the app's language after restart. Pages keep their own content.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Region") {
            Toggle("Start week on Monday", isOn: $monday)
            Toggle("Set timezone automatically", isOn: $autoTZ)
            if !autoTZ {
                Picker("Timezone", selection: $tz) {
                    ForEach(TimeZone.knownTimeZoneIdentifiers.filter { $0.contains("/") }, id: \.self) { Text($0).tag($0) }
                }
            }
            Picker("Date format", selection: $dateFormat) {
                Text("System").tag("system"); Text("2026‑03‑10").tag("iso"); Text("10.03.2026").tag("eu"); Text("03/10/2026").tag("us")
            }
            Toggle("24‑hour time", isOn: $h24)
        }
    }
}

// MARK: - Workspace

struct WorkspaceSettings: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var confirmReset = false
    var body: some View {
        let store = model.store
        Section("Workspace settings") {
            HStack {
                IconPickerButton(icon: store.workspace.icon) { model.setWorkspaceIcon($0) }
                TextField("Name", text: $name)
                    .onSubmit { commitName() }
                    .onChange(of: name) { _, _ in commitName() }
                    .accessibilityIdentifier("settings.workspaceName")
            }
            LabeledContent("Pages", value: "\(store.allPages().count)")
            LabeledContent("Databases", value: "\(store.databases.count)")
            LabeledContent("Blocks", value: "\(store.blocks.count)")
        }
        Section("Public settings") {
            TextField("Domain (Based server)", text: .constant("")).disabled(true)
            Toggle("Allow publishing pages to the web", isOn: .constant(false)).disabled(true)
            Text("Publishing needs a Based server with a public domain; coming with the sharing update.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Content") {
            Button("Export all workspace content…") { model.showExportAll = true }
            Button("Purge Trash (older than 30 days)") { store.purgeTrash() }
            Button("Clear undo history") { store.clearUndoHistory() }
        }
        Section("Danger zone") {
            Button("Reset workspace…", role: .destructive) { confirmReset = true }
                .confirmationDialog("Move every page to Trash?", isPresented: $confirmReset) {
                    Button("Move all pages to Trash", role: .destructive) { store.trash(store.topLevelPages().map(\.id)) }
                }
        }
        .onAppear { name = store.workspace.name }
    }

    private func commitName() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !n.isEmpty, n != model.store.workspace.name { model.store.renameWorkspace(n) }
    }
}

struct PeopleSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("account.name") private var name = ""
    @State private var invite = ""
    var body: some View {
        Section("Members · 1") {
            HStack {
                Image(systemName: "person.crop.circle.fill").font(.title2)
                VStack(alignment: .leading) { Text(name.isEmpty ? "You" : name); Text(model.store.userID ?? "me").font(.caption).foregroundStyle(Theme.secondary) }
                Spacer()
                Text("Workspace owner").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        Section("Invite") {
            HStack {
                TextField("Email address", text: $invite)
                Button("Invite") { }.disabled(true)
            }
            Text("Multi‑user collaboration arrives with the Based server accounts update. Until then, this workspace syncs between your own devices (iCloud or your server).")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Guests") { Text("No guests").foregroundStyle(Theme.secondary) }
    }
}

struct TeamspacesSettings: View {
    var body: some View {
        Section("Teamspaces") {
            LabeledContent("Default teamspace", value: "General")
            Toggle("Allow members to create teamspaces", isOn: .constant(true)).disabled(true)
            Text("One workspace is enough for now; teamspaces become available with multi‑user accounts.").font(.caption).foregroundStyle(Theme.secondary)
        }
    }
}

struct SecuritySettings: View {
    @AppStorage("security.requireAuth") private var requireAuth = false
    @AppStorage("security.allowExport") private var allowExport = true
    @AppStorage("security.allowGuests") private var allowGuests = false
    @AppStorage("security.agentWritesNeedApproval") private var agentApproval = true
    var body: some View {
        Section("Access") {
            Toggle("Require Face ID / Touch ID to open Based", isOn: $requireAuth)
            Toggle("Allow exporting pages", isOn: $allowExport)
            Toggle("Allow guests on pages", isOn: $allowGuests).disabled(true)
        }
        Section("Agents") {
            Toggle("Agents must get approval before writing files or running commands", isOn: $agentApproval)
            Text("Mirrors the permission policy under Agents & AI; the Inbox collects every request.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Encryption") {
            LabeledContent("Local database", value: "SQLite in the app sandbox (FileVault / iOS data protection)")
            LabeledContent("Agent transcripts", value: "ChaCha20‑Poly1305, key in Keychain")
            LabeledContent("Server transport", value: "HTTPS + bearer token")
        }
    }
}

struct ImportSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Section("Import") {
            Button { model.showNotionImport = true } label: { Label("Import from Notion (API)…", systemImage: "square.and.arrow.down.on.square") }
                .accessibilityIdentifier("settings.importNotionAPI")
            Text("Most faithful: pages, formatting, databases with all properties, views (filters, sorts, groups), rows, relations, formulas and files. Needs an internal integration token; importing again updates in place.").font(.caption).foregroundStyle(Theme.secondary)
            Button { model.showImport = true } label: { Label("Notion export file (.zip HTML / Markdown & CSV)", systemImage: "square.and.arrow.down") }
                .accessibilityIdentifier("settings.importNotion")
            Text("Export from Notion as HTML with subpages for a lossless import (anything Based can't show natively is kept as an HTML block). Markdown & CSV exports lose colors, toggles and layout.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("Also supported") {
            Label("Markdown files and folders", systemImage: "doc.text")
            Label("CSV → database", systemImage: "tablecells")
            Label("HTML pages", systemImage: "chevron.left.forwardslash.chevron.right")
            Label("Evernote / Apple Notes (via export to HTML)", systemImage: "note.text")
        }
    }
}

struct SyncSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @State private var syncOn = false
    @State private var serverToken = Secrets.get("server.token") ?? ""
    var body: some View {
        @Bindable var brain = brain
        Section("Based server (your VPS)") {
            TextField("Server URL (https://based.example.com)", text: $brain.serverURL).accessibilityIdentifier("settings.serverURL")
            SecureField("Server token", text: $serverToken)
            HStack {
                Button("Connect") { Secrets.set("server.token", serverToken); brain.startServerSyncIfConfigured() }
                Spacer()
                LabeledContent("Status", value: brain.serverStatus)
            }
            Text("The server is the main sync channel, MCP endpoint for Claude/ChatGPT/Cursor, scheduler for the Agent Brain and the daemon that runs coding agents for your iPhone.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("iCloud (experimental)") {
            Toggle("Sync with iCloud", isOn: Binding(get: { syncOn }, set: { v in syncOn = v; model.syncEnabled = v }))
                .disabled(!AppModel.cloudSyncBuildFlag || model.cloudContainerID == nil)
                .accessibilityIdentifier("settings.icloudSync")
            if syncOn { LabeledContent("Status", value: model.syncStatus) }
            if let d = model.lastSyncDate, syncOn { LabeledContent("Last synced", value: d.formatted(date: .abbreviated, time: .shortened)) }
            Text("Use one sync channel on all devices. iCloud and the Based server don't pass changes to each other, so a device that only uses one of them won't see edits made through the other.")
                .font(.caption).foregroundStyle(Theme.secondary)
            if syncOn && model.serverSyncConfigured {
                Label("Server and iCloud are both on.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
            if !AppModel.cloudSyncBuildFlag || model.cloudContainerID == nil {
                Text("This build has no iCloud container. Set BASED_CLOUD_SYNC = YES, a development team and an iCloud container in Config/Local.xcconfig, then rebuild.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            Button("Sync now") { model.syncNow() }.disabled(!syncOn)
        }
        .onAppear { syncOn = model.syncEnabled }
    }
}

struct BillingSettings: View {
    var body: some View {
        Section("Plan") {
            LabeledContent("Current plan", value: "Open source · free forever")
            Text("Based is MIT‑licensed. Costs you may have: your own server (optional) and AI provider usage billed by Anthropic / OpenAI.").font(.caption).foregroundStyle(Theme.secondary)
        }
        Section("AI usage") {
            Text("Tokens used by the Agent Brain are logged in Agent Brain → Runs.").font(.caption).foregroundStyle(Theme.secondary)
        }
    }
}

/// Settings → Agents & AI: the setup / diagnosis entry point.
struct AgentSetupSection: View {
    @Environment(AppModel.self) private var model
    @State private var showDoctor = false

    var body: some View {
        Section("Setup") {
            if AppDiagnostics.isSandboxed {
                Label("Sandboxed build — local agents can't start. Set BASED_AGENTS_SUFFIX = -Agents in Config/Local.xcconfig, or use a Based server.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Text("Check Node, Claude Code, Codex and the ACP adapters, see what's missing and test each agent.")
                    .font(.caption).foregroundStyle(Theme.secondary)
                Spacer()
                Button("Agent setup & diagnosis…") { showDoctor = true }
                    .accessibilityIdentifier("settings.agentDoctor")
            }
        }
        .sheet(isPresented: $showDoctor) { AgentDoctorView().environment(model.brain.happier).environment(model) }
    }
}

/// Settings → Diagnostics: log level, layout audit, where logs live.
struct DiagnosticsSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("log.level") private var level = ""
    @State private var autoAudit = LayoutAuditor.autoAuditEnabled

    var body: some View {
        Section("Logging") {
            Picker("Log level", selection: $level) {
                Text("Default").tag("")
                Text("Debug (everything)").tag("debug")
                Text("Info").tag("info")
                Text("Warnings and errors").tag("warning")
            }
            .onChange(of: level) { _, v in
                Log.shared.minimumLevel = LogLevel(name: v) ?? .info
                Log.notice("log level → \(v.isEmpty ? "default" : v)", category: "app")
            }
            Toggle("Check layout automatically (overlapping, clipped or off-screen controls)", isOn: $autoAudit)
                .onChange(of: autoAudit) { _, v in LayoutAuditor.autoAuditEnabled = v }
            LabeledContent("Log folder") {
                Text(AppDiagnostics.logDirectory.path).font(.caption.monospaced()).textSelection(.enabled).lineLimit(2)
            }
            LabeledContent("Main-thread hangs this session", value: "\(HangWatchdog.shared.hangCount)")
            HStack {
                Button("Open Diagnostics") { model.selection = .diagnostics }
                    .accessibilityIdentifier("settings.openDiagnostics")
                #if os(macOS)
                Button("Show logs in Finder") { NSWorkspace.shared.activateFileViewerSelecting([AppDiagnostics.logDirectory]) }
                #endif
            }
        }
    }
}

struct AboutSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Section("About") {
            LabeledContent("Version", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev")
            LabeledContent("Build", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "dev")
            LabeledContent("Commit", value: model.updater.shortCommit)
            Text("Based is a local‑first, open‑source Notion alternative with a built‑in AI brain and Happier‑style control room for coding agents. Data lives on your devices and syncs through iCloud or your own server.")
                .font(.caption).foregroundStyle(Theme.secondary)
            Link("Source code on GitHub", destination: URL(string: "https://github.com/elija-7580/Based")!)
        }
    }
}

/// Small icon button that opens the shared `IconPicker` in a popover.
struct IconPickerButton: View {
    let icon: PageIcon?
    let onPick: (PageIcon?) -> Void
    @State private var open = false
    var body: some View {
        Button { open.toggle() } label: {
            Group {
                if let icon { PageIconView(icon: icon, size: 22) } else { Image(systemName: "face.smiling").font(.title2).foregroundStyle(Theme.secondary) }
            }
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(Theme.codeBackground)))
        }
        .buttonStyle(.hoverFill)
        .panelPopover(isPresented: $open) { IconPicker(current: icon, onPick: { onPick($0); open = false }).frame(width: 360, height: 400) }
    }
}

/// Export‑all sheet: pick a folder (macOS) or export into Documents (iOS).
struct ExportAllSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    enum Kind: Hashable { case markdown, html, archive }
    @State private var kind: Kind = .markdown
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Export all workspace content").font(.headline)
            Text(explanation).font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("Format", selection: $kind) {
                Text("Markdown & CSV").tag(Kind.markdown)
                Text("HTML").tag(Kind.html)
                Text("Based archive").tag(Kind.archive)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.exportFormat")
            if let m = model.exportAllMessage { Text(m).font(.caption).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Close") { dismiss() }
                Button("Export…") { export() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("settings.exportAll")
            }
        }
        .padding(20).frame(minWidth: 460)
    }

    private var explanation: String {
        switch kind {
        case .markdown, .html:
            return "Every page becomes a \(kind == .html ? "HTML" : "Markdown") file, every database a CSV, nested pages become folders — the same structure Notion exports."
        case .archive:
            return "One file with everything, lossless: page tree, databases with views, filters and formulas, formatting and history stamps. Use it as a backup, to move to another Mac, or to import into other Based clients (File → Import)."
        }
    }

    private func export() {
        #if os(macOS)
        if kind == .archive {
            let p = NSSavePanel()
            p.nameFieldStringValue = "Based Workspace.based.jsonl"
            p.prompt = "Export"
            if p.runModal() == .OK, let u = p.url { model.exportArchive(to: u) }
            return
        }
        let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true; p.prompt = "Export here"
        if p.runModal() == .OK, let u = p.url { model.exportWorkspace(to: u.appendingPathComponent("Based Export", isDirectory: true), html: kind == .html) }
        #else
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        if kind == .archive { model.exportArchive(to: docs.appendingPathComponent("Based Workspace.based.jsonl")); return }
        model.exportWorkspace(to: docs.appendingPathComponent("Based Export", isDirectory: true), html: kind == .html)
        #endif
    }
}


private struct SettingsSectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.secondary)
            .padding(.horizontal, 8).padding(.bottom, 3)
    }
}

private struct SettingsNavRow: View {
    let page: SettingsView.SettingsPage
    let selected: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: page.symbol).font(.system(size: 13)).frame(width: 18)
                    .foregroundStyle(selected ? Theme.primary : Theme.secondary)
                Text(page.title).font(.system(size: 13.5, weight: selected ? .medium : .regular))
                    .foregroundStyle(Theme.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.hoverFill.opacity(1.8) : (hover ? Theme.hoverFill : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityIdentifier("settings.\(page.rawValue)")
    }
}
