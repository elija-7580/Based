import Foundation
import BasedCore

// MARK: - Engine spec

/// What answers in the chat: a coding-agent CLI on this Mac (with the user's own subscription) or an API model,
/// plus the model, effort / reasoning level and permission mode — the choices of the Claude / Codex apps' pickers.
public struct ChatEngineSpec: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case auto, claudeCode, codex, gemini, opencode, api

        public var title: String {
            switch self {
            case .auto: return "Auto"
            case .claudeCode: return "Claude Code"
            case .codex: return "Codex"
            case .gemini: return "Gemini CLI"
            case .opencode: return "OpenCode"
            case .api: return "API"
            }
        }

        /// Executable name of the CLI.
        public var command: String? {
            switch self {
            case .claudeCode: return "claude"
            case .codex: return "codex"
            case .gemini: return "gemini"
            case .opencode: return "opencode"
            case .auto, .api: return nil
            }
        }
    }

    public var kind: Kind
    /// CLI alias / model id ("" = the CLI's default); for `.api` a model ref "provider/model".
    public var model: String
    /// low · medium · high · xhigh · max ("" = default).
    public var effort: String
    /// Permission mode (Claude: default/acceptEdits/plan/bypassPermissions; Codex: read-only/workspace-write/danger-full-access;
    /// Gemini: default/auto_edit/yolo/plan).
    public var permission: String

    public init(kind: Kind, model: String = "", effort: String = "", permission: String = "") {
        self.kind = kind; self.model = model; self.effort = effort; self.permission = permission
    }

    public static let auto = ChatEngineSpec(kind: .auto)

    /// Stored form (UserDefaults).
    public var encoded: String {
        (try? String(decoding: JSONEncoder().encode(self), as: UTF8.self)) ?? ""
    }

    /// Reads the stored form; also the old values of the engine picker ("auto", "claude-code", "provider/model").
    public static func decode(_ s: String?) -> ChatEngineSpec {
        guard let s, !s.isEmpty else { return .auto }
        if s.hasPrefix("{"), let v = try? JSONDecoder().decode(ChatEngineSpec.self, from: Data(s.utf8)) { return v }
        switch s {
        case "auto": return .auto
        case "claude-code": return ChatEngineSpec(kind: .claudeCode)
        default: return ChatEngineSpec(kind: .api, model: s)
        }
    }
}

// MARK: - Catalog

public struct CLIModelChoice: Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var detail: String
    public init(id: String, label: String, detail: String = "") { self.id = id; self.label = label; self.detail = detail }
}

public struct CLIModeChoice: Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var detail: String
    public var symbol: String
}

/// Models, effort levels and permission modes per CLI.
public enum CLICatalog {
    public static func models(for kind: ChatEngineSpec.Kind, home: String = NSHomeDirectory()) -> [CLIModelChoice] {
        switch kind {
        case .claudeCode:
            return [
                CLIModelChoice(id: "", label: "Default", detail: "Your Claude Code default"),
                CLIModelChoice(id: "opus", label: "Opus 5.5", detail: "Most capable for complex work"),
                CLIModelChoice(id: "sonnet", label: "Sonnet 5.5", detail: "Smart, efficient for everyday tasks"),
                CLIModelChoice(id: "haiku", label: "Haiku 5.5", detail: "Fastest for quick answers"),
                CLIModelChoice(id: "fable", label: "Fable 5.1", detail: "Creative writing and long-form"),
            ]
        case .codex:
            let cached = codexModels(home: home)
            return [CLIModelChoice(id: "", label: "Default", detail: codexDefaultModel(home: home).map { "From config: \($0)" } ?? "Your Codex default")]
                + cached
        case .gemini:
            return [
                CLIModelChoice(id: "", label: "Default", detail: "Your Gemini CLI default"),
                CLIModelChoice(id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", detail: "Most capable"),
                CLIModelChoice(id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", detail: "Fast"),
            ]
        case .opencode:
            return [CLIModelChoice(id: "", label: "Default", detail: "Your OpenCode default")]
        case .auto, .api:
            return []
        }
    }

    /// Effort levels the CLI understands ("" = default).
    public static func efforts(for kind: ChatEngineSpec.Kind) -> [CLIModelChoice] {
        switch kind {
        case .claudeCode:
            return [CLIModelChoice(id: "", label: "Default"), CLIModelChoice(id: "low", label: "Low", detail: "Quick, minimal thinking"),
                    CLIModelChoice(id: "medium", label: "Medium"), CLIModelChoice(id: "high", label: "High", detail: "Thinks longer"),
                    CLIModelChoice(id: "xhigh", label: "Extra high"), CLIModelChoice(id: "max", label: "Max", detail: "Deepest thinking")]
        case .api:
            // Anthropic models (output_config.effort); other providers ignore it.
            return [CLIModelChoice(id: "", label: "Default"), CLIModelChoice(id: "low", label: "Low", detail: "Fast, light thinking"),
                    CLIModelChoice(id: "medium", label: "Medium"), CLIModelChoice(id: "high", label: "High", detail: "Thinks longer"),
                    CLIModelChoice(id: "xhigh", label: "Extra high"), CLIModelChoice(id: "max", label: "Max", detail: "Deepest thinking")]
        case .codex:
            return [CLIModelChoice(id: "", label: "Default"), CLIModelChoice(id: "minimal", label: "Minimal"),
                    CLIModelChoice(id: "low", label: "Low"), CLIModelChoice(id: "medium", label: "Medium"),
                    CLIModelChoice(id: "high", label: "High"), CLIModelChoice(id: "xhigh", label: "Extra high")]
        default:
            return []
        }
    }

    public static func permissions(for kind: ChatEngineSpec.Kind) -> [CLIModeChoice] {
        switch kind {
        case .claudeCode:
            return [
                CLIModeChoice(id: "", label: "Ask permissions", detail: "Read freely, ask before edits and commands", symbol: "hand.raised"),
                CLIModeChoice(id: "acceptEdits", label: "Accept edits", detail: "Edit files without asking", symbol: "pencil.and.outline"),
                CLIModeChoice(id: "plan", label: "Plan mode", detail: "Explore and propose a plan, change nothing", symbol: "list.bullet.clipboard"),
                CLIModeChoice(id: "bypassPermissions", label: "Bypass permissions", detail: "Run everything without asking", symbol: "exclamationmark.shield"),
            ]
        case .codex:
            return [
                CLIModeChoice(id: "", label: "Read only", detail: "Look, don't touch", symbol: "eye"),
                CLIModeChoice(id: "workspace-write", label: "Workspace write", detail: "Edit files in the working folder", symbol: "pencil.and.outline"),
                CLIModeChoice(id: "danger-full-access", label: "Full access", detail: "No sandbox", symbol: "exclamationmark.shield"),
            ]
        case .gemini:
            return [
                CLIModeChoice(id: "", label: "Plan (read only)", detail: "Read-only tools", symbol: "eye"),
                CLIModeChoice(id: "auto_edit", label: "Auto edit", detail: "Approve edit tools", symbol: "pencil.and.outline"),
                CLIModeChoice(id: "yolo", label: "YOLO", detail: "Approve everything", symbol: "exclamationmark.shield"),
            ]
        default:
            return []
        }
    }

    /// `~/.codex/models_cache.json` (written by Codex) → visible models.
    public static func codexModels(home: String) -> [CLIModelChoice] {
        let url = URL(fileURLWithPath: home).appendingPathComponent(".codex/models_cache.json")
        guard let d = try? Data(contentsOf: url), let v = try? JSONValue.parse(d) else { return [] }
        let list = v["models"]?.array ?? v.array ?? []
        return list.compactMap { m in
            guard let slug = m["slug"]?.string ?? m["id"]?.string else { return nil }
            if let vis = m["visibility"]?.string, vis != "list" { return nil }
            if slug.contains("review") { return nil }
            return CLIModelChoice(id: slug, label: m["display_name"]?.string ?? slug, detail: m["description"]?.string ?? "")
        }
    }

    static func codexDefaultModel(home: String) -> String? {
        let url = URL(fileURLWithPath: home).appendingPathComponent(".codex/config.toml")
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        for line in s.split(separator: "\n") where line.hasPrefix("model ") || line.hasPrefix("model=") {
            return line.split(separator: "=", maxSplits: 1).last?.trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
        }
        return nil
    }

    /// Short label for the picker button ("Opus 5.5 · High").
    public static func label(_ spec: ChatEngineSpec, home: String = NSHomeDirectory()) -> String {
        switch spec.kind {
        case .auto: return "Auto"
        case .api:
            let m = spec.model.split(separator: "/").last.map(String.init) ?? spec.model
            if spec.model.hasPrefix("apple/") { return "Apple Intelligence" }
            if !spec.effort.isEmpty, let e = efforts(for: .api).first(where: { $0.id == spec.effort }) { return m + " · " + e.label }
            return m
        default:
            let m = models(for: spec.kind, home: home).first { $0.id == spec.model }
            var s = spec.model.isEmpty ? spec.kind.title : (m?.label ?? spec.model)
            if !spec.effort.isEmpty, let e = efforts(for: spec.kind).first(where: { $0.id == spec.effort }) { s += " · " + e.label }
            return s
        }
    }
}

// MARK: - Arguments

public enum CLIChatArguments {
    /// `codex exec --json …` (resume: `codex exec resume <thread> --json …`).
    public static func codex(prompt: String, spec: ChatEngineSpec, resume: String?, mcpURL: String?, systemPrompt: String?) -> [String] {
        var a = ["exec"]
        if let r = resume, !r.isEmpty { a += ["resume", r] }
        a += ["--json", "--skip-git-repo-check"]
        if !spec.model.isEmpty { a += ["-m", spec.model] }
        if !spec.effort.isEmpty { a += ["-c", "model_reasoning_effort=\"\(spec.effort)\""] }
        // `resume` doesn't accept --sandbox; the session keeps the one it started with.
        if resume == nil || resume?.isEmpty == true { a += ["-s", spec.permission.isEmpty ? "read-only" : spec.permission] }
        if let u = mcpURL {
            a += ["-c", "mcp_servers.based.url=\"\(u)\"", "-c", "mcp_servers.based.bearer_token_env_var=\"BASED_MCP_TOKEN\""]
        }
        var p = prompt
        if let s = systemPrompt, !s.isEmpty, resume == nil || resume?.isEmpty == true { p = s + "\n\n---\n\n" + prompt }
        a.append(p)
        return a
    }

    /// `gemini -p … -o stream-json`.
    public static func gemini(prompt: String, spec: ChatEngineSpec, resume: String?, systemPrompt: String?) -> [String] {
        var p = prompt
        if let s = systemPrompt, !s.isEmpty, resume == nil { p = s + "\n\n---\n\n" + prompt }
        var a = ["-p", p, "-o", "stream-json", "--approval-mode", spec.permission.isEmpty ? "plan" : spec.permission]
        if !spec.model.isEmpty { a += ["-m", spec.model] }
        if let r = resume, !r.isEmpty { a += ["--resume", r] }
        return a
    }

    /// `opencode run --format json …`.
    public static func opencode(prompt: String, spec: ChatEngineSpec, resume: String?, systemPrompt: String?) -> [String] {
        var p = prompt
        if let s = systemPrompt, !s.isEmpty, resume == nil { p = s + "\n\n---\n\n" + prompt }
        var a = ["run", "--format", "json"]
        if !spec.model.isEmpty { a += ["-m", spec.model] }
        if let r = resume, !r.isEmpty { a += ["--session", r] }
        a.append(p)
        return a
    }
}

// MARK: - Codex `exec --json`

/// One JSONL line of `codex exec --json` → chat events.
///
/// `thread.started` → started · `item.*` (reasoning → thinking, agent_message → text, command_execution → Bash,
/// file_change → Edit, mcp_tool_call → mcp__server__tool, web_search → WebSearch, todo_list → TodoWrite)
/// · `turn.completed` → result · `turn.failed` / `error` → failed result.
public enum CodexChatStream {
    public static func events(fromLine line: String) -> [ChatEvent] {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{"), let v = try? JSONValue.parse(t) else { return [] }
        switch v["type"]?.string {
        case "thread.started":
            return [.started(model: nil, sessionID: v["thread_id"]?.string)]
        case "item.started":
            guard let item = v["item"] else { return [] }
            return toolStart(item).map { [$0] } ?? []
        case "item.updated":
            guard let item = v["item"], item["type"]?.string == "todo_list" else { return [] }
            return toolStart(item).map { [$0] } ?? []
        case "item.completed":
            guard let item = v["item"] else { return [] }
            let id = item["id"]?.string ?? ""
            switch item["type"]?.string {
            case "reasoning":
                return (item["text"]?.string).map { [.thinking($0)] } ?? []
            case "agent_message":
                return (item["text"]?.string).map { [.text($0)] } ?? []
            case "error":
                return [.text("⚠️ " + (item["message"]?.string ?? "Error"))]
            default:
                var out: [ChatEvent] = []
                if let s = toolStart(item) { out.append(s) }
                guard item["type"]?.string != "todo_list" else { return out }
                let failed = item["status"]?.string == "failed" || (item["exit_code"]?.number).map { $0 != 0 } == true
                out.append(.toolResult(id: id, output: output(item), isError: failed))
                return out
            }
        case "turn.completed":
            return [.result(text: "", sessionID: nil, costUSD: nil, isError: false)]
        case "turn.failed":
            return [.result(text: v["error"]?["message"]?.string ?? "Codex failed", sessionID: nil, costUSD: nil, isError: true)]
        case "error":
            return [.result(text: v["message"]?.string ?? "Codex error", sessionID: nil, costUSD: nil, isError: true)]
        default:
            return []
        }
    }

    /// The tool card for an item (same names as Claude Code's tools, so icons and verbs match).
    static func toolStart(_ item: JSONValue) -> ChatEvent? {
        let id = item["id"]?.string ?? ""
        switch item["type"]?.string {
        case "command_execution":
            return .toolUse(id: id, name: "Bash", input: ["command": .string(stripShell(item["command"]?.string ?? ""))])
        case "file_change":
            let paths = (item["changes"]?.array ?? []).compactMap { $0["path"]?.string }
            return .toolUse(id: id, name: "Edit", input: ["file_path": .string(paths.joined(separator: ", "))])
        case "mcp_tool_call":
            let name = "mcp__\(item["server"]?.string ?? "mcp")__\(item["tool"]?.string ?? "tool")"
            return .toolUse(id: id, name: name, input: item["arguments"] ?? .object([:]))
        case "web_search":
            return .toolUse(id: id, name: "WebSearch", input: ["query": .string(item["query"]?.string ?? "")])
        case "todo_list":
            let todos: [JSONValue] = (item["items"]?.array ?? []).map { i in
                ["content": .string(i["text"]?.string ?? ""), "status": .string(i["completed"]?.bool == true ? "completed" : "pending")]
            }
            return .toolUse(id: id, name: "TodoWrite", input: ["todos": .array(todos)])
        default:
            return nil
        }
    }

    static func output(_ item: JSONValue) -> String {
        if let o = item["aggregated_output"]?.string { return o }
        if let r = item["result"] {
            if let s = r.string { return s }
            if let content = r["content"]?.array {
                return content.compactMap { $0["text"]?.string }.joined(separator: "\n")
            }
            if let d = try? r.encoded() { return String(decoding: d, as: UTF8.self) }
        }
        if let e = item["error"]?["message"]?.string { return e }
        if let changes = item["changes"]?.array {
            return changes.map { "\($0["kind"]?.string ?? "update") \($0["path"]?.string ?? "")" }.joined(separator: "\n")
        }
        return ""
    }

    /// `/bin/zsh -lc 'echo hi'` → `echo hi`.
    static func stripShell(_ c: String) -> String {
        for prefix in ["/bin/zsh -lc ", "/bin/bash -lc ", "bash -lc ", "zsh -lc ", "/bin/sh -c "] where c.hasPrefix(prefix) {
            var rest = String(c.dropFirst(prefix.count))
            if rest.count >= 2, let f = rest.first, (f == "'" || f == "\""), rest.last == f { rest = String(rest.dropFirst().dropLast()) }
            return rest
        }
        return c
    }
}

// MARK: - Gemini `-o stream-json`

/// One NDJSON line of `gemini -p … -o stream-json` → chat events
/// (`init`, `message` (delta), `tool_use`, `tool_result`, `error`, `result`).
public enum GeminiChatStream {
    public static func events(fromLine line: String) -> [ChatEvent] {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{"), let v = try? JSONValue.parse(t) else { return [] }
        switch v["type"]?.string {
        case "init":
            return [.started(model: v["model"]?.string, sessionID: v["session_id"]?.string)]
        case "message":
            guard v["role"]?.string == "assistant", let c = v["content"]?.string else { return [] }
            return [v["delta"]?.bool == true ? .textDelta(c) : .text(c)]
        case "thought", "thinking":
            let c = v["content"]?.string ?? v["subject"]?.string ?? ""
            return c.isEmpty ? [] : [.thinkingDelta(c)]
        case "tool_use":
            return [.toolUse(id: v["tool_id"]?.string ?? "", name: toolName(v["tool_name"]?.string ?? "tool"),
                             input: v["parameters"] ?? .object([:]))]
        case "tool_result":
            let out = v["output"]?.string ?? v["error"]?["message"]?.string ?? ""
            return [.toolResult(id: v["tool_id"]?.string ?? "", output: out, isError: v["status"]?.string == "error")]
        case "error":
            guard v["severity"]?.string == "error" else { return [] }
            return [.text("⚠️ " + (v["message"]?.string ?? "Error"))]
        case "result":
            let ok = v["status"]?.string != "error"
            return [.result(text: ok ? "" : (v["error"]?["message"]?.string ?? "Gemini failed"), sessionID: nil, costUSD: nil, isError: !ok)]
        default:
            return []
        }
    }

    /// Gemini tool names → the Claude Code names the tool cards know.
    static func toolName(_ n: String) -> String {
        switch n {
        case "run_shell_command": return "Bash"
        case "read_file", "read_many_files": return "Read"
        case "write_file": return "Write"
        case "replace", "edit": return "Edit"
        case "glob": return "Glob"
        case "search_file_content", "grep": return "Grep"
        case "google_web_search", "web_search": return "WebSearch"
        case "web_fetch": return "WebFetch"
        case "list_directory": return "LS"
        case "write_todos": return "TodoWrite"
        default: return n
        }
    }
}

// MARK: - OpenCode `run --format json`

/// One JSON line of `opencode run --format json` → chat events (`text`, `reasoning`, `tool_use`, `step_finish`, `error`).
public enum OpenCodeChatStream {
    public static func events(fromLine line: String) -> [ChatEvent] {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{"), let v = try? JSONValue.parse(t) else { return [] }
        let part = v["part"] ?? v
        let session = v["sessionID"]?.string ?? part["sessionID"]?.string
        switch v["type"]?.string {
        case "step_start":
            return [.started(model: nil, sessionID: session)]
        case "text":
            return (part["text"]?.string).map { [.text($0)] } ?? []
        case "reasoning":
            return (part["text"]?.string).map { [.thinking($0)] } ?? []
        case "tool_use":
            let id = part["callID"]?.string ?? part["id"]?.string ?? ""
            let name = GeminiChatStream.toolName(part["tool"]?.string ?? "tool")
            let state = part["state"]
            var out: [ChatEvent] = [.toolUse(id: id, name: name == "bash" ? "Bash" : name, input: state?["input"] ?? .object([:]))]
            if let status = state?["status"]?.string, status == "completed" || status == "error" {
                out.append(.toolResult(id: id, output: state?["output"]?.string ?? state?["error"]?.string ?? "", isError: status == "error"))
            }
            return out
        case "error":
            return [.result(text: v["error"]?["data"]?["message"]?.string ?? v["error"]?["message"]?.string ?? "OpenCode error",
                            sessionID: session, costUSD: nil, isError: true)]
        default:
            return []
        }
    }
}

// MARK: - Runner

/// Runs a chat CLI, feeds its stdout line by line through `parse` and reports events on the main actor.
/// Cancelling the calling task terminates the process. The result is the last `.result` event, or a reply
/// built from the exit status when the CLI doesn't send one.
public enum CLIChatRunner {
    public static func run(executable: String, arguments: [String], environment: [String: String], cwd: String,
                           parse: @escaping @Sendable (String) -> [ChatEvent],
                           onEvent: @escaping @MainActor (ChatEvent) -> Void) async -> Result<ClaudePrint.Reply, Error> {
        #if os(macOS) || os(Linux)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        p.environment = environment
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        let state = StreamState()
        let started = Date()
        let name = URL(fileURLWithPath: executable).lastPathComponent
        out.fileHandleForReading.readabilityHandler = { h in
            for line in state.feed(h.availableData) {
                for e in parse(line) { state.note(e); state.sawEvent(); Task { @MainActor in onEvent(e) } }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in state.appendError(h.availableData) }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Result<ClaudePrint.Reply, Error>, Never>) in
                p.terminationHandler = { proc in
                    out.fileHandleForReading.readabilityHandler = nil
                    err.fileHandleForReading.readabilityHandler = nil
                    let rest = out.fileHandleForReading.readDataToEndOfFile()
                    for line in state.feed(rest + Data([0x0A])) {
                        for e in parse(line) { state.note(e); state.sawEvent(); Task { @MainActor in onEvent(e) } }
                    }
                    Log.info("\(name) finished in \(String(format: "%.1f", Date().timeIntervalSince(started))) s (status \(proc.terminationStatus))", category: "agents")
                    if proc.terminationReason == .uncaughtSignal {
                        c.resume(returning: .failure(ClaudePrint.Failure(description: "Stopped")))
                    } else if let r = state.reply {
                        c.resume(returning: r.isError ? .failure(ClaudePrint.Failure(description: r.text.isEmpty ? "\(name) reported an error" : r.text)) : .success(r))
                    } else if proc.terminationStatus == 0 && state.events > 0 {
                        c.resume(returning: .success(ClaudePrint.Reply(text: "", sessionID: nil, isError: false, costUSD: nil)))
                    } else {
                        let e = state.errorText.trimmingCharacters(in: .whitespacesAndNewlines)
                        c.resume(returning: .failure(ClaudePrint.Failure(description: e.isEmpty ? "\(name) exited with status \(proc.terminationStatus)" : String(e.suffix(800)))))
                    }
                }
                do { try p.run() } catch {
                    c.resume(returning: .failure(ClaudePrint.Failure(description: "Couldn't start \(name): \(error.localizedDescription)")))
                }
            }
        } onCancel: {
            if p.isRunning { p.terminate() }
        }
        #else
        return .failure(ClaudePrint.Failure(description: "Coding-agent CLIs run on the Mac or a Based server."))
        #endif
    }
}
