import Foundation

/// Where the caret should go after a structural edit.
public struct FocusTarget: Equatable, Sendable {
    public var id: RecordID
    public var offset: Int
    public init(_ id: RecordID, _ offset: Int) { self.id = id; self.offset = offset }
}

@MainActor
public extension WorkspaceStore {

    // MARK: Lookup helpers

    func block(_ id: RecordID) -> Block? { blocks[id] }

    /// Live (non-trashed) child blocks in order.
    func contentBlocks(of id: RecordID) -> [Block] {
        childBlocks(of: .block(id)).filter { $0.trashedAt == nil }
    }

    /// Children are rendered nested below the block (and take part in caret navigation).
    func showsChildrenInline(_ b: Block) -> Bool {
        switch b.type {
        case .page, .databasePage, .databaseInline, .table, .tableRow, .linkToPage: return false
        // The meeting view lays out its sections and transcript itself.
        case .meeting, .meetingSection, .transcript: return false
        case .toggle: return b.props.isOpen ?? false
        default:
            if b.type.isHeading, b.props.toggleable == true { return b.props.isOpen ?? false }
            return b.type.supportsChildren
        }
    }

    /// Blocks of a page in reading order, descending into nested blocks that are visible.
    func visibleOrder(in pageID: RecordID) -> [RecordID] {
        var out: [RecordID] = []
        func walk(_ id: RecordID) {
            for c in contentBlocks(of: id) {
                out.append(c.id)
                if showsChildrenInline(c) { walk(c.id) }
            }
        }
        walk(pageID)
        return out
    }

    /// Every block below `id` (children, grandchildren, database rows …), depth first.
    func descendants(of id: RecordID, includeRows: Bool = true) -> [RecordID] {
        var out: [RecordID] = []
        var stack = [id]
        while let cur = stack.popLast() {
            var kids = children(of: .block(cur))
            if includeRows, let b = blocks[cur], let db = b.props.databaseID, databases[db]?.blockID == cur {
                kids += children(of: .database(db))
            }
            out.append(contentsOf: kids)
            stack.append(contentsOf: kids.reversed())
        }
        return out
    }

    func isDescendant(_ id: RecordID, of ancestor: RecordID) -> Bool {
        var cur = blocks[id]?.parent
        var guardCount = 0
        while let p = cur, guardCount < 10_000 {
            guardCount += 1
            switch p {
            case .workspace: return false
            case .block(let pid):
                if pid == ancestor { return true }
                cur = blocks[pid]?.parent
            case .database(let did):
                guard let owner = databases[did]?.blockID else { return false }
                if owner == ancestor { return true }
                cur = blocks[owner]?.parent
            }
        }
        return false
    }

    func siblings(of id: RecordID) -> [RecordID] {
        guard let b = blocks[id] else { return [] }
        return children(of: b.parent)
    }

    func previousSibling(of id: RecordID) -> Block? {
        let s = siblings(of: id).filter { blocks[$0]?.trashedAt == nil }
        guard let i = s.firstIndex(of: id), i > 0 else { return nil }
        return blocks[s[i - 1]]
    }

    func nextSibling(of id: RecordID) -> Block? {
        let s = siblings(of: id).filter { blocks[$0]?.trashedAt == nil }
        guard let i = s.firstIndex(of: id), i + 1 < s.count else { return nil }
        return blocks[s[i + 1]]
    }

    /// 1-based number of a numbered-list item, counting consecutive numbered siblings.
    func listNumber(of id: RecordID) -> Int {
        let s = siblings(of: id).compactMap { blocks[$0] }.filter { $0.trashedAt == nil }
        guard let i = s.firstIndex(where: { $0.id == id }) else { return 1 }
        var n = 1
        var j = i - 1
        while j >= 0, s[j].type == .numberedList { n += 1; j -= 1 }
        return n
    }

    /// Nesting depth of a list item (for 1. / a. / i. and bullet styles).
    func listDepth(of id: RecordID) -> Int {
        var depth = 0
        var cur = blocks[id]
        while let b = cur, case .block(let pid) = b.parent, let p = blocks[pid], p.type.isList {
            depth += 1; cur = p
        }
        return depth
    }

    // MARK: Insert & text

    @discardableResult
    func insertBlock(_ type: BlockType, text: RichText = RichText(), props: BlockProps = BlockProps(),
                     in parent: ParentRef, at position: InsertPosition = .end, name: String = "Add block") -> RecordID {
        transact(name) { tx in
            let b = Block(type: type, parent: parent, sortKey: tx.sortKey(in: parent, position),
                          text: text, props: props, createdBy: userID)
            tx.put(b)
            return b.id
        }
    }

    /// Insert a block right after another one (same parent).
    @discardableResult
    func insertBlock(_ type: BlockType, after id: RecordID, text: RichText = RichText(), props: BlockProps = BlockProps()) -> RecordID? {
        guard let anchor = blocks[id] else { return nil }
        return insertBlock(type, text: text, props: props, in: anchor.parent, at: .after(id))
    }

    /// Typing: coalesced into one undo step per burst.
    func setText(_ id: RecordID, _ text: RichText) {
        guard let b = blocks[id], b.text != text else { return }
        transact("Typing", coalesce: "text:\(id)") { tx in
            tx.update(id) { $0.text = text }
        }
    }

    func updateBlock(_ id: RecordID, name: String = "Edit block", coalesce: String? = nil, _ f: (inout Block) -> Void) {
        guard blocks[id] != nil else { return }
        transact(name, coalesce: coalesce) { tx in tx.update(id, f) }
    }

    func updateBlocks(_ ids: [RecordID], name: String = "Edit blocks", _ f: (inout Block) -> Void) {
        transact(name) { tx in for id in ids where tx.block(id) != nil { tx.update(id, f) } }
    }

    func setChecked(_ id: RecordID, _ checked: Bool) {
        updateBlock(id, name: checked ? "Check" : "Uncheck") { $0.props.checked = checked }
    }

    /// Column widths as fractions of the row (Notion stores one ratio per column).
    func setColumnRatios(_ columns: [RecordID], _ ratios: [Double]) {
        guard columns.count == ratios.count, !columns.isEmpty else { return }
        transact("Resize columns", coalesce: "colratio:" + columns.joined()) { tx in
            for (c, r) in zip(columns, ratios) { tx.update(c) { $0.props.ratio = r } }
        }
    }

    func toggleOpen(_ id: RecordID) {
        guard let b = blocks[id] else { return }
        transact("Toggle", undoable: false) { tx in tx.update(id) { $0.props.isOpen = !(b.props.isOpen ?? false) } }
    }

    func setColor(_ ids: [RecordID], _ color: TColor?) {
        updateBlocks(ids, name: "Color") { $0.props.color = color == .default ? nil : color }
    }

    // MARK: Enter / Backspace

    /// Return key at `offset`. Returns the block that should receive focus.
    @discardableResult
    func splitBlock(_ id: RecordID, at offset: Int) -> FocusTarget? {
        guard let b = blocks[id] else { return nil }
        let len = b.text.length
        let offset = max(0, min(offset, len))

        // Empty list item: outdent if nested in a list, else turn into text.
        if b.type.isList || b.type == .quote, b.text.isEmpty, contentBlocks(of: id).isEmpty {
            if case .block(let pid) = b.parent, let p = blocks[pid], p.type.isList {
                outdent([id])
            } else {
                turnInto([id], .text)
            }
            return FocusTarget(id, 0)
        }

        let nextType: BlockType = b.type.continuesOnEnter ? b.type : .text
        var nextProps = BlockProps()
        if b.type == .todo { nextProps.checked = false }
        if b.type == .toggle { nextProps.isOpen = false }

        // Caret at the start of a non-empty block: insert an empty block above.
        if offset == 0, len > 0 {
            transact("New block") { tx in
                let nb = Block(type: nextType, parent: b.parent, sortKey: tx.sortKey(in: b.parent, .before(id)),
                               props: nextProps, createdBy: userID)
                tx.put(nb)
            }
            return FocusTarget(id, 0)
        }

        let (head, tail) = b.text.split(at: offset)
        let liveKids = contentBlocks(of: id)
        let intoChildren = showsChildrenInline(b) &&
            (!liveKids.isEmpty || b.type == .toggle || (b.type.isHeading && b.props.toggleable == true))
        return transact("New block") { tx in
            tx.update(id) { $0.text = head }
            let parent: ParentRef = intoChildren ? .block(id) : b.parent
            let position: InsertPosition = intoChildren ? .start : .after(id)
            let type: BlockType = (intoChildren && (b.type == .toggle || b.type.isHeading)) ? .text : nextType
            let nb = Block(type: type, parent: parent, sortKey: tx.sortKey(in: parent, position),
                           text: tail, props: type == nextType ? nextProps : BlockProps(), createdBy: userID)
            tx.put(nb)
            return FocusTarget(nb.id, 0)
        }
    }

    /// Backspace at offset 0. Returns where the caret should go, or nil if nothing changed.
    @discardableResult
    func mergeIntoPrevious(_ id: RecordID, pageID: RecordID) -> FocusTarget? {
        guard let b = blocks[id] else { return nil }
        // 1. Non-text block types first turn into plain text.
        if b.type != .text, b.type.hasRichText {
            turnInto([id], .text)
            return FocusTarget(id, 0)
        }
        // 2. Last nested text block under a list item: outdent.
        if case .block(let pid) = b.parent, pid != pageID, let p = blocks[pid], p.type.isList,
           nextSibling(of: id) == nil {
            outdent([id])
            return FocusTarget(id, 0)
        }
        // 3. Merge with previous visible text block.
        let order = visibleOrder(in: pageID)
        guard let i = order.firstIndex(of: id), i > 0, let prev = blocks[order[i - 1]] else { return nil }
        if !prev.type.isTextEditable {
            if b.text.isEmpty && contentBlocks(of: id).isEmpty {
                deleteBlocks([id])
                return FocusTarget(prev.id, 0)
            }
            return nil
        }
        let caret = prev.text.length
        let kids = children(of: .block(id))
        transact("Merge blocks") { tx in
            tx.update(prev.id) { $0.text = $0.text + b.text }
            // Children of the merged block take its place.
            if !kids.isEmpty {
                let keys = tx.sortKeys(kids.count, in: b.parent, .after(id))
                for (k, key) in zip(kids, keys) {
                    tx.update(k) { $0.parent = b.parent; $0.sortKey = key }
                }
            }
            tx.removeBlock(id)
        }
        return FocusTarget(prev.id, caret)
    }

    /// Forward delete at the end of a block: pull the next visible text block in.
    @discardableResult
    func mergeNext(_ id: RecordID, pageID: RecordID) -> FocusTarget? {
        let order = visibleOrder(in: pageID)
        guard let b = blocks[id], let i = order.firstIndex(of: id), i + 1 < order.count,
              let next = blocks[order[i + 1]], next.type.isTextEditable else { return nil }
        let caret = b.text.length
        let kids = children(of: .block(next.id))
        transact("Merge blocks") { tx in
            tx.update(id) { $0.text = $0.text + next.text }
            if !kids.isEmpty {
                let keys = tx.sortKeys(kids.count, in: next.parent, .after(next.id))
                for (k, key) in zip(kids, keys) { tx.update(k) { $0.parent = next.parent; $0.sortKey = key } }
            }
            tx.removeBlock(next.id)
        }
        return FocusTarget(id, caret)
    }

    // MARK: Structure

    /// Tab: make each block the last child of its previous sibling.
    func indent(_ ids: [RecordID]) {
        let ordered = documentOrder(ids)
        transact("Indent") { tx in
            for id in ordered {
                guard let b = tx.block(id) else { continue }
                let sibs = children(of: b.parent).filter { blocks[$0]?.trashedAt == nil }
                guard let i = sibs.firstIndex(of: id), i > 0, let prev = blocks[sibs[i - 1]],
                      prev.type.supportsChildren, !prev.type.isPageLike, prev.type != .table,
                      prev.type != .columnList, prev.type != .column else { continue }
                let parent = ParentRef.block(prev.id)
                let key = tx.sortKey(in: parent, .end)
                tx.update(id) { $0.parent = parent; $0.sortKey = key }
                if prev.type == .toggle || (prev.type.isHeading && prev.props.toggleable == true), prev.props.isOpen != true {
                    tx.update(prev.id) { $0.props.isOpen = true }
                }
            }
        }
    }

    /// Shift-Tab: move after the parent block; following siblings become children.
    func outdent(_ ids: [RecordID]) {
        let ordered = documentOrder(ids)
        transact("Outdent") { tx in
            for id in ordered {
                guard let b = tx.block(id), case .block(let pid) = b.parent, let p = tx.block(pid),
                      !p.type.isPageLike, p.type != .column, p.type != .syncedBlock else { continue }
                let sibs = children(of: b.parent)
                let following = Array(sibs.drop(while: { $0 != id }).dropFirst().filter { !ordered.contains($0) })
                let key = tx.sortKey(in: p.parent, .after(pid))
                tx.update(id) { $0.parent = p.parent; $0.sortKey = key }
                if !following.isEmpty, b.type.supportsChildren {
                    let keys = tx.sortKeys(following.count, in: .block(id), .end)
                    for (f, k) in zip(following, keys) { tx.update(f) { $0.parent = .block(id); $0.sortKey = k } }
                }
            }
        }
    }

    func turnInto(_ ids: [RecordID], _ type: BlockType, toggleable: Bool? = nil) {
        transact("Turn into \(type.displayName)") { tx in
            for id in ids {
                // A block from a newer version (BSD-25) keeps its type: turning it into something else would drop its content.
                guard let b = tx.block(id), b.type != .unknown, type != .unknown, !b.type.isPageLike || type.isPageLike else { continue }
                tx.update(id) { blk in
                    let from = blk.type
                    blk.type = type
                    if type == .todo, blk.props.checked == nil { blk.props.checked = false }
                    if type != .todo { blk.props.checked = nil }
                    if type == .code, from != .code {
                        blk.text = RichText(blk.text.plainText)
                        if blk.props.language == nil { blk.props.language = "plain text" }
                    }
                    if type == .callout, blk.props.icon == nil { blk.props.icon = .emoji("💡") }
                    if type.isHeading { blk.props.toggleable = toggleable } else { blk.props.toggleable = nil }
                    if type == .divider { blk.text = RichText() }
                }
            }
        }
    }

    /// Move blocks (keeping their relative order) to a new location.
    func moveBlocks(_ ids: [RecordID], to parent: ParentRef, at position: InsertPosition, name: String = "Move") {
        let plan = planMove(ids, to: parent, at: position)
        guard !plan.isEmpty else { return }
        let moving = Set(plan.map(\.0))
        // Columns the blocks leave; emptied ones are removed in the same undo step (Notion collapses them).
        let sourceColumns = Set(plan.compactMap { id, _ -> RecordID? in
            guard case .block(let pid) = blocks[id]?.parent, blocks[pid]?.type == .column else { return nil }
            return pid
        })
        transact(name) { tx in
            for (id, k) in plan {
                tx.update(id) { $0.parent = parent; $0.sortKey = k }
            }
            collapseColumns(sourceColumns, moving: moving, into: parent, tx: tx)
        }
    }

    /// Removes columns left empty by a move and unwraps a column list that is down to one column.
    private func collapseColumns(_ columns: Set<RecordID>, moving: Set<RecordID>, into dest: ParentRef,
                                 keepList: RecordID? = nil, tx: Tx) {
        var lists: [RecordID: Set<RecordID>] = [:]   // list → columns removed
        for colID in columns {
            if case .block(let d) = dest, d == colID { continue }
            guard let col = blocks[colID], case .block(let listID) = col.parent, blocks[listID]?.type == .columnList else { continue }
            let left = contentBlocks(of: colID).filter { !moving.contains($0.id) }
            if left.isEmpty { lists[listID, default: []].insert(colID) }
        }
        for (listID, removed) in lists {
            guard let list = blocks[listID] else { continue }
            for c in removed { tx.removeBlock(c) }
            // A list that just gained a column (placeInColumn) keeps its other columns even if only one is left.
            if listID == keepList { continue }
            let remaining = contentBlocks(of: listID).filter { !removed.contains($0.id) }
            guard remaining.count <= 1 else { continue }
            // Blocks landing in the last column stay put; unwrapping would move them a second time.
            if case .block(let d) = dest, remaining.contains(where: { $0.id == d }) { continue }
            let last = remaining.first
            let kids = last.map { contentBlocks(of: $0.id).map(\.id).filter { !moving.contains($0) } } ?? []
            let keys = tx.sortKeys(kids.count, in: list.parent, .after(listID))
            for (k, key) in zip(kids, keys) { tx.update(k) { $0.parent = list.parent; $0.sortKey = key } }
            if let l = last { tx.removeBlock(l.id) }
            tx.removeBlock(listID)
        }
    }

    /// Document-ordered ids with their new sort keys for a move into `parent` at `position` (no writes).
    internal func planMove(_ ids: [RecordID], to parent: ParentRef, at position: InsertPosition) -> [(RecordID, String)] {
        let ordered = documentOrder(ids).filter { id in
            if case .block(let pid) = parent, pid == id || isDescendant(pid, of: id) { return false }
            return true
        }
        guard !ordered.isEmpty else { return [] }
        let moving = Set(ordered)
        // Never anchor on a block that is being moved: walk to the nearest stable sibling.
        var pos = position
        let sibs = children(of: parent)
        switch position {
        case .after(let a) where moving.contains(a):
            if let i = sibs.firstIndex(of: a) {
                let prev = sibs[..<i].last { !moving.contains($0) }
                pos = prev.map(InsertPosition.after) ?? .start
            }
        case .before(let a) where moving.contains(a):
            if let i = sibs.firstIndex(of: a) {
                let next = sibs[(i + 1)...].first { !moving.contains($0) }
                pos = next.map(InsertPosition.before) ?? .end
            }
        default: break
        }
        // Keys are computed against the siblings that stay in place.
        let remaining = sibs.filter { !moving.contains($0) }
        let key: (RecordID) -> String? = { [blocks] in blocks[$0]?.sortKey }
        var lo: String?, hi: String?
        switch pos {
        case .start: hi = remaining.first.flatMap(key)
        case .end: lo = remaining.last.flatMap(key)
        case .after(let a):
            if let i = remaining.firstIndex(of: a) { lo = key(a); hi = i + 1 < remaining.count ? key(remaining[i + 1]) : nil }
            else { lo = remaining.last.flatMap(key) }
        case .before(let b):
            if let i = remaining.firstIndex(of: b) { hi = key(b); lo = i > 0 ? key(remaining[i - 1]) : nil }
            else { hi = remaining.first.flatMap(key) }
        }
        let keys = FractionalIndex.keys(count: ordered.count, between: lo, hi)
        return Array(zip(ordered, keys))
    }

    func moveUp(_ id: RecordID) {
        guard let prev = previousSibling(of: id), let b = blocks[id] else { return }
        moveBlocks([id], to: b.parent, at: .before(prev.id), name: "Move up")
    }

    func moveDown(_ id: RecordID) {
        guard let next = nextSibling(of: id), let b = blocks[id] else { return }
        moveBlocks([id], to: b.parent, at: .after(next.id), name: "Move down")
    }

    /// Deep copy, placed after the last original. Returns the new top-level ids.
    @discardableResult
    func duplicateBlocks(_ ids: [RecordID]) -> [RecordID] {
        let ordered = documentOrder(ids)
        guard let last = ordered.last, let anchor = blocks[last] else { return [] }
        return transact("Duplicate") { tx in
            var result: [RecordID] = []
            let keys = tx.sortKeys(ordered.count, in: anchor.parent, .after(last))
            for (id, key) in zip(ordered, keys) {
                guard let src = blocks[id] else { continue }
                let nid = copySubtree(src, parent: anchor.parent, sortKey: key, tx: tx,
                                      titleSuffix: src.type.isPageLike ? " (1)" : nil)
                linkMirrors(ofRow: nid, tx: tx)
                result.append(nid)
            }
            return result
        }
    }

    /// Copies a block (and everything under it) inside a transaction.
    @discardableResult
    func copySubtree(_ src: Block, parent: ParentRef, sortKey: String, tx: Tx, titleSuffix: String? = nil) -> RecordID {
        var copy = src
        copy.id = RecordIDs.make()
        copy.parent = parent
        copy.sortKey = sortKey
        copy.createdAt = Date(); copy.createdBy = userID
        copy.trashedAt = nil
        if let s = titleSuffix, !src.text.isEmpty { copy.text = src.text + RichText(s) }
        if let dbID = src.props.databaseID, let db = databases[dbID], db.blockID == src.id {
            // Database containers get their own database, views and rows.
            var ndb = db
            ndb.id = RecordIDs.make()
            ndb.blockID = copy.id
            // The copy's relations are one-way: the mirrors on other databases belong to the original (BSD-31).
            for i in ndb.properties.indices { ndb.properties[i].relation?.syncedPropertyID = nil }
            tx.put(ndb)
            copy.props.databaseID = ndb.id
            copy.props.viewIDs = copyViews(of: src.id, to: copy.id, databaseID: ndb.id, tx: tx)
            tx.put(copy)
            for r in childBlocks(of: .database(dbID)) where r.trashedAt == nil {
                copySubtree(r, parent: .database(ndb.id), sortKey: r.sortKey, tx: tx)
            }
        } else {
            if src.type == .databaseInline || src.type == .databasePage {
                copy.props.viewIDs = copyViews(of: src.id, to: copy.id, databaseID: nil, tx: tx)
            }
            tx.put(copy)
        }
        for c in childBlocks(of: .block(src.id)) where c.trashedAt == nil {
            copySubtree(c, parent: .block(copy.id), sortKey: c.sortKey, tx: tx)
        }
        return copy.id
    }

    private func copyViews(of blockID: RecordID, to newBlock: RecordID, databaseID: RecordID?, tx: Tx) -> [RecordID] {
        var ids: [RecordID] = []
        for v in views(forBlock: blockID) {
            var nv = v
            nv.id = RecordIDs.make(); nv.blockID = newBlock
            if let databaseID { nv.databaseID = databaseID }
            tx.put(nv); ids.append(nv.id)
        }
        return ids
    }

    /// Delete blocks. Pages and databases go to the trash; other blocks are removed (undoable).
    /// Pages and databases nested inside a removed block (a toggle, callout, column …) are not removed
    /// with it: they move to the Trash as well (see `removeSubtreeKeepingPages`).
    func deleteBlocks(_ ids: [RecordID]) {
        transact("Delete") { tx in
            let now = Date()
            for id in ids {
                guard let b = tx.block(id), !containsProtected(id) else { continue }
                if isTrashable(b) {
                    tx.update(id) { $0.trashedAt = now }
                } else {
                    removeSubtreeKeepingPages(id, trashedAt: now, tx: tx)
                }
            }
        }
    }

    /// A block that goes to the Trash instead of being removed: a page (or row) or a database container.
    func isTrashable(_ b: Block) -> Bool {
        b.type.isPageLike || ((b.type == .databaseInline || b.type == .databasePage) && ownsDatabase(b))
    }

    /// The outermost pages and database containers below `id` (not descending into them: their content
    /// and rows travel with them).
    func nestedTrashables(below id: RecordID) -> [RecordID] {
        var out: [RecordID] = []
        var stack = Array(children(of: .block(id)).reversed())
        while let cur = stack.popLast() {
            guard let b = blocks[cur] else { continue }
            if isTrashable(b) { out.append(cur); continue }
            stack.append(contentsOf: children(of: .block(cur)).reversed())
        }
        return out
    }

    /// Hard-removes a block and its plain content, but rescues every page and database inside it:
    /// they are re-attached at the end of the page the block was on and moved to the Trash (an already
    /// trashed one keeps its date), so "Restore" brings them back with all their content. Without this a
    /// deleted toggle took its sub-pages and inline databases with it for good (BSD-99).
    func removeSubtreeKeepingPages(_ id: RecordID, trashedAt now: Date, tx: Tx) {
        let rescued = nestedTrashables(below: id)
        if !rescued.isEmpty {
            let host: ParentRef = {
                if case .block(let pid)? = blocks[id]?.parent, let page = containingPage(of: pid) { return .block(page) }
                if case .database(let did)? = blocks[id]?.parent { return .database(did) }
                return .workspace
            }()
            let keys = FractionalIndex.keys(count: rescued.count,
                                            between: children(of: host).compactMap { blocks[$0]?.sortKey }.max(), nil)
            for (rid, key) in zip(rescued, keys) {
                tx.update(rid) { blk in
                    blk.parent = host
                    blk.sortKey = key
                    if blk.trashedAt == nil { blk.trashedAt = now }
                    if host == .workspace, blk.type == .databaseInline { blk.type = .databasePage }
                }
            }
        }
        removeSubtree(id, tx: tx)
    }

    func ownsDatabase(_ b: Block) -> Bool {
        guard let db = b.props.databaseID else { return false }
        return databases[db]?.blockID == b.id
    }

    /// Hard-remove a block and everything below it (inside a transaction).
    func removeSubtree(_ id: RecordID, tx: Tx) {
        let all = [id] + descendants(of: id)
        unlinkRemovedRows(Set(all), tx: tx)
        for d in all {
            if let b = blocks[d] {
                for v in viewIDs(forBlock: d) { tx.remove(RecordKey(.view, v)) }
                if let db = b.props.databaseID, databases[db]?.blockID == d { tx.remove(RecordKey(.database, db)) }
            }
            tx.removeBlock(d)
        }
    }

    /// Sort ids by their position in the document tree.
    func documentOrder(_ ids: [RecordID]) -> [RecordID] {
        let unique = Array(Set(ids))
        guard unique.count > 1 else { return unique }
        func path(_ id: RecordID) -> [String] {
            var p: [String] = []
            var cur = blocks[id]
            var n = 0
            while let b = cur, n < 1000 {
                n += 1
                p.append(b.sortKey + "\u{1}" + b.id)
                switch b.parent {
                case .block(let pid): cur = blocks[pid]
                case .database(let did): cur = databases[did].flatMap { blocks[$0.blockID] }
                case .workspace: cur = nil
                }
            }
            return p.reversed()
        }
        let paths = Dictionary(uniqueKeysWithValues: unique.map { ($0, path($0)) })
        return unique.sorted { a, b in paths[a]!.lexicographicallyPrecedes(paths[b]!) }
    }

    // MARK: Columns

    /// Drop `ids` beside `target`, creating (or extending) a column list.
    func placeInColumn(_ ids: [RecordID], beside target: RecordID, leading: Bool) {
        guard let t = blocks[target], !ids.contains(target) else { return }
        let moving = Set(ids)
        // Columns the blocks leave: emptied ones are removed in the same undo step, like `moveBlocks`
        // (they used to stay behind as blank columns with their old width and pushed the layout apart).
        let sourceColumns = Set(ids.compactMap { id -> RecordID? in
            guard case .block(let pid) = blocks[id]?.parent, blocks[pid]?.type == .column else { return nil }
            return pid
        })
        transact("Create columns") { tx in
            if case .block(let colID) = t.parent, let col = blocks[colID], col.type == .column,
               case .block(let listID) = col.parent {
                let newCol = Block(type: .column, parent: .block(listID),
                                   sortKey: tx.sortKey(in: .block(listID), leading ? .before(colID) : .after(colID)),
                                   createdBy: userID)
                tx.put(newCol)
                let keys = FractionalIndex.keys(count: ids.count, between: nil, nil)
                for (id, k) in zip(ids, keys) { tx.update(id) { $0.parent = .block(newCol.id); $0.sortKey = k } }
                // Stored widths (often Notion's) no longer fit with a column more: share the row equally again.
                for c in contentBlocks(of: listID) { tx.update(c.id) { $0.props.ratio = nil } }
                collapseColumns(sourceColumns, moving: moving, into: .block(newCol.id), keepList: listID, tx: tx)
                return
            }
            let list = Block(type: .columnList, parent: t.parent, sortKey: tx.sortKey(in: t.parent, .after(target)),
                             createdBy: userID)
            tx.put(list)
            let c1 = Block(type: .column, parent: .block(list.id), sortKey: FractionalIndex.between(nil, nil), createdBy: userID)
            let c2 = Block(type: .column, parent: .block(list.id), sortKey: FractionalIndex.between(c1.sortKey, nil),
                           createdBy: userID)
            tx.put(c1); tx.put(c2)
            let targetCol = leading ? c2 : c1
            let movedCol = leading ? c1 : c2
            tx.update(target) { $0.parent = .block(targetCol.id); $0.sortKey = FractionalIndex.between(nil, nil) }
            let keys = FractionalIndex.keys(count: ids.count, between: nil, nil)
            for (id, k) in zip(ids, keys) { tx.update(id) { $0.parent = .block(movedCol.id); $0.sortKey = k } }
            collapseColumns(sourceColumns, moving: moving, into: .block(movedCol.id), tx: tx)
        }
    }

    /// Remove empty columns / single-column lists after moves (Notion collapses them).
    func normalizeColumns(_ listID: RecordID) {
        guard let list = blocks[listID], list.type == .columnList else { return }
        let cols = contentBlocks(of: listID)
        let empty = cols.filter { contentBlocks(of: $0.id).isEmpty }
        guard !empty.isEmpty || cols.count < 2 else { return }
        transact("Remove empty columns") { tx in
            for c in empty { tx.removeBlock(c.id) }
            let remaining = cols.filter { c in !empty.contains { $0.id == c.id } }
            if remaining.count <= 1 {
                let kids = remaining.first.map { contentBlocks(of: $0.id).map(\.id) } ?? []
                let keys = tx.sortKeys(kids.count, in: list.parent, .after(listID))
                for (k, key) in zip(kids, keys) { tx.update(k) { $0.parent = list.parent; $0.sortKey = key } }
                for c in remaining { tx.removeBlock(c.id) }
                tx.removeBlock(listID)
            }
        }
    }
}