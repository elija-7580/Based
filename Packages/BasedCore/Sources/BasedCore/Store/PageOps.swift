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

    func topLevelPages() -> [Block] {
        childBlocks(of: .workspace).filter { $0.trashedAt == nil && $0.type.isPageLike }
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

    /// Restore from trash. Pages whose parent no longer exists move to the top level.
    func restore(_ ids: [RecordID]) {
        transact("Restore") { tx in
            for id in ids {
                guard let b = tx.block(id) else { continue }
                var parentGone = false
                switch b.parent {
                case .workspace: break
                case .block(let pid): parentGone = blocks[pid] == nil
                case .database(let did): parentGone = databases[did] == nil
                }
                let key = parentGone ? tx.sortKey(in: .workspace, .end) : b.sortKey
                tx.update(id) { blk in
                    blk.trashedAt = nil
                    if parentGone { blk.parent = .workspace; blk.sortKey = key }
                }
            }
        }
    }

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

    /// Pages that mention or link to `id`.
    func backlinks(to id: RecordID) -> [RecordID] {
        var pages: [RecordID] = []
        var seen = Set<RecordID>()
        for b in blocks.values where b.trashedAt == nil {
            let links = b.text.mentionedPages.contains(id) || b.props.linkTarget == id ||
                (b.props.cells ?? []).contains { $0.mentionedPages.contains(id) } ||
                b.values.values.contains { if case .text(let t) = $0 { return t.mentionedPages.contains(id) } else { return false } }
            guard links, let page = containingPage(of: b.id), page != id, !seen.contains(page), !isTrashed(page) else { continue }
            seen.insert(page)
            pages.append(page)
        }
        return pages.sorted { title(of: $0).localizedCaseInsensitiveCompare(title(of: $1)) == .orderedAscending }
    }

    /// Pages ordered by last edit, for "Recents" and Quick Find without a query.
    func recentPages(limit: Int = 20) -> [Block] {
        Array(blocks.values.filter { $0.type.isPageLike && !isTrashed($0.id) }
            .sorted { $0.updatedAt > $1.updatedAt }.prefix(limit))
    }

    /// All pages in the workspace (including database rows), not trashed.
    func allPages() -> [Block] {
        blocks.values.filter { $0.type.isPageLike && !isTrashed($0.id) }
    }
}