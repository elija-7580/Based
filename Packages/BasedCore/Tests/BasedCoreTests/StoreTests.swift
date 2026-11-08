import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct StoreTests {
    func makeStore() -> (WorkspaceStore, RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "test")
        let page = s.createPage(title: "Home")
        return (s, page)
    }

    func texts(_ s: WorkspaceStore, _ page: RecordID) -> [String] {
        s.visibleOrder(in: page).map { s.blocks[$0]!.text.plainText }
    }

    @Test func fractionalIndexOrdering() {
        var keys: [String] = []
        var lo: String? = nil
        for _ in 0..<200 { let k = FractionalIndex.between(lo, nil); keys.append(k); lo = k }
        #expect(keys == keys.sorted())
        let a = keys[10], b = keys[11]
        var mids: [String] = []
        var hi = b
        for _ in 0..<50 { let m = FractionalIndex.between(a, hi); #expect(a < m && m < hi); mids.append(m); hi = m }
        let many = FractionalIndex.keys(count: 20, between: a, b)
        #expect(many == many.sorted())
        #expect(many.allSatisfy { a < $0 && $0 < b })
    }

    @Test func insertSplitMerge() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "Hello world", in: .block(page))
        let f = s.splitBlock(a, at: 5)!
        #expect(texts(s, page) == ["Hello", " world"])
        let back = s.mergeIntoPrevious(f.id, pageID: page)!
        #expect(back == FocusTarget(a, 5))
        #expect(texts(s, page) == ["Hello world"])
    }

    @Test func enterOnListContinuesAndEmptyListBecomesText() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.todo, text: "Buy milk", in: .block(page))
        s.setChecked(a, true)
        let f = s.splitBlock(a, at: 8)!
        #expect(s.blocks[f.id]?.type == .todo)
        #expect(s.blocks[f.id]?.props.checked == false)
        _ = s.splitBlock(f.id, at: 0)
        #expect(s.blocks[f.id]?.type == .text)
    }

    @Test func headingEnterCreatesText() {
        let (s, page) = makeStore()
        let h = s.insertBlock(.heading1, text: "Title", in: .block(page))
        let f = s.splitBlock(h, at: 5)!
        #expect(s.blocks[f.id]?.type == .text)
    }

    @Test func enterAtStartInsertsAbove() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.bulletedList, text: "Item", in: .block(page))
        let f = s.splitBlock(a, at: 0)!
        #expect(f.id == a)
        #expect(texts(s, page) == ["", "Item"])
    }

    @Test func indentOutdent() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.bulletedList, text: "A", in: .block(page))
        let b = s.insertBlock(.bulletedList, text: "B", in: .block(page))
        let c = s.insertBlock(.bulletedList, text: "C", in: .block(page))
        s.indent([b, c])
        #expect(s.blocks[b]?.parent == .block(a))
        #expect(s.blocks[c]?.parent == .block(a))
        #expect(texts(s, page) == ["A", "B", "C"])
        s.outdent([b])
        #expect(s.blocks[b]?.parent == .block(page))
        #expect(s.blocks[c]?.parent == .block(b), "following siblings become children")
        #expect(texts(s, page) == ["A", "B", "C"])
    }

    @Test func undoRedoAndCoalescing() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, in: .block(page))
        s.setText(a, "H")
        s.setText(a, "He")
        s.setText(a, "Hey")
        #expect(s.undoActionName == "Typing")
        s.undo()
        #expect(s.blocks[a]?.text.plainText == "", "typing burst undone in one step")
        s.undo()
        #expect(s.blocks[a] == nil)
        s.redo()
        #expect(s.blocks[a] != nil)
        s.redo()
        #expect(s.blocks[a]?.text.plainText == "Hey")
    }

    @Test func moveDuplicateDelete() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "A", in: .block(page))
        let b = s.insertBlock(.text, text: "B", in: .block(page))
        let c = s.insertBlock(.text, text: "C", in: .block(page))
        s.moveBlocks([c], to: .block(page), at: .before(a))
        #expect(texts(s, page) == ["C", "A", "B"])
        s.moveDown(c)
        #expect(texts(s, page) == ["A", "C", "B"])
        s.moveBlocks([a, c], to: .block(page), at: .after(b))
        #expect(texts(s, page) == ["B", "A", "C"])
        let copies = s.duplicateBlocks([b])
        #expect(copies.count == 1)
        #expect(texts(s, page) == ["B", "B", "A", "C"])
        s.deleteBlocks([a])
        #expect(texts(s, page) == ["B", "B", "C"])
    }

    @Test func trashRestoreAndBacklinks() {
        let (s, page) = makeStore()
        let sub = s.createPage(title: "Sub", in: .block(page))
        #expect(s.subpages(of: page).map(\.id) == [sub])
        let other = s.createPage(title: "Other")
        let t = RichText(runs: [TextRun("see "), TextRun("Sub", mention: .page(sub))])
        s.insertBlock(.text, text: t, in: .block(other))
        #expect(s.backlinks(to: sub) == [other])
        s.trash([page])
        #expect(s.isTrashed(sub))
        #expect(s.trashedPages().map(\.id) == [page])
        s.restore([page])
        #expect(!s.isTrashed(sub))
        #expect(s.ancestors(of: sub).map(\.id) == [page])
        s.toggleFavorite(sub)
        #expect(s.favoritePages().map(\.id) == [sub])
    }

    @Test func sqlitePersistenceRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = dir.appendingPathComponent("based.sqlite")
        var pageID = ""
        do {
            let p = try SQLitePersistence(url: url)
            let s = WorkspaceStore(persistence: p, node: "a")
            pageID = s.createPage(title: "Persisted")
            s.insertBlock(.heading2, text: RichText("Bold", marks: Marks(bold: true)), in: .block(pageID))
            s.createDatabase(title: "Tasks", in: .block(pageID), inline: true)
            p.setMeta("k", Data([1, 2, 3]))
        }
        let p2 = try SQLitePersistence(url: url)
        let s2 = WorkspaceStore(persistence: p2, node: "b")
        #expect(s2.title(of: pageID) == "Persisted")
        let kids = s2.contentBlocks(of: pageID)
        #expect(kids.first?.type == .heading2)
        #expect(kids.first?.text.runs.first?.marks.bold == true)
        #expect(kids.last?.type == .databaseInline)
        #expect(s2.rows(of: kids.last!.props.databaseID!).count == 3)
        #expect(p2.meta("k") == Data([1, 2, 3]))
        try? FileManager.default.removeItem(at: dir)
    }

    @Test func remoteMergeLastWriterWins() {
        let a = WorkspaceStore(persistence: MemoryPersistence(), node: "A")
        let b = WorkspaceStore(persistence: MemoryPersistence(), node: "B")
        let page = a.createPage(title: "Shared")
        b.applyRemote(a.allRecords())
        #expect(b.title(of: page) == "Shared")
        a.setText(page, "From A")
        b.breakUndoCoalescing()
        b.setText(page, "From B") // later stamp wins
        let staleOnA = a.applyRemote(b.allRecords())
        #expect(staleOnA.isEmpty)
        #expect(a.title(of: page) == "From B")
        let staleOnB = b.applyRemote(a.allRecords())
        #expect(staleOnB.isEmpty)
        #expect(b.title(of: page) == "From B")
    }

    @Test func columns() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "Left", in: .block(page))
        let b = s.insertBlock(.text, text: "Right", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first!
        #expect(list.type == .columnList)
        #expect(s.contentBlocks(of: list.id).count == 2)
        #expect(texts(s, page).filter { !$0.isEmpty } == ["Left", "Right"])
    }

    @Test func movingLastBlockOutOfColumnRemovesIt() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "A", in: .block(page))
        let b = s.insertBlock(.text, text: "B", in: .block(page))
        let c = s.insertBlock(.text, text: "C", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first!
        s.placeInColumn([c], beside: b, leading: false)
        #expect(s.contentBlocks(of: list.id).count == 3)
        // Move B (alone in the middle column) under C: the middle column disappears.
        s.moveBlocks([b], to: s.blocks[c]!.parent, at: .after(c))
        #expect(s.contentBlocks(of: list.id).count == 2)
        // Move C's column content into A's column: one column left, so the list unwraps.
        s.moveBlocks([c, b], to: s.blocks[a]!.parent, at: .after(a))
        #expect(s.contentBlocks(of: list.id).count == 1)
        s.moveBlocks([a, c, b], to: .block(page), at: .end)
        #expect(s.blocks[list.id] == nil)
        #expect(texts(s, page).filter { !$0.isEmpty } == ["A", "C", "B"])
        // Undo restores the columns in one step.
        s.undo()
        #expect(s.blocks[list.id] != nil)
    }
}
