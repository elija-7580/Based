import Foundation
import Testing
@testable import BasedCore

/// BSD-17: no user formula or rollup configuration may trap, hang or recurse forever.
@MainActor
@Suite struct FormulaSafetyTests {
    func eval(_ src: String) throws -> Value {
        try Formula.evaluate(src, FormulaEnvironment(prop: { _ in .empty }, now: Date(timeIntervalSince1970: 1_700_000_000)))
    }

    func expectError(_ src: String, _ kind: FormulaError.Kind, sourceLocation: SourceLocation = #_sourceLocation) {
        do {
            let v = try eval(src)
            Issue.record("\(src) returned \(v) instead of an error", sourceLocation: sourceLocation)
        } catch let e as FormulaError {
            #expect(e.kind == kind, "\(src): \(e.message)", sourceLocation: sourceLocation)
        } catch {
            Issue.record("\(src): unexpected \(error)", sourceLocation: sourceLocation)
        }
    }

    @Test func divisionByZeroIsAnError() throws {
        expectError("1/0", .divisionByZero)
        expectError("0/0", .divisionByZero)
        expectError("5 % 0", .divisionByZero)
        expectError("divide(1, 0)", .divisionByZero)
        expectError("mod(1, 0)", .divisionByZero)
        #expect(try eval("7 / 2") == .number(3.5))
    }

    @Test func nonFiniteIntegerArgumentsDontTrap() {
        expectError("repeat(\"a\", 1/0)", .divisionByZero)          // the division already fails
        expectError("repeat(\"a\", 1e300)", .invalidArgument)
        expectError("repeat(\"a\", pow(10, 400))", .invalidArgument) // inf without a division
        expectError("substring(\"abc\", ln(0))", .invalidArgument)    // -inf
        expectError("substring(\"abc\", 0, sqrt(-1))", .invalidArgument) // NaN
        expectError("dateAdd(now(), 1e300, \"days\")", .invalidArgument)
        expectError("dateSubtract(now(), -1e300, \"years\")", .invalidArgument)
        expectError("dateAdd(now(), 1e8, \"years\")", .invalidArgument)
        expectError("at([1, 2], 1e19)", .invalidArgument)
        expectError("slice([1, 2], 0, 1e19)", .invalidArgument)
        expectError("splice([1, 2], -1e19)", .invalidArgument)
        expectError("padStart(\"x\", 1e300)", .invalidArgument)
    }

    @Test func hugeStringsAreRefused() throws {
        expectError("repeat(\"ab\", 60000)", .invalidArgument)
        expectError("padEnd(\"x\", 200000, \"-\")", .invalidArgument)
        #expect(try eval("repeat(\"ab\", 3)") == .string("ababab"))
        #expect(try eval("padStart(\"7\", 3, \"0\")") == .string("007"))
        #expect(try eval("padEnd(\"7\", 4, \"ab\")") == .string("7aba"))
        if case .string(let s) = try eval("padStart(\"\", 100000, \"x\")") { #expect(s.count == 100_000) }
        else { Issue.record("expected a string") }
    }

    @Test func normalDateAndListUseStillWorks() throws {
        #expect(try eval("dateAdd(now(), 5000, \"milliseconds\")") != .empty)
        #expect(try eval("year(dateAdd(parseDate(\"2024-01-15\"), 2, \"years\"))") == .number(2026))
        #expect(try eval("at([1, 2, 3], -1)") == .number(3))
        #expect(try eval("substring(\"hello\", 1, 3)") == .string("el"))
    }

    // MARK: Engine

    struct TwoDBs {
        let s: WorkspaceStore
        let a: RecordID, b: RecordID
        let relAB: String, relBA: String
        let rowA: RecordID, rowB: RecordID
    }

    /// Two databases A ↔ B with a two-way relation and one linked row each.
    func twoDBs() -> TwoDBs {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "q")
        let a = s.createDatabase(title: "A", in: .workspace, inline: false, sampleRows: 0).databaseID
        let b = s.createDatabase(title: "B", in: .workspace, inline: false, sampleRows: 0).databaseID
        let relAB = s.addProperty(to: a, name: "Bs", type: .relation)!
        s.updateProperty(a, relAB) { $0.relation = RelationConfig(databaseID: b) }
        s.makeRelationTwoWay(a, relAB, name: "As")
        let relBA = s.databases[b]!.property(named: "As")!.id
        let rowB = s.addRow(to: b, title: "b1")
        let rowA = s.addRow(to: a, title: "a1", values: [relAB: .relation([rowB])])
        if s.blocks[rowB]?.values[relBA] == nil { s.setValue(rowB, relBA, .relation([rowA])) }
        return TwoDBs(s: s, a: a, b: b, relAB: relAB, relBA: relBA, rowA: rowA, rowB: rowB)
    }

    @Test func mutualRollupsTerminateWithCycleError() {
        let f = twoDBs()
        let s = f.s
        let rA = s.addProperty(to: f.a, name: "Roll A", type: .rollup)!
        let rB = s.addProperty(to: f.b, name: "Roll B", type: .rollup)!
        s.updateProperty(f.a, rA) { $0.rollup = RollupConfig(relationPropertyID: f.relAB, targetPropertyID: rB, function: .countAll) }
        s.updateProperty(f.b, rB) { $0.rollup = RollupConfig(relationPropertyID: f.relBA, targetPropertyID: rA, function: .countAll) }

        let engine = QueryEngine(store: s)
        #expect(engine.value(f.rowA, rA) == .empty)
        #expect(engine.error(row: f.rowA, prop: rA)?.kind == .cycle)
        #expect(engine.failingProperties.contains(rA))
        #expect(engine.errors[rA] == "Circular reference")
        // The other side is part of the same cycle.
        #expect(engine.value(f.rowB, rB) == .empty)
        #expect(engine.error(row: f.rowB, prop: rB)?.kind == .cycle)
        // Whole-database queries terminate too.
        if let v = s.views.values.first(where: { $0.databaseID == f.a }) { _ = QueryEngine(store: s).run(v) }
    }

    @Test func formulaCycleAcrossRelationsIsDetected() {
        let f = twoDBs()
        let s = f.s
        let fa = s.addProperty(to: f.a, name: "FA", type: .formula)!
        let fb = s.addProperty(to: f.b, name: "FB", type: .formula)!
        s.updateProperty(f.a, fa) { $0.formula = "prop(\"Bs\").map(current.prop(\"FB\")).length()" }
        s.updateProperty(f.b, fb) { $0.formula = "prop(\"As\").map(current.prop(\"FA\")).length()" }
        let engine = QueryEngine(store: s)
        #expect(engine.value(f.rowA, fa) == .empty)
        #expect(engine.error(row: f.rowA, prop: fa)?.kind == .cycle)
    }

    @Test func longChainsStopAtMaxDepth() {
        // One database, rows linked in a chain r0 → r1 → … → r99; formula "Depth" = 1 + Next's Depth.
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "q")
        let db = s.createDatabase(title: "Chain", in: .workspace, inline: false, sampleRows: 0).databaseID
        let next = s.addProperty(to: db, name: "Next", type: .relation)!
        s.updateProperty(db, next) { $0.relation = RelationConfig(databaseID: db) }
        let depth = s.addProperty(to: db, name: "Depth", type: .formula)!
        s.updateProperty(db, depth) {
            $0.formula = "if(empty(prop(\"Next\")), 0, 1 + sum(prop(\"Next\").map(current.prop(\"Depth\"))))"
        }
        var rows: [RecordID] = []
        var last: RecordID?
        for i in 0..<100 {
            let r = s.addRow(to: db, title: RichText("r\(i)"), values: last.map { [next: .relation([$0])] } ?? [:])
            rows.append(r); last = r
        }
        let engine = QueryEngine(store: s)
        // Short chain: fine.
        #expect(engine.value(rows[10], depth) == .number(10))
        // 99 links: cut off with an error instead of recursing (default limit 32).
        #expect(QueryEngine.defaultMaxDepth == 32)
        let fresh = QueryEngine(store: s)
        #expect(fresh.value(rows[99], depth) == .empty)
        #expect(fresh.error(row: rows[99], prop: depth)?.kind == .tooDeep)
    }

    @Test func formulaErrorsArePerCell() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "q")
        let db = s.createDatabase(title: "N", in: .workspace, inline: false, sampleRows: 0).databaseID
        let n = s.addProperty(to: db, name: "N", type: .number)!
        let inv = s.addProperty(to: db, name: "Inverse", type: .formula)!
        s.updateProperty(db, inv) { $0.formula = "1 / prop(\"N\")" }
        let zero = s.addRow(to: db, title: "zero", values: [n: .number(0)])
        let two = s.addRow(to: db, title: "two", values: [n: .number(2)])
        let engine = QueryEngine(store: s)
        #expect(engine.value(two, inv) == .number(0.5))
        #expect(engine.error(row: two, prop: inv) == nil)
        #expect(engine.value(zero, inv) == .empty)
        #expect(engine.error(row: zero, prop: inv)?.kind == .divisionByZero)
        #expect(engine.failingProperties == [inv])
        engine.reset()
        #expect(engine.failingProperties.isEmpty)
    }

    @Test func wouldCreateRollupCycle() {
        let f = twoDBs()
        let s = f.s
        let rB = s.addProperty(to: f.b, name: "Roll B", type: .rollup)!
        let rA = s.addProperty(to: f.a, name: "Roll A", type: .rollup)!
        // B rolls up A's title: harmless.
        s.updateProperty(f.b, rB) { $0.rollup = RollupConfig(relationPropertyID: f.relBA, targetPropertyID: Database.titlePropertyID) }
        #expect(!s.wouldCreateRollupCycle(database: f.a, property: rA, relationPropertyID: f.relAB, targetPropertyID: rB))
        // B rolls up A's rollup: A rolling up B's rollup would close the loop.
        s.updateProperty(f.b, rB) { $0.rollup = RollupConfig(relationPropertyID: f.relBA, targetPropertyID: rA) }
        #expect(s.wouldCreateRollupCycle(database: f.a, property: rA, relationPropertyID: f.relAB, targetPropertyID: rB))
        #expect(!s.wouldCreateRollupCycle(database: f.a, property: rA, relationPropertyID: f.relAB, targetPropertyID: Database.titlePropertyID))
        // Through a formula on B that reads the rollup.
        let fb = s.addProperty(to: f.b, name: "FB", type: .formula)!
        s.updateProperty(f.b, fb) { $0.formula = "prop(\"Roll B\") + 1" }
        #expect(s.wouldCreateRollupCycle(database: f.a, property: rA, relationPropertyID: f.relAB, targetPropertyID: fb))
    }
}
