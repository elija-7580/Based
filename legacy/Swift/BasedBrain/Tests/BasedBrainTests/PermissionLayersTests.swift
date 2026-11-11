import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-98: approval card for API chats (Inbox), rules per agent / project, deny rules on the MCP path.
private final class AppendingProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    let page: RecordID
    init(page: RecordID) { self.page = page }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        if let last = messages.last, last.role == .tool { return AIResponse(message: .assistant("TOOL SAID: " + last.content)) }
        var m = ChatMessage.assistant("")
        m.toolCalls = [ToolCall(id: "c1", name: "append_markdown", arguments: ["page_id": .string(page), "markdown": "INJECTED"])]
        return AIResponse(message: m)
    }
}

@MainActor
private func fixture() -> (WorkspaceStore, BrainStore, AgentTools, AgentRuntime, RecordID) {
    let store = WorkspaceStore(persistence: nil, node: "t")
    let brain = BrainStore(store: store)
    let tools = AgentTools(store: store, brain: brain)
    let page = store.createPage(title: RichText("Notes"), in: .workspace)
    let reg = ModelRegistry()
    reg.register(AppendingProvider(page: page))
    return (store, brain, tools, AgentRuntime(registry: reg, tools: tools), page)
}

@Suite struct PermissionLayersTests {
    @Test func layerTextHasModeAndRules() {
        let l = AgentPermissions.parseLayer("mode: plan\n- deny Bash(*)\nmode sideways\nallow based.search")
        #expect(l.mode == .plan)
        #expect(l.rules.map(\.description) == ["deny Bash", "allow based.search"], "Bash(*) = any command")
        #expect(l.errors == ["mode sideways"])
        #expect(AgentPermissions.parseLayer("Mode Accept edits").mode == .acceptEdits)
        #expect(AgentPermissions.parseLayer("").mode == nil)
        let global = AgentPermissions(mode: .bypass, rulesText: "deny based.trash_page")
        let p = global.layered(text: "mode ask\nallow Bash(git status:*)")
        #expect(p.mode == .ask && p.rules.count == 2)
        #expect(global.layered(text: "").mode == .bypass, "no mode line keeps the outer mode")
        #expect(PermissionRule.alwaysAllow(PermissionCall(tool: "Bash", argument: "git push", category: .shell)).description == "allow Bash(git push)")
        #expect(PermissionRule.alwaysAllow(.based("append_markdown", ["page_id": "p"])).description == "allow based.append_markdown")
    }

    /// Answers the first pending Inbox item of `session` with `decision` once it shows up.
    @MainActor private func answer(_ brain: BrainStore, session: RecordID, _ decision: String) -> Task<Void, Never> {
        Task { @MainActor in
            for _ in 0..<400 {
                if let item = brain.inbox().first(where: { $0.sessionID == session && $0.status == .pending }) {
                    _ = brain.resolveInbox(item.id, decision: decision, status: decision.hasPrefix("allow") ? .approved : .rejected)
                    return
                }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
    }

    @MainActor @Test func chatApprovalCardDeclineAndAlwaysAllow() async throws {
        let (_, brain, _, runtime, page) = fixture()
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "Mac", cwd: "", encrypted: false)
        let approve = brain.inboxApprover(session: sid, timeout: 10, poll: 0.01)

        // Declined: the tool doesn't run, the model (transcript) sees the refusal.
        let a1 = answer(brain, session: sid, "reject_once")
        let declined = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: brain.permissions(mode: .ask), approve: approve)
        await a1.value
        #expect(declined.text.contains("declined"))
        #expect(!brain.body(of: page).contains("INJECTED"))
        let first = brain.inbox(pendingOnly: false).filter { $0.sessionID == sid }
        #expect(first.count == 1 && first[0].kind == .permission && first[0].title.hasPrefix("based.append_markdown"))
        #expect(first[0].options.contains { $0.hasPrefix("allow_always") })

        // "Always allow": runs now and writes a rule …
        let a2 = answer(brain, session: sid, "allow_always")
        let allowed = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: brain.permissions(mode: .ask), approve: approve)
        await a2.value
        #expect(!allowed.text.contains("declined") && brain.body(of: page).contains("INJECTED"))
        #expect(brain.permissions(mode: .ask).rules.map(\.description).contains("allow based.append_markdown"))

        // … so the next call doesn't ask.
        let again = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: brain.permissions(mode: .ask), approve: approve)
        #expect(!again.text.contains("declined"))
        #expect(brain.inbox(pendingOnly: false).filter { $0.sessionID == sid }.count == 2, "no third card")
        brain.appendPermissionRule(PermissionRule(.allow, tool: "based.append_markdown"))
        #expect(brain.permissions(mode: .ask).rules.count == 1, "the same rule is not added twice")
    }

    @MainActor @Test func unansweredCardTimesOutAsDeclined() async throws {
        let (_, brain, _, runtime, page) = fixture()
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "Mac", cwd: "", encrypted: false)
        let o = try await runtime.run(prompt: "go", modelRef: "fake/m1", permissions: AgentPermissions(mode: .ask),
                                      approve: brain.inboxApprover(session: sid, timeout: 0.1, poll: 0.02))
        #expect(o.text.contains("declined") && !brain.body(of: page).contains("INJECTED"))
        #expect(brain.inbox(pendingOnly: false).first { $0.sessionID == sid }?.status == .rejected)
    }

    @MainActor @Test func agentInPlanModeCannotChangeAnything() async {
        let (_, brain, _, runtime, page) = fixture()
        let id = brain.saveAgent(name: "Tidy", instructions: "Append to Notes", schedule: "daily 09:00", model: nil)
        brain.setPermissions(row: id, "mode plan")
        let agent = try! #require(brain.agents().first { $0.id == id })
        #expect(agent.permissions == "mode plan")
        let o = await runtime.run(agent: agent, trigger: "schedule")
        #expect(o?.text.contains("plan mode") == true)
        #expect(!brain.body(of: page).contains("INJECTED"))

        // Without the layer the same agent may edit (mode Ask without approver lets ordinary edits run, as before).
        brain.setPermissions(row: id, "")
        let free = try! #require(brain.agents().first { $0.id == id })
        _ = await runtime.run(agent: free, trigger: "schedule")
        #expect(brain.body(of: page).contains("INJECTED"))
    }

    @MainActor @Test func projectLayerAndProblems() {
        let (_, brain, _, _, _) = fixture()
        let project = brain.createProject(name: "Publit")
        brain.setPermissions(row: project, "deny based.append_markdown\nallow Bash(oops")
        let p = brain.permissions(mode: .bypass, project: project)
        #expect(p.decide(.based("append_markdown", [:])).effect == .deny)
        #expect(brain.permissions(mode: .bypass).decide(.based("append_markdown", [:])).effect == .allow)
        let id = brain.saveAgent(name: "Writer", instructions: "", schedule: nil, model: nil)
        brain.setPermissions(row: id, "mode wild")
        let problems = brain.permissionProblems()
        #expect(problems.contains("Project “Publit”: allow Bash(oops"))
        #expect(problems.contains("Agent “Writer”: mode wild"))
        let agent = brain.agents().first { $0.id == id }
        #expect(brain.permissions(mode: .ask, agent: agent, project: project).rules.count == 1)
    }

    @MainActor @Test func mcpToolsCallHonoursDenyRules() async {
        let (_, brain, tools, _, page) = fixture()
        let mcp = MCPServer(tools: tools)
        func call(_ name: String, _ args: JSONValue) async -> (String, Bool) {
            let msg: JSONValue = ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": .string(name), "arguments": args]]
            let r = await mcp.handle(message: msg, session: nil) ?? .null
            return (r["result"]?["content"]?[0]?["text"]?.string ?? "", r["result"]?["isError"]?.bool ?? false)
        }
        mcp.permissions = { AgentPermissions(mode: .bypass, rulesText: "deny based.append_markdown") }
        let (text, isError) = await call("append_markdown", ["page_id": .string(page), "markdown": "INJECTED"])
        #expect(isError && text.contains("Not permitted"))
        #expect(!brain.body(of: page).contains("INJECTED"))
        let (_, readError) = await call("search", ["query": "Notes"])
        #expect(!readError, "reads pass")
        // "ask" is the client's job: it passes here; Plan mode blocks changes.
        mcp.permissions = { AgentPermissions(mode: .ask, rulesText: "ask based.append_markdown") }
        let (_, askError) = await call("append_markdown", ["page_id": .string(page), "markdown": "OK1"])
        #expect(!askError && brain.body(of: page).contains("OK1"))
        mcp.permissions = { AgentPermissions(mode: .plan) }
        let (planText, planError) = await call("append_markdown", ["page_id": .string(page), "markdown": "OK2"])
        #expect(planError && planText.contains("plan mode") && !brain.body(of: page).contains("OK2"))
    }
}
