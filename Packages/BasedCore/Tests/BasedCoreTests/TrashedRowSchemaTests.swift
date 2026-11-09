import Foundation
import Testing
@testable import BasedCore

/// BSD-122: schema changes reach rows in the Trash, and a restored row never keeps values the schema forbids.
@MainActor
@Suite struct TrashedRowSchemaTests {
    /// A database with select "Kind" (A, B), multi-select "Tags" (X, Y) and text "Note"; one live row, one trashed.
    func fixture() -> (s: WorkspaceStore, db: RecordID, kind: String, tags: String, note: String, opts: [String], tagOpts: [String], live: RecordID, trashed: RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let c = s.createDatabase(title: "Things", in: .workspace, inline: false, sampleRows: 0)
        let kind = s.addProperty(to: c.databaseID, name: "Kind", type: .select)!
        let tags = s.addProperty(to: c.databaseID, name: "Tags", type: .multiSelect)!
        let note = s.addProperty(to: c.databaseID, name: "Note", type: .text)!
        let opts = ["A", "B"].map { s.addOption(c.databaseID, kind, name: $0)! }
        let tagOpts = ["X", "Y"].map { s.addOption(c.databaseID, tags, name: $0)! }
        let live = s.addRow(to: c.databaseID, title: "Live", values: [kind: .select(opts[1])])
        let trashed = s.addRow(to: c.databaseID, title: "Gone",
                               values: [kind: .select(opts[0]), tags: .multiSelect(tagOpts), note: .text(RichText("42"))])
        _ = s.trashPages([trashed])
        return (s, c.databaseID, kind, tags, note, opts, tagOpts, live, trashed)
    }

    @Test func deletingAnOptionClearsItInTrashedRows() {
        let f = fixture()
        f.s.deleteOption(f.db, f.kind, f.opts[0])
        f.s.deleteOption(f.db, f.tags, f.tagOpts[0])
        f.s.restorePages([f.trashed])
        let row = f.s.blocks[f.trashed]!
        #expect(row.trashedAt == nil)
        #expect(row.values[f.kind] == nil)
        #expect(row.values[f.tags] == .multiSelect([f.tagOpts[1]]))
        #expect(f.s.blocks[f.live]!.values[f.kind] == .select(f.opts[1]))
    }

    @Test func typeChangeConvertsTrashedRows() {
        let f = fixture()
        f.s.changePropertyType(f.db, f.note, to: .number)
        f.s.changePropertyType(f.db, f.kind, to: .number)
        f.s.restorePages([f.trashed])
        let row = f.s.blocks[f.trashed]!
        #expect(row.values[f.note] == .number(42))
        if case .select? = row.values[f.kind] { Issue.record("select value left in a number property") }
        #expect(row.values[f.kind] == nil)
    }

    @Test func newIDPropertyNumbersTrashedRowsWithoutDuplicates() {
        let f = fixture()
        let uid = f.s.addProperty(to: f.db, name: "ID", type: .uniqueID)!
        let next = f.s.addRow(to: f.db, title: "New")
        f.s.restorePages([f.trashed])
        let ids = [f.live, f.trashed, next].compactMap { id -> Int? in
            if case .uniqueID(let n)? = f.s.blocks[id]?.values[uid] { return n } else { return nil }
        }
        #expect(ids.count == 3)
        #expect(Set(ids).count == 3)
    }

    @Test func deletingAndDuplicatingPropertiesReachTrashedRows() {
        let f = fixture()
        let copy = f.s.duplicateProperty(f.db, f.note)!
        f.s.deleteProperty(f.db, f.kind)
        let row = f.s.blocks[f.trashed]!
        #expect(row.values[f.kind] == nil)
        #expect(row.values[copy] == .text(RichText("42")))
    }

    @Test func restoreDropsValuesThatNoLongerFitAndIsOneUndoStep() {
        let f = fixture()
        // A value that slipped past (e.g. written by an older version while the row was in the Trash).
        var db = f.s.databases[f.db]!
        db.properties[db.properties.firstIndex { $0.id == f.note }!].type = .number
        let fitted = WorkspaceStore.valuesMatchingSchema(f.s.blocks[f.trashed]!.values, db)
        #expect(fitted[f.note] == nil)
        #expect(fitted[f.kind] == .select(f.opts[0]))
        // Values of unknown properties and unknown value kinds are kept.
        let kept = WorkspaceStore.valuesMatchingSchema(["nope": .number(1), f.kind: .unknown(["vector": [1]])], db)
        #expect(kept.count == 2)

        f.s.deleteOption(f.db, f.kind, f.opts[0])
        f.s.restorePages([f.trashed])
        _ = f.s.undo()
        #expect(f.s.blocks[f.trashed]?.trashedAt != nil)
    }
}
