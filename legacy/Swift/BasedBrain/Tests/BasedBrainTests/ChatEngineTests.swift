import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Backend driven by a closure; emits from a background thread like the CLI pipe readers do.
private struct FakeBackend: ChatBackend {
    var resumeKind: String? = nil
    let body: @Sendable (ChatRequest, @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply
    func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        try await body(request, emit)
    }
}

/// Answers "CHAT" to chat prompts and "SCHEDULED" to scheduler prompts; the chat's first step calls a tool.
private final class ScriptedProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake", models = ["m1"]
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        let prompt = messages.last { $0.role == .user }?.content ?? ""
        if prompt.hasPrefix("scheduled") {
            try await Task.sleep(nanoseconds: 2_000_000)
            return AIResponse(message: .assistant("SCHEDULED"))
        }
        if messages.last?.role == .tool { return AIResponse(message: .assistant("CHAT answer")) }
        var m = ChatMessage.assistant("Let me look.")
        m.toolCalls = [ToolCall(id: "c1", name: "no_such_tool", arguments: .object([:]))]
        return AIResponse(message: m)
    }
}

/// BSD-45 / ADR 0005: one ChatEvent stream for every engine, orchestrated by ChatEngine in BasedBrain.
@MainActor
struct ChatEngineTests {
    private func make() -> (BrainStore, RecordID) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "mac", cwd: "", encrypted: false)
        return (brain, sid)
    }

    private func items(_ brain: BrainStore, _ sid: RecordID) -> [TranscriptItem] { TranscriptParser.parse(brain.transcript(sid)) }

    @Test func thousandFastDeltasArriveInOrder() async {
        let (brain, sid) = make()
        let backend = FakeBackend { _, emit in
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().async {
                    for i in 0..<1000 { emit(.textDelta("\(i),")) }
                    c.resume()
                }
            }
            return ChatReply()
        }
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "go", displayPrompt: "go"), session: sid, via: backend)
        var deltas: [String] = []
        var builder = ChatTurnBuilder()
        for await e in turn.events {
            if case .textDelta(let d) = e { deltas.append(d) }
            builder.apply(e)
        }
        let expected = (0..<1000).map { "\($0)," }
        #expect(deltas == expected)
        #expect(builder.text == expected.joined())
        await turn.finished()
        let saved = items(brain, sid)
        #expect(saved.first?.kind == .user)
        #expect(saved.last?.text == expected.joined(), "the streamed answer is saved once, complete")
        #expect(brain.sessions().first { $0.id == sid }?.status == .done)
    }

    @Test func mainActorRelayKeepsOrderFromAnyThread() async {
        final class Box { var got: [Int] = [] }
        let box = Box()
        let relay = MainActorRelay { e in if case .textDelta(let d) = e { box.got.append(Int(d)!) } }
        DispatchQueue.global().async { for i in 0..<1000 { relay.send(.textDelta("\(i)")) } }
        for _ in 0..<500 where box.got.count < 1000 { try? await Task.sleep(nanoseconds: 5_000_000) }
        #expect(box.got == Array(0..<1000))
    }

    @Test func schedulerRunDuringChatDoesNotLeakIntoIt() async throws {
        let (brain, sid) = make()
        let registry = ModelRegistry()
        registry.register(ScriptedProvider())
        let runtime = AgentRuntime(registry: registry, tools: AgentTools(store: brain.store, brain: brain))
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "hello"), session: sid,
                                                via: ModelChatBackend(runtime: runtime, modelRef: "fake/m1"))
        // The scheduler shares the runtime and runs at the same time.
        async let scheduled = runtime.run(prompt: "scheduled job", modelRef: "fake/m1")
        var events: [ChatEvent] = []
        for await e in turn.events { events.append(e) }
        let s = try await scheduled
        #expect(s.text == "SCHEDULED")
        var builder = ChatTurnBuilder()
        for e in events { builder.apply(e) }
        #expect(!builder.text.contains("SCHEDULED"))
        #expect(builder.parts.contains { $0.kind == .tool && $0.toolName == "no_such_tool" })
        // Text next to a tool call and the final answer are both shown (the final one used to get lost).
        #expect(builder.text.contains("Let me look.") && builder.text.contains("CHAT answer"))
        await turn.finished()
        #expect(!brain.transcript(sid).contains("SCHEDULED"))
    }

    @Test func stoppingAfterThreePartsKeepsThem() async {
        let (brain, sid) = make()
        let backend = FakeBackend { _, emit in
            emit(.thinking("Plan it"))
            emit(.text("First answer"))
            emit(.toolUse(id: "t1", name: "Read", input: .object(["file_path": .string("/a.txt")])))
            emit(.toolResult(id: "t1", output: "contents", isError: false))
            emit(.textDelta("partial"))
            try await Task.sleep(nanoseconds: 60_000_000_000)
            return ChatReply()
        }
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "go", displayPrompt: "go"), session: sid, via: backend)
        var events: [ChatEvent] = []
        for await e in turn.events {
            events.append(e)
            if case .textDelta = e {
                // Mid-answer (as if the app quit now): the three finished parts are already saved.
                let saved = items(brain, sid).map(\.kind)
                #expect(saved == [.user, .thought, .agent, .tool], "\(saved)")
                turn.cancel()
            }
        }
        await turn.finished()
        #expect(events.last == .failed("Stopped."))
        let saved = items(brain, sid)
        #expect(saved.map(\.kind) == [.user, .thought, .agent, .tool, .agent, .error])
        #expect(saved[4].text == "partial")
        #expect(brain.sessions().first { $0.id == sid }?.status == .failed)
    }

    @Test func toDoListIsSavedAtItsPlaceWithItsLastState() async {
        let (brain, sid) = make()
        let backend = FakeBackend { _, emit in
            emit(.toolUse(id: "p1", name: "TodoWrite", input: .object(["todos": .array([
                .object(["content": .string("One"), "status": .string("pending")])])])))
            emit(.text("Working"))
            emit(.toolUse(id: "p2", name: "TodoWrite", input: .object(["todos": .array([
                .object(["content": .string("One"), "status": .string("completed")])])])))
            emit(.text("Done"))
            return ChatReply(text: "Done")
        }
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "go"), session: sid, via: backend)
        for await _ in turn.events {}
        await turn.finished()
        let saved = items(brain, sid)
        #expect(saved.first?.kind == .plan)
        #expect(saved.first?.text.contains("[x] One") == true, "the plan is saved with its final state")
        let md = brain.transcript(sid)
        #expect(md.components(separatedBy: "**Plan**").count == 2, "once")
        #expect(md.range(of: "**Plan**")!.lowerBound < md.range(of: "Working")!.lowerBound)
        #expect(md.range(of: "Working")!.lowerBound < md.range(of: "Done")!.lowerBound)
    }

    @Test func resumeKeyIsStoredPerEngine() async {
        let (brain, sid) = make()
        let engine = ChatEngine(sink: brain)
        let codex = FakeBackend(resumeKind: "codex") { _, emit in
            emit(.started(model: nil, sessionID: "abc"))
            emit(.text("hi"))
            return ChatReply(text: "hi")
        }
        #expect(engine.resume(for: sid, with: codex) == nil)
        let turn = engine.send(ChatRequest(prompt: "go"), session: sid, via: codex)
        for await _ in turn.events {}
        await turn.finished()
        #expect(brain.sessions().first { $0.id == sid }?.acpSessionID == "codex:abc")
        #expect(engine.resume(for: sid, with: codex) == "abc")
        #expect(engine.resume(for: sid, with: FakeBackend(resumeKind: "gemini") { _, _ in ChatReply() }) == nil,
                "switching the engine starts a fresh CLI session")
        #expect(ChatEngine.resume(stored: "claude:x1", kind: "claude") == "x1", "old chats keep resuming")
        #expect(ChatEngine.resume(stored: "claude:x1", kind: nil) == nil)
    }

    @Test func failureBecomesAnErrorNote() async {
        let (brain, sid) = make()
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "go", displayPrompt: "go"), session: sid,
                                                via: UnavailableChatBackend("No AI is configured."))
        var builder = ChatTurnBuilder()
        for await e in turn.events { builder.apply(e) }
        await turn.finished()
        #expect(builder.isError)
        #expect(builder.parts.last?.text == "⚠️ No AI is configured.")
        let saved = items(brain, sid)
        #expect(saved.map(\.kind) == [.user, .error])
        #expect(saved.last?.text == "No AI is configured.")
    }

    @Test func apiModelWithoutEventsStillAnswers() async {
        let (brain, sid) = make()
        let backend = FakeBackend { _, _ in ChatReply(text: "") }
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "go"), session: sid, via: backend)
        var builder = ChatTurnBuilder()
        for await e in turn.events { builder.apply(e) }
        #expect(builder.text == "(done)")
    }
}
