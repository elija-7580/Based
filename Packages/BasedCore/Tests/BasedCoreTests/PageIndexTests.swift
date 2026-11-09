import Foundation
import Testing
@testable import BasedCore

/// BSD-38: page lists come from incrementally maintained indexes instead of scanning every block.
@MainActor
@Suite struct PageIndexTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    /// Full scans – what the indexes must always equal.
    func check(_ s: WorkspaceStore, _ note: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
        let pages = Set(s.blocks.values.filter { $0.type.isPageLike }.map(\.id))
        let trashed = Set(s.blocks.values.filter { $0.trashedAt != nil }.map(\.id))
        #expect(s.pageIDs == pages, "pageIDs \(note)", sourceLocation: sourceLocation)
        #expect(s.trashedIDs == trashed, "trashedIDs \(note)", sourceLocation: sourceLocation)
        #expect(Set(s.allPages().map(\.id)) == Set(s.blocks.values.filter { $0.type.isPageLike && !s.isTrashed($0.id) }.map(\.id)),
                "allPages \(note)", sourceLocation: sourceLocation)
        for id in pages {
            #expect(s.subpages(of: id).map(\.id) == s.scanSubpages(of: id).map(\.id), "subpages \(note)", sourceLocation: sourceLocation)
        }
        let recent = s.blocks.values.filter { $0.type.isPageLike && !s.isTrashed($0.id) }
            .sorted { $0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : $0.id < $1.id }.prefix(20).map(\.id)
        #expect(s.recentPages(limit: 20).map(\.id) == Array(recent), "recentPages \(note)", sourceLocation: sourceLocation)
    }

    @Test func randomOperationsKeepIndexesEqualToAFullScan() {
        let s = store()
        var rng = PageIndexRandom(seed: 38)
        var pages: [RecordID] = [s.createPage(title: "Root")]
        for step in 0..<400 {
            let target = pages[Int(rng.next() % UInt64(pages.count))]
            switch rng.next() % 11 {
            case 0, 1: pages.append(s.createPage(title: RichText("P\(step)"), in: .block(target)))
            case 2: s.insertBlock(.text, text: RichText("t\(step)"), in: .block(target))
            case 3:
                let toggle = s.insertBlock(.toggle, text: "toggle", in: .block(target))
                pages.append(s.createPage(title: RichText("in toggle \(step)"), in: .block(toggle)))
            case 4: s.renamePage(target, to: "Renamed \(step)")
            case 5: s.trash([target])
            case 6: s.restore([target])
            case 7: if let other = pages.randomElement(using: &rng), other != target { s.movePage(target, to: .block(other)) }
            case 8: s.undo()
            case 9: s.redo()
            default:
                let db = s.createDatabase(title: RichText("DB\(step)"), in: .block(target), inline: rng.next() % 2 == 0, sampleRows: 2)
                pages.append(db.blockID)
            }
            if step % 25 == 0 { check(s, "after step \(step)") }
        }
        check(s, "end")
        s.deleteForever(Array(s.trashedIDs))
        check(s, "after delete forever")
    }

    @Test func remoteChangesAndReloadUpdateTheIndexes() {
        let a = store()
        let page = a.createPage(title: "Shared")
        let sub = a.createPage(title: "Sub", in: .block(page))
        a.trash([sub])
        let b = WorkspaceStore(persistence: MemoryPersistence(a.allRecords()), node: "b")   // bulk-load path
        check(b, "bulk load")
        #expect(b.trashedIDs.contains(sub))
        // Remote: restore + new page arrive by sync.
        a.restore([sub])
        let fresh = a.createPage(title: "New", in: .block(page))
        _ = b.applyRemote([a.blocks[sub]!, a.blocks[fresh]!].map(Record.block))
        check(b, "after applyRemote")
        #expect(b.subpages(of: page).map(\.id) == [sub, fresh])
    }

    @Test func typingDoesNotInvalidateTheSubpageCache() {
        let s = store()
        let page = s.createPage(title: "Long page")
        let para = s.insertBlock(.text, text: "", in: .block(page))
        _ = s.createPage(title: "Child", in: .block(page))
        _ = s.subpages(of: page)
        let structure = s.hierarchyRevision
        for i in 0..<50 { s.setText(para, RichText("typed \(i)")) }
        s.renamePage(page, to: "Retitled")
        #expect(s.hierarchyRevision == structure, "text and title edits are not structural")
        #expect(s.subpages(of: page).map { $0.text.plainText } == ["Child"])
        s.renamePage(s.subpages(of: page)[0].id, to: "Child renamed")
        #expect(s.subpages(of: page).map { $0.text.plainText } == ["Child renamed"], "cached ids, current blocks")
    }

    /// BSD-117: the app's registry bumps `structureRevision` only when `hierarchyRevision` moves, so page titles
    /// and icons must not move it, while everything that changes the sidebar tree (incl. the teamspace) must.
    @Test func pageMetadataIsNotStructuralButTheSidebarSectionIs() {
        let s = store()
        let team = s.createTeamspace(name: "Team")
        let page = s.createPage(title: "Top")
        let rev = s.hierarchyRevision
        for i in 0..<20 { s.renamePage(page, to: "Top \(i)") }
        s.setPageIcon(page, .emoji("🚀"))
        #expect(s.hierarchyRevision == rev, "title and icon edits are page metadata")
        s.transact("teamspace only") { tx in tx.update(page) { $0.props.teamspace = team } }
        #expect(s.hierarchyRevision != rev, "a top-level page changing sidebar section is structural")
        #expect(s.topLevelPages(in: .teamspace(team)).map(\.id) == [page])
        let afterMove = s.hierarchyRevision
        s.trash([page])
        #expect(s.hierarchyRevision != afterMove, "trashing is structural")
    }

    @Test func backlinksOfALargeWorkspaceDoNotScanOnTheMainActor() async {
        let s = store()
        let target = s.createPage(title: "Target")
        let source = s.createPage(title: "Source")
        s.insertBlock(.text, text: RichText(runs: [TextRun("see "), TextRun("Target", mention: .page(target))]), in: .block(source))
        // Pretend the workspace is huge: the first call must not build the index synchronously.
        s.transact("filler", undoable: false) { tx in
            for i in 0..<(WorkspaceStore.synchronousLinkIndexLimit + 1) {
                tx.put(Block(type: .text, parent: .block(source), sortKey: "z\(i)", text: ""))
            }
        }
        #expect(!s.isLinkIndexReady)
        #expect(s.backlinks(to: target).isEmpty, "empty until the background index is ready")
        #expect(s.backlinks(to: target, waitForIndex: true) == [source], "tools can insist on an answer")
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            s.prepareLinkIndexInBackground { c.resume() }
        }
        #expect(s.isLinkIndexReady)
        #expect(s.backlinks(to: target) == [source])
    }

    /// Acceptance benchmark (BSD-38): 50k blocks, 2000 pages; 1000 title edits each followed by
    /// `recentPages(limit: 20)` + `subpages(of:)`. Run with BASED_BENCH=1; prints the time of the old full-scan
    /// approach too (Linux debug, 2 CPUs: ~170 ms now vs. several seconds before).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BASED_BENCH"] != nil))
    func titleEditsWithPageListsBenchmark() {
        let s = store()
        var records: [Record] = []
        var pageIDs: [RecordID] = []
        let root = s.createPage(title: "Root")
        for p in 0..<2_000 {
            let id = RecordIDs.make()
            pageIDs.append(id)
            records.append(.block(Block(id: id, type: .page, parent: .block(p < 50 ? root : pageIDs[p % 50]),
                                        sortKey: "p\(p)", text: RichText("Page \(p)"))))
            for k in 0..<24 {
                records.append(.block(Block(type: .text, parent: .block(id), sortKey: "b\(k)", text: RichText("Block \(k)"))))
            }
        }
        _ = s.applyRemote(records)
        #expect(s.blocks.count >= 50_000)
        let start = Date()
        for i in 0..<1_000 {
            s.renamePage(pageIDs[i % 50], to: "Edited \(i)")
            _ = s.recentPages(limit: 20)
            _ = s.subpages(of: root)
        }
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        var t = Date()
        for i in 0..<1_000 { s.renamePage(pageIDs[i % 50], to: "Again \(i)") }
        let renameMs = Int(Date().timeIntervalSince(t) * 1000)
        t = Date()
        for i in 0..<1_000 { s.renamePage(pageIDs[i % 50], to: "Third \(i)"); _ = s.recentPages(limit: 20) }
        let recentMs = Int(Date().timeIntervalSince(t) * 1000) - renameMs
        print("BENCH BSD-38 parts: rename \(renameMs) ms, recentPages \(recentMs) ms")
        // What recentPages + subpages did before BSD-38 (full scan per revision), for the record.
        t = Date()
        for i in 0..<1_000 {
            s.renamePage(pageIDs[i % 50], to: "Old \(i)")
            var c: [(date: Date, id: RecordID)] = []
            for b in s.blocks.values where b.type.isPageLike && b.trashedAt == nil { c.append((b.updatedAt, b.id)) }
            c.sort { $0.date != $1.date ? $0.date > $1.date : $0.id < $1.id }
            _ = s.scanSubpages(of: root)
        }
        print("BENCH BSD-38 before (full scans): \(Int(Date().timeIntervalSince(t) * 1000)) ms")
        print("BENCH BSD-38 1000 title edits + recentPages + subpages: \(ms) ms (\(s.blocks.count) blocks, \(s.pageIDs.count) pages)")
    }
}

/// Small deterministic generator for reproducible random operation sequences.
struct PageIndexRandom: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
