import Foundation

/// Page → standalone HTML document (Notion-like look, light/dark, no external assets except MathJax for
/// equations). HTML blocks (code blocks with language `html`) are embedded live in a sandboxed iframe,
/// Mermaid blocks render through mermaid.js. Inline databases become a table of their rows.
@MainActor
public struct HTMLExporter {
    public let store: WorkspaceStore
    /// How links to other pages are written (default: relative "<Title>.html").
    public var pageLink: (RecordID) -> (title: String, url: String)?

    /// Pages put their title in <h1>, so block headings start at <h2>; clipboard HTML keeps H1 = h1 (offset 0).
    public var headingOffset = 1

    public init(store: WorkspaceStore, pageLink: ((RecordID) -> (title: String, url: String)?)? = nil) {
        self.store = store
        self.pageLink = pageLink ?? { id in
            let t = store.title(of: id)
            return (t, (MarkdownExporter.fileName(t) + ".html").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? t)
        }
    }

    // MARK: Document

    public func export(page id: RecordID) -> String {
        guard let page = store.blocks[id] else { return "" }
        let title = store.title(of: id)
        var body = ""
        if case .emoji(let e)? = page.props.icon { body += "<div class=\"icon\">\(Self.escape(e))</div>\n" }
        body += "<h1 class=\"title\">\(Self.escape(title.isEmpty ? "Untitled" : title))</h1>\n"
        if let db = store.database(ofRow: id) {
            let q = QueryEngine(store: store)
            var rows = ""
            for p in db.properties where p.type != .title {
                let v = q.value(page, p, db)
                if v.isEmpty { continue }
                rows += "<tr><th>\(Self.escape(p.name))</th><td>\(Self.escape(CellFormatter.text(v, store: store)))</td></tr>\n"
            }
            if !rows.isEmpty { body += "<table class=\"properties\">\n\(rows)</table>\n" }
        }
        if page.type == .databasePage || page.type == .databaseInline { body += database(page) }
        else { body += blocks(store.contentBlocks(of: id)) }
        let usesMath = body.contains("class=\"equation\"")
        let usesMermaid = body.contains("class=\"mermaid\"")
        return """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="generator" content="Based">
        <title>\(Self.escape(title.isEmpty ? "Untitled" : title))</title>
        <style>\(Self.css)</style>
        \(usesMath ? "<script src=\"https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js\" async></script>" : "")
        </head>
        <body>
        <article class="page">
        \(body)</article>
        \(usesMermaid ? "<script type=\"module\">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default', securityLevel: 'strict' });</script>" : "")
        </body>
        </html>

        """
    }

    // MARK: Blocks

    public func blocks(_ list: [Block]) -> String {
        var out = ""
        var i = 0
        while i < list.count {
            let b = list[i]
            // Consecutive list items share one <ul>/<ol>.
            if b.type == .bulletedList || b.type == .numberedList || b.type == .todo {
                let tag = b.type == .numberedList ? "ol" : "ul"
                let cls = b.type == .todo ? " class=\"todo\"" : ""
                out += "<\(tag)\(cls)>\n"
                while i < list.count, list[i].type == b.type {
                    out += listItem(list[i])
                    i += 1
                }
                out += "</\(tag)>\n"
                continue
            }
            out += block(b)
            i += 1
        }
        return out
    }

    private func children(_ b: Block) -> String {
        let kids = store.contentBlocks(of: b.id)
        return kids.isEmpty ? "" : blocks(kids)
    }

    private func listItem(_ b: Block) -> String {
        let text = inline(b.text)
        if b.type == .todo {
            let checked = b.props.checked == true
            return "<li class=\"\(checked ? "checked" : "")\"><input type=\"checkbox\" disabled\(checked ? " checked" : "")> <span>\(text)</span>\(children(b))</li>\n"
        }
        return "<li>\(text)\(children(b))</li>\n"
    }

    private func colorClass(_ b: Block) -> String {
        guard let c = b.props.color, c != .default else { return "" }
        return " class=\"color-\(c.rawValue)\""
    }

    func block(_ b: Block) -> String {
        let text = inline(b.text)
        switch b.type {
        case .text:
            return text.isEmpty ? "<p class=\"empty\"></p>\n" + children(b) : "<p\(colorClass(b))>\(text)</p>\n" + indented(b)
        case .heading1, .heading2, .heading3, .heading4:
            let level = (b.type == .heading1 ? 1 : b.type == .heading2 ? 2 : b.type == .heading3 ? 3 : 4) + headingOffset
            if b.props.toggleable == true {
                return "<details\(b.props.isOpen == true ? " open" : "")><summary><h\(level)>\(text)</h\(level)></summary>\(children(b))</details>\n"
            }
            return "<h\(level)\(colorClass(b))>\(text)</h\(level)>\n"
        case .bulletedList, .numberedList, .todo:
            return blocks([b])
        case .toggle:
            return "<details\(b.props.isOpen == true ? " open" : "")><summary>\(text)</summary>\(children(b))</details>\n"
        case .quote:
            return "<blockquote\(colorClass(b))>\(text)\(children(b))</blockquote>\n"
        case .callout:
            let icon: String
            if case .emoji(let e)? = b.props.icon { icon = "<span class=\"callout-icon\">\(Self.escape(e))</span>" } else { icon = "" }
            return "<aside class=\"callout\">\(icon)<div>\(text.isEmpty ? "" : "<p>\(text)</p>")\(children(b))</div></aside>\n"
        case .divider:
            return "<hr>\n"
        case .code:
            let lang = (b.props.language ?? "").lowercased()
            let source = b.text.plainText
            if lang == "html" {
                // Live, sandboxed (scripts run, but can't reach this page or its storage).
                return "<figure class=\"html-block\"><iframe sandbox=\"allow-scripts\" loading=\"lazy\" srcdoc=\"\(Self.escapeAttribute(source))\"></iframe></figure>\n"
            }
            if lang == "mermaid" {
                return "<pre class=\"mermaid\">\(Self.escape(source))</pre>\n"
            }
            let cls = lang.isEmpty || lang == "plain text" ? "" : " class=\"language-\(Self.escapeAttribute(lang))\""
            return "<pre><code\(cls)>\(Self.escape(source))</code></pre>\n" + caption(b)
        case .equation:
            return "<div class=\"equation\">\\[\(Self.escape(b.props.expression ?? b.text.plainText))\\]</div>\n"
        case .image:
            let src = b.props.url ?? b.props.asset.map { "assets/" + $0.name } ?? ""
            let alt = b.props.caption?.plainText ?? ""
            return "<figure><img src=\"\(Self.escapeAttribute(src))\" alt=\"\(Self.escapeAttribute(alt))\">\(caption(b, figure: true))</figure>\n"
        case .video:
            let src = b.props.url ?? b.props.asset.map { "assets/" + $0.name } ?? ""
            return "<figure><video controls src=\"\(Self.escapeAttribute(src))\"></video>\(caption(b, figure: true))</figure>\n"
        case .audio:
            let src = b.props.url ?? b.props.asset.map { "assets/" + $0.name } ?? ""
            return "<figure><audio controls src=\"\(Self.escapeAttribute(src))\"></audio>\(caption(b, figure: true))</figure>\n"
        case .embed:
            let src = b.props.url ?? ""
            return "<figure><iframe class=\"embed\" src=\"\(Self.escapeAttribute(src))\" loading=\"lazy\"></iframe>\(caption(b, figure: true))</figure>\n"
        case .file, .pdf, .bookmark:
            let url = b.props.url ?? b.props.asset.map { "assets/" + $0.name } ?? ""
            let label = b.props.bookmark?.title ?? b.props.caption?.plainText ?? b.props.asset?.name ?? url
            let detail = b.props.bookmark?.summary.map { "<span class=\"bookmark-desc\">\(Self.escape($0))</span>" } ?? ""
            return "<a class=\"bookmark\" href=\"\(Self.escapeAttribute(url))\"><span class=\"bookmark-title\">\(Self.escape(label.isEmpty ? url : label))</span>\(detail)<span class=\"bookmark-url\">\(Self.escape(url))</span></a>\n"
        case .page, .databasePage, .linkToPage:
            let target = b.type == .linkToPage ? (b.props.linkTarget ?? b.id) : b.id
            let t = store.title(of: target)
            let icon: String
            if case .emoji(let e)? = store.blocks[target]?.props.icon { icon = Self.escape(e) + " " } else { icon = "📄 " }
            if let l = pageLink(target) { return "<p class=\"page-link\"><a href=\"\(Self.escapeAttribute(l.url))\">\(icon)\(Self.escape(l.title))</a></p>\n" }
            return "<p class=\"page-link\">\(icon)\(Self.escape(t))</p>\n"
        case .databaseInline:
            return database(b)
        case .table:
            return table(b)
        case .columnList:
            let cols = store.contentBlocks(of: b.id).filter { $0.type == .column }
            return "<div class=\"columns\">" + cols.map { "<div class=\"column\">\(children($0))</div>" }.joined() + "</div>\n"
        case .column, .syncedBlock:
            return children(b)
        case .tableOfContents:
            return ""
        case .breadcrumb, .button, .tableRow:
            return ""
        }
    }

    private func indented(_ b: Block) -> String {
        let c = children(b)
        return c.isEmpty ? "" : "<div class=\"indent\">\(c)</div>\n"
    }

    private func caption(_ b: Block, figure: Bool = false) -> String {
        guard let c = b.props.caption, !c.isEmpty else { return "" }
        return figure ? "<figcaption>\(inline(c))</figcaption>" : "<p class=\"caption\">\(inline(c))</p>\n"
    }

    func table(_ b: Block) -> String {
        let rows = store.contentBlocks(of: b.id).filter { $0.type == .tableRow }
        let cols = max(1, b.props.tableColumns ?? rows.map { $0.props.cells?.count ?? 0 }.max() ?? 1)
        var out = "<table class=\"simple\">\n"
        for (ri, r) in rows.enumerated() {
            let cells = r.props.cells ?? []
            let header = ri == 0 && b.props.tableHeaderRow == true
            out += "<tr>" + (0..<cols).map { i in
                let tag = header ? "th" : "td"
                return "<\(tag)>\(i < cells.count ? inline(cells[i]) : "")</\(tag)>"
            }.joined() + "</tr>\n"
        }
        return out + "</table>\n"
    }

    func database(_ b: Block) -> String {
        guard let db = store.database(forBlock: b.id) else { return "" }
        let q = QueryEngine(store: store)
        var props = db.properties
        if let ti = props.firstIndex(where: { $0.type == .title }) { props.insert(props.remove(at: ti), at: 0) }
        let rows = store.rows(of: db.id).filter { $0.props.isTemplate != true }
        var out = "<h4 class=\"db-title\">\(Self.escape(db.title.plainText.isEmpty ? "Untitled" : db.title.plainText))</h4>\n<table class=\"database\">\n<tr>"
        out += props.map { "<th>\(Self.escape($0.name))</th>" }.joined() + "</tr>\n"
        for r in rows {
            out += "<tr>" + props.map { p in
                if p.type == .title {
                    let t = store.title(of: r.id)
                    if let l = pageLink(r.id) { return "<td><a href=\"\(Self.escapeAttribute(l.url))\">\(Self.escape(t))</a></td>" }
                    return "<td>\(Self.escape(t))</td>"
                }
                let v = q.value(r, p, db)
                if case .bool(let on) = v { return "<td>\(on ? "☑︎" : "☐")</td>" }
                return "<td>\(Self.escape(CellFormatter.text(v, store: store)))</td>"
            }.joined() + "</tr>\n"
        }
        return out + "</table>\n"
    }

    // MARK: Inline

    public func inline(_ t: RichText) -> String {
        var out = ""
        for run in t.runs {
            var s: String
            if let eq = run.equation {
                s = "<span class=\"equation inline\">\\(\(Self.escape(eq))\\)</span>"
            } else if let m = run.mention {
                switch m {
                case .page(let id):
                    let title = store.title(of: id)
                    if let l = pageLink(id) { s = "<a class=\"mention\" href=\"\(Self.escapeAttribute(l.url))\">\(Self.escape(title))</a>" }
                    else { s = "<span class=\"mention\">\(Self.escape(title))</span>" }
                case .link(let url):
                    s = "<a class=\"mention\" href=\"\(Self.escapeAttribute(url))\">\(Self.escape(run.text))</a>"
                case .date, .user:
                    s = "<span class=\"mention\">\(Self.escape(run.text))</span>"
                }
            } else {
                s = Self.escape(run.text).replacingOccurrences(of: "\n", with: "<br>")
            }
            let m = run.marks
            if m.code { s = "<code>\(s)</code>" }
            if m.bold { s = "<strong>\(s)</strong>" }
            if m.italic { s = "<em>\(s)</em>" }
            if m.underline { s = "<u>\(s)</u>" }
            if m.strikethrough { s = "<s>\(s)</s>" }
            if let c = m.color, c != .default { s = "<span class=\"color-\(c.rawValue)\">\(s)</span>" }
            if let link = m.link { s = "<a href=\"\(Self.escapeAttribute(link))\">\(s)</a>" }
            out += s
        }
        return out
    }

    // MARK: Escaping

    public static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            default: out.append(ch)
            }
        }
        return out
    }

    public static func escapeAttribute(_ s: String) -> String {
        escape(s).replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }

    // MARK: Style

    static let css = """
    :root { color-scheme: light dark; --text: #37352f; --muted: #787774; --line: #e9e9e7; --bg: #ffffff; --soft: #f7f6f3; --accent: #2383e2; }
    @media (prefers-color-scheme: dark) { :root { --text: #e6e6e4; --muted: #9b9b9b; --line: #2f2f2f; --bg: #191919; --soft: #252525; --accent: #529cca; } }
    html { background: var(--bg); color: var(--text); }
    body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .page { max-width: 708px; margin: 0 auto; padding: 64px 24px 96px; }
    .icon { font-size: 64px; line-height: 1; margin-bottom: 8px; }
    h1.title { font-size: 40px; line-height: 1.2; margin: 0 0 24px; }
    h2 { font-size: 1.875em; margin: 1.4em 0 .3em; } h3 { font-size: 1.5em; margin: 1.2em 0 .2em; }
    h4 { font-size: 1.25em; margin: 1em 0 .2em; } h5 { font-size: 1.1em; margin: 1em 0 .2em; }
    p { margin: 2px 0; min-height: 1.6em; } p.empty { min-height: 1.6em; }
    .indent { padding-left: 1.6em; }
    a { color: inherit; text-decoration: underline; text-decoration-color: var(--muted); }
    code { font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); color: #eb5757; padding: .1em .35em; border-radius: 4px; }
    pre { background: var(--soft); padding: 16px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; color: inherit; padding: 0; font-size: .85em; }
    blockquote { border-left: 3px solid currentColor; margin: 6px 0; padding: 0 14px; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
    ul, ol { margin: 2px 0; padding-left: 1.6em; } ul.todo { list-style: none; padding-left: .2em; }
    ul.todo li.checked > span { text-decoration: line-through; color: var(--muted); }
    details { margin: 2px 0; } details > summary { cursor: pointer; } details > summary h2, details > summary h3, details > summary h4, details > summary h5 { display: inline; }
    .callout { display: flex; gap: 10px; background: var(--soft); border-radius: 6px; padding: 16px 16px 16px 12px; margin: 6px 0; }
    .callout-icon { font-size: 1.3em; line-height: 1.2; }
    figure { margin: 8px 0; } img, video { max-width: 100%; border-radius: 4px; } figcaption, .caption { color: var(--muted); font-size: 14px; }
    iframe.embed { width: 100%; height: 420px; border: 1px solid var(--line); border-radius: 6px; }
    .html-block iframe { width: 100%; min-height: 320px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }
    .bookmark { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; margin: 6px 0; text-decoration: none; }
    .bookmark-title { font-weight: 500; } .bookmark-desc, .bookmark-url { color: var(--muted); font-size: 13px; }
    .page-link a { text-decoration: none; border-bottom: 1px solid var(--line); }
    .mention { color: var(--muted); }
    table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 14px; }
    th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    table.properties { width: auto; margin-bottom: 24px; } table.properties th, table.properties td { border: 0; padding: 3px 12px 3px 0; }
    .db-title { margin-top: 1.4em; }
    .columns { display: flex; gap: 24px; } .column { flex: 1; min-width: 0; }
    .equation { text-align: center; margin: 8px 0; overflow-x: auto; } .equation.inline { display: inline; }
    .color-gray { color: #787774; } .color-brown { color: #9f6b53; } .color-orange { color: #d9730d; } .color-yellow { color: #cb912f; }
    .color-green { color: #448361; } .color-blue { color: #337ea9; } .color-purple { color: #9065b0; } .color-pink { color: #c14c8a; } .color-red { color: #d44c47; }
    .color-grayBackground { background: #f1f1ef; } .color-brownBackground { background: #f4eeee; } .color-orangeBackground { background: #fbecdd; }
    .color-yellowBackground { background: #fbf3db; } .color-greenBackground { background: #edf3ec; } .color-blueBackground { background: #e7f3f8; }
    .color-purpleBackground { background: rgba(244,240,247,.8); } .color-pinkBackground { background: rgba(249,238,243,.8); } .color-redBackground { background: #fdebec; }
    @media (prefers-color-scheme: dark) { [class*="Background"] { background: rgba(255,255,255,.08); } }
    @media print { .page { padding: 0; } iframe { display: none; } }
    """
}
