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

/// Quick Find: title and full-text search over pages (including database rows).
@MainActor
public struct SearchEngine {
    public let store: WorkspaceStore
    public init(store: WorkspaceStore) { self.store = store }

    public func search(_ query: String, filters: SearchFilters = SearchFilters(), sort: SearchSort = .bestMatch,
                       limit: Int = 50, now: Date = Date()) -> [SearchHit] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        if q.isEmpty {
            return store.recentPages(limit: limit).map { SearchHit(pageID: $0.id, score: 0) }
        }
        let terms = q.split(separator: " ").map(String.init)
        var hits: [RecordID: SearchHit] = [:]
        var trashedCache: [RecordID: Bool] = [:]
        func live(_ id: RecordID) -> Bool {
            if let t = trashedCache[id] { return !t }
            let t = store.isTrashed(id)
            trashedCache[id] = t
            return !t
        }
        func allowed(_ page: Block) -> Bool {
            if page.props.isTemplate == true { return false }
            if let by = filters.createdBy, page.createdBy != by { return false }
            if let a = filters.editedAfter, page.updatedAt < a { return false }
            if let b = filters.editedBefore, page.updatedAt > b { return false }
            if let p = filters.inPage, page.id != p, !store.isDescendant(page.id, of: p) { return false }
            return true
        }
        // Titles
        for b in store.blocks.values where b.type.isPageLike || (b.type == .databaseInline && store.ownsDatabase(b)) {
            guard allowed(b), live(b.id) else { continue }
            let title = store.title(of: b.id).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            guard let s = Self.titleScore(title, q, terms) else { continue }
            let recency = max(0, 10 - now.timeIntervalSince(b.updatedAt) / 86_400 / 3)
            hits[b.id] = SearchHit(pageID: b.id, score: s + recency)
        }
        // Content
        if !filters.titleOnly {
            for b in store.blocks.values where !b.type.isPageLike && b.trashedAt == nil {
                // Page mentions count with their current title, not the one stored when they were typed (BSD-40).
                var text = store.plainTextResolvingMentions(b.text)
                if let cells = b.props.cells { text += " " + cells.map(\.plainText).joined(separator: " ") }
                if let c = b.props.caption { text += " " + c.plainText }
                if let segs = b.props.segments { text += " " + segs.lazy.filter { !$0.isPartial }.map(\.text).joined(separator: " ") }
                guard !text.isEmpty else { continue }
                let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                guard terms.allSatisfy({ folded.contains($0) }) else { continue }
                guard let page = store.containingPage(of: b.id), let pb = store.blocks[page], allowed(pb), live(page) else { continue }
                let snippet = Self.snippet(text, folded, terms[0])
                if var h = hits[page] {
                    if h.snippet == nil { h.snippet = snippet; h.blockID = b.id; h.score += 5 }
                    hits[page] = h
                } else {
                    let recency = max(0, 10 - now.timeIntervalSince(pb.updatedAt) / 86_400 / 3)
                    hits[page] = SearchHit(pageID: page, score: 20 + recency, snippet: snippet, blockID: b.id)
                }
            }
            // Property values of rows
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
                    hits[b.id] = SearchHit(pageID: b.id, score: 15, snippet: Self.snippet(text, folded, terms[0]))
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

    static func titleScore(_ title: String, _ q: String, _ terms: [String]) -> Double? {
        if title == q { return 100 }
        if title.hasPrefix(q) { return 80 }
        let words = title.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if terms.allSatisfy({ t in words.contains { $0.hasPrefix(t) } }) { return 60 }
        if title.contains(q) { return 45 }
        if terms.allSatisfy({ title.contains($0) }) { return 35 }
        return nil
    }

    static func snippet(_ text: String, _ folded: String, _ term: String) -> String {
        guard let r = folded.range(of: term) else { return String(text.prefix(120)) }
        let offset = folded.distance(from: folded.startIndex, to: r.lowerBound)
        let chars = Array(text)
        let start = max(0, offset - 40)
        let end = min(chars.count, offset + term.count + 80)
        guard start < end, end <= chars.count else { return String(text.prefix(120)) }
        return (start > 0 ? "…" : "") + String(chars[start..<end]) + (end < chars.count ? "…" : "")
    }
}