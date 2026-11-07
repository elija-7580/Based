import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Codex / Gemini / OpenCode streams → the same chat parts as Claude Code; engine specs and arguments.
struct CLIChatTests {
    /// Recorded from `codex exec --json` (codex-cli 0.166).
    let codexLines = [
        #"{"type":"thread.started","thread_id":"01a1b341"}"#,
        #"{"type":"turn.started"}"#,
        #"{"type":"item.completed","item":{"id":"item_r","type":"reasoning","text":"Planning the command"}}"#,
        #"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’m running the requested command."}}"#,
        #"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
        #"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}"#,
        #"{"type":"item.completed","item":{"id":"item_3","type":"todo_list","items":[{"text":"Fix","completed":true},{"text":"Test","completed":false}]}}"#,
        #"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Command output: hello."}}"#,
        #"{"type":"turn.completed","usage":{"input_tokens":45166,"output_tokens":120}}"#,
    ]

    @Test func codexStreamBuildsParts() {
        var b = ChatTurnBuilder()
        for l in codexLines { for e in CodexChatStream.events(fromLine: l) { b.apply(e) } }
        #expect(b.sessionID == "01a1b341")
        let kinds = b.parts.map(\.kind)
        #expect(kinds == [.thinking, .text, .tool, .todos, .text])
        let tool = b.parts[2]
        #expect(tool.toolName == "Bash")
        #expect(tool.output == "hello\n")
        #expect(tool.status == .done)
        #expect(b.parts[3].todos.map(\.status) == [.completed, .pending])
        #expect(b.text.contains("Command output: hello."))
        #expect(!b.isError)
    }

    @Test func codexFailure() {
        let e = CodexChatStream.events(fromLine: #"{"type":"turn.failed","error":{"message":"quota"}}"#)
        #expect(e == [.result(text: "quota", sessionID: nil, costUSD: nil, isError: true)])
        let f = CodexChatStream.events(fromLine: #"{"type":"item.completed","item":{"id":"x","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"failed"}}"#)
        #expect(f.last == .toolResult(id: "x", output: "", isError: true))
    }

    @Test func geminiStream() {
        let lines = [
            #"{"type":"init","session_id":"g1","model":"gemini-2.5-pro"}"#,
            #"{"type":"message","role":"user","content":"hi"}"#,
            #"{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"a.txt"}}"#,
            #"{"type":"tool_result","tool_id":"t1","status":"success","output":"abc"}"#,
            #"{"type":"message","role":"assistant","content":"Hel","delta":true}"#,
            #"{"type":"message","role":"assistant","content":"lo","delta":true}"#,
            #"{"type":"result","status":"success","stats":{}}"#,
        ]
        var b = ChatTurnBuilder()
        for l in lines { for e in GeminiChatStream.events(fromLine: l) { b.apply(e) } }
        #expect(b.model == "gemini-2.5-pro")
        #expect(b.parts.map(\.kind) == [.tool, .text])
        #expect(b.parts[0].toolName == "Read")
        #expect(b.text == "Hello")
        #expect(b.parts.allSatisfy { $0.status == .done })
    }

    @Test func openCodeStream() {
        let lines = [
            #"{"type":"step_start","sessionID":"o1","part":{}}"#,
            #"{"type":"tool_use","sessionID":"o1","part":{"callID":"c1","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a b"}}}"#,
            #"{"type":"text","sessionID":"o1","part":{"text":"Two files."}}"#,
        ]
        var b = ChatTurnBuilder()
        for l in lines { for e in OpenCodeChatStream.events(fromLine: l) { b.apply(e) } }
        #expect(b.sessionID == "o1")
        #expect(b.parts.map(\.kind) == [.tool, .text])
        #expect(b.parts[0].output == "a b")
    }

    @Test func specRoundTripAndLegacyValues() {
        let s = ChatEngineSpec(kind: .claudeCode, model: "opus", effort: "high", permission: "plan")
        #expect(ChatEngineSpec.decode(s.encoded) == s)
        #expect(ChatEngineSpec.decode("claude-code").kind == .claudeCode)
        #expect(ChatEngineSpec.decode("anthropic/claude-x") == ChatEngineSpec(kind: .api, model: "anthropic/claude-x"))
        #expect(ChatEngineSpec.decode(nil) == .auto)
        #expect(CLICatalog.label(s) == "Opus 5.5 · High")
    }

    @Test func codexArguments() {
        let spec = ChatEngineSpec(kind: .codex, model: "gpt-x", effort: "high", permission: "workspace-write")
        let a = CLIChatArguments.codex(prompt: "hi", spec: spec, resume: nil, mcpURL: "http://127.0.0.1:1/mcp", systemPrompt: "SYS")
        #expect(a.prefix(3) == ["exec", "--json", "--skip-git-repo-check"])
        #expect(a.contains("gpt-x") && a.contains("workspace-write"))
        #expect(a.contains("model_reasoning_effort=\"high\""))
        #expect(a.last?.hasPrefix("SYS") == true && a.last?.hasSuffix("hi") == true)
        let r = CLIChatArguments.codex(prompt: "again", spec: spec, resume: "t1", mcpURL: nil, systemPrompt: "SYS")
        #expect(r.prefix(3) == ["exec", "resume", "t1"])
        #expect(!r.contains("-s"))
        #expect(r.last == "again")
    }

    @Test func claudeStreamArguments() {
        let a = ClaudePrint.streamArguments(prompt: "p", model: "opus", effort: "max", permissionMode: "plan")
        #expect(a.contains("--effort") && a.contains("max"))
        #expect(a.contains("--permission-mode") && a.contains("plan"))
        #expect(a.contains("stream-json"))
    }

    @Test func codexModelsFromCache() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("codexhome-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        let json = #"{"models":[{"slug":"gpt-a","display_name":"GPT A","visibility":"list"},{"slug":"hidden","visibility":"hide"},{"slug":"codex-auto-review"}]}"#
        try json.write(to: home.appendingPathComponent(".codex/models_cache.json"), atomically: true, encoding: .utf8)
        try "model = \"gpt-a\"\n".write(to: home.appendingPathComponent(".codex/config.toml"), atomically: true, encoding: .utf8)
        let m = CLICatalog.models(for: .codex, home: home.path)
        #expect(m.map(\.id) == ["", "gpt-a"])
        #expect(m[0].detail.contains("gpt-a"))
    }
}

struct ToolDiffTests {
    @Test func editGetsDiff() {
        var b = ChatTurnBuilder()
        b.apply(.toolUse(id: "e1", name: "Edit", input: ["file_path": "/a.swift", "old_string": "let x = 1\nlet y = 2", "new_string": "let x = 10\nlet y = 2\nlet z = 3"]))
        let p = b.parts[0]
        #expect(p.diff?.contains("+let x = 10") == true)
        #expect(p.diff?.contains("-let x = 1") == true)
        #expect(p.added == 2 && p.removed == 1)
        b.apply(.toolUse(id: "w1", name: "Write", input: ["file_path": "/b.txt", "content": "a\nb"]))
        #expect(b.parts[1].added == 2 && b.parts[1].removed == 0)
        b.apply(.toolUse(id: "r1", name: "Read", input: ["file_path": "/b.txt"]))
        #expect(b.parts[2].diff == nil)
    }
}

@MainActor
struct InboxDetailTests {
    @Test func detailKeepsBodyWithoutProperties() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        _ = brain.ensureHappier()
        let id = brain.addInbox(title: "Read(/a/b.txt)", kind: .permission, sessionID: "s1",
                                detail: "Agent wants to run **read**: Read(/a/b.txt)\n\n```\n{\n  \"file_path\" : \"/a/b.txt\"\n}\n```",
                                options: [("allow_once", "Allow")])
        let item = brain.inbox().first { $0.id == id }
        #expect(item?.detail.contains("file_path") == true)
        #expect(item?.detail.contains("Status:") == false)
    }
}
