import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Calls one tool with fixed arguments, then reports what the tool said (the nightly sorter in miniature).
private final class FilingProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    let calls: [(String, JSONValue)]
    init(_ calls: [(String, JSONValue)]) { self.calls = calls }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let done = messages.filter { $0.role == .tool }.count
        if done >= calls.count { return AIResponse(message: .assistant("Sorted: " + (messages.last?.content ?? ""))) }
        var m = ChatMessage.assistant("")
        m.toolCalls = [ToolCall(id: "c\(done)", name: calls[done].0, arguments: calls[done].1)]
        return AIResponse(message: m)
    }
}

/// BSD-63: Captures database, `capture` / `list_captures` / `file_capture`, and the sorter's filing rules.
@MainActor
struct CaptureTests {
    private func make() -> (WorkspaceStore, BrainStore, AgentTools) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        return (store, brain, AgentTools(store: store, brain: brain))
    }

    @Test func inputIsCheckedAndNormalised() throws {
        #expect(throws: CaptureInput.Problem.empty) { try CaptureInput(text: "  \n ").normalized() }
        #expect(throws: CaptureInput.Problem.badLink("ftp://x.org/a")) { try CaptureInput(text: "hi", link: "ftp://x.org/a").normalized() }
        #expect(throws: CaptureInput.Problem.tooLong(20_001)) { try CaptureInput(text: String(repeating: "a", count: 20_001)).normalized() }
        let shared = try CaptureInput(text: " https://example.com/post?id=1 ", source: .share).normalized()
        #expect(shared.text.isEmpty && shared.link == "https://example.com/post?id=1", "a shared URL as text becomes the link")
        let mixed = try CaptureInput(text: "Look at https://example.com later").normalized()
        #expect(mixed.link == nil && mixed.text.hasPrefix("Look"))
        #expect(try CaptureInput(audio: AssetRef(id: "a", name: "v.m4a")).normalized().audio != nil, "a voice note alone is enough")
        #expect(Capture.Source.parse("teilen") == .share && Capture.Source.parse("iphone") == .iPhone && Capture.Source.parse("x") == nil)
        let d = Date(timeIntervalSince1970: 0)
        #expect(CaptureInput.title(text: "First line\nsecond", link: nil, at: d) == "First line")
        #expect(CaptureInput.title(text: "", link: "https://www.notion.com/help", at: d) == "Link: www.notion.com")
        #expect(CaptureInput.title(text: "", link: nil, at: d).hasPrefix("Voice note "))
        #expect(CaptureInput.title(text: String(repeating: "x", count: 200), link: nil, at: d).count == 80)
    }

    @Test func captureToolCreatesDatabaseAndSorterOnce() async throws {
        let (_, brain, tools) = make()
        #expect(brain.existingCapturesDB == nil)
        let r = tools.call("capture", ["text": "Idea: EPUB export for Publit\nwith chapters", "source": "iphone"])
        #expect(!r.isError && r.text.contains("Sort captures"))
        let db = try #require(brain.existingCapturesDB)
        #expect(brain.store.protectedIDs.contains(brain.store.databases[db]!.blockID))
        let sorters = brain.agents().filter { $0.name == BrainStore.captureSorterName }
        #expect(sorters.count == 1 && sorters.first?.schedule == "daily 23:00")
        #expect(Schedule.parse("daily 23:00") != nil)
        // Edited by the user: a second database run must not overwrite it.
        brain.saveAgent(name: BrainStore.captureSorterName, instructions: "Mine", schedule: nil, model: nil)
        _ = tools.call("capture", ["url": "https://example.com", "text": ""])
        #expect(brain.agents().first { $0.name == BrainStore.captureSorterName }?.instructions == "Mine")

        let all = brain.captures()
        #expect(all.count == 2)
        let idea = try #require(all.first { $0.title.hasPrefix("Idea") })
        #expect(idea.source == .iPhone && idea.status == .new && idea.text.contains("with chapters"))
        #expect(all.first { $0.link == "https://example.com" }?.source == .agent)
        #expect(tools.call("capture", ["text": ""]).isError)
        let list = tools.call("list_captures", .object([:])).text
        #expect(list.contains("Idea: EPUB export") && list.contains("example.com"))
        #expect(tools.permissionCall("list_captures", .object([:])).category == .read)
        #expect(tools.permissionCall("file_capture", .object([:])).category == .edit)
    }

    @Test func voiceNotesWaitForTheirTranscript() throws {
        let (_, brain, tools) = make()
        let id = try brain.addCapture(CaptureInput(audio: AssetRef(id: "a1", name: "note.m4a", mime: "audio/mp4"), source: .watch))
        var c = try #require(brain.capture(id))
        #expect(c.needsTranscript && !c.isPending && c.audio?.asset?.id == "a1" && c.title.hasPrefix("Voice note"))
        #expect(tools.call("list_captures", .object([:])).text.contains("1 voice note(s) wait for a transcript"))
        brain.setTranscript(id, "Call Anna about the cover")
        c = try #require(brain.capture(id))
        #expect(c.status == .transcribed && c.isPending && c.title == "Call Anna about the cover")
        let direct = try brain.addCapture(CaptureInput(audio: AssetRef(id: "a2", name: "b.m4a"), transcript: "Buy milk", source: .iPhone))
        #expect(brain.capture(direct)?.status == .transcribed)
        #expect(brain.pendingCaptures().map(\.id) == [id, direct], "oldest first")
    }

    @Test func sorterFilesAPlanFromAFakeEngine() async throws {
        let (store, brain, _) = make()
        let publit = brain.createProject(name: "Publit", goal: "Publish books")
        let tasks = store.createDatabase(title: RichText("Tasks"), in: .workspace, inline: false, sampleRows: 0).databaseID
        let outside = store.createPage(title: RichText("Random notes"))
        var ids: [RecordID] = []
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        for (i, t) in ["EPUB export works with chapters", "Chapter outline for book two\n\n1. Intro\n2. Middle", "Call the printer",
                       "I prefer tea in the evening", "test", "Something vague", "Note for random page", "Left for tomorrow"].enumerated() {
            ids.append(try brain.addCapture(CaptureInput(text: t, capturedAt: base.addingTimeInterval(Double(i)))))
        }
        let plan = """
        Here is my plan:
        ```json
        [
          {"capture": "\(ids[0])", "action": "project", "target": "publit", "note": "progress"},
          {"capture": "\(ids[1])", "action": "new_page", "target": "Publit", "title": "Book two outline"},
          {"capture": "\(ids[2])", "action": "task", "title": "Call the printer about proofs"},
          {"capture": "\(ids[3])", "action": "memory", "title": "Drinks tea in the evening"},
          {"capture": "\(ids[4])", "action": "discard", "note": "test entry"},
          {"capture": "\(ids[5])", "action": "ask", "note": "Maybe Publit?"},
          {"capture": "\(ids[6])", "action": "page", "target": "\(outside)"},
          {"capture": "\(ids[0])", "action": "discard"},
          {"capture": "unknown", "action": "task"},
          {"capture": "\(ids[1])", "action": "fly"}
        ]
        ```
        """
        var asked = ""
        let out = try await CaptureSorter(brain: brain).run { system, user in
            #expect(system.contains("file_capture"))
            asked = user
            return plan
        }
        #expect(asked.contains("Publit: Publish books") && asked.contains("> Call the printer"))
        #expect(out.count == 7, "one action per known capture, duplicates and unknown ids dropped")

        #expect(brain.body(of: publit).contains("EPUB export works with chapters"))
        #expect(brain.capture(ids[0])?.status == .filed && brain.capture(ids[0])?.targetID == publit)

        let page = try #require(brain.capture(ids[1])?.targetID)
        #expect(store.blocks[page]?.title == "Book two outline" && store.blocks[page]?.parent == .block(publit))
        #expect(brain.body(of: page).contains("2. Middle") && brain.project(ofPage: page)?.id == publit)

        #expect(store.rows(of: tasks).map(\.title) == ["Call the printer about proofs"])
        #expect(brain.memories().contains { $0.title == "Drinks tea in the evening" })
        #expect(brain.capture(ids[4])?.status == .discarded && brain.capture(ids[4])?.text == "test", "discarded keeps its content")

        let inbox = brain.inbox()
        #expect(inbox.count == 2, "unsure + page outside a project")
        #expect(inbox.contains { $0.title.contains("Something vague") && $0.detail.contains("Maybe Publit?") && $0.kind == .review })
        #expect(inbox.contains { $0.title.contains("Note for random page") && $0.detail.contains("outside your projects") })
        #expect(brain.body(of: outside).isEmpty, "pages outside projects are never edited")
        #expect(brain.capture(ids[5])?.isPending == true && brain.capture(ids[5])?.note.hasPrefix("Waiting for you") == true)
        #expect(brain.capture(ids[7])?.status == .new, "left out of the plan → stays for the next pass")

        // Filed captures are not filed twice.
        let again = CaptureSorter(brain: brain).apply(CaptureAction(capture: ids[2], action: .task))
        #expect(again.result == .skipped("done"))
        #expect(store.rows(of: tasks).count == 1)
    }

    @Test func taskWithoutTaskDatabaseAsks() throws {
        let (_, brain, tools) = make()
        let id = try brain.addCapture(CaptureInput(text: "Renew passport"))
        let r = tools.call("file_capture", ["capture_id": .string(id), "action": "task"])
        #expect(!r.isError && r.text.contains("Asked"))
        #expect(brain.inbox().first?.detail.contains("no task database") == true)
        #expect(tools.call("file_capture", ["capture_id": .string(id), "action": "nope"]).isError)
        #expect(tools.call("file_capture", ["capture_id": "missing", "action": "discard"]).isError)
        #expect(CaptureSorter.parsePlan("no json here").isEmpty)
    }

    @Test func scheduledSorterFilesThroughTools() async throws {
        let (_, brain, tools) = make()
        brain.createProject(name: "Garden")
        let id = try brain.addCapture(CaptureInput(text: "Plant tulips in October", source: .iPhone))
        let reg = ModelRegistry()
        reg.register(FilingProvider([("list_captures", .object([:])),
                                     ("file_capture", ["capture_id": .string(id), "action": "project", "target": "Garden"])]))
        let agent = try #require(brain.agents().first { $0.name == BrainStore.captureSorterName })
        #expect(agent.instructions.contains("list_captures"))
        let o = await AgentRuntime(registry: reg, tools: tools).run(agent: agent, trigger: "schedule")
        #expect(o?.text.contains("added to Garden") == true)
        #expect(brain.capture(id)?.status == .filed)
        #expect(brain.body(of: brain.project(named: "Garden")!.id).contains("Plant tulips"))
    }
}
