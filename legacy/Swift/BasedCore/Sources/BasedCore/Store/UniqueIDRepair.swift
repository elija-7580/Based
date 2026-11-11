import Foundation

// BSD-123: the next ID of a database's ID property lives in the database record and is counted up locally. Two
// devices that add rows between two syncs hand out the same number, and last-writer-wins on the database record
// keeps the duplicate. After a remote merge every affected database is checked: duplicates are renumbered
// deterministically (the oldest row keeps its number, every other one gets the next free number in
// createdAt/ID order) and `nextUniqueID` is raised past the highest number. All devices reach the same result,
// so their repairs agree when they sync. Like Notion, a number is never handed out twice; the younger duplicate
// is the only row whose ID changes.

extension WorkspaceStore {
    /// Databases with an ID property touched by `records` (their rows or the database record itself).
    func databasesNeedingIDCheck(_ records: [Record]) -> Set<RecordID> {
        var out: Set<RecordID> = []
        for r in records {
            let id: RecordID?
            switch r {
            case .block(let b): if case .database(let d) = b.parent { id = d } else { id = nil }
            case .database(let d): id = d.id
            default: id = nil
            }
            if let id, databases[id]?.properties.contains(where: { $0.type == .uniqueID }) == true { out.insert(id) }
        }
        return out
    }

    /// New values for rows whose ID duplicates an older row's, and the `nextUniqueID` the database needs (nil when
    /// nothing has to change). Pure apart from reading the store; includes rows in the Trash (numbers are never reused).
    func uniqueIDRepair(_ databaseID: RecordID) -> (property: String, renumber: [RecordID: Int], next: Int?)? {
        guard let db = databases[databaseID], let uid = db.properties.first(where: { $0.type == .uniqueID }) else { return nil }
        let numbered = allRows(of: databaseID).compactMap { r -> (Block, Int)? in
            if case .uniqueID(let n)? = r.values[uid.id] { return (r, n) } else { return nil }
        }.sorted { a, b in
            a.0.createdAt != b.0.createdAt ? a.0.createdAt < b.0.createdAt : a.0.id < b.0.id
        }
        var maxID = numbered.map(\.1).max() ?? 0
        var seen: Set<Int> = []
        var renumber: [RecordID: Int] = [:]
        for (row, n) in numbered {
            if seen.insert(n).inserted { continue }
            maxID += 1
            renumber[row.id] = maxID
            seen.insert(maxID)
        }
        let next = (db.nextUniqueID ?? 1) <= maxID ? maxID + 1 : nil
        if renumber.isEmpty && next == nil { return nil }
        return (uid.id, renumber, next)
    }

    /// Repairs duplicate IDs in `databaseIDs` as one local, non-undoable change (synced like any edit).
    func repairUniqueIDs(in databaseIDs: Set<RecordID>) {
        let fixes = databaseIDs.sorted().compactMap { id in uniqueIDRepair(id).map { (id, $0) } }
        guard !fixes.isEmpty else { return }
        transact("Repair IDs", undoable: false) { tx in
            for (dbID, fix) in fixes {
                for (row, n) in fix.renumber { tx.update(row) { $0.values[fix.property] = .uniqueID(n) } }
                if let next = fix.next { tx.updateDatabase(dbID) { $0.nextUniqueID = next } }
            }
        }
    }
}
