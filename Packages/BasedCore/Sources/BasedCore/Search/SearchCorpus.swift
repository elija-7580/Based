import Foundation

/// BSD-137: Quick Find's search index. Built once per store revision from a copy-on-write snapshot of the
/// workspace (`blocks`, `databases`), so it can be built and searched off the main thread. Holds every searchable
/// text already folded (case and diacritics), so a keystroke in ⌘K only runs `contains` over prepared strings
/// instead of resolving mentions and folding the whole workspace again (253–462 ms on a 47 MB workspace).
///
/// The entries keep the iteration order of the snapshot's `blocks`, so results (including which block of a page
/// provides the snippet) match the former direct scan exactly.
public struct SearchCorpus: Sendable {
    /// A page, row, database page or owned inline database (title search).
    struct TitleEntry: Sendable {
        var id: RecordID
        var folded: String
    }
    /// A non-page block with text (content search). `page` is its containing page.
    struct ContentEntry: Sendable {
        var blockID: RecordID
        var page: RecordID
        var folded: String
    }
    /// A database row with text-like property values.
    struct RowEntry: Sendable {
        var id: RecordID
        var folded: String
    }

    public let revision: Int
    let snapshot: Snapshot
    let titles: [TitleEntry]
    let contents: [ContentEntry]
    let rows: [RowEntry]

    public var entryCount: Int { titles.count + contents.count + rows.count }

    @inline(__always) static func fold(_ s: String) -> String {
        var f = s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        f.makeContiguousUTF8()
        return f
    }

    /// Byte-wise substring test on two folded strings (`String.contains` compares by grapheme and costs several
    /// times more; both sides went through the same folding, so the bytes agree whenever the text does).
    static func has(_ hay: String, _ needle: String) -> Bool {
        if needle.isEmpty { return true }
        let r = hay.utf8.withContiguousStorageIfAvailable { h in
            needle.utf8.withContiguousStorageIfAvailable { n -> Bool in
                guard n.count <= h.count, let hb = h.baseAddress, let nb = n.baseAddress else { return false }
                return memmem(hb, h.count, nb, n.count) != nil
            }
        }
        if let r, let r { return r }
        return hay.contains(needle)
    }

    /// Builds the index. Pure function of the snapshot: safe on any thread. Returns nil when `isCancelled` fires.
    public static func build(blocks: [RecordID: Block], databases: [RecordID: Database], revision: Int,
                             isCancelled: () -> Bool = { false }) -> SearchCorpus? {
        let snap = Snapshot(blocks: blocks, databases: databases)
        var titles: [TitleEntry] = []
        var contents: [ContentEntry] = []
        var rows: [RowEntry] = []
        var trashed: [RecordID: Bool] = [:]
        func isLive(_ id: RecordID) -> Bool {
            if let t = trashed[id] { return !t }
            let t = snap.isTrashed(id)
            trashed[id] = t
            return !t
        }
        var n = 0
        for b in blocks.values {
            n += 1
            if n & 1023 == 0, isCancelled() { return nil }
            if b.type.isPageLike || (b.type == .databaseInline && snap.ownsDatabase(b)) {
                if isLive(b.id) { titles.append(TitleEntry(id: b.id, folded: fold(snap.title(of: b.id)))) }
            }
            if !b.type.isPageLike && b.trashedAt == nil {
                let text = snap.contentText(b)
                if !text.isEmpty, let page = snap.containingPage(of: b.id), blocks[page] != nil, isLive(page) {
                    contents.append(ContentEntry(blockID: b.id, page: page, folded: fold(text)))
                }
            }
            if b.isRow && !b.values.isEmpty, isLive(b.id) {
                let text = Snapshot.rowText(b)
                if !text.isEmpty { rows.append(RowEntry(id: b.id, folded: fold(text))) }
            }
        }
        return SearchCorpus(revision: revision, snapshot: snap, titles: titles, contents: contents, rows: rows)
    }

    /// The search itself (see `SearchEngine.search`). Pure function: safe on any thread. An empty query returns
    /// no hits (the caller shows recent pages). Returns nil when `isCancelled` fires.
    public func search(_ query: String, filters: SearchFilters = SearchFilters(), sort: SearchSort = .bestMatch,
                       limit: Int = 50, now: Date = Date(), isCancelled: () -> Bool = { false }) -> [SearchHit]? {
        let q = Self.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        if q.isEmpty { return [] }
        let terms = q.split(separator: " ").map { t -> String in var s = String(t); s.makeContiguousUTF8(); return s }
        let blocks = snapshot.blocks
        func allowed(_ page: Block) -> Bool {
            if page.props.isTemplate == true { return false }
            if let by = filters.createdBy, page.createdBy != by { return false }
            if let a = filters.editedAfter, page.updatedAt < a { return false }
            if let b = filters.editedBefore, page.updatedAt > b { return false }
            if let p = filters.inPage, page.id != p, !snapshot.isDescendant(page.id, of: p) { return false }
            return true
        }
        func recency(_ b: Block) -> Double { max(0, 10 - now.timeIntervalSince(b.updatedAt) / 86_400 / 3) }
        var hits: [RecordID: SearchHit] = [:]
        var n = 0
        // Titles
        for e in titles {
            n += 1
            if n & 4095 == 0, isCancelled() { return nil }
            guard let b = blocks[e.id], allowed(b), let s = SearchEngine.titleScore(e.folded, q, terms) else { continue }
            hits[e.id] = SearchHit(pageID: e.id, score: s + recency(b))
        }
        if !filters.titleOnly {
            // Content
            for e in contents {
                n += 1
                if n & 4095 == 0, isCancelled() { return nil }
                guard terms.allSatisfy({ Self.has(e.folded, $0) }) else { continue }
                guard let pb = blocks[e.page], allowed(pb) else { continue }
                if var h = hits[e.page] {
                    if h.snippet == nil, let b = blocks[e.blockID] {
                        h.snippet = SearchEngine.snippet(snapshot.contentText(b), e.folded, terms[0])
                        h.blockID = e.blockID
                        h.score += 5
                    }
                    hits[e.page] = h
                } else if let b = blocks[e.blockID] {
                    hits[e.page] = SearchHit(pageID: e.page, score: 20 + recency(pb),
                                             snippet: SearchEngine.snippet(snapshot.contentText(b), e.folded, terms[0]),
                                             blockID: e.blockID)
                }
            }
            // Property values of rows
            for e in rows {
                n += 1
                if n & 4095 == 0, isCancelled() { return nil }
                guard hits[e.id] == nil, let b = blocks[e.id], allowed(b), terms.allSatisfy({ Self.has(e.folded, $0) }) else { continue }
                hits[e.id] = SearchHit(pageID: e.id, score: 15, snippet: SearchEngine.snippet(Snapshot.rowText(b), e.folded, terms[0]))
            }
        }
        var out = Array(hits.values)
        switch sort {
        case .bestMatch:
            var titleCache: [RecordID: String] = [:]
            func t(_ id: RecordID) -> String {
                if let c = titleCache[id] { return c }
                let v = snapshot.title(of: id)
                titleCache[id] = v
                return v
            }
            out.sort { $0.score != $1.score ? $0.score > $1.score : t($0.pageID) < t($1.pageID) }
        case .lastEditedNewest: out.sort { (blocks[$0.pageID]?.updatedAt ?? .distantPast) > (blocks[$1.pageID]?.updatedAt ?? .distantPast) }
        case .lastEditedOldest: out.sort { (blocks[$0.pageID]?.updatedAt ?? .distantPast) < (blocks[$1.pageID]?.updatedAt ?? .distantPast) }
        case .createdNewest: out.sort { (blocks[$0.pageID]?.createdAt ?? .distantPast) > (blocks[$1.pageID]?.createdAt ?? .distantPast) }
        case .createdOldest: out.sort { (blocks[$0.pageID]?.createdAt ?? .distantPast) < (blocks[$1.pageID]?.createdAt ?? .distantPast) }
        }
        return Array(out.prefix(limit))
    }

    /// The store's hierarchy helpers (`PageOps`, `EditingOps`) as pure functions of a snapshot.
    struct Snapshot: Sendable {
        let blocks: [RecordID: Block]
        let databases: [RecordID: Database]

        func parentBlock(of b: Block) -> Block? {
            switch b.parent {
            case .workspace: return nil
            case .block(let pid): return blocks[pid]
            case .database(let did): return databases[did].flatMap { blocks[$0.blockID] }
            }
        }

        func isTrashed(_ id: RecordID) -> Bool {
            var cur = blocks[id]
            var n = 0
            while let b = cur, n < 1000 {
                n += 1
                if b.trashedAt != nil { return true }
                switch b.parent {
                case .workspace: return false
                case .block(let pid): cur = blocks[pid]; if cur == nil { return true }
                case .database(let did):
                    guard let owner = databases[did]?.blockID else { return true }
                    cur = blocks[owner]
                    if cur == nil { return true }
                }
            }
            return false
        }

        func containingPage(of id: RecordID) -> RecordID? {
            var cur = blocks[id]
            var n = 0
            while let b = cur, n < 1000 {
                n += 1
                if b.type.isPageLike { return b.id }
                cur = parentBlock(of: b)
            }
            return nil
        }

        func isDescendant(_ id: RecordID, of ancestor: RecordID) -> Bool {
            var cur = blocks[id]?.parent
            var guardCount = 0
            while let p = cur, guardCount < 10_000 {
                guardCount += 1
                switch p {
                case .workspace: return false
                case .block(let pid):
                    if pid == ancestor { return true }
                    cur = blocks[pid]?.parent
                case .database(let did):
                    guard let owner = databases[did]?.blockID else { return false }
                    if owner == ancestor { return true }
                    cur = blocks[owner]?.parent
                }
            }
            return false
        }

        func ownsDatabase(_ b: Block) -> Bool {
            guard let db = b.props.databaseID else { return false }
            return databases[db]?.blockID == b.id
        }

        func title(of id: RecordID) -> String {
            guard let b = blocks[id] else { return "Untitled" }
            if b.type == .databasePage || b.type == .databaseInline, let db = b.props.databaseID.flatMap({ databases[$0] }) {
                let t = db.title.plainText
                return t.isEmpty ? "Untitled" : t
            }
            let t = b.text.plainText.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? "Untitled" : t
        }

        func plainTextResolvingMentions(_ rt: RichText) -> String {
            rt.hasMentions ? rt.resolvingMentions { blocks[$0] != nil ? title(of: $0) : nil }.plainText : rt.plainText
        }

        /// Searchable text of a non-page block: text (mentions with current titles, BSD-40), table cells, caption,
        /// final transcript segments.
        func contentText(_ b: Block) -> String {
            var text = plainTextResolvingMentions(b.text)
            if let cells = b.props.cells { text += " " + cells.map(\.plainText).joined(separator: " ") }
            if let c = b.props.caption { text += " " + c.plainText }
            if let segs = b.props.segments { text += " " + segs.lazy.filter { !$0.isPartial }.map(\.text).joined(separator: " ") }
            return text
        }

        static func rowText(_ b: Block) -> String {
            b.values.values.compactMap { v -> String? in
                switch v {
                case .text(let t): return t.plainText
                case .url(let s), .email(let s), .phone(let s): return s
                case .place(let s): return PlaceValue.display(s)
                default: return nil
                }
            }.joined(separator: " ")
        }
    }
}
