import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Records what the model was sent and answers with a fixed text.
private final class FakeProvider: AIProvider, @unchecked Sendable {
    let id: String
    let displayName: String
    let models: [String]
    var received: [[ChatMessage]] = []
    var receivedTools: [[ToolSpec]] = []
    init(id: String) { self.id = id; displayName = id; models = [id == "apple" ? "on-device" : "m1"] }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        received.append(messages); receivedTools.append(tools)
        return AIResponse(message: .assistant("Hi there!"))
    }
}

/// Pass 16: chat engine order, on-device chat path, Agent Brain self-repair.
@MainActor
struct Pass16BrainTests {
    @Test func cloudModelsBeatOnDevice() {
        let r = ModelRegistry()
        r.register(FakeProvider(id: "apple"))
        #expect(r.resolve("")?.0.id == "apple")
        #expect(!r.hasToolCapableProvider)
        r.register(FakeProvider(id: "openai"))
        // "apple" sorts before "openai" by id, but chat must prefer the tool-capable model.
        #expect(r.resolve("")?.0.id == "openai")
        #expect(r.byChatPreference.map(\.id) == ["openai", "apple"])
        #expect(r.hasToolCapableProvider)
        #expect(r.resolve("apple/on-device")?.0.id == "apple")
    }

    @Test func appleSplitSendsOnlyTheLatestMessageAsPrompt() {
        let msgs: [ChatMessage] = [.system("SYS"), .user("hi!"), .assistant("Hello"), .user("what up?")]
        let (instructions, prompt) = AppleIntelligenceProvider.split(msgs)
        #expect(prompt == "what up?")
        #expect(instructions.hasPrefix("SYS"))
        #expect(instructions.contains("User: hi!") && instructions.contains("You: Hello"))
        #expect(!instructions.contains("what up?"))
        // Huge system prompts are cut to fit the on-device window.
        let big = AppleIntelligenceProvider.split([.system(String(repeating: "x", count: 50_000)), .user("q")])
        #expect(big.instructions.count < 8_000)
    }

    @Test func onDeviceChatGetsCompactPromptAndNoTools() async throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        _ = brain.saveMemory(title: "Prefers short answers", kind: .Preference, body: "")
        let tools = AgentTools(store: store, brain: brain)
        let r = ModelRegistry()
        let apple = FakeProvider(id: "apple")
        r.register(apple)
        let rt = AgentRuntime(registry: r, tools: tools)
        let o = try await rt.run(prompt: "hi!", modelRef: nil)
        #expect(o.text == "Hi there!")
        #expect(apple.receivedTools == [[]], "no tool list for the on-device model")
        let system = apple.received[0].first { $0.role == .system }?.content ?? ""
        #expect(system.count < 3_000)
        #expect(!system.contains("load_skill"))
        #expect(apple.received[0].last?.content == "hi!")
    }

    @Test func brainPagesAreProtectedAndRepaired() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let skillsHost = store.databases[brain.skillsDB]!.blockID
        #expect(store.protectedIDs.contains(brain.rootID) && store.protectedIDs.contains(skillsHost))
        #expect(store.trashPages([skillsHost]).isEmpty)
        #expect(store.trashPages([brain.rootID]).isEmpty)

        // Trashed by an older build / another device (bypassing the guard) → repair brings it back.
        store.protectedIDs = []
        store.trash([skillsHost])
        #expect(store.isTrashed(skillsHost))
        #expect(brain.repair())
        #expect(!store.isTrashed(skillsHost))
        #expect(!brain.repair(), "nothing left to fix")

        // Gone for good → recreated.
        store.protectedIDs = []
        store.deleteForever([store.databases[brain.agentsDB]!.blockID])
        #expect(store.databases[brain.agentsDB] == nil)
        #expect(brain.repair())
        #expect(store.databases[brain.agentsDB] != nil)
    }
}
