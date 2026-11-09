import Foundation

/// A block tree produced by importers before it is inserted into the store.
public struct ImportedBlock: Sendable {
    public var id: RecordID = RecordIDs.make()
    public var type: BlockType
    public var text: RichText
    public var props: BlockProps
    public var children: [ImportedBlock]
    /// Raw link target when this block is a lone link (used to place subpages).
    public var linkTarget: String?

    public init(_ type: BlockType, text: RichText = RichText(), props: BlockProps = BlockProps(), children: [ImportedBlock] = []) {
        self.type = type; self.text = text; self.props = props; self.children = children
    }
}

public struct MarkdownImporter {
    public var resolveLink: (String) -> RecordID?
    public var resolveAsset: (String) -> (url: String?, asset: AssetRef?)

    public init(resolveLink: @escaping (String) -> RecordID? = { _ in nil },
                resolveAsset: @escaping (String) -> (url: String?, asset: AssetRef?) = { ($0, nil) }) {
        self.resolveLink = resolveLink
        self.resolveAsset = resolveAsset
    }

    /// Splits off a leading "# Title" line.
    public static func splitTitle(_ md: String) -> (title: String?, body: String) {
        var lines = md.components(separatedBy: "\n")
        while let f = lines.first, f.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        if let f = lines.first, f.hasPrefix("# ") {
            lines.removeFirst()
            return (String(f.dropFirst(2)).trimmingCharacters(in: .whitespaces), lines.joined(separator: "\n"))
        }
        return (nil, lines.joined(separator: "\n"))
    }

    public func parse(_ markdown: String) -> [ImportedBlock] {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\t", with: "    ")
            .components(separatedBy: "\n")
        return parseLines(lines[...])
    }

    func inline(_ s: String) -> RichText {
        InlineMarkdownCodec.decode(s.replacingOccurrences(of: "<br>", with: "\n"), resolveLink: resolveLink)
    }

    /// "[!NOTE] text" / "[!warning]" → callout look (Notion-like icon + background).
    static func alert(_ line: String) -> (emoji: String, color: TColor, text: String)? {
        guard line.hasPrefix("[!"), let close = line.firstIndex(of: "]") else { return nil }
        let kind = line[line.index(line.startIndex, offsetBy: 2)..<close].lowercased()
        let text = String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        switch kind {
        case "note", "info": return ("ℹ️", .blueBackground, text)
        case "tip", "hint", "success": return ("💡", .greenBackground, text)
        case "important", "abstract", "summary": return ("📌", .purpleBackground, text)
        case "warning", "caution", "attention": return ("⚠️", .yellowBackground, text)
        case "danger", "error", "bug", "failure": return ("🚨", .redBackground, text)
        case "question", "faq", "help": return ("❓", .grayBackground, text)
        case "example", "quote", "cite": return ("📝", .grayBackground, text)
        default: return nil
        }
    }

    static func indentOf(_ l: Substring) -> Int { l.prefix { $0 == " " }.count }
    static func indentOf(_ l: String) -> Int { l.prefix { $0 == " " }.count }

    func parseLines(_ lines: ArraySlice<String>) -> [ImportedBlock] {
        var out: [ImportedBlock] = []
        var i = lines.startIndex
        let base = lines.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(Self.indentOf) ?? 0

        /// Lines belonging to the block that starts at `start` (indented deeper than `indent`).
        func childLines(after start: Int, indent: Int) -> (ArraySlice<String>, Int) {
            var j = start + 1
            var lastContent = start
            while j < lines.endIndex {
                let l = lines[j]
                if l.trimmingCharacters(in: .whitespaces).isEmpty { j += 1; continue }
                if Self.indentOf(l) > indent { lastContent = j; j += 1 } else { break }
            }
            let slice = lines[(start + 1)..<(lastContent + 1)]
            return (slice, lastContent + 1)
        }

        while i < lines.endIndex {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { i += 1; continue }
            let indent = Self.indentOf(raw)
            if indent > base, var last = out.popLast(), last.type.supportsChildren {
                // stray deeper indentation: nest under previous block
                let (kids, next) = childLines(after: i - 1, indent: indent - 1)
                last.children += parseLines(kids)
                out.append(last)
                i = next
                continue
            }

            // Fenced code
            if trimmed.hasPrefix("```") {
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                var j = i + 1
                while j < lines.endIndex, !lines[j].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(String(lines[j].dropFirst(min(indent, Self.indentOf(lines[j])))))
                    j += 1
                }
                var p = BlockProps(); p.language = lang.isEmpty ? "plain text" : lang.lowercased()
                out.append(ImportedBlock(.code, text: RichText(body.joined(separator: "\n")), props: p))
                i = min(j + 1, lines.endIndex); continue
            }
            // Block equation
            if trimmed == "$$" || (trimmed.hasPrefix("$$") && trimmed.hasSuffix("$$") && trimmed.count > 4) {
                var expr: String
                var j = i + 1
                if trimmed.count > 4 { expr = String(trimmed.dropFirst(2).dropLast(2)) } else {
                    var body: [String] = []
                    while j < lines.endIndex, lines[j].trimmingCharacters(in: .whitespaces) != "$$" { body.append(lines[j].trimmingCharacters(in: .whitespaces)); j += 1 }
                    expr = body.joined(separator: "\n")
                    j += 1
                }
                var p = BlockProps(); p.expression = expr
                out.append(ImportedBlock(.equation, props: p))
                i = trimmed.count > 4 ? i + 1 : min(j, lines.endIndex); continue
            }
            // <details> toggle (Notion export)
            if trimmed.hasPrefix("<details") {
                var j = i + 1
                var summary = ""
                if let r = trimmed.range(of: "<summary>"), let e = trimmed.range(of: "</summary>") {
                    summary = String(trimmed[r.upperBound..<e.lowerBound])
                } else if j < lines.endIndex, let r = lines[j].range(of: "<summary>") {
                    let l = lines[j]
                    let e = l.range(of: "</summary>")?.lowerBound ?? l.endIndex
                    summary = String(l[r.upperBound..<e]); j += 1
                }
                var depth = 1
                var body: [String] = []
                while j < lines.endIndex {
                    let t = lines[j].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("<details") { depth += 1 }
                    if t.hasPrefix("</details>") { depth -= 1; if depth == 0 { break } }
                    body.append(lines[j]); j += 1
                }
                let (title, _) = (summary, 0)
                var block = ImportedBlock(.toggle, text: inline(title))
                block.children = parseLines(body[...])
                out.append(block)
                i = min(j + 1, lines.endIndex); continue
            }
            // <aside> callout (Notion export)
            if trimmed.hasPrefix("<aside>") {
                var j = i + 1
                var body: [String] = []
                let rest = trimmed.dropFirst(7).replacingOccurrences(of: "</aside>", with: "")
                if !rest.trimmingCharacters(in: .whitespaces).isEmpty { body.append(rest) }
                if !trimmed.contains("</aside>") {
                    while j < lines.endIndex, !lines[j].contains("</aside>") { body.append(lines[j]); j += 1 }
                    j += 1
                }
                var p = BlockProps()
                var first = body.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })?.trimmingCharacters(in: .whitespaces) ?? ""
                if let c = first.first, c.unicodeScalars.first.map({ $0.properties.isEmoji && $0.value > 0x2000 }) == true {
                    p.icon = .emoji(String(c))
                    first = String(first.dropFirst()).trimmingCharacters(in: .whitespaces)
                } else {
                    p.icon = .emoji("💡")
                }
                if let fi = body.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) { body.remove(at: fi) }
                var block = ImportedBlock(.callout, text: inline(first), props: p)
                block.children = parseLines(body[...])
                out.append(block)
                i = min(j, lines.endIndex); continue
            }
            // Table
            if trimmed.hasPrefix("|") {
                var rows: [[String]] = []
                var j = i
                while j < lines.endIndex, lines[j].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    let t = lines[j].trimmingCharacters(in: .whitespaces)
                    let cells = Self.tableCells(t)
                    if !cells.allSatisfy({ $0.allSatisfy { "-: ".contains($0) } && !$0.isEmpty }) { rows.append(cells) }
                    j += 1
                }
                let cols = rows.map(\.count).max() ?? 1
                var p = BlockProps(); p.tableColumns = cols; p.tableHeaderRow = true
                var table = ImportedBlock(.table, props: p)
                for r in rows {
                    var rp = BlockProps()
                    rp.cells = (0..<cols).map { $0 < r.count ? inline(r[$0]) : RichText() }
                    table.children.append(ImportedBlock(.tableRow, props: rp))
                }
                out.append(table)
                i = j; continue
            }
            // Divider
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                out.append(ImportedBlock(.divider)); i += 1; continue
            }
            // Headings
            if let h = Self.heading(trimmed) {
                out.append(ImportedBlock(h.0, text: inline(h.1))); i += 1; continue
            }
            // Quote (consecutive lines)
            if trimmed.hasPrefix(">") {
                var parts: [String] = []
                var j = i
                while j < lines.endIndex {
                    let t = lines[j].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    parts.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces)); j += 1
                }
                // GitHub / Obsidian alerts: "> [!NOTE] text" → callout with an icon and colour.
                if let first = parts.first, let alert = Self.alert(first) {
                    var p = BlockProps()
                    p.icon = .emoji(alert.emoji)
                    p.color = alert.color
                    let rest = [alert.text] + parts.dropFirst()
                    let body = rest.filter { !$0.isEmpty }.joined(separator: "\n")
                    out.append(ImportedBlock(.callout, text: inline(body), props: p)); i = j; continue
                }
                out.append(ImportedBlock(.quote, text: inline(parts.joined(separator: "\n")))); i = j; continue
            }
            // Image
            if trimmed.hasPrefix("!["), let mid = trimmed.range(of: "]("), trimmed.hasSuffix(")") {
                let alt = String(trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)..<mid.lowerBound])
                let src = String(trimmed[mid.upperBound..<trimmed.index(before: trimmed.endIndex)])
                var p = BlockProps()
                let r = resolveAsset(src.removingPercentEncoding ?? src)
                p.url = r.asset == nil ? (r.url ?? src) : nil
                p.asset = r.asset
                if !alt.isEmpty { p.caption = RichText(alt) }
                out.append(ImportedBlock(.image, props: p)); i += 1; continue
            }
            // Lists
            if let (type, checked, content) = Self.listItem(trimmed) {
                var p = BlockProps()
                if type == .todo { p.checked = checked }
                var block = ImportedBlock(type, text: inline(content), props: p)
                let (kids, next) = childLines(after: i, indent: indent)
                if !kids.isEmpty { block.children = parseLines(kids) }
                out.append(block); i = next; continue
            }
            // Paragraph (lone links are remembered for subpage placement)
            var block = ImportedBlock(.text, text: inline(trimmed))
            if trimmed.hasPrefix("["), trimmed.hasSuffix(")"), let mid = trimmed.range(of: "]("),
               !trimmed[trimmed.index(after: trimmed.startIndex)..<mid.lowerBound].contains("]") {
                block.linkTarget = String(trimmed[mid.upperBound..<trimmed.index(before: trimmed.endIndex)])
            }
            let (kids, next) = childLines(after: i, indent: indent)
            if !kids.isEmpty { block.children = parseLines(kids) }
            out.append(block)
            i = next
        }
        return out
    }

    public static func heading(_ t: String) -> (BlockType, String)? {
        for (prefix, type) in [("#### ", BlockType.heading4), ("### ", .heading3), ("## ", .heading2), ("# ", .heading1)] where t.hasPrefix(prefix) {
            return (type, String(t.dropFirst(prefix.count)))
        }
        return nil
    }

    public static func listItem(_ t: String) -> (BlockType, Bool, String)? {
        for p in ["- [ ] ", "* [ ] ", "- [x] ", "- [X] ", "* [x] "] where t.hasPrefix(p) {
            return (.todo, p.contains("x") || p.contains("X"), String(t.dropFirst(p.count)))
        }
        if t == "- [ ]" { return (.todo, false, "") }
        for p in ["- ", "* ", "+ ", "• "] where t.hasPrefix(p) { return (.bulletedList, false, String(t.dropFirst(p.count))) }
        if t == "-" || t == "*" { return (.bulletedList, false, "") }
        let digits = t.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 9 {
            let rest = t.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") { return (.numberedList, false, String(rest.dropFirst(2))) }
        }
        if let f = t.first, f.isLetter, t.dropFirst().hasPrefix(". "), t.count > 3, f.isLowercase {
            return nil // "a. " is ambiguous in prose; only accepted as a typed shortcut
        }
        return nil
    }

    static func tableCells(_ line: String) -> [String] {
        var s = line
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s.removeLast() }
        var cells: [String] = []
        var cur = ""
        var esc = false
        for c in s {
            if esc { if c != "|" { cur.append("\\") }; cur.append(c); esc = false; continue }
            if c == "\\" { esc = true; continue }
            if c == "|" { cells.append(cur.trimmingCharacters(in: .whitespaces)); cur = ""; continue }
            cur.append(c)
        }
        cells.append(cur.trimmingCharacters(in: .whitespaces))
        return cells
    }
}

@MainActor
public extension WorkspaceStore {
    /// Insert imported block trees (one undo step). Returns the new top-level ids.
    @discardableResult
    func insertImported(_ items: [ImportedBlock], in parent: ParentRef, at position: InsertPosition = .end,
                        name: String = "Paste") -> [RecordID] {
        guard !items.isEmpty else { return [] }
        return transact(name) { tx in
            let keys = tx.sortKeys(items.count, in: parent, position)
            var ids: [RecordID] = []
            for (item, key) in zip(items, keys) {
                ids.append(putImported(item, parent: parent, sortKey: key, tx: tx))
            }
            return ids
        }
    }

    @discardableResult
    func putImported(_ item: ImportedBlock, parent: ParentRef, sortKey: String, tx: Tx) -> RecordID {
        var b = Block(id: item.id, type: item.type, parent: parent, sortKey: sortKey, text: item.text, props: item.props, createdBy: userID)
        if b.type == .table, b.props.tableColumns == nil { b.props.tableColumns = 2 }
        tx.put(b)
        let keys = FractionalIndex.keys(count: item.children.count, between: nil, nil)
        for (c, k) in zip(item.children, keys) { putImported(c, parent: .block(b.id), sortKey: k, tx: tx) }
        b = tx.block(b.id) ?? b
        return b.id
    }
}