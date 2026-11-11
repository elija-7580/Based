import Foundation
import Testing
@testable import BasedCore

/// BSD-27: undo/redo only revert what is still as the step left it; remote changes are neither overwritten
/// nor deleted records revived.
@MainActor
@Suite struct UndoRemoteTests {
    /// A copy of `id` as another device would send it: edited there, with a newer stamp.
    func remoteEdit(_ s: WorkspaceStore, _ id: RecordID, text: String) -> Record {
        var b = s.blocks[id]!
        b.text = RichText(text)
        b.stamp = Stamp(millis: b.stamp.millis + 60_000, counter: 0, node: "zz-other")
        return .block(b)
    }

    func remoteDelete(_ s: WorkspaceStore, _ id: RecordID) {
        let st = s.blocks[id]!.stamp
        s.applyRemote([], deletions: [RecordKey(.block, id)],
                      deletionStamps: [RecordKey(.block, id): Stamp(millis: st.millis + 60_000, counter: 0, node: "zz-other")])
    }

    @Test func undoKeepsARemoteEditOfTheSameBlock() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "one", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.setText(line, "two")
        s.applyRemote([remoteEdit(s, line, text: "from the other Mac")])
        let r = s.undo()
        #expect(s.blocks[line]?.text.plainText == "from the other Mac")
        #expect(r.applied == 0 && r.skipped == 1 && r.droppedSteps == 1)
        #expect(!s.canUndo && !s.canRedo)
    }

    @Test func undoOfALocalDeleteStillRestores() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "keep me", in: .block(page), at: .end)
        let other = s.insertBlock(.text, text: "unrelated", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.deleteBlocks([line])
        // Something unrelated changes remotely meanwhile.
        s.applyRemote([remoteEdit(s, other, text: "changed remotely")])
        let r = s.undo()
        #expect(s.blocks[line]?.text.plainText == "keep me")
        #expect(r.skipped == 0 && r.applied >= 1)
        #expect(s.blocks[other]?.text.plainText == "changed remotely")
    }

    @Test func undoNeverRevivesARemotelyDeletedBlock() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "one", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.setText(line, "two")
        remoteDelete(s, line)
        #expect(s.blocks[line] == nil)
        s.undo()
        #expect(s.blocks[line] == nil)
    }

    @Test func partialUndoAcrossTwoBlocksAndRedo() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let a = s.insertBlock(.text, text: "a", in: .block(page), at: .end)
        let b = s.insertBlock(.text, text: "b", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.updateBlocks([a, b]) { $0.props.color = .red }
        s.applyRemote([remoteEdit(s, b, text: "b remote")])

        let r = s.undo()
        #expect(r.partial && r.applied == 1 && r.skipped == 1)
        #expect(s.blocks[a]?.props.color == nil)
        #expect(s.blocks[b]?.props.color == .red)
        #expect(s.blocks[b]?.text.plainText == "b remote")

        // Redo covers only what was undone.
        let rr = s.redo()
        #expect(rr.applied == 1 && rr.skipped == 0)
        #expect(s.blocks[a]?.props.color == .red)
        #expect(s.blocks[b]?.text.plainText == "b remote")
    }

    @Test func redoSkipsWhatChangedRemotelyAfterTheUndo() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "one", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.setText(line, "two")
        s.undo()
        #expect(s.blocks[line]?.text.plainText == "one")
        s.applyRemote([remoteEdit(s, line, text: "remote")])
        let r = s.redo()
        #expect(r.applied == 0 && r.skipped == 1)
        #expect(s.blocks[line]?.text.plainText == "remote")
    }

    @Test func chainedLocalUndoRedoStillWorks() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "0", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.setText(line, "1")
        s.breakUndoCoalescing()
        s.setText(line, "2")
        s.breakUndoCoalescing()
        s.setText(line, "3")
        s.undo(); s.undo(); s.undo()
        #expect(s.blocks[line]?.text.plainText == "0")
        s.redo(); s.redo()
        #expect(s.blocks[line]?.text.plainText == "2")
        s.undo()
        #expect(s.blocks[line]?.text.plainText == "1")
        #expect(s.undo().skipped == 0)
        #expect(s.blocks[line]?.text.plainText == "0")
    }

    @Test func fullySkippedStepFallsThroughToTheNextOne() {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let a = s.insertBlock(.text, text: "a", in: .block(page), at: .end)
        let b = s.insertBlock(.text, text: "b", in: .block(page), at: .end)
        s.clearUndoHistory()
        s.setText(a, "a2")
        s.breakUndoCoalescing()
        s.setText(b, "b2")
        s.applyRemote([remoteEdit(s, b, text: "b remote")])
        let r = s.undo()
        #expect(r.droppedSteps == 1 && r.applied == 1)
        #expect(s.blocks[a]?.text.plainText == "a")
        #expect(s.blocks[b]?.text.plainText == "b remote")
    }
}
