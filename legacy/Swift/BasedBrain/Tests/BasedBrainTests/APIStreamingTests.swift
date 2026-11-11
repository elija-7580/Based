import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import BasedCore
@testable import BasedBrain

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

/// Splits data into chunks of `size` bytes (cuts lines, "\r\n" and multi-byte characters).
private func chunks(_ d: Data, size: Int) -> [Data] {
    stride(from: 0, to: d.count, by: size).map { d.subdata(in: $0..<min($0 + size, d.count)) }
}

/// Scripted HTTP: each request takes the next response; requests are recorded.
private final class FakeTransport: HTTPStreamTransport, @unchecked Sendable {
    enum Reply { case http(Int, [String: String], [Data], failAfter: Error? = nil), fail(Error) }
    let replies: Locked<[Reply]>
    let requests = Locked<[URLRequest]>([])
    init(_ replies: [Reply]) { self.replies = Locked(replies) }

    func send(_ request: URLRequest) async throws -> HTTPStreamResponse {
        requests.sync { $0.append(request) }
        let next = replies.sync { $0.isEmpty ? nil : $0.removeFirst() }
        switch next {
        case .fail(let e)?: throw e
        case .http(let status, let headers, let parts, let failAfter)?:
            let body = AsyncThrowingStream<Data, Error> { c in
                for p in parts { c.yield(p) }
                if let failAfter { c.finish(throwing: failAfter) } else { c.finish() }
            }
            return HTTPStreamResponse(status: status, headers: headers, body: body)
        case nil:
            throw URLError(.cannotConnectToHost)
        }
    }

    func body(_ i: Int) -> JSONValue? { requests.current[i].httpBody.flatMap { try? JSONValue.parse($0) } }
}

private final class EventLog: @unchecked Sendable {
    let events = Locked<[ChatEvent]>([])
    var emit: @Sendable (ChatEvent) -> Void { { e in self.events.sync { $0.append(e) } } }
    var all: [ChatEvent] { events.current }
}

private func instant() -> RetryPolicy {
    var p = RetryPolicy()
    p.jitter = { 0 }
    p.sleep = { _ in }
    return p
}

/// BSD-46: streaming, retry and continuing cut-off answers for the API models.
struct SSEParserTests {
    @Test func splitAnywhereGivesTheSameEvents() throws {
        let data = try fixture("anthropic-stream.sse")
        var whole = SSEParser()
        let expected = whole.feed(data) + whole.finish()
        #expect(expected.count == 17)
        #expect(expected[2] == SSEEvent(event: "ping", data: #"{"type":"ping"}"#))
        for size in [1, 2, 3, 7, 64] {
            var p = SSEParser()
            var got: [SSEEvent] = []
            for c in chunks(data, size: size) { got += p.feed(c) }
            got += p.finish()
            #expect(got == expected, "chunk size \(size)")
        }
    }

    @Test func crlfMultilineDataAndComments() {
        var p = SSEParser()
        let text = ": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata:x\n\ndata: tail"
        let got = p.feed(Data(text.utf8)) + p.finish()
        #expect(got == [SSEEvent(event: "a", data: "one\ntwo"), SSEEvent(data: "x"), SSEEvent(data: "tail")])
    }
}

struct AnthropicStreamingTests {
    private func provider(_ t: FakeTransport) -> AnthropicProvider {
        var p = AnthropicProvider(apiKey: "k")
        p.transport = t
        p.retry = instant()
        return p
    }

    @Test func streamsThinkingTextAndToolCall() async throws {
        let t = FakeTransport([.http(200, [:], chunks(try fixture("anthropic-stream.sse"), size: 5))])
        let log = EventLog()
        let r = try await provider(t).stream([.user("hi")], model: "claude-opus-5-5", tools: [], maxTokens: 1000, onEvent: log.emit)
        #expect(log.all == [.thinkingDelta("The user wants "), .thinkingDelta("a greeting."),
                            .textDelta("Grüß "), .textDelta("dich! Ich lese die Seite.")])
        #expect(r.thinking == "The user wants a greeting.")
        #expect(r.message.content == "Grüß dich! Ich lese die Seite.")
        #expect(r.message.toolCalls == [ToolCall(id: "toolu_01", name: "get_page", arguments: ["page_id": "p1"])])
        #expect(r.stopReason == "tool_use")
        #expect(r.usage == Usage(inputTokens: 25, outputTokens: 42))
        // Blocks are kept for replay in the tool loop, thinking with its signature.
        #expect(r.message.rawContent?[0]?["signature"]?.string == "EqQBCgIYAhIM")
        #expect(t.body(0)?["stream"] == true)
    }

    @Test func retriesOverloadAndRateLimitHonouringRetryAfter() async throws {
        let slept = Locked<[TimeInterval]>([])
        let t = FakeTransport([.http(429, ["retry-after": "2"], [Data("rate limited".utf8)]),
                               .http(529, [:], [Data(#"{"type":"error","error":{"type":"overloaded_error"}}"#.utf8)]),
                               .http(200, [:], [try fixture("anthropic-stream.sse")])])
        var p = provider(t)
        p.retry.sleep = { s in slept.sync { $0.append(s) } }
        let r = try await p.stream([.user("hi")], model: "claude-opus-5-5", tools: [], maxTokens: 1000) { _ in }
        #expect(r.message.content == "Grüß dich! Ich lese die Seite.")
        #expect(t.requests.current.count == 3)
        #expect(slept.current == [2, 2], "retry-after first, then backoff 1 s × 2¹")
    }

    @Test func givesUpAfterFourAttemptsAndNeverRetriesClientErrors() async {
        let t = FakeTransport(Array(repeating: .http(503, [:], [Data("busy".utf8)]), count: 6))
        await #expect(throws: AIError.self) {
            _ = try await provider(t).stream([.user("hi")], model: "m", tools: [], maxTokens: 10) { _ in }
        }
        #expect(t.requests.current.count == 4)
        let bad = FakeTransport([.http(400, [:], [Data("bad request".utf8)]), .http(200, [:], [])])
        do {
            _ = try await provider(bad).stream([.user("hi")], model: "m", tools: [], maxTokens: 10) { _ in }
            Issue.record("expected an error")
        } catch let AIError.http(code, body) {
            #expect(code == 400 && body == "bad request")
        } catch { Issue.record("\(error)") }
        #expect(bad.requests.current.count == 1)
    }

    @Test func networkDropBeforeFirstTokenIsRetriedButNotAfter() async throws {
        let ok = try fixture("anthropic-stream.sse")
        let t = FakeTransport([.fail(URLError(.networkConnectionLost)), .http(200, [:], [ok])])
        let r = try await provider(t).stream([.user("hi")], model: "m", tools: [], maxTokens: 10) { _ in }
        #expect(r.message.content.hasPrefix("Grüß"))
        // Cut after text was shown: no retry (it would repeat the text).
        let half = ok.prefix(ok.range(of: Data("dich!".utf8))!.upperBound + 40)
        let t2 = FakeTransport([.http(200, [:], [Data(half)], failAfter: URLError(.networkConnectionLost)), .http(200, [:], [ok])])
        let log = EventLog()
        await #expect(throws: URLError.self) {
            _ = try await provider(t2).stream([.user("hi")], model: "m", tools: [], maxTokens: 10, onEvent: log.emit)
        }
        #expect(t2.requests.current.count == 1)
        #expect(log.all.contains(.textDelta("Grüß ")))
    }

    @Test func overloadedEventMidStreamIsRetriedWhileNothingWasShown() async throws {
        let overloaded = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"content\":[],\"usage\":{\"input_tokens\":1}}}\n\nevent: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
        let t = FakeTransport([.http(200, [:], [Data(overloaded.utf8)]), .http(200, [:], [try fixture("anthropic-stream.sse")])])
        let r = try await provider(t).stream([.user("hi")], model: "m", tools: [], maxTokens: 10) { _ in }
        #expect(r.stopReason == "tool_use")
        #expect(t.requests.current.count == 2)
    }
}

struct OpenAIStreamingTests {
    private func provider(_ t: FakeTransport, base: String = "https://api.openai.com/v1", field: OpenAIProvider.TokenField = .auto) -> OpenAIProvider {
        var p = OpenAIProvider(apiKey: "k", baseURL: URL(string: base)!, tokenField: field)
        p.transport = t
        p.retry = instant()
        return p
    }

    @Test func streamsTextAndAssemblesToolCalls() async throws {
        let t = FakeTransport([.http(200, [:], chunks(try fixture("openai-stream.sse"), size: 11))])
        let log = EventLog()
        let r = try await provider(t).stream([.user("hi")], model: "gpt-4.1", tools: [], maxTokens: 100, onEvent: log.emit)
        #expect(log.all == [.textDelta("Hallo "), .textDelta("Welt.")])
        #expect(r.message.content == "Hallo Welt.")
        #expect(r.message.toolCalls == [ToolCall(id: "call_1", name: "search", arguments: ["query": "notes"])])
        #expect(r.stopReason == "tool_calls")
        #expect(r.usage == Usage(inputTokens: 12, outputTokens: 9))
        #expect(t.body(0)?["max_completion_tokens"]?.int == 100)
        #expect(t.body(0)?["stream_options"]?["include_usage"] == true)
    }

    @Test func tokenFieldFollowsTheHost() async throws {
        let sse = try fixture("openai-stream.sse")
        let ollama = FakeTransport([.http(200, [:], [sse])])
        _ = try await provider(ollama, base: "http://127.0.0.1:11434/v1").stream([.user("hi")], model: "llama3.1", tools: [], maxTokens: 50) { _ in }
        #expect(ollama.body(0)?["max_tokens"]?.int == 50)
        #expect(ollama.body(0)?["max_completion_tokens"] == nil)
        #expect(ollama.body(0)?["stream_options"] == nil, "older servers reject unknown stream options")
        #expect(OpenAIProvider.ollama().resolvedTokenField == "max_tokens")
        #expect(OpenAIProvider(apiKey: "k").resolvedTokenField == "max_completion_tokens")
        let forced = FakeTransport([.http(200, [:], [sse])])
        _ = try await provider(forced, base: "http://lmstudio.local/v1", field: .maxCompletionTokens).stream([.user("hi")], model: "x", tools: [], maxTokens: 7) { _ in }
        #expect(forced.body(0)?["max_completion_tokens"]?.int == 7)
    }

    @Test func rateLimitThenSuccess() async throws {
        let t = FakeTransport([.http(429, ["retry-after-ms": "1500"], []), .http(200, [:], [try fixture("openai-stream.sse")])])
        let slept = Locked<[TimeInterval]>([])
        var p = provider(t)
        p.retry.sleep = { s in slept.sync { $0.append(s) } }
        let r = try await p.stream([.user("hi")], model: "gpt-4.1", tools: [], maxTokens: 100) { _ in }
        #expect(r.message.content == "Hallo Welt.")
        #expect(slept.current == [1.5])
    }
}

/// Streams answers in pieces and stops with `max_tokens` until the script runs out.
private final class TruncatingProvider: AIProvider, @unchecked Sendable {
    let id = "trunc", displayName = "Trunc", models = ["m"]
    let script: Locked<[(String, String)]>
    let seen = Locked<[[ChatMessage]]>([])
    init(_ script: [(String, String)]) { self.script = Locked(script) }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        try await stream(messages, model: model, tools: tools, maxTokens: maxTokens) { _ in }
    }
    func stream(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int,
                onEvent: @escaping @Sendable (ChatEvent) -> Void) async throws -> AIResponse {
        seen.sync { $0.append(messages) }
        let (text, stop) = script.sync { $0.removeFirst() }
        onEvent(.thinkingDelta("hmm"))
        for w in text.split(separator: " ", omittingEmptySubsequences: false).enumerated().map({ $0.offset == 0 ? String($0.element) : " " + $0.element }) {
            onEvent(.textDelta(w))
        }
        return AIResponse(message: .assistant(text), usage: Usage(inputTokens: 1, outputTokens: 1), stopReason: stop, thinking: "hmm")
    }
}

@MainActor
struct ContinuationTests {
    private func run(_ p: TruncatingProvider) async throws -> (AgentRuntime.Outcome, [ChatEvent]) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let registry = ModelRegistry()
        registry.register(p)
        let rt = AgentRuntime(registry: registry, tools: AgentTools(store: store, brain: brain))
        let log = EventLog()
        let o = try await rt.run(prompt: "write", modelRef: "trunc/m", events: log.emit)
        return (o, log.all)
    }

    @Test func cutOffAnswerIsContinuedOnceIntoTheSameText() async throws {
        let p = TruncatingProvider([("Part one,", "max_tokens"), (" part two.", "end_turn")])
        let (o, events) = try await run(p)
        #expect(o.text == "Part one, part two.")
        #expect(o.usage == Usage(inputTokens: 2, outputTokens: 2))
        // The continuation asked to go on after the cut answer.
        let second = p.seen.current[1]
        #expect(second.suffix(2).map(\.role) == [.assistant, .user])
        #expect(second.last?.content.contains("Continue exactly where you stopped") == true)
        var b = ChatTurnBuilder()
        for e in events { b.apply(e) }
        #expect(b.parts.filter { $0.kind == .text }.map(\.text) == ["Part one, part two."], "one text part, not two")
        #expect(b.parts.filter { $0.kind == .thinking }.count == 1, "the continuation's thinking is not shown again")
        #expect(b.notices == ["The answer hit the length limit and was continued."])
        #expect(b.text == "Part one, part two.")
    }

    @Test func stillCutAfterOneContinuationIsMarked() async throws {
        let p = TruncatingProvider([("A", "max_tokens"), ("B", "length")])
        let (o, events) = try await run(p)
        #expect(o.text == "AB")
        #expect(p.seen.current.count == 2, "only one continuation")
        var b = ChatTurnBuilder()
        for e in events { b.apply(e) }
        #expect(b.notices.count == 2)
        #expect(b.notices.last == "The answer was cut off at the length limit.")
    }
}

/// The real URLSession transport (FoundationNetworking on Linux) with a stub protocol.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var chunks: [Data] = []
    nonisolated(unsafe) static var status = 200
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let r = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Retry-After": "3"])!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        for c in Self.chunks { client?.urlProtocol(self, didLoad: c) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct URLSessionTransportTests {
    @Test func deliversStatusHeadersAndBody() async throws {
        StubProtocol.chunks = chunks(try fixture("openai-stream.sse"), size: 100)
        StubProtocol.status = 200
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        var p = OpenAIProvider(apiKey: "k")
        p.transport = URLSessionStreamTransport(configuration: config)
        p.retry = instant()
        let log = EventLog()
        let r = try await p.stream([.user("hi")], model: "gpt-4.1", tools: [], maxTokens: 10, onEvent: log.emit)
        #expect(r.message.content == "Hallo Welt.")
        #expect(log.all.count == 2)
    }
}
