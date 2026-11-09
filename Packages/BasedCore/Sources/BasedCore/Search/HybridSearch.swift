import Foundation

// MARK: Sections

@MainActor
public extension WorkspaceStore {
    /// A page cut into sections for the semantic index (BSD-62): the title, a database row's text values, then the
    /// page's blocks in document order (nested blocks included, sub-page content not), packed along block
    /// boundaries into pieces of about `maxChars`. A single longer block is split at word boundaries.
    func semanticChunks(of page: RecordID, maxChars: Int = 800) -> [String] {
        guard let p = blocks[page] else { return [] }
        var parts: [String] = []
        let title = self.title(of: page).trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { parts.append(title) }
        if p.isRow, !p.values.isEmpty {
            let values = p.values.values.compactMap { v -> String? in
                switch v {
                case .text(let t): return t.plainText
                case .url(let s), .email(let s), .phone(let s): return s
                case .place(let s): return PlaceValue.display(s)
                default: return nil
                }
            }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !values.isEmpty { parts.append(values) }
        }
        for b in versionBlocks(of: page).dropFirst() {
            if b.type.isPageLike {
                // A sub-page reads like a link: its title only.
                let t = self.title(of: b.id)
                if !t.isEmpty { parts.append(t) }
                continue
            }
            var text = plainTextResolvingMentions(b.text)
            if let cells = b.props.cells { text += " " + cells.map(\.plainText).joined(separator: " ") }
            if let c = b.props.caption { text += " " + c.plainText }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { parts.append(text) }
        }
        return Self.pack(parts, maxChars: maxChars)
    }

    /// Joins parts with newlines into pieces of at most `maxChars` (a longer part is cut at word boundaries).
    nonisolated static func pack(_ parts: [String], maxChars: Int) -> [String] {
        let limit = max(40, maxChars)
        var out: [String] = []
        var cur = ""
        func flush() { if !cur.isEmpty { out.append(cur); cur = "" } }
        for part in parts {
            if part.count > limit {
                flush()
                var piece = ""
                for word in part.split(separator: " ", omittingEmptySubsequences: true) {
                    if !piece.isEmpty, piece.count + 1 + word.count > limit { out.append(piece); piece = "" }
                    if word.count > limit {
                        // One giant "word" (base64, URLs …): hard cut.
                        var w = Substring(word)
                        while w.count > limit { out.append(String(w.prefix(limit))); w = w.dropFirst(limit) }
                        piece = String(w)
                    } else {
                        piece += piece.isEmpty ? String(word) : " " + word
                    }
                }
                if !piece.isEmpty { out.append(piece) }
                continue
            }
            if !cur.isEmpty, cur.count + 1 + part.count > limit { flush() }
            cur += cur.isEmpty ? part : "\n" + part
        }
        flush()
        return out
    }

    /// Pages the semantic index covers: live pages and database rows, no templates, not the agent brain's
    /// internal pages when `excluding` names their root.
    func semanticIndexablePages(excluding roots: Set<RecordID> = []) -> [RecordID] {
        blocks.values.compactMap { b -> RecordID? in
            guard b.type.isPageLike, b.trashedAt == nil, b.props.isTemplate != true, !isTrashed(b.id) else { return nil }
            if roots.contains(b.id) || roots.contains(where: { isDescendant(b.id, of: $0) }) { return nil }
            return b.id
        }.sorted()
    }

    /// Content hash of a section, as the index stores it.
    nonisolated static func sectionHash(_ text: String) -> String { VersionHistory.hash(Data(text.utf8)) }
}

// MARK: Indexer

/// Keeps a `SemanticIndex` in step with the workspace (BSD-62): re-embeds a page only when its sections changed,
/// drops pages that were deleted. The app calls `update` in the background (low priority, debounced after edits).
@MainActor
public final class SemanticIndexer {
    public let store: WorkspaceStore
    public let context: SemanticContext
    /// Pages below these roots are never indexed (e.g. the agent brain).
    public var excludedRoots: Set<RecordID>
    public var maxChars = 800
    /// Texts per `embed` call.
    public var batchSize = 16

    public init(store: WorkspaceStore, context: SemanticContext, excludedRoots: Set<RecordID> = []) {
        self.store = store
        self.context = context
        self.excludedRoots = excludedRoots
    }

    public struct Report: Equatable, Sendable {
        public var embedded = 0
        public var unchanged = 0
        public var removed = 0
        public var failed = 0
    }

    /// Brings `pages` (nil = the whole workspace) up to date. With nil, pages no longer in the workspace are
    /// removed from the index too.
    @discardableResult
    public func update(pages: [RecordID]? = nil) async -> Report {
        var report = Report()
        let indexable = Set(store.semanticIndexablePages(excluding: excludedRoots))
        let targets = pages ?? indexable.sorted()
        if pages == nil {
            for gone in context.index.pageIDs.subtracting(indexable) { context.index.remove(page: gone); report.removed += 1 }
        }
        for page in targets {
            if Task.isCancelled { break }
            guard indexable.contains(page) else {
                if !context.index.hashes(of: page).isEmpty { context.index.remove(page: page); report.removed += 1 }
                continue
            }
            let texts = store.semanticChunks(of: page, maxChars: maxChars)
            let hashes = texts.map { WorkspaceStore.sectionHash($0) }
            if hashes == context.index.hashes(of: page) { report.unchanged += 1; continue }
            if texts.isEmpty { context.index.remove(page: page); report.removed += 1; continue }
            do {
                var vectors: [[Float]] = []
                for start in stride(from: 0, to: texts.count, by: max(1, batchSize)) {
                    let batch = Array(texts[start..<min(texts.count, start + max(1, batchSize))])
                    vectors += try await context.provider.embed(batch)
                }
                if context.index.replace(page: page, texts: texts, hashes: hashes, vectors: vectors) {
                    report.embedded += 1
                } else {
                    report.failed += 1
                }
            } catch {
                report.failed += 1
            }
        }
        return report
    }
}

// MARK: Hybrid search

/// Search by words and by meaning (BSD-62): the keyword results of `SearchEngine` and the semantic hits of the
/// index are merged with Reciprocal Rank Fusion, so a page found both ways ranks highest and a page that only
/// matches in meaning ("Wie synchronisieren Geräte?" → the sync docs) still shows up.
@MainActor
public struct HybridSearch {
    public let store: WorkspaceStore
    public let semantic: SemanticContext?
    /// Semantic hits below this cosine similarity are ignored (keeps unrelated pages out of short result lists).
    public var minSimilarity: Float = 0.25

    public init(store: WorkspaceStore, semantic: SemanticContext?) {
        self.store = store
        self.semantic = semantic
    }

    public func search(_ query: String, filters: SearchFilters = SearchFilters(), sort: SearchSort = .bestMatch,
                       limit: Int = 50, now: Date = Date()) async -> [SearchHit] {
        let keyword = SearchEngine(store: store).search(query, filters: filters, sort: sort, limit: limit, now: now)
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let semantic, !q.isEmpty, !filters.titleOnly, sort == .bestMatch,
              let vector = try? await semantic.provider.embed([q]).first else { return keyword }
        let hits = semantic.index.query(vector, limit: limit * 2, minScore: minSimilarity).filter { allowed($0.pageID, filters) }
        return Self.merge(keyword: keyword, semantic: hits, limit: limit)
    }

    /// Pages related in meaning to `page` (the "Related pages" list at the end of a page).
    public func related(to page: RecordID, limit: Int = 5) -> [SemanticHit] {
        guard let semantic else { return [] }
        return semantic.index.related(to: page, limit: limit * 3, minScore: minSimilarity)
            .filter { $0.pageID != page && allowed($0.pageID, SearchFilters()) }
            .prefix(limit).map { $0 }
    }

    private func allowed(_ id: RecordID, _ filters: SearchFilters) -> Bool {
        guard let b = store.blocks[id], b.trashedAt == nil, b.props.isTemplate != true, !store.isTrashed(id) else { return false }
        if let by = filters.createdBy, b.createdBy != by { return false }
        if let a = filters.editedAfter, b.updatedAt < a { return false }
        if let e = filters.editedBefore, b.updatedAt > e { return false }
        if let p = filters.inPage, id != p, !store.isDescendant(id, of: p) { return false }
        return true
    }

    /// Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank) over the lists d appears in (rank from 1).
    public nonisolated static func fuse(_ lists: [[RecordID]], k: Double = 60) -> [(id: RecordID, score: Double)] {
        var scores: [RecordID: Double] = [:]
        var first: [RecordID: Int] = [:]
        var order = 0
        for list in lists {
            var seen = Set<RecordID>()
            for (i, id) in list.enumerated() where seen.insert(id).inserted {
                scores[id, default: 0] += 1 / (k + Double(i + 1))
                if first[id] == nil { first[id] = order; order += 1 }
            }
        }
        return scores.map { (id: $0.key, score: $0.value) }
            .sorted { $0.score != $1.score ? $0.score > $1.score : first[$0.id]! < first[$1.id]! }
    }

    /// Keyword hits keep their snippet; pages found only by meaning get the matching section as snippet.
    public nonisolated static func merge(keyword: [SearchHit], semantic: [SemanticHit], limit: Int) -> [SearchHit] {
        let byKeyword = Dictionary(keyword.map { ($0.pageID, $0) }, uniquingKeysWith: { a, _ in a })
        let bySemantic = Dictionary(semantic.map { ($0.pageID, $0) }, uniquingKeysWith: { a, _ in a })
        return fuse([keyword.map(\.pageID), semantic.map(\.pageID)]).prefix(limit).map { f in
            if var h = byKeyword[f.id] { h.score = f.score; return h }
            return SearchHit(pageID: f.id, score: f.score, snippet: bySemantic[f.id]?.snippet)
        }
    }
}
