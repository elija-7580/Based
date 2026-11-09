import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-115: one permission vocabulary for coding sessions, 409 with the answering device.
@MainActor
struct PermissionsPart3Tests {
    @Test func oldPolicyValuesMapOntoModes() {
        #expect(PermissionMode(legacyPolicy: "ask") == .ask)
        #expect(PermissionMode(legacyPolicy: "allowReads") == .ask)
        #expect(PermissionMode(legacyPolicy: "allowAll") == .bypass)
        #expect(PermissionMode(legacyPolicy: "something") == .ask)
        #expect(PermissionMode.stored(nil, legacyPolicy: "allowAll") == .bypass, "migrated from the old key")
        #expect(PermissionMode.stored("plan", legacyPolicy: "allowAll") == .plan, "the new key wins")
        #expect(PermissionMode.stored(nil, legacyPolicy: nil) == .ask)
        // The old property still works on the runtime.
        let runtime = HappierRuntime(brain: BrainStore(store: WorkspaceStore(persistence: nil, node: "t")), connections: nil, agents: [], machineName: "t")
        runtime.permissionPolicy = .allowAll
        #expect(runtime.permissionMode == .bypass && runtime.permissionPolicy == .allowAll)
        runtime.permissionPolicy = .allowReads
        #expect(runtime.permissionMode == .ask)
    }

    @Test func modesAnswerRequestsByKind() {
        #expect(PermissionMode.ask.autoAnswer(kind: "read") == true)
        #expect(PermissionMode.ask.autoAnswer(kind: "edit") == nil)
        #expect(PermissionMode.acceptEdits.autoAnswer(kind: "edit") == true)
        #expect(PermissionMode.acceptEdits.autoAnswer(kind: "execute") == nil)
        #expect(PermissionMode.plan.autoAnswer(kind: "search") == true)
        #expect(PermissionMode.plan.autoAnswer(kind: "execute") == false)
        #expect(PermissionMode.bypass.autoAnswer(kind: "execute") == true)
        #expect(PermissionMode.plan.claudePermissionMode == "plan" && PermissionMode.bypass.claudePermissionMode == "bypassPermissions")
    }

    @Test func planModeRefusesClaudeEditsWithoutInbox() async {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let runtime = HappierRuntime(brain: brain, connections: nil, agents: [], machineName: "t")
        runtime.inboxTimeout = 0.1
        runtime.permissionMode = .plan
        let sid = brain.createSession(title: "S", agentID: "claude", machine: "t", cwd: "", encrypted: false)
        let edit = await runtime.claudeApproval(session: sid, tool: "Edit", input: ["file_path": "/x"])
        #expect(edit["behavior"]?.string == "deny")
        let read = await runtime.claudeApproval(session: sid, tool: "Read", input: ["file_path": "/x"])
        #expect(read["behavior"]?.string == "allow")
        #expect(brain.inbox().isEmpty)
    }

    @Test func secondAnswerGets409WithTheDevice() async throws {
        let routes = ServerRouterTests()
        let f = try routes.fixture()
        let brain = BrainStore(store: f.store)
        let id = brain.addInbox(title: "Run npm test", kind: .permission, sessionID: nil, detail: "",
                                options: [("allow_once", "Allow"), ("reject_once", "Deny")])
        func answer(_ device: String, _ decision: String) async throws -> (Int, JSONValue) {
            let body = try JSONValue.object(["decision": .string(decision), "device": .string(device)]).encoded()
            let r = await f.router.handle(routes.req("POST", "/inbox/\(id)/resolve", bearer: ServerRouterTests.owner, body: body))
            return (r.status, try JSONValue.parse(r.body))
        }
        let (s1, b1) = try await answer("iPhone", "allow_once")
        #expect(s1 == 200 && InboxResolveOutcome.parse(status: s1, body: b1) == .ok)
        let (s2, b2) = try await answer("Mac", "reject_once")
        #expect(s2 == 409)
        let outcome = InboxResolveOutcome.parse(status: s2, body: b2)
        #expect(outcome == .alreadyAnswered(device: "iPhone"))
        #expect(outcome.message == "Already answered on iPhone")
        #expect(brain.inbox(pendingOnly: false).first { $0.id == id }?.answeredOn == "iPhone")
        #expect(InboxResolveOutcome.parse(status: 409, body: [:]).message == "Already answered on another device")
        #expect(InboxResolveOutcome.parse(status: 500, body: ["error": "boom"]) == .failed("boom"))
    }
}
