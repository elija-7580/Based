import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Pass 18: Claude-style chat events → parts (thinking, text, tool cards, to-dos) and back from transcripts.
struct ChatStreamTests {
    let lines = [
        #"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus","tools":["Read"]}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"look."}}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me look."}]}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/a.swift"}}]}}"#,
        #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"let x = 1"}]}]}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"TodoWrite","input":{"todos":[{"content":"Fix bug","status":"in_progress","activeForm":"Fixing bug"},{"content":"Test","status":"pending"}]}}]}}"#,
        #"{"type":"assistant","parent_tool_use_id":"t9","message":{"content":[{"type":"text","text":"sub-agent noise"}]}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"**Done** "}}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"text","text":"**Done** — fixed."}]}}"#,
        #"{"type":"result","subtype":"success","result":"**Done** — fixed.","session_id":"s1","total_cost_usd":0.012,"is_error":false}"#,
    ]

    @Test func streamJSONBuildsParts() {
        var b = ChatTurnBuilder()
        for l in lines { for e in ClaudeChatStream.events(fromLine: l) { b.apply(e) } }
        #expect(b.sessionID == "s1" && b.model == "claude-opus")
        #expect(b.parts.map(\.kind) == [.thinking, .tool, .todos, .text])
        #expect(b.parts[0].text == "Let me look." && b.parts[0].status == .done)
        #expect(b.parts[1].toolName == "Read" && b.parts[1].detail == "/tmp/a.swift" && b.parts[1].output == "let x = 1")
        #expect(b.parts[2].todos.map(\.status) == [.inProgress, .pending])
        #expect(b.parts[2].todos[0].activeForm == "Fixing bug")
        #expect(b.text == "**Done** — fixed.", "the finished block replaces the streamed one; sub-agent text is skipped")
        #expect(b.costUSD == 0.012)
        #expect(!b.parts.contains { $0.status == .running })
    }

    @Test func taskToolsBuildTodoList() {
        var b = ChatTurnBuilder()
        b.apply(.toolUse(id: "a", name: "TaskCreate", input: ["subject": "Write tests", "activeForm": "Writing tests"]))
        b.apply(.toolUse(id: "b", name: "TaskCreate", input: ["subject": "Ship"]))
        b.apply(.toolUse(id: "c", name: "TaskUpdate", input: ["taskId": "1", "status": "completed"]))
        #expect(b.parts.count == 1)
        #expect(b.parts[0].todos.map(\.title) == ["Write tests", "Ship"])
        #expect(b.parts[0].todos.map(\.status) == [.completed, .pending])
    }

    @Test func transcriptRoundTrip() {
        var b = ChatTurnBuilder()
        for l in lines { for e in ClaudeChatStream.events(fromLine: l) { b.apply(e) } }
        let md = b.transcriptSections.map { "**\($0.role)**\n\n\($0.markdown)" }.joined(separator: "\n\n")
        let parts = ChatTurnBuilder.parts(from: TranscriptParser.parse(md))
        #expect(parts.map(\.kind) == [.thinking, .tool, .todos, .text])
        #expect(parts[1].toolName == "Read" && parts[1].output == "let x = 1")
        #expect(parts[2].todos.map(\.title) == ["Fix bug", "Test"])
    }

    @Test func linesSplitAcrossChunks() {
        var buf = Data("{\"a\":1}\n{\"b\"".utf8)
        #expect(ClaudeChatStream.takeLines(&buf) == ["{\"a\":1}"])
        buf.append(Data(":2}\n".utf8))
        #expect(ClaudeChatStream.takeLines(&buf) == ["{\"b\":2}"])
        #expect(buf.isEmpty)
    }

    @Test func streamArgumentsUseStreamJSON() {
        let a = ClaudePrint.streamArguments(prompt: "hi")
        #expect(a.contains("stream-json") && a.contains("--include-partial-messages") && a.contains("--verbose"))
        #expect(!a.contains("json"))
    }
}

struct ChatArtifactTests {
    @Test func extractsPreviewableBlocks() {
        let md = """
        Here you go:

        ```html
        <!doctype html>
        <html><head><title>Budget</title></head>
        <body>
        <h1>Budget</h1>
        <p>…</p>
        </body></html>
        ```

        Small example: ```css``` inline is ignored.

        ```html
        <b>hi</b>
        ```

        ```jsx
        import { useState } from "react";
        export default function Counter() {
          const [n, setN] = useState(0);
          return <button onClick={() => setN(n + 1)}>{n}</button>;
        }
        ```
        """
        let a = ChatArtifact.extract(md)
        #expect(a.map(\.kind) == [.html, .react], "the 1-line HTML snippet stays a code block")
        #expect(a[0].title == "Budget")
        #expect(a[1].title == "Counter")
        #expect(a[1].document.contains("React.createElement(Counter)"))
        #expect(!a[1].document.contains("import { useState }"))
    }

    @Test func toolImagesAttachToTheirCard() {
        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        let line = #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","content":[{"type":"text","text":"Took screenshot"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":""# + png + #""}}]}]}}"#
        var b = ChatTurnBuilder()
        b.apply(.toolUse(id: "b1", name: "mcp__claude-in-chrome__computer", input: ["action": "screenshot"]))
        for e in ClaudeChatStream.events(fromLine: line) { b.apply(e) }
        #expect(b.parts[0].output == "Took screenshot")
        #expect(b.parts[0].images == [Data([0x89, 0x50, 0x4E, 0x47])])
    }
}
