import Foundation
import Testing
@testable import BasedCore

/// Sidebar / Trash / Library flows (Swift Testing, so they also run on Linux toolchains where
/// main-actor XCTest classes can't be discovered).
@MainActor
struct PageManagementTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    func titles(_ s: WorkspaceStore, _ pages: [Block]) -> [String] { pages.map { s.title(of: $0.id) } }

    @Test func deleteUndoRestoreDeletePermanently() {
        let s = store()
        let parent = s.createPage(title: "Projects")
        let child = s.createPage(title: "Alpha", in: .block(parent))
        let grandchild = s.createPage(title: "Notes", in: .block(child))
        s.insertBlock(.text, text: "body", in: .block(grandchild))

        // Delete → parent and everything inside leave the tree, only the root is listed in Trash.
        #expect(s.trashPages([parent]) == [parent])
        #expect(s.isTrashed(child) && s.isTrashed(grandchild))
        #expect(s.topLevelPages().isEmpty)
        #expect(s.trashedPages().map(\.id) == [parent])
        #expect(Set(s.trashedDescendantPages(of: parent)) == [child, grandchild])

        // Undo (toast) → back in place with its children.
        s.undo()
        #expect(!s.isTrashed(parent) && !s.isTrashed(grandchild))
        #expect(titles(s, s.topLevelPages()) == ["Projects"])
        #expect(s.subpages(of: parent).map(\.id) == [child])

        // Delete again → restore from the Trash brings the subtree back.
        s.trashPages([parent])
        s.restorePages([parent])
        #expect(!s.isTrashed(grandchild))
        #expect(s.trashedPages().isEmpty)

        // Delete permanently removes every record of the subtree.
        s.trashPages([parent])
        s.deleteForever([parent])
        #expect(s.blocks[parent] == nil && s.blocks[child] == nil && s.blocks[grandchild] == nil)
        #expect(s.trashedPages().isEmpty)
    }

    @Test func bulkTrashSkipsNestedSelectionAndIsOneUndoStep() {
        let s = store()
        let a = s.createPage(title: "A")
        let a1 = s.createPage(title: "A1", in: .block(a))
        let b = s.createPage(title: "B")
        s.clearUndoHistory()
        #expect(Set(s.trashPages([a1, a, b])) == [a, b])   // a1 travels with a
        #expect(s.blocks[a1]?.trashedAt == nil && s.isTrashed(a1))
        s.undo()
        #expect(s.topLevelPages().count == 2 && !s.canUndo)
    }

    @Test func restoreChildWhoseParentIsStillInTrashMovesToTopLevel() {
        let s = store()
        let p = s.createPage(title: "Parent")
        let c = s.createPage(title: "Child", in: .block(p))
        s.trashPages([c])
        s.trashPages([p])
        s.restorePages([c])
        #expect(s.blocks[c]?.parent == .workspace)
        #expect(titles(s, s.topLevelPages()) == ["Child"])
        // A separately trashed child is not resurrected by restoring its parent.
        let p2 = s.createPage(title: "P2")
        let c2 = s.createPage(title: "C2", in: .block(p2))
        s.trashPages([c2]); s.trashPages([p2]); s.restorePages([p2])
        #expect(s.isTrashed(c2) && !s.isTrashed(p2))
    }

    @Test func moveSingleAndSeveralPages() {
        let s = store()
        let target = s.createPage(title: "Target")
        let one = s.createPage(title: "One")
        let two = s.createPage(title: "Two")
        let three = s.createPage(title: "Three")
        s.movePages([one], to: .page(target))
        #expect(s.subpages(of: target).map(\.id) == [one])
        s.clearUndoHistory()
        s.movePages([three, two], to: .page(target))
        #expect(s.subpages(of: target).map(\.id) == [one, two, three])   // document order kept
        s.undo()                                                           // one undo step for the bulk move
        #expect(titles(s, s.topLevelPages()) == ["Target", "Two", "Three"])
        // Never into itself or a descendant.
        s.movePages([target], to: .page(one))
        #expect(s.blocks[target]?.parent == .workspace)
        // Back to the top level.
        s.movePages([one], to: .privateTop, at: .start)
        #expect(titles(s, s.topLevelPages()).first == "One")
    }

    @Test func dragAndDropNestsAndReorders() {
        let s = store()
        let a = s.createPage(title: "A")
        let b = s.createPage(title: "B")
        let c = s.createPage(title: "C")
        #expect(s.dropPages([c], onto: a, zone: .inside))
        #expect(s.subpages(of: a).map(\.id) == [c])
        #expect(s.dropPages([b], onto: c, zone: .after))          // reorder inside A, next to C
        #expect(s.subpages(of: a).map(\.id) == [c, b])
        #expect(s.dropPages([b], onto: c, zone: .before))
        #expect(s.subpages(of: a).map(\.id) == [b, c])
        #expect(!s.dropPages([a], onto: b, zone: .inside))        // would nest a page into its own child
        #expect(s.dropPages([b], onto: a, zone: .before))         // back to the top level, above A
        #expect(titles(s, s.topLevelPages()) == ["B", "A"])
    }

    @Test func teamspacesGroupTopLevelPages() {
        let s = store()
        let t1 = s.createTeamspace(name: "HQ")
        let t2 = s.createTeamspace(name: "Lab")
        let home1 = s.createPage(title: "Teamspace Home")
        let home2 = s.createPage(title: "Teamspace Home")
        let mine = s.createPage(title: "Journal")
        s.movePages([home1], to: .teamspace(t1))
        s.movePages([home2], to: .teamspace(t2))
        #expect(s.topLevelPages(in: .teamspace(t1)).map(\.id) == [home1])
        #expect(s.topLevelPages(in: .teamspace(t2)).map(\.id) == [home2])
        #expect(s.topLevelPages(in: .privatePages).map(\.id) == [mine])
        // Dropping next to a teamspace page joins that teamspace.
        s.dropPages([mine], onto: home1, zone: .after)
        #expect(s.topLevelPages(in: .teamspace(t1)).map(\.id) == [home1, mine])
        // Nesting clears the section; deleting a teamspace keeps its pages (in Private).
        s.movePages([mine], to: .page(home1))
        #expect(s.blocks[mine]?.props.teamspace == nil)
        s.deleteTeamspace(t2)
        #expect(s.topLevelPages(in: .privatePages).map(\.id) == [home2])
        #expect(s.teamspaces.map(\.name) == ["HQ"])
    }

    @Test func duplicatePagesNextToEachOriginal() {
        let s = store()
        let a = s.createPage(title: "A")
        let inner = s.createPage(title: "Inner", in: .block(a))
        let b = s.createPage(title: "B")
        let copies = s.duplicatePages([inner, b])
        #expect(copies.count == 2)
        #expect(titles(s, s.subpages(of: a)) == ["Inner", "Inner (1)"])
        #expect(titles(s, s.topLevelPages()) == ["A", "B", "B (1)"])
    }

    @Test func libraryListsFiltersAndSorts() {
        let s = store()
        let brain = s.createPage(title: "Agent Brain")
        let mem = s.createDatabase(title: "Memories", in: .block(brain), inline: true, sampleRows: 0)
        let skills = s.createDatabase(title: "Skills", in: .block(brain), inline: true, sampleRows: 0)
        s.addRow(to: mem.databaseID, title: "Prefers short answers")
        s.addRow(to: skills.databaseID, title: "Proofread")
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        s.addRow(to: tasks.databaseID, title: "Ship it")
        let page = s.createPage(title: "Journal")
        let gone = s.createPage(title: "Old", in: .block(page))
        s.trashPages([gone])

        let items = s.libraryItems(memoriesDB: mem.databaseID, skillsDB: skills.databaseID)
        func kinds(_ title: String) -> LibraryKind? { items.first { $0.title == title }?.kind }
        #expect(kinds("Prefers short answers") == .memory)
        #expect(kinds("Proofread") == .skill)
        #expect(kinds("Ship it") == .row)
        #expect(kinds("Tasks") == .database)
        #expect(kinds("Memories") == .database)
        #expect(kinds("Journal") == .page)
        #expect(kinds("Old") == nil)                              // trashed items are only in Trash
        #expect(items.first { $0.title == "Ship it" }?.location == "Tasks")
        #expect(items.first { $0.title == "Journal" }?.location == "Private")

        var q = LibraryQuery()
        q.kinds = [.memory, .skill]
        q.sort = .title; q.ascending = true
        #expect(s.filterLibrary(items, q).map(\.title) == ["Prefers short answers", "Proofread"])
        q = LibraryQuery(); q.text = "ship"
        #expect(s.filterLibrary(items, q).map(\.title) == ["Ship it"])
        q = LibraryQuery(); q.location = .topLevel; q.sort = .title; q.ascending = true
        #expect(s.filterLibrary(items, q).map(\.title) == ["Agent Brain", "Journal", "Tasks"])
        q = LibraryQuery(); q.edited = .older
        #expect(s.filterLibrary(items, q).isEmpty)
    }

    @Test func duplicateDiagnosisTellsDistinctPagesFromIndexBugs() {
        let s = store()
        // Two different Notion pages (one per teamspace) that share a title, imported twice.
        for _ in 0..<2 {
            let builder = ImportBuilder()
            for id in ["24b618c1167e8314bb6d01dc04b6a6e2", "278618c1167e802097f3f76d81b908b8"] {
                builder.add(Block(id: ImportIDs.notion(id)!, type: .page, parent: .workspace, sortKey: "", text: "Teamspace Home"), root: true)
            }
            s.commitImport(builder)
        }
        #expect(s.childIndexDuplicates().isEmpty)                 // re-import never lists a page twice
        #expect(s.topLevelPages().count == 2)
        let report = s.duplicateTitleReport()
        #expect(report.count == 1)
        #expect(report.first?.cause == .distinctPages)

        // A local copy with identical content is reported as a copy.
        let x = s.createPage(title: "Log")
        s.insertBlock(.text, text: "same", in: .block(x))
        let y = s.createPage(title: "Log")
        s.insertBlock(.text, text: "same", in: .block(y))
        #expect(s.duplicateTitleReport().first { $0.title == "Log" }?.cause == .copies)

        var q = LibraryQuery(); q.onlyDuplicateTitles = true
        #expect(s.filterLibrary(s.libraryItems(), q).count == 4)
    }

    @Test func renameAndBulkFavorites() {
        let s = store()
        let a = s.createPage(title: "A")
        let db = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        s.renamePage(a, to: "Alpha")
        s.renamePage(db.blockID, to: "Todos")
        #expect(s.title(of: a) == "Alpha" && s.title(of: db.blockID) == "Todos")
        s.setFavorite([a, db.blockID], true)
        s.setFavorite([a], true)
        #expect(s.workspace.favorites == [a, db.blockID])
        s.setFavorite([a, db.blockID], false)
        #expect(s.workspace.favorites.isEmpty)
    }

    @Test func workspaceWithoutTeamspacesStillDecodes() throws {
        var w = Workspace()
        w.teamspaces = nil
        let data = try JSONEncoder().encode(w)
        let json = String(decoding: data, as: UTF8.self)
        #expect(!json.contains("teamspaces"))
        let back = try JSONDecoder().decode(Workspace.self, from: data)
        #expect(back.teamspaces == nil)
        var p = BlockProps(); p.teamspace = "t1"
        let pb = try JSONDecoder().decode(BlockProps.self, from: JSONEncoder().encode(p))
        #expect(pb.teamspace == "t1")
    }

    @Test func newPageInTeamspaceIsOneUndoStep() {
        let s = store()
        let t = s.createTeamspace(name: "Engineering")
        let id = s.createTopLevelPage(in: .teamspace(t), title: "Roadmap")
        #expect(s.topLevelPages(in: .teamspace(t)).map(\.id) == [id])
        #expect(s.topLevelPages(in: .privatePages).isEmpty)
        s.undo()
        #expect(s.topLevelPages().isEmpty)
        #expect(s.teamspace(t) != nil)
    }
}
