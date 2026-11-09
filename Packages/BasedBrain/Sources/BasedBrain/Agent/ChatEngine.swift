import Foundation
import BasedCore

// MARK: - ChatEngine (ADR 0005, BSD-45)
//
// One chat turn, for every engine: the backend (API tool loop, Claude Code, Codex, Gemini, OpenCode, a fake in
// tests) reports `ChatEvent`s through one serial emitter; `ChatEngine` folds them, saves finished parts while the
// turn is still running, stores the CLI session for resuming and hands the same events, in order, to the UI as an
// `AsyncStream`. The app only renders events and sends user input.

/// Everything a backend needs for one turn.
public struct ChatRequest: Sendable {
    /// The full prompt sent to the engine (with attachments and page context).
    public var prompt: String
    /// What the user typed, as saved in the transcript ("You"). nil = don't save a user entry.
    public var displayPrompt: String?
    /// Earlier turns (API models; CLIs resume their own session instead).
    public var history: [ChatMessage]
    /// The engine's own session to continue (CLI session id), if any.
    public var resume: String?
    /// Working folder for CLI engines.
    public var cwd: String
    /// Extra system prompt (CLI engines: appended to theirs).
    public var system: String

    public init(prompt: String, displayPrompt: String? = nil, history: [ChatMessage] = [], resume: String? = nil,
                cwd: String = NSHomeDirectory(), system: String = "") {
        self.prompt = prompt; self.displayPrompt = displayPrompt; self.history = history
        self.resume = resume; self.cwd = cwd; self.system = system
    }
}

/// How a backend's turn ended (events carry the content; this is the bookkeeping).
public struct ChatReply: Sendable, Equatable {
    public var text: String
    /// The engine's session id, stored so the next turn can resume it.
    public var sessionID: String?
    public var costUSD: Double?
    public init(text: String = "", sessionID: String? = nil, costUSD: Double? = nil) {
        self.text = text; self.sessionID = sessionID; self.costUSD = costUSD
    }
}

/// One engine adapter. `run` reports everything through `emit`, from one task or thread at a time (the stream
/// must stay serial — ADR 0005), and returns when the turn is over. Cancelling the task stops the engine.
public protocol ChatBackend: Sendable {
    /// Prefix of the stored resume key ("claude", "codex", …); nil = the engine has no resumable session.
    var resumeKind: String? { get }
    func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply
}

/// Where a chat turn is saved. `BrainStore` (Sessions database) in the app; anything in tests.
@MainActor
public protocol ChatTranscriptSink: AnyObject {
    func appendTranscript(_ session: RecordID, role: String, markdown: String)
    func chatStatus(_ session: RecordID, status: AgentSession.Status, result: String?)
    func resumeKey(_ session: RecordID) -> String?
    func setResumeKey(_ session: RecordID, _ key: String)
}

extension BrainStore: ChatTranscriptSink {
    public func appendTranscript(_ session: RecordID, role: String, markdown: String) {
        appendTranscript(session, role: role, markdown: markdown, cipher: nil)
    }
    public func chatStatus(_ session: RecordID, status: AgentSession.Status, result: String?) {
        updateSession(session, status: status, result: result)
    }
    public func resumeKey(_ session: RecordID) -> String? {
        sessions().first { $0.id == session }?.acpSessionID
    }
    public func setResumeKey(_ session: RecordID, _ key: String) {
        updateSession(session, acpSessionID: key)
    }
}

/// A running turn: its events (in engine order) and a way to stop it. Stopping still delivers the rest of the
/// turn's events, ending with `.failed("Stopped.")`.
public struct ChatTurnHandle: Sendable {
    public let events: AsyncStream<ChatEvent>
    private let task: Task<Void, Never>
    init(events: AsyncStream<ChatEvent>, task: Task<Void, Never>) { self.events = events; self.task = task }
    public func cancel() { task.cancel() }
    /// Waits until the turn is saved.
    public func finished() async { await task.value }
}

@MainActor
public final class ChatEngine {
    public let sink: ChatTranscriptSink

    public init(sink: ChatTranscriptSink) { self.sink = sink }

    /// The CLI session to continue for this chat with an engine of `kind`, from the stored "<kind>:<id>" key.
    /// Switching the engine starts a fresh CLI session. Old chats stored Claude sessions as "claude:<id>".
    public static func resume(stored: String?, kind: String?) -> String? {
        guard let stored, let kind, !kind.isEmpty else { return nil }
        let prefix = kind + ":"
        return stored.hasPrefix(prefix) ? String(stored.dropFirst(prefix.count)) : nil
    }

    /// Resume id for `session` with `backend` (nil when the chat ran on another engine before).
    public func resume(for session: RecordID, with backend: ChatBackend) -> String? {
        Self.resume(stored: sink.resumeKey(session), kind: backend.resumeKind)
    }

    /// One prompt, one answer, nothing saved (inline AI, meeting summaries): the answer's text blocks joined,
    /// collected synchronously from the emitter so none can arrive after the backend returned.
    public nonisolated static func text(from backend: ChatBackend, _ request: ChatRequest) async throws -> String {
        let texts = Locked<[String]>([])
        let r = try await backend.run(request, session: "", emit: { e in
            if case .text(let t) = e { texts.sync { $0.append(t) } }
        })
        let joined = texts.current.joined(separator: "\n\n")
        return joined.isEmpty ? r.text : joined
    }

    /// Runs one turn of `session`. The user message is saved first; finished parts are saved as soon as the next
    /// part starts (a crash or quit mid-answer keeps them); the rest, the status and the resume key at the end.
    public func send(_ request: ChatRequest, session: RecordID, via backend: ChatBackend) -> ChatTurnHandle {
        let sink = self.sink
        if let shown = request.displayPrompt { sink.appendTranscript(session, role: "You", markdown: shown) }
        sink.chatStatus(session, status: .running, result: nil)
        let (out, outCont) = AsyncStream.makeStream(of: ChatEvent.self, bufferingPolicy: .unbounded)
        let task = Task { @MainActor in
            let turn = ChatTurnSaver(session: session, sink: sink)
            let (raw, rawCont) = AsyncStream.makeStream(of: ChatEvent.self, bufferingPolicy: .unbounded)
            let outcome: Result<ChatReply, Error> = await withTaskGroup(of: Result<ChatReply, Error>?.self) { group in
                group.addTask {
                    defer { rawCont.finish() }
                    do { return .success(try await backend.run(request, session: session, emit: { rawCont.yield($0) })) }
                    catch { return .failure(error) }
                }
                group.addTask { @MainActor in
                    for await e in raw {
                        turn.apply(e)
                        outCont.yield(e)
                    }
                    return nil
                }
                var r: Result<ChatReply, Error> = .failure(CancellationError())
                for await x in group { if let x { r = x } }
                return r
            }
            let stopped = Task.isCancelled
            switch outcome {
            case .success(let reply) where !stopped:
                if let s = reply.sessionID ?? turn.builder.sessionID, let kind = backend.resumeKind {
                    sink.setResumeKey(session, kind + ":" + s)
                }
                if !turn.sawResult {
                    let e = ChatEvent.result(text: reply.text.isEmpty && turn.builder.text.isEmpty ? "(done)" : reply.text,
                                             sessionID: reply.sessionID, costUSD: reply.costUSD, isError: false)
                    turn.apply(e); outCont.yield(e)
                }
                turn.save(all: true)
                sink.chatStatus(session, status: turn.builder.isError ? .failed : .done, result: turn.builder.text)
            default:
                var message = "Stopped."
                if !stopped, case .failure(let error) = outcome, !(error is CancellationError) { message = "⚠️ \(error)" }
                let e = ChatEvent.failed(message)
                turn.apply(e); outCont.yield(e)
                turn.save(all: true)
                sink.appendTranscript(session, role: "Error", markdown: message.hasPrefix("⚠️ ") ? String(message.dropFirst("⚠️ ".count)) : message)
                sink.chatStatus(session, status: .failed, result: turn.builder.text)
                Log.error("Chat failed: \(message)", category: "ai")
            }
            outCont.finish()
        }
        outCont.onTermination = { reason in
            if case .cancelled = reason { task.cancel() }
        }
        return ChatTurnHandle(events: out, task: task)
    }
}

/// Folds a turn's events and saves its parts in order: a part is written once it is finished and something
/// follows it. The to-do list keeps changing while the agent works, so saving pauses there until the end.
@MainActor
final class ChatTurnSaver {
    let session: RecordID
    let sink: ChatTranscriptSink
    private(set) var builder = ChatTurnBuilder()
    private(set) var saved = 0
    private(set) var sawResult = false

    init(session: RecordID, sink: ChatTranscriptSink) { self.session = session; self.sink = sink }

    func apply(_ e: ChatEvent) {
        if case .result = e { sawResult = true }
        builder.apply(e)
        save(all: false)
    }

    func save(all: Bool) {
        let parts = builder.parts
        var end = saved
        while end < parts.count {
            let p = parts[end]
            if !all, end == parts.count - 1 || p.status == .running || p.provisional || p.kind == .todos { break }
            end += 1
        }
        guard end > saved else { return }
        for (role, md) in ChatTurnBuilder.transcriptSections(of: parts[saved..<end]) {
            sink.appendTranscript(session, role: role, markdown: md)
        }
        saved = end
    }
}

/// Delivers values on the main actor in exactly the order they were sent, from any thread. Each send schedules
/// a drain, and every drain takes all pending values in order — so it doesn't matter in which order the
/// scheduled tasks run (one `Task { @MainActor in … }` per event could swap deltas).
public final class OrderedMainActorRelay<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [Element] = []
    private let handler: @MainActor (Element) -> Void

    public init(_ handler: @escaping @MainActor (Element) -> Void) { self.handler = handler }

    @Sendable public func send(_ e: Element) {
        lock.lock(); pending.append(e); lock.unlock()
        Task { @MainActor in self.drain() }
    }

    @MainActor private func drain() {
        lock.lock(); let batch = pending; pending = []; lock.unlock()
        for e in batch { handler(e) }
    }
}

/// The chat's relay (BSD-45).
public typealias MainActorRelay = OrderedMainActorRelay<ChatEvent>

/// Main-actor work from any thread, run strictly in submission order (BSD-94: session transcripts and status
/// updates of `HappierRuntime`, which used one `Task` per update and could store lines out of order).
public final class MainActorQueue: Sendable {
    public typealias Job = @MainActor @Sendable () -> Void
    private let relay = OrderedMainActorRelay<Job> { job in job() }
    public init() {}

    /// Queues `job` behind everything sent before.
    @Sendable public func send(_ job: @escaping Job) { relay.send(job) }

    /// Runs `body` after everything queued before it and returns its result.
    public func run<R: Sendable>(_ body: @escaping @MainActor @Sendable () -> R) async -> R {
        await withCheckedContinuation { (c: CheckedContinuation<R, Never>) in
            relay.send { c.resume(returning: body()) }
        }
    }

    /// Waits until everything queued so far has run.
    public func drained() async { await run { () } }
}

// MARK: - Backends

/// API models (Anthropic, OpenAI-compatible, on device) through the `AgentRuntime` tool loop.
public struct ModelChatBackend: ChatBackend {
    public let runtime: AgentRuntime
    public let modelRef: String
    public init(runtime: AgentRuntime, modelRef: String) { self.runtime = runtime; self.modelRef = modelRef }
    public var resumeKind: String? { nil }
    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        let o = try await runtime.run(prompt: request.prompt, modelRef: modelRef, history: request.history,
                                      callerSession: session, events: emit)
        try Task.checkCancellation()
        return ChatReply(text: o.text)
    }
}

/// Claude Code (`claude -p --output-format stream-json`), with the Based MCP server when `mcpConfig` is set.
public struct ClaudeCodeChatBackend: ChatBackend {
    public var spec: ChatEngineSpec
    public var mcpConfig: JSONValue?
    public init(spec: ChatEngineSpec, mcpConfig: JSONValue?) { self.spec = spec; self.mcpConfig = mcpConfig }
    public var resumeKind: String? { "claude" }
    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        let r = await ClaudePrint.stream(request.prompt, resume: request.resume, cwd: request.cwd,
                                         appendSystemPrompt: request.system.isEmpty ? nil : request.system, mcpConfig: mcpConfig,
                                         allowedTools: mcpConfig == nil ? [] : ["mcp__based"],
                                         model: spec.model.isEmpty ? nil : spec.model,
                                         effort: spec.effort.isEmpty ? nil : spec.effort,
                                         permissionMode: spec.permission.isEmpty ? nil : spec.permission,
                                         permissionPromptTool: mcpConfig != nil && spec.permission != "bypassPermissions" ? "mcp__based__approval" : nil,
                                         emit: emit)
        switch r {
        case .success(let reply): return ChatReply(text: reply.text, sessionID: reply.sessionID, costUSD: reply.costUSD)
        case .failure(let e): throw e
        }
    }
}

/// Codex / Gemini CLI / OpenCode through `CLIChatRunner` with the matching line parser.
public struct CLIChatBackend: ChatBackend {
    public var spec: ChatEngineSpec
    /// Based MCP endpoint for this chat (Codex), as (url, token).
    public var mcp: (url: String, token: String)?
    public init(spec: ChatEngineSpec, mcp: (url: String, token: String)?) { self.spec = spec; self.mcp = mcp }
    public var resumeKind: String? { spec.kind.rawValue }

    struct NotAvailable: Error, CustomStringConvertible { let description: String }

    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        #if os(macOS) || os(Linux)
        guard let cmd = spec.kind.command else { throw NotAvailable(description: "No chat CLI selected.") }
        let exe = ShellEnvironment.which(cmd)
            ?? (spec.kind == .opencode ? "/Applications/OpenCode.app/Contents/MacOS/opencode-cli" : nil)
        guard let exe, FileManager.default.isExecutableFile(atPath: exe) else {
            throw ClaudePrint.Failure(description: "\(spec.kind.title) is not installed.")
        }
        var env = ShellEnvironment.environment()
        let args: [String]
        let parse: @Sendable (String) -> [ChatEvent]
        switch spec.kind {
        case .codex:
            if let mcp { env["BASED_MCP_TOKEN"] = mcp.token }
            args = CLIChatArguments.codex(prompt: request.prompt, spec: spec, resume: request.resume, mcpURL: mcp?.url, systemPrompt: request.system)
            parse = CodexChatStream.events(fromLine:)
        case .gemini:
            args = CLIChatArguments.gemini(prompt: request.prompt, spec: spec, resume: request.resume, systemPrompt: request.system)
            parse = GeminiChatStream.events(fromLine:)
        case .opencode:
            args = CLIChatArguments.opencode(prompt: request.prompt, spec: spec, resume: request.resume, systemPrompt: request.system)
            parse = OpenCodeChatStream.events(fromLine:)
        default:
            throw NotAvailable(description: "\(spec.kind.title) is not a chat CLI.")
        }
        let dir = FileManager.default.fileExists(atPath: request.cwd) ? request.cwd : NSHomeDirectory()
        let r = await CLIChatRunner.run(executable: exe, arguments: args, environment: env, cwd: dir, parse: parse, emit: emit)
        switch r {
        case .success(let reply): return ChatReply(text: reply.text, sessionID: reply.sessionID, costUSD: reply.costUSD)
        case .failure(let e): throw e
        }
        #else
        throw NotAvailable(description: "Coding-agent CLIs run on the Mac or a Based server.")
        #endif
    }
}

/// A backend that fails with a message (no engine configured).
public struct UnavailableChatBackend: ChatBackend {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var resumeKind: String? { nil }
    struct Failure: Error, CustomStringConvertible { let description: String }
    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        throw Failure(description: message)
    }
}
