import Foundation

/// BSD-104: blocks whose parent is gone after a sync (e.g. the parent page was deleted forever on one device while
/// a child was edited later on another: the newer child wins against the older tombstone, its parent doesn't).
/// Such a block is in the store but reachable from nowhere. `rescueOrphans` makes it visible in the Trash:
/// pages (and database rows whose database is gone) move to the top level and into the Trash; other blocks move
/// into one collecting page, "Recovered blocks", which itself sits in the Trash. Restoring it brings them back.
/// Nothing is deleted.
@MainActor
public extension WorkspaceStore {
    /// ID of the collecting page. Fixed, so devices that rescue the same orphans end up with one page
    /// (last writer wins on the page record) instead of one per device.
    static let recoveredBlocksPageID: RecordID = "recovered-blocks"

    /// Blocks among `candidates` whose parent block / database doesn't exist. Blocks that are themselves inside
    /// such a block are not listed (they come along with it).
    func orphanedBlocks(among candidates: some Sequence<RecordID>) -> [RecordID] {
        var out: [RecordID] = []
        var seen = Set<RecordID>()
        for id in candidates where seen.insert(id).inserted {
            guard let b = blocks[id] else { continue }
            switch b.parent {
            case .workspace: continue
            case .block(let pid): if blocks[pid] == nil { out.append(id) }
            case .database(let did): if databases[did] == nil { out.append(id) }
            }
        }
        return out.sorted()
    }

    /// Candidates for `rescueOrphans` after a remote batch: the arriving blocks and the children of arriving
    /// deletions (a parent deleted remotely can strand local children that weren't in the batch).
    func orphanCandidates(records: [Record], deletions: [RecordKey]) -> [RecordID] {
        var ids: [RecordID] = []
        for r in records { if case .block(let b) = r { ids.append(b.id) } }
        for k in deletions {
            switch k.kind {
            case .block: ids.append(contentsOf: children(of: .block(k.id)))
            case .database: ids.append(contentsOf: children(of: .database(k.id)))
            default: break
            }
        }
        return ids
    }

    /// Moves orphaned blocks among `candidates` into the Trash (see type comment). One transaction, not undoable,
    /// logged as a local change so other devices get the same, visible state. Returns the rescued block IDs.
    @discardableResult
    func rescueOrphans(among candidates: some Sequence<RecordID>, now: Date = Date()) -> [RecordID] {
        let orphans = orphanedBlocks(among: candidates)
        guard !orphans.isEmpty else { return [] }
        let pages = orphans.filter { blocks[$0]?.type.isPageLike == true }
        let loose = orphans.filter { blocks[$0]?.type.isPageLike != true }
        transact("Recover orphaned blocks", undoable: false) { tx in
            for id in pages {
                let key = tx.sortKey(in: .workspace, .end)
                tx.update(id) { b in
                    b.parent = .workspace
                    b.sortKey = key
                    b.props.teamspace = nil
                    if b.trashedAt == nil { b.trashedAt = now }
                }
            }
            guard !loose.isEmpty else { return }
            let holder = Self.recoveredBlocksPageID
            // An existing collecting page is used as it is (in the Trash, or wherever the user restored it to).
            if tx.block(holder) == nil {
                tx.put(Block(id: holder, type: .page, parent: .workspace, sortKey: tx.sortKey(in: .workspace, .end),
                             text: RichText("Recovered blocks"), createdBy: userID))
                tx.update(holder) { $0.trashedAt = now }
            }
            for id in loose {
                let key = tx.sortKey(in: .block(holder), .end)
                tx.update(id) { b in
                    b.parent = .block(holder)
                    b.sortKey = key
                }
            }
        }
        Log.warning("Recovered \(orphans.count) orphaned blocks into the Trash", category: "sync")
        return orphans
    }
}
