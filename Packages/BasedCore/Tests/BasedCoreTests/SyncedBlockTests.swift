import Foundation
import Testing
@testable import BasedCore

/// BSD-41: "Copy and sync" → paste creates a synced copy that shows and edits the original's content.
@MainActor
@Suite struct SyncedBlockTests {
    func setup() -> (WorkspaceStore, original: RecordID, line: RecordID, other: RecordID, anchor: RecordID) {
        let s = WorkspaceStore()
        let a = s.createPage(title: "A")
        let original = s.insertBlock(.syncedBlock, in: .block(a))
        let line = s.insertBlock(.text, text: "shared", in: .block(original))
        let b = s.createPage(title: "B")
        let anchor = s.insertBlock(.text, text: "before", in: .block(b))
        return (s, original, line, b, anchor)
    }

    @Test func clipboardFormat() {
        #expect(SyncedBlockClipboard.sourceID(in: SyncedBlockClipboard.string(for: "abc")) == "abc")
        #expect(SyncedBlockClipboard.sourceID(in: "  based-sync:abc\n") == "abc")
        #expect(SyncedBlockClipboard.sourceID(in: "based-sync:") == nil)
        #expect(SyncedBlockClipboard.sourceID(in: "based-sync:a b") == nil)
        #expect(SyncedBlockClipboard.sourceID(in: "hello based-sync:abc") == nil)
    }

    @Test func pastedCopyShowsAndEditsTheOriginal() throws {
        let (s, original, line, page, anchor) = setup()
        let copy = try s.pasteSyncedCopy(of: original, at: anchor)
        let c = try #require(s.blocks[copy])
        #expect(c.type == .syncedBlock && c.props.syncSource == original)
        #expect(c.parent == .block(page))
        #expect(s.childBlocks(of: .block(page)).map(\.id) == [anchor, copy])
        #expect(s.children(of: .block(copy)).isEmpty)                  // no content of its own
        // An edit "through the copy" is an edit of the original's child: visible in both places.
        s.setText(line, RichText("changed"))
        #expect(s.contentBlocks(of: c.props.syncSource!).map(\.text.plainText) == ["changed"])
        #expect(s.syncedCopies(of: original) == [copy])
        // Pasting a copy's clipboard links to the original, not to the copy.
        let p3 = s.createPage(title: "C")
        let a3 = s.insertBlock(.text, text: "x", in: .block(p3))
        let copy2 = try s.pasteSyncedCopy(of: copy, at: a3)
        #expect(s.blocks[copy2]?.props.syncSource == original)
    }

    @Test func emptyLineIsReplacedAndUndoIsOneStep() throws {
        let (s, original, _, page, anchor) = setup()
        let empty = s.insertBlock(.text, after: anchor)!
        let copy = try s.pasteSyncedCopy(of: original, at: empty)
        #expect(s.blocks[empty] == nil)
        #expect(s.childBlocks(of: .block(page)).map(\.id) == [anchor, copy])
        _ = s.undo()
        #expect(s.blocks[copy] == nil)
        #expect(s.blocks[empty] != nil)
    }

    @Test func refusedOnTheSamePageAndInsideItself() throws {
        let (s, original, line, page, anchor) = setup()
        #expect(throws: SyncedPasteProblem.insideItself) { try s.pasteSyncedCopy(of: original, at: line) }
        let origPage = s.containingPage(of: original)!
        let next = s.insertBlock(.text, text: "y", in: .block(origPage))
        #expect(throws: SyncedPasteProblem.alreadyOnPage) { try s.pasteSyncedCopy(of: original, at: next) }
        _ = try s.pasteSyncedCopy(of: original, at: anchor)
        let more = s.insertBlock(.text, text: "z", in: .block(page))
        #expect(throws: SyncedPasteProblem.alreadyOnPage) { try s.pasteSyncedCopy(of: original, at: more) }
        #expect(throws: SyncedPasteProblem.noSource) { try s.pasteSyncedCopy(of: "missing", at: more) }
        #expect(throws: SyncedPasteProblem.noSource) { try s.pasteSyncedCopy(of: anchor, at: more) }   // not a synced block
    }

    @Test func unsyncMakesAnIndependentCopy() throws {
        let (s, original, line, _, anchor) = setup()
        let copy = try s.pasteSyncedCopy(of: original, at: anchor)
        s.unsyncCopy(copy)
        #expect(s.blocks[copy]?.props.syncSource == nil)
        let own = s.contentBlocks(of: copy)
        #expect(own.map(\.text.plainText) == ["shared"])
        #expect(own.first?.id != line)
        s.setText(line, RichText("original only"))
        #expect(s.contentBlocks(of: copy).map(\.text.plainText) == ["shared"])
        _ = s.undo()   // the edit
        _ = s.undo()   // the unsync, in one step
        #expect(s.blocks[copy]?.props.syncSource == original)
        #expect(s.children(of: .block(copy)).isEmpty)
    }

    @Test func trashedOriginalIsReported() throws {
        let (s, original, _, _, anchor) = setup()
        let copy = try s.pasteSyncedCopy(of: original, at: anchor)
        let origPage = s.containingPage(of: original)!
        #expect(s.trashedRoot(of: original) == nil)
        s.trashPages([origPage])
        #expect(s.trashedRoot(of: s.blocks[copy]!.props.syncSource!) == origPage)
        s.restorePages([origPage])
        #expect(s.trashedRoot(of: original) == nil)
    }
}
