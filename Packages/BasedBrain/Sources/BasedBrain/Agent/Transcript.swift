import Foundation
import BasedCore

/// A structured view of a session transcript (stored as Markdown with `**Role**` headers in the session page),
/// used by the Claude-Code-style session UI.
public struct TranscriptItem: Identifiable, Sendable, Equatable {
    public enum Kind: String, Sendable { case user, agent, thought, tool, plan, notice, error, system }
    public var id: Int
    public var kind: Kind
    public var text: String
    /// Tool calls: "execute", "edit", "read", … and their output (merged from the following "Tool result").
    public var toolKind: String?
    public var output: String?
    public var failed = false
}

public enum TranscriptParser {
    static let roles: [String: TranscriptItem.Kind] = [
        "you": .user, "user": .user, "agent": .agent, "assistant": .agent, "thought": .thought, "thinking": .thought,
        "tool": .tool, "tool result": .tool, "tool failed": .tool, "plan": .plan, "notice": .notice, "error": .error, "system": .system,
    ]

    public static func parse(_ markdown: String) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var role: String?
        var buf: [String] = []
        func flush() {
            defer { buf = [] }
            guard let r = role else { return }
            var text = buf.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let key = r.lowercased()
            if key == "tool result" || key == "tool failed" {
                if text.hasPrefix("```") {
                    var lines = text.components(separatedBy: "\n")
                    lines.removeFirst()
                    if lines.last?.hasPrefix("```") == true { lines.removeLast() }
                    text = lines.joined(separator: "\n")
                }
                if let i = items.lastIndex(where: { $0.kind == .tool && $0.output == nil }) {
                    items[i].output = text
                    items[i].failed = key == "tool failed"
                    return
                }
                items.append(TranscriptItem(id: items.count, kind: .tool, text: "Result", toolKind: nil, output: text, failed: key == "tool failed"))
                return
            }
            guard let kind = roles[key] else {
                items.append(TranscriptItem(id: items.count, kind: .agent, text: text))
                return
            }
            if kind == .tool {
                // "`execute` Bash(ls)"
                var toolKind: String?
                if text.hasPrefix("`"), let end = text.dropFirst().firstIndex(of: "`") {
                    toolKind = String(text[text.index(after: text.startIndex)..<end])
                    text = String(text[text.index(after: end)...]).trimmingCharacters(in: .whitespaces)
                }
                items.append(TranscriptItem(id: items.count, kind: .tool, text: text, toolKind: toolKind))
                return
            }
            guard !text.isEmpty else { return }
            // Consecutive agent chunks belong together.
            if kind == .agent, let last = items.last, last.kind == .agent {
                items[items.count - 1].text += "\n\n" + text
                return
            }
            items.append(TranscriptItem(id: items.count, kind: kind, text: text))
        }
        for line in markdown.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("**"), t.hasSuffix("**"), t.count > 4, t.count < 40 {
                let name = String(t.dropFirst(2).dropLast(2))
                if roles[name.lowercased()] != nil {
                    flush()
                    role = name
                    continue
                }
            }
            buf.append(line)
        }
        flush()
        return items
    }
}
