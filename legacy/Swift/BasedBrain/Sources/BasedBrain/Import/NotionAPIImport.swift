import Foundation
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Live import from the Notion API (integration token): pages, page trees and databases,
/// plus a one-shot "brain" import (Memories + Skills databases → Based Agent Brain).
public final class NotionAPIImporter: @unchecked Sendable {
    public let token: String
    public let baseURL = URL(string: "https://api.notion.com/v1")!
    public var onProgress: (@Sendable (String) -> Void)?
    public init(token: String) { self.token = token }

    var headers: [String: String] { ["Authorization": "Bearer \(token)", "Notion-Version": "2022-06-28"] }

    // MARK: API

    public func page(_ id: String) async throws -> JSONValue { try await get("pages/\(id)") }
    public func database(_ id: String) async throws -> JSONValue { try await get("databases/\(id)") }

    public func blocks(of id: String) async throws -> [JSONValue] {
        var out: [JSONValue] = [], cursor: String?
        repeat {
            let q = cursor.map { "?start_cursor=\($0)&page_size=100" } ?? "?page_size=100"
            let r = try await get("blocks/\(id)/children\(q)")
            out += r["results"]?.array ?? []
            cursor = r["has_more"]?.bool == true ? r["next_cursor"]?.string : nil
        } while cursor != nil
        return out
    }

    public func rows(of databaseID: String) async throws -> [JSONValue] {
        var out: [JSONValue] = [], cursor: String?
        repeat {
            var body: [String: JSONValue] = ["page_size": 100]
            if let cursor { body["start_cursor"] = .string(cursor) }
            let (code, data) = try await HTTP.post(baseURL.appendingPathComponent("databases/\(databaseID)/query"), headers: headers, body: .object(body))
            guard code == 200 else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
            let r = try JSONValue.parse(data)
            out += r["results"]?.array ?? []
            cursor = r["has_more"]?.bool == true ? r["next_cursor"]?.string : nil
        } while cursor != nil
        return out
    }

    private func get(_ path: String) async throws -> JSONValue {
        let (code, data) = try await HTTP.get(URL(string: baseURL.absoluteString + "/" + path)!, headers: headers)
        guard code == 200 else { throw AIError.http(code, String(decoding: data, as: UTF8.self)) }
        return try JSONValue.parse(data)
    }

    // MARK: Mapping (pure, testable)

    /// Notion rich_text array → RichText (bold/italic/… marks, links).
    public static func richText(_ arr: JSONValue?) -> RichText {
        var runs: [TextRun] = []
        for t in arr?.array ?? [] {
            let plain = t["plain_text"]?.string ?? t["text"]?["content"]?.string ?? ""
            let a = t["annotations"]
            var marks = Marks.plain
            marks.bold = a?["bold"]?.bool == true
            marks.italic = a?["italic"]?.bool == true
            marks.strikethrough = a?["strikethrough"]?.bool == true
            marks.underline = a?["underline"]?.bool == true
            marks.code = a?["code"]?.bool == true
            marks.link = t["href"]?.string
            if let c = a?["color"]?.string, c != "default", let col = TColor(rawValue: c.replacingOccurrences(of: "_background", with: "Background")) { marks.color = col }
            runs.append(TextRun(plain, marks: marks))
        }
        return RichText(runs: runs)
    }

    public static func blockType(_ notion: String) -> (BlockType, [String: JSONValue])? {
        switch notion {
        case "paragraph": return (.text, [:])
        case "heading_1": return (.heading1, [:])
        case "heading_2": return (.heading2, [:])
        case "heading_3": return (.heading3, [:])
        case "bulleted_list_item": return (.bulletedList, [:])
        case "numbered_list_item": return (.numberedList, [:])
        case "to_do": return (.todo, [:])
        case "toggle": return (.toggle, [:])
        case "quote": return (.quote, [:])
        case "callout": return (.callout, [:])
        case "divider": return (.divider, [:])
        case "code": return (.code, [:])
        case "equation": return (.equation, [:])
        case "image": return (.image, [:])
        case "video": return (.video, [:])
        case "audio": return (.audio, [:])
        case "file": return (.file, [:])
        case "pdf": return (.pdf, [:])
        case "bookmark", "link_preview": return (.bookmark, [:])
        case "embed": return (.embed, [:])
        case "table_of_contents": return (.tableOfContents, [:])
        case "breadcrumb": return (.breadcrumb, [:])
        case "column_list": return (.columnList, [:])
        case "column": return (.column, [:])
        case "table": return (.table, [:])
        case "table_row": return (.tableRow, [:])
        case "child_page": return (.page, [:])
        case "synced_block": return (.syncedBlock, [:])
        default: return nil
        }
    }

    /// Convert one Notion block (with already-fetched children) into an ImportedBlock tree.
    public static func imported(_ b: JSONValue, children: [ImportedBlock]) -> ImportedBlock? {
        guard let t = b["type"]?.string else { return nil }
        let body = b[t] ?? .object([:])
        guard let (type, _) = blockType(t) else {
            // Unsupported (e.g. child_database, template, link_to_page): keep a placeholder line.
            return ImportedBlock(.text, text: RichText("[\(t)]"), children: children)
        }
        var props = BlockProps()
        var text = richText(body["rich_text"])
        if let c = body["color"]?.string, c != "default", let col = TColor(rawValue: c.replacingOccurrences(of: "_background", with: "Background")) { props.color = col }
        switch type {
        case .todo: props.checked = body["checked"]?.bool ?? false
        case .code: props.language = body["language"]?.string
        case .equation: text = RichText(body["expression"]?.string ?? "")
        case .callout:
            if let e = body["icon"]?["emoji"]?.string { props.icon = .emoji(e) }
        case .image, .video, .audio, .file, .pdf, .bookmark, .embed:
            props.url = body["url"]?.string ?? body["external"]?["url"]?.string ?? body["file"]?["url"]?.string
            props.caption = richText(body["caption"])
        case .page: text = RichText(body["title"]?.string ?? "Untitled")
        case .heading1, .heading2, .heading3: if body["is_toggleable"]?.bool == true { props.toggleable = true }
        case .toggle: props.isOpen = false
        default: break
        }
        if let cells = body["cells"]?.array, type == .tableRow {
            // Simple table rows: cells as children paragraphs.
            return ImportedBlock(.tableRow, children: cells.map { ImportedBlock(.text, text: richText($0)) })
        }
        return ImportedBlock(type, text: text, props: props, children: children)
    }

    /// Fetch and convert the whole block tree of a page.
    public func importedBlocks(of pageID: String, depth: Int = 0) async throws -> [ImportedBlock] {
        var out: [ImportedBlock] = []
        for b in try await blocks(of: pageID) {
            var kids: [ImportedBlock] = []
            if b["has_children"]?.bool == true, b["type"]?.string != "child_page", depth < 12, let id = b["id"]?.string {
                kids = try await importedBlocks(of: id, depth: depth + 1)
            }
            if let ib = Self.imported(b, children: kids) { out.append(ib) }
        }
        return out
    }

    public static func title(of page: JSONValue) -> String {
        for (_, v) in page["properties"]?.object ?? [:] where v["type"]?.string == "title" { return richText(v["title"]).plainText }
        return richText(page["title"]).plainText
    }

    public static func propertyText(_ p: JSONValue) -> String {
        switch p["type"]?.string {
        case "rich_text": return richText(p["rich_text"]).plainText
        case "select": return p["select"]?["name"]?.string ?? ""
        case "status": return p["status"]?["name"]?.string ?? ""
        case "multi_select": return (p["multi_select"]?.array ?? []).compactMap { $0["name"]?.string }.joined(separator: ", ")
        case "checkbox": return p["checkbox"]?.bool == true ? "true" : "false"
        case "number": return p["number"]?.number.map { String($0) } ?? ""
        case "url": return p["url"]?.string ?? ""
        case "email": return p["email"]?.string ?? ""
        case "phone_number": return p["phone_number"]?.string ?? ""
        case "date": return p["date"]?["start"]?.string ?? ""
        default: return ""
        }
    }

    // MARK: Workspace import

    /// Import a Notion page (and its child pages) under `parent`.
    @discardableResult
    public func importPage(_ notionID: String, into store: WorkspaceStore, parent: ParentRef, brain: BrainStore) async throws -> RecordID {
        let pg = try await page(notionID)
        let title = Self.title(of: pg)
        onProgress?("Importing page \(title)")
        let icon = pg["icon"]?["emoji"]?.string
        let blocks = try await importedBlocks(of: notionID)
        let id = await MainActor.run { () -> RecordID in
            let id = store.createPage(title: RichText(title), in: parent, icon: icon.map { .emoji($0) }, name: "Import from Notion")
            store.insertImported(blocks.filter { $0.type != .page }, in: .block(id), name: "Import from Notion")
            return id
        }
        for b in try await self.blocks(of: notionID) where b["type"]?.string == "child_page" {
            if let cid = b["id"]?.string { try await importPage(cid, into: store, parent: .block(id), brain: brain) }
        }
        return id
    }

    /// Import a Notion database as a Based database (title, text/select/multi/checkbox/number/url/date properties + page bodies).
    @discardableResult
    public func importDatabase(_ notionID: String, into store: WorkspaceStore, parent: ParentRef) async throws -> RecordID {
        let db = try await database(notionID)
        let title = Self.richText(db["title"]).plainText
        onProgress?("Importing database \(title)")
        let rows = try await self.rows(of: notionID)
        var bodiesMut: [String: [ImportedBlock]] = [:]
        for r in rows { if let id = r["id"]?.string { bodiesMut[id] = try await importedBlocks(of: id) } }
        let bodies = bodiesMut
        return await MainActor.run {
            let created = store.createDatabase(title: RichText(title), in: parent, inline: false, sampleRows: 0)
            var map: [String: (String, PropertyType)] = [:]
            for (name, p) in db["properties"]?.object ?? [:] {
                let t: PropertyType?
                switch p["type"]?.string {
                case "title": t = nil
                case "rich_text": t = .text; case "select": t = .select; case "status": t = .status; case "multi_select": t = .multiSelect
                case "checkbox": t = .checkbox; case "number": t = .number; case "url": t = .url; case "email": t = .email
                case "phone_number": t = .phone; case "date": t = .date
                default: t = .text
                }
                if let t, let pid = store.addProperty(to: created.databaseID, name: name, type: t) { map[name] = (pid, t) }
            }
            for r in rows {
                let rid = store.addRow(to: created.databaseID, title: RichText(Self.title(of: r)))
                for (name, p) in r["properties"]?.object ?? [:] {
                    guard let (pid, t) = map[name] else { continue }
                    let s = Self.propertyText(p)
                    guard !s.isEmpty else { continue }
                    switch t {
                    case .select: store.setValue(rid, pid, store.addOption(created.databaseID, pid, name: s).map { .select($0) })
                    case .status: store.setValue(rid, pid, store.addOption(created.databaseID, pid, name: s).map { .status($0) })
                    case .multiSelect: store.setValue(rid, pid, .multiSelect(s.split(separator: ",").compactMap { store.addOption(created.databaseID, pid, name: $0.trimmingCharacters(in: .whitespaces)) }))
                    case .checkbox: store.setValue(rid, pid, .checkbox(s == "true"))
                    case .number: store.setValue(rid, pid, Double(s).map { .number($0) })
                    case .url: store.setValue(rid, pid, .url(s))
                    case .email: store.setValue(rid, pid, .email(s))
                    case .phone: store.setValue(rid, pid, .phone(s))
                    case .date: store.setValue(rid, pid, DateParsing.parse(s).map { .date($0) })
                    default: store.setValue(rid, pid, .text(RichText(s)))
                    }
                }
                if let id = r["id"]?.string, let body = bodies[id] { store.insertImported(body, in: .block(rid), name: "Import") }
            }
            return created.blockID
        }
    }

    /// Bring the Notion AI brain over 1:1: Memories (Title + Type) and Skills databases, About page.
    public func importBrain(memoriesDatabaseID: String?, skillsDatabaseID: String?, aboutPageID: String?, into brain: BrainStore) async throws -> (memories: Int, skills: Int) {
        var m = 0, s = 0
        if let memoriesDatabaseID {
            for r in try await rows(of: memoriesDatabaseID) {
                guard let id = r["id"]?.string else { continue }
                let title = Self.title(of: r)
                let type = (r["properties"]?.object ?? [:]).values.first { $0["type"]?.string == "select" }.map(Self.propertyText) ?? "Notes"
                let body = ImportedMarkdown.markdown(of: try await importedBlocks(of: id))
                onProgress?("Memory: \(title)")
                await MainActor.run { brain.saveMemory(title: title, kind: Memory.Kind(rawValue: type) ?? .Notes, body: body) }
                m += 1
            }
        }
        if let skillsDatabaseID {
            for r in try await rows(of: skillsDatabaseID) {
                guard let id = r["id"]?.string else { continue }
                let title = Self.title(of: r)
                let desc = (r["properties"]?.object ?? [:]).values.first { $0["type"]?.string == "rich_text" }.map(Self.propertyText) ?? ""
                let body = ImportedMarkdown.markdown(of: try await importedBlocks(of: id))
                onProgress?("Skill: \(title)")
                await MainActor.run { brain.saveSkill(name: title, description: desc, body: body) }
                s += 1
            }
        }
        if let aboutPageID {
            let body = ImportedMarkdown.markdown(of: try await importedBlocks(of: aboutPageID))
            await MainActor.run { brain.setAbout(body) }
        }
        return (m, s)
    }
}

/// Render imported block trees to Markdown without inserting them into a store.
public enum ImportedMarkdown {
    public static func markdown(of items: [ImportedBlock], indent: Int = 0) -> String {
        var out = ""
        let pad = String(repeating: "    ", count: indent)
        for (i, b) in items.enumerated() {
            let t = InlineMarkdownCodec.encode(b.text)
            switch b.type {
            case .heading1: out += "\(pad)# \(t)\n"
            case .heading2: out += "\(pad)## \(t)\n"
            case .heading3: out += "\(pad)### \(t)\n"
            case .bulletedList, .toggle: out += "\(pad)- \(t)\n"
            case .numberedList: out += "\(pad)\(i + 1). \(t)\n"
            case .todo: out += "\(pad)- [\(b.props.checked == true ? "x" : " ")] \(t)\n"
            case .quote: out += "\(pad)> \(t)\n"
            case .callout: out += "\(pad)> \(b.props.icon.flatMap { if case .emoji(let e) = $0 { return e } else { return nil } } ?? "💡") \(t)\n"
            case .code: out += "\(pad)```\(b.props.language ?? "")\n\(b.text.plainText)\n\(pad)```\n"
            case .divider: out += "\(pad)---\n"
            case .equation: out += "\(pad)$$\n\(b.text.plainText)\n$$\n"
            case .image: out += "\(pad)![\(b.props.caption?.plainText ?? "")](\(b.props.url ?? ""))\n"
            case .bookmark, .embed, .file, .pdf, .video, .audio: out += "\(pad)[\(b.props.caption?.plainText.nonEmpty ?? b.props.url ?? "")](\(b.props.url ?? ""))\n"
            default: out += "\(pad)\(t)\n"
            }
            if !b.children.isEmpty { out += markdown(of: b.children, indent: b.type == .column || b.type == .columnList ? indent : indent + 1) }
            if indent == 0, ![.bulletedList, .numberedList, .todo, .toggle].contains(b.type) { out += "\n" }
        }
        return out
    }
}
