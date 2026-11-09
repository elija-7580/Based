import Foundation

/// Minimal, forgiving HTML reader used to turn Notion's "HTML" export into the Markdown + CSV
/// layout the `NotionImporter` already understands.
public struct HTMLNode {
    public var tag: String            // "" for text nodes, "#root" for the document
    public var attrs: [String: String] = [:]
    public var children: [HTMLNode] = []
    public var text: String = ""

    public var classes: Set<String> { Set((attrs["class"] ?? "").split(separator: " ").map(String.init)) }
    public func has(class c: String) -> Bool { classes.contains(c) }

    /// Depth-first search.
    public func first(where match: (HTMLNode) -> Bool) -> HTMLNode? {
        if match(self) { return self }
        for c in children { if let f = c.first(where: match) { return f } }
        return nil
    }

    public func all(where match: (HTMLNode) -> Bool) -> [HTMLNode] {
        var out: [HTMLNode] = []
        func walk(_ n: HTMLNode) { if match(n) { out.append(n) }; n.children.forEach(walk) }
        walk(self)
        return out
    }

    /// Concatenated text content, whitespace collapsed.
    public var textContent: String {
        var s = ""
        func walk(_ n: HTMLNode) { if n.tag.isEmpty { s += n.text } else if n.tag == "br" { s += " " } else { n.children.forEach(walk) } }
        walk(self)
        return HTMLParser.collapse(s).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public extension HTMLNode {
    var isText: Bool { tag.isEmpty }
    var elements: [HTMLNode] { children.filter { !$0.tag.isEmpty } }
    func attr(_ name: String) -> String? { attrs[name] }

    /// Text exactly as written (no whitespace collapsing), `<br>` as newline.
    var rawText: String {
        var s = ""
        func walk(_ n: HTMLNode) {
            if n.tag.isEmpty { s += n.text } else if n.tag == "br" { s += "\n" } else if n.tag != "style" && n.tag != "script" { n.children.forEach(walk) }
        }
        walk(self)
        return s
    }

    /// Serialized markup of the node (used to keep unknown content as an HTML block).
    var outerHTML: String {
        if tag.isEmpty { return HTMLParser.escape(text) }
        if tag == "#root" { return innerHTML }
        var s = "<" + tag
        for (k, v) in attrs.sorted(by: { $0.key < $1.key }) {
            s += " " + k + "=\"" + HTMLParser.escape(v).replacingOccurrences(of: "\"", with: "&quot;") + "\""
        }
        if HTMLParser.voidTags.contains(tag) { return s + "/>" }
        return s + ">" + innerHTML + "</" + tag + ">"
    }

    var innerHTML: String {
        if HTMLParser.rawTags.contains(tag) { return children.map(\.text).joined() }
        return children.map(\.outerHTML).joined()
    }

    /// Inline style property, e.g. `style("width")` for `style="width:240px"`.
    func style(_ property: String) -> String? {
        guard let st = attrs["style"] else { return nil }
        for decl in st.split(separator: ";") {
            let parts = decl.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, parts[0].lowercased() == property { return parts[1] }
        }
        return nil
    }
}

public enum HTMLParser {
    static let voidTags: Set<String> = ["br", "img", "hr", "input", "meta", "link", "col", "source", "wbr", "area", "base", "embed", "param", "track"]
    static let rawTags: Set<String> = ["script", "style", "textarea", "title"]

    public static func parse(_ html: String) -> HTMLNode {
        let s = Array(html.unicodeScalars)
        var stack: [HTMLNode] = [HTMLNode(tag: "#root")]
        var i = 0
        var text = String.UnicodeScalarView()

        func flushText() {
            guard !text.isEmpty else { return }
            stack[stack.count - 1].children.append(HTMLNode(tag: "", text: decodeEntities(String(text))))
            text = String.UnicodeScalarView()
        }
        func close(_ tag: String) {
            guard let idx = stack.lastIndex(where: { $0.tag == tag }), idx > 0 else { return }
            while stack.count > idx {
                let n = stack.removeLast()
                stack[stack.count - 1].children.append(n)
            }
        }
        func starts(_ p: String, at k: Int) -> Bool {
            var j = k
            for c in p.unicodeScalars { guard j < s.count, s[j] == c else { return false }; j += 1 }
            return true
        }

        while i < s.count {
            let c = s[i]
            guard c == "<" else { text.append(c); i += 1; continue }
            if starts("<!--", at: i) {
                flushText()
                var j = i + 4
                while j < s.count, !starts("-->", at: j) { j += 1 }
                i = j + 3; continue
            }
            if i + 1 < s.count, s[i + 1] == "!" || s[i + 1] == "?" {
                flushText()
                while i < s.count, s[i] != ">" { i += 1 }
                i += 1; continue
            }
            let closing = i + 1 < s.count && s[i + 1] == "/"
            var j = i + (closing ? 2 : 1)
            var name = ""
            while j < s.count, s[j].properties.isAlphabetic || ("0"..."9").contains(s[j]) || s[j] == "-" { name.unicodeScalars.append(s[j]); j += 1 }
            guard !name.isEmpty else { text.append(c); i += 1; continue }
            name = name.lowercased()
            flushText()
            // attributes
            var attrs: [String: String] = [:]
            var selfClosing = false
            while j < s.count, s[j] != ">" {
                if s[j] == "/" { selfClosing = true; j += 1; continue }
                if s[j].properties.isWhitespace { j += 1; continue }
                var key = ""
                while j < s.count, !s[j].properties.isWhitespace, s[j] != "=", s[j] != ">", s[j] != "/" { key.unicodeScalars.append(s[j]); j += 1 }
                var value = ""
                while j < s.count, s[j].properties.isWhitespace { j += 1 }
                if j < s.count, s[j] == "=" {
                    j += 1
                    while j < s.count, s[j].properties.isWhitespace { j += 1 }
                    if j < s.count, s[j] == "\"" || s[j] == "'" {
                        let q = s[j]; j += 1
                        while j < s.count, s[j] != q { value.unicodeScalars.append(s[j]); j += 1 }
                        j += 1
                    } else {
                        while j < s.count, !s[j].properties.isWhitespace, s[j] != ">" { value.unicodeScalars.append(s[j]); j += 1 }
                    }
                }
                if !key.isEmpty { attrs[key.lowercased()] = decodeEntities(value) }
                selfClosing = false
            }
            i = j + 1
            if closing { close(name); continue }
            let node = HTMLNode(tag: name, attrs: attrs)
            if voidTags.contains(name) || selfClosing {
                stack[stack.count - 1].children.append(node)
                continue
            }
            if rawTags.contains(name) {
                // Skip raw text content up to the closing tag.
                var k = i
                while k < s.count, !(s[k] == "<" && starts("</" + name, at: k)) { k += 1 }
                var raw = node
                raw.children = [HTMLNode(tag: "", text: String(String.UnicodeScalarView(s[i..<min(k, s.count)])))]
                stack[stack.count - 1].children.append(raw)
                while k < s.count, s[k] != ">" { k += 1 }
                i = k + 1
                continue
            }
            // Implicitly close <p>/<li> siblings the way browsers do.
            if name == "li", let top = stack.last?.tag, top == "li" { close("li") }
            if name == "p", stack.last?.tag == "p" { close("p") }
            stack.append(node)
        }
        flushText()
        while stack.count > 1 { let n = stack.removeLast(); stack[stack.count - 1].children.append(n) }
        return stack[0]
    }

    static let entities: [String: String] = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "#39": "'",
                                             "nbsp": "\u{00A0}", "mdash": "—", "ndash": "–", "hellip": "…", "rsquo": "’",
                                             "lsquo": "‘", "rdquo": "”", "ldquo": "“", "copy": "©", "reg": "®", "trade": "™",
                                             "times": "×", "middot": "·", "bull": "•", "rarr": "→", "larr": "←", "euro": "€"]

    public static func decodeEntities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == "&", let semi = s[i...].prefix(12).firstIndex(of: ";") {
                let name = String(s[s.index(after: i)..<semi])
                var rep: String?
                if name.hasPrefix("#x") || name.hasPrefix("#X") {
                    rep = UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
                } else if name.hasPrefix("#"), name != "#39" {
                    rep = UInt32(name.dropFirst()).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
                } else {
                    rep = entities[name]
                }
                if let rep { out += rep; i = s.index(after: semi); continue }
            }
            out.append(s[i]); i = s.index(after: i)
        }
        return out
    }

    public static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    static func collapse(_ s: String) -> String {
        var out = ""
        var lastSpace = false
        for ch in s {
            if ch == " " || ch == "\n" || ch == "\t" || ch == "\r" {
                if !lastSpace { out.append(" ") }
                lastSpace = true
            } else { out.append(ch); lastSpace = false }
        }
        return out
    }
}

/// Notion HTML export page → Markdown (+ database tables as CSV).
public struct HTMLPageConverter {
    public struct Table {
        public var title: String
        public var rows: [[String]]          // header first
        public var rowFolder: String?        // relative folder of the row pages (from the title links)
    }

    public var title = ""
    public var markdown = ""
    public var tables: [Table] = []
    /// True when the page is nothing but a database (full-page database export).
    public var isDatabasePage = false

    /// Relative link rewriting: Notion links pages as "X%20id.html"; the importer reads ".md".
    static func rewrite(_ href: String) -> String {
        guard !href.contains("://"), !href.hasPrefix("#"), !href.hasPrefix("mailto:") else { return href }
        if href.lowercased().hasSuffix(".html") { return String(href.dropLast(5)) + ".md" }
        return href
    }

    public init(html: String) {
        let doc = HTMLParser.parse(html)
        let article = doc.first { $0.tag == "article" } ?? doc.first { $0.tag == "body" } ?? doc
        var icon = ""
        if let h = article.first(where: { $0.has(class: "page-title") }) { title = h.textContent }
        else if let t = doc.first(where: { $0.tag == "title" }) { title = t.textContent }
        if let i = article.first(where: { $0.has(class: "page-header-icon") }) {
            let t = i.textContent
            if !t.isEmpty, t.count <= 2 { icon = t }
        }
        let body = article.first { $0.has(class: "page-body") }
        var lines: [String] = []
        if let body {
            for c in body.children { lines += block(c, indent: "") }
        } else {
            // Not a Notion page: render everything after the header.
            for c in article.children where c.tag != "header" && c.tag != "head" { lines += block(c, indent: "") }
        }
        // Full-page database: the page is nothing but its collection table.
        let content = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if tables.isEmpty, content.isEmpty, let t = article.first(where: { $0.tag == "table" && $0.has(class: "collection-content") }) {
            tables.append(Self.table(t, title: title))
            isDatabasePage = true
        } else if tables.count == 1, content.count <= 1, content.allSatisfy({ $0.hasSuffix(".csv)") }) {
            tables[0].title = title
            isDatabasePage = true
        }
        while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeLast() }
        let head = "# " + (icon.isEmpty ? "" : icon + " ") + (title.isEmpty ? "Untitled" : title)
        markdown = ([head, ""] + lines).joined(separator: "\n") + "\n"
    }

    static func table(_ t: HTMLNode, title: String) -> Table {
        var rows: [[String]] = []
        var folder: String?
        for tr in t.all(where: { $0.tag == "tr" }) {
            let cells = tr.children.filter { $0.tag == "td" || $0.tag == "th" }
            guard !cells.isEmpty else { continue }
            rows.append(cells.map { $0.textContent })
            if folder == nil, let a = cells.first?.first(where: { $0.tag == "a" }), let href = a.attrs["href"],
               !href.contains("://"), let decoded = href.removingPercentEncoding, decoded.contains("/") {
                folder = (decoded as NSString).deletingLastPathComponent
            }
        }
        return Table(title: title, rows: rows, rowFolder: folder)
    }

    // MARK: Blocks

    mutating func block(_ n: HTMLNode, indent: String) -> [String] {
        if n.tag.isEmpty {
            let t = HTMLParser.collapse(n.text).trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? [] : [indent + t]
        }
        switch n.tag {
        case "h1": return [indent + "# " + inline(n)]
        case "h2": return [indent + "## " + inline(n)]
        case "h3", "h4", "h5", "h6": return [indent + "### " + inline(n)]
        case "p":
            let t = inline(n)
            return [indent + t]
        case "hr": return [indent + "---"]
        case "br": return []
        case "blockquote": return [indent + "> " + inline(n)]
        case "pre":
            let lang = n.first { $0.tag == "code" }?.attrs["class"]?.split(separator: " ")
                .first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)).lowercased() } ?? ""
            var raw = ""
            func walk(_ x: HTMLNode) { if x.tag.isEmpty { raw += x.text } else if x.tag == "br" { raw += "\n" } else { x.children.forEach(walk) } }
            walk(n)
            return [indent + "```" + (lang == "plain" ? "" : lang)] + raw.components(separatedBy: "\n").map { indent + $0 } + [indent + "```"]
        case "ul", "ol":
            var out: [String] = []
            var number = 1
            for li in n.children where li.tag == "li" {
                out += listItem(li, ordered: n.tag == "ol", number: number, todo: n.has(class: "to-do-list"), indent: indent)
                number += 1
            }
            return out
        case "details":
            let summary = n.children.first { $0.tag == "summary" }.map { inline($0) } ?? ""
            var out = [indent + "<details>", indent + "<summary>\(summary)</summary>"]
            for c in n.children where c.tag != "summary" { out += block(c, indent: indent + "    ") }
            out.append(indent + "</details>")
            return out
        case "figure":
            if n.has(class: "callout") {
                let icon = n.first { $0.has(class: "icon") }?.textContent ?? ""
                let content = n.children.filter { !$0.has(class: "icon") && !($0.tag == "div" && $0.first(where: { $0.has(class: "icon") }) != nil && $0.textContent.count <= 2) }
                var inner: [String] = []
                for c in content { inner += block(c, indent: "") }
                let text = inner.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                return [indent + "<aside>", indent + (icon.isEmpty ? "" : icon + " ") + (text.first ?? "")] + text.dropFirst().map { indent + $0 } + [indent + "</aside>"]
            }
            if n.has(class: "link-to-page"), let a = n.first(where: { $0.tag == "a" }), let href = a.attrs["href"] {
                return [indent + "[\(a.textContent)](\(Self.rewrite(href)))"]
            }
            if let img = n.first(where: { $0.tag == "img" }), let src = img.attrs["src"] {
                return [indent + "![](\(src))"]
            }
            if n.has(class: "equation") { return [indent + "$$" + n.textContent + "$$"] }
            if let a = n.first(where: { $0.tag == "a" }), let href = a.attrs["href"] {
                return [indent + "[\(a.textContent.isEmpty ? href : a.textContent)](\(Self.rewrite(href)))"]
            }
            var out: [String] = []
            for c in n.children { out += block(c, indent: indent) }
            return out
        case "img":
            return n.attrs["src"].map { [indent + "![](\($0))"] } ?? []
        case "table":
            if n.has(class: "collection-content") {
                let t = Self.table(n, title: "Table")
                tables.append(t)
                return []
            }
            let rows = n.all(where: { $0.tag == "tr" }).map { tr in tr.children.filter { $0.tag == "td" || $0.tag == "th" }.map { inline($0).replacingOccurrences(of: "|", with: "\\|") } }
                .filter { !$0.isEmpty }
            guard let first = rows.first else { return [] }
            var out = [indent + "| " + first.joined(separator: " | ") + " |", indent + "|" + Array(repeating: " --- |", count: first.count).joined()]
            for r in rows.dropFirst() { out.append(indent + "| " + r.joined(separator: " | ") + " |") }
            return out
        case "div", "section", "span", "main", "nav", "header", "footer", "article":
            if n.has(class: "collection-content") || n.tag == "div" && n.children.contains(where: { $0.tag == "table" && $0.has(class: "collection-content") }) {
                let title = n.first { $0.has(class: "collection-title") }?.textContent ?? "Table"
                if let tn = n.first(where: { $0.tag == "table" }) {
                    let t = Self.table(tn, title: title)
                    tables.append(t)
                    if let folder = t.rowFolder {
                        let enc = folder.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? folder
                        return [indent + "[\(title)](\(enc).csv)"]
                    }
                }
                return []
            }
            if n.has(class: "column-list") || n.has(class: "column") || n.tag != "span" || n.children.contains(where: { !$0.tag.isEmpty && !Self.inlineTags.contains($0.tag) }) {
                var out: [String] = []
                for c in n.children { out += block(c, indent: indent) }
                return out
            }
            let t = inline(n)
            return t.isEmpty ? [] : [indent + t]
        case "script", "style", "head", "title", "meta":
            return []
        default:
            let t = inline(n)
            return t.isEmpty ? [] : [indent + t]
        }
    }

    static let inlineTags: Set<String> = ["a", "b", "strong", "i", "em", "u", "s", "del", "strike", "code", "mark", "span", "time", "sup", "sub", "br", "img", "small", "kbd"]

    mutating func listItem(_ li: HTMLNode, ordered: Bool, number: Int, todo: Bool, indent: String) -> [String] {
        var prefix = ordered ? "\(number). " : "- "
        if todo || li.first(where: { $0.has(class: "checkbox") }) != nil {
            let on = li.first { $0.has(class: "checkbox-on") } != nil || li.first { $0.tag == "input" && $0.attrs["checked"] != nil } != nil
            prefix = on ? "- [x] " : "- [ ] "
        }
        // Toggle list items wrap their content in <details>.
        if let d = li.children.first(where: { $0.tag == "details" }) {
            return block(d, indent: indent)
        }
        var nested: [HTMLNode] = []
        var textParts = li
        textParts.children = []
        for c in li.children {
            if ["ul", "ol", "details", "figure", "pre"].contains(c.tag) { nested.append(c) }
            else if !c.has(class: "checkbox") { textParts.children.append(c) }
        }
        var out = [indent + prefix + inline(textParts)]
        for c in nested { out += block(c, indent: indent + "    ") }
        return out
    }

    // MARK: Inline

    func inline(_ n: HTMLNode) -> String {
        var s = ""
        for c in n.children { s += inlineNode(c) }
        return HTMLParser.collapse(s).trimmingCharacters(in: .whitespaces)
    }

    func inlineNode(_ n: HTMLNode) -> String {
        if n.tag.isEmpty { return n.text.replacingOccurrences(of: "\u{00A0}", with: " ") }
        let inner = n.children.map(inlineNode).joined()
        let trimmed = inner.trimmingCharacters(in: .whitespaces)
        func wrap(_ m: String) -> String {
            guard !trimmed.isEmpty else { return inner }
            let lead = inner.hasPrefix(" ") ? " " : "", trail = inner.hasSuffix(" ") ? " " : ""
            return lead + m + trimmed + m + trail
        }
        switch n.tag {
        case "b", "strong": return wrap("**")
        case "i", "em": return wrap("*")
        case "s", "del", "strike": return wrap("~~")
        case "code": return trimmed.isEmpty ? inner : "`" + trimmed + "`"
        case "br": return " "
        case "a":
            guard let href = n.attrs["href"], !href.isEmpty else { return inner }
            return "[\(trimmed.isEmpty ? href : trimmed)](\(Self.rewrite(href)))"
        case "img": return n.attrs["src"].map { "![](\($0))" } ?? ""
        case "script", "style": return ""
        default: return inner
        }
    }
}

/// Converts every `.html` file below a folder into `.md` / `.csv` files the Markdown importer reads.
public enum HTMLExportConverter {
    /// Returns the number of converted pages.
    @discardableResult
    public static func convertFolder(_ dir: URL) -> Int {
        let fm = FileManager.default
        guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: nil) else { return 0 }
        var files: [URL] = []
        for case let u as URL in e where ["html", "htm"].contains(u.pathExtension.lowercased()) { files.append(u) }
        var count = 0
        for u in files {
            guard let data = try? Data(contentsOf: u) else { continue }
            let html = String(decoding: data, as: UTF8.self)
            let page = HTMLPageConverter(html: html)
            let base = u.deletingPathExtension()
            if page.isDatabasePage, let t = page.tables.first {
                try? CSV.encode(t.rows).write(to: base.appendingPathExtension("csv"), atomically: true, encoding: .utf8)
            } else {
                try? page.markdown.write(to: base.appendingPathExtension("md"), atomically: true, encoding: .utf8)
                // Inline databases: CSV next to their row folder, linked from the Markdown.
                for t in page.tables {
                    guard let folder = t.rowFolder else { continue }
                    let csv = u.deletingLastPathComponent().appendingPathComponent(folder + ".csv")
                    try? CSV.encode(t.rows).write(to: csv, atomically: true, encoding: .utf8)
                }
            }
            try? fm.removeItem(at: u)
            count += 1
        }
        return count
    }

    public static func containsHTML(_ dir: URL) -> Bool {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return false }
        for case let u as URL in e where ["html", "htm"].contains(u.pathExtension.lowercased()) { return true }
        return false
    }
}
