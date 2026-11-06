import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

// Claude-style chat rendering in Based's look: user bubbles, assistant replies made of parts —
// collapsible thinking, compact tool cards, a to-do card, and Markdown with real code blocks / tables.

// MARK: - Turn

struct ChatTurnView: View {
    let turn: ChatTurn
    var compact = false

    var body: some View {
        if turn.role == .user {
            UserMessageView(turn: turn)
        } else {
            AssistantMessageView(turn: turn, compact: compact)
        }
    }
}

struct UserMessageView: View {
    let turn: ChatTurn
    @State private var hover = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !turn.attachments.isEmpty {
                HStack(spacing: 6) {
                    ForEach(turn.attachments, id: \.self) { AttachmentChip(name: $0) }
                }
            }
            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(.system(size: 14))
                    .textSelection(.enabled)
                    .lineSpacing(3)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.06)))
            }
            CopyButton(text: turn.text).opacity(hover ? 1 : 0)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

struct AssistantMessageView: View {
    let turn: ChatTurn
    var compact = false
    @State private var hover = false

    var body: some View {
        let parts = turn.reply.parts
        VStack(alignment: .leading, spacing: 10) {
            ForEach(groups(parts)) { g in
                switch g.kind {
                case .thinking: ThinkingView(part: g.parts[0])
                case .text: MarkdownMessageView(markdown: g.parts[0].text, streaming: g.parts[0].status == .running)
                case .todos: TodoCardView(todos: g.parts[0].todos)
                case .tool: ToolGroupView(parts: g.parts)
                }
            }
            if turn.isRunning && !turn.reply.isThinking && parts.last?.status != .running {
                ChatWorkingIndicator(label: parts.isEmpty ? "Thinking…" : "Working…")
            }
            if !turn.isRunning {
                HStack(spacing: 10) {
                    CopyButton(text: turn.reply.text)
                    if let meta = turn.meta { Text(meta).font(.system(size: 11)).foregroundStyle(Theme.secondary) }
                }
                .opacity(hover ? 1 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }

    struct Group: Identifiable { let id: String; let kind: ChatPart.Kind; var parts: [ChatPart] }

    /// Consecutive tool calls share one card (like Claude: "Ran 3 tools").
    private func groups(_ parts: [ChatPart]) -> [Group] {
        var out: [Group] = []
        for p in parts {
            if p.kind == .tool, let last = out.last, last.kind == .tool { out[out.count - 1].parts.append(p) }
            else { out.append(Group(id: p.id, kind: p.kind, parts: [p])) }
        }
        return out
    }
}

// MARK: - Thinking

struct ThinkingView: View {
    let part: ChatPart
    @State private var open = false

    var body: some View {
        let running = part.status == .running
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    AIGlyph(size: 13).foregroundStyle(running ? Color.accentColor : Theme.secondary)
                    if running { ShimmerText(text: "Thinking…") }
                    else { Text(label).foregroundStyle(Theme.secondary) }
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .foregroundStyle(Theme.secondary)
                }
                .font(.system(size: 13))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open || running {
                Text(running ? String(part.text.suffix(600)) : part.text)
                    .font(.system(size: 12.5))
                    .italic()
                    .foregroundStyle(Theme.secondary)
                    .lineSpacing(2)
                    .lineLimit(open ? nil : 3)
                    .textSelection(.enabled)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Color(Theme.divider)).frame(width: 2) }
            }
        }
    }

    private var label: String {
        guard let d = part.duration, d >= 1 else { return "Thought" }
        return "Thought for \(Int(d.rounded())) s"
    }
}

/// Text with a moving highlight while the model works.
struct ShimmerText: View {
    let text: String
    @State private var phase: CGFloat = -1

    var body: some View {
        Text(text)
            .foregroundStyle(Theme.secondary)
            .overlay {
                GeometryReader { g in
                    LinearGradient(colors: [.clear, Color.primary.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: g.size.width * 0.5)
                        .offset(x: phase * g.size.width)
                }
                .mask { Text(text) }
            }
            .onAppear { withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1.5 } }
    }
}

struct ChatWorkingIndicator: View {
    let label: String
    var body: some View {
        HStack(spacing: 6) {
            AIGlyph(size: 13).foregroundStyle(Color.accentColor)
            ShimmerText(text: label).font(.system(size: 13))
        }
    }
}

// MARK: - Tools

/// One card for consecutive tool calls: a header ("Read a.swift", "Ran 3 tools") and one row per call.
struct ToolGroupView: View {
    let parts: [ChatPart]
    @State private var open = false

    var body: some View {
        let running = parts.contains { $0.status == .running }
        VStack(alignment: .leading, spacing: 0) {
            if parts.count == 1 {
                ToolRowView(part: parts[0], standalone: true)
            } else {
                Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
                    HStack(spacing: 8) {
                        StatusIcon(status: running ? .running : (parts.contains { $0.status == .failed } ? .failed : .done))
                        Text(running ? "Working · \(parts.count) steps" : "Used \(parts.count) tools").font(.system(size: 13, weight: .medium))
                        Text(ToolStyle.names(parts)).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(open ? 90 : 0)).foregroundStyle(Theme.secondary)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open || running {
                    Divider()
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(open ? parts : Array(parts.suffix(3))) { ToolRowView(part: $0, standalone: false) }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.025)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(Theme.divider)))
    }
}

struct ToolRowView: View {
    let part: ChatPart
    var standalone: Bool
    @State private var open = false

    var body: some View {
        let style = ToolStyle(name: part.toolName)
        VStack(alignment: .leading, spacing: 6) {
            Button { if part.output?.isEmpty == false { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } } label: {
                HStack(spacing: 8) {
                    Group {
                        if style.symbol == SymbolImage.ai { AIGlyph(size: 13) } else { Image(systemName: style.symbol).font(.system(size: 12)) }
                    }
                    .frame(width: 16)
                    .foregroundStyle(Theme.secondary)
                    Text(style.verb(part.status)).font(.system(size: 13, weight: .medium))
                    Text(part.detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    StatusIcon(status: part.status)
                }
                .padding(.horizontal, 10).padding(.vertical, standalone ? 8 : 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(part.toolName)
            if open, let out = part.output, !out.isEmpty {
                ScrollView([.vertical, .horizontal]) {
                    Text(String(out.prefix(20_000)))
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(part.status == .failed ? Color.red : Theme.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(maxHeight: 260)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.04)))
                .padding(.horizontal, 10).padding(.bottom, 8)
            }
        }
    }
}

struct StatusIcon: View {
    let status: ChatPart.Status
    var body: some View {
        switch status {
        case .running: ProgressView().controlSize(.mini).frame(width: 14, height: 14)
        case .done: Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.green.opacity(0.8))
        case .failed: Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.red)
        }
    }
}

/// Icon and wording per tool: Claude Code tools, Based's own MCP tools, browser / computer use, sub-agents.
struct ToolStyle {
    let name: String
    private var base: String {
        if name.hasPrefix("mcp__") { return name.components(separatedBy: "__").last ?? name }
        return name
    }

    var isBrowser: Bool {
        let n = name.lowercased()
        return n.contains("browser") || n.contains("navigate") || n.contains("computer") || n.contains("chrome") || n.contains("screenshot")
    }

    var symbol: String {
        if isBrowser { return "safari" }
        if name.hasPrefix("mcp__based") || name.hasPrefix("based__") { return SymbolImage.ai }
        switch base {
        case "Read", "read_page", "NotebookRead": return "doc.text"
        case "Write", "create_page": return "doc.badge.plus"
        case "Edit", "MultiEdit", "NotebookEdit", "replace_page", "append_to_page", "update_row": return "pencil"
        case "Bash", "BashOutput", "KillShell": return "terminal"
        case "Grep", "Glob", "search", "memory_search", "query_database": return "magnifyingglass"
        case "WebFetch", "WebSearch": return "globe"
        case "Task", "Agent", "spawn_agent": return "person.2"
        case "memory_save": return "brain"
        default: return "wrench.and.screwdriver"
        }
    }

    func verb(_ status: ChatPart.Status) -> String {
        let done = status != .running
        if isBrowser { return done ? "Used the browser" : "Using the browser" }
        switch base {
        case "Read", "read_page": return done ? "Read" : "Reading"
        case "Write": return done ? "Wrote" : "Writing"
        case "create_page": return done ? "Created page" : "Creating page"
        case "Edit", "MultiEdit", "replace_page", "append_to_page": return done ? "Edited" : "Editing"
        case "Bash": return done ? "Ran" : "Running"
        case "Grep", "Glob", "search": return done ? "Searched" : "Searching"
        case "WebSearch": return done ? "Searched the web" : "Searching the web"
        case "WebFetch": return done ? "Fetched" : "Fetching"
        case "Task", "Agent", "spawn_agent": return done ? "Sub-agent" : "Sub-agent working"
        case "memory_save": return done ? "Saved memory" : "Saving memory"
        case "memory_search": return done ? "Checked memories" : "Checking memories"
        case "query_database": return done ? "Queried database" : "Querying database"
        default: return base.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func names(_ parts: [ChatPart]) -> String {
        var seen: [String] = []
        for p in parts { let v = ToolStyle(name: p.toolName).verb(.done); if !seen.contains(v) { seen.append(v) } }
        return seen.joined(separator: ", ")
    }
}

// MARK: - To-dos

struct TodoCardView: View {
    let todos: [TodoItem]

    var body: some View {
        let done = todos.filter { $0.status == .completed }.count
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                Text("To-dos").font(.system(size: 13, weight: .medium))
                Text("\(done)/\(todos.count)").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                Spacer()
            }
            ProgressView(value: Double(done), total: Double(max(1, todos.count)))
                .progressViewStyle(.linear)
                .tint(Color.accentColor)
            VStack(alignment: .leading, spacing: 5) {
                ForEach(todos) { t in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Group {
                            switch t.status {
                            case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            case .inProgress: Image(systemName: "circle.dotted").foregroundStyle(Color.accentColor)
                            case .pending: Image(systemName: "circle").foregroundStyle(Theme.secondary)
                            }
                        }
                        .font(.system(size: 12))
                        Text(t.status == .inProgress ? (t.activeForm ?? t.title) : t.title)
                            .font(.system(size: 13, weight: t.status == .inProgress ? .medium : .regular))
                            .strikethrough(t.status == .completed, color: Theme.secondary)
                            .foregroundStyle(t.status == .completed ? Theme.secondary : Theme.primary)
                    }
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.025)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(Theme.divider)))
    }
}

// MARK: - Markdown

/// Markdown answer as blocks (headings, paragraphs, lists, to-dos, quotes, code with copy, tables, dividers,
/// equations) — parsed with Based's own Markdown importer, inline styles from its rich text.
struct MarkdownMessageView: View {
    let markdown: String
    var streaming = false

    var body: some View {
        let blocks = MarkdownImporter().parse(markdown)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, b in
                MarkdownBlockView(block: b, index: i, siblings: blocks)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MarkdownBlockView: View {
    let block: ImportedBlock
    let index: Int
    let siblings: [ImportedBlock]

    var body: some View {
        let t = MarkdownInline.attributed(block.text)
        switch block.type {
        case .heading1: Text(t).font(.system(size: 20, weight: .semibold)).padding(.top, 6)
        case .heading2: Text(t).font(.system(size: 17, weight: .semibold)).padding(.top, 4)
        case .heading3, .heading4: Text(t).font(.system(size: 15, weight: .semibold)).padding(.top, 2)
        case .bulletedList, .numberedList, .todo:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                marker.frame(minWidth: 14, alignment: .trailing)
                VStack(alignment: .leading, spacing: 4) {
                    Text(t).font(.system(size: 14)).lineSpacing(3)
                    children
                }
            }
        case .quote:
            VStack(alignment: .leading, spacing: 4) { Text(t).font(.system(size: 14)).lineSpacing(3); children }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.secondary.opacity(0.5)).frame(width: 3) }
        case .code:
            ChatCodeBlockView(code: block.text.plainText, language: block.props.language)
        case .divider:
            Divider().padding(.vertical, 4)
        case .equation:
            Text(block.props.expression ?? block.text.plainText).font(.system(size: 14, design: .serif)).italic()
                .frame(maxWidth: .infinity)
        case .table:
            MarkdownTableView(block: block)
        case .callout:
            Text(t).font(.system(size: 14)).padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        case .image:
            if let u = block.props.url, let url = URL(string: u) {
                AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { Color.primary.opacity(0.05) }
                    .frame(maxHeight: 320).clipShape(RoundedRectangle(cornerRadius: 8))
            }
        default:
            VStack(alignment: .leading, spacing: 4) {
                Text(t).font(.system(size: 14)).lineSpacing(3.5)
                children
            }
        }
    }

    @ViewBuilder private var marker: some View {
        switch block.type {
        case .numberedList:
            let n = siblings[..<index].reversed().prefix { $0.type == .numberedList }.count + 1
            Text("\(n).").font(.system(size: 14)).foregroundStyle(Theme.secondary)
        case .todo:
            Image(systemName: block.props.checked == true ? "checkmark.square.fill" : "square")
                .font(.system(size: 13)).foregroundStyle(block.props.checked == true ? Color.accentColor : Theme.secondary)
        default:
            Text("•").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.secondary)
        }
    }

    @ViewBuilder private var children: some View {
        if !block.children.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(block.children.enumerated()), id: \.offset) { i, c in
                    MarkdownBlockView(block: c, index: i, siblings: block.children)
                }
            }
        }
    }
}

enum MarkdownInline {
    /// Based rich text → AttributedString (bold, italic, strike, underline, inline code, links, page mentions).
    static func attributed(_ rt: RichText) -> AttributedString {
        var out = AttributedString()
        for run in rt.runs {
            var a = AttributedString(run.equation ?? run.text)
            var font = Font.system(size: 14)
            if run.marks.code { font = .system(size: 12.5, design: .monospaced); a.backgroundColor = Color.primary.opacity(0.07) }
            if run.marks.bold { font = font.bold() }
            if run.marks.italic { font = font.italic() }
            a.font = font
            if run.marks.strikethrough { a.strikethroughStyle = .single }
            if run.marks.underline { a.underlineStyle = .single }
            if let l = run.marks.link, let url = URL(string: l) { a.link = url; a.foregroundColor = Color.accentColor }
            if case .page(let id)? = run.mention { a.link = URL(string: "based://page/" + id); a.foregroundColor = Color.accentColor }
            if case .link(let l)? = run.mention, let url = URL(string: l) { a.link = url; a.foregroundColor = Color.accentColor }
            out += a
        }
        return out
    }
}

struct ChatCodeBlockView: View {
    let code: String
    let language: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text((language ?? "").isEmpty || language == "plain text" ? "code" : language!)
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.secondary)
                Spacer()
                Button {
                    Clipboard.copy(code)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11.5))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.primary.opacity(0.04))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.035)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(Theme.divider)))
    }
}

struct MarkdownTableView: View {
    let block: ImportedBlock

    var body: some View {
        let rows = block.children.map { $0.props.cells ?? [] }
        let cols = max(1, block.props.tableColumns ?? rows.map(\.count).max() ?? 1)
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { ri, row in
                    GridRow {
                        ForEach(0..<cols, id: \.self) { ci in
                            Text(ci < row.count ? MarkdownInline.attributed(row[ci]) : AttributedString(""))
                                .font(.system(size: 13, weight: ri == 0 ? .semibold : .regular))
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .frame(minWidth: 60, alignment: .leading)
                                .background(ri == 0 ? Color.primary.opacity(0.04) : .clear)
                                .overlay(Rectangle().stroke(Color(Theme.divider), lineWidth: 0.5))
                        }
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Small pieces

struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button {
            Clipboard.copy(text)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.secondary)
        .help("Copy")
    }
}

struct AttachmentChip: View {
    let name: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: FileDrop.imageExt.contains((name as NSString).pathExtension.lowercased()) ? "photo" : "doc")
                .font(.system(size: 11))
            Text(name).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
            if let onRemove {
                Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                    .buttonStyle(.plain)
            }
        }
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
        .frame(maxWidth: 220)
    }
}

/// Mic button: macOS system dictation into the focused field (no extra permissions).
struct DictationButton: View {
    let focus: () -> Void
    var body: some View {
        #if os(macOS)
        Button {
            focus()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil)
            }
        } label: { Image(systemName: "mic") }
        .buttonStyle(.plain)
        .help("Dictate (or press the dictation key)")
        .accessibilityIdentifier("ai.dictate")
        #else
        EmptyView()   // iOS: the keyboard's mic key
        #endif
    }
}
