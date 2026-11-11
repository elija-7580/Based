import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-56: setup assistant logic against a fake machine.
@Suite struct SetupPlanTests {
    /// A fake machine: installed commands, files, environment, Keychain names.
    private func probe(bins: [String] = [], files: [String: String] = [:], env: [String: String] = [:],
                       secrets: Set<String> = [], server: String = "", local: Bool = false) -> SetupProbe {
        let home = "/Users/eli"
        let f = files.reduce(into: [String: String]()) { $0[$1.key.replacingOccurrences(of: "~", with: home)] = $1.value }
        let b = Set(bins)
        return SetupProbe(environment: env, home: home,
                          fileExists: { f[$0] != nil }, readFile: { f[$0] },
                          which: { b.contains($0) ? "/opt/homebrew/bin/\($0)" : nil },
                          secrets: secrets, serverURL: server, serverToken: !server.isEmpty, localModel: local)
    }

    @Test func freshMachineNeedsEverything() {
        let s = SetupPlan.detect(probe())
        #expect(!s.isReady)
        #expect(s.readyAccounts.isEmpty)
        #expect(s.recommended == .chatgpt)
        #expect(SetupPlan.needsAssistant(state: s, completed: false))
        let steps = SetupPlan.steps(for: .chatgpt, state: s)
        #expect(steps.map(\.title) == ["Install Node.js", "Install Codex", "Sign in"])
        #expect(steps.map(\.command) == ["brew install node", "npm install -g @openai/codex", "codex login"])
        #expect(SetupPlan.nextStep(for: .chatgpt, state: s)?.title == "Install Node.js")
    }

    @Test func codexLoginDetection() {
        // Installed, not logged in → next step is the login.
        var s = SetupPlan.detect(probe(bins: ["node", "npx", "codex"]))
        #expect(s.codex.installed && !s.codex.loggedIn)
        #expect(SetupPlan.nextStep(for: .chatgpt, state: s)?.command == "codex login")
        #expect(s.recommended == .chatgpt)
        // auth.json with ChatGPT tokens → ready.
        s = SetupPlan.detect(probe(bins: ["node", "npx", "codex"], files: ["~/.codex/auth.json": #"{"OPENAI_API_KEY": null, "tokens": {"id_token": "x"}}"#]))
        #expect(s.ready(.chatgpt))
        #expect(SetupPlan.nextStep(for: .chatgpt, state: s) == nil)
        #expect(!SetupPlan.needsAssistant(state: s, completed: false))
        // Logged-out file (no tokens, empty key) is not a login; CODEX_HOME moves the file.
        s = SetupPlan.detect(probe(bins: ["codex"], files: ["~/.codex/auth.json": #"{"OPENAI_API_KEY": null}"#]))
        #expect(!s.codex.loggedIn)
        s = SetupPlan.detect(probe(bins: ["codex"], files: ["/data/codex/auth.json": #"{"tokens": {}}"#], env: ["CODEX_HOME": "/data/codex"]))
        #expect(s.codex.loggedIn)
        // A login file without the CLI is not ready (nothing can run it).
        s = SetupPlan.detect(probe(files: ["~/.codex/auth.json": #"{"tokens": {}}"#]))
        #expect(!s.ready(.chatgpt))
    }

    @Test func claudeLoginDetection() {
        var s = SetupPlan.detect(probe(bins: ["claude"]))
        #expect(s.claude.installed && !s.claude.loggedIn)
        #expect(s.recommended == .claude)
        let steps = SetupPlan.steps(for: .claude, state: s)
        #expect(steps.map(\.done) == [true, false], "no Node step when the CLI is already installed")
        #expect(steps.last?.command == "claude")
        s = SetupPlan.detect(probe(bins: ["claude"], files: ["~/.claude.json": #"{"oauthAccount": {"emailAddress": "e@x"}}"#]))
        #expect(s.ready(.claude))
        s = SetupPlan.detect(probe(bins: ["claude"], files: ["~/.claude/.credentials.json": "{}"]))
        #expect(s.ready(.claude))
        s = SetupPlan.detect(probe(bins: ["claude"], env: ["CLAUDE_CODE_OAUTH_TOKEN": "t"]))
        #expect(s.ready(.claude))
        // Both ready → Claude is preselected, both are listed.
        s = SetupPlan.detect(probe(bins: ["claude", "codex"], files: ["~/.claude/.credentials.json": "{}", "~/.codex/auth.json": #"{"tokens":{}}"#]))
        #expect(s.readyAccounts == [.chatgpt, .claude])
        #expect(s.recommended == .claude)
    }

    @Test func apiKeysAndLocalOnly() {
        var s = SetupPlan.detect(probe(secrets: ["openai"]))
        #expect(s.ready(.apiKey) && s.isReady)
        #expect(s.recommended == .apiKey)
        s = SetupPlan.detect(probe(env: ["ANTHROPIC_API_KEY": "sk"]))
        #expect(s.anthropicKey)
        s = SetupPlan.detect(probe(env: ["ANTHROPIC_API_KEY": "  "]))
        #expect(!s.anthropicKey, "blank variables do not count")
        let key = SetupPlan.steps(for: .apiKey, state: SetupPlan.detect(probe()))
        #expect(key.count == 1 && key[0].kind == .apiKey && key[0].secretKeys == ["anthropic", "openai"] && !key[0].done)
        // On-device alone is not "set up": it cannot use tools, the assistant still shows.
        s = SetupPlan.detect(probe(local: true))
        #expect(s.ready(.localOnly) && !s.isReady)
        #expect(SetupPlan.needsAssistant(state: s, completed: false))
        #expect(!SetupPlan.needsAssistant(state: s, completed: true), "never shown again once finished")
        // Server settings are reported, not required.
        s = SetupPlan.detect(probe(server: "https://based.example"))
        #expect(s.serverConfigured && s.serverToken)
    }

    @Test(arguments: SetupAccount.allCases)
    func defaultsPerAccount(_ a: SetupAccount) {
        let d = SetupPlan.defaults(for: a, state: SetupState())
        #expect(d.account == a)
        #expect(d.permissionMode == .ask)
        #expect(d.mainAgentCompute == .low)
        #expect(d.compute == .auto)
        #expect(d.heartbeat == "every 2h" && Schedule.parse(d.heartbeat) != nil)
        #expect(d.routes == ModelRouter.defaultRoutes.map(\.id) && !d.routes.isEmpty)
        switch a {
        case .chatgpt: #expect(d.engine.kind == .codex)
        case .claude: #expect(d.engine.kind == .claudeCode)
        case .apiKey, .localOnly: #expect(d.engine == .auto)
        }
        if a == .localOnly { #expect(d.dailyBrief == nil) } else {
            #expect(d.dailyBrief == "daily 06:30")
            #expect(Schedule.parse(d.dailyBrief!) != nil)
        }
    }

    @Test @MainActor func applyCreatesMainAgentAndBriefOnce() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let d = SetupPlan.defaults(for: .chatgpt, state: SetupState())
        let first = SetupPlan.apply(d, brain: brain)
        #expect(first.mainAgentCreated && first.dailyBriefCreated)
        let main = brain.mainAgent()
        #expect(main?.id == first.mainAgent && main?.isMain == true && main?.schedule == "every 2h")
        let brief = brain.agents().first { $0.name == SetupPlan.dailyBriefName }
        #expect(brief?.schedule == "daily 06:30" && brief?.instructions.contains("brief") == true)

        // The user edits the brief; running the assistant again keeps it and creates nothing new.
        brain.saveAgent(name: SetupPlan.dailyBriefName, instructions: "Mine.", schedule: "daily 08:00", model: nil)
        let count = brain.agents().count
        let second = SetupPlan.apply(d, brain: brain)
        #expect(!second.mainAgentCreated && !second.dailyBriefCreated)
        #expect(second.mainAgent == first.mainAgent && second.dailyBrief == first.dailyBrief)
        #expect(brain.agents().count == count)
        #expect(brain.agents().first { $0.name == SetupPlan.dailyBriefName }?.schedule == "daily 08:00")
    }

    @Test @MainActor func localOnlyCreatesNoBrief() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let r = SetupPlan.apply(SetupPlan.defaults(for: .localOnly, state: SetupState()), brain: brain)
        #expect(r.dailyBrief == nil && !r.dailyBriefCreated)
        #expect(brain.mainAgent() != nil)
    }
}
