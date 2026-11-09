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
            ToolSpec(name: "based_guide", description: "How Based works (read once before bigger edits): topics overview, markdown, databases, agents, safety.",
                     inputSchema: .schema(["topic": .str("overview | markdown | databases | agents | safety")], required: ["topic"])),
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
            // Notion-parity page tools
            ToolSpec(name: "update_page", description: "Change a page's title, emoji icon, or remove its icon/cover.",
                     inputSchema: .schema(["page_id": .str("Page id"), "title": .str("New title"), "icon": .str("Emoji icon, or 'none' to remove"), "remove_cover": .boolean("Remove the cover image")], required: ["page_id"])),
            ToolSpec(name: "find_replace", description: "Replace text inside a page's blocks (like editing a passage) without rewriting the whole page. Matches are case-sensitive.",
                     inputSchema: .schema(["page_id": .str("Page id"), "find": .str("Exact text to find"), "replace": .str("Replacement text"), "all": .boolean("Replace every match (default: first only)")], required: ["page_id", "find", "replace"])),
            ToolSpec(name: "move_page", description: "Move a page under another page, or to the workspace root when parent_id is omitted.",
                     inputSchema: .schema(["page_id": .str("Page id"), "parent_id": .str("New parent page id")], required: ["page_id"])),
            ToolSpec(name: "duplicate_page", description: "Duplicate a page with all its content.",
                     inputSchema: .schema(["page_id": .str("Page id")], required: ["page_id"])),
            ToolSpec(name: "trash_page", description: "Move a page (or database row) to the Trash. It can be restored.",
                     inputSchema: .schema(["page_id": .str("Page id")], required: ["page_id"])),
            ToolSpec(name: "restore_page", description: "Restore a page from the Trash.",
                     inputSchema: .schema(["page_id": .str("Page id")], required: ["page_id"])),
            ToolSpec(name: "list_trash", description: "List pages in the Trash.", inputSchema: .schema([:])),
            ToolSpec(name: "backlinks", description: "List pages that link to or mention a page.",
                     inputSchema: .schema(["page_id": .str("Page id")], required: ["page_id"])),
            ToolSpec(name: "set_favorite", description: "Add a page to or remove it from Favorites.",
                     inputSchema: .schema(["page_id": .str("Page id"), "favorite": .boolean("true to add, false to remove")], required: ["page_id", "favorite"])),
            // Notion-parity database tools
            ToolSpec(name: "create_database", description: "Create a database, inline inside a page or as a full page. Properties: name → type (text, number, select, multiSelect, status, date, person, files, checkbox, url, email, phone, relation, place).",
                     inputSchema: .schema(["title": .str("Database title"), "parent_id": .str("Parent page id (omit for workspace root)"), "inline": .boolean("Embed in the parent page (default true when parent_id is given)"), "properties": ["type": "object", "description": "name → property type"], "view": .str("First view layout: table, board, list, gallery, calendar, timeline")], required: ["title"])),
            ToolSpec(name: "update_database", description: "Rename a database, or add, rename, retype or delete properties, or add select options.",
                     inputSchema: .schema(["database_id": .str("Database id"), "title": .str("New title"),
                                           "add_properties": ["type": "object", "description": "name → type"],
                                           "rename_properties": ["type": "object", "description": "old name → new name"],
                                           "change_types": ["type": "object", "description": "name → new type"],
                                           "delete_properties": ["type": "array", "items": ["type": "string"], "description": "Property names to delete"],
                                           "add_options": ["type": "object", "description": "select/status property name → array of option names"]], required: ["database_id"])),
            ToolSpec(name: "list_views", description: "List the views of a database with their layout, filters, sorts and grouping.",
                     inputSchema: .schema(["database_id": .str("Database id")], required: ["database_id"])),
            ToolSpec(name: "create_view", description: "Add a view (table, board, list, gallery, calendar, timeline, map, form) to a database, optionally with filters, sorts and grouping.",
                     inputSchema: .schema(["database_id": .str("Database id"), "type": .str("Layout"), "name": .str("View name"),
                                           "filters": ["type": "array", "description": "[{property, op, value}] — op: equals, notEquals, contains, notContains, isEmpty, isNotEmpty, greater, less, before, after, onOrBefore, onOrAfter"],
                                           "filter_mode": .str("and | or (default and)"),
                                           "sorts": ["type": "array", "description": "[{property, direction: ascending|descending}]"],
                                           "group_by": .str("Property name to group by")], required: ["database_id", "type"])),
            ToolSpec(name: "update_view", description: "Change a view's name, layout, filters, sorts or grouping. Passing filters/sorts replaces them; pass [] to clear.",
                     inputSchema: .schema(["view_id": .str("View id"), "type": .str("Layout"), "name": .str("View name"),
                                           "filters": ["type": "array", "description": "[{property, op, value}]"], "filter_mode": .str("and | or"),
                                           "sorts": ["type": "array", "description": "[{property, direction}]"], "group_by": .str("Property name, or '' to ungroup")], required: ["view_id"])),
            ToolSpec(name: "add_button", description: "Add a Notion-style button block to a page. action: add_page (adds a page to database_id with optional property values, then opens it) or open_page (opens target_page_id).",
                     inputSchema: .schema(["parent_id": .str("Page or block (e.g. a column) to put the button in"), "label": .str("Button text"), "action": .str("add_page | open_page"),
                                           "database_id": .str("Database for add_page"), "properties": ["type": "object", "description": "add_page: property name → value"],
                                           "target_page_id": .str("Page for open_page"), "position": .str("start | end (default end)")], required: ["parent_id", "label", "action"])),
            ToolSpec(name: "delete_view", description: "Delete a database view.",
                     inputSchema: .schema(["view_id": .str("View id")], required: ["view_id"])),
            // BSD-58: agent-facing tools, described like Notion's MCP: what it is for, when to use it, an example.
            ToolSpec(name: "inbox", description: "List what waits for the user: permission requests and questions from coding agents, failed runs, reviews. Use it when the user asks \"what needs me?\". Each item shows its id and answer options; answer with resolve_inbox. Example: inbox {} → \"- [Permission] Run npm test (id: …) options: allow_once=Allow, reject_once=Deny\".",
                     inputSchema: .schema(["all": ["type": "boolean", "description": "Also answered items (default: pending only)"], "limit": .num("Max items (default 30)"), "offset": .num("Skip this many (paging)")])),
            ToolSpec(name: "resolve_inbox", description: "Answer an inbox item for the user — only when the user told you what to answer. Permission requests take one of the item's option ids (allow_once, allow_always, reject_once …); questions take a free-text answer. The first answer wins: an item already answered on another device is not changed. Example: resolve_inbox {\"item_id\": \"…\", \"option\": \"allow_once\"}.",
                     inputSchema: .schema(["item_id": .str("Inbox item id (from inbox)"), "option": .str("Option id for permission requests (allow_once | allow_always | reject_once | …)"), "answer": .str("Free-text answer for questions")], required: ["item_id"])),
            ToolSpec(name: "list_runs", description: "List agent runs (chat turns, coding sessions, scheduled agent runs, sub-agents of the main agent), newest first, with status, kind, tokens and cost. Use it for \"what is running / what failed today?\"; open one with get_run. Example: list_runs {\"status\": \"Running\"}.",
                     inputSchema: .schema(["status": .str("Optional: Planned | Running | Waiting | Needs you | Done | Failed | Cancelled"), "kind": .str("Optional: Chat | Session | Schedule | Subagent | Main"), "parent_id": .str("Optional: only sub-runs of this run"), "project": .str("Optional: project id or name"), "limit": .num("Max runs (default 30)"), "offset": .num("Skip this many (paging)")])),
            ToolSpec(name: "list_projects", description: "List the user's projects (Active, Paused, Done) with goal, folder and how many chats/runs belong to each. A project groups pages, chats, coding sessions and runs around one goal. Use get_project for details.",
                     inputSchema: .schema(["status": .str("Optional: Active | Paused | Done"), "limit": .num("Max projects (default 50)"), "offset": .num("Skip this many (paging)")])),
            ToolSpec(name: "get_project", description: "Read a project: goal, status, folder, its overview page (Status / Next steps / Latest updates), pages, chats and recent runs. Accepts the id or the name. Example: get_project {\"project\": \"Publit\"}.",
                     inputSchema: .schema(["project": .str("Project id or name")], required: ["project"])),
            ToolSpec(name: "create_project", description: "Create a project (a row in Projects with an overview page: Status, Next steps, Latest updates). Use it when the user starts a new goal that will have several chats, runs or pages; check list_projects first so you don't create a duplicate.",
                     inputSchema: .schema(["name": .str("Short project name"), "goal": .str("One sentence: what done looks like"), "folder": .str("Optional working folder for coding sessions"), "status": .str("Optional: Active (default) | Paused | Done")], required: ["name"])),
            ToolSpec(name: "update_project_status", description: "Post a short dated update to a project's \"Latest updates\" section, optionally changing its status. Use it after finishing something worth knowing in a project.",
                     inputSchema: .schema(["project": .str("Project id or name"), "update": .str("What happened, one or two sentences"), "status": .str("Optional: Active | Paused | Done")], required: ["project", "update"])),
            ToolSpec(name: "get_run", description: "Read one run: its fields, result, short protocol and direct sub-runs.",
                     inputSchema: .schema(["run_id": .str("Run id")], required: ["run_id"])),
        ] + Self.captureSpecs + hostSpecs + externalSpecs
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

    // MARK: Permissions (BSD-50)

    /// The permission call for a tool of this toolbox (Based tools, host tools such as sub-agents, MCP tools).
    public func permissionCall(_ name: String, _ args: JSONValue) -> PermissionCall {
        if isExternal(name) { return PermissionCall(tool: name, argument: nil, category: .external) }
        if isHost(name) { return PermissionCall(tool: "based." + name, argument: nil, category: .read) }
        return .based(name, args)
    }

    /// Checks a call against `permissions`. Returns nil when it may run, else the result to hand to the model.
    /// `approve` asks the user; without it (no approval prompt in this place yet) a mode's "ask" lets ordinary edits
    /// run as before, while rule-based asks and the "always ask" list are refused with an explanation.
    public func authorize(_ name: String, _ args: JSONValue, permissions: AgentPermissions?,
                          approve: (@Sendable (PermissionCall, PermissionVerdict) async -> Bool)? = nil) async -> ToolResult? {
        guard let permissions else { return nil }
        let call = permissionCall(name, args)
        let v = permissions.decide(call)
        switch v.effect {
        case .allow:
            return nil
        case .deny:
            return ToolResult(text: "Not permitted: \(call.tool) is blocked (\(v.reason)). Don't retry it; tell the user what you wanted to do so they can do it or change the permissions.", isError: true)
        case .ask:
            if let approve {
                return await approve(call, v) ? nil : ToolResult(text: "The user declined \(call.tool).", isError: true)
            }
            if call.alwaysAsks || v.reason.hasPrefix("rule") {
                return ToolResult(text: "Needs the user's approval: \(call.tool) (\(v.reason)). There is no approval prompt here — ask the user to do it or to allow it in the permission rules.", isError: true)
            }
            return nil
        }
    }

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

    private func project(_ a: JSONValue) throws -> AgentProject {
        let key = try req(a, "project")
        if let p = brain.project(key) ?? brain.project(named: key) { return p }
        throw ToolError("No project '\(key)'. Use list_projects.")
    }

    static func runLine(_ r: AgentRun) -> String {
        var s = "- [\(r.status.rawValue)] \(r.title) · \(r.kind.rawValue)"
        if !r.engine.isEmpty { s += " · \(r.engine)" }
        s += " · \(r.tokens) tokens"
        if r.cost > 0 { s += String(format: " · %.2f €", r.cost) }
        s += " · started \(ISO8601DateFormatter().string(from: r.startedAt)) (id: \(r.id))"
        return s
    }

    /// BSD-58: one page of a list plus a "more" hint (agents page with offset instead of getting everything).
    static func page<T>(_ items: [T], _ a: JSONValue, defaultLimit: Int) -> ([T], String) {
        let limit = max(1, a["limit"]?.int ?? defaultLimit), offset = max(0, a["offset"]?.int ?? 0)
        let slice = Array(items.dropFirst(offset).prefix(limit))
        let rest = items.count - offset - slice.count
        return (slice, rest > 0 ? "\n… \(rest) more (offset: \(offset + slice.count))" : "")
    }

    private func inboxLine(_ i: InboxItem) -> String {
        var s = "- [\(i.kind.rawValue)] \(i.title) (id: \(i.id))"
        if i.status != .pending { s += " · \(i.status.rawValue)" + (i.decision.map { ": \($0)" } ?? "") }
        if let sid = i.sessionID { s += " · session \(brain.sessions().first { $0.id == sid }?.title ?? sid)" }
        if !i.options.isEmpty { s += " · options: " + i.options.joined(separator: ", ") }
        let d = i.detail.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if !d.isEmpty { s += "\n  " + String(d.prefix(200)) }
        return s
    }

    /// Decision and status for an answer to `item`. Permission requests need one of their option ids (approved when
    /// it allows); questions and notices take free text.
    static func inboxDecision(_ item: InboxItem, option: String?, answer: String?) throws -> (String, InboxItem.Status) {
        let ids = item.options.map { $0.split(separator: "=", maxSplits: 1).first.map(String.init) ?? $0 }
        if let option = option?.trimmingCharacters(in: .whitespaces), !option.isEmpty {
            if !ids.isEmpty, !ids.contains(option) { throw ToolError("Unknown option '\(option)'. Options: \(ids.joined(separator: ", "))") }
            let allows = option.hasPrefix("allow") || option == "approve" || option == "approved" || option == "yes"
            return (option, allows ? .approved : .rejected)
        }
        if let answer = answer?.trimmingCharacters(in: .whitespacesAndNewlines), !answer.isEmpty, item.kind != .permission {
            return (answer, .done)
        }
        throw ToolError(item.kind == .permission ? "Permission requests need an option: \(ids.isEmpty ? "allow_once, reject_once" : ids.joined(separator: ", "))" : "Give an answer.")
    }

    private func dispatch(_ name: String, _ a: JSONValue) throws -> String {
        switch name {
        case "based_guide":
            let t = a["topic"]?.string ?? "overview"
            return BasedGuide.doc(t) ?? "Unknown topic. Topics: " + BasedGuide.topics.map(\.name).joined(separator: ", ")
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
            let all = brain.inbox(pendingOnly: a["all"]?.bool != true).sorted { $0.createdAt > $1.createdAt }
            let (page, more) = Self.page(all, a, defaultLimit: 30)
            if page.isEmpty { return a["all"]?.bool == true ? "Inbox is empty." : "Nothing waits for the user — the inbox is empty." }
            return page.map(inboxLine).joined(separator: "\n") + more
        case "resolve_inbox":
            let iid = try req(a, "item_id")
            guard let item = brain.inbox().first(where: { $0.id == iid }) else { throw ToolError("No inbox item \(iid). Use inbox.") }
            guard item.status == .pending else { return "Already answered (\(item.status.rawValue): \(item.decision ?? "")) — nothing changed." }
            // BSD-59: memory suggestions are confirmed by the user in the app; an agent may only dismiss one.
            if item.kind == .memory {
                guard a["option"]?.string == BrainStore.memoryDismissOption else {
                    throw ToolError("Memory suggestions are saved only when the user confirms them in the Inbox. You can dismiss it (option: \(BrainStore.memoryDismissOption)).")
                }
                brain.answerMemorySuggestion(iid, save: false, device: "mcp")
                return "Dismissed the memory suggestion \"\(item.title)\"."
            }
            let (decision, status) = try Self.inboxDecision(item, option: a["option"]?.string, answer: a["answer"]?.stringValue)
            guard brain.resolveInbox(iid, decision: decision, status: status, device: "mcp") else {
                return "Already answered on another device — nothing changed."
            }
            return "Answered \"\(item.title)\": \(decision) (\(status.rawValue))."
        case "list_runs":
            var f = RunFilter(parentID: a["parent_id"]?.string)
            if let st = a["status"]?.string, !st.isEmpty {
                guard let v = AgentRun.Status.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(st) == .orderedSame }) else { throw ToolError("Unknown status '\(st)'") }
                f.statuses = [v]
            }
            if let k = a["kind"]?.string, !k.isEmpty {
                guard let v = AgentRun.Kind.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(k) == .orderedSame }) else { throw ToolError("Unknown kind '\(k)'") }
                f.kinds = [v]
            }
            var rs = brain.runs(f)
            if let key = a["project"]?.string, !key.isEmpty { let p = try project(a); rs = rs.filter { $0.projectID == p.id } }
            let (page, more) = Self.page(rs, a, defaultLimit: 30)
            return page.isEmpty ? "No runs." : page.map(Self.runLine).joined(separator: "\n") + more
        case "list_projects":
            var ps = brain.projects()
            if let st = a["status"]?.string, !st.isEmpty {
                guard let v = AgentProject.Status.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(st) == .orderedSame }) else { throw ToolError("Unknown status '\(st)'") }
                ps = ps.filter { $0.status == v }
            }
            if ps.isEmpty { return "No projects yet. create_project starts one." }
            let sessions = brain.sessions(), runs = brain.runs()
            let (page, more) = Self.page(ps, a, defaultLimit: 50)
            return page.map { p in
                var line = "- \(p.name) [\(p.status.rawValue)] (id: \(p.id))"
                if !p.goal.isEmpty { line += " — \(p.goal)" }
                if !p.folder.isEmpty { line += " · folder \(p.folder)" }
                line += " · \(sessions.filter { $0.projectID == p.id }.count) chats/sessions, \(runs.filter { $0.projectID == p.id }.count) runs"
                return line
            }.joined(separator: "\n") + more
        case "create_project":
            let name = try req(a, "name").trimmingCharacters(in: .whitespacesAndNewlines)
            if let existing = brain.project(named: name) { return "A project named \(existing.name) already exists (id: \(existing.id)) — nothing created." }
            var status = AgentProject.Status.active
            if let st = a["status"]?.string, !st.isEmpty {
                guard let v = AgentProject.Status.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(st) == .orderedSame }) else { throw ToolError("Unknown status '\(st)'") }
                status = v
            }
            let id = brain.createProject(name: name, goal: a["goal"]?.stringValue ?? "", folder: a["folder"]?.stringValue ?? "", status: status)
            return "Created project [\(name)](\(PageLink.url(id))) (id: \(id), \(status.rawValue))."
        case "get_project":
            let p = try project(a)
            var out = "# \(p.name)\nStatus: \(p.status.rawValue)\nid: \(p.id)"
            if !p.goal.isEmpty { out += "\nGoal: \(p.goal)" }
            if !p.folder.isEmpty { out += "\nFolder: \(p.folder)" }
            let body = brain.body(of: p.id)
            if !body.isEmpty { out += "\n\n" + body }
            if !p.pageIDs.isEmpty { out += "\n\nPages:\n" + p.pageIDs.map { "- \(store.title(of: $0)) (id: \($0))" }.joined(separator: "\n") }
            let chats = brain.sessions(inProject: p.id)
            if !chats.isEmpty { out += "\n\nChats and sessions:\n" + chats.prefix(20).map { "- [\($0.status.rawValue)] \($0.title) (id: \($0.id))" }.joined(separator: "\n") }
            let runs = brain.runs(inProject: p.id)
            if !runs.isEmpty { out += "\n\nRecent runs:\n" + runs.prefix(10).map(Self.runLine).joined(separator: "\n") }
            return out
        case "update_project_status":
            let p = try project(a)
            var status: AgentProject.Status?
            if let st = a["status"]?.string, !st.isEmpty {
                guard let v = AgentProject.Status.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(st) == .orderedSame }) else { throw ToolError("Unknown status '\(st)'") }
                status = v
            }
            brain.postProjectUpdate(p.id, try req(a, "update"), status: status)
            return "Posted update to \(p.name)" + (status.map { " (status \($0.rawValue))" } ?? "") + "."
        case "get_run":
            let id = try req(a, "run_id")
            guard let r = brain.run(id) else { throw ToolError("No run with id \(id)") }
            var out = Self.runLine(r)
            if let p = r.parentID { out += "\nParent run: \(p)" }
            if let s = r.sessionID { out += "\nSession: \(s)" }
            if let ag = r.agentID { out += "\nAgent: \(ag)" }
            if !r.model.isEmpty { out += "\nModel: \(r.model)" }
            // BSD-54: the CLI's `based sandbox shell` reads this line.
            let sb = brain.sandboxInfo(run: id).reference
            if !sb.isEmpty { out += "\nSandbox: \(sb)" }
            if let e = r.endedAt { out += "\nEnded: \(ISO8601DateFormatter().string(from: e))" }
            if !r.result.isEmpty { out += "\n\nResult:\n\(r.result)" }
            let log = brain.body(of: id)
            if !log.isEmpty { out += "\n\nProtocol:\n\(log)" }
            let kids = brain.children(ofRun: id)
            if !kids.isEmpty { out += "\n\nSub-runs:\n" + kids.map(Self.runLine).joined(separator: "\n") }
            return out
        case "update_page":
            let id = try page(a)
            if let t = a["title"]?.string { store.setText(id, RichText(t)) }
            if let i = a["icon"]?.string { store.setPageIcon(id, i.lowercased() == "none" || i.isEmpty ? nil : .emoji(i)) }
            if a["remove_cover"]?.bool == true { store.setPageCover(id, nil) }
            return "Updated \(id)"
        case "find_replace":
            let id = try page(a); let find = try req(a, "find"); let rep = a["replace"]?.string ?? ""
            let all = a["all"]?.bool == true
            var count = 0
            var stack = store.contentBlocks(of: id).map(\.id).reversed() as [RecordID]
            while let bid = stack.popLast() {
                guard let b = store.blocks[bid] else { continue }
                let text = b.text.plainText
                if text.contains(find), !(b.type == .page || b.type == .databasePage || b.type == .databaseInline) {
                    let next = all ? text.replacingOccurrences(of: find, with: rep) : text.replacingFirst(find, with: rep)
                    count += all ? text.components(separatedBy: find).count - 1 : 1
                    store.setText(bid, RichText(next))
                    if !all { break }
                }
                if b.type != .page && b.type != .databasePage { stack.append(contentsOf: store.contentBlocks(of: bid).map(\.id).reversed()) }
            }
            return count == 0 ? "No match for that text in \(id)." : "Replaced \(count) match(es) in \(id)."
        case "move_page":
            let id = try page(a)
            let parent: ParentRef = try a["parent_id"]?.stringValue.map { pid in
                guard store.blocks[pid] != nil else { throw ToolError("No page \(pid)") }; return .block(pid) } ?? .workspace
            store.movePage(id, to: parent)
            return "Moved \(id)"
        case "duplicate_page":
            let id = try page(a)
            guard let copy = store.duplicatePages([id]).first else { throw ToolError("Could not duplicate \(id)") }
            return "Duplicated as \(copy) [link: \(PageLink.url(copy))]"
        case "trash_page":
            let id = try page(a)
            return store.trashPages([id]).isEmpty ? "Could not trash \(id) (protected or already trashed)." : "Moved \(id) to Trash."
        case "restore_page":
            let id = try req(a, "page_id"); store.restorePages([id]); return "Restored \(id)."
        case "list_trash":
            return store.trashedPages().map { "- \($0.title.nonEmpty ?? "Untitled") [id: \($0.id)]" }.joined(separator: "\n").nonEmpty ?? "Trash is empty."
        case "backlinks":
            let id = try page(a)
            return store.backlinks(to: id, waitForIndex: true).map { "- \(store.title(of: $0)) [id: \($0)]" }.joined(separator: "\n").nonEmpty ?? "No backlinks."
        case "set_favorite":
            let id = try page(a); store.setFavorite([id], a["favorite"]?.bool ?? true); return "Updated favorite for \(id)."
        case "create_database":
            let parentID = a["parent_id"]?.stringValue
            if let parentID, store.blocks[parentID] == nil { throw ToolError("No page \(parentID)") }
            let parent: ParentRef = parentID.map { .block($0) } ?? .workspace
            let vt = ViewType(rawValue: a["view"]?.string ?? "") ?? .table
            let made = store.createDatabase(title: RichText(try req(a, "title")), in: parent, inline: a["inline"]?.bool ?? (parentID != nil), viewType: vt, sampleRows: 0)
            var added: [String] = []
            for (name, t) in a["properties"]?.object ?? [:] {
                guard let type = Self.propertyType(t.stringValue ?? "") else { throw ToolError("Unknown property type '\(t.stringValue ?? "")' for \(name)") }
                if store.addProperty(to: made.databaseID, name: name, type: type) != nil { added.append(name) }
            }
            return "Created database \(made.databaseID) (block \(made.blockID), view \(made.viewID))" + (added.isEmpty ? "" : " with properties: " + added.joined(separator: ", "))
        case "update_database":
            let db = try database(a)
            var log: [String] = []
            if let t = a["title"]?.string { store.setDatabaseTitle(db.id, RichText(t)); log.append("renamed") }
            for (name, t) in a["add_properties"]?.object ?? [:] {
                guard let type = Self.propertyType(t.stringValue ?? "") else { throw ToolError("Unknown type for \(name)") }
                _ = store.addProperty(to: db.id, name: name, type: type); log.append("added \(name)")
            }
            for (old, new) in a["rename_properties"]?.object ?? [:] {
                let p = try property(db, old); store.renameProperty(db.id, p.id, to: new.stringValue ?? old); log.append("renamed \(old)")
            }
            for (name, t) in a["change_types"]?.object ?? [:] {
                let p = try property(db, name)
                guard let type = Self.propertyType(t.stringValue ?? "") else { throw ToolError("Unknown type for \(name)") }
                store.changePropertyType(db.id, p.id, to: type); log.append("retyped \(name)")
            }
            for name in a["delete_properties"]?.stringArray ?? [] {
                let p = try property(db, name)
                guard p.type != .title else { throw ToolError("The title property cannot be deleted") }
                store.deleteProperty(db.id, p.id); log.append("deleted \(name)")
            }
            for (name, opts) in a["add_options"]?.object ?? [:] {
                let p = try property(db, name)
                for o in opts.stringArray ?? [] { _ = store.addOption(db.id, p.id, name: o) }
                log.append("options for \(name)")
            }
            return log.isEmpty ? "Nothing to change." : "Updated database: " + log.joined(separator: ", ")
        case "list_views":
            let db = try database(a)
            let views = store.views(forBlock: db.blockID)
            return views.map { v in
                var line = "- \(v.name) [view_id: \(v.id)] \(v.type.rawValue)"
                if let f = v.filter, !f.isEmpty { line += "; filter(\(f.combinator.rawValue)): " + f.items.map { describe($0, db) }.joined(separator: ", ") }
                if let s = v.sorts, !s.isEmpty { line += "; sort: " + s.map { "\(db.property($0.propertyID)?.name ?? "?") \($0.ascending ? "asc" : "desc")" }.joined(separator: ", ") }
                if let g = v.groupBy { line += "; group by \(db.property(g.propertyID)?.name ?? "?")" }
                return line
            }.joined(separator: "\n").nonEmpty ?? "(no views)"
        case "create_view":
            let db = try database(a)
            guard let type = ViewType(rawValue: try req(a, "type")) else { throw ToolError("Unknown layout") }
            guard let vid = store.addView(to: db.blockID, type: type, name: a["name"]?.string) else { throw ToolError("Could not add view") }
            try applyViewArgs(vid, db, a)
            return "Created view \(vid)."
        case "update_view":
            let vid = try req(a, "view_id")
            guard let v = store.views[vid], let db = store.databases[v.databaseID] else { throw ToolError("No view \(vid)") }
            try applyViewArgs(vid, db, a)
            return "Updated view \(vid)."
        case "add_button":
            let parent = try req(a, "parent_id")
            guard store.blocks[parent] != nil else { throw ToolError("No block \(parent)") }
            var action: ButtonAction
            switch try req(a, "action") {
            case "add_page":
                let db = try database(a)
                var values: [String: PropertyValue] = [:]
                for (name, raw) in a["properties"]?.object ?? [:] {
                    let p = try property(db, name)
                    if let v = try propertyValue(raw, p, db) { values[p.id] = v }
                }
                action = ButtonAction(kind: .addPage, targetID: db.id, values: values.isEmpty ? nil : values)
            case "open_page":
                let t = try req(a, "target_page_id"); guard store.blocks[t] != nil else { throw ToolError("No page \(t)") }
                action = ButtonAction(kind: .openPage, targetID: t)
            default: throw ToolError("action must be add_page or open_page")
            }
            var props = BlockProps(); props.buttonLabel = try req(a, "label"); props.buttonAction = action
            let pos: InsertPosition = a["position"]?.string == "start" ? .start : .end
            let id = store.insertBlock(.button, props: props, in: .block(parent), at: pos)
            return "Added button \(id)"
        case "delete_view":
            let vid = try req(a, "view_id"); guard store.views[vid] != nil else { throw ToolError("No view \(vid)") }
            store.deleteView(vid); return "Deleted view \(vid)."
        case "capture", "list_captures", "file_capture":   // BSD-63 (Brain/CaptureStore.swift)
            return try captureTool(name, a)
        default: throw ToolError("Unknown tool \(name)")
        }
    }

    private func page(_ a: JSONValue) throws -> RecordID {
        let id = try req(a, "page_id")
        guard store.blocks[id] != nil else { throw ToolError("No page \(id)") }
        return id
    }

    private func property(_ db: Database, _ name: String) throws -> PropertySchema {
        if db.titleProperty.name.caseInsensitiveCompare(name) == .orderedSame { return db.titleProperty }
        guard let p = db.properties.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else { throw ToolError("No property '\(name)'") }
        return p
    }

    static func propertyType(_ s: String) -> PropertyType? {
        let k = s.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        if let t = PropertyType.allCases.first(where: { $0.rawValue.lowercased() == k }) { return t }
        switch k {
        case "richtext", "string": return .text
        case "multiselect", "tags": return .multiSelect
        case "people": return .person
        case "file": return .files
        case "link": return .url
        default: return nil
        }
    }

    private func describe(_ item: FilterItem, _ db: Database) -> String {
        switch item {
        case .group(let g): return "(" + g.items.map { describe($0, db) }.joined(separator: " \(g.combinator.rawValue) ") + ")"
        case .condition(let c):
            let p = db.property(c.propertyID)
            let v: String
            switch c.value {
            case .text(let t)?: v = t
            case .number(let n)?: v = String(n)
            case .bool(let b)?: v = String(b)
            case .date(let d)?: v = ISO8601DateFormatter().string(from: d)
            case .relative(let r)?: v = r.rawValue
            case .options(let ids)?: v = ids.map { p?.option($0)?.name ?? $0 }.joined(separator: "|")
            case nil: v = ""
            }
            return "\(p?.name ?? "?") \(c.op.rawValue) \(v)".trimmingCharacters(in: .whitespaces)
        }
    }

    /// Filters / sorts / grouping / name / layout from tool arguments, applied to one view.
    private func applyViewArgs(_ vid: RecordID, _ db: Database, _ a: JSONValue) throws {
        var filter: FilterGroup?? = nil
        if let fs = a["filters"]?.array {
            var items: [FilterItem] = []
            for f in fs {
                let p = try property(db, f["property"]?.stringValue ?? "")
                guard let op = FilterOp(rawValue: f["op"]?.stringValue ?? "equals") else { throw ToolError("Unknown filter op '\(f["op"]?.stringValue ?? "")'") }
                items.append(.condition(FilterCondition(propertyID: p.id, op: op, value: try filterValue(f["value"], p, db))))
            }
            let comb = Combinator(rawValue: a["filter_mode"]?.string ?? "and") ?? .and
            filter = .some(items.isEmpty ? nil : FilterGroup(combinator: comb, items: items))
        }
        var sorts: [SortRule]?? = nil
        if let ss = a["sorts"]?.array {
            sorts = .some(try ss.map { s in
                let p = try property(db, s["property"]?.stringValue ?? "")
                return SortRule(propertyID: p.id, ascending: !(s["direction"]?.stringValue ?? "").lowercased().hasPrefix("desc"))
            }.nilIfEmpty)
        }
        var group: GroupRule?? = nil
        if let g = a["group_by"]?.string { group = .some(g.isEmpty ? nil : GroupRule(propertyID: try property(db, g).id)) }
        let type = a["type"]?.string.flatMap { ViewType(rawValue: $0) }
        let name = a["name"]?.string
        store.updateView(vid, name: "Edit view") { v in
            if let filter { v.filter = filter }
            if let sorts { v.sorts = sorts }
            if let group { v.groupBy = group }
            if let type { v.type = type }
            if let name, !name.isEmpty { v.name = name }
        }
    }

    /// One property value from a tool argument (select/status options must exist; they are matched by name).
    private func propertyValue(_ raw: JSONValue, _ p: PropertySchema, _ db: Database) throws -> PropertyValue? {
        let s = raw.stringValue ?? raw.text
        func opt(_ n: String) throws -> String {
            guard let o = p.options?.first(where: { $0.name.caseInsensitiveCompare(n) == .orderedSame }) else { throw ToolError("No option '\(n)' in \(p.name)") }
            return o.id
        }
        switch p.type {
        case .text: return .text(RichText(s))
        case .number: return Double(s).map { .number($0) }
        case .checkbox: return .checkbox(["true", "yes", "1"].contains(s.lowercased()))
        case .url: return .url(s)
        case .select: return .select(try opt(s))
        case .status: return .status(try opt(s))
        case .multiSelect: return .multiSelect(try (raw.stringArray ?? [s]).map(opt))
        case .date: return DateParsing.parse(s).map { .date($0) }
        default: throw ToolError("Property '\(p.name)' can't be preset")
        }
    }

    private func filterValue(_ raw: JSONValue?, _ p: PropertySchema, _ db: Database) throws -> FilterValue? {
        guard let raw else { return nil }
        let s = raw.stringValue ?? raw.text
        switch p.type {
        case .number: return Double(s).map { .number($0) }
        case .checkbox: return .bool(["true", "yes", "1", "checked"].contains(s.lowercased()))
        case .date, .createdTime, .lastEditedTime:
            if let r = RelativeDate(rawValue: s) { return .relative(r) }
            return DateParsing.parse(s).map { .date($0.start) }
        case .select, .status, .multiSelect:
            let names = raw.stringArray ?? [s]
            return .options(try names.map { n in
                guard let o = p.options?.first(where: { $0.name.caseInsensitiveCompare(n) == .orderedSame }) else { throw ToolError("No option '\(n)' in \(p.name)") }
                return o.id
            })
        case .relation: return .options(raw.stringArray ?? [s])
        default: return .text(s)
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

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
    func replacingFirst(_ target: String, with rep: String) -> String {
        guard let r = range(of: target) else { return self }
        return replacingCharacters(in: r, with: rep)
    }
}
extension Array { var nilIfEmpty: [Element]? { isEmpty ? nil : self } }
