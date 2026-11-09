import Foundation

public struct SearchHit: Identifiable, Hashable, Sendable {
    public var id: RecordID { pageID }
    public var pageID: RecordID
    public var score: Double
    /// Matching content text (nil when only the title matched).
    public var snippet: String?
    public var blockID: RecordID?

    public init(pageID: RecordID, score: Double = 0, snippet: String? = nil, blockID: RecordID? = nil) {
        self.pageID = pageID
        self.score = score
        self.snippet = snippet
        self.blockID = blockID
    }
}

public struct SearchFilters: Sendable {
    public var titleOnly = false
    public var inPage: RecordID?
    public var createdBy: String?
    public var editedAfter: Date?
    public var editedBefore: Date?
    public init() {}
}

public enum SearchSort: String, CaseIterable, Sendable { case bestMatch, lastEditedNewest, lastEditedOldest, createdNewest, createdOldest }

/// Quick Find: title and full-text search over pages (including database rows). The scan runs over a
/// `SearchCorpus` (folded texts, built once per store revision); `searchAsync` keeps it off the main thread.
@MainActor
public struct SearchEngine {
    public let store: WorkspaceStore
    public init(store: WorkspaceStore) { self.store = store }

    public func search(_ query: String, filters: SearchFilters = SearchFilters(), sort: SearchSort = .bestMatch,
                       limit: Int = 50, now: Date = Date()) -> [SearchHit] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty {
            return store.recentPages(limit: limit).map { SearchHit(pageID: $0.id, score: 0) }
        }
        return corpus().search(q, filters: filters, sort: sort, limit: limit, now: now) ?? []
    }

    /// BSD-137: the same search with index build and scan off the main thread (Quick Find runs this on every
    /// keystroke). Cancelling the calling task (a newer keystroke) stops the scan; the result is then nil.
    /// Recent pages for an empty query come from the store's cache on the main actor.
    public func searchAsync(_ query: String, filters: SearchFilters = SearchFilters(), sort: SearchSort = .bestMatch,
                            limit: Int = 50, now: Date = Date()) async -> [SearchHit]? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty {
            return store.recentPages(limit: limit).map { SearchHit(pageID: $0.id, score: 0) }
        }
        let cached = store.searchCorpusCache?.revision == store.revision ? store.searchCorpusCache : nil
        let blocks = store.blocks, databases = store.databases, revision = store.revision
        let work = Task.detached(priority: .userInitiated) { () -> (SearchCorpus?, [SearchHit]?) in
            guard let corpus = cached ?? SearchCorpus.build(blocks: blocks, databases: databases, revision: revision,
                                                            isCancelled: { Task.isCancelled }) else { return (nil, nil) }
            return (corpus, corpus.search(q, filters: filters, sort: sort, limit: limit, now: now, isCancelled: { Task.isCancelled }))
        }
        let (corpus, hits) = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        // Keep a freshly built index while the workspace is unchanged (the next keystroke reuses it).
        if let corpus, cached == nil, corpus.revision == store.revision { store.searchCorpusCache = corpus }
        return Task.isCancelled ? nil : hits
    }

    /// The index for the current revision, built here on first use after a change.
    func corpus() -> SearchCorpus {
        if let c = store.searchCorpusCache, c.revision == store.revision { return c }
        let c = SearchCorpus.build(blocks: store.blocks, databases: store.databases, revision: store.revision)!
        store.searchCorpusCache = c
        return c
    }

    nonisolated static func titleScore(_ title: String, _ q: String, _ terms: [String]) -> Double? {
        if title == q { return 100 }
        if title.hasPrefix(q) { return 80 }
        let words = title.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if terms.allSatisfy({ t in words.contains { $0.hasPrefix(t) } }) { return 60 }
        if title.contains(q) { return 45 }
        if terms.allSatisfy({ title.contains($0) }) { return 35 }
        return nil
    }

    nonisolated static func snippet(_ text: String, _ folded: String, _ term: String) -> String {
        guard let r = folded.range(of: term) else { return String(text.prefix(120)) }
        let offset = folded.distance(from: folded.startIndex, to: r.lowerBound)
        let chars = Array(text)
        let start = max(0, offset - 40)
        let end = min(chars.count, offset + term.count + 80)
        guard start < end, end <= chars.count else { return String(text.prefix(120)) }
        return (start > 0 ? "…" : "") + String(chars[start..<end]) + (end < chars.count ? "…" : "")
    }
}