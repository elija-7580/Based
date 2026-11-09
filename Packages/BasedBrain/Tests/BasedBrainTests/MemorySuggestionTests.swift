import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Fake small model: records prompts, answers with a fixed JSON text.
private final class MemoryProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake"
    let models = ["claude-haiku-5-5"]
    let answer: String
    private let log = Locked<[String]>([])
    var prompts: [String] { log.current }
    init(_ answer: String) { self.answer = answer }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        log.sync { $0.append(messages.last?.content ?? "") }
        return AIResponse(message: .assistant(answer), usage: Usage(inputTokens: 10, outputTokens: 10))
    }
}

/// BSD-59: memories proposed from chats — only suggestions, saved after the user confirms.
@MainActor
struct MemorySuggestionTests {
    private func make(_ answer: String = #"{"memories": []}"#) -> (BrainStore, MemoryProvider, AgentRuntime) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let reg = ModelRegistry(); let p = MemoryProvider(answer); reg.register(p)
        return (brain, p, AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain)))
    }

    private func memory(_ id: String, _ title: String, _ body: String, _ kind: Memory.Kind = .Notes) -> Memory {
        Memory(id: id, title: title, kind: kind, body: body, updatedAt: Date())
    }

    @Test func parseCapsDeduplicatesAndFlagsSensitiveTopics() {
        let existing = [memory("m1", "Writing style", "Prefers short sentences.", .Preference),
                        memory("m2", "Project Based", "Native Notion alternative in SwiftUI.", .Work)]
        let answer = """
        Here you go:
        ```json
        {"memories": [
          {"title": "writing style", "type": "Preference", "body": "Likes German UI texts without anglicisms.", "sensitive": false},
          {"title": "Project Based", "type": "Work", "body": "Native Notion alternative in SwiftUI.", "sensitive": false},
          {"title": "Morning routine", "type": "profile", "body": "Works best before 9.", "sensitive": false},
          {"title": "Health", "type": "Profile", "body": "Has a mild gluten intolerance (Gesundheit).", "sensitive": false},
          {"title": "Coffee", "type": "Preference", "body": "Drinks flat whites.", "sensitive": false},
          {"title": "", "body": "no title"}
        ]}
        ```
        """
        let s = MemoryExtractor.parse(answer, existing: existing)
        #expect(s.count == 3, "at most three")
        #expect(s[0].updates == "m1" && s[0].title == "Writing style" && s[0].kind == .Preference, "similar title → update of the existing memory")
        #expect(!s.contains { $0.updates == "m2" }, "a fact the memory already has is dropped")
        #expect(s[1].title == "Morning routine" && s[1].kind == .Profile && s[1].updates == nil && !s[1].sensitive)
        #expect(s[2].title == "Health" && s[2].sensitive, "health is flagged even when the model did not")
        #expect(MemoryExtractor.parse("Nothing to remember.", existing: existing).isEmpty)
        #expect(MemoryExtractor.parse(#"[{"title": "Team", "type": "People", "body": "Works with Anna."}]"#, existing: []).first?.kind == .People)
        #expect(MemoryExtractor.similar("Project Based", "project: based") && !MemoryExtractor.similar("Coffee", "Writing style"))

        let (user, exchange) = MemoryExtractor.lastExchange("**You**\n\nold\n\n**Assistant**\n\nx\n\n**You**\n\nI live in Vienna and work on Based.\n\n**Assistant**\n\nNoted.")
        #expect(user == "I live in Vienna and work on Based.")
        #expect(exchange.hasPrefix("**You**") && exchange.contains("Noted.") && !exchange.contains("old"))
    }

    @Test func suggestionsWaitInTheInboxUntilTheUserConfirms() {
        let (brain, _, _) = make()
        let existing = brain.saveMemory(title: "Writing style", kind: .Preference, body: "Prefers short sentences.")
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "m", cwd: "/tmp", encrypted: false)
        let ids = brain.proposeMemories([
            MemorySuggestion(title: "Home town", kind: .Profile, body: "Lives in Vienna."),
            MemorySuggestion(title: "Writing style", kind: .Preference, body: "No anglicisms.", updates: existing),
            MemorySuggestion(title: "Health", kind: .Profile, body: "Gluten intolerance.", sensitive: true),
        ], session: sid)
        #expect(ids.count == 3)
        #expect(brain.memories().count == 1, "nothing saved before the user confirms")
        let items = brain.pendingMemorySuggestions()
        #expect(items.count == 3 && items.allSatisfy { $0.kind == .memory && $0.sessionID == sid })
        #expect(items.first { $0.id == ids[0] }?.title == "Remember: Home town")
        #expect(items.first { $0.id == ids[1] }?.title == "Update memory: Writing style")
        #expect(items.first { $0.id == ids[0] }?.options == ["save_memory=Save memory", "dismiss_memory=Dismiss"])
        // The page round-trips through the store's Markdown.
        let health = MemorySuggestion.parse(detail: items.first { $0.id == ids[2] }!.detail)
        #expect(health == MemorySuggestion(title: "Health", kind: .Profile, body: "Gluten intolerance.", sensitive: true))
        // The same proposal again is not added twice.
        #expect(brain.proposeMemories([MemorySuggestion(title: "Home town", kind: .Profile, body: "Lives in Vienna.")], session: sid).isEmpty)

        // Dismiss → nothing saved; save → new memory; update → appended to the existing one.
        #expect(brain.answerMemorySuggestion(ids[2], save: false) == nil)
        #expect(!brain.memories().contains { $0.title == "Health" })
        let home = brain.answerMemorySuggestion(ids[0], save: true, device: "mac")
        #expect(brain.memories().first { $0.id == home }?.body == "Lives in Vienna.")
        #expect(brain.memories().first { $0.id == home }?.kind == .Profile)
        #expect(brain.answerMemorySuggestion(ids[0], save: true) == nil, "first answer wins")
        #expect(brain.answerMemorySuggestion(ids[1], save: true) == existing)
        let style = brain.memories().first { $0.id == existing }!.body
        #expect(style.contains("Prefers short sentences.") && style.contains("No anglicisms."))
        #expect(brain.memories().count == 2)
        #expect(brain.pendingMemorySuggestions().isEmpty)
        #expect(brain.inbox().first { $0.id == ids[0] }?.decision == "save_memory · mac")
    }

    @Test func editedPageIsWhatGetsSaved() {
        let (brain, _, _) = make()
        let id = brain.proposeMemories([MemorySuggestion(title: "Team", kind: .People, body: "Works with Ana.")], session: nil)[0]
        // The user fixes the name on the item's page before saving.
        let page = MemorySuggestion(title: "Team", kind: .People, body: "Works with Anna (design).")
        brain.setBody(id, markdown: page.detail)
        let saved = brain.answerMemorySuggestion(id, save: true)
        #expect(brain.memories().first { $0.id == saved }?.body == "Works with Anna (design).")
    }

    @Test func runtimeProposesFromTheLastExchangeAndAgentsCannotAccept() async {
        let answer = #"{"memories": [{"title": "Home town", "type": "Profile", "body": "Lives in Vienna.", "sensitive": false}]}"#
        let (brain, provider, rt) = make(answer)
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "m", cwd: "/tmp", encrypted: false)
        brain.appendTranscript(sid, role: "You", markdown: "thanks")
        brain.appendTranscript(sid, role: "Assistant", markdown: "You're welcome.")
        #expect(await rt.suggestMemories(session: sid, modelRef: "fake/claude-haiku-5-5").isEmpty)
        #expect(provider.prompts.isEmpty, "short message → no model call")

        brain.saveMemory(title: "Writing style", kind: .Preference, body: "Short sentences.")
        brain.appendTranscript(sid, role: "You", markdown: "I moved to Vienna last year, please keep that in mind for events.")
        brain.appendTranscript(sid, role: "Assistant", markdown: "Got it.")
        let ids = await rt.suggestMemories(session: sid, modelRef: "fake/claude-haiku-5-5")
        #expect(ids.count == 1 && provider.prompts.count == 1)
        #expect(provider.prompts[0].contains("- Writing style (Preference)") && provider.prompts[0].contains("moved to Vienna"))
        #expect(!provider.prompts[0].contains("thanks"), "only the last exchange")
        #expect(brain.memories().count == 1, "still only a suggestion")

        // An agent (MCP / in-app tools) cannot save it; it may only dismiss.
        let tools = AgentTools(store: brain.store, brain: brain)
        var r = tools.call("resolve_inbox", ["item_id": .string(ids[0]), "option": "save_memory"])
        #expect(r.isError && r.text.contains("only when the user confirms"))
        r = tools.call("resolve_inbox", ["item_id": .string(ids[0]), "answer": "yes"])
        #expect(r.isError)
        #expect(brain.memories().count == 1 && brain.pendingMemorySuggestions().count == 1)
        r = tools.call("resolve_inbox", ["item_id": .string(ids[0]), "option": "dismiss_memory"])
        #expect(!r.isError && brain.pendingMemorySuggestions().isEmpty && brain.memories().count == 1)

        // Encrypted chats are never read.
        let enc = brain.createSession(title: "Secret", agentID: "based", machine: "m", cwd: "/tmp", encrypted: true)
        brain.appendBody(enc, markdown: "```based-encrypted\nAAAA\n```")
        #expect(await rt.suggestMemories(session: enc, modelRef: "fake/claude-haiku-5-5").isEmpty)
        #expect(provider.prompts.count == 1)
    }

    @Test func statusFollowsTheAnswer() {
        let (brain, _, _) = make()
        let ids = brain.proposeMemories([MemorySuggestion(title: "Home town", kind: .Profile, body: "Lives in Vienna."),
                                         MemorySuggestion(title: "Coffee", kind: .Preference, body: "Flat white.")], session: nil)
        // Dismiss → Rejected, save → Approved; only the saved one becomes a memory.
        #expect(brain.answerMemorySuggestion(ids[1], save: false, device: "web") == nil)
        #expect(brain.inbox().first { $0.id == ids[1] }?.status == .rejected)
        #expect(brain.answerMemorySuggestion(ids[0], save: true, device: "web") != nil)
        #expect(brain.inbox().first { $0.id == ids[0] }?.status == .approved)
        #expect(brain.memories().map(\.title) == ["Home town"])
    }
}
