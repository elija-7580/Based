import Foundation
import BasedCore

/// Tools over the workspace. One implementation serves the in-app agent runtime,
/// the scheduler and the MCP server, so every connected AI gets the same capabilities.
@MainActor
public final class AgentTools {
    public let store: WorkspaceStore
    public let brain: BrainStore
    public init(store: WorkspaceStore, brain: BrainStore) { self.store = store; self.brain = brain }

    public var specs: [ToolSpec] {
        [
            ToolSpec(name: "search", description: "Search pages and database rows by title and full text. Returns ids, titles and snippets.",
                     inputSchema: .schema(["query": .str("Search text"), "limit": .num("Max results (default 20)")], required: ["query"])),
            ToolSpec(name: "read_page", description: "Read a page as Markdown, including its properties when it is a database row.",
                     inputSchema: .schema(["page_id": .str("Page id")], required: ["page_id"])),
            ToolSpec(name: "list_pages", description: "List top-level pages, or the subpages of a page.",
                     inputSchema: .schema(["parent_id": .str("Optional parent page id")])),
            ToolSpec(name: "create_page", description: "Create a page with Markdown content under a parent page (or at workspace root).",
                     inputSchema: .schema(["title": .str("Title"), "markdown": .str("Body as Markdown"), "parent_id": .str("Parent page id"), "icon": .str("Emoji icon")], required: ["title"])),
            ToolSpec(name: "append_markdown", description: "Append Markdown blocks to the end of a page.",
                     inputSchema: .schema(["page_id": .str("Page id"), "markdown": .str("Markdown to append")], required: ["page_id", "markdown"])),
            ToolSpec(name: "replace_page_content", description: "Replace the whole body of a page with new Markdown.",
                     inputSchema: .schema(["page_id": .str("Page id"), "markdown": .str("New body")], required: ["page_id", "markdown"])),
            ToolSpec(name: "query_database", description: "List rows of a database with their property values (as text).",
                     inputSchema: .schema(["database_id": .str("Database id (or the id of its page/block)"), "filter_text": .str("Optional substring that must appear in the row title or values"), "limit": .num("Max rows (default 100)")], required: ["database_id"])),
            ToolSpec(name: "add_row", description: "Add a row to a database. Property values are given by property name as strings.",
                     inputSchema: .schema(["database_id": .str("Database id"), "title": .str("Row title"), "properties": ["type": "object", "description": "name → value"], "markdown": .str("Optional page body")], required: ["database_id", "title"])),
            ToolSpec(name: "update_row", description: "Set property values on a database row by property name.",
                     inputSchema: .schema(["row_id": .str("Row id"), "properties": ["type": "object", "description": "name → value"]], required: ["row_id", "properties"])),
            ToolSpec(name: "list_databases", description: "List databases with their ids and property schemas.", inputSchema: .schema([:])),
            ToolSpec(name: "memory_search", description: "Search the user's durable memories (preferences, people, decisions).",
                     inputSchema: .schema(["query": .str("What to recall")], required: ["query"])),
            ToolSpec(name: "memory_save", description: "Save or extend a memory. One topic per memory; title the topic, not the fact.",
                     inputSchema: .schema(["title": .str("Topic"), "type": .str("Profile | Preference | Work | People | Notes"), "markdown": .str("Short bullets")], required: ["title", "markdown"])),
            ToolSpec(name: "list_skills", description: "List available skills (reusable instructions).", inputSchema: .schema([:])),
            ToolSpec(name: "load_skill", description: "Load a skill's full instructions by name.",
                     inputSchema: .schema(["name": .str("Skill name")], required: ["name"])),
            ToolSpec(name: "about_user", description: "Read the user's About page.", inputSchema: .schema([:])),
            ToolSpec(name: "create_chart", description: "Add a chart view to a database (bar, horizontalBar, line, area, pie, donut). x_property groups rows (select/status/date/checkbox/text); y_property is a number property to aggregate (omit to count rows).",
                     inputSchema: .schema(["database_id": .str("Database id"), "kind": .str("bar | horizontalBar | line | area | pie | donut"), "x_property": .str("Property name for the x axis / slices"), "y_property": .str("Number property to aggregate (optional)"), "aggregate": .str("count | sum | average | min | max | median"), "name": .str("View name")], required: ["database_id", "kind"])),
            ToolSpec(name: "add_html", description: "Append an HTML visualisation block (rendered in a sandboxed web view) to a page. Inline <style> and <script> are allowed; use it for custom charts, diagrams, widgets.",
                     inputSchema: .schema(["page_id": .str("Page id"), "html": .str("Complete HTML snippet"), "height": .num("Height in points (default 320)")], required: ["page_id", "html"])),
            ToolSpec(name: "add_mermaid", description: "Append a Mermaid diagram (flowchart, sequence, gantt, mindmap …) to a page.",
                     inputSchema: .schema(["page_id": .str("Page id"), "mermaid": .str("Mermaid source")], required: ["page_id", "mermaid"])),
            ToolSpec(name: "list_connections", description: "List connected external services (MCP servers) and their tools. External tools are called directly by name.", inputSchema: .schema([:])),
            ToolSpec(name: "inbox", description: "List pending items in the user's inbox (permission requests and questions from coding agents).", inputSchema: .schema([:])),
        ] + hostSpecs + externalSpecs
    }

    /// Tools provided by the host runtime (sub-agents …), executed asynchronously through `hostCall`.
    public var hostSpecs: [ToolSpec] = []
    public var hostCall: (@Sendable (String, JSONValue) async -> ToolResult?)?
    public func isHost(_ name: String) -> Bool { hostSpecs.contains { $0.name == name } }

    /// Runs any tool — built-in (sync), host or external (async).
    public func callAsync(_ name: String, _ args: JSONValue) async -> ToolResult {
        if isHost(name), let h = hostCall, let r = await h(name, args) { return r }
        if isExternal(name), let e = externalCall, let r = await e(name, args) { return r }
        return call(name, args)
    }

    public struct ToolResult: Sendable { public var text: String; public var isError: Bool }

    /// Tools provided by connected MCP servers (filled by `ConnectionManager`). Names are `<slug>__<tool>`.
    public var externalSpecs: [ToolSpec] = []
    /// Async executor for external tools; returns nil when the name is not external.
    public var externalCall: (@Sendable (String, JSONValue) async -> ToolResult?)?
    public func isExternal(_ name: String) -> Bool { externalSpecs.contains { $0.name == name } }
    nonisolated public static func slug(_ name: String) -> String {
        String(name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "_" }).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    }

    public func call(_ name: String, _ args: JSONValue) -> ToolResult {
        do { return ToolResult(text: try dispatch(name, args), isError: false) }
        catch { return ToolResult(text: "Error: \(error)", isError: true) }
    }

    struct ToolError: Error, CustomStringConvertible { let description: String; init(_ d: String) { description = d } }

    private func req(_ args: JSONValue, _ k: String) throws -> String {
        guard let v = args[k]?.stringValue, !v.isEmpty else { throw ToolError("Missing argument '\(k)'") }
        return v
    }

    private func dispatch(_ name: String, _ a: JSONValue) throws -> String {
        switch name {
        case "search":
            let hits = SearchEngine(store: store).search(try req(a, "query"), limit: a["limit"]?.int ?? 20)
            return hits.map { h in "- \(store.title(of: h.pageID)) [id: \(h.pageID), link: \(PageLink.url(h.pageID))]" + (h.snippet.map { " — \($0)" } ?? "") }.joined(separator: "\n").nonEmpty ?? "No results."
        case "read_page":
            let id = try req(a, "page_id")
            guard let b = store.blocks[id] else { throw ToolError("No page \(id)") }
            var out = "# \(store.title(of: id))\n"
            if let db = store.database(ofRow: id) {
                out += "Properties:\n" + db.properties.filter { $0.type != .title }.map { "- \($0.name): \(propertyText(b, $0, db))" }.joined(separator: "\n") + "\n\n"
            }
            return out + MarkdownExporter(store: store).export(page: id, includeTitle: false)
        case "list_pages":
            let pages = a["parent_id"]?.stringValue.map { store.subpages(of: $0) } ?? store.topLevelPages()
            return pages.map { "- \($0.title.nonEmpty ?? "Untitled") [id: \($0.id), link: \(PageLink.url($0.id))]" }.joined(separator: "\n").nonEmpty ?? "(none)"
        case "create_page":
            let parent: ParentRef = a["parent_id"]?.stringValue.map { .block($0) } ?? .workspace
            let id = store.createPage(title: RichText(try req(a, "title")), in: parent, icon: a["icon"]?.string.map { .emoji($0) })
            if let md = a["markdown"]?.string, !md.isEmpty { brain.appendBody(id, markdown: md) }
            return "Created page \(id)"
        case "append_markdown":
            let id = try req(a, "page_id"); guard store.blocks[id] != nil else { throw ToolError("No page \(id)") }
            brain.appendBody(id, markdown: try req(a, "markdown")); return "Appended to \(id)"
        case "replace_page_content":
            let id = try req(a, "page_id"); guard store.blocks[id] != nil else { throw ToolError("No page \(id)") }
            brain.setBody(id, markdown: try req(a, "markdown")); return "Replaced content of \(id)"
        case "list_databases":
            return store.databases.values.sorted { $0.title.plainText < $1.title.plainText }.map { db in
                "- \(db.title.plainText.nonEmpty ?? "Untitled") [id: \(db.id)]: " + db.properties.map { "\($0.name) (\($0.type.rawValue))" }.joined(separator: ", ")
            }.joined(separator: "\n").nonEmpty ?? "(none)"
        case "query_database":
            let db = try database(a)
            let needle = a["filter_text"]?.string?.lowercased()
            var rows = store.rows(of: db.id)
            if let needle, !needle.isEmpty {
                rows = rows.filter { r in (r.title + " " + db.properties.map { propertyText(r, $0, db) }.joined(separator: " ")).lowercased().contains(needle) }
            }
            return rows.prefix(a["limit"]?.int ?? 100).map { r in
                "- \(r.title.nonEmpty ?? "Untitled") [id: \(r.id), link: \(PageLink.url(r.id))] " + db.properties.filter { $0.type != .title }.compactMap { p in
                    let t = propertyText(r, p, db); return t.isEmpty ? nil : "\(p.name)=\(t)" }.joined(separator: "; ")
            }.joined(separator: "\n").nonEmpty ?? "(no rows)"
        case "add_row":
            let db = try database(a)
            let id = store.addRow(to: db.id, title: RichText(try req(a, "title")))
            try setProperties(id, db, a["properties"])
            if let md = a["markdown"]?.string, !md.isEmpty { brain.appendBody(id, markdown: md) }
            return "Added row \(id)"
        case "update_row":
            let id = try req(a, "row_id")
            guard let db = store.database(ofRow: id) else { throw ToolError("No row \(id)") }
            try setProperties(id, db, a["properties"]); return "Updated \(id)"
        case "memory_search":
            return brain.searchMemories(try req(a, "query")).map { "## \($0.title) (\($0.kind.rawValue)) [id: \($0.id)]\n\($0.body)" }.joined(separator: "\n").nonEmpty ?? "No memories match."
        case "memory_save":
            let kind = Memory.Kind(rawValue: a["type"]?.string ?? "") ?? .Notes
            return "Saved memory \(brain.saveMemory(title: try req(a, "title"), kind: kind, body: try req(a, "markdown")))"
        case "list_skills":
            return brain.skills(enabledOnly: true).map { "- \($0.name): \($0.description)" }.joined(separator: "\n").nonEmpty ?? "(no skills)"
        case "load_skill":
            let n = try req(a, "name")
            guard let s = brain.skills().first(where: { $0.name.caseInsensitiveCompare(n) == .orderedSame }) else { throw ToolError("No skill '\(n)'") }
            return "# \(s.name)\n\(s.body)"
        case "about_user": return brain.about
        case "create_chart":
            let db = try database(a)
            let kind = ChartConfig.Kind(rawValue: try req(a, "kind")) ?? .bar
            let x = a["x_property"]?.string.flatMap { n in db.properties.first { $0.name.caseInsensitiveCompare(n) == .orderedSame }?.id }
            let y = a["y_property"]?.string.flatMap { n in db.properties.first { $0.name.caseInsensitiveCompare(n) == .orderedSame }?.id }
            let agg = ChartConfig.Aggregate(rawValue: a["aggregate"]?.string ?? "") ?? (y == nil ? .count : .sum)
            guard let vid = store.addView(to: db.blockID, type: .chart, name: a["name"]?.string ?? "Chart") else { throw ToolError("Could not add view") }
            store.updateView(vid, name: "Configure chart") { $0.chart = ChartConfig(kind: kind, xPropertyID: x, yPropertyID: y, aggregate: agg) }
            return "Created chart view \(vid) on database \(db.title.plainText)."
        case "add_html":
            let id = try req(a, "page_id"); let html = try req(a, "html")
            guard store.blocks[id] != nil else { throw ToolError("No page \(id)") }
            var b = ImportedBlock(.code, text: RichText(html)); b.props.language = "html"; b.props.url = "preview"; b.props.caption = a["height"]?.number.map { RichText("height=\(Int($0))") }
            store.insertImported([b], in: .block(id), name: "Add HTML")
            return "Added HTML block to \(id)."
        case "add_mermaid":
            let id = try req(a, "page_id"); let src = try req(a, "mermaid")
            guard store.blocks[id] != nil else { throw ToolError("No page \(id)") }
            var b = ImportedBlock(.code, text: RichText(src)); b.props.language = "mermaid"; b.props.url = "preview"
            store.insertImported([b], in: .block(id), name: "Add diagram")
            return "Added Mermaid diagram to \(id)."
        case "list_connections":
            let cs = brain.connections()
            if cs.isEmpty { return "No connections. Add MCP servers in Settings → Connections." }
            return cs.map { c in "- \(c.name) (\(c.transport.rawValue), \(c.enabled ? "enabled" : "disabled")) \(c.status)\n" + (externalSpecs.filter { $0.name.hasPrefix(Self.slug(c.name) + "__") }.map { "    • \($0.name): \($0.description.prefix(80))" }.joined(separator: "\n")) }.joined(separator: "\n")
        case "inbox":
            let items = brain.inbox(pendingOnly: true)
            return items.isEmpty ? "Inbox is empty." : items.map { "- [\($0.kind.rawValue)] \($0.title) (id: \($0.id))" }.joined(separator: "\n")
        default: throw ToolError("Unknown tool \(name)")
        }
    }

    private func database(_ a: JSONValue) throws -> Database {
        let id = try req(a, "database_id")
        if let db = store.databases[id] { return db }
        if let db = store.database(forBlock: id) { return db }
        if let db = store.database(ofRow: id) { return db }
        throw ToolError("No database \(id)")
    }

    public func propertyText(_ row: Block, _ p: PropertySchema, _ db: Database) -> String {
        if p.type == .title { return row.title }
        guard let v = row.values[p.id] else { return "" }
        switch v {
        case .text(let t): return t.plainText
        case .number(let n): return CellFormatter.number(n, p.numberFormat)
        case .select(let o), .status(let o): return p.option(o)?.name ?? ""
        case .multiSelect(let os): return os.compactMap { p.option($0)?.name }.joined(separator: ", ")
        case .date(let d): return DateParsing.format(d)
        case .checkbox(let b): return b ? "true" : "false"
        case .url(let s), .email(let s), .phone(let s): return s
        case .place(let s): return PlaceValue.display(s)
        case .person(let ps): return ps.joined(separator: ", ")
        case .relation(let ids): return ids.map { store.title(of: $0) }.joined(separator: ", ")
        case .files(let fs): return "\(fs.count) file(s)"
        case .uniqueID(let n): return (p.idPrefix.map { $0 + "-" } ?? "") + String(n)
        }
    }

    private func setProperties(_ rowID: RecordID, _ db: Database, _ props: JSONValue?) throws {
        guard let o = props?.object else { return }
        for (name, raw) in o {
            guard let p = db.properties.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else { throw ToolError("No property '\(name)'") }
            let s = raw.stringValue ?? raw.text
            let value: PropertyValue?
            switch p.type {
            case .title: store.setText(rowID, RichText(s)); continue
            case .text: value = .text(RichText(s))
            case .number: value = Double(s).map { .number($0) }
            case .checkbox: value = .checkbox(["true", "yes", "1", "__YES__"].contains(s.lowercased()))
            case .url: value = .url(s)
            case .email: value = .email(s)
            case .phone: value = .phone(s)
            case .select, .status:
                value = store.addOption(db.id, p.id, name: s).map { p.type == .status ? .status($0) : .select($0) }
            case .multiSelect:
                let names = raw.stringArray ?? s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                value = .multiSelect(names.compactMap { store.addOption(db.id, p.id, name: $0) })
            case .date: value = DateParsing.parse(s).map { .date($0) }
            case .relation:
                let ids = raw.stringArray ?? s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                store.setRelation(rowID, p.id, ids.filter { store.blocks[$0] != nil }); continue
            default: throw ToolError("Property '\(name)' (\(p.type.rawValue)) is read-only")
            }
            store.setValue(rowID, p.id, value)
        }
    }
}

extension String { var nonEmpty: String? { isEmpty ? nil : self } }
