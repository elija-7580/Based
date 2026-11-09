import SwiftUI
import BasedCore
import BasedBrain

// BSD-56: "Set up in a minute". Three steps: what to work with → sign in (embedded terminal / key field) → done.
// Detection, steps and defaults come from `SetupPlan` in BasedBrain; this file only shows them and applies them.

extension BrainModel {
    /// Keychain names that have a value (never the values themselves).
    var setupSecrets: Set<String> { Set(["anthropic", "openai"].filter { Secrets.get($0) != nil }) }

    /// Detects what is installed and signed in (off the main thread: resolves the login shell's PATH).
    func detectSetup() async -> SetupState {
        let probe = await SetupProbe.live(secrets: setupSecrets, serverURL: serverURL, serverToken: Secrets.get("server.token") != nil,
                                    localModel: AppleIntelligenceProvider.isAvailable || !ollamaURL.isEmpty)
        return await Task.detached(priority: .userInitiated) { SetupPlan.detect(probe) }.value
    }

    /// Sets the chat engine, routing level and permission mode, creates the main agent and the daily brief.
    @discardableResult
    func applySetup(_ account: SetupAccount, state: SetupState) -> SetupApplied {
        let d = SetupPlan.defaults(for: account, state: state)
        engineSpec = d.engine
        compute = d.compute
        permissionMode = d.permissionMode
        reloadProviders()
        let r = SetupPlan.apply(d, brain: brain)
        UserDefaults.standard.set(account.rawValue, forKey: SetupAssistant.completedKey)
        Log.info("setup: \(account.rawValue) — main agent \(r.mainAgentCreated ? "created" : "kept"), daily brief \(r.dailyBriefCreated ? "created" : "kept")", category: "agents")
        return r
    }
}

enum SetupAssistant {
    /// Account chosen when the assistant was finished ("" = never finished).
    static let completedKey = "setup.completed"
    static var completed: Bool { !(UserDefaults.standard.string(forKey: completedKey) ?? "").isEmpty }
}

/// Shows the assistant once, the first time the AI mode opens and nothing is set up yet.
struct SetupAssistantPresenter: ViewModifier {
    @Environment(AppModel.self) private var model
    @State private var show = false
    @State private var checked = false

    func body(content: Content) -> some View {
        content
            .task(id: model.sidebarMode) {
                guard model.sidebarMode == .ai, !checked, !SetupAssistant.completed else { return }
                checked = true
                let state = await model.brain.detectSetup()
                if SetupPlan.needsAssistant(state: state, completed: SetupAssistant.completed) { show = true }
            }
            .sheet(isPresented: $show) { SetupAssistantView().environment(model) }
    }
}

struct SetupAssistantView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var step = 0
    @State private var state: SetupState?
    @State private var account: SetupAccount = .chatgpt
    @State private var terminalCommand: String?
    @State private var keyName = "anthropic"
    @State private var key = ""
    @State private var showServer = false
    @State private var serverURL = ""
    @State private var serverToken = ""

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.xl) {
            HStack {
                Text(["Set up Based", "Sign in", "You're set"][step]).font(DS.Text.title())
                Spacer()
                Text("Step \(step + 1) of 3").font(DS.Text.small()).foregroundStyle(Theme.secondary)
            }
            switch step {
            case 0: chooseStep
            case 1: signInStep
            default: doneStep
            }
            Spacer(minLength: 0)
            footer
        }
        .padding(DS.Space.xxl)
        .frame(minWidth: 520, idealWidth: 600, minHeight: 440)
        .task { await refresh(preselect: true) }
        .accessibilityIdentifier("setupAssistant")
    }

    // MARK: Step 1

    private var chooseStep: some View {
        VStack(alignment: .leading, spacing: DS.Space.md) {
            Text("What do you want to work with? You can add more later in Settings.")
                .font(DS.Text.body()).foregroundStyle(Theme.secondary)
            ForEach(SetupAccount.allCases) { a in
                Button { account = a } label: {
                    HStack(spacing: DS.Space.lg) {
                        Image(systemName: a.symbol).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title).font(DS.Text.ui(.medium))
                            Text(a.subtitle).font(DS.Text.small()).foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        if state?.ready(a) == true {
                            Label("Ready", systemImage: "checkmark.circle.fill").font(DS.Text.small()).foregroundStyle(.green)
                        }
                        Image(systemName: account == a ? "largecircle.fill.circle" : "circle").foregroundStyle(Theme.accentBlue)
                    }
                    .padding(DS.Space.lg)
                    .contentShape(Rectangle())
                    .background(RoundedRectangle(cornerRadius: DS.Radius.card).stroke(account == a ? Theme.accentBlue : Theme.dividerColor))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("setup.account.\(a.rawValue)")
            }
        }
    }

    // MARK: Step 2

    private var signInStep: some View {
        let steps = state.map { SetupPlan.steps(for: account, state: $0) } ?? []
        return VStack(alignment: .leading, spacing: DS.Space.lg) {
            ForEach(steps) { s in
                HStack(alignment: .top, spacing: DS.Space.md) {
                    Image(systemName: s.done ? "checkmark.circle.fill" : "circle").foregroundStyle(s.done ? .green : Theme.secondary)
                    VStack(alignment: .leading, spacing: DS.Space.xs) {
                        Text(s.title).font(DS.Text.ui(.medium))
                        Text(s.detail).font(DS.Text.small()).foregroundStyle(Theme.secondary)
                        if !s.done, let cmd = s.command {
                            HStack {
                                Text(cmd).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                #if os(macOS)
                                Button("Run") { terminalCommand = cmd }.accessibilityIdentifier("setup.run")
                                #endif
                            }
                        }
                        if !s.done, s.kind == .apiKey { keyField(s.secretKeys) }
                    }
                }
            }
            #if os(macOS) && canImport(SwiftTerm)
            if let cmd = terminalCommand {
                AgentTerminalView(key: "setup-" + cmd, cwd: NSHomeDirectory(), command: cmd)
                    .frame(minHeight: 180)
                    .background(RoundedRectangle(cornerRadius: DS.Radius.card).stroke(Theme.dividerColor))
            }
            #endif
            DisclosureGroup("Connect a Based server (optional)", isExpanded: $showServer) {
                VStack(alignment: .leading) {
                    TextField("https://based.example.com", text: $serverURL)
                    SecureField("Token", text: $serverToken)
                }
                .textFieldStyle(.roundedBorder)
                .padding(.top, DS.Space.xs)
            }
            .font(DS.Text.small())
        }
    }

    private func keyField(_ names: [String]) -> some View {
        HStack {
            Picker("", selection: $keyName) {
                Text("Anthropic").tag("anthropic")
                Text("OpenAI").tag("openai")
            }
            .labelsHidden().frame(width: 120)
            SecureField("Paste key", text: $key).textFieldStyle(.roundedBorder)
            Button("Save") {
                Secrets.set(keyName, key.trimmingCharacters(in: .whitespacesAndNewlines))
                key = ""
                model.brain.reloadProviders()
                Task { await refresh() }
            }
            .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    // MARK: Step 3

    private var doneStep: some View {
        VStack(alignment: .leading, spacing: DS.Space.md) {
            Text("Your main agent is ready. It answers small things itself, hands bigger work to sub-agents, asks before it changes anything and checks in every 2 hours.")
                .font(DS.Text.body())
            if account != .localOnly {
                Label("A daily brief arrives at 06:30.", systemImage: "sun.horizon").font(DS.Text.small())
            }
            Label("Details and every engine: Settings → Agents → Agent setup & diagnosis.", systemImage: "stethoscope")
                .font(DS.Text.small()).foregroundStyle(Theme.secondary)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Button("Not now") {
                UserDefaults.standard.set("skipped", forKey: SetupAssistant.completedKey)
                dismiss()
            }
            Spacer()
            if step == 1 { Button("Check again") { Task { await refresh() } }.accessibilityIdentifier("setup.recheck") }
            if step > 0 && step < 2 { Button("Back") { step -= 1 } }
            switch step {
            case 0:
                Button("Continue") {
                    if state?.ready(account) == true { finish() } else { step = 1 }
                }
                .keyboardShortcut(.defaultAction)
            case 1:
                Button("Finish") { finish() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!(state?.ready(account) ?? false) && account != .localOnly)
            default:
                Button("Say hello to your agent") {
                    dismiss()
                    model.openChat(model.brain.mainThreadID(), fullPage: false)
                    model.brain.ask("Hello! What can you do for me?")
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("setup.hello")
            }
        }
    }

    private func refresh(preselect: Bool = false) async {
        let s = await model.brain.detectSetup()
        state = s
        if preselect { account = s.recommended }
    }

    private func finish() {
        if !serverURL.trimmingCharacters(in: .whitespaces).isEmpty {
            model.brain.serverURL = serverURL.trimmingCharacters(in: .whitespaces)
            if !serverToken.isEmpty { Secrets.set("server.token", serverToken) }
            model.brain.startServerSyncIfConfigured()
        }
        model.brain.applySetup(account, state: state ?? SetupState())
        #if os(macOS) && canImport(SwiftTerm)
        if let cmd = terminalCommand { TerminalRegistry.shared.close("setup-" + cmd) }
        #endif
        step = 2
    }
}
