import Foundation

/// Claude-Code-style prompt helpers for the session console: slash commands, `@file` mentions and tool headers.
public enum ConsoleCompletion {
    public struct Command: Sendable, Equatable, Identifiable {
        public var name: String          // without "/"
        public var summary: String
        public var argument: String?     // placeholder shown after the name, e.g. "<task>"
        /// Handled by Based itself; everything else is sent to the agent as typed.
        public var local: Bool
        public var id: String { name }
        public init(_ name: String, _ summary: String, argument: String? = nil, local: Bool = true) {
            self.name = name; self.summary = summary; self.argument = argument; self.local = local
        }
    }

    public static let commands: [Command] = [
        Command("help", "Show commands and shortcuts"),
        Command("status", "Agent, model, folder, permission mode and session ids"),
        Command("cost", "Tokens used in this session"),
        Command("clear", "Clear the screen (the transcript stays in the session page)"),
        Command("spawn", "Start a sub-agent in this folder with a task", argument: "<task>"),
        Command("subagent", "New sub-agent… (pick agent and folder)"),
        Command("agents", "Show all agents on the canvas"),
        Command("board", "Show sessions as a Kanban board"),
        Command("mode", "Switch permission mode (default, acceptEdits, plan, bypassPermissions)", argument: "[mode]"),
        Command("terminal", "Toggle the interactive terminal"),
        Command("stop", "Stop the agent process"),
        Command("compact", "Ask the agent to compact its context", local: false),
        Command("review", "Ask the agent to review the current changes", local: false),
        Command("init", "Ask the agent to write a CLAUDE.md / AGENTS.md for this folder", local: false),
    ]

    /// Commands matching a prompt that is still being typed as "/name" (no space yet).
    public static func commandMatches(_ input: String) -> [Command] {
        guard input.hasPrefix("/"), !input.contains(" "), !input.contains("\n") else { return [] }
        let q = input.dropFirst().lowercased()
        let prefix = commands.filter { $0.name.hasPrefix(q) }
        let rest = q.isEmpty ? [] : commands.filter { !$0.name.hasPrefix(q) && $0.name.contains(q) }
        return prefix + rest
    }

    /// "/spawn fix the tests" → ("spawn", "fix the tests"); nil when the text is not a slash command.
    public static func parseCommand(_ text: String) -> (name: String, argument: String)? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("/"), t.count > 1, !t.hasPrefix("//") else { return nil }
        let body = t.dropFirst()
        let name = body.prefix { !$0.isWhitespace }
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ":" }) else { return nil }
        let arg = body.dropFirst(name.count).trimmingCharacters(in: .whitespacesAndNewlines)
        return (String(name).lowercased(), arg)
    }

    // MARK: @file mentions

    /// The partial path after the last "@" when the cursor (end of input) is still inside that mention.
    public static func mentionQuery(_ input: String) -> String? {
        guard let at = input.lastIndex(of: "@") else { return nil }
        if at > input.startIndex {
            let before = input[input.index(before: at)]
            guard before.isWhitespace else { return nil }   // e-mail addresses, "a@b"
        }
        let q = input[input.index(after: at)...]
        guard !q.contains(where: \.isWhitespace) else { return nil }
        return String(q)
    }

    /// Replaces the trailing "@query" with "@path ".
    public static func applyMention(_ path: String, to input: String) -> String {
        guard mentionQuery(input) != nil, let at = input.lastIndex(of: "@") else { return input }
        return String(input[..<at]) + "@" + path + " "
    }

    public static let skippedFolders: Set<String> = [".git", "node_modules", ".build", "DerivedData", "Pods", ".swiftpm", "build", "dist", ".next", ".venv", "venv", "__pycache__", ".idea", ".gradle", "target"]

    /// Relative paths of files (and folders, with a trailing "/") below `root`, skipping build output and VCS folders.
    public static func files(in root: String, limit: Int = 4000) -> [String] {
        let base = URL(fileURLWithPath: root).standardizedFileURL
        let fm = FileManager.default
        var out: [String] = []
        var queue: [(URL, String)] = [(base, "")]
        while !queue.isEmpty, out.count < limit {
            let (dir, rel) = queue.removeFirst()
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { continue }
            for name in names.sorted() where !name.hasPrefix(".") || name == ".github" {
                guard out.count < limit else { break }
                let url = dir.appendingPathComponent(name)
                let path = rel.isEmpty ? name : rel + "/" + name
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else { continue }
                if isDir.boolValue {
                    if skippedFolders.contains(name) || name.hasSuffix(".xcodeproj") || name.hasSuffix(".xcworkspace") { continue }
                    out.append(path + "/")
                    queue.append((url, path))
                } else {
                    out.append(path)
                }
            }
        }
        return out
    }

    /// Best matches for a mention query: file-name prefix, then path contains, then fuzzy subsequence; shorter paths first.
    public static func rank(_ files: [String], query: String, limit: Int = 8) -> [String] {
        let q = query.lowercased()
        guard !q.isEmpty else { return Array(files.filter { !$0.dropLast().contains("/") }.prefix(limit)) }
        func score(_ f: String) -> Int? {
            let lower = f.lowercased()
            let trimmed = lower.hasSuffix("/") ? String(lower.dropLast()) : lower
            let name = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
            if name == q { return 0 }
            if name.hasPrefix(q) { return 1 }
            if lower.hasPrefix(q) { return 2 }
            if name.contains(q) { return 3 }
            if lower.contains(q) { return 4 }
            var it = lower.makeIterator()
            for c in q { var found = false; while let n = it.next() { if n == c { found = true; break } }; if !found { return nil } }
            return 5
        }
        var scored: [(path: String, score: Int)] = []
        for f in files { if let s = score(f) { scored.append((f, s)) } }
        scored.sort { a, b in
            if a.score != b.score { return a.score < b.score }
            if a.path.count != b.path.count { return a.path.count < b.path.count }
            return a.path < b.path
        }
        return scored.prefix(limit).map { $0.path }
    }

    // MARK: Tool headers

    /// "Bash(ls -la)" stays as is; a bare argument gets the tool name in front: ("Read", "Sources/a.swift").
    public static func toolHeader(kind: String?, text: String) -> (name: String, argument: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = t.firstIndex(of: "("), t.hasSuffix(")"), open > t.startIndex {
            let name = t[..<open]
            if name.count <= 48, name.first?.isLetter == true,
               name.allSatisfy({ $0.isLetter || $0.isNumber || " :_-.".contains($0) }) {
                return (String(name), String(t[t.index(after: open)..<t.index(before: t.endIndex)]))
            }
        }
        if !t.isEmpty, !t.contains(where: \.isWhitespace), t.first?.isUppercase == true, t.allSatisfy({ $0.isLetter || $0.isNumber || $0 == ":" }) {
            return (t, "")   // just a tool name ("TodoWrite")
        }
        return (toolName(kind), t)
    }

    public static func toolName(_ kind: String?) -> String {
        switch kind {
        case "execute"?: return "Bash"
        case "edit"?: return "Update"
        case "read"?: return "Read"
        case "search"?: return "Search"
        case "fetch"?: return "Fetch"
        case "delete"?: return "Delete"
        case "move"?: return "Move"
        case "think"?: return "Think"
        case "agent"?: return "Agent"
        case let k?: return k.prefix(1).uppercased() + k.dropFirst()
        case nil: return "Tool"
        }
    }

    /// The sub-agent session id in notices like "Started sub-agent **x** (Claude Code, session abc)."
    public static func sessionReference(in text: String) -> String? {
        guard let r = text.range(of: "session ", options: .backwards) else { return nil }
        let id = text[r.upperBound...].prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return id.count >= 6 ? String(id) : nil
    }

    /// Model name from a "Model: claude-…" notice (Claude Code init event).
    public static func model(fromNotices notices: [String]) -> String? {
        for n in notices.reversed() {
            for line in n.components(separatedBy: "\n") {
                let l = line.trimmingCharacters(in: .whitespaces)
                if let r = l.range(of: "Model: ") {
                    let m = l[r.upperBound...].prefix { !$0.isWhitespace && $0 != "," && $0 != "·" }
                    if !m.isEmpty { return String(m) }
                }
            }
        }
        return nil
    }
}
