import Foundation

/// Memoizes `QueryEngine.run` results per view until the view's database (or a database it reads through
/// relations / rollups) changes. Large databases (50k+ rows) re-run filters/sorts only after an edit to them,
/// not on every redraw and not when someone types in an ordinary page (BSD-39).
///
/// Invalidation: results are keyed on the view itself (any local edit to filters/sorts is a miss) and on the
/// `WorkspaceStore.databaseRevision` of the database plus every database reachable over its relations.
/// Formula / rollup values are dropped per row: a row edit drops that row's cells; databases that read the
/// changed one through relations drop all their cells.
@MainActor
public final class QueryCache {
    public let store: WorkspaceStore
    private var engine: QueryEngine
    private struct Signature: Equatable { var epoch: Int; var revisions: [RecordID: Int] }
    private struct Entry { var view: DatabaseView; var signature: Signature; var result: QueryResult; var derived: [String: Any] = [:] }
    private var results: [String: Entry] = [:]
    private var observation: ObservationToken?
    /// Formulas with `now()` are refreshed at most this often (they used to refresh on every keystroke anywhere).
    public var clockRefreshInterval: TimeInterval = 60
    public private(set) var hits = 0, misses = 0

    public init(store: WorkspaceStore) {
        self.store = store; engine = QueryEngine(store: store)
        observation = store.observe { [weak self] change in self?.apply(change) }
    }

    /// Drops memoized cells touched by a committed change (runs synchronously inside the commit).
    private func apply(_ change: ChangeSet) {
        if change.origin == .load { invalidate(); return }
        var whole = change.databaseSchemas
        for (db, rows) in change.databaseRows {
            // A database that relates to itself: any row may read the changed one.
            if dependencies(of: db).contains(db) { whole.insert(db) } else { engine.invalidate(database: db, rows: rows) }
        }
        let changed = change.databaseSchemas.union(change.databaseRows.keys)
        guard !changed.isEmpty else { return }
        for db in whole { engine.invalidate(database: db) }
        for other in engine.memoizedDatabases where !dependencies(of: other).isDisjoint(with: changed.subtracting([other])) {
            engine.invalidate(database: other)
        }
    }

    /// Databases reachable from `id` over relation properties (transitively; contains `id` only for a cycle).
    public func dependencies(of id: RecordID) -> Set<RecordID> {
        var seen = Set<RecordID>(), queue = [id]
        while let cur = queue.popLast() {
            for p in store.databases[cur]?.properties ?? [] {
                if let t = p.relation?.databaseID, seen.insert(t).inserted { queue.append(t) }
            }
        }
        return seen
    }

    private func signature(_ db: RecordID) -> Signature {
        var revs = [db: store.databaseRevision(db)]
        for d in dependencies(of: db) { revs[d] = store.databaseRevision(d) }
        return Signature(epoch: store.databaseEpoch, revisions: revs)
    }

    private func refreshClock() {
        let now = Date()
        // Relative date filters ("today", "past week") and `now()` formulas move on with the clock.
        if (engine.usesNow && now.timeIntervalSince(engine.now) > clockRefreshInterval)
            || !Calendar.current.isDate(engine.now, inSameDayAs: now) { invalidate() }
    }

    public func run(_ view: DatabaseView, search: String? = nil) -> QueryResult {
        refreshClock()
        let key = view.id + "\u{1}" + (search ?? "")
        let sig = signature(view.databaseID)
        if let e = results[key], e.view == view, e.signature == sig { hits += 1; return e.result }
        misses += 1
        let r = engine.run(view, search: search)
        results[key] = Entry(view: view, signature: sig, result: r)
        return r
    }

    public var queryEngine: QueryEngine { engine }

    /// Something computed from a view's result (chart points, calendar buckets …), kept as long as that result
    /// is (BSD-39). `tag` names the computation; everything else it depends on must be in the view.
    public func derived<T>(_ view: DatabaseView, search: String? = nil, tag: String, _ compute: () -> T) -> T {
        _ = run(view, search: search)
        let key = view.id + "\u{1}" + (search ?? "")
        if let v = results[key]?.derived[tag] as? T { return v }
        let v = compute()
        results[key]?.derived[tag] = v
        return v
    }

    /// Error of a formula / rollup cell (division by zero, cycle, too deep …), computing it if needed (BSD-17).
    public func error(row: RecordID, prop: String) -> FormulaError? {
        refreshClock()
        _ = engine.value(row, prop)
        return engine.error(row: row, prop: prop)
    }

    /// Whether any cell of this property failed in the values computed so far.
    public func hasErrors(prop: String) -> Bool { engine.failingProperties.contains(prop) }
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
