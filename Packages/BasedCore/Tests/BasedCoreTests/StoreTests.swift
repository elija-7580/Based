import XCTest
@testable import BasedCore

@MainActor
final class StoreTests: XCTestCase {
    func makeStore() -> (WorkspaceStore, RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "test")
        let page = s.createPage(title: "Home")
        return (s, page)
    }

    func texts(_ s: WorkspaceStore, _ page: RecordID) -> [String] {
        s.visibleOrder(in: page).map { s.blocks[$0]!.text.plainText }
    }

    func testFractionalIndexOrdering() {
        var keys: [String] = []
        var lo: String? = nil
        for _ in 0..<200 { let k = FractionalIndex.between(lo, nil); keys.append(k); lo = k }
        XCTAssertEqual(keys, keys.sorted())
        let a = keys[10], b = keys[11]
        var mids: [String] = []
        var hi = b
        for _ in 0..<50 { let m = FractionalIndex.between(a, hi); XCTAssert(a < m && m < hi); mids.append(m); hi = m }
        let many = FractionalIndex.keys(count: 20, between: a, b)
        XCTAssertEqual(many, many.sorted())
        XCTAssert(many.allSatisfy { a < $0 && $0 < b })
    }

    func testInsertSplitMerge() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "Hello world", in: .block(page))
        let f = s.splitBlock(a, at: 5)!
        XCTAssertEqual(texts(s, page), ["Hello", " world"])
        let back = s.mergeIntoPrevious(f.id, pageID: page)!
        XCTAssertEqual(back, FocusTarget(a, 5))
        XCTAssertEqual(texts(s, page), ["Hello world"])
    }

    func testEnterOnListContinuesAndEmptyListBecomesText() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.todo, text: "Buy milk", in: .block(page))
        s.setChecked(a, true)
        let f = s.splitBlock(a, at: 8)!
        XCTAssertEqual(s.blocks[f.id]?.type, .todo)
        XCTAssertEqual(s.blocks[f.id]?.props.checked, false)
        _ = s.splitBlock(f.id, at: 0)
        XCTAssertEqual(s.blocks[f.id]?.type, .text)
    }

    func testHeadingEnterCreatesText() {
        let (s, page) = makeStore()
        let h = s.insertBlock(.heading1, text: "Title", in: .block(page))
        let f = s.splitBlock(h, at: 5)!
        XCTAssertEqual(s.blocks[f.id]?.type, .text)
    }

    func testEnterAtStartInsertsAbove() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.bulletedList, text: "Item", in: .block(page))
        let f = s.splitBlock(a, at: 0)!
        XCTAssertEqual(f.id, a)
        XCTAssertEqual(texts(s, page), ["", "Item"])
    }

    func testIndentOutdent() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.bulletedList, text: "A", in: .block(page))
        let b = s.insertBlock(.bulletedList, text: "B", in: .block(page))
        let c = s.insertBlock(.bulletedList, text: "C", in: .block(page))
        s.indent([b, c])
        XCTAssertEqual(s.blocks[b]?.parent, .block(a))
        XCTAssertEqual(s.blocks[c]?.parent, .block(a))
        XCTAssertEqual(texts(s, page), ["A", "B", "C"])
        s.outdent([b])
        XCTAssertEqual(s.blocks[b]?.parent, .block(page))
        XCTAssertEqual(s.blocks[c]?.parent, .block(b), "following siblings become children")
        XCTAssertEqual(texts(s, page), ["A", "B", "C"])
    }

    func testUndoRedoAndCoalescing() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, in: .block(page))
        s.setText(a, "H")
        s.setText(a, "He")
        s.setText(a, "Hey")
        XCTAssertEqual(s.undoActionName, "Typing")
        s.undo()
        XCTAssertEqual(s.blocks[a]?.text.plainText, "", "typing burst undone in one step")
        s.undo()
        XCTAssertNil(s.blocks[a])
        s.redo()
        XCTAssertNotNil(s.blocks[a])
        s.redo()
        XCTAssertEqual(s.blocks[a]?.text.plainText, "Hey")
    }

    func testMoveDuplicateDelete() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "A", in: .block(page))
        let b = s.insertBlock(.text, text: "B", in: .block(page))
        let c = s.insertBlock(.text, text: "C", in: .block(page))
        s.moveBlocks([c], to: .block(page), at: .before(a))
        XCTAssertEqual(texts(s, page), ["C", "A", "B"])
        s.moveDown(c)
        XCTAssertEqual(texts(s, page), ["A", "C", "B"])
        s.moveBlocks([a, c], to: .block(page), at: .after(b))
        XCTAssertEqual(texts(s, page), ["B", "A", "C"])
        let copies = s.duplicateBlocks([b])
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(texts(s, page), ["B", "B", "A", "C"])
        s.deleteBlocks([a])
        XCTAssertEqual(texts(s, page), ["B", "B", "C"])
    }

    func testTrashRestoreAndBacklinks() {
        let (s, page) = makeStore()
        let sub = s.createPage(title: "Sub", in: .block(page))
        XCTAssertEqual(s.subpages(of: page).map(\.id), [sub])
        let other = s.createPage(title: "Other")
        let t = RichText(runs: [TextRun("see "), TextRun("Sub", mention: .page(sub))])
        s.insertBlock(.text, text: t, in: .block(other))
        XCTAssertEqual(s.backlinks(to: sub), [other])
        s.trash([page])
        XCTAssertTrue(s.isTrashed(sub))
        XCTAssertEqual(s.trashedPages().map(\.id), [page])
        s.restore([page])
        XCTAssertFalse(s.isTrashed(sub))
        XCTAssertEqual(s.ancestors(of: sub).map(\.id), [page])
        s.toggleFavorite(sub)
        XCTAssertEqual(s.favoritePages().map(\.id), [sub])
    }

    func testSQLitePersistenceRoundTrip() throws {
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
        XCTAssertEqual(s2.title(of: pageID), "Persisted")
        let kids = s2.contentBlocks(of: pageID)
        XCTAssertEqual(kids.first?.type, .heading2)
        XCTAssertEqual(kids.first?.text.runs.first?.marks.bold, true)
        XCTAssertEqual(kids.last?.type, .databaseInline)
        XCTAssertEqual(s2.rows(of: kids.last!.props.databaseID!).count, 3)
        XCTAssertEqual(p2.meta("k"), Data([1, 2, 3]))
        try? FileManager.default.removeItem(at: dir)
    }

    func testRemoteMergeLastWriterWins() {
        let a = WorkspaceStore(persistence: MemoryPersistence(), node: "A")
        let b = WorkspaceStore(persistence: MemoryPersistence(), node: "B")
        let page = a.createPage(title: "Shared")
        b.applyRemote(a.allRecords())
        XCTAssertEqual(b.title(of: page), "Shared")
        a.setText(page, "From A")
        b.breakUndoCoalescing()
        b.setText(page, "From B") // later stamp wins
        let staleOnA = a.applyRemote(b.allRecords())
        XCTAssertTrue(staleOnA.isEmpty)
        XCTAssertEqual(a.title(of: page), "From B")
        let staleOnB = b.applyRemote(a.allRecords())
        XCTAssertTrue(staleOnB.isEmpty)
        XCTAssertEqual(b.title(of: page), "From B")
    }

    func testColumns() {
        let (s, page) = makeStore()
        let a = s.insertBlock(.text, text: "Left", in: .block(page))
        let b = s.insertBlock(.text, text: "Right", in: .block(page))
        s.placeInColumn([b], beside: a, leading: false)
        let list = s.contentBlocks(of: page).first!
        XCTAssertEqual(list.type, .columnList)
        XCTAssertEqual(s.contentBlocks(of: list.id).count, 2)
        XCTAssertEqual(texts(s, page).filter { !$0.isEmpty }, ["Left", "Right"])
    }
}