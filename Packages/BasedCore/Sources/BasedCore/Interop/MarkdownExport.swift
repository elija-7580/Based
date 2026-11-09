import Foundation

@MainActor
public struct MarkdownExporter {
    public let store: WorkspaceStore
    /// How page mentions/links are written (default: relative "<Title>.md").
    public var pageLink: (RecordID) -> (title: String, url: String)?
    /// Where a block's file (image, video, attachment) is linked from the page (default "assets/<name>";
    /// WorkspaceExporter points it at the copied file, BSD-67).
    public var assetLink: (AssetRef) -> String = { "assets/" + $0.name }

    public init(store: WorkspaceStore, pageLink: ((RecordID) -> (title: String, url: String)?)? = nil) {
        self.store = store
        self.pageLink = pageLink ?? { id in
            let t = store.title(of: id)
            return (t, (MarkdownExporter.fileName(t) + ".md").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? t)
        }
    }

    nonisolated public static func fileName(_ title: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:?*\"<>|\n")
        let s = title.components(separatedBy: bad).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "Untitled" : String(s.prefix(120))
    }

    /// Full page: "# Title", properties (for rows), then content.
    public func export(page id: RecordID, includeTitle: Bool = true) -> String {
        guard let page = store.blocks[id] else { return "" }
        var lines: [String] = []
        if includeTitle { lines.append("# " + store.title(of: id)); lines.append("") }
        if let db = store.database(ofRow: id) {
            let q = QueryEngine(store: store)
            var props: [String] = []
            for p in db.properties where p.type != .title {
                let v = q.value(page, p, db)
                if v.isEmpty { continue }
                props.append("\(p.name): \(CellFormatter.text(v, store: store))")
            }
            if !props.isEmpty { lines += props; lines.append("") }
        }
        let body = exportBlocks(store.contentBlocks(of: id), indent: 0)
        lines.append(body)
        return lines.joined(separator: "\n").trimmingCharacters(in: .newlines) + "\n"
    }

    func inline(_ t: RichText) -> String { InlineMarkdownCodec.encode(t, pageLink: pageLink) }

    public func exportBlocks(_ blocks: [Block], indent: Int) -> String {
        var out: [String] = []
        let pad = String(repeating: "    ", count: indent)
        var number = 0
        for (idx, b) in blocks.enumerated() {
            number = b.type == .numberedList ? number + 1 : 0
            let kids = store.contentBlocks(of: b.id)
            func nested(_ extra: Int = 1) -> String? {
                kids.isEmpty || b.type.isPageLike ? nil : exportBlocks(kids, indent: indent + extra)
            }
            let text = inline(b.text).replacingOccurrences(of: "\n", with: "<br>")
            var line: String
            switch b.type {
            case .text: line = text
            case .heading1: line = "# " + text
            case .heading2: line = "## " + text
            case .heading3: line = "### " + text
            case .heading4: line = "#### " + text
            case .bulletedList: line = "- " + text
            case .numberedList: line = "\(number). " + text
            case .todo: line = (b.props.checked == true ? "- [x] " : "- [ ] ") + text
            case .toggle:
                let inner = nested(0).map { "\n\n" + $0 + "\n" } ?? ""
                line = "<details>\n<summary>\(text)</summary>\(inner)\n</details>"
                out.append(pad + line.replacingOccurrences(of: "\n", with: "\n" + pad))
                if idx < blocks.count - 1 { out.append("") }
                continue
            case .quote: line = "> " + text.replacingOccurrences(of: "<br>", with: "\n> ")
            case .callout:
                let icon = b.props.icon?.emoji.map { $0 + " " } ?? ""
                let inner = nested(0).map { "\n" + $0 } ?? ""
                line = "<aside>\n\(icon)\(text)\(inner)\n</aside>"
                out.append(pad + line.replacingOccurrences(of: "\n", with: "\n" + pad))
                continue
            case .divider: line = "---"
            case .code:
                let lang = (b.props.language ?? "").replacingOccurrences(of: "plain text", with: "")
                line = "```\(lang)\n\(b.text.plainText)\n```"
            case .equation: line = "$$\n\(b.props.expression ?? b.text.plainText)\n$$"
            case .image:
                line = "![\(b.props.caption?.plainText ?? "")](\(b.props.url ?? b.props.asset.map(assetLink) ?? ""))"
            case .video, .audio, .file, .pdf, .embed, .bookmark:
                let url = b.props.url ?? b.props.asset.map(assetLink) ?? ""
                let label = b.props.bookmark?.title ?? b.props.caption?.plainText ?? b.props.asset?.name ?? url
                line = "[\(label.isEmpty ? url : label)](\(url))"
            case .page, .databasePage, .linkToPage:
                let target = b.type == .linkToPage ? (b.props.linkTarget ?? b.id) : b.id
                if let l = pageLink(target) { line = "[\(l.title)](\(l.url))" } else { line = store.title(of: target) }
            case .databaseInline:
                let title = store.title(of: b.id)
                line = "[\(title)](\((MarkdownExporter.fileName(title) + ".csv").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? title))"
            case .table: line = table(b)
            case .tableOfContents, .breadcrumb, .button, .tableRow, .meetingSection, .transcript, .unknown: continue
            case .meeting:
                out.append(pad + meeting(b).replacingOccurrences(of: "\n", with: "\n" + pad))
                if idx < blocks.count - 1 { out.append("") }
                continue
            case .columnList, .column, .syncedBlock:
                if !kids.isEmpty { out.append(exportBlocks(kids, indent: indent)) }
                continue
            }
            out.append(pad + line.replacingOccurrences(of: "\n", with: "\n" + pad))
            if let n = nested() { out.append(n) }
            // blank line between paragraphs, but keep lists tight
            let next = idx + 1 < blocks.count ? blocks[idx + 1] : nil
            if !(b.type.isList && next?.type == b.type) && next != nil { out.append("") }
        }
        return out.joined(separator: "\n")
    }

    /// A meeting as a heading with Summary, Notes and Transcript.
    func meeting(_ b: Block) -> String {
        var parts = ["## " + inline(b.text)]
        let info = b.props.meeting
        if let start = info?.startedAt {
            let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime]
            parts.append("*" + f.string(from: start) + (info?.duration.map { " · " + Transcript.timecode($0) } ?? "") + "*")
        }
        for kind in [MeetingSectionKind.summary, .notes] {
            guard let sec = store.contentBlocks(of: b.id).first(where: { $0.props.meetingSection == kind }) else { continue }
            let kids = store.contentBlocks(of: sec.id)
            guard !kids.isEmpty else { continue }
            parts.append("### " + (kind == .summary ? "Summary" : "Notes"))
            parts.append(exportBlocks(kids, indent: 0))
        }
        let segs = store.transcriptChunks(of: b.id).flatMap { $0.props.segments ?? [] }
        if !segs.isEmpty {
            parts.append("### Transcript")
            parts.append(Transcript.paragraphs(segs.filter { !$0.isPartial }).map { p in
                "**\(info?.speakerName(p.speaker) ?? "Unknown")** [\(Transcript.timecode(p.start))]: \(p.text)"
            }.joined(separator: "\n\n"))
        }
        return parts.joined(separator: "\n\n")
    }

    func table(_ b: Block) -> String {
        let rows = store.contentBlocks(of: b.id).filter { $0.type == .tableRow }
        let cols = max(1, b.props.tableColumns ?? rows.map { $0.props.cells?.count ?? 0 }.max() ?? 1)
        func cell(_ r: Block, _ i: Int) -> String {
            let c = r.props.cells ?? []
            return i < c.count ? inline(c[i]).replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: "<br>") : ""
        }
        var lines: [String] = []
        for (ri, r) in rows.enumerated() {
            lines.append("| " + (0..<cols).map { cell(r, $0) }.joined(separator: " | ") + " |")
            if ri == 0 { lines.append("|" + String(repeating: " --- |", count: cols)) }
        }
        if rows.isEmpty { lines = ["| " + String(repeating: " |", count: cols), "|" + String(repeating: " --- |", count: cols)] }
        return lines.joined(separator: "\n")
    }

    /// CSV for a database (title column first, like Notion's export).
    public func csv(database id: RecordID, viewID: RecordID? = nil) -> String {
        guard let db = store.databases[id] else { return "" }
        let q = QueryEngine(store: store)
        let rows: [Block]
        var props = db.properties
        if let viewID, let v = store.views[viewID] {
            rows = q.run(v).rows
            let visible = v.visiblePropertyIDs(in: db)
            props = visible.compactMap { db.property($0) ?? (db.titleProperty.id == $0 ? db.titleProperty : nil) }
        } else {
            rows = store.rows(of: id).filter { $0.props.isTemplate != true }
        }
        if let ti = props.firstIndex(where: { $0.type == .title }) { props.insert(props.remove(at: ti), at: 0) }
        else { props.insert(db.titleProperty, at: 0) }
        var table: [[String]] = [props.map(\.name)]
        for r in rows {
            table.append(props.map { p in
                let v = q.value(r, p, db)
                if case .bool(let b) = v { return b ? "Yes" : "No" }
                if case .date(let d) = v { return DateDisplay.long(d) }
                if case .number(let n) = v, p.type == .uniqueID { return (p.idPrefix.map { "\($0)-" } ?? "") + NumberFormatting.plain(n) }
                return CellFormatter.text(v, store: store)
            })
        }
        return CSV.encode(table)
    }
}