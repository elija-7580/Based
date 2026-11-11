import Foundation

/// High-fidelity importer for Notion's "HTML" export (the downloaded .zip, an unzipped folder or single .html files).
///
/// Unlike the Markdown export, the HTML export carries block ids, colors, callout icons, toggles and toggle headings,
/// column widths, captions, image sizes, page icons/covers/fonts, typed database properties (row pages list every
/// property with its type) and select colors. Everything is mapped onto native blocks; markup without a native
/// equivalent is kept verbatim as an HTML block (code block with live preview) so nothing is lost.
public final class NotionHTMLImporter {
    public let builder: ImportBuilder
    public var progress: ((Double) -> Void)?

    private var pageFiles: [String: RecordID] = [:]      // standardized .html path → page / database block id
    private var titles: [RecordID: String] = [:]
    private var consumed: Set<String> = []
    private var total = 1
    private var done = 0
    private var flat = false
    private var rowDatabase: [RecordID: RecordID] = [:]  // row page id → database id
    private var dbBlockByFolder: [String: RecordID] = [:] // row folder → database block id
    private var databaseByBlock: [RecordID: RecordID] = [:]
    private var relationTitles: [RecordID: [String: [String]]] = [:] // row → property → titles (fallback)
    private var linkedCandidates: [(blockID: RecordID, folder: String, table: HTMLNode, dir: URL, title: RichText, parent: ParentRef, inline: Bool)] = []
    private var fallbackCount = 0

    public init(builder: ImportBuilder) { self.builder = builder }

    // MARK: Detection

    /// True for HTML files written by Notion's exporter (`<article class="page …">`).
    public static func isNotionHTML(_ url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        let head = String(decoding: h.readData(ofLength: 64 * 1024), as: UTF8.self)
        return head.contains("<article") && (head.contains("class=\"page ") || head.contains("class=\"page\""))
    }

    static func htmlFiles(in dir: URL) -> [URL] {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
        var out: [URL] = []
        for case let u as URL in e where ["html", "htm"].contains(u.pathExtension.lowercased()) { out.append(u) }
        return out.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    static func key(_ u: URL) -> String { u.standardizedFileURL.path }

    // MARK: Entry

    /// Imports a folder (unzipped export) or a single .html file. New top-level pages become builder roots.
    public func importExport(at url: URL) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return }
        let files: [URL]
        if isDir.boolValue {
            files = Self.htmlFiles(in: url)
        } else {
            let folder = url.deletingPathExtension()
            files = [url] + Self.htmlFiles(in: folder)
        }
        for f in files { registerFile(f) }
        total = max(1, files.count)
        flat = !files.contains { f in
            let parent = f.deletingLastPathComponent()
            return FileManager.default.fileExists(atPath: parent.path + ".html")
        }
        if isDir.boolValue {
            for item in topLevelItems(in: url, isRoot: true) { importItem(item, parent: nil) }
        } else {
            importPage(url, parent: nil)
        }
        // Pages nobody linked to (e.g. unlinked subpages): below the page owning their folder, else top level.
        for f in files where !consumed.contains(Self.key(f)) && f.lastPathComponent.lowercased() != "index.html" {
            let owner = URL(fileURLWithPath: f.deletingLastPathComponent().path + ".html")
            if let dbBlock = dbBlockByFolder[Self.key(f.deletingLastPathComponent())], let dbID = databaseByBlock[dbBlock] {
                importPage(f, parent: .database(dbID))
            } else if let pid = pageFiles[Self.key(owner)], builder.contains(pid), builder.block(pid)?.type == .page {
                importPage(f, parent: .block(pid))
            } else {
                importPage(f, parent: nil)
            }
        }
        finish()
    }

    private func registerFile(_ f: URL) {
        let k = Self.key(f)
        guard pageFiles[k] == nil else { return }
        let id = ImportIDs.notionID(inName: f.lastPathComponent) ?? ImportIDs.derived("html-file", f.lastPathComponent, f.deletingLastPathComponent().lastPathComponent)
        pageFiles[k] = id
        titles[id] = NotionImporter.cleanTitle(f.deletingPathExtension().lastPathComponent)
    }

    private func topLevelItems(in dir: URL, isRoot: Bool) -> [URL] {
        let all = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? [])
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        let names = Set(all.map(\.lastPathComponent))
        var out: [URL] = []
        for u in all where ["html", "htm"].contains(u.pathExtension.lowercased()) {
            if isRoot && u.lastPathComponent.lowercased() == "index.html" { continue }
            out.append(u)
        }
        for u in all where (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            if !names.contains(u.lastPathComponent + ".html") { out.append(u) }
        }
        return out
    }

    private func importItem(_ u: URL, parent: ParentRef?) {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
        if isDir.boolValue {
            for item in topLevelItems(in: u, isRoot: false) { importItem(item, parent: parent) }
        } else {
            importPage(u, parent: parent)
        }
    }

    private func tick() {
        done += 1
        progress?(min(1, Double(done) / Double(total)))
    }

    // MARK: Pages

    struct Ctx {
        var dir: URL            // directory of the current .html file (links are relative to it)
        var file: URL
        var pageID: RecordID
        var counter = 0
        var notion = true       // Notion markup (pre-wrap text) vs. generic HTML (collapsible whitespace)
    }

    private func load(_ file: URL) -> HTMLNode? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return HTMLParser.parse(String(decoding: data, as: UTF8.self))
    }

    @discardableResult
    func importPage(_ file: URL, parent: ParentRef?) -> RecordID? {
        let k = Self.key(file)
        guard !consumed.contains(k) else { return nil }
        consumed.insert(k)
        guard let doc = load(file) else { builder.warnings.append("Couldn't read \(file.lastPathComponent)"); return nil }
        tick()
        let article = doc.first { $0.tag == "article" } ?? doc.first { $0.tag == "body" } ?? doc
        if file.lastPathComponent.lowercased() == "index.html", !article.has(class: "page"), parent == nil { return nil }
        let id = pageFiles[k] ?? ImportIDs.derived("html", k)
        var ctx = Ctx(dir: file.deletingLastPathComponent(), file: file, pageID: id)
        ctx.notion = article.has(class: "page")
        let header = article.first { $0.tag == "header" }
        let bodyNode = article.first { $0.has(class: "page-body") }
        var title = header?.first { $0.has(class: "page-title") }.map { richText($0.children, &ctx) } ?? RichText()
        if title.isEmpty, let t = doc.first(where: { $0.tag == "title" })?.rawText.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            title = RichText(t)
        }
        if title.isEmpty { title = RichText(titles[id] ?? NotionImporter.cleanTitle(file.deletingPathExtension().lastPathComponent)) }
        titles[id] = title.plainText

        // Full-page database: header followed by the collection table.
        let looseTable = article.elements.first { $0.tag == "table" && $0.has(class: "collection-content") }
            ?? article.elements.first { $0.tag == "div" && $0.has(class: "collection-content") }?.first { $0.tag == "table" && $0.has(class: "collection-content") }
        let bodyOnly = bodyNode.flatMap { b -> HTMLNode? in
            let els = b.elements.filter { !Self.skipTags.contains($0.tag) }
            guard els.count == 1, let only = els.first, only.has(class: "collection-content") else { return nil }
            return only.tag == "table" ? only : only.first { $0.tag == "table" && $0.has(class: "collection-content") }
        }
        if let table = looseTable ?? bodyOnly, looseTable == nil ? true : (bodyNode?.elements.isEmpty ?? true) {
            let desc = header?.first { $0.has(class: "page-description") }.map { richText($0.children, &ctx) }
            var props = BlockProps()
            applyHeader(header, to: &props, article: article, ctx: &ctx)
            importDatabase(table: table, title: title, summary: desc, blockID: id, parent: parent, inline: false, ctx: &ctx, extra: props)
            builder.markComplete(.block(id))
            return id
        }

        var props = BlockProps()
        applyHeader(header, to: &props, article: article, ctx: &ctx)
        var page = Block(id: id, type: .page, parent: parent ?? .workspace, sortKey: "", text: title, props: props, createdBy: builder.createdBy)
        page.updatedAt = page.createdAt
        builder.add(page, root: parent == nil)
        if let d = header?.first(where: { $0.has(class: "page-description") }), !d.textContent.isEmpty {
            var p = BlockProps(); p.color = .gray
            builder.append(.text, in: .block(id), id: ImportIDs.derived(id, "description"), text: richText(d.children, &ctx), props: p)
        }
        if let body = bodyNode {
            convert(body.children, into: .block(id), &ctx)
        } else if !article.has(class: "page") {
            // Any other HTML file: keep its body.
            convert(article.children.filter { $0.tag != "header" }, into: .block(id), &ctx)
        }
        importRemainingChildren(of: file, into: id)
        builder.markComplete(.block(id))
        return id
    }

    /// Subpages in the page's folder that the content didn't link (appended at the end).
    private func importRemainingChildren(of file: URL, into id: RecordID) {
        let folder = file.deletingPathExtension()
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDir), isDir.boolValue else { return }
        for item in topLevelItems(in: folder, isRoot: false) where !consumed.contains(Self.key(item)) {
            if item.pathExtension.lowercased() == "html" {
                // Row pages of a database living in this folder are imported with the database.
                if isRowFile(item) { continue }
                importPage(item, parent: .block(id))
            } else {
                for f in Self.htmlFiles(in: item) where !consumed.contains(Self.key(f)) && !isRowFile(f) { importPage(f, parent: .block(id)) }
            }
        }
    }

    private func isRowFile(_ f: URL) -> Bool { dbBlockByFolder[Self.key(f.deletingLastPathComponent())] != nil }

    private func applyHeader(_ header: HTMLNode?, to props: inout BlockProps, article: HTMLNode, ctx: inout Ctx) {
        if let iconBox = header?.first(where: { $0.has(class: "page-header-icon") }) {
            if let img = iconBox.first(where: { $0.tag == "img" }), let src = img.attr("src") {
                props.icon = media(src, ctx).map { r in r.asset.map(PageIcon.asset) ?? PageIcon.url(r.url ?? src) } ?? .url(src)
            } else {
                if let e = PageIcon.importedEmoji(iconBox.textContent) { props.icon = e }   // BSD-35
            }
        }
        if let cover = header?.first(where: { $0.tag == "img" && $0.has(class: "page-cover-image") }), let src = cover.attr("src") {
            if let r = media(src, ctx) { props.cover = r.asset.map(PageCover.asset) ?? .url(r.url ?? src) }
            if let pos = cover.style("object-position"), let pct = pos.split(separator: " ").last.flatMap({ Double($0.replacingOccurrences(of: "%", with: "")) }) {
                var f = props.format ?? PageFormat(); f.coverPosition = pct / 100; props.format = f
            }
        }
        let cls = article.classes
        var f = props.format ?? PageFormat()
        if cls.contains("serif") { f.font = .serif } else if cls.contains("mono") { f.font = .mono }
        if cls.contains(where: { $0.contains("full-width") }) { f.fullWidth = true }
        if cls.contains(where: { $0.contains("small-text") }) { f.smallText = true }
        if f != PageFormat() { props.format = f }
    }

    // MARK: Block conversion

    static let inlineTags: Set<String> = ["", "a", "span", "strong", "b", "em", "i", "u", "s", "del", "strike", "code", "mark", "sub", "sup",
                                          "small", "big", "time", "br", "abbr", "cite", "kbd", "q", "label", "font", "wbr"]
    static let skipTags: Set<String> = ["style", "script", "meta", "link", "title", "head", "noscript", "template"]

    private func blockID(_ n: HTMLNode, _ ctx: inout Ctx) -> RecordID {
        if let raw = n.attr("id"), let id = ImportIDs.notion(raw), !builder.contains(id) { return id }
        ctx.counter += 1
        return ImportIDs.derived(ctx.pageID, "block", String(ctx.counter))
    }

    private func color(_ n: HTMLNode) -> TColor? {
        for c in n.classes where c.hasPrefix("block-color-") { return Self.tcolor(String(c.dropFirst("block-color-".count))) }
        return nil
    }

    static func tcolor(_ notion: String) -> TColor? {
        var s = notion.lowercased()
        var bg = false
        if s.hasSuffix("_background") { bg = true; s = String(s.dropLast("_background".count)) }
        if s.hasPrefix("translucent") || s == "default" || s.isEmpty { return nil }
        let hue = TColor(rawValue: s == "grey" ? "gray" : s)
        guard let hue, hue != .default else { return nil }
        return bg ? hue.background : hue
    }

    /// Converts a list of sibling nodes into blocks under `parent`.
    func convert(_ nodes: [HTMLNode], into parent: ParentRef, _ ctx: inout Ctx) {
        var inline: [HTMLNode] = []
        var last: RecordID?
        func flush() {
            let rt = richText(inline, &ctx).trimmed()
            if !rt.isEmpty {
                ctx.counter += 1
                last = builder.append(.text, in: parent, id: ImportIDs.derived(ctx.pageID, "block", String(ctx.counter)), text: rt)
            }
            inline = []
        }
        for n in nodes {
            if Self.skipTags.contains(n.tag) { continue }
            if Self.inlineTags.contains(n.tag) && !(n.tag == "span" && n.elements.contains { !Self.inlineTags.contains($0.tag) }) {
                if n.isText && inline.isEmpty && n.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                inline.append(n); continue
            }
            flush()
            if n.tag == "div", n.has(class: "indented") {
                if let l = last, let b = builder.block(l), b.type.supportsChildren, !b.type.isPageLike {
                    convert(n.children, into: .block(l), &ctx)
                } else {
                    convert(n.children, into: parent, &ctx)
                }
                continue
            }
            if let id = emit(n, into: parent, &ctx) { last = id }
        }
        flush()
    }

    /// One block-level element → block(s). Returns the id of the (last) block created.
    @discardableResult
    func emit(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        switch n.tag {
        case "p":
            var p = BlockProps(); p.color = color(n)
            if n.elements.contains(where: { !Self.inlineTags.contains($0.tag) }) {
                // <p> wrapping block content (generic HTML)
                let id = builder.append(.text, in: parent, id: blockID(n, &ctx), text: richText(n.children.filter { Self.inlineTags.contains($0.tag) }, &ctx).trimmed(), props: p)
                convert(n.children.filter { !Self.inlineTags.contains($0.tag) }, into: .block(id), &ctx)
                return id
            }
            return builder.append(.text, in: parent, id: blockID(n, &ctx), text: richText(n.children, &ctx).trimmed(), props: p)
        case "h1", "h2", "h3", "h4", "h5", "h6":
            if n.has(class: "page-title") || n.has(class: "collection-title") { return nil }
            let type: BlockType = ["h1": .heading1, "h2": .heading2, "h3": .heading3][n.tag] ?? .heading4
            var p = BlockProps(); p.color = color(n)
            return builder.append(type, in: parent, id: blockID(n, &ctx), text: richText(n.children, &ctx).trimmed(), props: p)
        case "ul", "ol":
            return list(n, into: parent, &ctx)
        case "details":
            return toggle(n, id: blockID(n, &ctx), color: color(n), into: parent, &ctx)
        case "blockquote":
            var p = BlockProps(); p.color = color(n)
            let (inl, blocks) = split(n.children)
            let id = builder.append(.quote, in: parent, id: blockID(n, &ctx), text: richText(inl, &ctx).trimmed(), props: p)
            if !blocks.isEmpty { convert(blocks, into: .block(id), &ctx) }
            return id
        case "hr":
            return builder.append(.divider, in: parent, id: blockID(n, &ctx))
        case "pre":
            return code(n, id: blockID(n, &ctx), caption: nil, into: parent, &ctx)
        case "figure":
            return figure(n, into: parent, &ctx)
        case "nav":
            if n.has(class: "table_of_contents") || n.classes.contains(where: { $0.contains("table_of_contents") }) {
                var p = BlockProps(); p.color = color(n)
                return builder.append(.tableOfContents, in: parent, id: blockID(n, &ctx), props: p)
            }
            if n.classes.contains(where: { $0.contains("breadcrumb") }) {
                return builder.append(.breadcrumb, in: parent, id: blockID(n, &ctx))
            }
            return fallback(n, into: parent, &ctx)
        case "table":
            if n.has(class: "collection-content") {
                let id = blockID(n, &ctx)
                return importInlineDatabase(table: n, title: RichText(), blockID: id, parent: parent, &ctx)
            }
            return simpleTable(n, into: parent, &ctx)
        case "img":
            return image(src: n.attr("src"), node: n, caption: nil, id: blockID(n, &ctx), into: parent, &ctx)
        case "iframe", "embed", "object":
            var p = BlockProps(); p.url = n.attr("src") ?? n.attr("data")
            return builder.append(.embed, in: parent, id: blockID(n, &ctx), props: p)
        case "video", "audio":
            let src = n.attr("src") ?? n.first { $0.tag == "source" }?.attr("src")
            return mediaBlock(n.tag == "video" ? .video : .audio, href: src, caption: nil, id: blockID(n, &ctx), into: parent, &ctx)
        case "div", "section", "main", "article", "body", "html", "aside", "footer", "center", "span":
            return div(n, into: parent, &ctx)
        case "header":
            return nil
        case "dl":
            for item in n.elements {
                let rt = richText(item.children, &ctx).trimmed()
                if rt.isEmpty { continue }
                var p = BlockProps()
                if item.tag == "dd" { p.color = .gray }
                builder.append(item.tag == "dt" ? .text : .quote, in: parent, id: blockID(item, &ctx), text: item.tag == "dt" ? rt.applying(0, rt.length) { $0.bold = true } : rt, props: p)
            }
            return nil
        default:
            if n.elements.isEmpty && n.textContent.isEmpty { return nil }
            return fallback(n, into: parent, &ctx)
        }
    }

    private func split(_ nodes: [HTMLNode]) -> (inline: [HTMLNode], blocks: [HTMLNode]) {
        var inl: [HTMLNode] = [], blocks: [HTMLNode] = []
        for c in nodes {
            if blocks.isEmpty && Self.inlineTags.contains(c.tag) { inl.append(c) } else if !Self.skipTags.contains(c.tag) { blocks.append(c) }
        }
        return (inl, blocks)
    }

    private func div(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        if n.has(class: "column-list") { return columns(n, into: parent, &ctx) }
        if n.has(class: "collection-content") {
            let title = n.first { $0.has(class: "collection-title") }.map { richText($0.children, &ctx).trimmed() } ?? RichText()
            guard let table = n.first(where: { $0.tag == "table" }) else { return nil }
            return importInlineDatabase(table: table, title: title, blockID: blockID(n, &ctx), parent: parent, &ctx)
        }
        if n.has(class: "callout") { return callout(n, into: parent, &ctx) }
        if n.has(class: "page-body") || n.has(class: "display-contents") || n.style("display") == "contents" || n.tag != "div" || n.attrs["class"] == nil || n.has(class: "indented") {
            let hasBlocks = n.elements.contains { !Self.inlineTags.contains($0.tag) }
            if hasBlocks || n.tag != "div" && n.tag != "span" {
                convert(n.children, into: parent, &ctx)
                return nil
            }
            let rt = richText(n.children, &ctx).trimmed()
            if rt.isEmpty { return nil }
            var p = BlockProps(); p.color = color(n)
            return builder.append(.text, in: parent, id: blockID(n, &ctx), text: rt, props: p)
        }
        // Unknown classed div: keep its content natively when it is ordinary markup, else as HTML.
        if n.elements.allSatisfy({ ["p", "ul", "ol", "h1", "h2", "h3", "h4", "figure", "pre", "blockquote", "hr", "div", "table", "details", "img"].contains($0.tag) || Self.inlineTags.contains($0.tag) }) {
            convert(n.children, into: parent, &ctx)
            return nil
        }
        return fallback(n, into: parent, &ctx)
    }

    /// Markup without a native equivalent: an HTML code block with live preview.
    @discardableResult
    private func fallback(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        let html = n.outerHTML
        guard !html.isEmpty else { return nil }
        fallbackCount += 1
        var p = BlockProps(); p.language = "html"; p.url = "preview"
        return builder.append(.code, in: parent, id: blockID(n, &ctx), text: RichText(html), props: p)
    }

    // MARK: Lists & toggles

    private func list(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        let cls = n.classes
        let items = n.elements.filter { $0.tag == "li" }
        var last: RecordID?
        for (i, li) in items.enumerated() {
            let id: RecordID = (items.count == 1 && i == 0) ? blockID(n, &ctx) : blockID(li, &ctx)
            let col = color(li) ?? color(n)
            if cls.contains("toggle") || (li.elements.first?.tag == "details" && li.elements.count == 1) {
                if let d = li.first(where: { $0.tag == "details" }) { last = toggle(d, id: id, color: col, into: parent, &ctx); continue }
            }
            let checkbox = li.first { $0.has(class: "checkbox") }
            let type: BlockType = cls.contains("to-do-list") || checkbox != nil ? .todo : (n.tag == "ol" || cls.contains("numbered-list") ? .numberedList : .bulletedList)
            var p = BlockProps(); p.color = col
            if type == .todo { p.checked = checkbox?.has(class: "checkbox-on") ?? false }
            var inlineNodes: [HTMLNode] = [], blockNodes: [HTMLNode] = []
            for c in li.children {
                if c.has(class: "checkbox") { continue }
                if c.tag == "span", c.classes.contains(where: { $0.hasPrefix("to-do-children") }) { inlineNodes.append(contentsOf: c.children); continue }
                if blockNodes.isEmpty && Self.inlineTags.contains(c.tag) { inlineNodes.append(c) }
                else if !Self.skipTags.contains(c.tag) { blockNodes.append(c) }
            }
            // A leading <p> carries the item text in some exports.
            if inlineNodes.allSatisfy({ $0.isText && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }), let first = blockNodes.first, first.tag == "p" {
                inlineNodes = first.children
                blockNodes.removeFirst()
            }
            let lid = builder.append(type, in: parent, id: id, text: richText(inlineNodes, &ctx).trimmed(), props: p)
            if !blockNodes.isEmpty { convert(blockNodes, into: .block(lid), &ctx) }
            last = lid
        }
        return last
    }

    private func toggle(_ d: HTMLNode, id: RecordID, color: TColor?, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID {
        let summary = d.elements.first { $0.tag == "summary" }
        var type: BlockType = .toggle
        var titleNodes = summary?.children ?? []
        if let s = summary {
            if let h = s.elements.first(where: { ["h1", "h2", "h3", "h4"].contains($0.tag) }) {
                type = ["h1": .heading1, "h2": .heading2, "h3": .heading3][h.tag] ?? .heading4
                titleNodes = h.children
            } else if let size = s.style("font-size") {
                switch size.trimmingCharacters(in: .whitespaces) {
                case "1.875em": type = .heading1
                case "1.5em": type = .heading2
                case "1.25em": type = .heading3
                default: break
                }
            }
        }
        var p = BlockProps(); p.color = color ?? summary.flatMap(self.color)
        if type != .toggle { p.toggleable = true }
        let tid = builder.append(type, in: parent, id: id, text: richText(titleNodes, &ctx).trimmed(), props: p)
        let rest = d.children.filter { $0.tag != "summary" }
        var flat: [HTMLNode] = []
        for c in rest { if c.tag == "div", c.has(class: "indented") { flat.append(contentsOf: c.children) } else { flat.append(c) } }
        convert(flat, into: .block(tid), &ctx)
        return tid
    }

    // MARK: Figures, media, code

    private func figure(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        let id = blockID(n, &ctx)
        let caption = n.elements.first { $0.tag == "figcaption" }.map { richText($0.children, &ctx).trimmed() }
        let cap = (caption?.isEmpty ?? true) ? nil : caption
        if n.has(class: "callout") { return callout(n, into: parent, &ctx, id: id) }
        if n.has(class: "equation") {
            let tex = n.first { $0.tag == "annotation" }?.rawText ?? n.textContent
            var p = BlockProps(); p.expression = tex.trimmingCharacters(in: .whitespacesAndNewlines)
            return builder.append(.equation, in: parent, id: id, props: p)
        }
        if n.has(class: "link-to-page"), let a = n.first(where: { $0.tag == "a" }), let href = a.attr("href") {
            return pageLink(href: href, anchor: a, id: id, into: parent, &ctx)
        }
        if let a = n.first(where: { $0.tag == "a" && $0.has(class: "bookmark") }), let href = a.attr("href") {
            var p = BlockProps(); p.url = href; p.caption = cap
            var meta = BookmarkMeta()
            meta.title = a.first { $0.has(class: "bookmark-title") }?.textContent
            meta.summary = a.first { $0.has(class: "bookmark-description") }?.textContent
            meta.imageURL = a.first { $0.has(class: "bookmark-image") }?.attr("src")
            meta.iconURL = a.first { $0.has(class: "bookmark-icon") }?.attr("src")
            if meta.title != nil || meta.imageURL != nil { p.bookmark = meta }
            return builder.append(.bookmark, in: parent, id: id, props: p)
        }
        if let pre = n.first(where: { $0.tag == "pre" }) { return code(pre, id: id, caption: cap, into: parent, &ctx) }
        if n.has(class: "image") || (n.first { $0.tag == "img" } != nil && n.first { $0.has(class: "source") } == nil) {
            let img = n.first { $0.tag == "img" }
            let src = img?.attr("src") ?? n.first { $0.tag == "a" }?.attr("href")
            return image(src: src, node: img, caption: cap, id: id, into: parent, &ctx)
        }
        if let v = n.first(where: { $0.tag == "video" || $0.tag == "audio" }) {
            let src = v.attr("src") ?? v.first { $0.tag == "source" }?.attr("src")
            return mediaBlock(v.tag == "video" ? .video : .audio, href: src, caption: cap, id: id, into: parent, &ctx)
        }
        if let f = n.first(where: { $0.tag == "iframe" }) {
            var p = BlockProps(); p.url = f.attr("src"); p.caption = cap
            return builder.append(.embed, in: parent, id: id, props: p)
        }
        if let a = n.first(where: { $0.tag == "a" }), let href = a.attr("href") {
            return mediaBlock(nil, href: href, caption: cap, id: id, into: parent, &ctx, label: a.textContent)
        }
        if n.elements.isEmpty && n.textContent.isEmpty { return nil }
        return fallback(n, into: parent, &ctx)
    }

    private func callout(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx, id: RecordID? = nil) -> RecordID {
        let id = id ?? blockID(n, &ctx)
        var p = BlockProps(); p.color = color(n)
        let parts = n.elements.filter { !Self.skipTags.contains($0.tag) }
        var content: [HTMLNode] = n.children
        if parts.count >= 2, let iconBox = parts.first {
            if let img = iconBox.first(where: { $0.tag == "img" }), let src = img.attr("src") {
                p.icon = media(src, ctx).map { r in r.asset.map(PageIcon.asset) ?? PageIcon.url(r.url ?? src) } ?? .url(src)
            } else {
                if let e = PageIcon.importedEmoji(iconBox.textContent) { p.icon = e }   // BSD-35
            }
            content = Array(parts.dropFirst()).flatMap { $0.tag == "div" ? $0.children : [$0] }
        }
        let (inl, blocks) = split(content)
        var text = richText(inl, &ctx).trimmed()
        var rest = blocks
        if text.isEmpty, let first = rest.first, first.tag == "p" { text = richText(first.children, &ctx).trimmed(); rest.removeFirst() }
        let cid = builder.append(.callout, in: parent, id: id, text: text, props: p)
        if !rest.isEmpty { convert(rest, into: .block(cid), &ctx) }
        return cid
    }

    private func code(_ pre: HTMLNode, id: RecordID, caption: RichText?, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID {
        let codeNode = pre.first { $0.tag == "code" } ?? pre
        var lang = codeNode.classes.first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)) } ?? "plain text"
        lang = lang.replacingOccurrences(of: "_", with: " ").lowercased()
        if lang == "shell" { lang = "bash" }
        if lang == "plain" || lang.isEmpty { lang = "plain text" }
        var p = BlockProps(); p.language = lang; p.caption = caption
        if pre.classes.contains("code-wrap") { p.wrap = true }
        if lang == "mermaid" { p.url = "preview" }
        var text = codeNode.rawText
        if text.hasSuffix("\n") { text.removeLast() }
        return builder.append(.code, in: parent, id: id, text: RichText(text), props: p)
    }

    /// Local export file or remote URL for a `src` / `href`.
    private func media(_ src: String, _ ctx: Ctx) -> (url: String?, asset: AssetRef?)? {
        guard !src.isEmpty else { return nil }
        if src.hasPrefix("data:"), let comma = src.firstIndex(of: ","), src[..<comma].hasSuffix(";base64"),
           let data = Data(base64Encoded: String(src[src.index(after: comma)...]), options: .ignoreUnknownCharacters) {
            let mime = String(src.dropFirst(5).prefix { $0 != ";" })
            let ext = mime.split(separator: "/").last.map { $0 == "jpeg" ? "jpg" : String($0.prefix { $0.isLetter }) } ?? "bin"
            let u = FileManager.default.temporaryDirectory.appendingPathComponent("based-inline-" + UUID().uuidString + "." + ext)
            if (try? data.write(to: u)) != nil { return (nil, builder.asset(file: u, name: "image." + ext, mime: mime)) }
        }
        if src.contains("://") || src.hasPrefix("data:") || src.hasPrefix("mailto:") { return (src, nil) }
        let decoded = src.removingPercentEncoding ?? src
        let u = ctx.dir.appendingPathComponent(decoded)
        if FileManager.default.fileExists(atPath: u.path) { return (nil, builder.asset(file: u)) }
        return (src, nil)
    }

    private func image(src: String?, node: HTMLNode?, caption: RichText?, id: RecordID, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        guard let src, let m = media(src, ctx) else { return nil }
        var p = BlockProps(); p.url = m.url; p.asset = m.asset; p.caption = caption
        if let w = node?.style("width"), w.hasSuffix("px"), let px = Double(w.dropLast(2)) { p.width = px }
        else if let w = node?.attr("width"), let px = Double(w) { p.width = px }
        return builder.append(.image, in: parent, id: id, props: p)
    }

    static let videoExt: Set<String> = ["mp4", "mov", "m4v", "webm", "avi", "mkv"]
    static let audioExt: Set<String> = ["mp3", "m4a", "wav", "ogg", "aac", "flac"]
    static let imageExt: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "bmp", "tiff"]

    private func mediaBlock(_ forced: BlockType?, href: String?, caption: RichText?, id: RecordID, into parent: ParentRef, _ ctx: inout Ctx, label: String? = nil) -> RecordID? {
        guard let href, let m = media(href, ctx) else { return nil }
        let ext = (URL(string: href)?.pathExtension ?? (href as NSString).pathExtension).lowercased()
        var type: BlockType = forced ?? .file
        if forced == nil {
            if Self.videoExt.contains(ext) { type = .video }
            else if Self.audioExt.contains(ext) { type = .audio }
            else if Self.imageExt.contains(ext) { type = .image }
            else if ext == "pdf" { type = .pdf }
            else if m.asset == nil {
                let host = URL(string: href)?.host?.lowercased() ?? ""
                if host.contains("youtube.com") || host.contains("youtu.be") || host.contains("vimeo.com") || host.contains("loom.com") { type = .video }
                else if m.url?.hasPrefix("http") == true { type = .embed }
            }
        }
        var p = BlockProps(); p.url = m.url; p.asset = m.asset; p.caption = caption
        if type == .file, m.asset == nil, let label, !label.isEmpty, caption == nil, label != href { p.caption = RichText(label) }
        return builder.append(type, in: parent, id: id, props: p)
    }

    // MARK: Page links

    private func resolve(_ href: String, _ ctx: Ctx) -> (id: RecordID, file: URL?)? {
        if href.hasPrefix("#") || href.hasPrefix("mailto:") || href.hasPrefix("tel:") { return nil }
        if href.contains("://") {
            guard let host = URL(string: href)?.host?.lowercased(), host.hasSuffix("notion.so") || host.hasSuffix("notion.site") || host.hasSuffix("notion.com"),
                  let id = ImportIDs.notionID(inName: URL(string: href)?.path ?? href) else { return nil }
            return (id, nil)
        }
        let path = href.split(separator: "#").first.map(String.init) ?? href
        guard path.lowercased().hasSuffix(".html") else { return nil }
        let u = ctx.dir.appendingPathComponent(path.removingPercentEncoding ?? path).standardizedFileURL
        if let id = pageFiles[Self.key(u)] { return (id, u) }
        if let id = ImportIDs.notionID(inName: u.lastPathComponent) { return (id, FileManager.default.fileExists(atPath: u.path) ? u : nil) }
        return nil
    }

    private func pageLink(href: String, anchor: HTMLNode, id: RecordID, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        guard let target = resolve(href, ctx) else {
            // Not a page: keep the link as text.
            let rt = richText(anchor.children, &ctx).trimmed()
            let text = rt.isEmpty ? RichText(href) : rt
            return builder.append(.text, in: parent, id: id, text: text.applying(0, text.length) { $0.link = href })
        }
        if let file = target.file, !consumed.contains(Self.key(file)) {
            let ownFolder = ctx.file.deletingPathExtension().standardizedFileURL.path
            let isChild = file.deletingLastPathComponent().standardizedFileURL.path == ownFolder
                || (flat && file.deletingLastPathComponent().standardizedFileURL.path == ctx.dir.standardizedFileURL.path)
            if isChild, case .block = parent {
                // A subpage: import it right here.
                if let pid = importPage(file, parent: parent) { return pid }
            }
        }
        var p = BlockProps(); p.linkTarget = target.id
        return builder.append(.linkToPage, in: parent, id: id, props: p)
    }

    // MARK: Columns & simple tables

    private func columns(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        let cols = n.elements.filter { $0.has(class: "column") }
        guard !cols.isEmpty else { convert(n.children, into: parent, &ctx); return nil }
        let id = builder.append(.columnList, in: parent, id: blockID(n, &ctx))
        for c in cols {
            var p = BlockProps()
            if let w = c.style("width") { p.ratio = Self.columnRatio(w) }
            let cid = builder.append(.column, in: .block(id), id: blockID(c, &ctx), props: p)
            convert(c.children, into: .block(cid), &ctx)
        }
        return id
    }

    /// "50%" → 0.5, "calc((100% - 92px) * 0.3333)" → 0.3333
    static func columnRatio(_ w: String) -> Double? {
        let s = w.trimmingCharacters(in: .whitespaces)
        if s.hasSuffix("%"), let v = Double(s.dropLast()) { return v / 100 }
        if let star = s.lastIndex(of: "*") {
            let num = s[s.index(after: star)...].filter { $0.isNumber || $0 == "." }
            return Double(num)
        }
        return nil
    }

    private func simpleTable(_ n: HTMLNode, into parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        let head = n.elements.first { $0.tag == "thead" }
        let headRows = head?.elements.filter { $0.tag == "tr" } ?? []
        let bodyRows = n.elements.filter { $0.tag == "tbody" }.flatMap { $0.elements.filter { $0.tag == "tr" } } + n.elements.filter { $0.tag == "tr" }
        let rows = headRows + bodyRows
        guard !rows.isEmpty else { return nil }
        var p = BlockProps()
        let width = rows.map { $0.elements.filter { $0.tag == "td" || $0.tag == "th" }.count }.max() ?? 1
        p.tableColumns = max(1, width)
        p.tableHeaderRow = !headRows.isEmpty
        p.tableHeaderColumn = !bodyRows.isEmpty && bodyRows.allSatisfy { r in
            guard let c = r.elements.first(where: { $0.tag == "td" || $0.tag == "th" }) else { return false }
            return c.tag == "th" || c.classes.contains { $0.hasPrefix("simple-table-header") }
        }
        if p.tableHeaderRow == false, p.tableHeaderColumn == false { p.tableHeaderRow = nil; p.tableHeaderColumn = nil }
        let id = builder.append(.table, in: parent, id: blockID(n, &ctx), props: p)
        for r in rows {
            var rp = BlockProps()
            var cells = r.elements.filter { $0.tag == "td" || $0.tag == "th" }.map { richText($0.children, &ctx).trimmed() }
            while cells.count < width { cells.append(RichText()) }
            rp.cells = cells
            builder.append(.tableRow, in: .block(id), id: blockID(r, &ctx), props: rp)
        }
        return id
    }

    // MARK: Rich text

    func richText(_ nodes: [HTMLNode], _ ctx: inout Ctx) -> RichText {
        var runs: [TextRun] = []
        func add(_ s: String, _ m: Marks) {
            guard !s.isEmpty else { return }
            runs.append(TextRun(s.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\r", with: ""), marks: m))
        }
        func walk(_ n: HTMLNode, _ m: Marks, inLink: Bool) {
            if n.isText {
                // Notion writes pre-wrap text (line breaks are <br>); generic HTML collapses whitespace.
                add(ctx.notion ? n.text.replacingOccurrences(of: "\n", with: " ") : HTMLParser.collapse(n.text), m); return
            }
            var m = m
            switch n.tag {
            case "br": add("\n", m); return
            case "style", "script", "svg": return
            case "strong", "b": m.bold = true
            case "em", "i": m.italic = true
            case "u", "ins": m.underline = true
            case "s", "del", "strike": m.strikethrough = true
            case "code", "kbd": m.code = true
            case "mark":
                m.color = n.classes.first { $0.hasPrefix("highlight-") }.flatMap { Self.tcolor(String($0.dropFirst(10))) } ?? .yellowBackground
            case "img":
                if !inLink, let alt = n.attr("alt"), !alt.isEmpty, !n.has(class: "icon") { add(alt, m) }
                return
            case "time":
                let raw = n.textContent
                let s = raw.hasPrefix("@") ? String(raw.dropFirst()) : raw
                if let d = DateParsing.parse(s) { runs.append(TextRun("@" + s, marks: m, mention: .date(d))) } else { add(raw, m) }
                return
            case "span":
                if n.has(class: "notion-text-equation-token") {
                    let tex = (n.first { $0.tag == "annotation" }?.rawText ?? n.textContent).trimmingCharacters(in: .whitespacesAndNewlines)
                    runs.append(TextRun(tex, marks: m, equation: tex)); return
                }
                if n.has(class: "user") {
                    let name = n.textContent
                    runs.append(TextRun(name.hasPrefix("@") ? name : "@" + name, marks: m, mention: .user(name.hasPrefix("@") ? String(name.dropFirst()) : name))); return
                }
                if n.has(class: "icon") && inLink { return }
                if let st = n.attrs["style"], st.contains("border-bottom") { m.underline = true }
                if let h = n.classes.first(where: { $0.hasPrefix("highlight-") }) { m.color = Self.tcolor(String(h.dropFirst(10))) }
                if n.has(class: "katex-mathml") || n.has(class: "katex-html") { return }
            case "a":
                guard let href = n.attr("href"), !href.isEmpty else { break }
                if let target = resolve(href, ctx) {
                    let label = n.children.filter { !($0.tag == "span" && $0.has(class: "icon")) && $0.tag != "img" }
                    var tmp = ctx
                    let text = richTextPlain(label, &tmp)
                    let title = titles[target.id]
                    if title == nil || text.isEmpty || text == title || text.hasPrefix(title ?? "\u{0}") {
                        runs.append(TextRun(text.isEmpty ? (title ?? "Untitled") : text, marks: m, mention: .page(target.id)))
                        return
                    }
                    m.link = "based://page/" + target.id
                } else if href.hasPrefix("#") {
                    break
                } else {
                    m.link = href
                }
                for c in n.children { walk(c, m, inLink: true) }
                return
            default: break
            }
            for c in n.children { walk(c, m, inLink: inLink) }
        }
        for n in nodes { walk(n, .plain, inLink: false) }
        var rt = RichText(runs: runs)
        rt.normalize()
        return rt
    }

    private func richTextPlain(_ nodes: [HTMLNode], _ ctx: inout Ctx) -> String {
        HTMLParser.collapse(nodes.map(\.rawText).joined()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Databases

    private struct Column {
        var name: String
        var hint: PropertyType?          // from the header icon
        var cellClass: String?
        var rowType: [String: Int] = [:] // property-row-<type> votes from row pages
    }

    private struct RowSource {
        var id: RecordID
        var title: RichText
        var cells: [String: HTMLNode] = [:]      // property name → value node
        var cellDirs: [String: URL] = [:]        // links in a cell are relative to the file it came from
        var file: URL?
        var doc: HTMLNode?
        var icon: PageIcon?
    }

    @discardableResult
    private func importInlineDatabase(table: HTMLNode, title: RichText, blockID: RecordID, parent: ParentRef, _ ctx: inout Ctx) -> RecordID? {
        // Rows linking into another database's folder: a linked view of that database.
        if let folder = rowFolder(of: table, ctx), !folder.hasPrefix(ctx.file.deletingPathExtension().standardizedFileURL.path + "/") && folder != ctx.file.deletingPathExtension().standardizedFileURL.path {
            let ownerFolder = folder
            if dbBlockByFolder[ownerFolder] == nil {
                // Defer: the owner may be imported later; resolved in `finish`.
                var p = BlockProps(); p.databaseID = nil
                let id = builder.append(.databaseInline, in: parent, id: blockID, props: p)
                linkedCandidates.append((id, ownerFolder, table, ctx.dir, title, parent, true))
                return id
            }
            return linkedView(blockID: blockID, folder: ownerFolder, table: table, parent: parent, existing: false)
        }
        importDatabase(table: table, title: title, summary: nil, blockID: blockID, parent: parent, inline: true, ctx: &ctx, extra: BlockProps())
        return blockID
    }

    private func linkedView(blockID: RecordID, folder: String, table: HTMLNode, parent: ParentRef, existing: Bool) -> RecordID? {
        guard let srcBlock = dbBlockByFolder[folder], let dbID = databaseByBlock[srcBlock], let db = builder.database(dbID) else { return nil }
        let viewID = ImportIDs.derived(blockID, "view")
        var v = DatabaseView(id: viewID, databaseID: dbID, blockID: blockID, name: "Table", type: .table, sortKey: FractionalIndex.first)
        let names = headerNames(table)
        var vp: [ViewProperty] = names.compactMap { n in db.property(named: n).map { ViewProperty(id: $0.id, visible: true) } }
        for p in db.properties where !vp.contains(where: { $0.id == p.id }) { vp.append(ViewProperty(id: p.id, visible: false)) }
        v.properties = vp
        builder.addView(v)
        var p = BlockProps(); p.databaseID = dbID; p.viewIDs = [viewID]
        if existing { builder.update(blockID) { $0.props = p } }
        else { builder.append(.databaseInline, in: parent, id: blockID, props: p) }
        return blockID
    }

    private func headerNames(_ table: HTMLNode) -> [String] {
        (table.first { $0.tag == "thead" }?.all { $0.tag == "th" } ?? []).map { $0.textContent }
    }

    /// Folder that holds the row pages linked from a collection table.
    private func rowFolder(of table: HTMLNode, _ ctx: Ctx) -> String? {
        for td in table.all(where: { $0.tag == "td" && $0.has(class: "cell-title") }) {
            if let href = td.first(where: { $0.tag == "a" })?.attr("href"), !href.contains("://") {
                let u = ctx.dir.appendingPathComponent(href.removingPercentEncoding ?? href).standardizedFileURL
                return u.deletingLastPathComponent().path
            }
        }
        return nil
    }

    static func svgType(_ th: HTMLNode) -> PropertyType? {
        guard let svg = th.first(where: { $0.tag == "svg" }) else { return nil }
        let c = (svg.attrs["class"] ?? "").lowercased()
        let table: [(String, PropertyType)] = [
            ("typestitle", .title), ("multipleselect", .multiSelect), ("multiselect", .multiSelect), ("status", .status),
            ("createdby", .createdBy), ("lasteditedby", .lastEditedBy), ("updatedby", .lastEditedBy), ("editedby", .lastEditedBy),
            ("createdat", .createdTime), ("createdtime", .createdTime), ("updatedat", .lastEditedTime), ("lasteditedtime", .lastEditedTime), ("editedtime", .lastEditedTime),
            ("select", .select), ("date", .date), ("person", .person), ("people", .person), ("file", .files),
            ("checkbox", .checkbox), ("url", .url), ("email", .email), ("phone", .phone), ("number", .number),
            ("formula", .formula), ("relation", .relation), ("rollup", .rollup), ("autoincrement", .uniqueID), ("uniqueid", .uniqueID),
            ("location", .place), ("place", .place), ("button", .button), ("verification", .verification), ("text", .text),
        ]
        for (k, t) in table where c.contains(k) { return t }
        return nil
    }

    static func rowType(_ notion: String) -> PropertyType? {
        switch notion {
        case "title": return .title
        case "text", "rich_text": return .text
        case "number": return .number
        case "select": return .select
        case "multi_select": return .multiSelect
        case "status": return .status
        case "date": return .date
        case "person", "people": return .person
        case "file", "files": return .files
        case "checkbox": return .checkbox
        case "url": return .url
        case "email": return .email
        case "phone_number": return .phone
        case "formula": return .formula
        case "relation": return .relation
        case "rollup": return .rollup
        case "created_time": return .createdTime
        case "created_by": return .createdBy
        case "last_edited_time": return .lastEditedTime
        case "last_edited_by": return .lastEditedBy
        case "auto_increment_id", "unique_id": return .uniqueID
        case "place", "location": return .place
        case "button": return .button
        case "verification": return .verification
        default: return nil
        }
    }

    @discardableResult
    private func importDatabase(table: HTMLNode, title: RichText, summary: RichText?, blockID: RecordID, parent: ParentRef?, inline: Bool,
                                ctx: inout Ctx, extra: BlockProps) -> RecordID {
        let dbID = ImportIDs.derived(blockID, "database")
        databaseByBlock[blockID] = dbID
        if let folder = rowFolder(of: table, ctx) { dbBlockByFolder[folder] = blockID }
        else { dbBlockByFolder[ctx.dir.appendingPathComponent(title.plainText).standardizedFileURL.path] = blockID }

        // Header
        let ths = table.first { $0.tag == "thead" }?.all { $0.tag == "th" } ?? []
        var columns: [Column] = ths.map { Column(name: $0.textContent, hint: Self.svgType($0)) }
        let trs = (table.first { $0.tag == "tbody" } ?? table).elements.filter { $0.tag == "tr" }
        var titleIndex = columns.firstIndex { $0.hint == .title }
        if titleIndex == nil, let first = trs.first {
            titleIndex = first.elements.filter { $0.tag == "td" }.firstIndex { $0.has(class: "cell-title") }
        }
        let ti = titleIndex ?? 0
        if columns.isEmpty { columns = [Column(name: "Name", hint: .title)] }
        for (i, td) in (trs.first?.elements.filter { $0.tag == "td" } ?? []).enumerated() where i < columns.count {
            columns[i].cellClass = td.classes.first { $0.hasPrefix("cell-") && $0 != "cell-title" }
        }

        // Rows (table cells + row pages)
        var rows: [RowSource] = []
        var extraNames: [String] = []
        var extraTypes: [String: [String: Int]] = [:]
        for (ri, tr) in trs.enumerated() {
            let tds = tr.elements.filter { $0.tag == "td" }
            let titleCell = ti < tds.count ? tds[ti] : tds.first
            let a = titleCell?.first { $0.tag == "a" }
            var file: URL?
            if let href = a?.attr("href"), !href.contains("://") {
                let u = ctx.dir.appendingPathComponent(href.removingPercentEncoding ?? href).standardizedFileURL
                if FileManager.default.fileExists(atPath: u.path) { file = u }
            }
            let rid = tr.attr("id").flatMap(ImportIDs.notion) ?? a?.attr("href").flatMap { ImportIDs.notionID(inName: (($0.removingPercentEncoding ?? $0) as NSString).lastPathComponent) } ?? ImportIDs.derived(dbID, "row", String(ri))
            let label = (a ?? titleCell).map { node in node.children.filter { !($0.tag == "span" && $0.has(class: "icon")) && $0.tag != "img" } } ?? []
            var tctx = Ctx(dir: ctx.dir, file: ctx.file, pageID: rid)
            var row = RowSource(id: rid, title: richText(label, &tctx).trimmed(), file: file)
            if let icon = a?.first(where: { $0.has(class: "icon") }) {
                if icon.tag == "img", let src = icon.attr("src") { row.icon = media(src, tctx).map { r in r.asset.map(PageIcon.asset) ?? PageIcon.url(r.url ?? src) } }
                else if let e = PageIcon.importedEmoji(icon.textContent) { row.icon = e }
            }
            for (i, td) in tds.enumerated() where i != ti && i < columns.count { row.cells[columns[i].name] = td; row.cellDirs[columns[i].name] = ctx.dir }
            if let file, !consumed.contains(Self.key(file)), let doc = load(file) {
                consumed.insert(Self.key(file))
                tick()
                row.doc = doc
                if let props = doc.first(where: { $0.tag == "table" && $0.has(class: "properties") }) {
                    for tr2 in props.all(where: { $0.tag == "tr" }) {
                        guard let th = tr2.first(where: { $0.tag == "th" }), let td = tr2.first(where: { $0.tag == "td" }) else { continue }
                        let name = th.textContent
                        let typeClass = tr2.classes.first { $0.hasPrefix("property-row-") }.map { String($0.dropFirst(13)) }
                        if let ci = columns.firstIndex(where: { $0.name == name }) {
                            if let t = typeClass { columns[ci].rowType[t, default: 0] += 1 }
                            if columns[ci].hint == nil { columns[ci].hint = Self.svgType(th) }
                        } else {
                            if !extraNames.contains(name) { extraNames.append(name) }
                            if let t = typeClass { extraTypes[name, default: [:]][t, default: 0] += 1 }
                            else if let t = Self.svgType(th) { extraTypes[name, default: [:]]["svg:" + t.rawValue, default: 0] += 1 }
                        }
                        row.cells[name] = td
                        row.cellDirs[name] = file.deletingLastPathComponent()
                    }
                }
                if let header = doc.first(where: { $0.tag == "header" }), let iconBox = header.first(where: { $0.has(class: "page-header-icon") }) {
                    if let img = iconBox.first(where: { $0.tag == "img" }), let src = img.attr("src") {
                        let rctx = Ctx(dir: file.deletingLastPathComponent(), file: file, pageID: rid)
                        row.icon = media(src, rctx).map { r in r.asset.map(PageIcon.asset) ?? PageIcon.url(r.url ?? src) }
                    } else if let e = PageIcon.importedEmoji(iconBox.textContent) { row.icon = e }
                }
            }
            rows.append(row)
            rowDatabase[rid] = dbID
            titles[rid] = row.title.plainText
            if let file { pageFiles[Self.key(file)] = rid }
        }

        // Schema
        var schema: [PropertySchema] = []
        var visible: [String] = []
        let titleName = ti < columns.count ? columns[ti].name : "Name"
        schema.append(PropertySchema(id: Database.titlePropertyID, name: titleName.isEmpty ? "Name" : titleName, type: .title))
        visible.append(Database.titlePropertyID)
        var allNames: [(String, PropertyType?, [String: Int], Bool)] = []
        for (i, c) in columns.enumerated() where i != ti { allNames.append((c.name, c.hint, c.rowType, true)) }
        for n in extraNames {
            var votes = extraTypes[n] ?? [:]
            let svg = votes.keys.first { $0.hasPrefix("svg:") }.flatMap { PropertyType(rawValue: String($0.dropFirst(4))) }
            votes = votes.filter { !$0.key.hasPrefix("svg:") }
            allNames.append((n, svg, votes, false))
        }
        for (name, hint, votes, isVisible) in allNames {
            let cells = rows.compactMap { $0.cells[name] }
            var type = votes.max { $0.value < $1.value }.flatMap { Self.rowType($0.key) } ?? hint ?? Self.guessType(cells)
            if type == .title { type = .text }
            var p = PropertySchema(id: ImportIDs.derived(dbID, "property", name), name: name, type: type)
            switch type {
            case .formula, .rollup:
                // The HTML export has values only: keep them as static values.
                let inner = Self.guessType(cells)
                p.type = [.number, .date, .checkbox].contains(inner) ? inner : .text
                p.description = "\(type == .formula ? "Formula" : "Rollup") in Notion (the HTML export has no expression; import via the Notion API to keep it live)."
            case .select, .multiSelect, .status:
                var opts: [SelectOption] = []
                for c in cells {
                    for (label, col) in Self.optionValues(c) where !opts.contains(where: { $0.name == label }) {
                        opts.append(SelectOption(id: ImportIDs.derived(dbID, name, label), name: label, color: col))
                    }
                }
                p.options = opts
                if type == .status { p.statusGroups = Self.statusGroups(opts, salt: dbID + name) }
            case .number:
                p.numberFormat = Self.numberFormat(cells.map(\.textContent))
            case .uniqueID:
                p.idPrefix = cells.map(\.textContent).first { $0.contains("-") }.map { String($0[..<$0.lastIndex(of: "-")!]) }
            case .button, .verification:
                continue
            default: break
            }
            schema.append(p)
            visible.append(isVisible ? p.id : "-" + p.id)
        }

        var db = Database(id: dbID, blockID: blockID, title: title, properties: schema)
        db.summary = (summary?.isEmpty ?? true) ? nil : summary
        let viewID = ImportIDs.derived(blockID, "view")
        var view = DatabaseView(id: viewID, databaseID: dbID, blockID: blockID, name: "Table", type: .table, sortKey: FractionalIndex.first)
        view.properties = visible.map { $0.hasPrefix("-") ? ViewProperty(id: String($0.dropFirst()), visible: false) : ViewProperty(id: $0, visible: true) }
        var bp = extra
        bp.databaseID = dbID
        bp.viewIDs = [viewID]
        var container = Block(id: blockID, type: inline ? .databaseInline : .databasePage, parent: parent ?? .workspace, sortKey: "", props: bp, createdBy: builder.createdBy)
        if !inline { container.text = title }
        builder.add(container, root: parent == nil)
        builder.addView(view)

        // Row blocks
        var maxUnique = 0
        for row in rows {
            var values: [String: PropertyValue] = [:]
            var created: Date?, edited: Date?, createdBy: String?, editedBy: String?
            let rdir = row.file?.deletingLastPathComponent() ?? ctx.dir
            var rctx = Ctx(dir: rdir, file: row.file ?? ctx.file, pageID: row.id)
            // Cells of the table are relative to the table's file, row page properties to the row file.
            for p in schema where p.type != .title {
                guard let node = row.cells[p.name] else { continue }
                let vctx = Ctx(dir: row.cellDirs[p.name] ?? ctx.dir, file: row.file ?? ctx.file, pageID: row.id)
                switch p.type {
                case .createdTime: created = DateParsing.parse(Self.stripAt(node.textContent))?.start
                case .lastEditedTime: edited = DateParsing.parse(Self.stripAt(node.textContent))?.start
                case .createdBy: createdBy = Self.people(node).first
                case .lastEditedBy: editedBy = Self.people(node).first
                case .uniqueID:
                    if let n = Int(node.textContent.split(separator: "-").last.map(String.init) ?? node.textContent) { values[p.id] = .uniqueID(n); maxUnique = max(maxUnique, n) }
                default:
                    var vc = vctx
                    if let v = value(node, p, row: row.id, &vc) { values[p.id] = v }
                }
            }
            var b = Block(id: row.id, type: .page, parent: .database(dbID), sortKey: "", text: row.title, values: values,
                          createdAt: created ?? Date(), createdBy: createdBy ?? builder.createdBy)
            b.updatedAt = edited ?? created ?? b.createdAt
            b.updatedBy = editedBy ?? b.createdBy
            if let icon = row.icon { b.props.icon = icon }
            if let doc = row.doc, let header = doc.first(where: { $0.tag == "header" }) {
                var hp = b.props
                applyHeader(header, to: &hp, article: doc.first { $0.tag == "article" } ?? doc, ctx: &rctx)
                b.props = hp
            }
            builder.add(b)
            if let doc = row.doc, let body = doc.first(where: { $0.has(class: "page-body") }) {
                convert(body.children, into: .block(row.id), &rctx)
            }
            if let f = row.file { importRemainingChildren(of: f, into: row.id) }
            builder.markComplete(.block(row.id))
        }
        if maxUnique > 0 { db.nextUniqueID = maxUnique + 1 }
        builder.addDatabase(db)
        builder.markComplete(.database(dbID))
        return blockID
    }

    static func stripAt(_ s: String) -> String { s.hasPrefix("@") ? String(s.dropFirst()) : s }

    static func people(_ node: HTMLNode) -> [String] {
        let users = node.all { $0.has(class: "user") }.map { stripAt($0.textContent) }.filter { !$0.isEmpty }
        if !users.isEmpty { return users }
        let t = node.textContent
        return t.isEmpty ? [] : t.split(separator: ",").map { stripAt($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// (label, color) of select / status chips in a cell.
    static func optionValues(_ node: HTMLNode) -> [(String, TColor)] {
        let chips = node.all { $0.has(class: "selected-value") || $0.has(class: "status-value") }
        if chips.isEmpty {
            let t = node.textContent
            return t.isEmpty ? [] : t.split(separator: ",").map { ($0.trimmingCharacters(in: .whitespaces), TColor.default) }
        }
        return chips.map { chip in
            let colorClass = chip.classes.first { $0.hasPrefix("select-value-color-") }.map { String($0.dropFirst(19)) }
            let label = chip.textContent
            return (label, colorClass.flatMap(tcolor) ?? .default)
        }.filter { !$0.0.isEmpty }
    }

    static func statusGroups(_ opts: [SelectOption], salt: String) -> [StatusGroup] {
        var todo: [String] = [], doing: [String] = [], done: [String] = []
        for o in opts {
            let n = o.name.lowercased()
            if o.color == .green || ["done", "complete", "completed", "erledigt", "fertig", "closed", "shipped", "abgeschlossen"].contains(where: n.contains) { done.append(o.id) }
            else if o.color == .blue || ["progress", "doing", "arbeit", "review", "active", "started"].contains(where: { n.contains($0) && !n.contains("not started") }) { doing.append(o.id) }
            else { todo.append(o.id) }
        }
        return [StatusGroup(id: ImportIDs.derived(salt, "todo"), name: "To-do", color: .gray, optionIDs: todo),
                StatusGroup(id: ImportIDs.derived(salt, "doing"), name: "In progress", color: .blue, optionIDs: doing),
                StatusGroup(id: ImportIDs.derived(salt, "done"), name: "Complete", color: .green, optionIDs: done)]
    }

    static func numberFormat(_ values: [String]) -> NumberFormat? {
        let v = values.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !v.isEmpty else { return nil }
        let pairs: [(String, NumberFormat)] = [("$", .dollar), ("€", .euro), ("£", .pound), ("¥", .yen), ("₹", .rupee), ("₩", .won), ("R$", .real), ("₽", .ruble), ("₺", .lira), ("CHF", .franc)]
        for (sym, f) in pairs where v.allSatisfy({ $0.contains(sym) }) { return f }
        if v.allSatisfy({ $0.hasSuffix("%") }) { return .percent }
        if v.contains(where: { $0.contains(",") }) { return .numberWithCommas }
        return nil
    }

    static func number(_ raw: String) -> Double? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let pct = t.hasSuffix("%")
        let digits = t.filter { $0.isNumber || $0 == "." || $0 == "-" || $0 == "e" || $0 == "E" }
        guard let d = Double(digits) else { return nil }
        return pct ? d / 100 : d
    }

    static func guessType(_ cells: [HTMLNode]) -> PropertyType {
        let nonEmpty = cells.filter { !$0.textContent.isEmpty || $0.first { $0.has(class: "checkbox") } != nil }
        guard !nonEmpty.isEmpty else { return .text }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "checkbox") } != nil }) { return .checkbox }
        if nonEmpty.contains(where: { $0.first { $0.has(class: "status-value") } != nil }) { return .status }
        if nonEmpty.contains(where: { $0.all { $0.has(class: "selected-value") }.count > 1 }) { return .multiSelect }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "selected-value") } != nil }) { return .select }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "user") } != nil }) { return .person }
        if nonEmpty.allSatisfy({ $0.first { $0.tag == "time" } != nil }) { return .date }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "url-value") } != nil }) { return .url }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "email-value") } != nil }) { return .email }
        if nonEmpty.allSatisfy({ $0.first { $0.has(class: "phone-value") } != nil }) { return .phone }
        if nonEmpty.allSatisfy({ c in c.first { $0.tag == "a" && ($0.attr("href") ?? "").lowercased().contains(".html") } != nil }) { return .relation }
        if nonEmpty.allSatisfy({ number($0.textContent) != nil && $0.elements.allSatisfy { $0.tag == "span" || $0.tag == "br" } }) { return .number }
        return .text
    }

    private func value(_ node: HTMLNode, _ p: PropertySchema, row: RecordID, _ ctx: inout Ctx) -> PropertyValue? {
        let text = node.textContent
        switch p.type {
        case .text, .formula, .rollup:
            let rt = richText(node.children, &ctx).trimmed()
            return rt.isEmpty ? nil : .text(rt)
        case .number: return Self.number(text).map(PropertyValue.number)
        case .select:
            guard let (label, _) = Self.optionValues(node).first, let o = p.option(named: label) else { return nil }
            return .select(o.id)
        case .status:
            guard let (label, _) = Self.optionValues(node).first, let o = p.option(named: label) else { return nil }
            return .status(o.id)
        case .multiSelect:
            let ids = Self.optionValues(node).compactMap { p.option(named: $0.0)?.id }
            return ids.isEmpty ? nil : .multiSelect(ids)
        case .date:
            return DateParsing.parse(Self.stripAt(text)).map(PropertyValue.date)
        case .person:
            let ps = Self.people(node)
            return ps.isEmpty ? nil : .person(ps)
        case .files:
            var files: [FileValue] = []
            for a in node.all(where: { $0.tag == "a" }) {
                guard let href = a.attr("href"), let m = media(href, ctx) else { continue }
                let name = a.textContent.isEmpty ? ((href.removingPercentEncoding ?? href) as NSString).lastPathComponent : a.textContent
                files.append(FileValue(name: name, asset: m.asset, url: m.url))
            }
            if files.isEmpty, !text.isEmpty { files = text.split(separator: ",").map { FileValue(name: $0.trimmingCharacters(in: .whitespaces), url: nil) } }
            return files.isEmpty ? nil : .files(files)
        case .checkbox:
            if let cb = node.first(where: { $0.has(class: "checkbox") }) { return .checkbox(cb.has(class: "checkbox-on")) }
            return .checkbox(["yes", "true", "✓", "☑"].contains(text.lowercased()))
        case .url:
            let href = node.first { $0.tag == "a" }?.attr("href")
            let v = href ?? text
            return v.isEmpty ? nil : .url(v)
        case .email:
            let v = node.first { $0.tag == "a" }?.attr("href")?.replacingOccurrences(of: "mailto:", with: "") ?? text
            return v.isEmpty ? nil : .email(v)
        case .phone:
            let v = node.first { $0.tag == "a" }?.attr("href")?.replacingOccurrences(of: "tel:", with: "") ?? text
            return v.isEmpty ? nil : .phone(v)
        case .relation:
            var ids: [RecordID] = []
            var names: [String] = []
            for a in node.all(where: { $0.tag == "a" }) {
                guard let href = a.attr("href") else { continue }
                names.append(a.textContent)
                if let t = resolve(href, ctx) { ids.append(t.id) }
            }
            if !names.isEmpty { relationTitles[row, default: [:]][p.id] = names }
            return ids.isEmpty ? nil : .relation(ids)
        case .place:
            return text.isEmpty ? nil : .place(text)
        default:
            return nil
        }
    }

    // MARK: Finish

    private func finish() {
        // Linked database views whose source database was imported later.
        for c in linkedCandidates {
            if linkedView(blockID: c.blockID, folder: c.folder, table: c.table, parent: c.parent, existing: true) == nil {
                var ctx = Ctx(dir: c.dir, file: c.dir.appendingPathComponent("linked.html"), pageID: c.blockID)
                importDatabase(table: c.table, title: c.title, summary: nil, blockID: c.blockID, parent: c.parent, inline: c.inline, ctx: &ctx, extra: BlockProps())
            }
        }
        // Relation targets: the database most related rows live in; unresolved relations become text.
        for db in builder.databases {
            for p in db.properties where p.type == .relation {
                var votes: [RecordID: Int] = [:]
                for b in builder.blocks where b.parent == .database(db.id) {
                    if case .relation(let ids)? = b.values[p.id] {
                        for id in ids { if let target = rowDatabase[id] { votes[target, default: 0] += 1 } }
                    }
                }
                if let target = votes.max(by: { $0.value < $1.value })?.key {
                    builder.updateDatabase(db.id) { d in
                        if let i = d.properties.firstIndex(where: { $0.id == p.id }) { d.properties[i].relation = RelationConfig(databaseID: target) }
                    }
                } else {
                    builder.updateDatabase(db.id) { d in
                        if let i = d.properties.firstIndex(where: { $0.id == p.id }) {
                            d.properties[i].type = .text
                            d.properties[i].description = "Relation in Notion (related pages weren't part of this export)."
                        }
                    }
                    for b in builder.blocks where b.parent == .database(db.id) {
                        let names = relationTitles[b.id]?[p.id] ?? []
                        builder.update(b.id) { $0.values[p.id] = names.isEmpty ? nil : .text(RichText(names.joined(separator: ", "))) }
                    }
                }
            }
        }
        // Links to pages that are neither in this export nor in the workspace stay as Notion links.
        if fallbackCount > 0 { builder.notes.append("\(fallbackCount) block(s) without a native equivalent were kept as HTML blocks.") }
    }
}

extension RichText {
    /// Trims leading/trailing whitespace of the plain-text ends.
    func trimmed() -> RichText {
        var runs = self.runs
        while let f = runs.first, !f.isAtomic {
            let t = String(f.text.drop { $0 == " " || $0 == "\n" || $0 == "\t" })
            if t.isEmpty { runs.removeFirst() } else { runs[0].text = t; break }
        }
        while let l = runs.last, !l.isAtomic {
            var t = l.text
            while let c = t.last, c == " " || c == "\n" || c == "\t" { t.removeLast() }
            if t.isEmpty { runs.removeLast() } else { runs[runs.count - 1].text = t; break }
        }
        return RichText(runs: runs)
    }
}
