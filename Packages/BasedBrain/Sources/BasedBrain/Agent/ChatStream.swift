import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Events

/// What a chat engine reports while it works — the same vocabulary for Claude Code (`stream-json`),
/// the API tool loop (`AgentRuntime`) and saved transcripts, so one UI renders all of them.
public enum ChatEvent: Sendable, Equatable {
    case started(model: String?, sessionID: String?)
    /// Partial output while a block is streaming.
    case thinkingDelta(String)
    case textDelta(String)
    /// A finished block (replaces the partial one built from deltas).
    case thinking(String)
    case text(String)
    case toolUse(id: String, name: String, input: JSONValue)
    case toolResult(id: String, output: String, isError: Bool)
    /// A screenshot / image a tool returned (browser use, computer use, image tools).
    case toolImage(id: String, data: Data, mediaType: String)
    case result(text: String, sessionID: String?, costUSD: Double?, isError: Bool)
}

public struct TodoItem: Sendable, Equatable, Identifiable {
    public enum Status: String, Sendable { case pending, inProgress = "in_progress", completed }
    public var id: String
    public var title: String
    public var activeForm: String?
    public var status: Status
    public init(id: String, title: String, activeForm: String? = nil, status: Status) {
        self.id = id; self.title = title; self.activeForm = activeForm; self.status = status
    }
}

/// One rendered piece of an assistant turn: a thinking block, Markdown text, a tool call or the to-do list.
public struct ChatPart: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case thinking, text, tool, todos }
    public enum Status: String, Sendable { case running, done, failed }
    public var id: String
    public var kind: Kind
    public var text: String = ""
    /// Tools: raw name ("Read", "Bash", "mcp__based__search") and a short argument ("Sources/App.swift").
    public var toolName: String = ""
    public var detail: String = ""
    public var output: String?
    /// Images returned by the tool (newest last, at most 4 kept).
    public var images: [Data] = []
    public var status: Status = .done
    public var todos: [TodoItem] = []
    /// Built from deltas; replaced when the finished block arrives.
    public var provisional = false
    public var started = Date()
    public var finished: Date?
    /// Edit / Write / MultiEdit: unified diff of the change (shown like Claude Code's diff view).
    public var diff: String?
    public var added = 0
    public var removed = 0

    public init(id: String, kind: Kind, text: String = "", status: Status = .done) {
        self.id = id; self.kind = kind; self.text = text; self.status = status
    }

    public var duration: TimeInterval? { finished.map { $0.timeIntervalSince(started) } }
}

// MARK: - Turn builder

/// Folds events into the parts of one assistant turn.
public struct ChatTurnBuilder: Sendable, Equatable {
    public private(set) var parts: [ChatPart] = []
    public private(set) var sessionID: String?
    public private(set) var model: String?
    public private(set) var costUSD: Double?
    public private(set) var finalText: String?
    public private(set) var isError = false
    private var counter = 0
    /// Tasks created by TaskCreate get ids 1, 2, 3 … like Claude Code.
    private var tasks: [TodoItem] = []

    public init() {}

    private mutating func nextID(_ prefix: String) -> String { counter += 1; return "\(prefix)\(counter)" }

    /// The answer text (all text parts), used for the saved transcript and copy.
    public var text: String {
        if let finalText, !finalText.isEmpty, !parts.contains(where: { $0.kind == .text && !$0.text.isEmpty }) { return finalText }
        return parts.filter { $0.kind == .text }.map(\.text).joined(separator: "\n\n")
    }

    /// Adds a finished part (reopened transcripts, error notes).
    public mutating func restore(_ part: ChatPart) {
        var p = part
        p.provisional = false
        if p.status == .running { p.status = .done }
        if parts.contains(where: { $0.id == p.id }) { p.id = nextID("r") }
        parts.append(p)
    }

    public var isThinking: Bool { parts.last?.kind == .thinking && parts.last?.status == .running }

    public mutating func apply(_ e: ChatEvent) {
        switch e {
        case .started(let m, let s):
            model = m ?? model; sessionID = s ?? sessionID
        case .thinkingDelta(let d):
            if let i = parts.indices.last, parts[i].kind == .thinking, parts[i].provisional { parts[i].text += d }
            else {
                var p = ChatPart(id: nextID("th"), kind: .thinking, text: d, status: .running); p.provisional = true
                parts.append(p)
            }
        case .textDelta(let d):
            closeThinking()
            if let i = parts.indices.last, parts[i].kind == .text, parts[i].provisional { parts[i].text += d }
            else {
                var p = ChatPart(id: nextID("tx"), kind: .text, text: d, status: .running); p.provisional = true
                parts.append(p)
            }
        case .thinking(let t):
            if let i = lastProvisional(.thinking) { parts[i].text = t; parts[i].provisional = false; finish(i) }
            else {
                var p = ChatPart(id: nextID("th"), kind: .thinking, text: t); p.finished = Date()
                parts.append(p)
            }
        case .text(let t):
            closeThinking()
            if let i = lastProvisional(.text) { parts[i].text = t; parts[i].provisional = false; finish(i) }
            else if !t.isEmpty { parts.append(ChatPart(id: nextID("tx"), kind: .text, text: t)) }
        case .toolUse(let id, let name, let input):
            closeThinking()
            closeProvisionalText()
            if let todos = todoUpdate(name: name, input: input) {
                if let i = parts.lastIndex(where: { $0.kind == .todos }) { parts[i].todos = todos }
                else { var p = ChatPart(id: nextID("td"), kind: .todos); p.todos = todos; parts.append(p) }
                return
            }
            var p = ChatPart(id: id.isEmpty ? nextID("tl") : id, kind: .tool, status: .running)
            p.toolName = name
            p.detail = Self.summary(name: name, input: input)
            if let d = Self.diff(name: name, input: input) {
                p.diff = d
                let c = LineDiff.counts(LineDiff.ops(old: Self.oldText(name, input), new: Self.newText(name, input)))
                p.added = c.added; p.removed = c.removed
            }
            if !parts.contains(where: { $0.id == p.id }) { parts.append(p) }
        case .toolResult(let id, let output, let isError):
            guard let i = parts.firstIndex(where: { $0.id == id && $0.kind == .tool }) else { return }
            parts[i].output = output
            parts[i].status = isError ? .failed : .done
            parts[i].finished = Date()
        case .toolImage(let id, let data, _):
            guard let i = parts.lastIndex(where: { $0.id == id && $0.kind == .tool }) ?? parts.lastIndex(where: { $0.kind == .tool }) else { return }
            parts[i].images.append(data)
            if parts[i].images.count > 4 { parts[i].images.removeFirst(parts[i].images.count - 4) }
        case .result(let t, let s, let c, let err):
            finalText = t; sessionID = s ?? sessionID; costUSD = c ?? costUSD; isError = err
            closeThinking()
            for i in parts.indices where parts[i].status == .running {
                parts[i].status = parts[i].kind == .tool ? .done : .done
                parts[i].provisional = false
                if parts[i].finished == nil { parts[i].finished = Date() }
            }
            if !parts.contains(where: { $0.kind == .text && !$0.text.isEmpty }), !t.isEmpty, !err {
                parts.append(ChatPart(id: nextID("tx"), kind: .text, text: t))
            }
        }
    }

    private func lastProvisional(_ kind: ChatPart.Kind) -> Int? {
        parts.lastIndex { $0.kind == kind && $0.provisional }
    }

    private mutating func finish(_ i: Int) {
        parts[i].status = .done
        if parts[i].finished == nil { parts[i].finished = Date() }
    }

    private mutating func closeThinking() {
        if let i = parts.indices.last, parts[i].kind == .thinking, parts[i].status == .running { finish(i) }
    }

    private mutating func closeProvisionalText() {
        if let i = parts.indices.last, parts[i].kind == .text, parts[i].status == .running { finish(i) }
    }

    /// Unified diff for file-changing tools (Claude Code Edit / MultiEdit / Write, Codex apply_patch-like input).
    static func diff(name: String, input: JSONValue) -> String? {
        let base = name.components(separatedBy: "__").last ?? name
        guard ["Edit", "MultiEdit", "Write", "str_replace_based_edit_tool", "write_file", "replace"].contains(base) else { return nil }
        let old = oldText(name, input), new = newText(name, input)
        guard !(old.isEmpty && new.isEmpty), old != new else { return nil }
        return LineDiff.unified(old: old, new: new, context: 2)
    }

    static func oldText(_ name: String, _ input: JSONValue) -> String {
        if let edits = input["edits"]?.array { return edits.compactMap { $0["old_string"]?.string }.joined(separator: "\n") }
        return input["old_string"]?.string ?? input["old_str"]?.string ?? ""
    }

    static func newText(_ name: String, _ input: JSONValue) -> String {
        if let edits = input["edits"]?.array { return edits.compactMap { $0["new_string"]?.string }.joined(separator: "\n") }
        return input["new_string"]?.string ?? input["new_str"]?.string ?? input["content"]?.string ?? ""
    }

    /// TodoWrite (whole list) and TaskCreate / TaskUpdate (incremental) → the current to-do list.
    private mutating func todoUpdate(name: String, input: JSONValue) -> [TodoItem]? {
        func status(_ s: String?) -> TodoItem.Status {
            switch (s ?? "").lowercased() { case "completed", "done": return .completed; case "in_progress", "inprogress", "active": return .inProgress; default: return .pending }
        }
        switch name {
        case "TodoWrite":
            guard let list = input["todos"]?.array else { return nil }
            tasks = list.enumerated().map { i, t in
                TodoItem(id: t["id"]?.stringValue ?? "\(i + 1)", title: t["content"]?.string ?? t["subject"]?.string ?? "",
                         activeForm: t["activeForm"]?.string ?? t["active_form"]?.string, status: status(t["status"]?.string))
            }
            return tasks
        case "TaskCreate":
            let title = input["subject"]?.string ?? input["content"]?.string ?? input["description"]?.string ?? "Task"
            tasks.append(TodoItem(id: "\(tasks.count + 1)", title: title, activeForm: input["activeForm"]?.string ?? input["active_form"]?.string,
                                  status: status(input["status"]?.string)))
            return tasks
        case "TaskUpdate":
            let tid = input["taskId"]?.stringValue ?? input["task_id"]?.stringValue ?? input["id"]?.stringValue
            guard let tid, let i = tasks.firstIndex(where: { $0.id == tid }) else { return tasks.isEmpty ? nil : tasks }
            if let s = input["status"]?.string {
                if s == "deleted" { tasks.remove(at: i); return tasks }
                tasks[i].status = status(s)
            }
            if let sub = input["subject"]?.string { tasks[i].title = sub }
            if let af = input["activeForm"]?.string ?? input["active_form"]?.string { tasks[i].activeForm = af }
            return tasks
        case "TaskList", "TaskGet":
            return tasks.isEmpty ? nil : tasks
        default:
            return nil
        }
    }

    /// Short argument for a tool card: the file, command, pattern, URL or query.
    public static func summary(name: String, input: JSONValue) -> String {
        for key in ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description", "prompt", "title", "id", "page_id"] {
            if let v = input[key]?.stringValue, !v.isEmpty {
                var s = v.replacingOccurrences(of: "\n", with: " ")
                let home = NSHomeDirectory()
                if s.hasPrefix(home) { s = "~" + s.dropFirst(home.count) }
                return String(s.prefix(160))
            }
        }
        if case .object(let o) = input, let first = o.sorted(by: { $0.key < $1.key }).first?.value.stringValue { return String(first.prefix(160)) }
        return ""
    }
}

// MARK: - Claude Code stream-json

public enum ClaudeChatStream {
    /// One NDJSON line of `claude -p --output-format stream-json --verbose --include-partial-messages` → events.
    /// Sub-agent output (`parent_tool_use_id` set) is skipped; its parent tool card shows the result.
    public static func events(fromLine line: String) -> [ChatEvent] {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{"), let v = try? JSONValue.parse(t) else { return [] }
        if let parent = v["parent_tool_use_id"], !parent.isNull { return [] }
        switch v["type"]?.string {
        case "system":
            guard v["subtype"]?.string == "init" else { return [] }
            return [.started(model: v["model"]?.string, sessionID: v["session_id"]?.string)]
        case "stream_event":
            guard let ev = v["event"], ev["type"]?.string == "content_block_delta", let d = ev["delta"] else { return [] }
            switch d["type"]?.string {
            case "text_delta": return d["text"]?.string.map { [.textDelta($0)] } ?? []
            case "thinking_delta": return d["thinking"]?.string.map { [.thinkingDelta($0)] } ?? []
            default: return []
            }
        case "assistant":
            return (v["message"]?["content"]?.array ?? []).compactMap { b -> ChatEvent? in
                switch b["type"]?.string {
                case "thinking": return b["thinking"]?.string.map { .thinking($0) }
                case "text": return b["text"]?.string.map { .text($0) }
                case "tool_use": return .toolUse(id: b["id"]?.string ?? "", name: b["name"]?.string ?? "tool", input: b["input"] ?? .object([:]))
                default: return nil
                }
            }
        case "user":
            var out: [ChatEvent] = []
            for b in v["message"]?["content"]?.array ?? [] where b["type"]?.string == "tool_result" {
                let id = b["tool_use_id"]?.string ?? ""
                out.append(.toolResult(id: id, output: Self.text(of: b["content"]), isError: b["is_error"]?.bool ?? false))
                for img in b["content"]?.array ?? [] where img["type"]?.string == "image" {
                    guard let src = img["source"], src["type"]?.string == "base64", let b64 = src["data"]?.string,
                          let data = Data(base64Encoded: b64) else { continue }
                    out.append(.toolImage(id: id, data: data, mediaType: src["media_type"]?.string ?? "image/png"))
                }
            }
            return out
        case "result":
            return [.result(text: v["result"]?.string ?? "", sessionID: v["session_id"]?.string,
                            costUSD: v["total_cost_usd"]?.number ?? v["cost_usd"]?.number, isError: v["is_error"]?.bool ?? false)]
        default:
            return []
        }
    }

    static func text(of content: JSONValue?) -> String {
        guard let content else { return "" }
        if let s = content.string { return s }
        return (content.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
    }

    /// Splits a growing byte buffer into complete lines (keeps the unfinished tail).
    public static func takeLines(_ buffer: inout Data) -> [String] {
        var out: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            out.append(String(decoding: line, as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        return out
    }
}

// MARK: - Transcript round trip

public extension ChatTurnBuilder {
    /// Markdown sections for the saved chat (`**Thought**`, `**Tool**`, `**Tool result**`, `**Plan**`, `**Agent**`),
    /// read back by `TranscriptParser` / `parts(from:)` when the chat is reopened.
    var transcriptSections: [(role: String, markdown: String)] {
        var out: [(String, String)] = []
        for p in parts {
            switch p.kind {
            case .thinking where !p.text.isEmpty: out.append(("Thought", p.text))
            case .text where !p.text.isEmpty: out.append(("Agent", p.text))
            case .tool:
                out.append(("Tool", "`\(p.toolName)` \(p.detail)"))
                if let o = p.output { out.append((p.status == .failed ? "Tool failed" : "Tool result", "```\n" + String(o.prefix(4000)) + "\n```")) }
            case .todos:
                out.append(("Plan", p.todos.map { "- [\($0.status == .completed ? "x" : " ")] \($0.title)" }.joined(separator: "\n")))
            default: break
            }
        }
        return out
    }

    /// Saved transcript items of one assistant turn → parts.
    static func parts(from items: [TranscriptItem]) -> [ChatPart] {
        items.enumerated().compactMap { i, item in
            switch item.kind {
            case .thought: return ChatPart(id: "s\(i)", kind: .thinking, text: item.text)
            case .agent: return ChatPart(id: "s\(i)", kind: .text, text: item.text)
            case .tool:
                var p = ChatPart(id: "s\(i)", kind: .tool, status: item.failed ? .failed : .done)
                p.toolName = item.toolKind ?? "Tool"
                p.detail = item.text
                p.output = item.output
                return p
            case .plan:
                var p = ChatPart(id: "s\(i)", kind: .todos)
                p.todos = item.text.components(separatedBy: "\n").enumerated().compactMap { j, line in
                    let done = line.contains("[x]")
                    let title = line.replacingOccurrences(of: "- [x] ", with: "").replacingOccurrences(of: "- [ ] ", with: "").trimmingCharacters(in: .whitespaces)
                    return title.isEmpty ? nil : TodoItem(id: "\(j + 1)", title: title, status: done ? .completed : .pending)
                }
                return p
            case .error: return ChatPart(id: "s\(i)", kind: .text, text: "⚠️ " + item.text)
            default: return nil
            }
        }
    }
}

// MARK: - Artifacts

/// A self-contained result the chat shows in its own panel (like Claude's artifacts): an HTML page, an SVG,
/// a Mermaid diagram or a React component, taken from a fenced code block of an answer.
public struct ChatArtifact: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case html, svg, mermaid, react, markdown }
    public var id: String { kind.rawValue + ":" + String(source.hashValue) }
    public var kind: Kind
    public var title: String
    public var source: String

    public init(kind: Kind, title: String, source: String) { self.kind = kind; self.title = title; self.source = source }

    public static func kind(forLanguage lang: String?) -> Kind? {
        switch (lang ?? "").lowercased() {
        case "html", "htm": return .html
        case "svg": return .svg
        case "mermaid": return .mermaid
        case "jsx", "tsx", "react": return .react
        case "markdown", "md", "document", "doc": return .markdown
        default: return nil
        }
    }

    /// Artifact for a code block, if it is one: previewable language and more than a snippet
    /// (a 3-line HTML example in an explanation stays a code block).
    public static func from(language: String?, code: String) -> ChatArtifact? {
        guard let k = kind(forLanguage: language) else { return nil }
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false).count
        // A document is worth its own panel once it is more than a short snippet.
        if k == .markdown { return lines >= 8 ? ChatArtifact(kind: k, title: title(of: code, kind: k), source: code) : nil }
        guard lines >= 5 || code.lowercased().contains("<html") || code.lowercased().contains("<svg") || k == .mermaid else { return nil }
        return ChatArtifact(kind: k, title: title(of: code, kind: k), source: code)
    }

    /// All artifacts in an answer, in order.
    public static func extract(_ markdown: String) -> [ChatArtifact] {
        var out: [ChatArtifact] = []
        var lang: String?
        var buf: [String] = []
        var inFence = false
        for line in markdown.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") {
                if inFence {
                    if let a = from(language: lang, code: buf.joined(separator: "\n")) { out.append(a) }
                    inFence = false; buf = []; lang = nil
                } else {
                    inFence = true
                    lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                continue
            }
            if inFence { buf.append(line) }
        }
        return out
    }

    static func title(of code: String, kind: Kind) -> String {
        func between(_ a: String, _ b: String) -> String? {
            guard let r1 = code.range(of: a, options: .caseInsensitive), let r2 = code.range(of: b, options: .caseInsensitive, range: r1.upperBound..<code.endIndex) else { return nil }
            let s = code[r1.upperBound..<r2.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            return s.isEmpty ? nil : String(s.prefix(80))
        }
        switch kind {
        case .html:
            if let t = between("<title>", "</title>") { return t }
            if let h = between("<h1", "</h1>"), let gt = h.firstIndex(of: ">") { return String(h[h.index(after: gt)...]).trimmingCharacters(in: .whitespaces) }
            return "Web page"
        case .svg: return "Image (SVG)"
        case .mermaid:
            let first = code.split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
            return first.isEmpty ? "Diagram" : "Diagram · " + first.prefix(30)
        case .react:
            if let r = code.range(of: #"(function|const)\s+([A-Z][A-Za-z0-9]*)"#, options: .regularExpression) {
                return String(code[r]).components(separatedBy: .whitespaces).last ?? "Component"
            }
            return "Component"
        case .markdown:
            for line in code.split(separator: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("#") { return String(t.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces).prefix(80)) }
                if !t.isEmpty { return String(t.prefix(60)) }
            }
            return "Document"
        }
    }

    /// Full HTML document for the preview (React via React 18 + Babel standalone, SVG wrapped).
    public var document: String {
        switch kind {
        case .html:
            return source
        case .svg:
            return "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:transparent}svg{max-width:100%;height:auto}</style></head><body>\(source)</body></html>"
        case .mermaid, .markdown:
            return source
        case .react:
            var code = source
            // `export default function App` → render it.
            var name = "App"
            if let r = code.range(of: #"export\s+default\s+(function\s+)?([A-Z][A-Za-z0-9]*)"#, options: .regularExpression) {
                name = String(code[r]).components(separatedBy: .whitespaces).last ?? "App"
            }
            code = code.replacingOccurrences(of: #"export\s+default\s+"#, with: "", options: .regularExpression)
            code = code.replacingOccurrences(of: #"(?m)^import .*$"#, with: "", options: .regularExpression)
            return """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>body{margin:0;font-family:-apple-system,system-ui,sans-serif}</style></head>
            <body><div id="root"></div>
            <script type="text/babel" data-presets="react,typescript" data-type="module">
            const { useState, useEffect, useMemo, useRef, useCallback, useReducer } = React;
            \(code)
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(\(name)));
            </script></body></html>
            """
        }
    }
}
