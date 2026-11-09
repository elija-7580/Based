import SwiftUI
import BasedBrain

/// BSD-110: Settings → Agents & AI → Environment passthrough. Per coding agent, the login-shell variables it may
/// inherit on top of the safe allowlist (BSD-33), e.g. `ANTHROPIC_API_KEY` for Claude Code. Stored in the defaults
/// key `based.agentEnv.<agent id>` (the same one `based-server --agent-env` sets). Written on Return or when the
/// section disappears, and only when the list really changed (BSD-135: no defaults write per keystroke).
struct AgentEnvSettingsSection: View {
    @Environment(HappierModel.self) private var happier
    @State private var drafts: [String: String] = [:]
    @State private var saved: [String: String] = [:]

    var body: some View {
        Section {
            ForEach(happier.agents.filter(\.enabled)) { a in
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent(a.name) {
                        TextField("e.g. \(Self.example(for: a.id))", text: Binding(get: { drafts[a.id] ?? "" }, set: { drafts[a.id] = $0 }))
                            .font(.body.monospaced())
                            .onSubmit { commit(a.id) }
                    }
                    let names = Self.names(drafts[a.id] ?? "")
                    if let secret = names.first(where: SandboxEnvironmentPolicy.looksSecret) {
                        Label("\(secret) looks like a secret: \(a.name) and every command it runs can read it.", systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if let missing = ShellEnvironment.unapprovedKeys(for: a.id, base: ShellEnvironment.cachedEnvironment ?? [:]).first,
                       !names.contains(missing) {
                        Button("Pass \(missing) from your shell to \(a.name)") {
                            drafts[a.id] = (names + [missing]).joined(separator: ", ")
                            commit(a.id)
                        }
                        .font(.caption)
                    }
                }
            }
        } header: { Text("Environment passthrough") } footer: {
            Text("Agents only get a safe set of shell variables (PATH, HOME, proxies …). List extra names here, comma-separated, to let one agent see them. Press Return to save. On a server: based-server --agent-env claude=ANTHROPIC_API_KEY.")
                .font(.caption)
        }
        .onAppear(perform: load)
        .onDisappear { for id in drafts.keys { commit(id) } }
    }

    private func load() {
        var d: [String: String] = [:]
        for a in happier.agents { d[a.id] = ShellEnvironment.approvedPassthrough(for: a.id).sorted().joined(separator: ", ") }
        drafts = d
        saved = d
    }

    private func commit(_ id: String) {
        guard let text = drafts[id], text != saved[id] else { return }
        let stored = ShellEnvironment.setApprovedPassthrough(Self.names(text), for: id)
        let shown = stored.joined(separator: ", ")
        drafts[id] = shown
        saved[id] = shown
    }

    static func names(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)
    }

    static func example(for id: String) -> String {
        ShellEnvironment.agentKeyHints[id]?.first ?? "MY_TOOL_HOME"
    }
}
