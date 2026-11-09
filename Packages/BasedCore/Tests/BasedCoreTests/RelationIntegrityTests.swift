import Foundation
import Testing
@testable import BasedCore

/// BSD-31: relations, rollups, formulas and views stay consistent whatever happens to properties, rows or pages.
@MainActor
@Suite struct RelationIntegrityTests {
    /// Projects ⇄ Tasks (two-way), a rollup "Total" over task hours, one project linked to two tasks.
    @MainActor struct Fixture {
        let s: WorkspaceStore
        let projects: RecordID, tasks: RecordID
        let rel: String, mirror: String, hours: String, roll: String
        let p: RecordID, t1: RecordID, t2: RecordID
        var view: RecordID { s.views.values.first { $0.databaseID == projects && $0.widgetOf == nil }!.id }
    }

    func fixture() -> Fixture {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "ri")
        let projects = s.createDatabase(title: "Projects", in: .workspace, inline: false, sampleRows: 0).databaseID
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0).databaseID
        let hours = s.addProperty(to: tasks, name: "Hours", type: .number)!
        let rel = s.addProperty(to: projects, name: "Tasks", type: .relation)!
        s.updateProperty(projects, rel) { $0.relation = RelationConfig(databaseID: tasks) }
        s.makeRelationTwoWay(projects, rel)
        let mirror = s.databases[projects]!.property(rel)!.relation!.syncedPropertyID!
        let roll = s.addProperty(to: projects, name: "Total", type: .rollup)!
        s.updateProperty(projects, roll) { $0.rollup = RollupConfig(relationPropertyID: rel, targetPropertyID: hours, function: .sum) }
        let p = s.addRow(to: projects, title: "Launch")
        let t1 = s.addRow(to: tasks, title: "Write", values: [hours: .number(2)])
        let t2 = s.addRow(to: tasks, title: "Ship", values: [hours: .number(3)])
        s.setRelation(p, rel, [t1, t2])
        return Fixture(s: s, projects: projects, tasks: tasks, rel: rel, mirror: mirror, hours: hours, roll: roll, p: p, t1: t1, t2: t2)
    }

    // MARK: 1. Rename

    @Test func renameRewritesFormulas() {
        let f = fixture()
        let est = f.s.addProperty(to: f.projects, name: "Budget \"A\"", type: .number)!
        let formula = f.s.addProperty(to: f.projects, name: "Double", type: .formula)!
        f.s.updateProperty(f.projects, formula) {
            $0.formula = #"prop("Budget \"A\"") * 2 + prop("Tasks").map(current.prop("Budget \"A\"")).length()"#
        }
        let simple = f.s.addProperty(to: f.projects, name: "Simple", type: .formula)!
        f.s.updateProperty(f.projects, simple) { $0.formula = #"prop("Budget \"A\"") * 2"# }
        f.s.setValue(f.p, est, .number(21))
        f.s.renameProperty(f.projects, est, to: "Cost")
        let src = f.s.databases[f.projects]!.property(formula)!.formula!
        // Own property rewritten; `current.prop(…)` reads a related page and stays.
        #expect(src == #"prop("Cost") * 2 + prop("Tasks").map(current.prop("Budget \"A\"")).length()"#)
        let q = QueryEngine(store: f.s)
        #expect(q.value(f.p, simple) == .number(42))
        _ = f.s.undo()
        #expect(f.s.databases[f.projects]!.property(est)!.name == "Budget \"A\"")
        #expect(f.s.databases[f.projects]!.property(formula)!.formula!.hasPrefix(#"prop("Budget \"A\"") * 2"#))
    }

    @Test func renameRewriteOnlyTouchesExactNames() {
        let out = WorkspaceStore.renamingFormulaReferences(#"prop("A") + prop( "A" ) + prop("AB") + x.prop("A")"#, from: "A", to: "Z")
        #expect(out == #"prop("Z") + prop("Z") + prop("AB") + x.prop("A")"#)
        #expect(WorkspaceStore.renamingFormulaReferences(#"prop("B")"#, from: "A", to: "Z") == #"prop("B")"#)
    }

    // MARK: 2. Delete property

    @Test func deletingOneSideLeavesOneWayRelationWithValues() {
        let f = fixture()
        f.s.deleteProperty(f.projects, f.rel)
        let m = f.s.databases[f.tasks]!.property(f.mirror)!
        #expect(m.relation?.syncedPropertyID == nil)
        #expect(f.s.blocks[f.t1]?.values[f.mirror] == .relation([f.p]))  // values stay
        #expect(f.s.databases[f.projects]!.property(f.roll)!.rollup == nil) // rollup through it reset
        // A later edit of the old mirror doesn't write into the deleted property (no ghost data).
        f.s.setRelation(f.t1, f.mirror, [])
        #expect(f.s.blocks[f.p]?.values[f.rel] == nil)
        #expect(f.s.blocks[f.p]?.values.keys.contains(f.rel) == false)
    }

    @Test func deletingMirrorKeepsSourceAndUndoRestoresBoth() {
        let f = fixture()
        f.s.deleteProperty(f.tasks, f.mirror)
        #expect(f.s.databases[f.projects]!.property(f.rel)!.relation?.syncedPropertyID == nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == .relation([f.t1, f.t2]))
        f.s.setRelation(f.p, f.rel, [f.t1])  // no write into the deleted mirror
        #expect(f.s.blocks[f.t2]?.values[f.mirror] == nil)
        _ = f.s.undo()   // setRelation
        _ = f.s.undo()   // delete property: one step restores schema, link and values
        #expect(f.s.databases[f.tasks]!.property(f.mirror) != nil)
        #expect(f.s.databases[f.projects]!.property(f.rel)!.relation?.syncedPropertyID == f.mirror)
        #expect(f.s.blocks[f.t1]?.values[f.mirror] == .relation([f.p]))
    }

    @Test func deletingPropertyCleansViewsChartsCoversAndForeignRollups() {
        let f = fixture()
        // A rollup on Tasks? No: a rollup on Projects that shows task hours is the "foreign" case for Tasks.Hours.
        f.s.updateView(f.view) { v in
            v.chart = ChartConfig(kind: .bar, xPropertyID: f.roll, yPropertyID: f.roll)
            v.cardCover = .property(f.roll)
            v.sorts = [SortRule(propertyID: f.roll)]
        }
        f.s.deleteProperty(f.tasks, f.hours)
        #expect(f.s.databases[f.projects]!.property(f.roll)!.rollup == nil)
        f.s.deleteProperty(f.projects, f.roll)
        let v = f.s.views[f.view]!
        #expect(v.chart?.xPropertyID == nil && v.chart?.yPropertyID == nil)
        #expect(v.cardCover == nil)
        #expect(v.sorts?.isEmpty == true)
    }

    // MARK: 3. Change target / type

    @Test func changingTargetDropsMirrorValuesAndRollups() {
        let f = fixture()
        let other = f.s.createDatabase(title: "People", in: .workspace, inline: false, sampleRows: 0).databaseID
        f.s.setRelationTarget(f.projects, f.rel, to: other)
        let p = f.s.databases[f.projects]!.property(f.rel)!
        #expect(p.relation?.databaseID == other && p.relation?.syncedPropertyID == nil)
        #expect(f.s.databases[f.tasks]!.property(f.mirror) == nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == nil)
        #expect(f.s.blocks[f.t1]?.values[f.mirror] == nil)
        #expect(f.s.databases[f.projects]!.property(f.roll)!.rollup == nil)
        _ = f.s.undo()
        #expect(f.s.databases[f.projects]!.property(f.rel)!.relation?.databaseID == f.tasks)
        #expect(f.s.databases[f.tasks]!.property(f.mirror) != nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == .relation([f.t1, f.t2]))
    }

    @Test func typeChangeAwayFromRelationRemovesMirror() {
        let f = fixture()
        f.s.changePropertyType(f.projects, f.rel, to: .text)
        let p = f.s.databases[f.projects]!.property(f.rel)!
        #expect(p.type == .text && p.relation == nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == .text(RichText("Write, Ship")))
        #expect(f.s.databases[f.tasks]!.property(f.mirror) == nil)
        #expect(f.s.blocks[f.t1]?.values[f.mirror] == nil)
        #expect(f.s.databases[f.projects]!.property(f.roll)!.rollup == nil)
    }

    // MARK: 4. Duplicate

    @Test func duplicatedPropertyIsOneWay() {
        let f = fixture()
        let copy = f.s.duplicateProperty(f.projects, f.rel)!
        let c = f.s.databases[f.projects]!.property(copy)!
        #expect(c.relation?.databaseID == f.tasks && c.relation?.syncedPropertyID == nil)
        #expect(f.s.blocks[f.p]?.values[copy] == .relation([f.t1, f.t2]))
        #expect(f.s.databases[f.tasks]!.property(f.mirror)!.relation?.syncedPropertyID == f.rel)
    }

    @Test func duplicatedRowAndTemplateRowUpdateMirror() {
        let f = fixture()
        let dup = f.s.duplicateBlocks([f.p]).first!
        if case .relation(let ids)? = f.s.blocks[f.t1]?.values[f.mirror] { #expect(Set(ids) == [f.p, dup]) }
        else { Issue.record("mirror not updated") }
        let tpl = f.s.addTemplate(to: f.projects)
        f.s.setRelation(tpl, f.rel, [f.t2])
        let row = f.s.addRow(to: f.projects, title: "From template", template: tpl)
        if case .relation(let ids)? = f.s.blocks[f.t2]?.values[f.mirror] { #expect(ids.contains(row)) }
        else { Issue.record("mirror not updated") }
        let plain = f.s.addRow(to: f.projects, title: "With value", values: [f.rel: .relation([f.t1])])
        if case .relation(let ids)? = f.s.blocks[f.t1]?.values[f.mirror] { #expect(ids.contains(plain)) }
        else { Issue.record("mirror not updated") }
    }

    @Test func duplicatedDatabaseHasOneWayRelations() {
        let f = fixture()
        let block = f.s.databases[f.projects]!.blockID
        let copyBlock = f.s.duplicateBlocks([block]).first!
        let copyDB = f.s.blocks[copyBlock]!.props.databaseID!
        #expect(copyDB != f.projects)
        #expect(f.s.databases[copyDB]!.property(f.rel)!.relation?.syncedPropertyID == nil)
        #expect(f.s.databases[f.tasks]!.property(f.mirror)!.relation?.syncedPropertyID == f.rel)
        #expect(f.s.blocks[f.t1]?.values[f.mirror] == .relation([f.p]))
    }

    // MARK: 5. Trash and delete forever

    @Test func trashedTargetsAreHiddenAndDeletedForeverAreUnlinked() {
        let f = fixture()
        let db = f.s.databases[f.projects]!
        let q = QueryEngine(store: f.s)
        f.s.trash([f.t1])
        q.reset()
        #expect(q.value(f.s.blocks[f.p]!, db.property(f.rel)!, db) == .list([.page(f.t2)]))
        #expect(q.value(f.p, f.roll) == .number(3))
        f.s.deleteForever([f.t1])
        #expect(f.s.blocks[f.p]?.values[f.rel] == .relation([f.t2]))
        _ = f.s.undo()
        #expect(f.s.blocks[f.t1] != nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == .relation([f.t1, f.t2]))
    }

    @Test func deletingTargetDatabaseForeverMakesRelationOneWay() {
        let f = fixture()
        let block = f.s.databases[f.tasks]!.blockID
        f.s.trash([block])
        f.s.deleteForever([block])
        #expect(f.s.databases[f.tasks] == nil)
        #expect(f.s.databases[f.projects]!.property(f.rel)!.relation?.syncedPropertyID == nil)
        #expect(f.s.blocks[f.p]?.values[f.rel] == nil)
    }

    // MARK: 6. Delete option

    @Test func deletingOptionCleansFiltersAndGroups() {
        let f = fixture()
        let kind = f.s.addProperty(to: f.projects, name: "Kind", type: .select)!
        let a = f.s.addOption(f.projects, kind, name: "A")!
        let b = f.s.addOption(f.projects, kind, name: "B")!
        f.s.updateView(f.view) { v in
            v.filter = FilterGroup(items: [
                .condition(FilterCondition(propertyID: kind, op: .equals, value: .options([a, b]))),
                .group(FilterGroup(items: [.condition(FilterCondition(propertyID: kind, op: .equals, value: .options([a])))])),
            ])
            var g = GroupRule(propertyID: kind)
            g.groupOrder = [a, b]; g.hiddenGroups = [a]
            v.groupBy = g
        }
        f.s.deleteOption(f.projects, kind, a)
        let v = f.s.views[f.view]!
        guard case .condition(let c1)? = v.filter?.items.first, case .group(let sub)? = v.filter?.items.last,
              case .condition(let c2)? = sub.items.first else { Issue.record("filter shape"); return }
        #expect(c1.value == .options([b]))
        #expect(c2.value == nil)
        #expect(v.groupBy?.groupOrder == [b] && v.groupBy?.hiddenGroups == [])
        _ = f.s.undo()
        #expect(f.s.views[f.view]!.groupBy?.groupOrder == [a, b])
    }
}
