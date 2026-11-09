import Foundation
import BasedCore

// BSD-102: the lazily created Brain databases (Runs, Projects, Captures) are made on whichever device needs them
// first. Two devices that do so before they have synced end up with two databases of the same title. The rule
// that makes every device agree: the oldest database of that title inside the Agent Brain is the one (creation
// time, then id — both synced), never a device-local remembered id. The others are merged into it:
// - rows (also trashed ones) move into it, values follow the column of the same name and type (missing columns
//   are added with their settings, select options by name), so nothing is lost;
// - relation columns anywhere in the workspace that pointed at the duplicate now point at the kept database;
// - the emptied duplicate goes to the Trash (restorable, never deleted here).
// Projects of the same name (each device migrated its sessions' project names) are merged the same way: the
// oldest row stays; the duplicate's goal/folder/agent fill empty fields, its pages are added, its own page content
// (if more than the empty template) moves under a heading into the kept project, every relation to it is
// re-pointed (runs, sessions, …), then the empty duplicate row goes to the Trash.

public struct BrainMergeReport: Sendable, Equatable {
    /// Duplicate databases merged, by title.
    public var databases: [String: Int] = [:]
    public var rowsMoved = 0
    public var projectsMerged = 0
    public var isEmpty: Bool { databases.isEmpty && rowsMoved == 0 && projectsMerged == 0 }
}

@MainActor
extension BrainStore {
    /// The lazily created Brain databases that can appear twice.
    static var mergeableDatabases: [(title: String, metaKey: String)] {
        [("Runs", runsMetaKey), ("Projects", projectsMetaKey), ("Captures", capturesMetaKey)]
    }

    /// Databases titled `title` whose host block sits directly in the Agent Brain page (also trashed ones), oldest first.
    func brainDatabaseCandidates(title: String) -> [Database] {
        store.databases.values.filter { d in
            d.title.plainText == title && store.blocks[d.blockID].map { $0.parent == .block(rootID) } == true
        }.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// Merges every duplicate Brain database and duplicate project (see the file comment). Cheap when there is
    /// nothing to do; runs from `repair()`, the `ensure…` functions and after remote changes.
    @discardableResult
    public func mergeDuplicateBrainDatabases() -> BrainMergeReport {
        var report = BrainMergeReport()
        for (title, key) in Self.mergeableDatabases {
            guard let keep = existingBrainDatabase(title: title, metaKey: key) else { continue }
            let (dbs, rows) = mergeDuplicates(title: title, into: keep)
            if dbs > 0 { report.databases[title] = dbs }
            report.rowsMoved += rows
        }
        if let projects = existingProjectsDB { report.projectsMerged = mergeDuplicateProjects(projects) }
        if !report.isEmpty {
            Log.notice("brain: merged duplicates \(report.databases), \(report.rowsMoved) rows moved, \(report.projectsMerged) projects merged", category: "brain")
        }
        return report
    }

    /// Moves the rows of every other `title` database in the Brain into `keep`, re-points relations and trashes the
    /// emptied duplicates. Returns (duplicates merged, rows moved).
    func mergeDuplicates(title: String, into keep: RecordID) -> (Int, Int) {
        var merged = 0, moved = 0
        for dup in brainDatabaseCandidates(title: title) where dup.id != keep {
            let rows = store.children(of: .database(dup.id)).compactMap { store.blocks[$0] }
            let hostTrashed = store.blocks[dup.blockID]?.trashedAt != nil
            let pointing = relationColumns(targeting: dup.id)
            if rows.isEmpty && hostTrashed && pointing.isEmpty { continue }   // merged before
            // Columns: same name and type, else added with the duplicate's settings.
            var columnMap: [String: String] = [:]
            var optionMap: [String: String] = [:]
            for p in dup.properties {
                if p.type == .title { columnMap[p.id] = Database.titlePropertyID; continue }
                guard let kept = store.databases[keep] else { break }
                var target = kept.properties.first { $0.name == p.name && $0.type == p.type }?.id
                if target == nil, let added = store.addProperty(to: keep, name: p.name, type: p.type) {
                    store.updateProperty(keep, added, name: "Merge \(title) column") { s in
                        s.options = p.options; s.statusGroups = p.statusGroups; s.numberFormat = p.numberFormat
                        s.formula = p.formula; s.relation = p.relation; s.idPrefix = p.idPrefix; s.dateFormat = p.dateFormat
                    }
                    target = added
                }
                guard let t = target else { continue }
                columnMap[p.id] = t
                for o in p.options ?? [] { if let oid = store.addOption(keep, t, name: o.name, color: o.color) { optionMap[o.id] = oid } }
            }
            func remap(_ v: PropertyValue) -> PropertyValue {
                switch v {
                case .select(let o): return .select(optionMap[o] ?? o)
                case .status(let o): return .status(optionMap[o] ?? o)
                case .multiSelect(let os): return .multiSelect(os.map { optionMap[$0] ?? $0 })
                default: return v
                }
            }
            store.transact("Merge duplicate \(title)", undoable: false) { tx in
                let keys = tx.sortKeys(rows.count, in: .database(keep), .end)
                for (row, key) in zip(rows, keys) {
                    tx.update(row.id) { b in
                        b.parent = .database(keep)
                        b.sortKey = key
                        var values: [String: PropertyValue] = [:]
                        // A value whose column couldn't be mapped keeps its old key (kept, just not shown).
                        for (pid, v) in b.values { values[columnMap[pid] ?? pid] = remap(v) }
                        b.values = values
                    }
                }
                for (db, pid) in pointing {
                    tx.updateDatabase(db) { d in
                        if let i = d.properties.firstIndex(where: { $0.id == pid }) { d.properties[i].relation?.databaseID = keep }
                    }
                }
            }
            moved += rows.count
            store.protectedIDs.remove(dup.blockID)
            if !hostTrashed { _ = store.trashPages([dup.blockID]) }
            merged += 1
        }
        return (merged, moved)
    }

    /// (database, property) of every relation column in the workspace whose target is `db`.
    func relationColumns(targeting db: RecordID) -> [(RecordID, String)] {
        store.databases.values.flatMap { d in
            d.properties.filter { $0.type == .relation && $0.relation?.databaseID == db }.map { (d.id, $0.id) }
        }
    }

    /// Merges projects of the same name (case and surrounding spaces ignored) into the oldest. Returns how many
    /// duplicate rows were merged.
    func mergeDuplicateProjects(_ db: RecordID) -> Int {
        var groups: [String: [Block]] = [:]
        for row in store.rows(of: db) {
            let key = row.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !key.isEmpty { groups[key, default: []].append(row) }
        }
        var merged = 0
        let template = Self.normalizedBody(Self.projectBodyTemplate)
        for (_, rows) in groups.sorted(by: { $0.key < $1.key }) where rows.count > 1 {
            let ordered = rows.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            let keep = ordered[0].id
            for dup in ordered.dropFirst() {
                guard let k = project(keep), let d = project(dup.id) else { continue }
                // Fields: fill what's empty, add pages.
                // (Direct writes: setProject/projectsDB would re-enter ensureProjects → this merge.)
                if k.goal.isEmpty, !d.goal.isEmpty, let pid = propID(db, ProjectCol.goal) { store.setValue(keep, pid, .text(RichText(d.goal))) }
                if k.folder.isEmpty, !d.folder.isEmpty, let pid = propID(db, ProjectCol.folder) { store.setValue(keep, pid, .text(RichText(d.folder))) }
                let pages = k.pageIDs + d.pageIDs.filter { !k.pageIDs.contains($0) }
                if pages != k.pageIDs, let pid = propID(db, ProjectCol.pages) {
                    store.setValue(keep, pid, .text(RichText(pages.joined(separator: " "))))
                }
                if k.agentID == nil, let a = d.agentID, let pid = propID(db, ProjectCol.agent) { store.setValue(keep, pid, .relation([a])) }
                // Page content beyond the empty template moves over under a heading.
                let body = store.contentBlocks(of: dup.id)
                let dupText = Self.normalizedBody(MarkdownExporter(store: store).exportBlocks(body, indent: 0))
                let keepText = Self.normalizedBody(MarkdownExporter(store: store).exportBlocks(store.contentBlocks(of: keep), indent: 0))
                if !body.isEmpty, dupText != template, dupText != keepText {
                    let stamp = DateFormatter.localizedString(from: dup.createdAt, dateStyle: .medium, timeStyle: .short)
                    store.insertBlock(.heading2, text: RichText("Merged from a duplicate project (created \(stamp))"), in: .block(keep))
                    store.moveBlocks(body.map(\.id), to: .block(keep), at: .end, name: "Merge duplicate project")
                }
                // Everything that pointed at the duplicate points at the kept project.
                repointRelations(from: dup.id, to: keep, targetDB: db)
                _ = store.trashPages([dup.id])
                merged += 1
            }
        }
        return merged
    }

    /// Replaces `old` by `new` in every relation value of a column that targets `targetDB`.
    func repointRelations(from old: RecordID, to new: RecordID, targetDB: RecordID) {
        let columns = relationColumns(targeting: targetDB)
        guard !columns.isEmpty else { return }
        store.transact("Re-point project links", undoable: false) { tx in
            for (db, pid) in columns {
                for id in store.children(of: .database(db)) {
                    guard let row = store.blocks[id], case .relation(let ids)? = row.values[pid], ids.contains(old) else { continue }
                    var out: [RecordID] = []
                    for x in ids.map({ $0 == old ? new : $0 }) where !out.contains(x) { out.append(x) }
                    tx.update(id) { $0.values[pid] = .relation(out) }
                }
            }
        }
    }

    static func normalizedBody(_ s: String) -> String {
        s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}
