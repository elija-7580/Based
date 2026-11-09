import Testing
import Foundation
@testable import BasedBrain

/// BSD-96: coding sessions render through `ChatTurnBuilder` / `ChatPart` like the chat.
@Suite struct SessionChatPartsTests {
    @Test func liveSessionUpdatesBecomePartsInOrder() {
        var b = ChatTurnBuilder()
        let updates: [ACPUpdate] = [
            .agentThought("Look first"),
            .toolCall(id: "r1", title: "Read(/src/App.swift)", kind: "read", status: "in_progress"),
            .toolCallUpdate(id: "r1", status: "completed", output: "import SwiftUI"),
            .toolCall(id: "e1", title: "Edit(/src/App.swift)", kind: "edit", status: "pending"),
            .diff(path: "/src/App.swift", old: "a\nb", new: "a\nc\nd"),
            .toolCallUpdate(id: "e1", status: "failed", output: "denied"),
            .plan(["[completed] Read", "[in_progress] Fix", "[pending] Test"]),
            .toolCall(id: "x1", title: "Bash(ls)", kind: "execute", status: "completed"),
            .agentText("All "), .agentText("done"),
            .usage(input: 3, output: 4), .modeChanged("plan"),
        ]
        for u in updates { b.apply(u) }
        #expect(b.parts.map(\.kind) == [.thinking, .tool, .tool, .todos, .tool, .text])
        let read = b.parts[1], edit = b.parts[2], bash = b.parts[4]
        #expect(read.toolName == "Read" && read.detail == "/src/App.swift" && read.status == .done && read.output == "import SwiftUI")
        // The diff is attached to its edit card, not a separate one.
        #expect(edit.toolName == "Edit" && edit.status == .failed && edit.diff != nil && edit.added == 2 && edit.removed == 1)
        #expect(b.parts[3].todos.map(\.status) == [.completed, .inProgress, .pending])
        #expect(b.parts[3].todos.map(\.title) == ["Read", "Fix", "Test"])
        // Arrived finished: not left spinning.
        #expect(bash.toolName == "Bash" && bash.detail == "ls" && bash.status == .done && bash.output == nil)
        #expect(b.parts[5].status == .running && b.text == "All done")
    }

    @Test func diffWithoutEditCallIsItsOwnCard() {
        var b = ChatTurnBuilder()
        b.apply(.toolCall(id: "c", title: "Bash(make)", kind: "execute", status: "in_progress"))
        b.apply(.diff(path: "/a.txt", old: "", new: "x"))
        b.apply(.diff(path: "/same.txt", old: "s", new: "s"))
        #expect(b.parts.count == 2)
        #expect(b.parts[1].toolName == "Edit" && b.parts[1].detail == "/a.txt" && b.parts[1].added == 1)
    }

    @Test func toolNamesFromKindsAndTitles() {
        #expect(SessionTool.normalize(kind: "execute", title: "Bash(ls -la)") == ("Bash", "ls -la"))
        #expect(SessionTool.normalize(kind: "edit", title: "Write(/x.md)") == ("Write", "/x.md"))
        #expect(SessionTool.normalize(kind: "other", title: "mcp__based__search(q)") == ("mcp__based__search", "q"))
        #expect(SessionTool.normalize(kind: "search", title: "Find files") == ("Grep", "Find files"))
        // Chat transcripts already carry real tool names.
        #expect(SessionTool.normalize(kind: "Read", title: "Sources/App.swift") == ("Read", "Sources/App.swift"))
        #expect(SessionTool.normalize(kind: nil, title: "") == ("Tool", ""))
        #expect(SessionTool.planLine("- [completed] Ship").status == "completed")
        #expect(SessionTool.planLine("- ◐ Fix") == ("Fix", "in_progress"))
        #expect(SessionTool.planLine("- [x] Done") == ("Done", "completed"))
    }

    @Test func savedSessionTranscriptGroupsIntoTurns() {
        let md = """
        **You**
        Fix the bug

        **Thought**
        Read first

        **Tool**
        `read` Read(/src/a.swift)

        **Tool result**
        ```
        let a = 1
        ```

        **Tool**
        `edit` Edit(/src/a.swift)

        **Diff**
        `/src/a.swift`
        ```diff
        @@ -1,1 +1,1 @@
        -let a = 1
        +let a = 2
        ```

        **Plan**
        - [completed] Read
        - [pending] Test

        **Agent**
        Fixed.

        **Notice**
        Model: opus

        **You**
        Thanks
        """
        let segs = SessionTranscript.segments(TranscriptParser.parse(md))
        guard segs.count == 4, case .user(let u) = segs[0], case .reply(_, let parts) = segs[1], case .line(let n) = segs[2],
              case .user(let u2) = segs[3] else { Issue.record("unexpected segments \(segs)"); return }
        #expect(u.text == "Fix the bug" && u2.text == "Thanks" && n.text == "Model: opus")
        #expect(parts.map(\.kind) == [.thinking, .tool, .tool, .todos, .text])
        #expect(parts[1].toolName == "Read" && parts[1].detail == "/src/a.swift" && parts[1].output == "let a = 1")
        #expect(parts[2].toolName == "Edit" && parts[2].diff != nil && parts[2].added == 1 && parts[2].removed == 1)
        #expect(parts[3].todos.map(\.status) == [.completed, .pending])
        #expect(Set(parts.map(\.id)).count == parts.count)
    }
}
