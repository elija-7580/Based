import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-50: permission modes and allow / ask / deny rules like Claude Code.
private final class ToolCallingProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    let tool: String
    let args: JSONValue
    init(tool: String, args: JSONValue) { self.tool = tool; self.args = args }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        if let last = messages.last, last.role == .tool { return AIResponse(message: .assistant("TOOL SAID: " + last.content)) }
        var m = ChatMessage.assistant("")
        m.toolCalls = [ToolCall(id: "c1", name: tool, arguments: args)]
        return AIResponse(message: m)
    }
}

@Suite struct AgentPermissionsTests {
    private let home = "/Users/e"

    @Test func parsesLinesJSONAndReportsBadLines() {
        let text = """
        ## Rules
        - allow Bash(git status:*)
        - `deny Write(~/secret/**)`
        ask based.trash_page
        # a comment
        allow: Web(*)
        nonsense here
        allow Bash(unclosed
        """
        let (rules, errors) = AgentPermissions.parseRules(text)
        #expect(rules.map(\.description) == ["allow Bash(git status:*)", "deny Write(~/secret/**)", "ask based.trash_page", "allow Web"])
        #expect(errors == ["nonsense here", "allow Bash(unclosed"])
        #expect(AgentPermissions.parseRules(#"- deny based.trash\_page"#).rules.first?.tool == "based.trash_page", "Markdown escapes")
        let json = #"{"permissions": {"allow": ["Bash(npm run test:*)"], "deny": ["Read(./.env)"], "ask": ["mcp__gmail__*"]}}"#
        let (j, je) = AgentPermissions.parseRules(json)
        #expect(je.isEmpty)
        #expect(Set(j.map(\.description)) == ["allow Bash(npm run test:*)", "deny Read(./.env)", "ask mcp__gmail__*"])
    }

    @Test func precedenceDenyAskAllowMode() {
        let p = AgentPermissions(mode: .bypass, rulesText: """
        allow Bash(git *)
        ask Bash(git push:*)
        deny Bash(git push --force:*)
        """, home: home)
        let bash = { (c: String) in PermissionCall(tool: "Bash", argument: c, category: .shell, sandboxed: true) }
        #expect(p.decide(bash("git status")).effect == .allow)
        #expect(p.decide(bash("git push origin main")).effect == .ask)
        #expect(p.decide(bash("git push --force origin main")).effect == .deny)
        #expect(p.decide(bash("rm -rf build")).effect == .allow, "bypass mode, sandboxed")
        #expect(p.decide(PermissionCall(tool: "Bash", argument: "rm -rf build", category: .shell)).effect == .ask,
                "shell outside a sandbox always asks, even in bypass")
    }

    @Test func commandPrefixRespectsWordBoundary() {
        let p = AgentPermissions(mode: .ask, rulesText: "allow Bash(git status:*)", home: home)
        func eff(_ c: String) -> PermissionEffect { p.decide(PermissionCall(tool: "Bash", argument: c, category: .shell)).effect }
        #expect(eff("git status") == .allow)
        #expect(eff("git status --short") == .allow)
        #expect(eff("git statusx; rm -rf /") == .ask)
        #expect(eff("git commit") == .ask)
    }

    @Test func modesPerCategory() {
        func eff(_ m: PermissionMode, _ c: ToolCategory) -> PermissionEffect {
            AgentPermissions(mode: m, home: home).decide(PermissionCall(tool: "x", category: c, sandboxed: true)).effect
        }
        #expect(eff(.ask, .read) == .allow && eff(.ask, .edit) == .ask && eff(.ask, .shell) == .ask)
        #expect(eff(.acceptEdits, .edit) == .allow && eff(.acceptEdits, .destructive) == .ask && eff(.acceptEdits, .external) == .ask)
        #expect(eff(.plan, .read) == .allow && eff(.plan, .web) == .allow && eff(.plan, .edit) == .deny && eff(.plan, .shell) == .deny)
        #expect(eff(.bypass, .destructive) == .allow && eff(.bypass, .external) == .allow)
        // Plan stays read-only even with an allow rule.
        let plan = AgentPermissions(mode: .plan, rulesText: "allow based.*", home: home)
        #expect(plan.decide(.based("append_markdown", ["page_id": "p"])).effect == .deny)
        #expect(plan.decide(.based("read_page", ["page_id": "p"])).effect == .allow)
    }

    @Test func alwaysAskList() {
        let bypass = AgentPermissions(mode: .bypass, home: home)
        let send = PermissionCall(tool: "mcp__gmail__send_email", category: .external)
        #expect(send.alwaysAsks && bypass.decide(send).effect == .ask)
        #expect(bypass.decide(PermissionCall(tool: "mcp__github__list_issues", category: .external)).effect == .allow)
        #expect(bypass.decide(PermissionCall(tool: "based.delete_page_permanently", category: .destructive)).effect == .ask)
        let allowed = AgentPermissions(mode: .bypass, rulesText: "allow mcp__gmail__send_email", home: home)
        #expect(allowed.decide(send).effect == .allow, "only an explicit rule lifts it")
    }

    @Test func pathRulesUseSeparatorsAndResolveSymlinks() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("perm-\(UUID().uuidString)").resolvingSymlinksInPath()
        let proj = base.appendingPathComponent("proj"), secret = base.appendingPathComponent("proj-secret")
        try fm.createDirectory(at: proj, withIntermediateDirectories: true)
        try fm.createDirectory(at: secret, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: proj.appendingPathComponent("link"), withDestinationURL: secret)
        defer { try? fm.removeItem(at: base) }

        #expect(PathScope.contains(root: proj.path, path: proj.path + "/a/b.txt"))
        #expect(!PathScope.contains(root: proj.path, path: secret.path + "/x"), "/proj must not allow /proj-secret")
        #expect(!PathScope.contains(root: proj.path, path: proj.path + "/link/x"), "a symlink out of the project is outside")
        #expect(!PathScope.contains(root: proj.path, path: proj.path + "/../proj-secret/x"))

        let p = AgentPermissions(mode: .acceptEdits, rulesText: "deny Write(\(secret.path)/**)", home: home)
        #expect(p.decide(PermissionCall(tool: "Edit", argument: proj.path + "/link/x.txt", category: .edit)).effect == .deny,
                "Write rules cover Edit, through the symlink")
        #expect(p.decide(PermissionCall(tool: "Edit", argument: proj.path + "/ok.txt", category: .edit)).effect == .allow)
        let tilde = AgentPermissions(mode: .acceptEdits, rulesText: "deny Read(~/private/**)", home: "/Users/e")
        #expect(tilde.decide(PermissionCall(tool: "Read", argument: "/Users/e/private/a", category: .read)).effect == .deny)
        #expect(tilde.decide(PermissionCall(tool: "Read", argument: "/Users/e/private-not/a", category: .read)).effect == .allow)

        // ACP file access uses the same check.
        let client = ACPClient(definition: AgentDefinition(id: "x", name: "X", command: "/bin/true"))
        client.allowedRoots = [proj.path]
        #expect(client.allowed(proj.path + "/file.txt"))
        #expect(!client.allowed(secret.path + "/file.txt"))
        #expect(!client.allowed(proj.path + "/link/file.txt"))
    }

    @Test func callsFromClaudeAndACP() {
        #expect(PermissionCall.claude("Bash", ["command": "ls"]) == PermissionCall(tool: "Bash", argument: "ls", category: .shell))
        #expect(PermissionCall.claude("Write", ["file_path": "/a"]).category == .edit)
        #expect(PermissionCall.claude("mcp__based__trash_page", ["page_id": "p"]).tool == "based.trash_page")
        #expect(PermissionCall.claude("mcp__slack__post", [:]).category == .external)
        #expect(PermissionCall.acp(kind: "execute", title: "Run", detail: #"{"command":"git status"}"#).argument == "git status")
        #expect(PermissionCall.acp(kind: "read", title: "Read", detail: "{}").category == .read)
        #expect(PermissionCall.based("update_database", ["database_id": "d", "delete_properties": ["X"]]).category == .destructive)
        #expect(PermissionCall.based("update_row", ["page_id": "r"]).category == .edit)
        #expect(PermissionMode.acceptEdits.cliPermission(for: .claudeCode) == "acceptEdits")
        #expect(PermissionMode.bypass.cliPermission(for: .codex) == "danger-full-access")
    }

    @MainActor @Test func runtimeRefusesDeniedToolsAndPlanMode() async throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let page = store.createPage(title: RichText("Notes"), in: .workspace)
        let reg = ModelRegistry()
        reg.register(ToolCallingProvider(tool: "append_markdown", args: ["page_id": .string(page), "markdown": "INJECTED"]))
        let runtime = AgentRuntime(registry: reg, tools: tools)
        let body = { brain.body(of: page) }

        let denied = try await runtime.run(prompt: "go", modelRef: "fake/m1",
                                           permissions: AgentPermissions(mode: .bypass, rulesText: "deny based.append_markdown"))
        #expect(denied.text.contains("Not permitted") && !body().contains("INJECTED"))
        let plan = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: AgentPermissions(mode: .plan))
        #expect(plan.text.contains("plan mode") && !body().contains("INJECTED"))
        let askRule = try await runtime.run(prompt: "go", modelRef: "fake/m1",
                                            permissions: AgentPermissions(mode: .acceptEdits, rulesText: "ask based.append_markdown"))
        #expect(askRule.text.contains("Needs the user's approval") && !body().contains("INJECTED"))
        let asked = await tools.authorize("append_markdown", ["page_id": .string(page)], permissions: AgentPermissions(mode: .ask),
                                          approve: { _, _ in false })
        #expect(asked?.text.contains("declined") == true)
        let accepted = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: AgentPermissions(mode: .acceptEdits))
        #expect(!accepted.text.contains("Not permitted") && body().contains("INJECTED"))
        let legacy = await tools.authorize("append_markdown", ["page_id": .string(page)], permissions: nil)
        #expect(legacy == nil, "no permissions = as before")
    }

    @MainActor @Test func inboxIsAnsweredOnce() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let item = brain.addInbox(title: "Run git push", kind: .permission, sessionID: nil, detail: "", options: [("allow_once", "Allow")])
        #expect(brain.resolveInbox(item, decision: "allow_once", status: .approved, device: "Mac"))
        #expect(!brain.resolveInbox(item, decision: "reject_once", status: .rejected, device: "iPhone"), "second device loses")
        let it = brain.inbox(pendingOnly: false).first { $0.id == item }
        #expect(it?.status == .approved)
        #expect(it?.decision == "allow_once · Mac")
    }

    @MainActor @Test func codingSessionRulesAnswerWithoutInbox() async {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let runtime = HappierRuntime(brain: brain, connections: nil, agents: [], machineName: "test")
        runtime.inboxTimeout = 0.1
        runtime.permissionPolicy = .ask
        let sid = brain.createSession(title: "S", agentID: "claude", machine: "test", cwd: "", encrypted: false)
        runtime.permissionRules = { AgentPermissions(mode: .ask, rulesText: "allow Bash(git status:*)\ndeny Bash(rm:*)") }
        let ok = await runtime.claudeApproval(session: sid, tool: "Bash", input: ["command": "git status"])
        #expect(ok["behavior"]?.string == "allow")
        #expect(brain.inbox().isEmpty, "allowed by rule, no Inbox item")
        let no = await runtime.claudeApproval(session: sid, tool: "Bash", input: ["command": "rm -rf ~"])
        #expect(no["behavior"]?.string == "deny")
        // An ask rule wins over "allow everything": it goes to the Inbox (and times out here).
        runtime.permissionPolicy = .allowAll
        runtime.permissionRules = { AgentPermissions(mode: .ask, rulesText: "ask Bash(git push:*)") }
        let asked = await runtime.claudeApproval(session: sid, tool: "Bash", input: ["command": "git push"])
        #expect(asked["behavior"]?.string == "deny")
        #expect(brain.inbox(pendingOnly: false).contains { $0.title.contains("git push") || $0.decision == "timeout" })
    }

    @MainActor @Test func permissionsPage() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        #expect(brain.permissionRulesText().isEmpty)
        let id = brain.ensurePermissionsPage()
        #expect(brain.ensurePermissionsPage() == id)
        #expect(AgentPermissions.parseRules(brain.permissionRulesText()).rules.isEmpty, "the template has no active rule")
        brain.appendBody(id, markdown: "- deny based.trash_page")
        let p = brain.permissions(mode: .bypass)
        #expect(p.rules.count == 1, Comment(rawValue: brain.permissionRulesText()))
        #expect(p.decide(.based("trash_page", ["page_id": "x"])).effect == .deny)
    }
}
