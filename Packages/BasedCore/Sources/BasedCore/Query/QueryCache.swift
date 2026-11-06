import Foundation

/// Memoizes `QueryEngine.run` results per view until the store changes.
/// Large databases (50k+ rows) re-run filters/sorts only after an edit, not on every redraw.
@MainActor
public final class QueryCache {
    public let store: WorkspaceStore
    private var engine: QueryEngine
    private var revision: Int
    private var results: [String: QueryResult] = [:]
    public private(set) var hits = 0, misses = 0

    public init(store: WorkspaceStore) {
        self.store = store; engine = QueryEngine(store: store); revision = store.revision
    }

    public func run(_ view: DatabaseView, search: String? = nil) -> QueryResult {
        if revision != store.revision { results.removeAll(); engine.reset(); revision = store.revision }
        let key = "\(view.id)|\(view.updatedAt.timeIntervalSince1970)|\(search ?? "")"
        if let r = results[key] { hits += 1; return r }
        misses += 1
        let r = engine.run(view, search: search)
        results[key] = r
        return r
    }

    public var queryEngine: QueryEngine { engine }
    public func invalidate() { results.removeAll(); engine.reset() }
}

/// Slices a sorted result into pages for lazy table rendering ("Load 50 more").
public struct RowPager: Equatable, Sendable {
    public var pageSize: Int
    public var loaded: Int
    public init(pageSize: Int = 50) { self.pageSize = pageSize; loaded = pageSize }
    public func visible(_ rows: [Block]) -> ArraySlice<Block> { rows.prefix(loaded) }
    public func hasMore(_ rows: [Block]) -> Bool { rows.count > loaded }
    public mutating func loadMore() { loaded += pageSize }
    public mutating func loadAll(_ rows: [Block]) { loaded = max(loaded, rows.count) }
    public mutating func reset() { loaded = pageSize }
}
