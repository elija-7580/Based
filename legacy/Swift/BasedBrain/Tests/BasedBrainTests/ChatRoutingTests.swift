import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-94: engine choice, system prompt and page context in BasedBrain; one stream-json parser;
/// sessions deliver their updates in order.
private struct StubProvider: AIProvider {
    var id: String
    var displayName: String { id }
    var models: [String]
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        AIResponse(message: ChatMessage(role: .assistant, content: "ok"))
    }
}

@Suite struct ChatRoutingTests {
    private func registry(_ providers: [StubProvider]) -> ModelRegistry {
        let r = ModelRegistry()
        for p in providers { r.register(p) }
        return r
    }

    @Test func autoPrefersAPIThenClaudeCodeThenCodexThenOnDevice() {
        let api = registry([StubProvider(id: "anthropic", models: ["claude-opus-5-5"]), StubProvider(id: "apple", models: ["on-device"])])
        #expect(ChatRouting.resolve(.auto, registry: api, installed: [.claudeCode], defaultModel: "") == .model("anthropic/claude-opus-5-5"))
        #expect(ChatRouting.resolve(.auto, registry: api, installed: [], defaultModel: "anthropic/x") == .model("anthropic/x"))
        #expect(ChatRouting.resolve(.auto, registry: api, installed: [], defaultModel: "apple/on-device") == .model("anthropic/claude-opus-5-5"),
                "an on-device default never wins over a cloud model")
        let onDevice = registry([StubProvider(id: "apple", models: ["on-device"])])
        #expect(ChatRouting.resolve(.auto, registry: onDevice, installed: [.codex, .claudeCode], defaultModel: "") == .cli(ChatEngineSpec(kind: .claudeCode)))
        #expect(ChatRouting.resolve(.auto, registry: onDevice, installed: [.codex], defaultModel: "") == .cli(ChatEngineSpec(kind: .codex)))
        #expect(ChatRouting.resolve(.auto, registry: onDevice, installed: [], defaultModel: "") == .model("apple/on-device"))
        #expect(ChatRouting.resolve(.auto, registry: ModelRegistry(), installed: [], defaultModel: "") == .none)
    }

    @Test func explicitChoicesAndFallbacks() {
        let api = registry([StubProvider(id: "openai", models: ["gpt-5"])])
        let gemini = ChatEngineSpec(kind: .gemini, model: "pro")
        #expect(ChatRouting.resolve(gemini, registry: api, installed: [.gemini], defaultModel: "") == .cli(gemini))
        #expect(ChatRouting.resolve(gemini, registry: api, installed: [], defaultModel: "") == .model("openai/gpt-5"),
                "a CLI that is not installed falls back to Auto")
        let apiSpec = ChatEngineSpec(kind: .api, model: "openai/gpt-5")
        #expect(ChatRouting.resolve(apiSpec, registry: api, installed: [.claudeCode], defaultModel: "") == .model("openai/gpt-5"))
        #expect(ChatRouting.resolve(apiSpec, registry: ModelRegistry(), installed: [.claudeCode], defaultModel: "") == .cli(ChatEngineSpec(kind: .claudeCode)))
        #expect(ChatRouting.label(.model("apple/on-device")) == "Apple Intelligence (on device)")
        #expect(ChatRouting.label(.cli(ChatEngineSpec(kind: .codex))) == "Codex")
        #expect(ChatRouting.label(.none) == "No AI configured")
    }

    @Test func systemPromptOnlyForCLIs() {
        let long = String(repeating: "m", count: 9000)
        let s = ChatRouting.systemPrompt(for: .cli(ChatEngineSpec(kind: .claudeCode)), context: long)
        #expect(s.hasPrefix("You are the assistant inside Based"))
        #expect(s.contains(ChatRouting.artifactHint) && s.contains(BasedGuide.instructions))
        #expect(s.hasSuffix(String(repeating: "m", count: 6000)) && !s.hasSuffix(String(repeating: "m", count: 6001)))
        #expect(ChatRouting.systemPrompt(for: .model("anthropic/x"), context: long).isEmpty)
    }

    @MainActor @Test func pageContextOnDeviceAndWithTools() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let page = store.createPage(title: RichText("Plan"))
        store.trash([store.createPage(title: RichText("Gone"))])
        let trashed = store.blocks.values.first { store.isTrashed($0.id) }?.id
        #expect(ChatRouting.page(nil, in: store, onDevice: false) == nil)
        #expect(trashed.map { ChatRouting.page($0, in: store, onDevice: false) == nil } ?? true)
        let withTools = ChatRouting.prompt("Hi", attachments: ["Attached file: /a.txt"], page: ChatRouting.page(page, in: store, onDevice: false), onDevice: false)
        #expect(withTools.hasPrefix("Hi\n\nAttached file: /a.txt\n\n---\nContext: the user has the page “Plan” open (page id \(page))"))
        let local = ChatRouting.prompt("Hi", page: (page, "", String(repeating: "x", count: 3000)), onDevice: true)
        #expect(local.contains("Open page “Untitled”:\n") && local.hasSuffix(String(repeating: "x", count: 1500)))
        #expect(!local.contains(String(repeating: "x", count: 1501)))
    }

    @Test func oneParserForSessionsAndChat() {
        let lines = [
            #"{"type":"system","subtype":"init","session_id":"s1","model":"opus","cwd":"/p","permissionMode":"plan","tools":[]}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a"}}]}}"#,
            #"{"type":"assistant","parent_tool_use_id":"t9","message":{"content":[{"type":"text","text":"sub"}]}}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"x"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAEC"}}]}]}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"result":"Hello","session_id":"s1","cost_usd":0.5,"usage":{"input_tokens":3,"output_tokens":4}}"#,
        ]
        // Chat = parser without sub-agents, mapped 1:1.
        let chat = lines.flatMap { ClaudeChatStream.events(fromLine: $0) }
        let mapped = lines.flatMap { ClaudeStream.parse(line: $0, includeSubagents: false) }.compactMap(ClaudeStream.chatEvent)
        #expect(chat == mapped)
        #expect(chat == [.started(model: "opus", sessionID: "s1"), .textDelta("Hel"), .text("Hello"),
                         .toolUse(id: "t1", name: "Read", input: ["file_path": "/a"]), .toolResult(id: "t1", output: "x", isError: false),
                         .toolImage(id: "t1", data: Data([0, 1, 2]), mediaType: "image/png"),
                         .result(text: "Hello", sessionID: "s1", costUSD: 0.5, isError: false)])
        // Sessions see the sub-agent line and get ACP updates; deltas and images add nothing there.
        let session = lines.flatMap { ClaudeStream.parse(line: $0) }
        #expect(session.contains(.text("sub")))
        let updates = session.flatMap(ClaudeStream.updates)
        #expect(updates.filter { if case .agentText = $0 { return true }; return false } == [.agentText("Hello"), .agentText("sub")])
        #expect(updates.contains(.usage(input: 3, output: 4)) && updates.contains(.modeChanged("plan")))
    }

    @Test func acpUpdatesFoldLikeAChatTurn() {
        var b = ChatTurnBuilder()
        let updates: [ACPUpdate] = [.agentThought("hmm"), .toolCall(id: "c1", title: "Bash(ls)", kind: "execute", status: "in_progress"),
                                    .toolCallUpdate(id: "c1", status: "in_progress", output: nil),
                                    .toolCallUpdate(id: "c1", status: "completed", output: "a.txt"),
                                    .plan(["☒ Read", "◐ Fix", "☐ Ship"]), .agentText("Do"), .agentText("ne"), .usage(input: 1, output: 2)]
        for u in updates { if let e = u.chatEvent { b.apply(e) } }
        b.apply(.result(text: "", sessionID: nil, costUSD: nil, isError: false))
        #expect(b.parts.map(\.kind) == [.thinking, .tool, .todos, .text])
        #expect(b.parts[1].output == "a.txt" && b.parts[1].detail == "ls" && b.parts[1].toolName == "Bash" && b.parts[1].status == .done)
        #expect(b.parts[2].todos.map(\.status) == [.completed, .inProgress, .pending])
        #expect(b.parts[2].todos.map(\.title) == ["Read", "Fix", "Ship"])
        #expect(b.text == "Done")
    }
}

@Suite struct SessionOrderTests {
    /// 1000 fast ACP updates from a background thread land in the session transcript in order
    /// (before: one `Task` per update, so lines could be stored swapped).
    @Test func thousandUpdatesKeepTheirOrder() async {
        let (runtime, sid) = await MainActor.run { () -> (HappierRuntime, RecordID) in
            let store = WorkspaceStore(persistence: nil, node: "t")
            let brain = BrainStore(store: store)
            let r = HappierRuntime(brain: brain, connections: nil, machineName: "test")
            return (r, brain.createSession(title: "S", agentID: "claude", machine: "test", cwd: "/tmp", encrypted: false))
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                for i in 0..<1000 { runtime.ingest(sid, .notice("n\(i)")) }
                c.resume()
            }
        }
        await runtime.mainQueue.drained()
        let md = await MainActor.run { runtime.brain.transcript(sid) }
        let seen = md.components(separatedBy: "\n").compactMap { line -> Int? in
            line.hasPrefix("n") ? Int(line.dropFirst()) : nil
        }
        #expect(seen == Array(0..<1000))
    }

    @Test func queueRunsAfterEverythingSentBefore() async {
        let q = MainActorQueue()
        let log = Locked<[Int]>([])
        for i in 0..<200 { q.send { log.sync { $0.append(i) } } }
        let n = await q.run { log.sync { $0.count } }
        #expect(n == 200)
        #expect(log.sync { $0 } == Array(0..<200))
    }
}
