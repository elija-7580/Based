import Foundation
import Testing
@testable import BasedCore

/// BSD-104: blocks whose parent is missing after a remote batch move into the Trash instead of staying invisible.
@MainActor
@Suite struct OrphanRescueTests {
    /// A remote batch brings a subpage, a text block (with a child) and a row whose parents this store doesn't have.
    @Test func orphansFromARemoteBatchLandInTheTrash() throws {
        let s = WorkspaceStore()
        let other = WorkspaceStore()
        let page = other.createPage(title: "Gone")
        let sub = other.createPage(title: "Sub", in: .block(page))
        let line = other.insertBlock(.text, text: "keep", in: .block(page))
        let nested = other.insertBlock(.text, text: "nested", in: .block(line))
        let db = other.createDatabase(title: "Tasks", in: .block(page), inline: true, sampleRows: 0).databaseID
        let row = other.createPage(title: "Row", in: .database(db))
        let batch: [Record] = [sub, line, nested, row].map { .block(other.blocks[$0]!) }
        s.applyRemote(batch)
        #expect(s.isTrashed(sub))      // invisible: parent missing

        let rescued = s.rescueOrphans(among: s.orphanCandidates(records: batch, deletions: []))
        #expect(Set(rescued) == [sub, line, row])        // `nested` comes along with `line`
        let holder = WorkspaceStore.recoveredBlocksPageID
        let trash = s.trashedPages().map(\.id)
        #expect(trash.contains(sub) && trash.contains(row) && trash.contains(holder))
        #expect(s.blocks[sub]?.parent == .workspace)
        #expect(s.blocks[line]?.parent == .block(holder))
        #expect(s.blocks[nested]?.parent == .block(line))
        #expect(s.orphanedBlocks(among: s.blocks.keys).isEmpty)

        // Restorable, and nothing to undo (it's not a user action).
        s.restorePages([sub, holder])
        #expect(!s.isTrashed(sub) && !s.isTrashed(nested))
        #expect(s.blocks[nested]?.text.plainText == "nested")
    }

    /// Children stranded by a remote deletion of their parent (not part of the batch) are found too; a second
    /// rescue reuses the collecting page.
    @Test func childrenOfARemotelyDeletedParentAreFound() throws {
        let s = WorkspaceStore()
        let page = s.createPage(title: "P")
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        s.applyRemote([], deletions: [RecordKey(.block, page)])
        let cands = s.orphanCandidates(records: [], deletions: [RecordKey(.block, page)])
        #expect(cands == [a])
        #expect(s.rescueOrphans(among: cands) == [a])
        let page2 = s.createPage(title: "P2")
        let b = s.insertBlock(.text, text: "b", in: .block(page2))
        s.applyRemote([], deletions: [RecordKey(.block, page2)])
        s.rescueOrphans(among: s.orphanCandidates(records: [], deletions: [RecordKey(.block, page2)]))
        #expect(s.childBlocks(of: .block(WorkspaceStore.recoveredBlocksPageID)).map(\.id) == [a, b])
        // Nothing orphaned → no transaction, no change.
        #expect(s.rescueOrphans(among: [a, b]).isEmpty)
    }
}
