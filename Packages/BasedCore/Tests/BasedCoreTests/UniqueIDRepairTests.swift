import Foundation
import Testing
@testable import BasedCore

/// BSD-123: rows added on two devices between syncs never end up with the same ID number.
@MainActor
@Suite struct UniqueIDRepairTests {
    func ids(_ s: WorkspaceStore, _ db: RecordID, _ uid: String) -> [RecordID: Int] {
        var out: [RecordID: Int] = [:]
        for r in s.allRows(of: db) { if case .uniqueID(let n)? = r.values[uid] { out[r.id] = n } }
        return out
    }

    @Test func offlineRowsOnTwoDevicesGetDistinctIDs() {
        let a = WorkspaceStore(persistence: MemoryPersistence(), node: "a")
        let c = a.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        let uid = a.addProperty(to: c.databaseID, name: "ID", type: .uniqueID)!
        _ = a.addRow(to: c.databaseID, title: "Shared")
        let b = WorkspaceStore(persistence: MemoryPersistence(), node: "b")
        b.applyRemote(a.allRecords())
        #expect(ids(b, c.databaseID, uid).values.sorted() == [1])

        // Offline on both devices: each adds rows and hands out the same next numbers.
        let ra = a.addRow(to: c.databaseID, title: "From A")
        let ra2 = a.addRow(to: c.databaseID, title: "From A 2")
        let rb = b.addRow(to: c.databaseID, title: "From B")
        #expect(ids(a, c.databaseID, uid)[ra] == 2 && ids(b, c.databaseID, uid)[rb] == 2)

        // Sync both ways, then once more so each side sees the other's repair.
        let fromA = a.allRecords(), fromB = b.allRecords()
        b.applyRemote(fromA)
        a.applyRemote(fromB)
        b.applyRemote(a.allRecords())
        a.applyRemote(b.allRecords())

        let idsA = ids(a, c.databaseID, uid), idsB = ids(b, c.databaseID, uid)
        #expect(idsA == idsB)
        #expect(idsA.count == 4)
        #expect(Set(idsA.values).count == 4)
        #expect(idsA[ra] == 2)               // the oldest row with a number keeps it
        #expect(idsA[ra2] == 3)
        #expect(idsA[rb] == 4)               // the younger duplicate moves past the highest number
        for s in [a, b] {
            let next = s.databases[c.databaseID]!.nextUniqueID ?? 0
            #expect(next > idsA.values.max()!)
            // The next row on either device gets a fresh number.
            let r = s.addRow(to: c.databaseID, title: "Later")
            #expect(!idsA.values.contains(ids(s, c.databaseID, uid)[r]!))
        }
    }

    @Test func staleNextCounterIsRaisedWithoutRenumbering() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "s")
        let c = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        let uid = s.addProperty(to: c.databaseID, name: "ID", type: .uniqueID)!
        let rows = (0..<3).map { s.addRow(to: c.databaseID, title: RichText("R\($0)")) }
        // An older database record (counter 2) wins last-writer-wins from another device.
        var db = s.databases[c.databaseID]!
        db.nextUniqueID = 2
        db.stamp = Stamp(millis: db.stamp.millis + 60_000, counter: 0, node: "z")
        s.applyRemote([.database(db)])
        #expect(s.databases[c.databaseID]!.nextUniqueID == 4)
        #expect(rows.map { ids(s, c.databaseID, uid)[$0] } == [1, 2, 3])
    }

    @Test func nothingToRepairWritesNothing() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "s")
        let c = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        _ = s.addProperty(to: c.databaseID, name: "ID", type: .uniqueID)!
        _ = s.addRow(to: c.databaseID, title: "R")
        #expect(s.uniqueIDRepair(c.databaseID) == nil)
    }
}
