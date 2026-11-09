import Foundation

/// BSD-31: keeps relations, two-way mirrors, rollups, formulas and views consistent when properties, rows or
/// pages change. Every helper runs inside the caller's transaction, so the main change and all its repairs are
/// one undo step (no observers, no second transaction).
///
/// Who calls what:
/// - `renameProperty` → `rewriteFormulaReferences`
/// - `deleteProperty` → `purgeProperty` (mirror becomes one-way, rollups/charts/card covers/filters cleaned)
/// - `changePropertyType` away from Relation, `setRelationTarget` → `dropRelationLinks`
/// - `duplicateProperty` → the copy is one-way; `createPage`/`addRow`/`duplicateBlocks` in a database →
///   `linkMirrors(ofRow:)`
/// - `removeSubtree` (delete forever, empty trash, re-import) → `unlinkRemovedRows`
/// - `deleteOption` → `FilterGroup.removingOption`, group order / hidden groups
@MainActor
extension WorkspaceStore {

    // MARK: Two-way mirrors

    /// After a row was created or copied with relation values: adds the row to the mirror property of every
    /// target, so a two-way relation shows the link on both sides. Idempotent.
    func linkMirrors(ofRow rowID: RecordID, tx: Tx) {
        guard let row = tx.block(rowID), case .database(let dbID) = row.parent, let db = tx.database(dbID) else { return }
        for p in db.properties where p.type == .relation {
            guard let mirror = p.relation?.syncedPropertyID, case .relation(let targets)? = row.values[p.id] else { continue }
            for t in targets where tx.block(t) != nil {
                tx.update(t) { b in
                    var ids: [RecordID] = { if case .relation(let x) = b.values[mirror] { return x } else { return [] } }()
                    if !ids.contains(rowID) { ids.append(rowID) }
                    b.values[mirror] = .relation(ids)
                }
            }
        }
    }

    /// The relation property `propertyID` stops being two-way: its counterpart on the other database keeps its
    /// values but no longer points back (Notion: deleting one side leaves the other as a one-way relation).
    func detachMirror(_ databaseID: RecordID, _ propertyID: String, tx: Tx) {
        guard let rel = tx.database(databaseID)?.property(propertyID)?.relation, let mirror = rel.syncedPropertyID else { return }
        tx.updateDatabase(databaseID) { d in
            if let i = d.properties.firstIndex(where: { $0.id == propertyID }) { d.properties[i].relation?.syncedPropertyID = nil }
        }
        guard let target = tx.database(rel.databaseID), target.property(mirror)?.relation?.syncedPropertyID == propertyID else { return }
        tx.updateDatabase(target.id) { d in
            if let i = d.properties.firstIndex(where: { $0.id == mirror }) { d.properties[i].relation?.syncedPropertyID = nil }
        }
    }

    /// For a relation whose target changes or that stops being a relation: removes the mirror property on the
    /// target database (with all its references) and turns off rollups that read through this relation.
    func dropRelationLinks(_ databaseID: RecordID, _ propertyID: String, tx: Tx) {
        if let rel = tx.database(databaseID)?.property(propertyID)?.relation, let mirror = rel.syncedPropertyID {
            detachMirror(databaseID, propertyID, tx: tx)
            if tx.database(rel.databaseID)?.property(mirror) != nil, !(rel.databaseID == databaseID && mirror == propertyID) {
                purgeProperty(rel.databaseID, mirror, tx: tx)
            }
        }
        disableRollups(through: propertyID, in: databaseID, tx: tx)
    }

    // MARK: Property removal

    /// Removes a property and everything that points at it, inside `tx`: its values, view settings (columns,
    /// sorts, filters, grouping, calendar/timeline/map, chart axes, card cover, calculations), rollups that read
    /// it (here or from other databases through a relation), and the two-way link of a relation.
    func purgeProperty(_ databaseID: RecordID, _ propertyID: String, tx: Tx) {
        guard let db = tx.database(databaseID), db.property(propertyID) != nil else { return }
        detachMirror(databaseID, propertyID, tx: tx)
        tx.updateDatabase(databaseID) { $0.properties.removeAll { $0.id == propertyID } }
        for v in views.values where v.databaseID == databaseID {
            tx.updateView(v.id) { view in view.forgetProperty(propertyID) }
        }
        disableRollups(through: propertyID, in: databaseID, tx: tx)
        // Rollups elsewhere that show this property through a relation to this database.
        for other in databases.values {
            let relationsHere = Set(other.properties.filter { $0.relation?.databaseID == databaseID }.map(\.id))
            guard !relationsHere.isEmpty else { continue }
            let broken = other.properties.filter {
                guard let r = $0.rollup else { return false }
                return relationsHere.contains(r.relationPropertyID) && r.targetPropertyID == propertyID
            }.map(\.id)
            guard !broken.isEmpty else { continue }
            tx.updateDatabase(other.id) { d in
                for i in d.properties.indices where broken.contains(d.properties[i].id) { d.properties[i].rollup = nil }
            }
        }
        for r in rows(of: databaseID) where r.values[propertyID] != nil {
            tx.update(r.id) { $0.values[propertyID] = nil }
        }
    }

    /// Rollups of `databaseID` that read through relation `propertyID` lose their configuration (empty cells
    /// instead of values from a relation that no longer exists or now points elsewhere).
    func disableRollups(through propertyID: String, in databaseID: RecordID, tx: Tx) {
        guard let db = tx.database(databaseID),
              db.properties.contains(where: { $0.rollup?.relationPropertyID == propertyID }) else { return }
        tx.updateDatabase(databaseID) { d in
            for i in d.properties.indices where d.properties[i].rollup?.relationPropertyID == propertyID {
                d.properties[i].rollup = nil
            }
        }
    }

    // MARK: Formulas

    /// `prop("old")` → `prop("new")` in every formula of the database (not `x.prop("old")`, which reads a
    /// related page's property).
    func rewriteFormulaReferences(_ databaseID: RecordID, from old: String, to new: String, tx: Tx) {
        guard old != new, let db = tx.database(databaseID) else { return }
        var changed = false
        var props = db.properties
        for i in props.indices {
            guard let src = props[i].formula, !src.isEmpty else { continue }
            let out = Self.renamingFormulaReferences(src, from: old, to: new)
            if out != src { props[i].formula = out; changed = true }
        }
        if changed { tx.updateDatabase(databaseID) { $0.properties = props } }
    }

    nonisolated static func renamingFormulaReferences(_ src: String, from old: String, to new: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"(?<![.\w])prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)"#) else { return src }
        let ns = src as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: src, range: NSRange(location: 0, length: ns.length)) {
            let raw = ns.substring(with: m.range(at: 1))
            guard unescapeFormulaString(raw) == old else { continue }
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += "prop(\"" + escapeFormulaString(new) + "\")"
            last = m.range.location + m.range.length
        }
        guard last > 0 else { return src }
        return out + ns.substring(from: last)
    }

    nonisolated private static func unescapeFormulaString(_ s: String) -> String {
        var out = ""
        var escaped = false
        for c in s {
            if escaped { out.append(c); escaped = false } else if c == "\\" { escaped = true } else { out.append(c) }
        }
        return out
    }

    nonisolated private static func escapeFormulaString(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    // MARK: Hard delete

    /// Before `ids` are removed for good: relation values elsewhere drop the removed rows, and relations that
    /// pointed back into a removed database become one-way (their mirror is gone).
    func unlinkRemovedRows(_ ids: Set<RecordID>, tx: Tx) {
        var rowDBs: Set<RecordID> = []
        var removedDBs: Set<RecordID> = []
        for id in ids {
            guard let b = tx.block(id) else { continue }
            if case .database(let d) = b.parent { rowDBs.insert(d) }
            if let d = b.props.databaseID, databases[d]?.blockID == id { removedDBs.insert(d) }
        }
        guard !rowDBs.isEmpty || !removedDBs.isEmpty else { return }
        for db in databases.values where !removedDBs.contains(db.id) {
            let rels = db.properties.filter { $0.type == .relation && $0.relation.map { rowDBs.contains($0.databaseID) } == true }
            if !rels.isEmpty {
                for r in rows(of: db.id) where !ids.contains(r.id) {
                    for p in rels {
                        guard case .relation(let targets)? = r.values[p.id], targets.contains(where: ids.contains) else { continue }
                        let rest = targets.filter { !ids.contains($0) }
                        tx.update(r.id) { $0.values[p.id] = rest.isEmpty ? nil : .relation(rest) }
                    }
                }
            }
            let orphaned = db.properties.filter {
                guard let rel = $0.relation else { return false }
                return removedDBs.contains(rel.databaseID) && rel.syncedPropertyID != nil
            }.map(\.id)
            if !orphaned.isEmpty {
                tx.updateDatabase(db.id) { d in
                    for i in d.properties.indices where orphaned.contains(d.properties[i].id) { d.properties[i].relation?.syncedPropertyID = nil }
                }
            }
        }
    }
}

public extension DatabaseView {
    /// Drops every setting that refers to a property that no longer exists.
    mutating func forgetProperty(_ propertyID: String) {
        properties?.removeAll { $0.id == propertyID }
        sorts?.removeAll { $0.propertyID == propertyID }
        if groupBy?.propertyID == propertyID { groupBy = nil }
        if datePropertyID == propertyID { datePropertyID = nil }
        if endDatePropertyID == propertyID { endDatePropertyID = nil }
        if mapPropertyID == propertyID { mapPropertyID = nil }
        calculations?[propertyID] = nil
        if let f = filter { filter = f.removing(propertyID: propertyID) }
        if chart?.xPropertyID == propertyID { chart?.xPropertyID = nil }
        if chart?.yPropertyID == propertyID { chart?.yPropertyID = nil }
        if cardCover == .property(propertyID) { cardCover = nil }
    }

    /// Drops a deleted select/status option from filters and grouping of `propertyID`.
    mutating func forgetOption(_ optionID: String, of propertyID: String) {
        if let f = filter { filter = f.removingOption(optionID, of: propertyID) }
        if groupBy?.propertyID == propertyID {
            groupBy?.hiddenGroups?.removeAll { $0 == optionID }
            groupBy?.groupOrder?.removeAll { $0 == optionID }
        }
    }
}

public extension FilterGroup {
    /// Removes `optionID` from "is / is not / contains" conditions on `propertyID`; a condition left without
    /// options keeps its operator but has no value (it matches everything, like an unfinished filter).
    func removingOption(_ optionID: String, of propertyID: String) -> FilterGroup {
        var g = self
        g.items = items.map { item in
            switch item {
            case .condition(var c):
                guard c.propertyID == propertyID, case .options(let ids)? = c.value, ids.contains(optionID) else { return item }
                let rest = ids.filter { $0 != optionID }
                c.value = rest.isEmpty ? nil : .options(rest)
                return .condition(c)
            case .group(let sub): return .group(sub.removingOption(optionID, of: propertyID))
            case .unknown: return item
            }
        }
        return g
    }
}
