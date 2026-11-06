import Foundation
import BasedCore

public struct NotionImportOptions: Sendable, Equatable {
    /// Fetch the page content of database rows (one request per row).
    public var rowContent = true
    /// Also import databases that relation properties point to (so relations resolve).
    public var followRelations = true
    /// Copy Notion-hosted files and images (their URLs expire after an hour).
    public var downloadFiles = true
    /// Import subpages of imported pages.
    public var subpages = true
    public var maxConcurrent = 3
    public init() {}
}

/// Everything fetched from the API, before mapping. Pure data, so the mapping is testable offline.
public struct NotionSnapshot: Sendable {
    public enum Root: Hashable, Sendable { case page(String), database(String) }
    public var roots: [Root] = []
    public var pages: [String: JSONValue] = [:]
    /// Child blocks of a page or block, in order.
    public var children: [String: [JSONValue]] = [:]
    public var databases: [String: JSONValue] = [:]
    public var dataSources: [String: JSONValue] = [:]
    /// Views of a database (full view objects), in Notion's order.
    public var views: [String: [JSONValue]] = [:]
    /// Row page ids of a data source, in the order of its main view when known.
    public var rows: [String: [String]] = [:]
    /// Complete values of truncated properties (relations / people with more than 25 entries): page → property id → items.
    public var propertyItems: [String: [String: [JSONValue]]] = [:]
    /// Downloaded files: `fileKey(url)` → local copy.
    public var files: [String: URL] = [:]
    public var users: [String: String] = [:]
    public var warnings: [String] = []
    public init() {}

    /// Signed Notion file URLs change on every request; the path identifies the file.
    public static func fileKey(_ url: String) -> String {
        guard var c = URLComponents(string: url) else { return url }
        c.query = nil; c.fragment = nil
        return c.string ?? url
    }

    /// Normalized id (dashed lowercase).
    static func id(_ v: JSONValue?) -> String? { v?.string.flatMap { ImportIDs.notion($0) ?? $0 } }
}

/// Walks pages, blocks, databases, data sources, views and rows reachable from the targets.
public final class NotionCrawler: @unchecked Sendable {
    let client: NotionClient
    let options: NotionImportOptions
    let fileDir: URL
    public var onProgress: (@Sendable (_ done: Int, _ total: Int, _ message: String) -> Void)?

    enum Job: Hashable {
        case resolve(String)
        case search
        case page(String)
        case children(String)
        case database(String)
        case dataSource(String)
        case rows(String)
        case views(String)
        case propertyItem(String, String)
        case download(String, String?)
        case users
    }

    struct Outcome {
        var pages: [JSONValue] = []
        var children: [(String, [JSONValue])] = []
        var databases: [JSONValue] = []
        var dataSources: [JSONValue] = []
        var views: [(String, [JSONValue])] = []
        var rows: [(String, [String])] = []
        var viewOrders: [(String, [String])] = []
        var propertyItems: [(String, String, [JSONValue])] = []
        var files: [(String, URL)] = []
        var users: [(String, String)] = []
        var roots: [NotionSnapshot.Root] = []
        var searchResults: [JSONValue] = []
        var warnings: [String] = []
        var next: [Job] = []
    }

    private var snap = NotionSnapshot()
    private var queue: [Job] = []
    private var seen: Set<Job> = []
    private var done = 0
    private var viewOrders: [String: [String]] = [:]

    public init(client: NotionClient, options: NotionImportOptions = NotionImportOptions(), fileDirectory: URL) {
        self.client = client
        self.options = options
        self.fileDir = fileDirectory
    }

    /// Crawls the targets (or everything shared with the integration when `targets` is empty).
    public func crawl(_ targets: [NotionTarget]) async throws -> NotionSnapshot {
        enqueue(.users)
        if targets.isEmpty { enqueue(.search) } else { targets.forEach { enqueue(.resolve($0.id)) } }
        while !queue.isEmpty {
            if Task.isCancelled { throw NotionAPIError.cancelled }
            let batch = Array(queue.prefix(max(1, options.maxConcurrent)))
            queue.removeFirst(batch.count)
            let outcomes = try await withThrowingTaskGroup(of: Outcome.self) { group -> [Outcome] in
                for job in batch { group.addTask { try await self.run(job) } }
                var out: [Outcome] = []
                for try await o in group { out.append(o) }
                return out
            }
            for o in outcomes { merge(o) }
            done += batch.count
            onProgress?(done, done + queue.count, describe(batch.first))
        }
        // Row order: the main view's order first, then the rest in query order.
        for (ds, ids) in snap.rows {
            guard let order = viewOrders[ds], !order.isEmpty else { continue }
            let set = Set(ids)
            var out = order.filter { set.contains($0) }
            let placed = Set(out)
            out += ids.filter { !placed.contains($0) }
            snap.rows[ds] = out
        }
        return snap
    }

    private func describe(_ job: Job?) -> String {
        switch job {
        case .page(let id)?: return "Page " + (snap.pages[id].map(NotionAPIMapper.title(of:)) ?? "")
        case .children?: return "Reading page content…"
        case .database?, .dataSource?: return "Reading databases…"
        case .rows?: return "Reading database rows…"
        case .views?: return "Reading views…"
        case .download?: return "Downloading files…"
        case .search?: return "Searching pages shared with the integration…"
        default: return "Reading Notion…"
        }
    }

    private func enqueue(_ job: Job) {
        guard seen.insert(job).inserted else { return }
        queue.append(job)
    }

    private func merge(_ o: Outcome) {
        for p in o.pages { if let id = NotionSnapshot.id(p["id"]) { snap.pages[id] = p } }
        for (id, c) in o.children { snap.children[id] = c }
        for d in o.databases { if let id = NotionSnapshot.id(d["id"]) { snap.databases[id] = d } }
        for d in o.dataSources { if let id = NotionSnapshot.id(d["id"]) { snap.dataSources[id] = d } }
        for (id, v) in o.views { snap.views[id] = v }
        for (id, r) in o.rows { snap.rows[id] = r }
        for (id, r) in o.viewOrders { viewOrders[id] = r }
        for (p, prop, items) in o.propertyItems { snap.propertyItems[p, default: [:]][prop] = items }
        for (k, u) in o.files { snap.files[k] = u }
        for (id, n) in o.users { snap.users[id] = n }
        for r in o.roots where !snap.roots.contains(r) { snap.roots.append(r) }
        snap.warnings += o.warnings
        if !o.searchResults.isEmpty { planSearch(o.searchResults) }
        o.next.forEach(enqueue)
    }

    // MARK: Jobs

    private func run(_ job: Job) async throws -> Outcome {
        var o = Outcome()
        do {
            switch job {
            case .users:
                for u in (try? await client.paginateGet("users")) ?? [] {
                    if let id = NotionSnapshot.id(u["id"]), let n = u["name"]?.string ?? u["person"]?["email"]?.string { o.users.append((id, n)) }
                }
            case .search:
                o.searchResults = try await client.paginatePost("search")
                if o.searchResults.isEmpty { o.warnings.append("Nothing is shared with the integration yet. In Notion, open a page → ••• → Connections → add the integration.") }
            case .resolve(let id):
                try await resolve(id, &o)
            case .page(let id):
                let p = try await client.get("pages/\(id)")
                o.pages.append(p)
                files(ofPage: p, &o)
                o.next.append(.children(id))
            case .children(let id):
                let blocks = try await client.paginateGet("blocks/\(id)/children")
                o.children.append((id, blocks))
                for b in blocks { follow(block: b, &o) }
            case .database(let id):
                let d = try await client.get("databases/\(id)")
                o.databases.append(d)
                files(ofPage: d, &o)
                for ds in d["data_sources"]?.array ?? [] { if let dsid = NotionSnapshot.id(ds["id"]) { o.next.append(.dataSource(dsid)) } }
                o.next.append(.views(id))
            case .dataSource(let id):
                let ds = try await client.get("data_sources/\(id)")
                o.dataSources.append(ds)
                o.next.append(.rows(id))
                if let owner = NotionSnapshot.id(ds["parent"]?["database_id"]) { o.next.append(.database(owner)) }
                if options.followRelations {
                    for (_, prop) in ds["properties"]?.object ?? [:] where prop["type"]?.string == "relation" {
                        if let target = NotionSnapshot.id(prop["relation"]?["data_source_id"]) { o.next.append(.dataSource(target)) }
                        else if let db = NotionSnapshot.id(prop["relation"]?["database_id"]) { o.next.append(.database(db)) }
                    }
                }
            case .rows(let id):
                let pages = try await client.paginatePost("data_sources/\(id)/query")
                o.rows.append((id, pages.compactMap { NotionSnapshot.id($0["id"]) }))
                for p in pages {
                    o.pages.append(p)
                    files(ofPage: p, &o)
                    guard let pid = NotionSnapshot.id(p["id"]) else { continue }
                    if options.rowContent { o.next.append(.children(pid)) }
                    for (_, v) in p["properties"]?.object ?? [:] where v["has_more"]?.bool == true {
                        if let prop = v["id"]?.string { o.next.append(.propertyItem(pid, prop)) }
                    }
                }
            case .views(let dbID):
                try await views(dbID, &o)
            case .propertyItem(let page, let prop):
                // Property ids come URL-encoded ("%3AeAg"); encode anything else that isn't path-safe.
                let enc = prop.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "%-._~"))) ?? prop
                let items = try await client.paginateGet("pages/\(page)/properties/\(enc)")
                o.propertyItems.append((page, prop, items))
            case .download(let url, let name):
                guard let u = URL(string: url) else { break }
                let local = try await client.download(u, to: fileDir, name: name)
                o.files.append((NotionSnapshot.fileKey(url), local))
            }
        } catch NotionAPIError.unauthorized(let m) {
            throw NotionAPIError.unauthorized(m)
        } catch NotionAPIError.cancelled {
            throw NotionAPIError.cancelled
        } catch is CancellationError {
            throw NotionAPIError.cancelled
        } catch {
            o.warnings.append("\(describeJob(job)): \(error.localizedDescription)")
        }
        return o
    }

    private func describeJob(_ job: Job) -> String {
        switch job {
        case .page(let id): return "Page \(id)"
        case .children(let id): return "Content of \(id)"
        case .database(let id): return "Database \(id)"
        case .dataSource(let id): return "Data source \(id)"
        case .rows(let id): return "Rows of \(id)"
        case .views(let id): return "Views of \(id)"
        case .propertyItem(let p, let prop): return "Property \(prop) of \(p)"
        case .download(let u, _): return "File \(URL(string: u)?.lastPathComponent ?? u)"
        case .resolve(let id): return "Link \(id)"
        case .search: return "Search"
        case .users: return "Users"
        }
    }

    /// A link can point at a page, a database or a data source.
    private func resolve(_ id: String, _ o: inout Outcome) async throws {
        var lastError: Error?
        do {
            let p = try await client.get("pages/\(id)")
            o.pages.append(p); files(ofPage: p, &o)
            o.roots.append(.page(id)); o.next.append(.children(id))
            // A row opened directly: bring its database's schema so properties map.
            return
        } catch NotionAPIError.unauthorized(let m) { throw NotionAPIError.unauthorized(m) } catch { lastError = error }
        do {
            let d = try await client.get("databases/\(id)")
            o.databases.append(d); files(ofPage: d, &o)
            o.roots.append(.database(id))
            for ds in d["data_sources"]?.array ?? [] { if let dsid = NotionSnapshot.id(ds["id"]) { o.next.append(.dataSource(dsid)) } }
            o.next.append(.views(id))
            return
        } catch NotionAPIError.unauthorized(let m) { throw NotionAPIError.unauthorized(m) } catch { lastError = error }
        do {
            let ds = try await client.get("data_sources/\(id)")
            o.dataSources.append(ds)
            if let db = NotionSnapshot.id(ds["parent"]?["database_id"]) {
                o.roots.append(.database(db)); o.next.append(.database(db))
            }
            o.next.append(.rows(id))
            return
        } catch NotionAPIError.unauthorized(let m) { throw NotionAPIError.unauthorized(m) } catch { lastError = error }
        o.warnings.append("Couldn't open \(id) — is it shared with the integration (••• → Connections)? \(lastError?.localizedDescription ?? "")")
    }

    private func views(_ dbID: String, _ o: inout Outcome) async throws {
        let refs: [JSONValue]
        do { refs = try await client.paginateGet("views", query: ["database_id": dbID]) }
        catch { o.warnings.append("Views of database \(dbID) unavailable (\(error.localizedDescription)); a default table view is used."); return }
        var full: [JSONValue] = []
        for r in refs {
            guard let vid = r["id"]?.string else { continue }
            do { full.append(try await client.get("views/\(vid)")) }
            catch { o.warnings.append("View \(r["name"]?.string ?? vid) of database \(dbID) couldn't be read (\(error.localizedDescription)).") }
        }
        // Dashboards: make sure every widget view is loaded, and import the databases widgets show.
        var have = Set(full.compactMap { NotionSnapshot.id($0["id"]) })
        for v in full where v["type"]?.string == "dashboard" {
            for row in v["configuration"]?["rows"]?.array ?? [] {
                for w in row["widgets"]?.array ?? [] {
                    guard let wid = NotionSnapshot.id(w["view_id"]), !have.contains(wid) else { continue }
                    have.insert(wid)
                    do { full.append(try await client.get("views/\(wid)")) }
                    catch { o.warnings.append("Dashboard widget \(wid) couldn't be read (\(error.localizedDescription)).") }
                }
            }
        }
        for v in full where NotionSnapshot.id(v["dashboard_view_id"]) != nil {
            if let other = NotionSnapshot.id(v["parent"]?["database_id"]), other != NotionSnapshot.id(.string(dbID)) {
                o.next.append(.database(other))
            }
        }
        o.views.append((dbID, full))
        // Manual row order comes from an unfiltered, unsorted view (preferably a table).
        var bySource: [String: [JSONValue]] = [:]
        for v in full { if let ds = NotionSnapshot.id(v["data_source_id"]) { bySource[ds, default: []].append(v) } }
        for (ds, vs) in bySource {
            func plain(_ v: JSONValue) -> Bool {
                let f = v["filter"]; let s = v["sorts"]?.array ?? []
                return (f == nil || f?.isNull == true || f?.object?.isEmpty == true) && s.isEmpty
            }
            let pick = vs.first { plain($0) && $0["type"]?.string == "table" } ?? vs.first(where: plain) ?? vs.first { $0["filter"] == nil || $0["filter"]?.isNull == true }
            if let vid = pick?["id"]?.string, let order = try? await client.viewOrder(vid) {
                o.viewOrders.append((ds, order.compactMap { ImportIDs.notion($0) ?? $0 }))
            }
        }
    }

    // MARK: Following

    private func follow(block b: JSONValue, _ o: inout Outcome) {
        guard let id = NotionSnapshot.id(b["id"]), let type = b["type"]?.string else { return }
        switch type {
        case "child_page":
            if options.subpages { o.next.append(.page(id)) }
        case "child_database":
            o.next.append(.database(id))
        default:
            if b["has_children"]?.bool == true { o.next.append(.children(id)) }
        }
        let body = b[type]
        if ["image", "video", "audio", "file", "pdf"].contains(type), body?["type"]?.string == "file", let url = body?["file"]?["url"]?.string {
            download(url, name: body?["name"]?.string, &o)
        }
        if type == "callout", let icon = body?["icon"] { fileOfIcon(icon, &o) }
    }

    private func files(ofPage p: JSONValue, _ o: inout Outcome) {
        if let icon = p["icon"] { fileOfIcon(icon, &o) }
        if let cover = p["cover"], cover["type"]?.string == "file", let url = cover["file"]?["url"]?.string { download(url, name: nil, &o) }
        for (_, v) in p["properties"]?.object ?? [:] where v["type"]?.string == "files" {
            for f in v["files"]?.array ?? [] where f["type"]?.string == "file" {
                if let url = f["file"]?["url"]?.string { download(url, name: f["name"]?.string, &o) }
            }
        }
    }

    private func fileOfIcon(_ icon: JSONValue, _ o: inout Outcome) {
        if icon["type"]?.string == "file", let url = icon["file"]?["url"]?.string { download(url, name: nil, &o) }
        if icon["type"]?.string == "custom_emoji", let url = icon["custom_emoji"]?["url"]?.string { download(url, name: nil, &o) }
    }

    private func download(_ url: String, name: String?, _ o: inout Outcome) {
        guard options.downloadFiles else { return }
        o.next.append(.download(url, name))
    }

    /// Search mode: roots are objects whose parent isn't part of the shared set.
    private func planSearch(_ results: [JSONValue]) {
        var ids = Set<String>()
        for r in results { if let id = NotionSnapshot.id(r["id"]) { ids.insert(id) } }
        // Databases containing the shared data sources
        var dbOfSource: [String: String] = [:]
        for r in results where r["object"]?.string == "data_source" {
            if let id = NotionSnapshot.id(r["id"]), let db = NotionSnapshot.id(r["parent"]?["database_id"]) { dbOfSource[id] = db; ids.insert(db) }
        }
        for r in results {
            guard let id = NotionSnapshot.id(r["id"]) else { continue }
            let obj = r["object"]?.string
            if obj == "page" {
                snap.pages[id] = r
                seen.insert(.page(id))
                let parent = r["parent"]
                let ptype = parent?["type"]?.string ?? "workspace"
                let pid = NotionSnapshot.id(parent?[ptype])
                if ptype == "database_id" || ptype == "data_source_id" {
                    if let pid, ids.contains(pid) || dbOfSource.keys.contains(pid) { continue }   // a row: comes with its database
                }
                if ptype == "workspace" || pid == nil || !ids.contains(pid!) {
                    if !snap.roots.contains(.page(id)) { snap.roots.append(.page(id)) }
                }
                enqueue(.children(id))
                files(ofSearchPage: r)
            } else if obj == "data_source" || obj == "database" {
                let db = dbOfSource[id] ?? id
                let dbParent = r["database_parent"] ?? r["parent"]
                let ptype = dbParent?["type"]?.string ?? "workspace"
                let pid = NotionSnapshot.id(dbParent?[ptype])
                if ptype == "workspace" || pid == nil || !ids.contains(pid!) {
                    if !snap.roots.contains(.database(db)) { snap.roots.append(.database(db)) }
                }
                enqueue(.database(db))
            }
        }
    }

    private func files(ofSearchPage p: JSONValue) {
        var o = Outcome()
        files(ofPage: p, &o)
        o.next.forEach(enqueue)
    }
}
