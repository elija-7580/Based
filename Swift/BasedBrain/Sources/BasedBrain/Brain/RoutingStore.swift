import Foundation
import BasedCore

// BSD-97: the routes of Auto-Routing live in the "Routing" database inside the Agent Brain page (protected and
// synced like Runs). One row per route: Name (title), ID, Description and the candidate chains for Low / Auto /
// High as text ("claudeCode:sonnet@high, api:@small, codex"). Created on first use with `ModelRouter.defaultRoutes`;
// later starts only add columns. A row that can't be read never breaks routing: it falls back to the default
// route of that id (or General) and says why.

@MainActor
extension BrainStore {
    static let routingMetaKey = "brain.routing"

    enum RouteCol {
        static let id = "ID", description = "Description", low = "Low", auto = "Auto", high = "High"
    }

    /// Creates the Routing database on first use (pre-filled with the default routes), adds missing columns and
    /// protects it. Returns the database id.
    @discardableResult
    public func ensureRouting() -> RecordID {
        let (db, created) = ensureBrainDatabase(title: "Routing", metaKey: Self.routingMetaKey)
        for c in [RouteCol.id, RouteCol.description, RouteCol.low, RouteCol.auto, RouteCol.high] { ensureColumn(db, c, .text) }
        if created {
            for r in ModelRouter.defaultRoutes { addRouteRow(db, r) }
        }
        return db
    }

    /// The Routing database when it exists (never creates it — safe from views and the router).
    var existingRoutingDB: RecordID? { existingBrainDatabase(title: "Routing", metaKey: Self.routingMetaKey) }

    private func addRouteRow(_ db: RecordID, _ r: Route) {
        var values: [String: PropertyValue] = [:]
        func set(_ col: String, _ s: String) { if let pid = propID(db, col) { values[pid] = .text(RichText(s)) } }
        set(RouteCol.id, r.id)
        set(RouteCol.description, r.description)
        set(RouteCol.low, RouteTarget.listText(r.low))
        set(RouteCol.auto, RouteTarget.listText(r.auto))
        set(RouteCol.high, RouteTarget.listText(r.high))
        _ = store.addRow(to: db, title: RichText(r.name), values: values)
    }

    /// The routes to use, read fresh (an edited row counts from the next turn), plus notes about rows that could
    /// not be read. Without a Routing database: the defaults. A General route is always there.
    public func routes() -> (routes: [Route], notes: [String]) {
        guard let db = existingRoutingDB else { return (ModelRouter.defaultRoutes, []) }
        return Self.routes(fromRows: store.rows(of: db).map { row in
            (name: row.title, id: text(row, db, RouteCol.id), description: text(row, db, RouteCol.description),
             low: text(row, db, RouteCol.low), auto: text(row, db, RouteCol.auto), high: text(row, db, RouteCol.high))
        })
    }

    /// Rows → routes (pure, for tests). Duplicate ids: the first row wins.
    nonisolated static func routes(fromRows rows: [(name: String, id: String, description: String, low: String, auto: String, high: String)]) -> (routes: [Route], notes: [String]) {
        var out: [Route] = []
        var notes: [String] = []
        let defaults = Dictionary(uniqueKeysWithValues: ModelRouter.defaultRoutes.map { ($0.id, $0) })
        let general = defaults["general"]!
        for row in rows {
            let name = row.name.trimmingCharacters(in: .whitespaces)
            var id = row.id.trimmingCharacters(in: .whitespaces).lowercased()
            if id.isEmpty { id = name.lowercased().replacingOccurrences(of: " ", with: "-") }
            guard !id.isEmpty, !out.contains(where: { $0.id == id }) else { continue }
            let fallback = defaults[id] ?? general
            func chain(_ text: String, _ level: ComputeLevel) -> [RouteTarget] {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return fallback.candidates(level) }
                if let list = RouteTarget.parseList(text), !list.isEmpty { return list }
                notes.append("Routing “\(name.isEmpty ? id : name)”, \(level.title): can't read “\(text)” — using the default.")
                return fallback.candidates(level)
            }
            out.append(Route(id: id, name: name.isEmpty ? fallback.name : name,
                             description: row.description.isEmpty ? fallback.description : row.description,
                             low: chain(row.low, .low), auto: chain(row.auto, .auto), high: chain(row.high, .high)))
        }
        if !out.contains(where: { $0.id == "general" }) { out.append(general) }
        return (out, notes)
    }
}
