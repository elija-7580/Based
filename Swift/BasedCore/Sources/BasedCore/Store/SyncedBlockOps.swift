import Foundation

/// Synced blocks (BSD-41), as in Notion: an original `syncedBlock` holds the content; a copy is a `syncedBlock`
/// with `props.syncSource` = the original and no children of its own. It renders and edits the original's
/// children, so both places always show the same content. "Copy and sync" puts `based-sync:<id>` on the
/// clipboard; pasting it creates a copy.
public enum SyncedBlockClipboard {
    public static let prefix = "based-sync:"

    public static func string(for id: RecordID) -> String { prefix + id }

    /// The block ID in a "Copy and sync" clipboard string, or nil for any other text.
    public static func sourceID(in string: String) -> RecordID? {
        let s = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix(prefix) else { return nil }
        let id = String(s.dropFirst(prefix.count))
        guard !id.isEmpty, !id.contains(where: { $0.isWhitespace }) else { return nil }
        return id
    }
}

/// Why a synced copy can't be pasted somewhere.
public enum SyncedPasteProblem: Error, Equatable, Sendable {
    /// The clipboard names no synced block (or one that was deleted forever).
    case noSource
    /// Pasted right next to itself: the anchor is a copy of the same original (BSD-120). Elsewhere on the same
    /// page is fine – the editor keeps one text view per synced path, so two copies don't fight over focus.
    /// (The name is kept for source compatibility.)
    case alreadyOnPage
    /// Pasting into the synced block's own content would make it contain itself.
    case insideItself
}

@MainActor
public extension WorkspaceStore {
    /// The original of a synced block (itself for an original, `syncSource` for a copy); nil for other blocks.
    func syncedOriginal(of id: RecordID) -> RecordID? {
        guard let b = blocks[id], b.type == .syncedBlock else { return nil }
        return b.props.syncSource ?? b.id
    }

    /// Copies of an original synced block (blocks pointing at it), in no particular order.
    func syncedCopies(of original: RecordID) -> [RecordID] {
        blocks.values.filter { $0.type == .syncedBlock && $0.props.syncSource == original }.map(\.id)
    }

    /// The trashed page (or block) that hides `id`, if `id` is in the Trash; restore it to bring `id` back.
    func trashedRoot(of id: RecordID) -> RecordID? {
        var cur = blocks[id]
        var n = 0
        while let b = cur, n < 1000 {
            n += 1
            if b.trashedAt != nil { return b.id }
            cur = parentBlock(of: b.id)
        }
        return nil
    }

    /// Checks whether a copy of `source`'s original may go next to `anchor`.
    func syncedPasteProblem(source: RecordID, at anchor: RecordID) -> SyncedPasteProblem? {
        guard let original = syncedOriginal(of: source), blocks[original] != nil, blocks[anchor] != nil else { return .noSource }
        if anchor == original || isDescendant(anchor, of: original) { return .insideItself }
        if blocks[anchor]?.props.syncSource == original { return .alreadyOnPage }
        return nil
    }

    /// Pastes a synced copy of `source` (an original or a copy: the copy points at the original) right after
    /// `anchor`. An empty text block at `anchor` is replaced, like Notion pasting into an empty line.
    /// One undo step. Throws `SyncedPasteProblem`.
    @discardableResult
    func pasteSyncedCopy(of source: RecordID, at anchor: RecordID) throws -> RecordID {
        if let p = syncedPasteProblem(source: source, at: anchor) { throw p }
        let original = syncedOriginal(of: source)!
        let a = blocks[anchor]!
        let replace = a.type == .text && a.text.plainText.isEmpty && children(of: .block(anchor)).isEmpty
        return transact("Paste synced block") { tx in
            var props = BlockProps()
            props.syncSource = original
            let b = Block(type: .syncedBlock, parent: a.parent, sortKey: tx.sortKey(in: a.parent, .after(anchor)),
                          props: props, createdBy: userID)
            tx.put(b)
            if replace { tx.removeBlock(anchor) }
            return b.id
        }
    }

    /// "Unsync": the copy keeps an independent duplicate of the original's content (new IDs) and stops pointing
    /// at it. One undo step. No-op for originals and other blocks.
    func unsyncCopy(_ id: RecordID) {
        guard let b = blocks[id], b.type == .syncedBlock, let source = b.props.syncSource else { return }
        transact("Unsync") { tx in
            let kids = blocks[source] == nil ? [] : contentBlocks(of: source)
            let keys = FractionalIndex.keys(count: kids.count, between: nil, nil)
            for (k, key) in zip(kids, keys) { _ = copySubtree(k, parent: .block(id), sortKey: key, tx: tx) }
            tx.update(id) { $0.props.syncSource = nil }
        }
    }
}
