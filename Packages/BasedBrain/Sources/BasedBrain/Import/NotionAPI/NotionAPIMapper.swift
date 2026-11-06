import Foundation
import BasedCore

/// Turns a `NotionSnapshot` (raw API objects) into Based blocks, databases and views.
/// Ids are Notion's own ids, so importing the same page again updates it in place.
public final class NotionAPIMapper {
    let snap: NotionSnapshot
    let builder: ImportBuilder

    // Precomputed
    private var reachable: Set<String> = []          // pages / databases placed inside another imported page or as rows
    private var rowIDs: Set<String> = []
    private var blockIDs: Set<String> = []
    private var importedIDs: Set<String> = []        // everything that becomes a record (for internal links)

    // Mapping state
    private var mappedPages: Set<String> = []
    private var mappedContainers: Set<String> = []
    private var schemas: [String: [PropertySchema]] = [:]          // data source → schema
    private var propIndex: [String: [String: PropertySchema]] = [:] // data source → notion prop id / name → schema
    private var notionTypes: [String: [String: String]] = [:]       // data source → our prop id → notion type
    private var owner: [String: String] = [:]                       // data source → container block id
    private var liveFormula: Set<String> = []                       // "ds|prop" kept as live formulas
    private var unsupported: [String: Int] = [:]
    private var approximations = 0

    private let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private let day: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone.current; f.dateFormat = "yyyy-MM-dd"; return f
    }()

    init(_ snap: NotionSnapshot, into builder: ImportBuilder) {
        self.snap = snap
        self.builder = builder
    }

    /// Maps everything in the snapshot into `builder`.
    public static func map(_ snap: NotionSnapshot, into builder: ImportBuilder) {
        let m = NotionAPIMapper(snap, into: builder)
        m.run()
    }

    // MARK: Driver

    func run() {
        precompute()
        for ds in snap.dataSources.keys.sorted() { buildSchema(ds) }
        for root in snap.roots {
            switch root {
            case .page(let id):
                guard !reachable.contains(id) else { continue }
                mapPage(id, parent: .workspace, root: true, fallbackTitle: nil)
            case .database(let id):
                guard !reachable.contains(id) else { continue }
                mapContainer(id, parent: .workspace, root: true, inline: false, fallbackTitle: nil)
            }
        }
        // Databases that only appear through relations or linked views get their own top-level page.
        for ds in snap.dataSources.keys.sorted() where owner[ds] == nil {
            if let db = NotionSnapshot.id(snap.dataSources[ds]?["parent"]?["database_id"]), snap.databases[db] != nil, !mappedContainers.contains(db) {
                mapContainer(db, parent: .workspace, root: true, inline: false, fallbackTitle: nil)
            }
            if owner[ds] == nil { mapOrphanSource(ds) }
        }
        finish()
    }

    private func precompute() {
        for (_, kids) in snap.children {
            for k in kids {
                guard let id = NotionSnapshot.id(k["id"]) else { continue }
                blockIDs.insert(id)
                let t = k["type"]?.string
                if t == "child_page" || t == "child_database" { reachable.insert(id) }
            }
        }
        for (_, rows) in snap.rows { for r in rows { rowIDs.insert(r); reachable.insert(r) } }
        importedIDs = Set(snap.pages.keys).union(snap.databases.keys).union(blockIDs)
        // Duplicate root entries that are rows of an imported data source are reachable too.
    }

    // MARK: Pages

    private func mapPage(_ id: String, parent: ParentRef, root: Bool, fallbackTitle: String?) {
        guard mappedPages.insert(id).inserted else { return }
        guard let p = snap.pages[id] else {
            var b = Block(id: id, type: .page, parent: parent, sortKey: "", text: RichText(fallbackTitle ?? "Untitled"), createdBy: builder.createdBy)
            b.updatedAt = b.createdAt
            builder.add(b, root: root)
            return
        }
        var props = BlockProps()
        props.icon = icon(p["icon"])
        props.cover = cover(p["cover"])
        if p["is_locked"]?.bool == true { var f = props.format ?? PageFormat(); f.locked = true; props.format = f }
        var text = titleText(of: p)
        if text.isEmpty, let fallbackTitle { text = RichText(fallbackTitle) }
        let b = block(.page, p, parent: parent, text: text, props: props)
        builder.add(b, root: root)
        mapChildren(of: id, into: .block(id))
    }

    private func mapChildren(of owner: String, into parent: ParentRef) {
        guard let kids = snap.children[owner] else { return }
        for k in kids { mapBlock(k, into: parent) }
        builder.markComplete(parent)
    }

    // MARK: Blocks

    private func mapBlock(_ j: JSONValue, into parent: ParentRef) {
        guard let type = j["type"]?.string, let id = NotionSnapshot.id(j["id"]) else { return }
        if j["in_trash"]?.bool == true || j["archived"]?.bool == true { return }
        let body = j[type]
        var props = BlockProps()
        var text = RichText()
        var bt: BlockType
        var childrenAllowed = true
        if let c = Self.color(body?["color"]?.string) { props.color = c }

        switch type {
        case "paragraph": bt = .text; text = richText(body?["rich_text"])
        case "heading_1", "heading_2", "heading_3", "heading_4":
            bt = [.heading1, .heading2, .heading3, .heading4][Int(String(type.last!))! - 1]
            text = richText(body?["rich_text"])
            if body?["is_toggleable"]?.bool == true { props.toggleable = true }
        case "bulleted_list_item": bt = .bulletedList; text = richText(body?["rich_text"])
        case "numbered_list_item": bt = .numberedList; text = richText(body?["rich_text"])
        case "to_do": bt = .todo; text = richText(body?["rich_text"]); props.checked = body?["checked"]?.bool ?? false
        case "toggle": bt = .toggle; text = richText(body?["rich_text"])
        case "quote": bt = .quote; text = richText(body?["rich_text"])
        case "callout":
            bt = .callout; text = richText(body?["rich_text"])
            props.icon = icon(body?["icon"])
        case "code":
            bt = .code
            text = RichText(richText(body?["rich_text"]).plainText)
            props.language = body?["language"]?.string.map(Self.codeLanguage)
            let cap = richText(body?["caption"]); if !cap.isEmpty { props.caption = cap }
            childrenAllowed = false
        case "equation":
            bt = .equation; props.expression = body?["expression"]?.string ?? ""; childrenAllowed = false
        case "divider": bt = .divider; childrenAllowed = false
        case "breadcrumb": bt = .breadcrumb; childrenAllowed = false
        case "table_of_contents": bt = .tableOfContents; childrenAllowed = false
        case "image", "video", "audio", "file", "pdf":
            bt = BlockType(rawValue: type)!
            let m = media(body)
            props.asset = m.asset; props.url = m.url
            let cap = richText(body?["caption"]); if !cap.isEmpty { props.caption = cap }
            childrenAllowed = false
        case "bookmark", "link_preview":
            bt = .bookmark; props.url = body?["url"]?.string
            let cap = richText(body?["caption"]); if !cap.isEmpty { props.caption = cap }
            childrenAllowed = false
        case "embed":
            bt = .embed; props.url = body?["url"]?.string
            let cap = richText(body?["caption"]); if !cap.isEmpty { props.caption = cap }
            childrenAllowed = false
        case "child_page":
            mapPage(id, parent: parent, root: false, fallbackTitle: body?["title"]?.string)
            return
        case "child_database":
            let inline = snap.databases[id]?["is_inline"]?.bool ?? true
            mapContainer(id, parent: parent, root: false, inline: inline, fallbackTitle: body?["title"]?.string)
            return
        case "link_to_page":
            bt = .linkToPage
            let kind = body?["type"]?.string ?? "page_id"
            props.linkTarget = NotionSnapshot.id(body?[kind]) ?? NotionSnapshot.id(body?["page_id"]) ?? NotionSnapshot.id(body?["database_id"])
            childrenAllowed = false
        case "column_list": bt = .columnList
        case "column":
            bt = .column
            if let r = body?["width_ratio"]?.number { props.ratio = r }
        case "table":
            bt = .table
            props.tableColumns = body?["table_width"]?.int ?? 2
            props.tableHeaderRow = body?["has_column_header"]?.bool ?? false
            props.tableHeaderColumn = body?["has_row_header"]?.bool ?? false
        case "table_row":
            bt = .tableRow
            props.cells = (body?["cells"]?.array ?? []).map { richText($0) }
            childrenAllowed = false
        case "synced_block":
            bt = .syncedBlock
            if let src = NotionSnapshot.id(body?["synced_from"]?["block_id"]), blockIDs.contains(src) {
                props.syncSource = src
                childrenAllowed = false
            }
        case "template":
            bt = .toggle; text = richText(body?["rich_text"])
            if text.isEmpty { text = RichText("Template") }
        case "transcription", "meeting_notes":
            bt = .toggle
            text = richText(body?["title"])
            if text.isEmpty { text = RichText("Meeting notes") }
        default:
            unsupported[type, default: 0] += 1
            bt = .callout
            props.icon = .emoji("⚠️"); props.color = .grayBackground
            text = RichText("This Notion block (\(type.replacingOccurrences(of: "_", with: " "))) isn't available through the Notion API.")
            childrenAllowed = j["has_children"]?.bool == true
        }
        let b = block(bt, j, parent: parent, text: text, props: props)
        builder.add(b)
        if childrenAllowed { mapChildren(of: id, into: .block(id)) }
        else if bt == .syncedBlock || bt == .code || bt.isMedia { builder.markComplete(.block(id)) }
    }

    /// Our code language names follow Notion's, lowercased.
    static func codeLanguage(_ s: String) -> String { s.lowercased() }

    private func block(_ type: BlockType, _ j: JSONValue, parent: ParentRef, text: RichText = RichText(), props: BlockProps = BlockProps(), values: [String: PropertyValue] = [:]) -> Block {
        let id = NotionSnapshot.id(j["id"]) ?? RecordIDs.make()
        let created = time(j["created_time"]) ?? Date()
        var b = Block(id: id, type: type, parent: parent, sortKey: "", text: text, props: props, values: values,
                      createdAt: created, createdBy: user(j["created_by"]) ?? builder.createdBy)
        b.updatedAt = time(j["last_edited_time"]) ?? created
        b.updatedBy = user(j["last_edited_by"]) ?? b.createdBy
        return b
    }

    // MARK: Databases

    /// A database block: owns its data sources (unless it is a linked view of a database elsewhere) and shows its views.
    private func mapContainer(_ dbID: String, parent: ParentRef, root: Bool, inline: Bool, fallbackTitle: String?) {
        guard mappedContainers.insert(dbID).inserted else { return }
        guard let db = snap.databases[dbID] else {
            // Not shared / not readable: keep a placeholder so the page layout stays intact.
            var p = BlockProps(); p.icon = .emoji("🗃️")
            var b = Block(id: dbID, type: .page, parent: parent, sortKey: "", text: RichText(fallbackTitle ?? "Database"), props: p, createdBy: builder.createdBy)
            b.updatedAt = b.createdAt
            builder.add(b, root: root)
            builder.warnings.append("Database “\(fallbackTitle ?? dbID)” couldn't be read — share it with the integration (••• → Connections) and import again.")
            return
        }
        let title = richText(db["title"])
        var sources = (db["data_sources"]?.array ?? []).compactMap { NotionSnapshot.id($0["id"]) }.filter { snap.dataSources[$0] != nil }
        if sources.isEmpty, let any = snap.views[dbID]?.compactMap({ NotionSnapshot.id($0["data_source_id"]) }).first(where: { snap.dataSources[$0] != nil }) { sources = [any] }
        let isInline = inline && !root
        var containers: [(id: String, ds: String?)] = []
        if sources.isEmpty { containers = [(dbID, nil)] }
        for (i, ds) in sources.enumerated() { containers.append((i == 0 ? dbID : ImportIDs.derived(dbID, "source", ds), ds)) }

        for (i, c) in containers.enumerated() {
            var p = BlockProps()
            if i == 0 {
                p.icon = icon(db["icon"])
                p.cover = cover(db["cover"])
                if db["is_locked"]?.bool == true { var f = PageFormat(); f.locked = true; p.format = f }
            }
            var text = RichText()
            if let ds = c.ds {
                p.databaseID = ds
                if owner[ds] == nil {
                    let own = NotionSnapshot.id(snap.dataSources[ds]?["parent"]?["database_id"])
                    if own == dbID || own == nil || snap.databases[own!] == nil || i > 0 { owner[ds] = c.id }
                }
                p.viewIDs = mapViews(container: c.id, dbID: dbID, ds: ds, primary: i == 0)
            }
            if !isInline || i > 0 {
                text = i == 0 ? title : (c.ds.map { richText(snap.dataSources[$0]?["title"]) } ?? title)
                if text.isEmpty { text = RichText(fallbackTitle ?? "Untitled") }
            }
            let type: BlockType = isInline ? .databaseInline : .databasePage
            var b = block(type, db, parent: parent, text: text, props: p)
            b.id = c.id
            builder.add(b, root: root)
            if c.ds == nil {
                builder.warnings.append("The data source of “\(title.plainText)” couldn't be read.")
            }
        }
    }

    /// A data source whose database wasn't found: gets a page of its own.
    private func mapOrphanSource(_ ds: String) {
        guard let src = snap.dataSources[ds] else { return }
        let id = NotionSnapshot.id(src["parent"]?["database_id"]) ?? ImportIDs.derived(ds, "container")
        guard !mappedContainers.contains(id) else { owner[ds] = owner[ds] ?? id; return }
        mappedContainers.insert(id)
        owner[ds] = id
        var p = BlockProps()
        p.databaseID = ds
        p.icon = icon(src["icon"])
        p.viewIDs = mapViews(container: id, dbID: id, ds: ds, primary: true)
        var text = richText(src["title"]); if text.isEmpty { text = "Untitled" }
        var b = block(.databasePage, src, parent: .workspace, text: text, props: p)
        b.id = id
        builder.add(b, root: true)
    }

    private func finish() {
        // Database records and rows
        for ds in snap.dataSources.keys.sorted() {
            guard let src = snap.dataSources[ds], let container = owner[ds] else { continue }
            let dbObj = NotionSnapshot.id(src["parent"]?["database_id"]).flatMap { snap.databases[$0] }
            let primary = (dbObj?["data_sources"]?.array?.first).flatMap { NotionSnapshot.id($0["id"]) } == ds
            var title = primary ? richText(dbObj?["title"]) : richText(src["title"])
            if title.isEmpty { title = richText(src["title"]) }
            var db = Database(id: ds, blockID: container, title: title, properties: schemas[ds] ?? [])
            let summary = richText(dbObj?["description"] ?? src["description"])
            if !summary.isEmpty { db.summary = summary }
            if dbObj?["is_locked"]?.bool == true { db.locked = true }
            if let t = time(src["created_time"]) { db.createdAt = t }
            if let t = time(src["last_edited_time"]) { db.updatedAt = t }
            var maxUnique = 0
            for rid in snap.rows[ds] ?? [] {
                guard let page = snap.pages[rid], !mappedPages.contains(rid) else { continue }
                mappedPages.insert(rid)
                var values: [String: PropertyValue] = [:]
                for (name, v) in page["properties"]?.object ?? [:] {
                    guard let s = prop(ds, v["id"]?.string, name: name), s.type != .title else { continue }
                    if let pv = value(v, s, ds: ds, page: rid) {
                        values[s.id] = pv
                        if case .uniqueID(let n) = pv { maxUnique = max(maxUnique, n) }
                    }
                }
                var props = BlockProps()
                props.icon = icon(page["icon"])
                props.cover = cover(page["cover"])
                if page["is_locked"]?.bool == true { var f = PageFormat(); f.locked = true; props.format = f }
                let b = block(.page, page, parent: .database(ds), text: titleText(of: page), props: props, values: values)
                builder.add(b)
                mapChildren(of: rid, into: .block(rid))
            }
            if maxUnique > 0 { db.nextUniqueID = maxUnique + 1 }
            builder.addDatabase(db)
            if snap.rows[ds] != nil { builder.markComplete(.database(ds)) }
        }
        let skipped = unsupported.values.reduce(0, +)
        if skipped > 0 {
            let kinds = unsupported.keys.sorted().joined(separator: ", ")
            builder.warnings.append("\(skipped) block(s) aren't available through the Notion API (\(kinds)) and were replaced by a note.")
        }
        if approximations > 0 { builder.notes.append("\(approximations) view filter(s) were approximated.") }
        builder.warnings += snap.warnings
    }

    // MARK: Schema

    private func buildSchema(_ ds: String) {
        guard let src = snap.dataSources[ds] else { return }
        let props = src["properties"]?.object ?? [:]
        // Column order: the first view's property order, then the rest by name.
        let viewOrder: [String] = {
            for (_, vs) in snap.views.sorted(by: { $0.key < $1.key }) {
                for v in vs where NotionSnapshot.id(v["data_source_id"]) == ds {
                    let ids = (v["configuration"]?["properties"]?.array ?? []).compactMap { $0["property_id"]?.string }
                    if !ids.isEmpty { return ids }
                }
            }
            return []
        }()
        func rank(_ name: String, _ p: JSONValue) -> (Int, String) {
            if p["type"]?.string == "title" { return (-1, name) }
            let pid = p["id"]?.string ?? ""
            if let i = viewOrder.firstIndex(where: { Self.sameID($0, pid) || $0 == name }) { return (i, name) }
            return (Int.max, name.lowercased())
        }
        let ordered = props.sorted { rank($0.key, $0.value) < rank($1.key, $1.value) }
        var schema: [PropertySchema] = []
        var index: [String: PropertySchema] = [:]
        var types: [String: String] = [:]
        // First pass without formulas/rollups (they reference others by name / id).
        for (name, p) in ordered {
            let ntype = p["type"]?.string ?? "rich_text"
            let nid = p["id"]?.string ?? name
            var s = PropertySchema(id: ntype == "title" ? Database.titlePropertyID : Self.propertyID(ds, nid), name: name, type: .text)
            let cfg = p[ntype]
            if let d = p["description"]?.string, !d.isEmpty { s.description = d }
            switch ntype {
            case "title": s.type = .title
            case "rich_text": s.type = .text
            case "number": s.type = .number; s.numberFormat = Self.numberFormat(cfg?["format"]?.string)
            case "select", "multi_select", "status":
                s.type = ntype == "select" ? .select : ntype == "status" ? .status : .multiSelect
                s.options = (cfg?["options"]?.array ?? []).map { o in
                    SelectOption(id: o["id"]?.string ?? ImportIDs.derived(ds, nid, o["name"]?.string ?? ""), name: o["name"]?.string ?? "",
                                 color: TColor(rawValue: o["color"]?.string ?? "default") ?? .default)
                }
                if ntype == "status" {
                    s.statusGroups = (cfg?["groups"]?.array ?? []).map { g in
                        StatusGroup(id: g["id"]?.string ?? RecordIDs.make(), name: g["name"]?.string ?? "",
                                    color: TColor(rawValue: g["color"]?.string ?? "gray") ?? .gray,
                                    optionIDs: (g["option_ids"]?.array ?? []).compactMap(\.string))
                    }
                }
            case "date": s.type = .date
            case "people": s.type = .person
            case "files": s.type = .files
            case "checkbox": s.type = .checkbox
            case "url": s.type = .url
            case "email": s.type = .email
            case "phone_number": s.type = .phone
            case "created_time": s.type = .createdTime
            case "created_by": s.type = .createdBy
            case "last_edited_time": s.type = .lastEditedTime
            case "last_edited_by": s.type = .lastEditedBy
            case "unique_id": s.type = .uniqueID; s.idPrefix = cfg?["prefix"]?.string.flatMap { $0.isEmpty ? nil : $0 }
            case "button": s.type = .button
            case "verification": s.type = .verification
            case "place", "location": s.type = .place
            case "relation":
                if let target = NotionSnapshot.id(cfg?["data_source_id"]), snap.dataSources[target] != nil {
                    s.type = .relation
                    let synced = cfg?["dual_property"]?["synced_property_id"]?.string
                    s.relation = RelationConfig(databaseID: target, syncedPropertyID: synced.map { Self.propertyID(target, $0) })
                } else {
                    s.type = .text
                    s.description = [s.description, "Relation in Notion (the related database wasn't imported)."].compactMap { $0 }.joined(separator: " ")
                }
            case "formula", "rollup": s.type = .text   // resolved below
            default:
                s.type = .text
                s.description = [s.description, "Notion property type “\(ntype)”."].compactMap { $0 }.joined(separator: " ")
            }
            schema.append(s)
            index[nid] = s; index[nid.removingPercentEncoding ?? nid] = s; index["name:" + name] = s
            types[s.id] = ntype
        }
        schemas[ds] = schema
        propIndex[ds] = index
        notionTypes[ds] = types
        // Formulas and rollups
        let names = Dictionary(props.map { (($0.value["id"]?.string ?? $0.key).removingPercentEncoding ?? $0.key, $0.key) }, uniquingKeysWith: { a, _ in a })
        for (name, p) in ordered {
            let ntype = p["type"]?.string
            guard ntype == "formula" || ntype == "rollup", let nid = p["id"]?.string else { continue }
            guard var s = index[nid] else { continue }
            if ntype == "formula" {
                let expr = p["formula"]?["expression"]?.string ?? ""
                if let f = Self.convertFormula(expr, names: names) {
                    s.type = .formula; s.formula = f
                    liveFormula.insert(ds + "|" + s.id)
                } else {
                    s.type = staticType(ds, nid, kind: "formula")
                    let readable = Self.readableFormula(expr, names: names)
                    s.description = [s.description, "Formula in Notion: \(readable) — imported as values."].compactMap { $0 }.joined(separator: " ")
                }
            } else {
                let cfg = p["rollup"]
                let relID = cfg?["relation_property_id"]?.string
                let rel = relID.flatMap { index[$0] ?? index[$0.removingPercentEncoding ?? $0] } ?? cfg?["relation_property_name"]?.string.flatMap { index["name:" + $0] }
                var target: PropertySchema?
                if let rel, rel.type == .relation, let tds = rel.relation?.databaseID, let tsrc = snap.dataSources[tds] {
                    let tid = cfg?["rollup_property_id"]?.string
                    let tname = cfg?["rollup_property_name"]?.string
                    for (tn, tp) in tsrc["properties"]?.object ?? [:] where (tid != nil && Self.sameID(tp["id"]?.string ?? "", tid!)) || tn == tname {
                        let ttype = tp["type"]?.string ?? ""
                        target = PropertySchema(id: ttype == "title" ? Database.titlePropertyID : Self.propertyID(tds, tp["id"]?.string ?? tn), name: tn, type: .text)
                    }
                }
                if let rel, let target, let fn = Self.rollupFunction(cfg?["function"]?.string) {
                    s.type = .rollup
                    s.rollup = RollupConfig(relationPropertyID: rel.id, targetPropertyID: target.id, function: fn)
                } else {
                    s.type = staticType(ds, nid, kind: "rollup")
                    s.description = [s.description, "Rollup in Notion (\(cfg?["function"]?.string ?? "")) — imported as values."].compactMap { $0 }.joined(separator: " ")
                }
            }
            _ = name
            if let i = schema.firstIndex(where: { $0.id == s.id }) { schema[i] = s }
            index[nid] = s; index[nid.removingPercentEncoding ?? nid] = s; index["name:" + name] = s
        }
        schemas[ds] = schema
        propIndex[ds] = index
    }

    /// Value type of a formula / rollup kept as static values, from the rows' results.
    private func staticType(_ ds: String, _ nid: String, kind: String) -> PropertyType {
        for rid in snap.rows[ds] ?? [] {
            guard let page = snap.pages[rid] else { continue }
            for (_, v) in page["properties"]?.object ?? [:] where Self.sameID(v["id"]?.string ?? "", nid) {
                let r = v[kind]
                switch r?["type"]?.string {
                case "number": if r?["number"]?.number != nil { return .number }
                case "boolean": return .checkbox
                case "date": if r?["date"]?.isNull == false, r?["date"] != nil { return .date }
                default: break
                }
            }
        }
        return .text
    }

    private func prop(_ ds: String, _ nid: String?, name: String) -> PropertySchema? {
        let idx = propIndex[ds] ?? [:]
        if let nid, let s = idx[nid] ?? idx[nid.removingPercentEncoding ?? nid] { return s }
        return idx["name:" + name]
    }

    /// Finds a property by the id or name used in views / filters.
    private func prop(_ ds: String, ref: String?) -> PropertySchema? {
        guard let ref else { return nil }
        let idx = propIndex[ds] ?? [:]
        if ref == "title" { return schemas[ds]?.first { $0.type == .title } }
        return idx[ref] ?? idx[ref.removingPercentEncoding ?? ref] ?? idx["name:" + ref]
    }

    static func propertyID(_ ds: String, _ notionID: String) -> String {
        ImportIDs.derived(ds, "prop", notionID.removingPercentEncoding ?? notionID)
    }

    static func sameID(_ a: String, _ b: String) -> Bool {
        a == b || (a.removingPercentEncoding ?? a) == (b.removingPercentEncoding ?? b)
    }

    static func numberFormat(_ s: String?) -> NumberFormat? {
        guard let s else { return nil }
        switch s {
        case "number": return nil
        case "number_with_commas": return .numberWithCommas
        case "percent": return .percent
        case "euro": return .euro
        case "pound": return .pound
        case "yen": return .yen
        case "franc": return .franc
        case "rupee": return .rupee
        case "won": return .won
        case "yuan": return .yuan
        case "real": return .real
        case "ruble": return .ruble
        case "lira": return .lira
        default: return s.hasSuffix("dollar") ? .dollar : .numberWithCommas
        }
    }

    static func rollupFunction(_ s: String?) -> CalculationType? {
        switch s ?? "show_original" {
        case "show_original", "show_unique": return .showOriginal
        case "count", "count_all": return .countAll
        case "count_values": return .countValues
        case "unique", "count_unique_values": return .countUnique
        case "empty", "count_empty": return .countEmpty
        case "not_empty", "count_not_empty": return .countNotEmpty
        case "percent_empty": return .percentEmpty
        case "percent_not_empty": return .percentNotEmpty
        case "sum": return .sum
        case "average": return .average
        case "median": return .median
        case "min": return .min
        case "max": return .max
        case "range": return .range
        case "earliest_date": return .earliest
        case "latest_date": return .latest
        case "date_range": return .dateRange
        case "checked": return .checked
        case "unchecked": return .unchecked
        case "percent_checked": return .percentChecked
        case "percent_unchecked": return .percentUnchecked
        default: return nil
        }
    }

    private static let placeholder = try! NSRegularExpression(pattern: #"\{\{notion:block_property:([^:}]+)(?::[^}]*)?\}\}"#)

    /// `{{notion:block_property:ID:…}}` → `prop("Name")`; nil when the result isn't a formula Based can evaluate.
    static func convertFormula(_ expr: String, names: [String: String]) -> String? {
        guard !expr.isEmpty else { return nil }
        var ok = true
        let out = replacePlaceholders(expr) { id in
            guard let n = names[id.removingPercentEncoding ?? id] ?? names[id] else { ok = false; return "prop(\"?\")" }
            return "prop(\"" + n.replacingOccurrences(of: "\"", with: "\\\"") + "\")"
        }
        guard ok, (try? Formula(out)) != nil else { return nil }
        // Every function used must be one Based knows.
        let known = Set(Formula.functionNames)
        let call = try! NSRegularExpression(pattern: #"([A-Za-z_][A-Za-z0-9_]*)\s*\("#)
        let ns = out as NSString
        for m in call.matches(in: out, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1))
            if !known.contains(name) { return nil }
        }
        return out
    }

    /// The expression with property names, for descriptions.
    static func readableFormula(_ expr: String, names: [String: String]) -> String {
        replacePlaceholders(expr) { id in "prop(\"\(names[id.removingPercentEncoding ?? id] ?? names[id] ?? id)\")" }
    }

    private static func replacePlaceholders(_ s: String, _ f: (String) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in placeholder.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += f(ns.substring(with: m.range(at: 1)))
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    // MARK: Values

    private func value(_ v: JSONValue, _ s: PropertySchema, ds: String, page: String) -> PropertyValue? {
        let ntype = v["type"]?.string ?? ""
        let body = v[ntype]
        let pid = v["id"]?.string ?? ""
        func items() -> [JSONValue] {
            if let full = snap.propertyItems[page]?[pid] ?? snap.propertyItems[page]?[pid.removingPercentEncoding ?? pid] {
                return full.map { $0[ntype] ?? $0 }
            }
            return body?.array ?? []
        }
        switch ntype {
        case "rich_text":
            let rt = richText(body); return rt.isEmpty ? nil : .text(rt)
        case "number":
            return body?.number.map { .number($0) }
        case "select":
            guard let o = body, !o.isNull else { return nil }
            return .select(optionID(o, ds: ds, prop: s.id))
        case "status":
            guard let o = body, !o.isNull else { return nil }
            return .status(optionID(o, ds: ds, prop: s.id))
        case "multi_select":
            let ids = (body?.array ?? []).map { optionID($0, ds: ds, prop: s.id) }
            return ids.isEmpty ? nil : .multiSelect(ids)
        case "date":
            return dateValue(body).map { .date($0) }
        case "people":
            let names = items().compactMap { user($0) }
            return names.isEmpty ? nil : .person(names)
        case "files":
            let files = (body?.array ?? []).map { f -> FileValue in
                let m = media(f)
                return FileValue(name: f["name"]?.string ?? m.url.flatMap { URL(string: $0)?.lastPathComponent } ?? "File", asset: m.asset, url: m.url)
            }
            return files.isEmpty ? nil : .files(files)
        case "checkbox": return .checkbox(body?.bool ?? false)
        case "url": return body?.string.flatMap { $0.isEmpty ? nil : .url($0) }
        case "email": return body?.string.flatMap { $0.isEmpty ? nil : .email($0) }
        case "phone_number": return body?.string.flatMap { $0.isEmpty ? nil : .phone($0) }
        case "unique_id": return body?["number"]?.int.map { .uniqueID($0) }
        case "relation":
            let ids = items().compactMap { NotionSnapshot.id($0["id"]) }
            if ids.isEmpty { return nil }
            if s.type == .relation { return .relation(ids) }
            return .text(pageLinks(ids))
        case "formula":
            if liveFormula.contains(ds + "|" + s.id) { return nil }
            return computed(body, s)
        case "rollup":
            if s.type == .rollup { return nil }
            return computed(body, s)
        case "place", "location":
            let name = body?["name"]?.string ?? body?["address"]?.string
            return name.map { .place($0) }
        default:
            return nil
        }
    }

    /// A formula / rollup result stored as a plain value.
    private func computed(_ r: JSONValue?, _ s: PropertySchema) -> PropertyValue? {
        guard let r else { return nil }
        let t = r["type"]?.string ?? ""
        switch t {
        case "string": return r["string"]?.string.flatMap { $0.isEmpty ? nil : .text(RichText($0)) }
        case "number":
            guard let n = r["number"]?.number else { return nil }
            return s.type == .number ? .number(n) : .text(RichText(NumberFormatting.plain(n)))
        case "boolean":
            let b = r["boolean"]?.bool ?? false
            return s.type == .checkbox ? .checkbox(b) : .text(RichText(b ? "true" : "false"))
        case "date":
            guard let d = dateValue(r["date"]) else { return nil }
            return s.type == .date ? .date(d) : .text(RichText(DateParsing.format(d)))
        case "array":
            let parts = (r["array"]?.array ?? []).compactMap { displayText($0) }.filter { !$0.isEmpty }
            return parts.isEmpty ? nil : .text(RichText(parts.joined(separator: ", ")))
        default: return nil
        }
    }

    /// Plain text of a property value item (used for rollup arrays).
    private func displayText(_ v: JSONValue) -> String? {
        let t = v["type"]?.string ?? ""
        let body = v[t]
        switch t {
        case "title", "rich_text": return richText(body).plainText
        case "number": return body?.number.map(NumberFormatting.plain)
        case "select", "status": return body?["name"]?.string
        case "multi_select": return (body?.array ?? []).compactMap { $0["name"]?.string }.joined(separator: ", ")
        case "date": return dateValue(body).map(DateParsing.format)
        case "people": return (body?.array ?? []).compactMap { user($0) }.joined(separator: ", ")
        case "checkbox": return (body?.bool ?? false) ? "✓" : "✗"
        case "url", "email", "phone_number": return body?.string
        case "relation": return (body?.array ?? []).compactMap { NotionSnapshot.id($0["id"]).map(pageTitle) }.joined(separator: ", ")
        case "formula": return computed(body, PropertySchema(name: "", type: .text)).flatMap { if case .text(let r) = $0 { return r.plainText }; return nil }
        case "unique_id": return body?["number"]?.int.map { n in (body?["prefix"]?.string.map { $0 + "-" } ?? "") + String(n) }
        default: return body?.stringValue
        }
    }

    private func optionID(_ o: JSONValue, ds: String, prop: String) -> String {
        let name = o["name"]?.string ?? ""
        guard var schema = schemas[ds], let i = schema.firstIndex(where: { $0.id == prop }) else { return o["id"]?.string ?? name }
        let opts = schema[i].options ?? []
        if let id = o["id"]?.string, opts.contains(where: { $0.id == id }) { return id }
        if let hit = opts.first(where: { $0.name == name }) { return hit.id }
        // Unknown option (e.g. removed from the schema): add it.
        let new = SelectOption(id: o["id"]?.string ?? ImportIDs.derived(ds, prop, name), name: name, color: TColor(rawValue: o["color"]?.string ?? "default") ?? .default)
        schema[i].options = opts + [new]
        schemas[ds] = schema
        return new.id
    }

    private func pageTitle(_ id: String) -> String {
        snap.pages[id].map(Self.title(of:)).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled"
    }

    /// Links to pages that aren't part of the import.
    private func pageLinks(_ ids: [String]) -> RichText {
        var rt = RichText()
        for (i, id) in ids.enumerated() {
            if i > 0 { rt.runs.append(TextRun(", ")) }
            if importedIDs.contains(id) { rt.runs.append(TextRun(pageTitle(id), mention: .page(id))) }
            else { rt.runs.append(TextRun(pageTitle(id), marks: Marks(link: "https://www.notion.so/" + id.replacingOccurrences(of: "-", with: "")))) }
        }
        return rt
    }

    // MARK: Views

    /// Maps the views of `dbID` that show `ds` onto `container`; returns their ids in order.
    private func mapViews(container: String, dbID: String, ds: String, primary: Bool) -> [String] {
        let all = snap.views[dbID] ?? []
        var vs = all.filter { NotionSnapshot.id($0["data_source_id"]) == ds || ($0["data_source_id"] == nil && primary) }
        vs = vs.filter { $0["type"]?.string != "dashboard" }
        if all.contains(where: { $0["type"]?.string == "dashboard" }) {
            builder.notes.append("Dashboard views aren't supported yet; their widgets were imported as separate views.")
        }
        var ids: [String] = []
        var key: String?
        for v in vs {
            guard let vid = NotionSnapshot.id(v["id"]) else { continue }
            key = FractionalIndex.between(key, nil)
            if let view = mapView(v, id: vid, container: container, ds: ds, sortKey: key!) {
                builder.addView(view)
                ids.append(view.id)
            }
        }
        if ids.isEmpty {
            let vid = ImportIDs.derived(container, "view")
            var v = DatabaseView(id: vid, databaseID: ds, blockID: container, name: "Table", type: .table, sortKey: FractionalIndex.first)
            v.properties = (schemas[ds] ?? []).map { ViewProperty(id: $0.id, visible: true) }
            builder.addView(v)
            ids = [vid]
        }
        return ids
    }

    private func mapView(_ v: JSONValue, id: String, container: String, ds: String, sortKey: String) -> DatabaseView? {
        let ntype = v["type"]?.string ?? "table"
        let cfg = v["configuration"]
        var type = ViewType(rawValue: ntype) ?? .table
        if !ViewType.available.contains(type) {
            builder.notes.append("“\(v["name"]?.string ?? ntype)” is a \(ntype) view in Notion — imported as a table.")
            type = .table
        }
        var name = v["name"]?.string ?? ""
        if name.isEmpty { name = type.displayName }
        var view = DatabaseView(id: id, databaseID: ds, blockID: container, name: name, type: type, sortKey: sortKey)
        if let t = time(v["created_time"]) { view.createdAt = t }
        if let t = time(v["last_edited_time"]) { view.updatedAt = t } else { view.updatedAt = view.createdAt }

        // Properties
        var vp: [ViewProperty] = []
        for p in cfg?["properties"]?.array ?? [] {
            guard let s = prop(ds, ref: p["property_id"]?.string), !vp.contains(where: { $0.id == s.id }) else { continue }
            vp.append(ViewProperty(id: s.id, visible: p["visible"]?.bool ?? true, width: p["width"]?.number))
        }
        if !vp.isEmpty {
            // Properties the view doesn't list are hidden there in Notion (except in tables, where new ones show up).
            if type != .table {
                for s in schemas[ds] ?? [] where !vp.contains(where: { $0.id == s.id }) && s.type != .title { vp.append(ViewProperty(id: s.id, visible: false)) }
            }
            view.properties = vp
        }
        // Grouping
        if let g = cfg?["group_by"], !g.isNull, let s = prop(ds, ref: g["property_id"]?.string) {
            var rule = GroupRule(propertyID: s.id)
            if g["hide_empty_groups"]?.bool == true { rule.hideEmptyGroups = true }
            switch g["group_by"]?.string {
            case "relative"?: rule.dateGrouping = .relative
            case "day"?: rule.dateGrouping = .day
            case "week"?: rule.dateGrouping = .week
            case "month"?: rule.dateGrouping = .month
            case "year"?: rule.dateGrouping = .year
            default: break
            }
            if type == .board || type == .table || type == .list || type == .gallery { view.groupBy = rule }
        }
        // Dates
        if let s = prop(ds, ref: cfg?["date_property_id"]?.string) { view.datePropertyID = s.id }
        if let s = prop(ds, ref: cfg?["end_date_property_id"]?.string) { view.endDatePropertyID = s.id }
        if (type == .calendar || type == .timeline) && view.datePropertyID == nil {
            view.datePropertyID = schemas[ds]?.first { $0.type == .date }?.id
        }
        // Cards
        if let c = cfg?["cover"], !c.isNull {
            switch c["type"]?.string {
            case "page_cover"?: view.cardCover = .pageCover
            case "page_content"?: view.cardCover = .pageContent
            case "property"?: view.cardCover = prop(ds, ref: c["property_id"]?.string).map { .property($0.id) } ?? CardCover.none
            default: break
            }
        } else if type == .gallery || type == .board, cfg?["cover"]?.isNull == true {
            view.cardCover = CardCover.none
        }
        if let size = cfg?["cover_size"]?.string { view.cardSize = CardSize(rawValue: size) }
        if let w = cfg?["wrap_cells"]?.bool { view.wrapCells = w }
        // Chart
        if type == .chart { view.chart = chart(cfg, ds: ds) }
        // Filter & sorts
        if let f = v["filter"], !f.isNull, let g = filterGroup(f, ds: ds, view: &view), !g.isEmpty { view.filter = g }
        var sorts: [SortRule] = []
        for s in v["sorts"]?.array ?? [] {
            let asc = (s["direction"]?.string ?? "ascending") == "ascending"
            if let ts = s["timestamp"]?.string, let p = timestampProperty(ts, ds: ds, view: &view) { sorts.append(SortRule(propertyID: p, ascending: asc)) }
            else if let p = prop(ds, ref: s["property"]?.string) { sorts.append(SortRule(propertyID: p.id, ascending: asc)) }
        }
        if !sorts.isEmpty { view.sorts = sorts }
        return view
    }

    private func chart(_ cfg: JSONValue?, ds: String) -> ChartConfig {
        var c = ChartConfig()
        switch cfg?["chart_type"]?.string {
        case "bar"?: c.kind = .horizontalBar
        case "line"?: c.kind = cfg?["hide_line_fill_area"]?.bool == false ? .area : .line
        case "donut"?: c.kind = .donut
        default: c.kind = .bar
        }
        if let x = cfg?["x_axis"], !x.isNull {
            c.xPropertyID = prop(ds, ref: x["property_id"]?.string)?.id
            switch x["group_by"]?.string {
            case "day"?: c.dateBucket = .day
            case "week"?: c.dateBucket = .week
            case "year"?: c.dateBucket = .year
            default: break
            }
        } else if let x = prop(ds, ref: cfg?["x_axis_property_id"]?.string) { c.xPropertyID = x.id }
        let agg = cfg?["y_axis"] ?? cfg?["value"]
        if let a = agg, !a.isNull {
            c.yPropertyID = prop(ds, ref: a["property_id"]?.string)?.id
            c.aggregate = ChartConfig.Aggregate(rawValue: a["aggregator"]?.string ?? "count") ?? .count
            if c.yPropertyID == nil { c.aggregate = .count }
        }
        if let l = cfg?["show_data_labels"]?.bool { c.showValues = l }
        if cfg?["legend_position"]?.string == "off" { c.showLegend = false }
        if let s = cfg?["sort"]?.string { c.sortByValue = s.hasPrefix("y_") }
        return c
    }

    /// Sorting / filtering by created or edited time needs a property for it.
    private func timestampProperty(_ ts: String, ds: String, view: inout DatabaseView) -> String? {
        let type: PropertyType = ts == "created_time" ? .createdTime : .lastEditedTime
        if let s = schemas[ds]?.first(where: { $0.type == type }) { return s.id }
        let s = PropertySchema(id: ImportIDs.derived(ds, "prop", ts), name: type == .createdTime ? "Created time" : "Last edited time", type: type)
        schemas[ds, default: []].append(s)
        var vp = view.properties ?? []
        vp.append(ViewProperty(id: s.id, visible: false))
        view.properties = vp
        return s.id
    }

    private func filterGroup(_ f: JSONValue, ds: String, view: inout DatabaseView) -> FilterGroup? {
        if let items = f["and"]?.array ?? f["or"]?.array {
            let comb: Combinator = f["and"] != nil ? .and : .or
            var out: [FilterItem] = []
            for i in items {
                if i["and"] != nil || i["or"] != nil {
                    if let g = filterGroup(i, ds: ds, view: &view), !g.isEmpty { out.append(.group(g)) }
                } else if let c = condition(i, ds: ds, view: &view) {
                    out.append(.condition(c))
                }
            }
            return FilterGroup(combinator: comb, items: out)
        }
        return condition(f, ds: ds, view: &view).map { FilterGroup(combinator: .and, items: [.condition($0)]) }
    }

    private func condition(_ f: JSONValue, ds: String, view: inout DatabaseView) -> FilterCondition? {
        let pid: String
        var schema: PropertySchema?
        if let ts = f["timestamp"]?.string {
            guard let p = timestampProperty(ts, ds: ds, view: &view) else { return nil }
            pid = p; schema = schemas[ds]?.first { $0.id == p }
        } else {
            guard let s = prop(ds, ref: f["property"]?.string) else { approximations += 1; return nil }
            pid = s.id; schema = s
        }
        guard let typeKey = f.object?.keys.first(where: { !["property", "timestamp", "type"].contains($0) }) else { return nil }
        var body = f[typeKey]
        // formula / rollup filters wrap the condition once more
        if typeKey == "formula" || typeKey == "rollup", let inner = body?.object?.first {
            if ["any", "every", "none"].contains(inner.key) { approximations += 1 }
            body = inner.value
            if let deeper = body?.object?.first, deeper.value.object != nil, ["rich_text", "select", "multi_select", "number", "date", "checkbox", "status", "people"].contains(deeper.key) { body = deeper.value }
        }
        guard let (opKey, raw) = body?.object?.first else { return nil }
        var op: FilterOp
        var value: FilterValue?
        switch opKey {
        case "equals": op = .equals
        case "does_not_equal": op = .notEquals
        case "contains": op = .contains
        case "does_not_contain": op = .notContains
        case "starts_with": op = .startsWith
        case "ends_with": op = .endsWith
        case "is_empty": op = .isEmpty
        case "is_not_empty": op = .isNotEmpty
        case "greater_than": op = .greater
        case "less_than": op = .less
        case "greater_than_or_equal_to": op = .greaterOrEqual
        case "less_than_or_equal_to": op = .lessOrEqual
        case "before": op = .before
        case "after": op = .after
        case "on_or_before": op = .onOrBefore
        case "on_or_after": op = .onOrAfter
        case "past_week": op = .within; value = .relative(.pastWeek)
        case "past_month": op = .within; value = .relative(.pastMonth)
        case "past_year": op = .within; value = .relative(.pastYear)
        case "next_week": op = .within; value = .relative(.nextWeek)
        case "next_month": op = .within; value = .relative(.nextMonth)
        case "next_year": op = .within; value = .relative(.nextYear)
        case "this_week": op = .within; value = .relative(.pastWeek); approximations += 1
        case "this_month": op = .within; value = .relative(.pastMonth); approximations += 1
        default: approximations += 1; return nil
        }
        if op.needsValue && value == nil {
            value = filterValue(raw, schema: schema, ds: ds)
            if value == nil { return nil }
        }
        return FilterCondition(id: ImportIDs.derived(view.id, "filter", pid, opKey, raw.text), propertyID: pid, op: op, value: value)
    }

    private func filterValue(_ raw: JSONValue, schema: PropertySchema?, ds: String) -> FilterValue? {
        switch raw {
        case .bool(let b): return .bool(b)
        case .number(let n): return .number(n)
        case .string(let s):
            guard let schema else { return .text(s) }
            switch schema.type {
            case .select, .status, .multiSelect:
                let id = schema.options?.first { $0.name == s || $0.id == s }?.id ?? s
                return .options([id])
            case .person, .createdBy, .lastEditedBy:
                if s == "me" { return nil }
                return .options([snap.users[ImportIDs.notion(s) ?? s] ?? s])
            case .relation:
                return .options([ImportIDs.notion(s) ?? s])
            case .date, .createdTime, .lastEditedTime:
                switch s {
                case "today": return .relative(.today)
                case "tomorrow": return .relative(.tomorrow)
                case "yesterday": return .relative(.yesterday)
                case "one_week_ago": approximations += 1; return .date(Date().addingTimeInterval(-7 * 86400))
                case "one_week_from_now": approximations += 1; return .date(Date().addingTimeInterval(7 * 86400))
                case "one_month_ago": approximations += 1; return .date(Calendar.current.date(byAdding: .month, value: -1, to: Date())!)
                case "one_month_from_now": approximations += 1; return .date(Calendar.current.date(byAdding: .month, value: 1, to: Date())!)
                default: return parseDate(s).map { .date($0.date) }
                }
            case .number, .uniqueID:
                return Double(s).map { .number($0) } ?? .text(s)
            case .checkbox:
                return .bool(s == "true")
            default:
                return .text(s)
            }
        default:
            return nil
        }
    }

    // MARK: Rich text

    func richText(_ arr: JSONValue?) -> RichText {
        var runs: [TextRun] = []
        for r in arr?.array ?? [] {
            let a = r["annotations"]
            var m = Marks()
            m.bold = a?["bold"]?.bool ?? false
            m.italic = a?["italic"]?.bool ?? false
            m.strikethrough = a?["strikethrough"]?.bool ?? false
            m.underline = a?["underline"]?.bool ?? false
            m.code = a?["code"]?.bool ?? false
            m.color = Self.color(a?["color"]?.string)
            let plain = r["plain_text"]?.string ?? ""
            switch r["type"]?.string {
            case "equation"?:
                let ex = r["equation"]?["expression"]?.string ?? plain
                runs.append(TextRun(ex, marks: m, equation: ex))
            case "mention"?:
                let men = r["mention"]
                let kind = men?["type"]?.string ?? ""
                switch kind {
                case "page", "database":
                    if let id = NotionSnapshot.id(men?[kind]?["id"]), importedIDs.contains(id) {
                        runs.append(TextRun(plain.isEmpty ? pageTitle(id) : plain, marks: m, mention: .page(id)))
                    } else {
                        m.link = r["href"]?.string ?? NotionSnapshot.id(men?[kind]?["id"]).map { "https://www.notion.so/" + $0.replacingOccurrences(of: "-", with: "") }
                        runs.append(TextRun(plain.isEmpty ? "Untitled" : plain, marks: m))
                    }
                case "user":
                    let name = user(men?["user"]) ?? plain.replacingOccurrences(of: "@", with: "")
                    runs.append(TextRun(plain.isEmpty ? "@" + name : plain, marks: m, mention: .user(name)))
                case "date":
                    if let d = dateValue(men?["date"]) { runs.append(TextRun(plain, marks: m, mention: .date(d))) }
                    else { runs.append(TextRun(plain, marks: m)) }
                case "link_preview", "link_mention":
                    let url = men?[kind]?["url"]?.string ?? men?[kind]?["href"]?.string ?? r["href"]?.string ?? plain
                    runs.append(TextRun(plain.isEmpty ? url : plain, marks: m, mention: .link(url)))
                default:
                    if let h = r["href"]?.string { m.link = link(h) }
                    runs.append(TextRun(plain, marks: m))
                }
            default:
                let content = r["text"]?["content"]?.string ?? plain
                if let h = r["text"]?["link"]?["url"]?.string ?? r["href"]?.string { m.link = link(h) }
                runs.append(TextRun(content, marks: m))
            }
        }
        var rt = RichText(runs: runs)
        if rt.runs.isEmpty { rt = RichText() }
        return rt
    }

    /// Links into the imported workspace become internal links.
    private func link(_ href: String) -> String {
        let isNotion = href.hasPrefix("/") || href.contains("notion.so/") || href.contains("notion.site/")
        if isNotion, let id = ImportIDs.notionID(inName: href), importedIDs.contains(id) { return "based://page/" + id }
        if href.hasPrefix("/") { return "https://www.notion.so" + href }
        return href
    }

    static func color(_ s: String?) -> TColor? {
        guard let s, s != "default" else { return nil }
        if s.hasSuffix("_background") { return TColor(rawValue: String(s.dropLast("_background".count)) + "Background") }
        return TColor(rawValue: s)
    }

    // MARK: Icons, files, people, dates

    private func icon(_ j: JSONValue?) -> PageIcon? {
        guard let j, !j.isNull else { return nil }
        switch j["type"]?.string {
        case "emoji"?: return j["emoji"]?.string.map(PageIcon.emoji)
        case "external"?: return j["external"]?["url"]?.string.map(PageIcon.url)
        case "file"?, "file_upload"?:
            let m = media(j); return m.asset.map(PageIcon.asset) ?? m.url.map(PageIcon.url)
        case "custom_emoji"?:
            if let url = j["custom_emoji"]?["url"]?.string {
                if let local = snap.files[NotionSnapshot.fileKey(url)] { return .asset(builder.asset(file: local, name: (j["custom_emoji"]?["name"]?.string ?? "emoji") + "." + local.pathExtension)) }
                return .url(url)
            }
            return nil
        case "icon"?:
            let name = j["icon"]?["name"]?.string ?? "document"
            let color = j["icon"]?["color"]?.string ?? "gray"
            return .url("https://www.notion.so/icons/\(name)_\(color).svg")
        default: return nil
        }
    }

    private func cover(_ j: JSONValue?) -> PageCover? {
        guard let j, !j.isNull else { return nil }
        let m = media(j)
        return m.asset.map(PageCover.asset) ?? m.url.map(PageCover.url)
    }

    /// A file object (`{type: file|external|file_upload, …}`): a local copy when downloaded, else its URL.
    private func media(_ j: JSONValue?) -> (asset: AssetRef?, url: String?) {
        guard let j else { return (nil, nil) }
        let t = j["type"]?.string ?? ""
        let url = j[t]?["url"]?.string ?? j["external"]?["url"]?.string ?? j["file"]?["url"]?.string
        guard let url else { return (nil, nil) }
        if t != "external", let local = snap.files[NotionSnapshot.fileKey(url)] {
            return (builder.asset(file: local, name: j["name"]?.string ?? local.lastPathComponent), nil)
        }
        return (nil, url)
    }

    private func user(_ j: JSONValue?) -> String? {
        guard let j, !j.isNull else { return nil }
        if let n = j["name"]?.string, !n.isEmpty { return n }
        if let id = NotionSnapshot.id(j["id"]), let n = snap.users[id] { return n }
        return j["person"]?["email"]?.string
    }

    private func time(_ j: JSONValue?) -> Date? {
        guard let s = j?.string else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s)
    }

    private func parseDate(_ s: String) -> (date: Date, time: Bool)? {
        if s.count <= 10 { return day.date(from: s).map { ($0, false) } }
        if let d = isoFrac.date(from: s) ?? iso.date(from: s) { return (d, true) }
        return day.date(from: String(s.prefix(10))).map { ($0, false) }
    }

    private func dateValue(_ j: JSONValue?) -> DateValue? {
        guard let j, !j.isNull, let start = j["start"]?.string, let s = parseDate(start) else { return nil }
        let end = j["end"]?.string.flatMap(parseDate)
        return DateValue(start: s.date, end: end?.date, includeTime: s.time)
    }

    private func titleText(of page: JSONValue) -> RichText {
        for (_, v) in page["properties"]?.object ?? [:] where v["type"]?.string == "title" { return richText(v["title"]) }
        return richText(page["title"])
    }

    /// Plain title of a page or database object.
    public static func title(of page: JSONValue) -> String {
        for (_, v) in page["properties"]?.object ?? [:] where v["type"]?.string == "title" {
            return (v["title"]?.array ?? []).compactMap { $0["plain_text"]?.string }.joined()
        }
        if let t = page["title"]?.array { return t.compactMap { $0["plain_text"]?.string }.joined() }
        return page["child_page"]?["title"]?.string ?? ""
    }
}
