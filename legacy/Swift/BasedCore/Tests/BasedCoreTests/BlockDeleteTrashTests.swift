import Foundation
import Testing
@testable import BasedCore

/// BSD-99: deleting an ordinary block must not destroy the pages and databases nested inside it.
@MainActor
struct BlockDeleteTrashTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    @Test func toggleWithSubpageMovesSubpageToTrash() {
        let s = store()
        let page = s.createPage(title: "Host")
        s.insertBlock(.text, text: "before", in: .block(page))
        let toggle = s.insertBlock(.toggle, text: "Details", in: .block(page))
        s.insertBlock(.text, text: "plain", in: .block(toggle))
        let sub = s.createPage(title: "Sub", in: .block(toggle))
        let body = s.insertBlock(.text, text: "sub body", in: .block(sub))
        let grand = s.createPage(title: "Grand", in: .block(sub))

        s.deleteBlocks([toggle])

        #expect(s.blocks[toggle] == nil)
        #expect(s.blocks[sub] != nil)
        #expect(s.blocks[sub]?.trashedAt != nil)
        #expect(s.blocks[sub]?.parent == .block(page))
        #expect(s.trashedPages().map(\.id) == [sub])
        #expect(s.blocks[body]?.text.plainText == "sub body")
        #expect(s.blocks[grand] != nil)

        // Restore brings the sub-page back on the host page with all its content.
        s.restorePages([sub])
        #expect(s.blocks[sub]?.trashedAt == nil)
        #expect(s.blocks[sub]?.parent == .block(page))
        #expect(s.subpages(of: page).map(\.id) == [sub])
        #expect(s.subpages(of: sub).map(\.id) == [grand])
    }

    @Test func calloutWithInlineDatabaseMovesDatabaseWithRowsToTrash() {
        let s = store()
        let page = s.createPage(title: "Host")
        let callout = s.insertBlock(.callout, text: "Note", in: .block(page))
        let db = s.createDatabase(title: "Tasks", in: .block(callout), inline: true, sampleRows: 2)
        let rows = s.children(of: .database(db.databaseID))
        #expect(rows.count == 2)

        s.deleteBlocks([callout])

        #expect(s.blocks[callout] == nil)
        #expect(s.blocks[db.blockID]?.trashedAt != nil)
        #expect(s.blocks[db.blockID]?.parent == .block(page))
        #expect(s.databases[db.databaseID] != nil)
        #expect(s.views[db.viewID] != nil)
        #expect(s.children(of: .database(db.databaseID)) == rows)

        s.restorePages([db.blockID])
        #expect(s.blocks[db.blockID]?.trashedAt == nil)
        #expect(s.blocks[db.blockID]?.type == .databaseInline)
    }

    @Test func undoRestoresTheOriginalTree() {
        let s = store()
        let page = s.createPage(title: "Host")
        let col = s.insertBlock(.toggle, text: "T", in: .block(page))
        let inner = s.insertBlock(.text, text: "inner", in: .block(col))
        let sub = s.createPage(title: "Sub", in: .block(col))
        let db = s.createDatabase(title: "DB", in: .block(col), inline: true, sampleRows: 1)
        let before = s.children(of: .block(col))

        s.deleteBlocks([col])
        s.undo()

        #expect(s.blocks[col] != nil)
        #expect(s.blocks[inner]?.parent == .block(col))
        #expect(s.blocks[sub]?.parent == .block(col))
        #expect(s.blocks[sub]?.trashedAt == nil)
        #expect(s.blocks[db.blockID]?.trashedAt == nil)
        #expect(s.children(of: .block(col)) == before)
        #expect(s.trashedPages().isEmpty)
    }

    @Test func alreadyTrashedNestedPageKeepsItsDateAndPlainBlocksStillGo() {
        let s = store()
        let page = s.createPage(title: "Host")
        let toggle = s.insertBlock(.toggle, text: "T", in: .block(page))
        let plain = s.insertBlock(.text, text: "x", in: .block(toggle))
        let old = s.createPage(title: "Old", in: .block(toggle))
        s.trashPages([old])
        let date = s.blocks[old]?.trashedAt

        s.deleteBlocks([toggle])

        #expect(s.blocks[plain] == nil)
        #expect(s.blocks[old]?.trashedAt == date)
        #expect(s.blocks[old]?.parent == .block(page))
    }

    @Test func deleteForeverStillRemovesEverything() {
        let s = store()
        let page = s.createPage(title: "Host")
        let toggle = s.insertBlock(.toggle, text: "T", in: .block(page))
        let sub = s.createPage(title: "Sub", in: .block(toggle))
        s.deleteBlocks([toggle])
        s.deleteForever([sub])
        #expect(s.blocks[sub] == nil)
        #expect(s.trashedPages().isEmpty)
    }
}
