import Foundation
import Testing
@testable import BasedCore

/// BSD-39: query results and formula/rollup values survive edits outside their database.
@MainActor
@Suite struct QueryCacheInvalidationTests {
    struct Fixture {
        let s: WorkspaceStore
        let note: RecordID, para: RecordID
        let projects: CreatedDatabase, tasks: CreatedDatabase, other: CreatedDatabase
        let hours: String, rel: String, roll: String, double: String
        let launch: RecordID, t1: RecordID, t2: RecordID, otherRow: RecordID
    }

    func fixture() -> Fixture {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "q")
        let note = s.createPage(title: "Notes")
        let para = s.insertBlock(.text, text: "Hello", in: .block(note))
        let projects = s.createDatabase(title: "Projects", in: .workspace, inline: false, sampleRows: 0)
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        let other = s.createDatabase(title: "Other", in: .workspace, inline: false, sampleRows: 0)
        let hours = s.addProperty(to: tasks.databaseID, name: "Hours", type: .number)!
        let double = s.addProperty(to: tasks.databaseID, name: "Double", type: .formula)!
        s.updateProperty(tasks.databaseID, double) { $0.formula = "prop(\"Hours\") * 2" }
        let rel = s.addProperty(to: projects.databaseID, name: "Tasks", type: .relation)!
        s.updateProperty(projects.databaseID, rel) { $0.relation = RelationConfig(databaseID: tasks.databaseID) }
        let roll = s.addProperty(to: projects.databaseID, name: "Total", type: .rollup)!
        s.updateProperty(projects.databaseID, roll) { $0.rollup = RollupConfig(relationPropertyID: rel, targetPropertyID: double, function: .sum) }
        let launch = s.addRow(to: projects.databaseID, title: "Launch")
        let t1 = s.addRow(to: tasks.databaseID, title: "Write", values: [hours: .number(2)])
        let t2 = s.addRow(to: tasks.databaseID, title: "Ship", values: [hours: .number(3)])
        s.setRelation(launch, rel, [t1, t2])
        let otherRow = s.addRow(to: other.databaseID, title: "Unrelated")
        return Fixture(s: s, note: note, para: para, projects: projects, tasks: tasks, other: other,
                       hours: hours, rel: rel, roll: roll, double: double, launch: launch, t1: t1, t2: t2, otherRow: otherRow)
    }

    @Test func typingOutsideTheDatabaseKeepsResults() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let view = f.s.views[f.projects.viewID]!
        #expect(cache.run(view).rows.count == 1)
        #expect(cache.queryEngine.value(f.launch, f.roll) == .number(10))
        let rev = f.s.databaseRevision(f.projects.databaseID)
        for i in 0..<50 { f.s.setText(f.para, RichText("Hello \(i)")) }
        _ = f.s.addRow(to: f.other.databaseID, title: "Also unrelated")
        #expect(f.s.databaseRevision(f.projects.databaseID) == rev)
        _ = cache.run(view)
        #expect(cache.hits == 1); #expect(cache.misses == 1)
        #expect(cache.queryEngine.memoizedDatabases.contains(f.projects.databaseID), "formula memo survives")
    }

    @Test func rowEditInTheDatabaseRecomputes() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let view = f.s.views[f.projects.viewID]!
        _ = cache.run(view)
        _ = f.s.addRow(to: f.projects.databaseID, title: "Second")
        #expect(cache.run(view).rows.count == 2)
        #expect(cache.misses == 2)
    }

    @Test func editInReferencedDatabaseRecomputesRollup() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let view = f.s.views[f.projects.viewID]!
        _ = cache.run(view)
        #expect(cache.queryEngine.value(f.launch, f.roll) == .number(10))
        f.s.setValue(f.t1, f.hours, .number(10))
        _ = cache.run(view)
        #expect(cache.misses == 2, "a related database changed")
        #expect(cache.queryEngine.value(f.launch, f.roll) == .number(26))
        // Trashing a related row also counts.
        f.s.trash([f.t2])
        #expect(cache.queryEngine.value(f.launch, f.roll) == .number(20))
    }

    @Test func rowEditDropsOnlyThatRowsFormulas() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let engine = cache.queryEngine
        #expect(engine.value(f.t1, f.double) == .number(4))
        #expect(engine.value(f.t2, f.double) == .number(6))
        f.s.setValue(f.t1, f.hours, .number(5))
        #expect(engine.value(f.t1, f.double) == .number(10))
        #expect(engine.value(f.t2, f.double) == .number(6))
        // Schema change: the formula itself changes for every row.
        f.s.updateProperty(f.tasks.databaseID, f.double) { $0.formula = "prop(\"Hours\") * 3" }
        #expect(engine.value(f.t2, f.double) == .number(9))
    }

    @Test func locallyEditedViewIsAMiss() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        var view = f.s.views[f.tasks.viewID]!
        #expect(cache.run(view).rows.count == 2)
        // An edited copy (same id and updatedAt) must not return the old result.
        view.sorts = [SortRule(propertyID: f.hours, ascending: false)]
        #expect(cache.run(view).rows.map(\.id) == [f.t2, f.t1])
        #expect(cache.misses == 2)
    }

    @Test func derivedValuesFollowTheResult() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let view = f.s.views[f.tasks.viewID]!
        var computed = 0
        func count() -> Int { cache.derived(view, tag: "n") { computed += 1; return cache.run(view).rows.count } }
        #expect(count() == 2); #expect(count() == 2)
        #expect(computed == 1)
        f.s.setText(f.para, "typing")
        #expect(count() == 2); #expect(computed == 1)
        _ = f.s.addRow(to: f.tasks.databaseID, title: "Third")
        #expect(count() == 3); #expect(computed == 2)
    }

    @Test func selfRelationDropsTheWholeDatabase() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "sr")
        let db = s.createDatabase(title: "People", in: .workspace, inline: false, sampleRows: 0)
        let age = s.addProperty(to: db.databaseID, name: "Age", type: .number)!
        let rel = s.addProperty(to: db.databaseID, name: "Friends", type: .relation)!
        s.updateProperty(db.databaseID, rel) { $0.relation = RelationConfig(databaseID: db.databaseID) }
        let roll = s.addProperty(to: db.databaseID, name: "Friends' age", type: .rollup)!
        s.updateProperty(db.databaseID, roll) { $0.rollup = RollupConfig(relationPropertyID: rel, targetPropertyID: age, function: .sum) }
        let a = s.addRow(to: db.databaseID, title: "A", values: [age: .number(30)])
        let b = s.addRow(to: db.databaseID, title: "B", values: [age: .number(40)])
        s.setRelation(b, rel, [a])
        let cache = QueryCache(store: s)
        #expect(cache.queryEngine.value(b, roll) == .number(30))
        s.setValue(a, age, .number(31))
        #expect(cache.queryEngine.value(b, roll) == .number(31))
    }

    @Test func undoAndRemoteChangesBumpTheDatabase() {
        let f = fixture()
        let cache = QueryCache(store: f.s)
        let view = f.s.views[f.tasks.viewID]!
        #expect(cache.run(view).rows.count == 2)
        _ = f.s.addRow(to: f.tasks.databaseID, title: "Third")
        #expect(cache.run(view).rows.count == 3)
        f.s.undo()
        #expect(cache.run(view).rows.count == 2)
    }

    /// Benchmark (acceptance): 50k rows, 3 formulas, 1000 keystrokes outside → no recomputation.
    @Test func keystrokesOutsideALargeDatabaseNeverRecompute() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "big")
        let note = s.createPage(title: "Notes")
        let para = s.insertBlock(.text, text: "", in: .block(note))
        let db = s.createDatabase(title: "Big", in: .workspace, inline: false, sampleRows: 0)
        let n = s.addProperty(to: db.databaseID, name: "N", type: .number)!
        var formulas: [String] = []
        for (i, src) in ["prop(\"N\") * 2", "prop(\"N\") + 1", "if(prop(\"N\") > 100, \"big\", \"small\")"].enumerated() {
            let p = s.addProperty(to: db.databaseID, name: "F\(i)", type: .formula)!
            s.updateProperty(db.databaseID, p) { $0.formula = src }
            formulas.append(p)
        }
        s.transact("bulk") { _ in
            for i in 0..<50_000 { _ = s.addRow(to: db.databaseID, title: RichText("R\(i)"), values: [n: .number(Double(i))]) }
        }
        var view = s.views[db.viewID]!
        view.sorts = [SortRule(propertyID: formulas[0], ascending: false)]
        let cache = QueryCache(store: s)
        let r = cache.run(view)
        #expect(r.rows.count == 50_000)
        let t0 = Date()
        var typed = ""
        for i in 0..<1000 { typed += String(i % 10); s.setText(para, RichText(typed)); _ = cache.run(view) }
        let elapsed = Date().timeIntervalSince(t0)
        print("PERF 1000 keystrokes outside a 50k-row database: \(elapsed)s")
        #expect(cache.misses == 1)
        #expect(cache.hits == 1000)
    }
}
