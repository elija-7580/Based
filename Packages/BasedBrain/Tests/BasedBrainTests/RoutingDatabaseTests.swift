import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-97: Routing database, classifier time limit, and the runtime fallback chain.
private struct SlowClassifier: RouteClassifier {
    var delay: TimeInterval
    var answer: String?
    func classify(_ task: RouteTask, routes: [Route]) async -> String? {
        // Ignores cancellation on purpose: the router must not wait for it.
        let until = Date().addingTimeInterval(delay)
        while Date() < until { try? await Task.sleep(nanoseconds: 10_000_000) }
        return answer
    }
}

private struct FakeBackend: ChatBackend {
    var resumeKind: String? = nil
    let body: @Sendable (ChatRequest, @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply
    func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        try await body(request, emit)
    }
}

private struct Overloaded: Error, CustomStringConvertible { var description: String { "HTTP 529 overloaded" } }

@MainActor
@Suite struct RoutingDatabaseTests {
    @Test func targetTextRoundTrip() {
        #expect(RouteTarget.parse("claudeCode:sonnet@high") == .claude("sonnet", effort: "high"))
        #expect(RouteTarget.parse("api:@small") == .api("@small"))
        #expect(RouteTarget.parse("api:@strong@high") == .api("@strong", effort: "high"))
        #expect(RouteTarget.parse(" codex ") == .codex())
        #expect(RouteTarget.parse("codex@low") == .codex(effort: "low"))
        #expect(RouteTarget.parse("claude:haiku") == .claude("haiku"))
        #expect(RouteTarget.parse("api:anthropic/claude-haiku-4-5") == RouteTarget(.api, "anthropic/claude-haiku-4-5"))
        #expect(RouteTarget.parse("gpt") == nil)
        #expect(RouteTarget.parseList("claudeCode:sonnet@high, api:@small, codex") == [.claude("sonnet", effort: "high"), .api("@small"), .codex()])
        #expect(RouteTarget.parseList("codex, ???") == nil)
        for r in ModelRouter.defaultRoutes {
            for level in ComputeLevel.allCases {
                #expect(RouteTarget.parseList(RouteTarget.listText(r.candidates(level))) == r.candidates(level), "\(r.id) \(level)")
            }
        }
    }

    @Test func databaseIsSeededEditableAndForgiving() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        #expect(brain.routes().routes == ModelRouter.defaultRoutes, "no database yet → defaults, nothing created")
        #expect(brain.existingRoutingDB == nil)
        let db = brain.ensureRouting()
        #expect(brain.store.rows(of: db).count == ModelRouter.defaultRoutes.count)
        #expect(brain.routes().routes == ModelRouter.defaultRoutes)
        #expect(brain.store.protectedIDs.contains(brain.store.databases[db]!.blockID))
        // Second start: nothing added.
        brain.ensureRouting()
        #expect(brain.store.rows(of: db).count == ModelRouter.defaultRoutes.count)

        // Edit "Quick" → takes effect on the next read; break "Writing" → default chain + note.
        let quick = brain.store.rows(of: db).first { $0.title == "Quick" }!
        let write = brain.store.rows(of: db).first { $0.title == "Writing" }!
        let autoCol = brain.propID(db, "Auto")!
        brain.store.setValue(quick.id, autoCol, .text(RichText("codex@high")))
        brain.store.setValue(write.id, autoCol, .text(RichText("claude:sonnet, ???")))
        let (routes, notes) = brain.routes()
        #expect(routes.first { $0.id == "quick" }?.auto == [.codex(effort: "high")])
        #expect(routes.first { $0.id == "write" }?.auto == ModelRouter.defaultRoutes.first { $0.id == "write" }?.auto)
        #expect(notes.count == 1 && notes[0].contains("Writing"))
        let d = ModelRouter(routes: routes).decide(RouteTask(text: "Fasse das zusammen"), compute: .auto, registry: ModelRegistry(),
                                                   installed: [.codex], defaultModel: "")
        #expect(d.route?.id == "quick" && d.choice == .cli(ChatEngineSpec(kind: .codex, model: "", effort: "high")))
    }

    @Test func rowsWithoutGeneralOrIDStillRoute() {
        let (routes, notes) = BrainStore.routes(fromRows: [
            (name: "My Code", id: "", description: "", low: "", auto: "codex", high: ""),
            (name: "Dup", id: "my-code", description: "", low: "", auto: "claude", high: ""),
        ])
        #expect(notes.isEmpty)
        #expect(routes.map(\.id) == ["my-code", "general"])
        #expect(routes[0].auto == [.codex()] && routes[0].low == ModelRouter.defaultRoutes.first { $0.id == "general" }!.low)
    }

    @Test func slowClassifierFallsBackToGeneral() async {
        let task = RouteTask(text: "Lass uns über die Planung für nächstes Jahr reden und Ideen sammeln")
        let start = Date()
        let d = await ModelRouter().route(task, compute: .auto, classifier: SlowClassifier(delay: 2, answer: "research"), timeout: 0.2,
                                          registry: ModelRegistry(), installed: [.claudeCode], defaultModel: "")
        #expect(Date().timeIntervalSince(start) < 1.5, "the router does not wait for the classifier")
        #expect(d.route?.id == "general" && d.reason.contains("too slow"))
        let fast = await ModelRouter().route(task, compute: .auto, classifier: SlowClassifier(delay: 0, answer: "research"), timeout: 1,
                                             registry: ModelRegistry(), installed: [.claudeCode], defaultModel: "")
        #expect(fast.route?.id == "research")
    }

    @Test func overloadedFirstEngineFallsBackWithNotice() async {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let sid = brain.createSession(title: "Chat", agentID: "based", machine: "mac", cwd: "", encrypted: false)
        let first = FakeBackend(resumeKind: "claude") { _, emit in
            emit(.started(model: "sonnet", sessionID: "dead"))
            throw Overloaded()
        }
        let second = FakeBackend(resumeKind: "codex") { req, emit in
            #expect(req.resume == nil)
            emit(.started(model: nil, sessionID: "cx1"))
            emit(.text("Answer from Codex"))
            return ChatReply(text: "Answer from Codex", sessionID: "cx1")
        }
        let backend = FallbackChatBackend([.init(label: "Claude Code", backend: first), .init(label: "Codex", backend: second)])
        let turn = ChatEngine(sink: brain).send(ChatRequest(prompt: "hi", displayPrompt: "hi", resume: "old"), session: sid, via: backend)
        var b = ChatTurnBuilder()
        for await e in turn.events { b.apply(e) }
        await turn.finished()
        #expect(b.text == "Answer from Codex" && !b.isError)
        #expect(b.notices.count == 1 && b.notices[0].hasPrefix("Claude Code failed") && b.notices[0].hasSuffix("answered by Codex"))
        #expect(b.sessionID == "cx1", "the failed engine's session is dropped")
        #expect(brain.resumeKey(sid) == "codex:cx1")
        let items = TranscriptParser.parse(brain.transcript(sid))
        #expect(items.contains { $0.kind == .notice && $0.text.contains("answered by Codex") })
        #expect(brain.sessions().first { $0.id == sid }?.status == .done)
    }

    @Test func errorAfterOutputDoesNotFallBack() async {
        let first = FakeBackend { _, emit in emit(.textDelta("Hal")); throw Overloaded() }
        let second = FakeBackend { _, _ in Issue.record("must not run"); return ChatReply() }
        let backend = FallbackChatBackend([.init(label: "A", backend: first), .init(label: "B", backend: second)])
        await #expect(throws: Overloaded.self) { try await backend.run(ChatRequest(prompt: "x"), session: "s", emit: { _ in }) }
        // All fail → the error names every engine.
        let both = FallbackChatBackend([.init(label: "A", backend: FakeBackend { _, _ in throw Overloaded() }),
                                        .init(label: "B", backend: FakeBackend { _, emit in emit(.result(text: "not logged in", sessionID: nil, costUSD: nil, isError: true)); return ChatReply() })])
        let events = Locked<[ChatEvent]>([])
        _ = try? await both.run(ChatRequest(prompt: "x"), session: "s", emit: { e in events.sync { $0.append(e) } })
        #expect(events.current.contains { if case .result(_, _, _, true) = $0 { return true }; return false }, "the last engine's error reaches the chat")
    }
}
