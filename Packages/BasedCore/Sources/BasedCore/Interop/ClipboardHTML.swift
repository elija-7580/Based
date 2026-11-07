import Foundation

/// Pasted HTML (Notion's clipboard, web pages, Google Docs, Mail …) → Based blocks.
/// Notion puts semantic HTML on the clipboard: headings, lists, to-dos, toggles (`<details>`), callouts, quotes,
/// code, tables, dividers, images, colours (`highlight-*` / `block-color-*` classes) and links to notion.so pages.
/// Links to Notion pages that were imported into Based (same id) become page mentions.
public struct ClipboardHTMLImporter {
    /// Existing page for a link target (based://page/…, notion.so/…-<32 hex>), if any.
    public var resolvePage: (String) -> RecordID?

    public init(resolvePage: @escaping (String) -> RecordID? = { _ in nil }) { self.resolvePage = resolvePage }

    /// True when the HTML carries structure worth more than its plain text (otherwise the Markdown path is fine).
    public static func isStructured(_ html: String) -> Bool {
        let l = html.lowercased()
        let tags = ["<h1", "<h2", "<h3", "<ul", "<ol", "<details", "<table", "<aside", "<blockquote", "<pre", "<hr", "<img", "<figure"]
        if tags.contains(where: { l.contains($0) }) { return true }
        return l.components(separatedBy: "<p").count > 2 || l.contains("highlight-") || l.contains("block-color-")
    }

    public func parse(_ html: String) -> [ImportedBlock] {
        let root = HTMLParser.parse(html)
        let body = root.first { $0.tag == "body" } ?? root
        return blocks(body.children)
    }

    // MARK: Blocks

    private static let blockTags: Set<String> = ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "details", "blockquote",
                                                 "pre", "table", "hr", "figure", "aside", "img", "section", "article", "header", "footer", "main"]

    func blocks(_ nodes: [HTMLNode]) -> [ImportedBlock] {
        var out: [ImportedBlock] = []
        var inline: [HTMLNode] = []
        func flush() {
            let rt = richText(inline)
            inline = []
            if !rt.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(ImportedBlock(.text, text: trimmed(rt))) }
        }
        for n in nodes {
            if n.isText || !(Self.blockTags.contains(n.tag)) {
                if n.tag == "style" || n.tag == "script" || n.tag == "meta" || n.tag == "head" || n.tag == "title" { continue }
                if n.tag == "br" { flush(); continue }
                inline.append(n); continue
            }
            flush()
            out.append(contentsOf: block(n))
        }
        flush()
        return out
    }

    private func block(_ n: HTMLNode) -> [ImportedBlock] {
        let color = Self.blockColor(n)
        func colored(_ b: ImportedBlock) -> ImportedBlock { var b = b; if let color { b.props.color = color }; return b }
        switch n.tag {
        case "h1", "h2", "h3", "h4", "h5", "h6":
            let type: BlockType = n.tag == "h1" ? .heading1 : n.tag == "h2" ? .heading2 : .heading3
            return [colored(ImportedBlock(type, text: trimmed(richText(n.children))))]
        case "hr":
            return [ImportedBlock(.divider)]
        case "ul", "ol":
            let todoList = n.has(class: "to-do-list")
            return n.elements.filter { $0.tag == "li" }.map { li in listItem(li, numbered: n.tag == "ol", todo: todoList) }
        case "li":
            return [listItem(n, numbered: false, todo: false)]
        case "details":
            let summary = n.elements.first { $0.tag == "summary" }
            let rest = n.children.filter { $0.tag != "summary" }
            var b = ImportedBlock(.toggle, text: trimmed(richText(summary?.children ?? [])), children: blocks(rest))
            if let color { b.props.color = color }
            return [b]
        case "blockquote":
            let kids = blocks(n.children)
            if kids.count <= 1 { return [colored(ImportedBlock(.quote, text: kids.first?.text ?? trimmed(richText(n.children))))] }
            var q = ImportedBlock(.quote, text: kids[0].text); q.children = Array(kids.dropFirst()); return [colored(q)]
        case "aside":
            return [callout(n)]
        case "pre":
            let codeNode = n.first { $0.tag == "code" } ?? n
            var p = BlockProps()
            p.language = (codeNode.classes.union(n.classes)).first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)) }
            return [ImportedBlock(.code, text: RichText(codeNode.rawText.trimmingCharacters(in: .newlines)), props: p)]
        case "table":
            return [table(n)]
        case "img":
            return image(n, caption: nil)
        case "figure":
            if n.has(class: "callout") { return [callout(n)] }
            let cap = n.first { $0.tag == "figcaption" }.map { trimmed(richText($0.children)) }
            if let img = n.first(where: { $0.tag == "img" }) { return image(img, caption: cap) }
            if let a = n.first(where: { $0.tag == "a" }), let href = a.attr("href") {
                var p = BlockProps(); p.url = href; p.caption = cap
                return [ImportedBlock(.bookmark, props: p)]
            }
            return blocks(n.children)
        default:
            // p / div / section: a callout div (Notion), a paragraph, or a container of more blocks.
            if n.has(class: "callout") { return [callout(n)] }
            if n.elements.contains(where: { Self.blockTags.contains($0.tag) }) {
                return blocks(n.children).map(colored)
            }
            let rt = trimmed(richText(n.children))
            if rt.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
            return [colored(ImportedBlock(.text, text: rt))]
        }
    }

    private func listItem(_ li: HTMLNode, numbered: Bool, todo: Bool) -> ImportedBlock {
        let checkbox = li.first { $0.tag == "input" && ($0.attr("type") ?? "") == "checkbox" }
            ?? li.first { $0.has(class: "checkbox") }
        let isTodo = todo || checkbox != nil || li.has(class: "to-do")
        let checked = checkbox.map { $0.attrs["checked"] != nil || $0.has(class: "checkbox-on") } ?? false
            || li.has(class: "checked") || li.first { $0.has(class: "to-do-children-checked") } != nil
        let nested = li.elements.filter { ["ul", "ol", "details", "blockquote", "pre", "table", "div"].contains($0.tag) && $0.elements.contains { Self.blockTags.contains($0.tag) } || $0.tag == "ul" || $0.tag == "ol" }
        let inline = li.children.filter { c in !nested.contains { $0.outerHTML == c.outerHTML } && !(c.tag == "input") && !c.has(class: "checkbox") }
        var b = ImportedBlock(isTodo ? .todo : (numbered ? .numberedList : .bulletedList), text: trimmed(richText(inline)))
        if isTodo { b.props.checked = checked }
        b.children = nested.flatMap { block($0) }
        if let c = Self.blockColor(li) { b.props.color = c }
        return b
    }

    private func callout(_ n: HTMLNode) -> ImportedBlock {
        var p = BlockProps()
        var nodes = n.children
        // Notion: <aside><span class="icon">💡</span><div>text</div></aside>; also a leading emoji character.
        if let icon = n.first(where: { $0.has(class: "icon") }) {
            let t = icon.textContent
            if !t.isEmpty { p.icon = .emoji(t) }
            nodes = nodes.filter { !$0.has(class: "icon") }
        }
        var kids = blocks(nodes)
        var text = kids.first?.type == .text ? kids.removeFirst().text : RichText()
        if p.icon == nil, let first = text.plainText.first, first.unicodeScalars.first?.properties.isEmojiPresentation == true {
            p.icon = .emoji(String(first))
            text = trimmed(text.slice(String(first).utf16.count, text.length))
        }
        p.color = Self.blockColor(n) ?? .grayBackground
        return ImportedBlock(.callout, text: text, props: p, children: kids)
    }

    private func table(_ n: HTMLNode) -> ImportedBlock {
        let rows = n.all { $0.tag == "tr" }
        let cols = rows.map { $0.elements.filter { $0.tag == "td" || $0.tag == "th" }.count }.max() ?? 1
        var t = ImportedBlock(.table)
        t.props.tableColumns = max(1, cols)
        t.props.tableHeaderRow = rows.first?.elements.allSatisfy { $0.tag == "th" } == true
        t.children = rows.map { tr in
            var r = ImportedBlock(.tableRow)
            var cells = tr.elements.filter { $0.tag == "td" || $0.tag == "th" }.map { trimmed(richText($0.children)) }
            while cells.count < cols { cells.append(RichText()) }
            r.props.cells = cells
            return r
        }
        return t
    }

    private func image(_ img: HTMLNode, caption: RichText?) -> [ImportedBlock] {
        guard let src = img.attr("src"), src.hasPrefix("http") else { return [] }
        var p = BlockProps(); p.url = src; p.caption = caption
        return [ImportedBlock(.image, props: p)]
    }

    // MARK: Inline

    func richText(_ nodes: [HTMLNode]) -> RichText {
        var runs: [TextRun] = []
        func add(_ s: String, _ m: Marks) {
            guard !s.isEmpty else { return }
            runs.append(TextRun(s.replacingOccurrences(of: "\u{00A0}", with: " "), marks: m))
        }
        func walk(_ n: HTMLNode, _ m: Marks) {
            if n.isText { add(HTMLParser.collapse(n.text), m); return }
            var m = m
            switch n.tag {
            case "br": add("\n", m); return
            case "style", "script", "svg", "input": return
            case "strong", "b": m.bold = true
            case "em", "i": m.italic = true
            case "u", "ins": m.underline = true
            case "s", "del", "strike": m.strikethrough = true
            case "code", "kbd": m.code = true
            case "mark": m.color = Self.colorClass(n) ?? .yellowBackground
            case "img": if let alt = n.attr("alt"), !alt.isEmpty, alt.count <= 4 { add(alt, m) }; return
            case "span", "font":
                if let c = Self.colorClass(n) ?? Self.cssColor(n) { m.color = c }
                if n.style("font-weight").map({ $0 == "bold" || (Int($0) ?? 400) >= 600 }) == true { m.bold = true }
                if n.style("font-style") == "italic" { m.italic = true }
                if n.style("text-decoration")?.contains("line-through") == true { m.strikethrough = true }
                if n.style("text-decoration")?.contains("underline") == true { m.underline = true }
            case "a":
                guard let href = n.attr("href"), !href.isEmpty, !href.hasPrefix("#") else { break }
                if let id = resolvePage(href) {
                    let label = n.textContent
                    runs.append(TextRun(label.isEmpty ? "Untitled" : label, marks: m, mention: .page(id)))
                    return
                }
                m.link = href
            default: break
            }
            for c in n.children { walk(c, m) }
        }
        for n in nodes { walk(n, .plain) }
        var rt = RichText(runs: runs)
        rt.normalize()
        return rt
    }

    private func trimmed(_ rt: RichText) -> RichText {
        let s = rt.plainText
        let lead = s.prefix { $0 == " " || $0 == "\n" }.count
        let trail = s.reversed().prefix { $0 == " " || $0 == "\n" }.count
        guard lead + trail < s.count else { return RichText() }
        return rt.slice(lead, rt.length - trail)
    }

    // MARK: Colours

    /// Notion: `highlight-blue`, `highlight-red_background`, `block-color-gray_background`.
    static func colorClass(_ n: HTMLNode) -> TColor? {
        for c in n.classes {
            for prefix in ["highlight-", "block-color-"] where c.hasPrefix(prefix) {
                if let t = NotionHTMLImporter.tcolor(String(c.dropFirst(prefix.count))) { return t }
            }
        }
        return nil
    }

    static func blockColor(_ n: HTMLNode) -> TColor? {
        n.classes.first { $0.hasPrefix("block-color-") }.flatMap { NotionHTMLImporter.tcolor(String($0.dropFirst(12))) }
    }

    /// Inline `color:` / `background-color:` from editors that don't use classes — mapped to the nearest Notion colour.
    static func cssColor(_ n: HTMLNode) -> TColor? {
        if let bg = n.style("background-color"), let c = nearest(bg) { return TColor(rawValue: c.rawValue + "Background") ?? c }
        if let fg = n.style("color"), let c = nearest(fg) { return c }
        return nil
    }

    private static func nearest(_ css: String) -> TColor? {
        let s = css.lowercased().replacingOccurrences(of: " ", with: "")
        let names: [(String, TColor)] = [("red", .red), ("orange", .orange), ("yellow", .yellow), ("green", .green), ("blue", .blue),
                                         ("purple", .purple), ("pink", .pink), ("brown", .brown), ("gray", .gray), ("grey", .gray)]
        if let n = names.first(where: { s.contains($0.0) }) { return n.1 }
        guard s.hasPrefix("#") || s.hasPrefix("rgb") else { return nil }
        var r = 0.0, g = 0.0, b = 0.0
        if s.hasPrefix("#"), s.count >= 7, let v = UInt32(s.dropFirst().prefix(6), radix: 16) {
            r = Double((v >> 16) & 0xFF); g = Double((v >> 8) & 0xFF); b = Double(v & 0xFF)
        } else if let open = s.firstIndex(of: "("), let close = s.firstIndex(of: ")") {
            let parts = s[s.index(after: open)..<close].split(separator: ",").compactMap { Double($0) }
            guard parts.count >= 3 else { return nil }
            r = parts[0]; g = parts[1]; b = parts[2]
        } else { return nil }
        let mx = max(r, g, b), mn = min(r, g, b)
        if mx - mn < 24 { return nil }   // black / white / grey text: no colour
        if r >= g && r >= b { return g > b + 40 ? (g > 150 ? .yellow : .orange) : (b > 120 ? .pink : .red) }
        if g >= r && g >= b { return .green }
        return r > g + 30 ? .purple : .blue
    }
}

public extension ClipboardHTMLImporter {
    /// Page id from a Based or Notion link (`based://page/<id>`, `https://www.notion.so/Title-<32 hex>`), if it exists.
    static func pageResolver(_ exists: @escaping (RecordID) -> Bool) -> (String) -> RecordID? {
        { href in
            if let id = PageLink.id(from: href), exists(id) { return id }
            guard href.contains("notion.so") || href.contains("notion.site") else { return nil }
            let path = href.split(separator: "?").first.map(String.init) ?? href
            guard let r = path.range(of: "[0-9a-fA-F]{32}", options: [.regularExpression, .backwards]) else { return nil }
            let h = path[r].lowercased()
            func part(_ a: Int, _ b: Int) -> Substring { h[h.index(h.startIndex, offsetBy: a)..<h.index(h.startIndex, offsetBy: b)] }
            let id = "\(part(0, 8))-\(part(8, 12))-\(part(12, 16))-\(part(16, 20))-\(part(20, 32))"
            return exists(id) ? id : nil
        }
    }
}
