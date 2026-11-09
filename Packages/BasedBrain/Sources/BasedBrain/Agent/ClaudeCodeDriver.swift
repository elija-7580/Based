import Foundation
import BasedCore

/// A running coding agent, whatever the wire protocol (ACP adapter or Claude Code's own stream-json).
public protocol AgentConnection: AnyObject, Sendable {
    var sessionID: String? { get }
    var isRunning: Bool { get }
    func prompt(_ text: String, resources: [(uri: String, text: String)]) async throws -> ACPStopReason
    func cancel()
    func stop()
    /// PID of the agent's process while it runs (BSD-36: `HappierRuntime.stopAll` ends its whole process tree).
    var processID: Int32? { get }
}

public extension AgentConnection {
    var processID: Int32? { nil }
}

extension ACPClient: AgentConnection {}

/// One parsed line of `claude --output-format stream-json --verbose [--include-partial-messages]`.
/// BSD-94: the only parser for Claude Code's stream-json — sessions (`ClaudeCodeDriver`) use these events,
/// the chat (`ClaudeChatStream`) maps them to `ChatEvent`.
public enum ClaudeStreamEvent: Sendable, Equatable {
    case initialized(sessionID: String, model: String?, cwd: String?, permissionMode: String?, tools: [String])
    case text(String)
    case thinking(String)
    /// Partial output (`stream_event` / `content_block_delta`, only with `--include-partial-messages`).
    case textDelta(String)
    case thinkingDelta(String)
    case toolUse(id: String, name: String, input: JSONValue)
    case toolResult(id: String, output: String, isError: Bool)
    /// An image inside a tool result (screenshots of browser / computer use).
    case toolImage(id: String, data: Data, mediaType: String)
    case result(sessionID: String?, isError: Bool, text: String?, inputTokens: Int, outputTokens: Int, costUSD: Double?, turns: Int?)
    case other(String)
}

public enum ClaudeStream {
    /// Parses one JSON line into zero or more events. Lines of sub-agents (`parent_tool_use_id` set) are
    /// included unless `includeSubagents` is false (the chat shows them through the parent's tool card).
    public static func parse(line: String, includeSubagents: Bool = true) -> [ClaudeStreamEvent] {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), let v = try? JSONValue.parse(trimmed) else { return [] }
        if !includeSubagents, let parent = v["parent_tool_use_id"], !parent.isNull { return [] }
        switch v["type"]?.string ?? "" {
        case "system":
            if v["subtype"]?.string == "init" {
                return [.initialized(sessionID: v["session_id"]?.string ?? "", model: v["model"]?.string, cwd: v["cwd"]?.string,
                                     permissionMode: v["permissionMode"]?.string, tools: v["tools"]?.stringArray ?? [])]
            }
            return [.other(v["subtype"]?.string ?? "system")]
        case "stream_event":
            guard let ev = v["event"], ev["type"]?.string == "content_block_delta", let d = ev["delta"] else { return [] }
            switch d["type"]?.string {
            case "text_delta": return d["text"]?.string.map { [.textDelta($0)] } ?? []
            case "thinking_delta": return d["thinking"]?.string.map { [.thinkingDelta($0)] } ?? []
            default: return []
            }
        case "assistant":
            var out: [ClaudeStreamEvent] = []
            for item in v["message"]?["content"]?.array ?? [] {
                switch item["type"]?.string ?? "" {
                case "text": if let t = item["text"]?.string { out.append(.text(t)) }
                case "thinking": if let t = item["thinking"]?.string { out.append(.thinking(t)) }
                case "tool_use":
                    out.append(.toolUse(id: item["id"]?.string ?? "", name: item["name"]?.string ?? "tool", input: item["input"] ?? .object([:])))
                default: break
                }
            }
            return out
        case "user":
            var out: [ClaudeStreamEvent] = []
            for item in v["message"]?["content"]?.array ?? [] where item["type"]?.string == "tool_result" {
                let id = item["tool_use_id"]?.string ?? ""
                out.append(.toolResult(id: id, output: resultText(item["content"]), isError: item["is_error"]?.bool ?? false))
                for img in item["content"]?.array ?? [] where img["type"]?.string == "image" {
                    guard let src = img["source"], src["type"]?.string == "base64", let b64 = src["data"]?.string,
                          let data = Data(base64Encoded: b64) else { continue }
                    out.append(.toolImage(id: id, data: data, mediaType: src["media_type"]?.string ?? "image/png"))
                }
            }
            return out
        case "result":
            let usage = v["usage"]
            func int(_ k: String) -> Int { Int(usage?[k]?.number ?? 0) }
            return [.result(sessionID: v["session_id"]?.string, isError: v["is_error"]?.bool ?? (v["subtype"]?.string != "success"),
                            text: v["result"]?.string, inputTokens: int("input_tokens") + int("cache_read_input_tokens") + int("cache_creation_input_tokens"),
                            outputTokens: int("output_tokens"), costUSD: v["total_cost_usd"]?.number ?? v["cost_usd"]?.number,
                            turns: v["num_turns"]?.number.map { Int($0) })]
        default:
            return [.other(v["type"]?.string ?? "?")]
        }
    }

    /// Text of a tool result: a string, or the text items of a content array (images come as `.toolImage`).
    static func resultText(_ v: JSONValue?) -> String {
        guard let v else { return "" }
        if let s = v.string { return s }
        if let a = v.array { return a.compactMap { $0["type"]?.string == "text" ? $0["text"]?.string : nil }.joined(separator: "\n") }
        if v.isNull { return "" }
        return (try? String(data: v.encoded(), encoding: .utf8)) ?? ""
    }

    /// Stream event → chat event (`nil` for lines the chat does not show).
    public static func chatEvent(_ e: ClaudeStreamEvent) -> ChatEvent? {
        switch e {
        case .initialized(let sid, let model, _, _, _): return .started(model: model, sessionID: sid.isEmpty ? nil : sid)
        case .text(let t): return .text(t)
        case .thinking(let t): return .thinking(t)
        case .textDelta(let t): return .textDelta(t)
        case .thinkingDelta(let t): return .thinkingDelta(t)
        case .toolUse(let id, let name, let input): return .toolUse(id: id, name: name, input: input)
        case .toolResult(let id, let output, let isError): return .toolResult(id: id, output: output, isError: isError)
        case .toolImage(let id, let data, let type): return .toolImage(id: id, data: data, mediaType: type)
        case .result(let sid, let isError, let text, _, _, let cost, _): return .result(text: text ?? "", sessionID: sid, costUSD: cost, isError: isError)
        case .other: return nil
        }
    }

    /// Claude Code tool → ACP tool kind (drives icons and the "allow reads" policy).
    public static func kind(of tool: String) -> String {
        switch tool {
        case "Read", "NotebookRead", "LS": return "read"
        case "Grep", "Glob", "WebSearch", "ToolSearch": return "search"
        case "Edit", "MultiEdit", "Write", "NotebookEdit": return "edit"
        case "Bash", "BashOutput", "KillShell", "KillBash": return "execute"
        case "WebFetch": return "fetch"
        case "Task", "Agent": return "think"
        case "TodoWrite": return "plan"
        default: return tool.hasPrefix("mcp__") ? "other" : "other"
        }
    }

    /// "Bash(ls -la)", "Edit(Sources/App.swift)" — the one-line title Claude Code shows.
    public static func title(of tool: String, input: JSONValue) -> String {
        func s(_ k: String) -> String? { input[k]?.string }
        var arg: String?
        switch tool {
        case "Bash": arg = s("command")
        case "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead": arg = s("file_path") ?? s("notebook_path")
        case "Grep": arg = s("pattern").map { p in s("path").map { "\(p) in \($0)" } ?? p }
        case "Glob": arg = s("pattern")
        case "LS": arg = s("path")
        case "WebFetch": arg = s("url")
        case "WebSearch": arg = s("query")
        case "Task", "Agent": arg = s("description")
        case "TodoWrite": arg = nil
        default: arg = input.object?.sorted { $0.key < $1.key }.lazy.compactMap { $0.value.string }.first
        }
        var name = tool
        if tool.hasPrefix("mcp__") {
            // mcp__<server>__<tool> → "server:tool"; Based's own orchestration tools read like Claude Code's Task tool.
            let parts = tool.components(separatedBy: "__").filter { !$0.isEmpty }
            let server = parts.count > 1 ? parts[1] : "mcp"
            let t = parts.count > 2 ? parts[2...].joined(separator: "__") : server
            switch t {
            case "spawn_agent": name = "Agent"; arg = s("title") ?? s("prompt")
            case "wait_for_agents": name = "Wait"; arg = s("session_ids") ?? "all sub-agents"
            case "message_agent": name = "Message"; arg = s("prompt")
            case "read_agent_session": name = "Read session"; arg = s("session_id")
            case "agent_sessions": name = "Sessions"; arg = s("scope") ?? "children"
            case "stop_agent": name = "Stop agent"; arg = s("session_id")
            default: name = "\(server):\(t)"
            }
        }
        guard let arg, !arg.isEmpty else { return name }
        let one = arg.replacingOccurrences(of: "\n", with: " ")
        return "\(name)(\(one.count > 120 ? String(one.prefix(117)) + "…" : one))"
    }

    /// Edit / MultiEdit / Write inputs → diffs (old → new text) for the transcript.
    public static func diffs(_ tool: String, _ input: JSONValue) -> [ACPUpdate] {
        let path = input["file_path"]?.string ?? input["notebook_path"]?.string ?? "file"
        switch tool {
        case "Edit": return [.diff(path: path, old: input["old_string"]?.string ?? "", new: input["new_string"]?.string ?? "")]
        case "MultiEdit":
            return (input["edits"]?.array ?? []).map { .diff(path: path, old: $0["old_string"]?.string ?? "", new: $0["new_string"]?.string ?? "") }
        case "Write": return [.diff(path: path, old: "", new: input["content"]?.string ?? "")]
        default: return []
        }
    }

    /// TodoWrite input → plan lines ("☐ task" / "☒ done").
    public static func todos(_ input: JSONValue) -> [String] {
        (input["todos"]?.array ?? []).map { t in
            let done = t["status"]?.string == "completed"
            let active = t["status"]?.string == "in_progress"
            return (done ? "☒ " : active ? "◐ " : "☐ ") + (t["content"]?.string ?? "")
        }
    }

    /// Converts stream events to the ACP-style updates the rest of Based understands.
    public static func updates(for e: ClaudeStreamEvent) -> [ACPUpdate] {
        switch e {
        case .initialized(_, let model, _, let mode, _):
            var out: [ACPUpdate] = []
            if let model { out.append(.notice("Model: \(model)")) }
            if let mode { out.append(.modeChanged(mode)) }
            return out
        case .text(let t): return t.isEmpty ? [] : [.agentText(t)]
        case .thinking(let t): return t.isEmpty ? [] : [.agentThought(t)]
        case .textDelta, .thinkingDelta, .toolImage: return []
        case .toolUse(let id, let name, let input):
            if name == "TodoWrite" { return [.plan(todos(input))] }
            return [.toolCall(id: id.isEmpty ? UUID().uuidString : id, title: title(of: name, input: input), kind: kind(of: name), status: "in_progress")] + diffs(name, input)
        case .toolResult(let id, let output, let isError):
            return [.toolCallUpdate(id: id, status: isError ? "failed" : "completed", output: output)]
        case .result(_, _, _, let i, let o, _, _): return [.usage(input: i, output: o)]
        case .other: return []
        }
    }
}

/// Drives the real `claude` CLI without an ACP adapter:
/// `claude -p --input-format stream-json --output-format stream-json --verbose [--resume id]
///   --permission-mode … --mcp-config <file> --permission-prompt-tool mcp__based__approval`.
/// BSD-33: the MCP config (with its bearer token) is written to a private file, never passed on the command line,
/// and the child gets only the allowlisted environment (`ShellEnvironment.childEnvironment`).
/// One long-lived process per session; each prompt is a JSON line on stdin, a `result` line ends the turn.
public final class ClaudeCodeDriver: AgentConnection, @unchecked Sendable {
    public struct Options: Sendable {
        public var executable: String
        public var cwd: String
        public var resume: String?
        public var permissionMode: String          // default | acceptEdits | plan | bypassPermissions
        public var model: String?
        public var mcpConfig: JSONValue?           // {"mcpServers": {...}}
        public var permissionPromptTool: String?   // "mcp__based__approval"
        public var appendSystemPrompt: String?
        public var extraArgs: [String] = []
        public var environment: [String: String] = [:]
        /// Agent id for user-approved environment variables (`ShellEnvironment.passthrough(for:)`).
        public var agentID: String = "claude"
        public init(executable: String, cwd: String, resume: String? = nil, permissionMode: String = "default", model: String? = nil,
                    mcpConfig: JSONValue? = nil, permissionPromptTool: String? = nil, appendSystemPrompt: String? = nil) {
            self.executable = executable; self.cwd = cwd; self.resume = resume; self.permissionMode = permissionMode; self.model = model
            self.mcpConfig = mcpConfig; self.permissionPromptTool = permissionPromptTool; self.appendSystemPrompt = appendSystemPrompt
        }
    }

    public let options: Options
    public var onUpdate: (@Sendable (ACPUpdate) -> Void)?
    public var onEvent: (@Sendable (ClaudeStreamEvent) -> Void)?
    public var onLog: (@Sendable (String) -> Void)?

    private let state = Locked<State>(State())
    /// BSD-48: one turn at a time. A prompt sent while a turn runs waits for that turn's `result` (before, it
    /// cancelled the old waiter and the first `result` answered the second prompt — answers swapped).
    private let gate = AsyncTurnGate()
    private struct State {
        var sessionID: String?
        var buffer = Data()
        var waiter: CheckedContinuation<ACPStopReason, Error>?
        var running = false
        var cancelled = false
    }
    #if os(macOS) || os(Linux)
    private var process: Process?
    private var stdinPipe: Pipe?
    #endif
    /// The private `--mcp-config` file of the running process (removed when it stops).
    private let configFile = Locked<MCPConfigFile?>(nil)

    public init(options: Options) {
        self.options = options
        state.sync { $0.sessionID = options.resume }
    }

    public var sessionID: String? { state.sync { $0.sessionID } }
    public var isRunning: Bool { state.sync { $0.running } }

    /// Command line; `mcpConfigPath` is the private file holding `options.mcpConfig` (never the JSON itself).
    public func arguments(mcpConfigPath: String? = nil) -> [String] {
        var a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                 "--permission-mode", options.permissionMode]
        if let r = options.resume { a += ["--resume", r] }
        if let m = options.model, !m.isEmpty { a += ["--model", m] }
        if let path = mcpConfigPath { a += ["--mcp-config", path] }
        if let t = options.permissionPromptTool { a += ["--permission-prompt-tool", t] }
        if let s = options.appendSystemPrompt, !s.isEmpty { a += ["--append-system-prompt", s] }
        return a + options.extraArgs
    }

    public func start() throws {
        #if os(macOS) || os(Linux)
        ProcessSupervisor.ignoreSIGPIPE()   // BSD-36: a dead session's pipe returns EPIPE instead of killing Based
        let p = Process()
        p.executableURL = URL(fileURLWithPath: options.executable)
        var file: MCPConfigFile?
        if let c = options.mcpConfig { file = try MCPConfigFile.write(c) }
        p.arguments = arguments(mcpConfigPath: file?.path)
        var extra = options.environment
        extra["CLAUDE_CODE_ENTRYPOINT"] = extra["CLAUDE_CODE_ENTRYPOINT"] ?? "sdk-based"
        p.environment = ShellEnvironment.childEnvironment(agent: options.agentID, extra: extra)
        p.currentDirectoryURL = URL(fileURLWithPath: options.cwd)
        let input = Pipe(), output = Pipe(), errors = Pipe()
        p.standardInput = input; p.standardOutput = output; p.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { self?.receive(d) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { self?.onLog?(String(decoding: d, as: UTF8.self)) }
        }
        p.terminationHandler = { [weak self] proc in self?.terminated(status: proc.terminationStatus) }
        do { try ProcessSupervisor.launch(p) } catch { file?.remove(); throw error }
        configFile.sync { $0?.remove(); $0 = file }
        process = p; stdinPipe = input
        state.sync { $0.running = true }
        Log.info("Claude Code started (pid \(p.processIdentifier)) in \(options.cwd)", category: "agents")
        #else
        throw JSONRPCPeer.RPCError(code: -32000, message: "Claude Code runs on the Mac or a Based server.")
        #endif
    }

    private func receive(_ d: Data) {
        var lines: [String] = []
        state.sync { s in
            s.buffer.append(d)
            while let nl = s.buffer.firstIndex(of: 0x0A) {
                let line = s.buffer[s.buffer.startIndex..<nl]
                s.buffer.removeSubrange(s.buffer.startIndex...nl)
                lines.append(String(decoding: line, as: UTF8.self))
            }
        }
        for l in lines { for e in ClaudeStream.parse(line: l) { handle(e) } }
    }

    private func handle(_ e: ClaudeStreamEvent) {
        onEvent?(e)
        for u in ClaudeStream.updates(for: e) { onUpdate?(u) }
        switch e {
        case .initialized(let sid, _, _, _, _):
            if !sid.isEmpty { state.sync { $0.sessionID = sid } }
        case .result(let sid, let isError, let text, _, _, _, _):
            let (w, cancelled) = state.sync { s -> (CheckedContinuation<ACPStopReason, Error>?, Bool) in
                if let sid { s.sessionID = sid }
                let w = s.waiter; s.waiter = nil
                let c = s.cancelled; s.cancelled = false
                return (w, c)
            }
            if isError, !cancelled, let text, !text.isEmpty { onUpdate?(.notice(text)) }
            w?.resume(returning: cancelled ? .cancelled : (isError ? .refusal : .end_turn))
        default: break
        }
    }

    private func terminated(status: Int32) {
        configFile.sync { $0?.remove(); $0 = nil }
        let w = state.sync { s -> CheckedContinuation<ACPStopReason, Error>? in
            s.running = false
            let w = s.waiter; s.waiter = nil
            return w
        }
        Log.info("Claude Code exited with status \(status)", category: "agents")
        if let w {
            if status == 0 || state.sync({ $0.cancelled }) { w.resume(returning: .cancelled) }
            else { w.resume(throwing: JSONRPCPeer.RPCError(code: Int(status), message: "Claude Code exited with status \(status). Is it installed and logged in? (Settings → Agents → Check setup)")) }
        }
    }

    /// Sends one user turn and waits for its `result`.
    public func prompt(_ text: String, resources: [(uri: String, text: String)] = []) async throws -> ACPStopReason {
        guard await gate.enter() else { return .cancelled }
        defer { gate.leave() }
        if !isRunning { try start() }
        var content: [JSONValue] = [["type": "text", "text": .string(text)]]
        for r in resources where !r.text.isEmpty {
            content.append(["type": "text", "text": .string("<context source=\"\(r.uri)\">\n\(r.text)\n</context>")])
        }
        let msg: JSONValue = ["type": "user", "message": ["role": "user", "content": .array(content)]]
        guard var line = try? msg.encoded() else { throw JSONRPCPeer.RPCError.internalError("encode") }
        line.append(0x0A)
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<ACPStopReason, Error>) in
            let previous = state.sync { s -> CheckedContinuation<ACPStopReason, Error>? in
                let p = s.waiter; s.waiter = c; s.cancelled = false; return p
            }
            previous?.resume(returning: .cancelled)
            #if os(macOS) || os(Linux)
            // BSD-36: `write(_:)` raised an exception (app crash) when the process was already gone; now the turn fails.
            var failure: String?
            if let h = stdinPipe?.fileHandleForWriting, process?.isRunning == true {
                do { try h.write(contentsOf: line) } catch { failure = "\(error)" }
            } else {
                failure = "not running"
            }
            if let failure {
                let w = state.sync { s -> CheckedContinuation<ACPStopReason, Error>? in s.running = false; let w = s.waiter; s.waiter = nil; return w }
                Log.notice("Claude Code input closed (\(failure)); the session restarts on the next prompt", category: "agents")
                w?.resume(throwing: JSONRPCPeer.RPCError(code: -32000, message: "Claude Code is no longer running. Send the message again to restart the session."))
            }
            #endif
        }
    }

    public var processID: Int32? {
        #if os(macOS) || os(Linux)
        guard let p = process, p.isRunning else { return nil }
        return p.processIdentifier
        #else
        return nil
        #endif
    }

    /// Interrupts the current turn (SIGINT, like pressing Esc in Claude Code). The session resumes on the next prompt.
    public func cancel() {
        state.sync { $0.cancelled = true }
        #if os(macOS) || os(Linux)
        if let p = process, p.isRunning { p.interrupt() }
        #endif
    }

    /// Prompts waiting for the running turn.
    public var queuedPrompts: Int { gate.waitingCount }

    public func stop() {
        gate.cancelWaiting()
        #if os(macOS) || os(Linux)
        try? stdinPipe?.fileHandleForWriting.close()
        if let p = process, p.isRunning { p.terminate() }
        process = nil; stdinPipe = nil
        #endif
        configFile.sync { $0?.remove(); $0 = nil }
        let w = state.sync { s -> CheckedContinuation<ACPStopReason, Error>? in s.running = false; let w = s.waiter; s.waiter = nil; return w }
        w?.resume(returning: .cancelled)
    }
}

/// One-shot `claude -p … --output-format json` call. Used by the app's AI chat when no API key is
/// configured but Claude Code is installed and logged in (the subscription then powers "Ask AI").
public enum ClaudePrint {
    public struct Reply: Sendable, Equatable {
        public var text: String
        public var sessionID: String?
        public var isError: Bool
        public var costUSD: Double?
        public init(text: String, sessionID: String?, isError: Bool, costUSD: Double?) {
            self.text = text; self.sessionID = sessionID; self.isError = isError; self.costUSD = costUSD
        }
    }

    /// `mcpConfigPath`: the private file with the MCP config (`MCPConfigFile`) — BSD-33: never the JSON with its token.
    public static func arguments(prompt: String, resume: String? = nil, appendSystemPrompt: String? = nil, mcpConfigPath: String? = nil,
                                 allowedTools: [String] = [], model: String? = nil, maxTurns: Int? = nil) -> [String] {
        var a = ["-p", prompt, "--output-format", "json"]
        if let r = resume, !r.isEmpty { a += ["--resume", r] }
        if let m = model, !m.isEmpty { a += ["--model", m] }
        if let path = mcpConfigPath { a += ["--mcp-config", path] }
        if !allowedTools.isEmpty { a += ["--allowedTools", allowedTools.joined(separator: ",")] }
        if let s = appendSystemPrompt, !s.isEmpty { a += ["--append-system-prompt", s] }
        if let t = maxTurns { a += ["--max-turns", String(t)] }
        return a
    }

    /// Parses the final JSON object (`{"type":"result","result":…,"session_id":…}`); tolerates log lines before it.
    public static func parse(_ data: Data) -> Reply? {
        let s = String(decoding: data, as: UTF8.self)
        let candidates = [s.trimmingCharacters(in: .whitespacesAndNewlines)] + s.split(separator: "\n").reversed().map(String.init)
        for c in candidates {
            guard c.hasPrefix("{"), let v = try? JSONValue.parse(Data(c.utf8)), v["result"] != nil || v["is_error"] != nil else { continue }
            return Reply(text: v["result"]?.string ?? "", sessionID: v["session_id"]?.string,
                         isError: v["is_error"]?.bool ?? false, costUSD: v["total_cost_usd"]?.number ?? v["cost_usd"]?.number)
        }
        return nil
    }

    public struct Failure: Error, CustomStringConvertible {
        public let description: String
        public init(description: String) { self.description = description }
    }

    /// Runs the CLI off the calling thread. `executable` defaults to `which claude`.
    public static func ask(_ prompt: String, executable: String? = nil, resume: String? = nil, cwd: String = NSHomeDirectory(),
                           appendSystemPrompt: String? = nil, mcpConfig: JSONValue? = nil, allowedTools: [String] = [],
                           model: String? = nil, timeout: TimeInterval = 600) async -> Result<Reply, Error> {
        #if os(macOS) || os(Linux)
        guard let exe = executable ?? ShellEnvironment.which("claude") else {
            return .failure(Failure(description: "Claude Code is not installed (npm install -g @anthropic-ai/claude-code)."))
        }
        let file: MCPConfigFile?
        do { file = try mcpConfig.map { try MCPConfigFile.write($0) } } catch { return .failure(error) }
        let args = arguments(prompt: prompt, resume: resume, appendSystemPrompt: appendSystemPrompt, mcpConfigPath: file?.path,
                             allowedTools: allowedTools, model: model)
        return await Task.detached(priority: .userInitiated) { () -> Result<Reply, Error> in
            defer { file?.remove() }
            let started = Date()
            guard let d = ShellEnvironment.run(exe, args, timeout: timeout, environment: ShellEnvironment.childEnvironment(agent: "claude"),
                                               cwd: cwd, stderrToStdout: false) else {
                return .failure(Failure(description: "claude did not answer within \(Int(timeout)) s"))
            }
            Log.info("claude -p finished in \(String(format: "%.1f", Date().timeIntervalSince(started))) s", category: "agents")
            guard let r = parse(d) else { return .failure(Failure(description: String(decoding: d.prefix(600), as: UTF8.self))) }
            return r.isError ? .failure(Failure(description: r.text.isEmpty ? "Claude Code reported an error" : r.text)) : .success(r)
        }.value
        #else
        return .failure(Failure(description: "Claude Code runs on the Mac or a Based server."))
        #endif
    }
}

// MARK: - Streaming (in-app chat)

public extension ClaudePrint {
    /// Arguments for a streamed run: thinking, text deltas, tool calls and results arrive line by line.
    static func streamArguments(prompt: String, resume: String? = nil, appendSystemPrompt: String? = nil, mcpConfigPath: String? = nil,
                                allowedTools: [String] = [], model: String? = nil, effort: String? = nil,
                                permissionMode: String? = nil, permissionPromptTool: String? = nil) -> [String] {
        var a = arguments(prompt: prompt, resume: resume, appendSystemPrompt: appendSystemPrompt, mcpConfigPath: mcpConfigPath,
                          allowedTools: allowedTools, model: model)
        if let i = a.firstIndex(of: "json") { a[i] = "stream-json" }
        if let e = effort, !e.isEmpty { a += ["--effort", e] }
        if let m = permissionMode, !m.isEmpty { a += ["--permission-mode", m] }
        // Permission prompts (e.g. reading outside the working folder) go to Based instead of failing silently.
        if let t = permissionPromptTool, !t.isEmpty { a += ["--permission-prompt-tool", t] }
        // Thinking summaries when the CLI provides them (otherwise the chat shows "Thought for N s").
        a += ["--settings", #"{"showThinkingSummaries":true}"#]
        return a + ["--verbose", "--include-partial-messages"]
    }

    /// Runs `claude -p` with `stream-json` and reports every event on the main actor while it runs, in order
    /// (BSD-45: through `MainActorRelay` instead of one `Task` per event, which could reorder deltas).
    /// Cancelling the calling task terminates the process.
    static func stream(_ prompt: String, executable: String? = nil, resume: String? = nil, cwd: String = NSHomeDirectory(),
                       appendSystemPrompt: String? = nil, mcpConfig: JSONValue? = nil, allowedTools: [String] = [],
                       model: String? = nil, effort: String? = nil, permissionMode: String? = nil,
                       permissionPromptTool: String? = nil,
                       onEvent: @escaping @MainActor (ChatEvent) -> Void) async -> Result<Reply, Error> {
        let relay = MainActorRelay(onEvent)
        return await stream(prompt, executable: executable, resume: resume, cwd: cwd, appendSystemPrompt: appendSystemPrompt,
                            mcpConfig: mcpConfig, allowedTools: allowedTools, model: model, effort: effort,
                            permissionMode: permissionMode, permissionPromptTool: permissionPromptTool, emit: relay.send)
    }

    /// Same, but every event goes synchronously to `emit` on the pipe's reader thread, one at a time and in
    /// stream order — the form `ChatEngine` uses (ADR 0005: one serial `ChatEvent` stream).
    static func stream(_ prompt: String, executable: String? = nil, resume: String? = nil, cwd: String = NSHomeDirectory(),
                       appendSystemPrompt: String? = nil, mcpConfig: JSONValue? = nil, allowedTools: [String] = [],
                       model: String? = nil, effort: String? = nil, permissionMode: String? = nil,
                       permissionPromptTool: String? = nil,
                       emit: @escaping @Sendable (ChatEvent) -> Void) async -> Result<Reply, Error> {
        #if os(macOS) || os(Linux)
        guard let exe = executable ?? ShellEnvironment.which("claude") else {
            return .failure(Failure(description: "Claude Code is not installed (npm install -g @anthropic-ai/claude-code)."))
        }
        let file: MCPConfigFile?
        do { file = try mcpConfig.map { try MCPConfigFile.write($0) } } catch { return .failure(error) }
        defer { file?.remove() }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = streamArguments(prompt: prompt, resume: resume, appendSystemPrompt: appendSystemPrompt, mcpConfigPath: file?.path,
                                      allowedTools: allowedTools, model: model, effort: effort, permissionMode: permissionMode,
                                      permissionPromptTool: permissionPromptTool)
        p.environment = ShellEnvironment.childEnvironment(agent: "claude")
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        let state = StreamState()
        out.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            for line in state.feed(chunk) {
                for e in ClaudeChatStream.events(fromLine: line) {
                    state.note(e)
                    emit(e)
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in state.appendError(h.availableData) }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Result<Reply, Error>, Never>) in
                p.terminationHandler = { proc in
                    out.fileHandleForReading.readabilityHandler = nil
                    err.fileHandleForReading.readabilityHandler = nil
                    // Whatever is left in the pipe.
                    let rest = out.fileHandleForReading.readDataToEndOfFile()
                    for line in state.feed(rest + Data([0x0A])) {
                        for e in ClaudeChatStream.events(fromLine: line) { state.note(e); emit(e) }
                    }
                    if let r = state.reply {
                        c.resume(returning: r.isError ? .failure(Failure(description: r.text.isEmpty ? "Claude Code reported an error" : r.text)) : .success(r))
                    } else if proc.terminationReason == .uncaughtSignal {
                        c.resume(returning: .failure(Failure(description: "Stopped")))
                    } else {
                        c.resume(returning: .failure(Failure(description: state.errorText.isEmpty ? "claude exited with status \(proc.terminationStatus)" : String(state.errorText.prefix(600)))))
                    }
                }
                do { try ProcessSupervisor.launch(p) } catch {
                    c.resume(returning: .failure(Failure(description: "Couldn't start claude: \(error.localizedDescription)")))
                }
            }
        } onCancel: {
            if p.isRunning { p.terminate() }
        }
        #else
        return .failure(Failure(description: "Claude Code runs on the Mac or a Based server."))
        #endif
    }
}

/// Line buffer + final reply for `ClaudePrint.stream` (touched from the pipe's queue).
final class StreamState: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var errors = Data()
    private(set) var reply: ClaudePrint.Reply?

    func feed(_ d: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        buffer.append(d)
        return ClaudeChatStream.takeLines(&buffer)
    }

    func note(_ e: ChatEvent) {
        guard case .result(let t, let s, let c, let err) = e else { return }
        lock.lock(); reply = ClaudePrint.Reply(text: t, sessionID: s, isError: err, costUSD: c); lock.unlock()
    }

    func appendError(_ d: Data) { lock.lock(); errors.append(d); lock.unlock() }

    private var eventCount = 0
    func sawEvent() { lock.lock(); eventCount += 1; lock.unlock() }
    var events: Int { lock.lock(); defer { lock.unlock() }; return eventCount }
    var errorText: String { lock.lock(); defer { lock.unlock() }; return String(decoding: errors, as: UTF8.self) }
}
