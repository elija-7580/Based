import Foundation

@MainActor
public extension WorkspaceStore {

    // MARK: Create

    /// New page. `parent` is the workspace (top level), a page/block, or a database (row).
    @discardableResult
    func createPage(title: RichText = RichText(), in parent: ParentRef = .workspace, at position: InsertPosition = .end,
                    icon: PageIcon? = nil, values: [String: PropertyValue] = [:], name: String = "New page") -> RecordID {
        transact(name) { tx in
            var props = BlockProps()
            props.icon = icon
            var b = Block(type: .page, parent: parent, sortKey: tx.sortKey(in: parent, position),
                          text: title, props: props, values: values, createdBy: userID)
            if case .database(let dbID) = parent, let db = tx.database(dbID) {
                b.values = values
                if let uid = db.properties.first(where: { $0.type == .uniqueID }) {
                    let next = (db.nextUniqueID ?? 1)
                    b.values[uid.id] = .uniqueID(next)
                    tx.updateDatabase(dbID) { $0.nextUniqueID = next + 1 }
                }
            }
            tx.put(b)
            return b.id
        }
    }

    /// "Turn into page" for a set of blocks: wraps them as the content of a new subpage.
    @discardableResult
    func movesIntoNewPage(_ ids: [RecordID], title: RichText = RichText()) -> RecordID? {
        let ordered = documentOrder(ids)
        guard let first = ordered.first, let anchor = blocks[first] else { return nil }
        return transact("Turn into page") { tx in
            let page = Block(type: .page, parent: anchor.parent, sortKey: tx.sortKey(in: anchor.parent, .before(first)),
                             text: title, createdBy: userID)
            tx.put(page)
            let keys = FractionalIndex.keys(count: ordered.count, between: nil, nil)
            for (id, k) in zip(ordered, keys) { tx.update(id) { $0.parent = .block(page.id); $0.sortKey = k } }
            return page.id
        }
    }

    // MARK: Hierarchy

    func isTrashed(_ id: RecordID) -> Bool {
        var cur = blocks[id]
        var n = 0
        while let b = cur, n < 1000 {
            n += 1
            if b.trashedAt != nil { return true }
            switch b.parent {
            case .workspace: return false
            case .block(let pid): cur = blocks[pid]; if cur == nil { return true }
            case .database(let did):
                guard let owner = databases[did]?.blockID else { return true }
                cur = blocks[owner]
                if cur == nil { return true }
            }
        }
        return false
    }

    /// Parent block of a block (database rows resolve to the database's container).
    func parentBlock(of id: RecordID) -> Block? {
        guard let b = blocks[id] else { return nil }
        switch b.parent {
        case .workspace: return nil
        case .block(let pid): return blocks[pid]
        case .database(let did): return databases[did].flatMap { blocks[$0.blockID] }
        }
    }

    /// Nearest page-like block that contains `id` (or `id` itself when it is a page).
    func containingPage(of id: RecordID) -> RecordID? {
        var cur = blocks[id]
        var n = 0
        while let b = cur, n < 1000 {
            n += 1
            if b.type.isPageLike { return b.id }
            cur = parentBlock(of: b.id)
        }
        return nil
    }

    /// Breadcrumb trail: page-like ancestors from the top down, excluding `id`.
    func ancestors(of id: RecordID) -> [Block] {
        var out: [Block] = []
        var cur = parentBlock(of: id)
        var n = 0
        while let b = cur, n < 1000 {
            n += 1
            if b.type.isPageLike || b.type == .databaseInline { out.append(b) }
            cur = parentBlock(of: b.id)
        }
        return out.reversed()
    }

    func title(of id: RecordID) -> String {
        guard let b = blocks[id] else { return "Untitled" }
        if b.type == .databasePage || b.type == .databaseInline, let db = b.props.databaseID.flatMap({ databases[$0] }) {
            let t = db.title.plainText
            return t.isEmpty ? "Untitled" : t
        }
        let t = b.text.plainText.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? "Untitled" : t
    }

    func icon(of id: RecordID) -> PageIcon? { blocks[id]?.props.icon }

    /// Top-level pages and databases in sidebar order. Never lists a record twice, even if the index did.
    func topLevelPages() -> [Block] {
        var seen = Set<RecordID>()
        return childBlocks(of: .workspace).filter { $0.trashedAt == nil && $0.type.isPageLike && seen.insert($0.id).inserted }
    }

    /// Pages and databases nested in a page's content (any depth, not crossing into other pages).
    func subpages(of id: RecordID) -> [Block] {
        var out: [Block] = []
        func walk(_ pid: RecordID) {
            for c in contentBlocks(of: pid) {
                if c.type.isPageLike || (c.type == .databaseInline && ownsDatabase(c)) { out.append(c) }
                else if c.type != .syncedBlock || c.props.syncSource == nil { walk(c.id) }
            }
        }
        walk(id)
        return out
    }

    func hasSubpages(_ id: RecordID) -> Bool { !subpages(of: id).isEmpty }

    // MARK: Trash

    func trash(_ ids: [RecordID]) {
        transact("Move to Trash") { tx in
            let now = Date()
            for id in ids where tx.block(id) != nil { tx.update(id) { $0.trashedAt = now } }
        }
    }

    /// Restore from trash (see `restorePages`: orphaned pages move to the top level).
    func restore(_ ids: [RecordID]) { restorePages(ids) }

    func deleteForever(_ ids: [RecordID]) {
        transact("Delete forever") { tx in
            for id in ids where tx.block(id) != nil { removeSubtree(id, tx: tx) }
            tx.updateWorkspace { $0.favorites.removeAll { ids.contains($0) } }
        }
    }

    /// Trashed roots (pages, databases, rows), most recent first.
    func trashedPages() -> [Block] {
        blocks.values.filter { $0.trashedAt != nil }.sorted { ($0.trashedAt ?? .distantPast) > ($1.trashedAt ?? .distantPast) }
    }

    func emptyTrash() { deleteForever(trashedPages().map(\.id)) }

    /// Notion deletes trashed pages after 30 days.
    func purgeTrash(olderThan days: Int = 30, now: Date = Date()) {
        let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
        let old = trashedPages().filter { ($0.trashedAt ?? now) < cutoff }.map(\.id)
        if !old.isEmpty { deleteForever(old) }
    }

    // MARK: Favorites & moving

    func isFavorite(_ id: RecordID) -> Bool { workspace.favorites.contains(id) }

    func toggleFavorite(_ id: RecordID) {
        transact(isFavorite(id) ? "Remove from Favorites" : "Add to Favorites") { tx in
            tx.updateWorkspace { w in
                if let i = w.favorites.firstIndex(of: id) { w.favorites.remove(at: i) } else { w.favorites.append(id) }
            }
        }
    }

    func favoritePages() -> [Block] {
        workspace.favorites.compactMap { blocks[$0] }.filter { !isTrashed($0.id) }
    }

    /// Move a page (or any block) to another page, the top level, or a database.
    func movePage(_ id: RecordID, to parent: ParentRef, at position: InsertPosition = .end) {
        if case .block(let pid) = parent, pid == id || isDescendant(pid, of: id) { return }
        moveBlocks([id], to: parent, at: position, name: "Move page")
    }

    func renameWorkspace(_ name: String) {
        transact("Rename workspace") { tx in tx.updateWorkspace { $0.name = name } }
    }

    func setPageIcon(_ id: RecordID, _ icon: PageIcon?) {
        updateBlock(id, name: "Change icon") { $0.props.icon = icon }
    }

    func setPageCover(_ id: RecordID, _ cover: PageCover?) {
        updateBlock(id, name: "Change cover") { $0.props.cover = cover }
    }

    func setPageFormat(_ id: RecordID, _ f: (inout PageFormat) -> Void) {
        updateBlock(id, name: "Page settings") { b in
            var fmt = b.props.format ?? PageFormat()
            f(&fmt)
            b.props.format = fmt
        }
    }

    // MARK: Links

    /// Pages that mention or link to `id` (served from an incrementally maintained index).
    func backlinks(to id: RecordID) -> [RecordID] {
        if !linkIndexBuilt {
            Log.measure("Backlink index (\(blocks.count) blocks)", warnAfter: 0.05) {
                for b in blocks.values { reindexLinks(b.id) }
            }
            linkIndexBuilt = true
        }
        var pages: [RecordID] = []
        var seen = Set<RecordID>()
        for src in linkSources[id] ?? [] {
            guard let b = blocks[src], b.trashedAt == nil, let page = containingPage(of: b.id), page != id,
                  !seen.contains(page), !isTrashed(page) else { continue }
            seen.insert(page)
            pages.append(page)
        }
        return pages.sorted { title(of: $0).localizedCaseInsensitiveCompare(title(of: $1)) == .orderedAscending }
    }

    /// Builds the backlink index off the main thread (call right after opening a workspace), so the
    /// first page open doesn't scan every block. Changes made meanwhile are re-indexed on install;
    /// a `backlinks(to:)` call before it finishes still builds synchronously.
    public func prepareLinkIndexInBackground() {
        guard !linkIndexBuilt, linkIndexPending == nil else { return }
        let snapshot = blocks
        linkIndexPending = []
        Task.detached(priority: .utility) {
            let start = DispatchTime.now().uptimeNanoseconds
            var targets: [RecordID: Set<RecordID>] = [:]
            var sources: [RecordID: Set<RecordID>] = [:]
            for (id, b) in snapshot {
                let l = WorkspaceStore.linkedPages(of: b)
                guard !l.isEmpty else { continue }
                targets[id] = l
                for t in l { sources[t, default: []].insert(id) }
            }
            let ms = Int(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            await MainActor.run { [targets, sources] in
                self.installLinkIndex(targets: targets, sources: sources)
                Log.debug("Backlink index built in the background: \(snapshot.count) blocks in \(ms) ms", category: "perf")
            }
        }
    }

    /// True once backlinks are served from the index.
    public var isLinkIndexReady: Bool { linkIndexBuilt }

    internal func installLinkIndex(targets: [RecordID: Set<RecordID>], sources: [RecordID: Set<RecordID>]) {
        defer { linkIndexPending = nil }
        guard !linkIndexBuilt else { return }
        linkTargets = targets
        linkSources = sources
        linkIndexBuilt = true
        for id in linkIndexPending ?? [] { reindexLinks(id) }
    }

    /// Pages a block links to (mentions, link-to-page, table cells, text properties).
    nonisolated static func linkedPages(of b: Block) -> Set<RecordID> {
        var out = Set(b.text.mentionedPages)
        if let t = b.props.linkTarget { out.insert(t) }
        for c in b.props.cells ?? [] { out.formUnion(c.mentionedPages) }
        for v in b.values.values { if case .text(let t) = v { out.formUnion(t.mentionedPages) } }
        return out
    }

    func reindexLinks(_ id: RecordID) {
        let new = blocks[id].map(Self.linkedPages) ?? []
        let old = linkTargets[id] ?? []
        guard new != old else { return }
        for t in old.subtracting(new) {
            linkSources[t]?.remove(id)
            if linkSources[t]?.isEmpty == true { linkSources[t] = nil }
        }
        for t in new.subtracting(old) { linkSources[t, default: []].insert(id) }
        linkTargets[id] = new.isEmpty ? nil : new
    }

    /// Pages ordered by last edit, for "Recents" and Quick Find without a query.
    /// Cached per store revision; only the newest candidates are checked for trashed ancestors.
    func recentPages(limit: Int = 20) -> [Block] {
        if let c = recentPagesCache, c.revision == revision, c.limit >= limit { return Array(c.pages.prefix(limit)) }
        let keep = max(limit, 40)
        var candidates: [(date: Date, id: RecordID)] = []
        candidates.reserveCapacity(blocks.count / 4)
        for b in blocks.values where b.type.isPageLike && b.trashedAt == nil { candidates.append((b.updatedAt, b.id)) }
        candidates.sort { $0.date != $1.date ? $0.date > $1.date : $0.id < $1.id }
        var out: [Block] = []
        for c in candidates {
            if out.count >= keep { break }
            if !isTrashed(c.id), let b = blocks[c.id] { out.append(b) }
        }
        recentPagesCache = (revision, keep, out)
        return Array(out.prefix(limit))
    }

    /// All pages in the workspace (including database rows), not trashed. Cached per store revision.
    func allPages() -> [Block] {
        if let c = allPagesCache, c.revision == revision { return c.pages }
        let pages = blocks.values.filter { $0.type.isPageLike && !isTrashed($0.id) }
        allPagesCache = (revision, pages)
        return pages
    }
}