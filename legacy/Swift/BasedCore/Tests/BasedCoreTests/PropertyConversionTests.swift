import Foundation
import Testing
@testable import BasedCore

/// BSD-18: changing a property's type must not drop values silently.
@MainActor
@Suite struct PropertyConversionTests {
    struct Fixture {
        let s: WorkspaceStore
        let db: RecordID
        let rows: [RecordID]
    }

    /// A database with a select property "Kind" (options A, B, C) and three rows A, B, C plus one empty row.
    func selectFixture(multi: Bool = false) -> (Fixture, String, [String]) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "c")
        let c = s.createDatabase(title: "Things", in: .workspace, inline: false, sampleRows: 0)
        let kind = s.addProperty(to: c.databaseID, name: "Kind", type: multi ? .multiSelect : .select)!
        let opts = ["A", "B", "C"].map { s.addOption(c.databaseID, kind, name: $0)! }
        var rows: [RecordID] = []
        for (i, o) in opts.enumerated() {
            let v: PropertyValue = multi ? .multiSelect(i == 2 ? [opts[2], opts[0]] : [o]) : .select(o)
            rows.append(s.addRow(to: c.databaseID, title: RichText("Row \(i)"), values: [kind: v]))
        }
        rows.append(s.addRow(to: c.databaseID, title: "Empty"))
        return (Fixture(s: s, db: c.databaseID, rows: rows), kind, opts)
    }

    @Test func selectToStatusKeepsOptionsAndValues() {
        let (f, kind, opts) = selectFixture()
        let before = f.s.databases[f.db]!.property(kind)!.options!
        f.s.changePropertyType(f.db, kind, to: .status)
        let p = f.s.databases[f.db]!.property(kind)!
        #expect(p.type == .status)
        // Same options (ID, name, colour), all in "To-do"; no defaults mixed in.
        #expect(p.options == before)
        #expect(p.statusGroups?.map(\.name) == ["To-do", "In progress", "Complete"])
        #expect(p.statusGroups?[0].optionIDs == opts)
        #expect(p.statusGroups?[1].optionIDs == [])
        for (i, r) in f.rows.prefix(3).enumerated() {
            #expect(f.s.blocks[r]?.values[kind] == .status(opts[i]))
        }
        #expect(f.s.blocks[f.rows[3]]?.values[kind] == nil)
    }

    @Test func multiSelectToStatusKeepsFirstValue() {
        let (f, kind, opts) = selectFixture(multi: true)
        #expect(f.s.conversionLoss(f.db, kind, to: .status) == ConversionLoss(cells: 1))   // row 2 has C and A
        f.s.changePropertyType(f.db, kind, to: .status)
        let p = f.s.databases[f.db]!.property(kind)!
        #expect(p.options?.map(\.id) == opts)
        #expect(p.statusGroups?[0].optionIDs == opts)
        #expect(f.s.blocks[f.rows[0]]?.values[kind] == .status(opts[0]))
        #expect(f.s.blocks[f.rows[2]]?.values[kind] == .status(opts[2]))
    }

    @Test func statusBackToSelectKeepsOptions() {
        let (f, kind, opts) = selectFixture()
        f.s.changePropertyType(f.db, kind, to: .status)
        f.s.changePropertyType(f.db, kind, to: .select)
        let p = f.s.databases[f.db]!.property(kind)!
        #expect(p.options?.map(\.id) == opts)
        #expect(p.statusGroups == nil)
        #expect(f.s.blocks[f.rows[1]]?.values[kind] == .select(opts[1]))
    }

    @Test func textToStatusUsesDefaultsAndKeepsOtherValues() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let c = s.createDatabase(title: "T", in: .workspace, inline: false, sampleRows: 0)
        let note = s.addProperty(to: c.databaseID, name: "State", type: .text)!
        let r1 = s.addRow(to: c.databaseID, title: "1", values: [note: .text(RichText("done"))])
        let r2 = s.addRow(to: c.databaseID, title: "2", values: [note: .text(RichText("Blocked"))])
        #expect(s.conversionLoss(c.databaseID, note, to: .status).isEmpty)
        s.changePropertyType(c.databaseID, note, to: .status)
        let p = s.databases[c.databaseID]!.property(note)!
        let done = p.option(named: "Done")!, blocked = p.option(named: "Blocked")!
        #expect(p.option(named: "Not started") != nil)
        #expect(s.blocks[r1]?.values[note] == .status(done.id))
        #expect(s.blocks[r2]?.values[note] == .status(blocked.id))
        #expect(p.statusGroups?[0].optionIDs.contains(blocked.id) == true)
        #expect(p.statusGroups?[2].optionIDs == [done.id])
    }

    @Test func emptyPropertyToStatusGetsDefaults() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "e")
        let c = s.createDatabase(title: "T", in: .workspace, inline: false, sampleRows: 0)
        let p0 = s.addProperty(to: c.databaseID, name: "S", type: .select)!
        s.changePropertyType(c.databaseID, p0, to: .status)
        let p = s.databases[c.databaseID]!.property(p0)!
        #expect(p.options?.map(\.name) == ["Not started", "In progress", "Done"])
        #expect(p.statusGroups?.count == 3)
    }

    @Test func relationToTextUsesTitles() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "r")
        let projects = s.createDatabase(title: "Projects", in: .workspace, inline: false, sampleRows: 0)
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        let rel = s.addProperty(to: projects.databaseID, name: "Tasks", type: .relation)!
        s.updateProperty(projects.databaseID, rel) { $0.relation = RelationConfig(databaseID: tasks.databaseID) }
        let t1 = s.addRow(to: tasks.databaseID, title: "Write")
        let t2 = s.addRow(to: tasks.databaseID, title: "Ship")
        let p = s.addRow(to: projects.databaseID, title: "Launch")
        s.setRelation(p, rel, [t1, t2])
        #expect(s.conversionLoss(projects.databaseID, rel, to: .text).isEmpty)
        s.changePropertyType(projects.databaseID, rel, to: .text)
        #expect(s.blocks[p]?.values[rel] == .text(RichText("Write, Ship")))
    }

    @Test func conversionLossMatrix() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "m")
        let c = s.createDatabase(title: "M", in: .workspace, inline: false, sampleRows: 0)
        let text = s.addProperty(to: c.databaseID, name: "Text", type: .text)!
        let num = s.addProperty(to: c.databaseID, name: "Num", type: .number)!
        s.addRow(to: c.databaseID, title: "a", values: [text: .text(RichText("12")), num: .number(3)])
        s.addRow(to: c.databaseID, title: "b", values: [text: .text(RichText("hello")), num: .number(4)])
        s.addRow(to: c.databaseID, title: "c", values: [text: .text(RichText("yes"))])
        s.addRow(to: c.databaseID, title: "d", values: [text: .text(RichText(""))])   // blank: never counted
        let db = c.databaseID
        // Text → …
        #expect(s.conversionLoss(db, text, to: .number).cells == 2)        // "hello", "yes"
        #expect(s.conversionLoss(db, text, to: .checkbox).cells == 2)      // "12", "hello"
        #expect(s.conversionLoss(db, text, to: .select).isEmpty)
        #expect(s.conversionLoss(db, text, to: .multiSelect).isEmpty)
        #expect(s.conversionLoss(db, text, to: .url).isEmpty)
        #expect(s.conversionLoss(db, text, to: .date).cells == 3)
        for t in [PropertyType.formula, .rollup, .uniqueID, .person, .files, .relation, .createdTime, .lastEditedTime] {
            #expect(s.conversionLoss(db, text, to: t).cells == 3, "text → \(t)")
        }
        // Number → …
        #expect(s.conversionLoss(db, num, to: .text).isEmpty)
        #expect(s.conversionLoss(db, num, to: .select).isEmpty)
        #expect(s.conversionLoss(db, num, to: .formula).cells == 2)
        // Same type / title: nothing to convert.
        #expect(s.conversionLoss(db, text, to: .text).isEmpty)
        #expect(s.filledCellCount(db, text) == 3)
        #expect(s.filledCellCount(db, num) == 2)
        // Nothing was written by the checks.
        #expect(s.databases[db]!.property(text)!.type == .text)
    }

    @Test func typeChangeIsOneUndoStep() {
        let (f, kind, opts) = selectFixture()
        f.s.changePropertyType(f.db, kind, to: .formula)
        #expect(f.s.blocks[f.rows[0]]?.values[kind] == nil)
        f.s.undo()
        #expect(f.s.databases[f.db]!.property(kind)!.type == .select)
        #expect(f.s.blocks[f.rows[0]]?.values[kind] == .select(opts[0]))
    }
}
