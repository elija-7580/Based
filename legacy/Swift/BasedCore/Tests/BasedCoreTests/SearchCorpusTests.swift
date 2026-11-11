import Foundation
import Testing
@testable import BasedCore

/// BSD-137: Quick Find runs over a prebuilt, folded `SearchCorpus` (off the main thread for ⌘K). The results must
/// be exactly those of the former direct scan, which is kept here as the oracle.
@MainActor
@Suite struct SearchCorpusTests {

    /// The pre-BSD-137 `SearchEngine.search` body, verbatim (oracle).
    static func legacySearch(_ store: WorkspaceStore, _ query: String, filters: SearchFilters = SearchFilters(),
                             sort: SearchSort = .bestMatch, limit: Int = 50, now: Date) -> [SearchHit] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        if q.isEmpty { return store.recentPages(limit: limit).map { SearchHit(pageID: $0.id, score: 0) } }
        let terms = q.split(separator: " ").map(String.init)
        var hits: [RecordID: SearchHit] = [:]
        func live(_ id: RecordID) -> Bool { !store.isTrashed(id) }
        func allowed(_ page: Block) -> Bool {
            if page.props.isTemplate == true { return false }
            if let by = filters.createdBy, page.createdBy != by { return false }
            if let a = filters.editedAfter, page.updatedAt < a { return false }
            if let b = filters.editedBefore, page.updatedAt > b { return false }
            if let p = filters.inPage, page.id != p, !store.isDescendant(page.id, of: p) { return false }
            return true
        }
        for b in store.blocks.values where b.type.isPageLike || (b.type == .databaseInline && store.ownsDatabase(b)) {
            guard allowed(b), live(b.id) else { continue }
            let title = store.title(of: b.id).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            guard let s = SearchEngine.titleScore(title, q, terms) else { continue }
            let recency = max(0, 10 - now.timeIntervalSince(b.updatedAt) / 86_400 / 3)
            hits[b.id] = SearchHit(pageID: b.id, score: s + recency)
        }
        if !filters.titleOnly {
            for b in store.blocks.values where !b.type.isPageLike && b.trashedAt == nil {
                var text = store.plainTextResolvingMentions(b.text)
                if let cells = b.props.cells { text += " " + cells.map(\.plainText).joined(separator: " ") }
                if let c = b.props.caption { text += " " + c.plainText }
                if let segs = b.props.segments { text += " " + segs.lazy.filter { !$0.isPartial }.map(\.text).joined(separator: " ") }
                guard !text.isEmpty else { continue }
                let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                guard terms.allSatisfy({ folded.contains($0) }) else { continue }
                guard let page = store.containingPage(of: b.id), let pb = store.blocks[page], allowed(pb), live(page) else { continue }
                let snippet = SearchEngine.snippet(text, folded, terms[0])
                if var h = hits[page] {
                    if h.snippet == nil { h.snippet = snippet; h.blockID = b.id; h.score += 5 }
                    hits[page] = h
                } else {
                    let recency = max(0, 10 - now.timeIntervalSince(pb.updatedAt) / 86_400 / 3)
                    hits[page] = SearchHit(pageID: page, score: 20 + recency, snippet: snippet, blockID: b.id)
                }
            }
            for b in store.blocks.values where b.isRow && !b.values.isEmpty {
                guard hits[b.id] == nil, allowed(b), live(b.id) else { continue }
                let text = b.values.values.compactMap { v -> String? in
                    switch v {
                    case .text(let t): return t.plainText
                    case .url(let s), .email(let s), .phone(let s): return s
                    case .place(let s): return PlaceValue.display(s)
                    default: return nil
                    }
                }.joined(separator: " ")
                let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                if !text.isEmpty, terms.allSatisfy({ folded.contains($0) }) {
                    hits[b.id] = SearchHit(pageID: b.id, score: 15, snippet: SearchEngine.snippet(text, folded, terms[0]))
                }
            }
        }
        var out = Array(hits.values)
        switch sort {
        case .bestMatch: out.sort { $0.score != $1.score ? $0.score > $1.score : store.title(of: $0.pageID) < store.title(of: $1.pageID) }
        case .lastEditedNewest: out.sort { (store.blocks[$0.pageID]?.updatedAt ?? .distantPast) > (store.blocks[$1.pageID]?.updatedAt ?? .distantPast) }
        case .lastEditedOldest: out.sort { (store.blocks[$0.pageID]?.updatedAt ?? .distantPast) < (store.blocks[$1.pageID]?.updatedAt ?? .distantPast) }
        case .createdNewest: out.sort { (store.blocks[$0.pageID]?.createdAt ?? .distantPast) > (store.blocks[$1.pageID]?.createdAt ?? .distantPast) }
        case .createdOldest: out.sort { (store.blocks[$0.pageID]?.createdAt ?? .distantPast) < (store.blocks[$1.pageID]?.createdAt ?? .distantPast) }
        }
        return Array(out.prefix(limit))
    }

    struct Fixture {
        let s: WorkspaceStore
        let roadmap: RecordID, notes: RecordID, child: RecordID, trashed: RecordID, template: RecordID
        let db: CreatedDatabase, row: RecordID
    }

    func fixture() -> Fixture {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "sc")
        let roadmap = s.createPage(title: "Roadmap Café")
        let notes = s.createPage(title: "Notes")
        s.insertBlock(.text, text: RichText(runs: [TextRun("See "), TextRun("Roadmap", mention: .page(roadmap)), TextRun(" for the plan")]), in: .block(notes))
        s.insertBlock(.text, text: RichText("Another PLAN line in notes"), in: .block(notes))
        let toggle = s.insertBlock(.toggle, text: RichText("Details"), in: .block(notes))
        s.insertBlock(.text, text: RichText("Résumé deep inside the toggle"), in: .block(toggle))
        var table = BlockProps(); table.cells = [RichText("Budget"), RichText("Zürich")]
        s.insertBlock(.text, text: RichText(""), props: table, in: .block(notes))
        let child = s.createPage(title: "Plan child", in: .block(notes))
        s.insertBlock(.text, text: RichText("child content about the café"), in: .block(child))
        let trashed = s.createPage(title: "Old plan")
        s.insertBlock(.text, text: RichText("plan in the trash"), in: .block(trashed))
        _ = s.trashPages([trashed])
        let template = s.createPage(title: "Plan template")
        s.updateBlock(template) { $0.props.isTemplate = true }
        let db = s.createDatabase(title: "Plan tracker", in: .block(notes), inline: true, sampleRows: 0)
        let link = s.addProperty(to: db.databaseID, name: "Link", type: .url)!
        let note = s.addProperty(to: db.databaseID, name: "Note", type: .text)!
        let row = s.addRow(to: db.databaseID, title: "Ship it", values: [link: .url("https://example.com/plan"), note: .text(RichText("Ëxtra notes"))])
        s.addRow(to: db.databaseID, title: "Second row", values: [note: .text(RichText("nothing"))])
        return Fixture(s: s, roadmap: roadmap, notes: notes, child: child, trashed: trashed, template: template, db: db, row: row)
    }

    static func key(_ h: [SearchHit]) -> [String] {
        h.map { "\($0.pageID)|\($0.score)|\($0.snippet ?? "-")|\($0.blockID ?? "-")" }.sorted()
    }

    @Test func sameResultsAsTheFormerScan() {
        let f = fixture()
        let now = Date()
        let engine = SearchEngine(store: f.s)
        var inPage = SearchFilters(); inPage.inPage = f.notes
        var titleOnly = SearchFilters(); titleOnly.titleOnly = true
        var editedAfter = SearchFilters(); editedAfter.editedAfter = now.addingTimeInterval(-3600)
        let queries = ["plan", "PLAN", "cafe", "café", "resume", "zurich", "budget", "roadmap", "example.com",
                       "extra", "ship", "plan child", "notes plan", "nothing here", "tracker", "  plan  "]
        for q in queries {
            for filters in [SearchFilters(), inPage, titleOnly, editedAfter] {
                for sort in SearchSort.allCases {
                    let new = engine.search(q, filters: filters, sort: sort, limit: 60, now: now)
                    let old = Self.legacySearch(f.s, q, filters: filters, sort: sort, limit: 60, now: now)
                    #expect(Self.key(new) == Self.key(old), "query \(q) sort \(sort)")
                    if sort == .bestMatch { #expect(new.map(\.score) == old.map(\.score)) }
                }
            }
        }
    }

    @Test func expectedHitsAndExclusions() {
        let f = fixture()
        let hits = SearchEngine(store: f.s).search("plan")
        let ids = Set(hits.map(\.pageID))
        #expect(ids.contains(f.notes))          // content
        #expect(ids.contains(f.child))          // title
        #expect(ids.contains(f.row))            // row value (URL)
        #expect(!ids.contains(f.trashed))       // trash stays out
        #expect(!ids.contains(f.template))      // templates stay out
        let resume = SearchEngine(store: f.s).search("RESUME")
        #expect(resume.first?.pageID == f.notes)
        #expect(resume.first?.snippet?.contains("Résumé") == true)
        // A mention counts with the target's current title.
        f.s.setText(f.roadmap, RichText("Masterplan"))
        #expect(SearchEngine(store: f.s).search("masterplan").contains { $0.pageID == f.notes })
    }

    @Test func indexIsBuiltOncePerRevision() {
        let f = fixture()
        let engine = SearchEngine(store: f.s)
        #expect(f.s.searchCorpusCache == nil)
        _ = engine.search("plan")
        let first = f.s.searchCorpusCache
        #expect(first?.revision == f.s.revision)
        _ = engine.search("notes")
        #expect(f.s.searchCorpusCache?.revision == first?.revision)
        // Every write drops the index (and its snapshot); the next search sees the change.
        let p = f.s.createPage(title: "Brand new zebra")
        #expect(f.s.searchCorpusCache == nil || f.s.searchCorpusCache?.revision == f.s.revision)
        #expect(engine.search("zebra").map(\.pageID) == [p])
        #expect(f.s.searchCorpusCache?.revision == f.s.revision)
    }

    @Test func asyncSearchMatchesAndCachesTheIndex() async {
        let f = fixture()
        let engine = SearchEngine(store: f.s)
        let now = Date()
        let a = await engine.searchAsync("plan", now: now)
        #expect(a.map(Self.key) == Self.key(Self.legacySearch(f.s, "plan", now: now)))
        #expect(f.s.searchCorpusCache?.revision == f.s.revision)
        let empty = await engine.searchAsync("   ")
        #expect(empty?.map(\.pageID) == f.s.recentPages(limit: 50).map(\.id))
    }

    @Test func cancellationStopsBuildAndScan() async {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "big")
        let page = s.createPage(title: "Big")
        s.transact("fill") { tx in
            for i in 0..<5000 {
                var b = Block(type: .text, parent: .block(page), sortKey: String(format: "a%05d", i))
                b.text = RichText("line \(i) lorem ipsum")
                tx.put(b)
            }
        }
        #expect(SearchCorpus.build(blocks: s.blocks, databases: s.databases, revision: s.revision, isCancelled: { true }) == nil)
        let corpus = SearchCorpus.build(blocks: s.blocks, databases: s.databases, revision: s.revision)!
        #expect(corpus.entryCount > 5000)
        #expect(corpus.search("lorem", isCancelled: { true }) == nil)
        #expect(corpus.search("lorem 4999")?.first?.pageID == page)
        // A cancelled caller gets nil back.
        let engine = SearchEngine(store: s)
        let task = Task { @MainActor in await engine.searchAsync("lorem") }
        task.cancel()
        #expect(await task.value == nil)
    }
}
