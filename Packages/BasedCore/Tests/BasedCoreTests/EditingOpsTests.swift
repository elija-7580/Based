import Foundation
import Testing
@testable import BasedCore

/// BSD-103: the editing primitives every keystroke relies on (EditingOps), each with a normal and an edge case.
@MainActor
@Suite struct EditingOpsTests {
    func store() -> (WorkspaceStore, page: RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "test")
        return (s, s.createPage(title: "Page"))
    }

    func texts(_ s: WorkspaceStore, _ parent: RecordID) -> [String] {
        s.contentBlocks(of: parent).map(\.text.plainText)
    }

    // MARK: mergeNext

    @Test func mergeNextPullsTheNextBlockInAndKeepsItsChildren() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "Hello ", in: .block(page))
        let b = s.insertBlock(.bulletedList, text: "world", in: .block(page))
        let kid = s.insertBlock(.text, text: "nested", in: .block(b))
        let tail = s.insertBlock(.text, text: "tail", in: .block(page))
        let focus = s.mergeNext(a, pageID: page)
        #expect(focus == FocusTarget(a, 6), "caret at the old end")
        #expect(s.blocks[b] == nil)
        #expect(s.blocks[a]?.text.plainText == "Hello world")
        #expect(s.contentBlocks(of: page).map(\.id) == [a, kid, tail], "the merged block's children move up in its place")
        _ = s.undo()
        #expect(texts(s, page) == ["Hello ", "world", "tail"])
        #expect(s.contentBlocks(of: b).map(\.id) == [kid])
    }

    @Test func mergeNextAtTheLastOrBeforeANonTextBlockDoesNothing() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        _ = s.insertBlock(.divider, in: .block(page))
        let last = s.insertBlock(.text, text: "last", in: .block(page))
        #expect(s.mergeNext(a, pageID: page) == nil)
        #expect(s.mergeNext(last, pageID: page) == nil)
        #expect(texts(s, page) == ["a", "", "last"])
    }

    // MARK: turnInto

    @Test func turnIntoCodeDropsFormattingAndSetsALanguage() {
        let (s, page) = store()
        let id = s.insertBlock(.text, text: RichText(runs: [TextRun("bold", marks: Marks(bold: true)), TextRun(" plain")]), in: .block(page))
        s.turnInto([id], .code)
        let b = s.blocks[id]!
        #expect(b.type == .code)
        #expect(b.text == RichText("bold plain"), "code is plain text")
        #expect(b.props.language == "plain text")
        _ = s.undo()
        #expect(s.blocks[id]?.text.runs.first?.marks.bold == true, "undo brings the formatting back")
    }

    @Test func turnIntoTodoAndBackClearsTheCheckbox() {
        let (s, page) = store()
        let id = s.insertBlock(.text, text: "task", in: .block(page))
        s.turnInto([id], .todo)
        #expect(s.blocks[id]?.props.checked == false)
        s.setChecked(id, true)
        s.turnInto([id], .heading2, toggleable: true)
        #expect(s.blocks[id]?.props.checked == nil)
        #expect(s.blocks[id]?.props.toggleable == true)
        s.turnInto([id], .text)
        #expect(s.blocks[id]?.props.toggleable == nil)
    }

    @Test func turnIntoLeavesPagesAndUnknownBlocksAlone() {
        let (s, page) = store()
        let sub = s.createPage(title: "Sub", in: .block(page))
        s.turnInto([sub], .text)
        #expect(s.blocks[sub]?.type == .page, "a page doesn't turn into a text block (its content would vanish)")
    }

    // MARK: copySubtree / duplicate

    @Test func duplicateCopiesNestedBlocksWithNewIDs() {
        let (s, page) = store()
        let toggle = s.insertBlock(.toggle, text: "T", in: .block(page))
        let kid = s.insertBlock(.text, text: "inside", in: .block(toggle))
        _ = s.insertBlock(.text, text: "deeper", in: .block(kid))
        let copies = s.duplicateBlocks([toggle])
        #expect(copies.count == 1)
        let copy = copies[0]
        #expect(copy != toggle)
        #expect(s.contentBlocks(of: page).map(\.id) == [toggle, copy], "placed right after the original")
        let copyKid = s.contentBlocks(of: copy).first!
        #expect(copyKid.id != kid && copyKid.text.plainText == "inside")
        #expect(texts(s, copyKid.id) == ["deeper"])
        _ = s.undo()
        #expect(s.blocks[copy] == nil && s.blocks[copyKid.id] == nil, "one undo step removes the whole copy")
    }

    @Test func duplicateOfAnInlineDatabaseGetsItsOwnDatabaseViewsAndRows() {
        let (s, page) = store()
        let db = s.createDatabase(title: "Tasks", in: .block(page), inline: true, sampleRows: 0)
        _ = s.addRow(to: db.databaseID, title: "One")
        _ = s.addRow(to: db.databaseID, title: "Two")
        _ = s.addView(to: db.blockID, type: .board)
        let copy = s.duplicateBlocks([db.blockID])[0]
        let newDB = s.blocks[copy]?.props.databaseID
        #expect(newDB != nil && newDB != db.databaseID)
        #expect(s.databases[newDB!]?.blockID == copy)
        #expect(s.childBlocks(of: .database(newDB!)).map(\.text.plainText) == ["One", "Two"])
        #expect(s.childBlocks(of: .database(db.databaseID)).count == 2, "the original keeps its rows")
        let views = s.viewIDs(forBlock: copy)
        #expect(views.count == 2)
        #expect(Set(views).isDisjoint(with: s.viewIDs(forBlock: db.blockID)))
        #expect(views.allSatisfy { s.views[$0]?.blockID == copy })
    }

    // MARK: setColor / toggleOpen / setColumnRatios

    @Test func setColorSetsAndDefaultClears() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        s.setColor([a, b], .red)
        #expect(s.blocks[a]?.props.color == .red && s.blocks[b]?.props.color == .red)
        s.setColor([a], .default)
        #expect(s.blocks[a]?.props.color == nil, "default is stored as no color")
        s.setColor(["missing", b], nil)
        #expect(s.blocks[b]?.props.color == nil, "unknown ids are skipped")
    }

    @Test func toggleOpenFlipsAndIsNotAnUndoStep() {
        let (s, page) = store()
        let t = s.insertBlock(.toggle, text: "T", in: .block(page))
        s.toggleOpen(t)
        #expect(s.blocks[t]?.props.isOpen == true)
        s.toggleOpen(t)
        #expect(s.blocks[t]?.props.isOpen == false)
        s.toggleOpen(t)
        let outcome = s.undo()
        // Open/close isn't an undo step, so ⌘Z should remove the inserted toggle. Today the local toggle counts as
        // "changed elsewhere" and the insert step is dropped instead (BSD-134).
        withKnownIssue("BSD-134: undo skips a step whose block was only opened/closed since") {
            #expect(s.blocks[t] == nil, "undo removes the inserted block (\(outcome))")
        }
        s.toggleOpen("missing")   // no crash
    }

    @Test func columnRatiosNeedOneRatioPerColumn() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first { $0.type == .columnList }!
        let cols = s.contentBlocks(of: list.id).map(\.id)
        s.setColumnRatios(cols, [0.3])
        #expect(cols.allSatisfy { s.blocks[$0]?.props.ratio == nil }, "mismatched counts are ignored")
        s.setColumnRatios(cols, [0.3, 0.7])
        #expect(cols.map { s.blocks[$0]?.props.ratio } == [0.3, 0.7])
        s.setColumnRatios(cols, [0.4, 0.6])
        _ = s.undo()
        #expect(cols.map { s.blocks[$0]?.props.ratio } == [nil, nil], "a resize drag is one coalesced undo step")
    }

    // MARK: normalizeColumns

    @Test func normalizeColumnsUnwrapsTheLastColumn() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        let after = s.insertBlock(.text, text: "after", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first { $0.type == .columnList }!
        // Empty one column behind the store's back (like a remote edit), then normalize.
        let cols = s.contentBlocks(of: list.id)
        s.transact("move out", undoable: false) { tx in
            tx.update(b) { $0.parent = .block(page); $0.sortKey = FractionalIndex.between(nil, nil) }
        }
        #expect(s.contentBlocks(of: cols[1].id).isEmpty)
        s.normalizeColumns(list.id)
        #expect(s.blocks[list.id] == nil && cols.allSatisfy { s.blocks[$0.id] == nil })
        #expect(s.contentBlocks(of: page).map(\.id) == [b, a, after], "the remaining column's blocks take the list's place")
    }

    @Test func normalizeColumnsKeepsAFullRow() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first { $0.type == .columnList }!
        let before = s.blocks
        s.normalizeColumns(list.id)
        #expect(s.contentBlocks(of: list.id).count == 2)
        #expect(s.blocks == before, "nothing to clean up: no change")
        s.normalizeColumns(a)   // not a column list: no-op
        #expect(s.blocks[a] != nil)
    }

    // MARK: listNumber / listDepth

    @Test func listNumbersRestartAfterAnInterruption() {
        let (s, page) = store()
        let n1 = s.insertBlock(.numberedList, text: "1", in: .block(page))
        let n2 = s.insertBlock(.numberedList, text: "2", in: .block(page))
        _ = s.insertBlock(.text, text: "break", in: .block(page))
        let m1 = s.insertBlock(.numberedList, text: "1 again", in: .block(page))
        let m2 = s.insertBlock(.numberedList, text: "2 again", in: .block(page))
        #expect([n1, n2, m1, m2].map { s.listNumber(of: $0) } == [1, 2, 1, 2])
        let nested = s.insertBlock(.numberedList, text: "nested", in: .block(m2))
        #expect(s.listNumber(of: nested) == 1, "children count on their own")
        s.trash([n1])
        #expect(s.listNumber(of: n2) == 1, "trashed items don't count")
        #expect(s.listNumber(of: "missing") == 1)
    }

    @Test func listDepthCountsListAncestorsOnly() {
        let (s, page) = store()
        let top = s.insertBlock(.bulletedList, text: "top", in: .block(page))
        let mid = s.insertBlock(.numberedList, text: "mid", in: .block(top))
        let leaf = s.insertBlock(.todo, text: "leaf", in: .block(mid))
        #expect([top, mid, leaf].map { s.listDepth(of: $0) } == [0, 1, 2])
        let toggle = s.insertBlock(.toggle, text: "t", in: .block(page))
        let inToggle = s.insertBlock(.bulletedList, text: "x", in: .block(toggle))
        #expect(s.listDepth(of: inToggle) == 1, "a toggle list counts as a list level")
        let callout = s.insertBlock(.callout, text: "c", in: .block(page))
        let inCallout = s.insertBlock(.bulletedList, text: "y", in: .block(callout))
        #expect(s.listDepth(of: inCallout) == 0, "other containers don't")
    }

    // MARK: documentOrder / moveUp / moveDown

    @Test func documentOrderFollowsTheTreeNotTheInput() {
        let (s, page) = store()
        let a = s.insertBlock(.toggle, text: "a", in: .block(page))
        let a1 = s.insertBlock(.text, text: "a1", in: .block(a))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        #expect(s.documentOrder([b, a1, a]) == [a, a1, b])
        #expect(s.documentOrder([b, b]) == [b], "duplicates collapse")
        #expect(s.documentOrder([]) == [])
    }

    @Test func moveUpAndDownSwapWithSiblingsAndStopAtTheEnds() {
        let (s, page) = store()
        let a = s.insertBlock(.text, text: "a", in: .block(page))
        let b = s.insertBlock(.text, text: "b", in: .block(page))
        let c = s.insertBlock(.text, text: "c", in: .block(page))
        s.moveUp(c)
        #expect(s.contentBlocks(of: page).map(\.id) == [a, c, b])
        s.moveUp(a)
        #expect(s.contentBlocks(of: page).map(\.id) == [a, c, b], "first block stays")
        s.moveDown(a)
        #expect(s.contentBlocks(of: page).map(\.id) == [c, a, b])
        s.moveDown(b)
        #expect(s.contentBlocks(of: page).map(\.id) == [c, a, b], "last block stays")
        _ = s.undo()
        #expect(s.contentBlocks(of: page).map(\.id) == [a, c, b])
    }
}
