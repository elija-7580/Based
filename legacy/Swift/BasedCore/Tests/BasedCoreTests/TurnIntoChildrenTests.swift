import Foundation
import Testing
@testable import BasedCore

/// BSD-100: turning a block with children into code / equation keeps the children visible.
@MainActor
@Suite struct TurnIntoChildrenTests {
    func fixture() -> (WorkspaceStore, RecordID, RecordID, [RecordID], RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "ti")
        let page = s.createPage(title: "P")
        let parent = s.insertBlock(.text, text: RichText("Parent"), in: .block(page))
        let k1 = s.insertBlock(.text, text: RichText("Kid 1"), in: .block(parent))
        let k2 = s.insertBlock(.bulletedList, text: RichText("Kid 2"), in: .block(parent))
        let after = s.insertBlock(.text, text: RichText("After"), in: .block(page))
        return (s, page, parent, [k1, k2], after)
    }

    @Test(arguments: [BlockType.code, .equation, .divider])
    func childrenBecomeSiblingsBelowTheBlock(_ type: BlockType) {
        let (s, page, parent, kids, after) = fixture()
        s.turnInto([parent], type)
        #expect(s.blocks[parent]!.type == type)
        #expect(s.contentBlocks(of: page).map(\.id) == [parent] + kids + [after])
        #expect(s.children(of: .block(parent)).isEmpty)

        _ = s.undo()
        #expect(s.blocks[parent]!.type == .text)
        #expect(s.contentBlocks(of: parent).map(\.id) == kids)
        #expect(s.contentBlocks(of: page).map(\.id) == [parent, after])
    }

    @Test func containerTypesKeepTheirChildren() {
        let (s, _, parent, kids, _) = fixture()
        s.turnInto([parent], .toggle)
        #expect(s.contentBlocks(of: parent).map(\.id) == kids)
    }

    @Test func repairShowsChildrenHiddenEarlier() {
        let (s, page, parent, kids, after) = fixture()
        // As written before the fix: the type changed, the children stayed underneath.
        s.transact("old turn into") { tx in tx.update(parent) { $0.type = .code } }
        #expect(s.liftHiddenChildren() == [parent])
        #expect(s.contentBlocks(of: page).map(\.id) == [parent] + kids + [after])
        #expect(s.liftHiddenChildren().isEmpty)
        #expect(!WorkspaceStore.hidesChildren(.button))
    }
}
