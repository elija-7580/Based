import Foundation

/// Where pages can be moved to from the sidebar, the Library or the "Move to…" picker.
public enum PageDestination: Hashable, Sendable {
    /// Top level, Private section.
    case privateTop
    /// Top level inside a teamspace section.
    case teamspace(RecordID)
    /// Inside another page (as sub-pages).
    case page(RecordID)
}

/// Where a dragged sidebar row lands relative to the row under the pointer.
public enum PageDropZone: Sendable { case before, inside, after }

/// Sidebar sections a top-level page belongs to.
public enum SidebarSectionID: Hashable, Sendable {
    case privatePages
    case teamspace(RecordID)
}

@MainActor
public extension WorkspaceStore {

    // MARK: Sections

    var teamspaces: [Teamspace] { workspace.teamspaces ?? [] }

    func teamspace(_ id: RecordID) -> Teamspace? { teamspaces.first { $0.id == id } }

    /// Section of a top-level page. Pages pointing at a deleted teamspace fall back to Private.
    func section(of page: Block) -> SidebarSectionID {
        if let t = page.props.teamspace, teamspace(t) != nil { return .teamspace(t) }
        return .privatePages
    }

    /// Top-level pages of one sidebar section, in order, never listing a record twice.
    func topLevelPages(in section: SidebarSectionID) -> [Block] {
        topLevelPages().filter { self.section(of: $0) == section }
    }

    @discardableResult
    func createTeamspace(name: String, icon: PageIcon? = nil) -> RecordID {
        let t = Teamspace(name: name.isEmpty ? "New teamspace" : name, icon: icon)
        transact("New teamspace") { tx in tx.updateWorkspace { w in w.teamspaces = (w.teamspaces ?? []) + [t] } }
        return t.id
    }

    func renameTeamspace(_ id: RecordID, to name: String) {
        transact("Rename teamspace") { tx in
            tx.updateWorkspace { w in
                guard let i = w.teamspaces?.firstIndex(where: { $0.id == id }) else { return }
                w.teamspaces?[i].name = name
            }
        }
    }

    /// Removes the section only; its pages move to Private (no page is deleted).
    func deleteTeamspace(_ id: RecordID) {
        transact("Delete teamspace") { tx in
            for b in childBlocks(of: .workspace) where b.props.teamspace == id { tx.update(b.id) { $0.props.teamspace = nil } }
            tx.updateWorkspace { w in
                w.teamspaces?.removeAll { $0.id == id }
                if w.teamspaces?.isEmpty == true { w.teamspaces = nil }
            }
        }
    }

    /// New empty top-level page at the end of a sidebar section (one undo step).
    @discardableResult
    func createTopLevelPage(in section: SidebarSectionID, title: String = "") -> RecordID {
        transact("New page") { tx in
            var props = BlockProps()
            if case .teamspace(let t) = section { props.teamspace = t }
            let b = Block(type: .page, parent: .workspace, sortKey: tx.sortKey(in: .workspace, .end),
                          text: RichText(title), props: props, values: [:], createdBy: userID)
            tx.put(b)
            return b.id
        }
    }

    // MARK: Trash

    /// The id is protected, or a protected record lives inside it (deleting it would take that one along).
    func containsProtected(_ id: RecordID) -> Bool {
        guard !protectedIDs.isEmpty else { return false }
        return protectedIDs.contains(id) || protectedIDs.contains { isDescendant($0, of: id) }
    }

    /// Of `ids`, those that can't be trashed or deleted.
    func protectedAmong(_ ids: [RecordID]) -> [RecordID] { ids.filter(containsProtected) }

    /// Moves pages (and, implicitly, everything inside them) to the Trash in one undoable step.
    /// Ids nested inside another selected id are skipped: trashing the parent already hides them, and
    /// restoring the parent brings them back. Returns the ids that were trashed.
    @discardableResult
    func trashPages(_ ids: [RecordID]) -> [RecordID] {
        let unique = Array(Set(ids)).filter { blocks[$0] != nil && !isTrashed($0) && !containsProtected($0) }
        let set = Set(unique)
        let roots = documentOrder(unique.filter { id in !set.contains { $0 != id && isDescendant(id, of: $0) } })
        guard !roots.isEmpty else { return [] }
        transact(roots.count == 1 ? "Move to Trash" : "Move \(roots.count) pages to Trash") { tx in
            let now = Date()
            for id in roots { tx.update(id) { $0.trashedAt = now } }
        }
        return roots
    }

    /// Restores trashed pages. A page whose parent is gone or still in the Trash moves to the top level
    /// (Private), so it never stays invisible.
    func restorePages(_ ids: [RecordID]) {
        let roots = ids.filter { blocks[$0]?.trashedAt != nil }
        guard !roots.isEmpty else { return }
        transact(roots.count == 1 ? "Restore" : "Restore \(roots.count) pages") { tx in
            for id in roots {
                guard let b = tx.block(id) else { continue }
                var orphaned = false
                switch b.parent {
                case .workspace: break
                case .block(let pid): orphaned = blocks[pid] == nil || isTrashed(pid)
                case .database(let did):
                    if let owner = databases[did]?.blockID { orphaned = blocks[owner] == nil || isTrashed(owner) } else { orphaned = true }
                }
                let key = orphaned ? tx.sortKey(in: .workspace, .end) : b.sortKey
                // A row restored into its database: drop values the schema no longer allows (BSD-122).
                var fitted: [String: PropertyValue]?
                if !orphaned, case .database(let did) = b.parent, let db = tx.database(did) {
                    let v = Self.valuesMatchingSchema(b.values, db)
                    if v != b.values { fitted = v }
                }
                tx.update(id) { blk in
                    blk.trashedAt = nil
                    if let fitted { blk.values = fitted }
                    if orphaned {
                        blk.parent = .workspace
                        blk.sortKey = key
                        blk.props.teamspace = nil
                        if blk.type == .databaseInline { blk.type = .databasePage }
                    }
                }
                restampSubtree(of: id, tx: tx)
            }
        }
    }

    /// Re-stamps everything inside a restored page (blocks, rows, databases, views) so the restore wins against
    /// an older "delete forever" on another device: otherwise only the page itself would be newer than those
    /// tombstones and come back empty (ADR 0002, BSD-24).
    func restampSubtree(of id: RecordID, tx: Tx) {
        for d in [id] + descendants(of: id) {
            if d != id { tx.restamp(RecordKey(.block, d)) }
            for v in viewIDs(forBlock: d) { tx.restamp(RecordKey(.view, v)) }
            if let db = blocks[d]?.props.databaseID, databases[db]?.blockID == d { tx.restamp(RecordKey(.database, db)) }
        }
    }

    /// Pages hidden because an ancestor is in the Trash (shown as "N pages inside" in the Trash).
    func trashedDescendantPages(of id: RecordID) -> [RecordID] {
        descendants(of: id, includeRows: false).filter { blocks[$0]?.type.isPageLike == true }
    }

    // MARK: Move

    /// Moves pages in one undoable step. Pages that would end up inside themselves are skipped, as are ids
    /// nested inside another moved id (they travel with their parent).
    func movePages(_ ids: [RecordID], to destination: PageDestination, at position: InsertPosition = .end) {
        let set = Set(ids)
        var moving = ids.filter { id in blocks[id] != nil && !set.contains { $0 != id && isDescendant(id, of: $0) } }
        let parent: ParentRef
        var teamspaceID: RecordID?
        switch destination {
        case .privateTop: parent = .workspace
        case .teamspace(let t): parent = .workspace; teamspaceID = t
        case .page(let pid):
            moving = moving.filter { $0 != pid && !isDescendant(pid, of: $0) }
            parent = .block(pid)
        }
        guard !moving.isEmpty else { return }
        let name = moving.count == 1 ? "Move page" : "Move \(moving.count) pages"
        let plan = planMove(moving, to: parent, at: position)
        guard !plan.isEmpty else { return }
        let toTop = parent == .workspace
        transact(name) { tx in
            for (id, key) in plan {
                tx.update(id) { b in
                    b.parent = parent
                    b.sortKey = key
                    b.props.teamspace = toTop ? teamspaceID : nil
                    if toTop && b.type == .databaseInline { b.type = .databasePage }
                }
            }
        }
    }

    /// Sidebar drag & drop: nests onto the middle of a page row, reorders on its top / bottom edge (keeping the
    /// target's section). Returns false when nothing moved.
    @discardableResult
    func dropPages(_ ids: [RecordID], onto target: RecordID, zone: PageDropZone) -> Bool {
        guard let t = blocks[target] else { return false }
        let valid = ids.filter { $0 != target && !isDescendant(target, of: $0) && blocks[$0] != nil }
        guard !valid.isEmpty else { return false }
        switch zone {
        case .inside:
            guard t.type == .page else { return false }
            movePages(valid, to: .page(target))
        case .before, .after:
            let pos: InsertPosition = zone == .before ? .before(target) : .after(target)
            switch t.parent {
            case .database: return false
            case .workspace:
                movePages(valid, to: t.props.teamspace.map { .teamspace($0) } ?? .privateTop, at: pos)
            case .block(let pid):
                movePages(valid, to: .page(pid), at: pos)
            }
        }
        return true
    }

    // MARK: Duplicate

    /// Duplicates each page next to its original (works across parents, unlike `duplicateBlocks`).
    @discardableResult
    func duplicatePages(_ ids: [RecordID]) -> [RecordID] {
        let set = Set(ids)
        let roots = documentOrder(ids.filter { id in blocks[id] != nil && !set.contains { $0 != id && isDescendant(id, of: $0) } })
        guard !roots.isEmpty else { return [] }
        return transact(roots.count == 1 ? "Duplicate" : "Duplicate \(roots.count) pages") { tx in
            var out: [RecordID] = []
            for id in roots {
                guard let src = blocks[id] else { continue }
                let key = tx.sortKey(in: src.parent, .after(id))
                out.append(copySubtree(src, parent: src.parent, sortKey: key, tx: tx, titleSuffix: src.type.isPageLike ? " (1)" : nil))
            }
            return out
        }
    }

    // MARK: Rename

    /// Renames a page or a database (whose title lives on the database record).
    func renamePage(_ id: RecordID, to title: String) {
        guard let b = blocks[id] else { return }
        if (b.type == .databasePage || b.type == .databaseInline), let db = b.props.databaseID, databases[db] != nil {
            setDatabaseTitle(db, RichText(title))
        } else {
            updateBlock(id, name: "Rename") { $0.text = RichText(title) }
        }
    }

    // MARK: Favorites

    /// Adds or removes all `ids` from Favorites in one step (adds unless every id is already a favorite).
    /// The chosen Home page, if it still exists and isn't in the Trash.
    var homePageID: RecordID? {
        guard let id = workspace.homePageID, blocks[id] != nil, !isTrashed(id) else { return nil }
        return id
    }

    /// Sets (or with nil clears) the page shown under Home. Synced like the rest of the workspace.
    func setHomePage(_ id: RecordID?) {
        guard workspace.homePageID != id else { return }
        transact(id == nil ? "Clear Home page" : "Set Home page") { tx in tx.updateWorkspace { $0.homePageID = id } }
    }

    func setFavorite(_ ids: [RecordID], _ on: Bool) {
        transact(on ? "Add to Favorites" : "Remove from Favorites") { tx in
            tx.updateWorkspace { w in
                if on { for id in ids where !w.favorites.contains(id) { w.favorites.append(id) } }
                else { w.favorites.removeAll { ids.contains($0) } }
            }
        }
    }
}
