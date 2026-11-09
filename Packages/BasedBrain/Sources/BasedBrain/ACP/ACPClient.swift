import Foundation

/// An installable coding agent that speaks the Agent Client Protocol (ACP) over stdio.
/// Based drives these agents the way Happier does: your existing Claude / Codex / Gemini subscriptions, no extra API key.
public struct AgentDefinition: Codable, Hashable, Sendable, Identifiable {
    public var id: String                // "claude", "codex", "gemini", "opencode", "pi", or custom
    public var name: String
    public var command: String
    public var arguments: [String]
    public var environment: [String: String]
    public var icon: String              // SF Symbol or emoji
    public var enabled: Bool
    public var note: String

    public init(id: String, name: String, command: String, arguments: [String] = [], environment: [String: String] = [:],
                icon: String = "terminal", enabled: Bool = true, note: String = "") {
        self.id = id; self.name = name; self.command = command; self.arguments = arguments; self.environment = environment
        self.icon = icon; self.enabled = enabled; self.note = note
    }

    /// Defaults mirror the launch commands used by Happier / Zed's ACP adapters. All editable in Settings → Agents.
    public static let defaults: [AgentDefinition] = [
        .init(id: "claude", name: "Claude Code", command: "npx", arguments: ["-y", "@zed-industries/claude-code-acp"], icon: "✴️",
              note: "Uses your Claude subscription via the Claude Code CLI login."),
        .init(id: "codex", name: "Codex", command: "npx", arguments: ["-y", "@zed-industries/codex-acp"], icon: "🅾️",
              note: "Uses your ChatGPT / OpenAI login through the Codex CLI."),
        .init(id: "gemini", name: "Gemini CLI", command: "gemini", arguments: ["--experimental-acp"], icon: "♊️",
              note: "Google account login via gemini CLI."),
        .init(id: "opencode", name: "OpenCode", command: "opencode", arguments: ["acp"], icon: "🟩",
              note: "opencode.ai (npm i -g opencode-ai or brew install opencode); any model you set up with `opencode auth login`."),
        .init(id: "pi", name: "Pi", command: "pi", arguments: ["--acp"], icon: "π", enabled: false,
              note: "Verify the ACP flag for your Pi build."),
        .init(id: "cursor", name: "Cursor Agent", command: "cursor-agent", arguments: ["acp"], icon: "🖱️", enabled: false,
              note: "Cursor's CLI agent; verify the ACP subcommand."),
    ]
}

/// MCP server definition handed to agents on `session/new` so every agent sees the same tools ("configured once").
public struct MCPServerConfig: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var command: String
    public var args: [String]
    public var env: [String: String]
    public init(id: String = UUID().uuidString, name: String, command: String, args: [String] = [], env: [String: String] = [:]) {
        self.id = id; self.name = name; self.command = command; self.args = args; self.env = env
    }
    public var json: JSONValue {
        ["name": .string(name), "command": .string(command), "args": .array(args.map(JSONValue.string)),
         "env": .array(env.map { ["name": .string($0.key), "value": .string($0.value)] })]
    }
}

/// Streamed update from an agent during a prompt turn (subset of ACP `session/update`).
public enum ACPUpdate: Sendable, Equatable {
    case agentText(String)
    case agentThought(String)
    case userText(String)
    case toolCall(id: String, title: String, kind: String, status: String)
    case toolCallUpdate(id: String, status: String, output: String?)
    case plan([String])
    case usage(input: Int, output: Int)
    case notice(String)
    case modeChanged(String)
    /// A file edit (old → new text) proposed or made by a tool call, rendered as a diff.
    case diff(path: String, old: String, new: String)
    case other(String)
}

public struct ACPPermissionRequest: Sendable, Equatable {
    public struct Option: Sendable, Equatable { public var id: String; public var name: String; public var kind: String }
    public var sessionID: String
    public var toolTitle: String
    public var toolKind: String
    public var detail: String
    public var options: [Option]
}

public enum ACPStopReason: String, Sendable { case end_turn, max_tokens, max_turn_requests, refusal, cancelled, unknown }

/// One live ACP agent process + session. Thread-safe; callbacks arrive on arbitrary threads.
public final class ACPClient: @unchecked Sendable {
    public let definition: AgentDefinition
    public private(set) var sessionID: String?
    public private(set) var agentInfo: JSONValue = .null
    public private(set) var availableModes: [(id: String, name: String)] = []
    private var transport: ProcessTransport?
    private var peer: JSONRPCPeer { transport!.peer }

    public var onUpdate: (@Sendable (ACPUpdate) -> Void)?
    /// Decide a permission request. Return the chosen `optionId`, or nil to cancel.
    public var onPermission: (@Sendable (ACPPermissionRequest) async -> String?)?
    public var onLog: (@Sendable (String) -> Void)?
    /// Allow the agent to read/write files in these directories (fs/* requests). Empty = deny all.
    public var allowedRoots: [String] = []
    /// BSD-50: rules checked for `fs/write_text_file` (deny rules and plan mode block the write; the agent asked
    /// for the edit itself via `session/request_permission`, so there is no second prompt).
    public var permissions: AgentPermissions?

    public init(definition: AgentDefinition) { self.definition = definition }

    /// Launch the agent process and perform the ACP handshake.
    public func start(cwd: String) throws {
        let t = try ProcessTransport(command: definition.command, arguments: definition.arguments, environment: definition.environment, cwd: cwd)
        t.stderrLog = { [weak self] in self?.onLog?($0) }
        transport = t
        t.peer.onNotification = { [weak self] method, params in self?.handleNotification(method, params) }
        t.peer.onRequest = { [weak self] method, params in await self?.handleRequest(method, params) ?? .failure(.methodNotFound(method)) }
    }

    public func initialize() async throws {
        let r = try await peer.request("initialize", [
            "protocolVersion": 1,
            "clientCapabilities": ["fs": ["readTextFile": true, "writeTextFile": true], "terminal": false],
            "clientInfo": ["name": "Based", "version": "0.2.0"],
        ])
        agentInfo = r["agentInfo"] ?? r["agentCapabilities"] ?? .null
        if let auth = r["authMethods"]?.array, !auth.isEmpty, r["agentCapabilities"]?["loadSession"] == nil {
            // Most adapters authenticate through their own CLI login; try the first method and ignore failures.
            if let id = auth.first?["id"]?.string { _ = try? await peer.request("authenticate", ["methodId": .string(id)]) }
        }
    }

    public func newSession(cwd: String, mcpServers: [MCPServerConfig]) async throws -> String {
        let r = try await peer.request("session/new", ["cwd": .string(cwd), "mcpServers": .array(mcpServers.map(\.json))])
        guard let id = r["sessionId"]?.string else { throw JSONRPCPeer.RPCError.internalError("session/new returned no sessionId") }
        sessionID = id
        if let modes = r["modes"]?["availableModes"]?.array {
            availableModes = modes.compactMap { m in m["id"]?.string.map { ($0, m["name"]?.string ?? $0) } }
        }
        return id
    }

    public func loadSession(_ id: String, cwd: String, mcpServers: [MCPServerConfig]) async throws {
        _ = try await peer.request("session/load", ["sessionId": .string(id), "cwd": .string(cwd), "mcpServers": .array(mcpServers.map(\.json))])
        sessionID = id
    }

    public func setMode(_ modeID: String) async throws {
        guard let sessionID else { return }
        _ = try await peer.request("session/set_mode", ["sessionId": .string(sessionID), "modeId": .string(modeID)])
    }

    /// Send a prompt; updates stream to `onUpdate`. Returns when the turn ends.
    public func prompt(_ text: String, resources: [(uri: String, text: String)] = []) async throws -> ACPStopReason {
        guard let sessionID else { throw JSONRPCPeer.RPCError.internalError("No session") }
        var blocks: [JSONValue] = [["type": "text", "text": .string(text)]]
        for r in resources { blocks.append(["type": "resource", "resource": ["uri": .string(r.uri), "mimeType": "text/markdown", "text": .string(r.text)]]) }
        let r = try await peer.request("session/prompt", ["sessionId": .string(sessionID), "prompt": .array(blocks)])
        return ACPStopReason(rawValue: r["stopReason"]?.string ?? "") ?? .unknown
    }

    public func cancel() { if let sessionID { peer.notify("session/cancel", ["sessionId": .string(sessionID)]) } }

    public func stop() { transport?.terminate(); transport = nil; sessionID = nil }
    public var isRunning: Bool { transport?.isRunning ?? false }

    // MARK: Incoming

    /// ACP tool-call content `{"type":"diff","path","oldText","newText"}` → `.diff`.
    private func emitDiffs(_ content: JSONValue?) {
        for c in content?.array ?? [] where c["type"]?.string == "diff" {
            onUpdate?(.diff(path: c["path"]?.string ?? "file", old: c["oldText"]?.string ?? "", new: c["newText"]?.string ?? ""))
        }
    }

    private func handleNotification(_ method: String, _ params: JSONValue?) {
        guard method == "session/update", let u = params?["update"] else { return }
        let kind = u["sessionUpdate"]?.string ?? ""
        let text = u["content"]?["text"]?.string ?? ""
        switch kind {
        case "agent_message_chunk": onUpdate?(.agentText(text))
        case "agent_thought_chunk": onUpdate?(.agentThought(text))
        case "user_message_chunk": onUpdate?(.userText(text))
        case "tool_call":
            onUpdate?(.toolCall(id: u["toolCallId"]?.string ?? "", title: u["title"]?.string ?? "tool", kind: u["kind"]?.string ?? "other", status: u["status"]?.string ?? "pending"))
            emitDiffs(u["content"])
        case "tool_call_update":
            emitDiffs(u["content"])
            let out = u["content"]?.array?.compactMap { $0["content"]?["text"]?.string }.joined(separator: "\n")
            onUpdate?(.toolCallUpdate(id: u["toolCallId"]?.string ?? "", status: u["status"]?.string ?? "", output: out?.isEmpty == false ? out : nil))
        case "plan":
            onUpdate?(.plan(u["entries"]?.array?.compactMap { e in e["content"]?.string.map { "[\(e["status"]?.string ?? "pending")] \($0)" } } ?? []))
        case "usage_update":
            onUpdate?(.usage(input: u["inputTokens"]?.int ?? u["used"]?.int ?? 0, output: u["outputTokens"]?.int ?? 0))
        case "notice": onUpdate?(.notice(text.isEmpty ? (u["message"]?.string ?? "") : text))
        case "current_mode_update": onUpdate?(.modeChanged(u["currentModeId"]?.string ?? ""))
        case "available_commands_update", "config_option_update", "session_info_update", "compaction_update", "compaction_summary_chunk": break
        default: onUpdate?(.other(kind))
        }
    }

    private func handleRequest(_ method: String, _ params: JSONValue?) async -> Result<JSONValue, JSONRPCPeer.RPCError> {
        switch method {
        case "session/request_permission":
            let tc = params?["toolCall"] ?? .null
            let options = params?["options"]?.array?.compactMap { o -> ACPPermissionRequest.Option? in
                guard let id = o["optionId"]?.string else { return nil }
                return .init(id: id, name: o["name"]?.string ?? id, kind: o["kind"]?.string ?? "allow_once")
            } ?? []
            let detail = tc["rawInput"]?.text ?? tc["content"]?.text ?? ""
            let req = ACPPermissionRequest(sessionID: params?["sessionId"]?.string ?? "", toolTitle: tc["title"]?.string ?? "Tool",
                                           toolKind: tc["kind"]?.string ?? "other", detail: String(detail.prefix(2000)), options: options)
            if let chosen = await onPermission?(req) {
                return .success(["outcome": ["outcome": "selected", "optionId": .string(chosen)]])
            }
            return .success(["outcome": ["outcome": "cancelled"]])
        case "fs/read_text_file":
            guard let path = params?["path"]?.string, allowed(path) else { return .failure(.init(code: -32001, message: "Read not permitted")) }
            do { return .success(["content": .string(try String(contentsOfFile: path, encoding: .utf8))]) }
            catch { return .failure(.internalError("\(error)")) }
        case "fs/write_text_file":
            guard let path = params?["path"]?.string, allowed(path), let content = params?["content"]?.string else { return .failure(.init(code: -32001, message: "Write not permitted")) }
            if let permissions, permissions.decide(PermissionCall(tool: "Write", argument: path, category: .edit)).effect == .deny {
                return .failure(.init(code: -32001, message: "Write not permitted by the permission rules"))
            }
            do { try content.write(toFile: path, atomically: true, encoding: .utf8); return .success(.null) }
            catch { return .failure(.internalError("\(error)")) }
        default:
            return .failure(.methodNotFound(method))
        }
    }

    /// Inside one of `allowedRoots`, component-wise and with symlinks resolved (BSD-50: `/p/proj` no longer
    /// allows `/p/proj-secret`, and a symlink inside the project can't point outside it).
    func allowed(_ path: String) -> Bool {
        allowedRoots.contains { PathScope.contains(root: $0, path: path) }
    }
}
