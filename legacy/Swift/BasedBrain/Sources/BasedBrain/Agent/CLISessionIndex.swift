import Foundation
import BasedCore

/// A conversation recorded by a coding-agent CLI on this machine (Claude Code, Codex), indexed read-only
/// so Based can show every chat of a project in one place and resume it.
public struct CLISession: Identifiable, Sendable, Hashable {
    public var id: String
    public var tool: String              // "claude" | "codex"
    public var title: String
    public var cwd: String
    public var file: String
    public var startedAt: Date?
    public var updatedAt: Date
    public var gitBranch: String?
    public var sizeBytes: Int

    public var project: String { cwd.isEmpty ? "Unknown" : URL(fileURLWithPath: cwd).lastPathComponent }

    /// Shell command that continues this conversation in its directory.
    public var resumeCommand: String {
        let dir = cwd.isEmpty ? "~" : "'" + cwd.replacingOccurrences(of: "'", with: "'\\''") + "'"
        switch tool {
        case "codex": return "cd \(dir) && codex resume \(id)"
        default: return "cd \(dir) && claude --resume \(id)"
        }
    }
}

public struct CLIMessage: Identifiable, Sendable, Hashable {
    public enum Role: String, Sendable { case user, assistant, tool, toolResult, thinking, summary }
    public var id: Int
    public var role: Role
    public var text: String
    public var toolName: String?
    public var date: Date?
}

public enum CLISessionIndex {
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoPlain = ISO8601DateFormatter()
    static let lock = NSLock()
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        lock.lock(); defer { lock.unlock() }
        return iso.date(from: s) ?? isoPlain.date(from: s)
    }

    /// All sessions, newest first. Reads only the head/tail of each file, so it stays fast for big histories.
    public static func scan(home: String = NSHomeDirectory(), limit: Int = 400) -> [CLISession] {
        var out: [CLISession] = []
        out += scanClaude(root: URL(fileURLWithPath: home).appendingPathComponent(".claude/projects"))
        out += scanCodex(root: URL(fileURLWithPath: home).appendingPathComponent(".codex/sessions"))
        return Array(out.sorted { $0.updatedAt > $1.updatedAt }.prefix(limit))
    }

    static func files(under root: URL, matching: (URL) -> Bool) -> [(URL, Date, Int)] {
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) else { return [] }
        var out: [(URL, Date, Int)] = []
        for case let u as URL in e where matching(u) {
            let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            out.append((u, v?.contentModificationDate ?? .distantPast, v?.fileSize ?? 0))
        }
        return out
    }

    static func head(_ url: URL, bytes: Int = 96 * 1024) -> [String] {
        guard let h = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? h.close() }
        let d = (try? h.read(upToCount: bytes)) ?? Data()
        var lines = String(decoding: d, as: UTF8.self).components(separatedBy: "\n")
        if d.count == bytes { lines.removeLast() }   // last line is probably cut
        return lines
    }

    static func tail(_ url: URL, bytes: Int = 16 * 1024) -> [String] {
        guard let h = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        let start = size > UInt64(bytes) ? size - UInt64(bytes) : 0
        try? h.seek(toOffset: start)
        let d = (try? h.readToEnd()) ?? Data()
        var lines = String(decoding: d, as: UTF8.self).components(separatedBy: "\n")
        if start > 0, !lines.isEmpty { lines.removeFirst() }
        return lines
    }

    /// Plain text of a Claude/Codex message `content` (string or blocks).
    static func text(_ content: JSONValue?) -> String {
        guard let content else { return "" }
        if let s = content.string { return s }
        return (content.array ?? []).compactMap { b -> String? in
            switch b["type"]?.string ?? "" {
            case "text", "input_text", "output_text": return b["text"]?.string
            default: return nil
            }
        }.joined(separator: "\n")
    }

    static func isNoise(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || t.hasPrefix("<command-") || t.hasPrefix("<local-command") || t.hasPrefix("Caveat:") ||
            t.hasPrefix("<environment_context>") || t.hasPrefix("<user_instructions>") || t.hasPrefix("[Request interrupted")
    }

    static func titleLine(_ s: String) -> String {
        let one = s.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? s
        return one.count > 90 ? String(one.prefix(87)) + "…" : one
    }

    // MARK: Claude Code — ~/.claude/projects/<encoded cwd>/<session>.jsonl

    static func scanClaude(root: URL) -> [CLISession] {
        files(under: root) { $0.pathExtension == "jsonl" }.compactMap { (url, mtime, size) in
            var id = url.deletingPathExtension().lastPathComponent
            var cwd = "", title = "", summary = "", branch: String?
            var started: Date?, updated: Date?
            for line in head(url) {
                guard let v = try? JSONValue.parse(line) else { continue }
                if let s = v["sessionId"]?.string, !s.isEmpty { id = s }
                if cwd.isEmpty, let c = v["cwd"]?.string { cwd = c }
                if branch == nil, let b = v["gitBranch"]?.string, !b.isEmpty { branch = b }
                if started == nil { started = date(v["timestamp"]?.string) }
                if v["type"]?.string == "summary", summary.isEmpty, let s = v["summary"]?.string { summary = s }
                if title.isEmpty, v["type"]?.string == "user", v["isMeta"]?.bool != true, v["isSidechain"]?.bool != true {
                    let t = text(v["message"]?["content"])
                    if !isNoise(t) { title = titleLine(t) }
                }
            }
            for line in tail(url).reversed() {
                if let v = try? JSONValue.parse(line), let d = date(v["timestamp"]?.string) { updated = d; break }
            }
            guard started != nil || !title.isEmpty || !summary.isEmpty else { return nil }
            return CLISession(id: id, tool: "claude", title: !summary.isEmpty ? summary : (title.isEmpty ? "Claude Code session" : title),
                              cwd: cwd, file: url.path, startedAt: started, updatedAt: updated ?? mtime, gitBranch: branch, sizeBytes: size)
        }
    }

    // MARK: Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

    static func scanCodex(root: URL) -> [CLISession] {
        files(under: root) { $0.pathExtension == "jsonl" && $0.lastPathComponent.hasPrefix("rollout-") }.compactMap { (url, mtime, size) in
            var id = "", cwd = "", title = ""
            var started: Date?
            for line in head(url) {
                guard let v = try? JSONValue.parse(line) else { continue }
                let p = v["payload"] ?? v
                if v["type"]?.string == "session_meta" || p["id"] != nil && p["cwd"] != nil {
                    if id.isEmpty { id = p["id"]?.string ?? "" }
                    if cwd.isEmpty { cwd = p["cwd"]?.string ?? "" }
                    if started == nil { started = date(p["timestamp"]?.string ?? v["timestamp"]?.string) }
                }
                if cwd.isEmpty, let c = p["cwd"]?.string { cwd = c }
                if title.isEmpty, p["type"]?.string == "message", p["role"]?.string == "user" {
                    let t = text(p["content"])
                    if !isNoise(t) { title = titleLine(t) }
                }
            }
            if id.isEmpty {
                // rollout-2025-01-01T10-00-00-<uuid>.jsonl
                let name = url.deletingPathExtension().lastPathComponent
                id = String(name.suffix(36))
            }
            return CLISession(id: id, tool: "codex", title: title.isEmpty ? "Codex session" : title, cwd: cwd, file: url.path,
                              startedAt: started, updatedAt: mtime, gitBranch: nil, sizeBytes: size)
        }
    }

    // MARK: Transcript

    /// Messages of a session (whole file; capped at `limit` most recent).
    public static func transcript(of s: CLISession, limit: Int = 1500) -> [CLIMessage] {
        guard let data = FileManager.default.contents(atPath: s.file) else { return [] }
        var out: [CLIMessage] = []
        var n = 0
        func add(_ role: CLIMessage.Role, _ text: String, tool: String? = nil, date: Date?) {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty || role == .tool else { return }
            out.append(CLIMessage(id: n, role: role, text: t, toolName: tool, date: date)); n += 1
        }
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            guard let v = try? JSONValue.parse(String(raw)) else { continue }
            if s.tool == "codex" {
                let p = v["payload"] ?? v
                let d = date(v["timestamp"]?.string)
                switch p["type"]?.string ?? "" {
                case "message":
                    let t = text(p["content"])
                    if p["role"]?.string == "user" { if !isNoise(t) { add(.user, t, date: d) } } else if p["role"]?.string == "assistant" { add(.assistant, t, date: d) }
                case "reasoning":
                    add(.thinking, (p["summary"]?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n"), date: d)
                case "function_call", "local_shell_call", "custom_tool_call":
                    let args = p["arguments"]?.string ?? p["input"]?.string ?? ""
                    var detail = args
                    if let j = try? JSONValue.parse(args), let cmd = j["command"] {
                        detail = cmd.stringArray?.joined(separator: " ") ?? cmd.string ?? args
                    }
                    add(.tool, detail, tool: p["name"]?.string ?? "shell", date: d)
                case "function_call_output", "custom_tool_call_output":
                    var o = p["output"]?.string ?? ""
                    if let j = try? JSONValue.parse(o), let inner = j["output"]?.string { o = inner }
                    add(.toolResult, String(o.prefix(4000)), date: d)
                default: break
                }
                continue
            }
            let d = date(v["timestamp"]?.string)
            switch v["type"]?.string ?? "" {
            case "summary": add(.summary, v["summary"]?.string ?? "", date: d)
            case "user":
                guard v["isMeta"]?.bool != true else { continue }
                let content = v["message"]?["content"]
                if let blocks = content?.array, blocks.contains(where: { $0["type"]?.string == "tool_result" }) {
                    for b in blocks where b["type"]?.string == "tool_result" {
                        add(.toolResult, String(ClaudeStream.resultText(b["content"]).prefix(4000)), date: d)
                    }
                } else {
                    let t = text(content)
                    if !isNoise(t) { add(.user, t, date: d) }
                }
            case "assistant":
                for b in v["message"]?["content"]?.array ?? [] {
                    switch b["type"]?.string ?? "" {
                    case "text": add(.assistant, b["text"]?.string ?? "", date: d)
                    case "thinking": add(.thinking, b["thinking"]?.string ?? "", date: d)
                    case "tool_use":
                        let name = b["name"]?.string ?? "tool"
                        add(.tool, ClaudeStream.title(of: name, input: b["input"] ?? .object([:])), tool: name, date: d)
                    default: break
                    }
                }
            default: break
            }
        }
        return Array(out.suffix(limit))
    }

    /// Sessions grouped by working directory, most recently active project first.
    public static func byProject(_ sessions: [CLISession]) -> [(cwd: String, sessions: [CLISession])] {
        let groups = Dictionary(grouping: sessions, by: \.cwd)
        return groups.map { ($0.key, $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { ($0.sessions.first?.updatedAt ?? .distantPast) > ($1.sessions.first?.updatedAt ?? .distantPast) }
    }
}
