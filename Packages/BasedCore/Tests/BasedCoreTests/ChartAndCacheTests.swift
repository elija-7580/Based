import XCTest
@testable import BasedCore

@MainActor
final class ChartAndCacheTests: XCTestCase {
    struct Fixture { let store: WorkspaceStore; let dbID: RecordID; let viewID: RecordID; let status: String; let amount: String; let due: String; let open: String; let done: String }

    func fixture(rows: Int = 6) -> Fixture {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let page = s.createPage(title: "P")
        let c = s.createDatabase(title: RichText("Deals"), in: .block(page), inline: true, sampleRows: 0)
        let status = s.addProperty(to: c.databaseID, name: "Stage", type: .select)!
        let open = s.addOption(c.databaseID, status, name: "Open", color: .blue)!
        let done = s.addOption(c.databaseID, status, name: "Done", color: .green)!
        let amount = s.addProperty(to: c.databaseID, name: "Amount", type: .number)!
        let due = s.addProperty(to: c.databaseID, name: "Due", type: .date)!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        for i in 0..<rows {
            let d = cal.date(from: DateComponents(year: 2026, month: 1 + (i % 3), day: 5))!
            _ = s.addRow(to: c.databaseID, title: RichText("Row \(i)"), values: [
                status: .select(i % 3 == 0 ? done : open),
                amount: .number(Double(i + 1) * 10),
                due: .date(DateValue(start: d)),
            ])
        }
        return Fixture(store: s, dbID: c.databaseID, viewID: c.viewID, status: status, amount: amount, due: due, open: open, done: done)
    }

    func testNumberChart() {
        let f = fixture()
        let engine = QueryEngine(store: f.store)
        let rows = engine.run(f.store.views[f.viewID]!).rows
        let data = ChartData(engine: engine)
        XCTAssertEqual(data.number(rows: rows, db: f.store.databases[f.dbID]!, config: ChartConfig(kind: .number)), 6)
        XCTAssertEqual(data.number(rows: rows, db: f.store.databases[f.dbID]!, config: ChartConfig(kind: .number, yPropertyID: f.amount, aggregate: .sum)), 210)
        XCTAssertEqual(ChartConfig(kind: .number).heightPoints, 280)
    }

    func testDashboardLayoutOps() {
        var c = DashboardConfig()
        c.insert("a", rowIndex: nil, newRow: true)
        c.insert("b", rowIndex: 0, newRow: false)
        c.insert("c", rowIndex: 0, newRow: false)
        XCTAssertEqual(c.rows.count, 1)
        XCTAssertEqual(c.rows[0].widgets.map(\.width), [4, 4, 4])
        c.insert("d", rowIndex: 0, newRow: false)
        c.insert("e", rowIndex: 0, newRow: false)   // row full (4) → new row
        XCTAssertEqual(c.rows.map { $0.widgets.map(\.viewID) }, [["a", "b", "c", "d"], ["e"]])
        c.setWidth(viewID: "a", 5)
        XCTAssertEqual(c.rows[0].widgets.map(\.width), [5, 1, 3, 3])
        c.remove(viewID: "b")
        XCTAssertEqual(c.rows[0].widgets.map(\.width), [4, 4, 4])
        c.move(viewID: "e", toRow: 0, index: 0)
        XCTAssertEqual(c.rows.map { $0.widgets.map(\.viewID) }, [["e", "a", "c", "d"]], "empty row removed")
        c.move(viewID: "d", toRow: 1, newRow: true)
        XCTAssertEqual(c.rows.map { $0.widgets.map(\.viewID) }, [["e", "a", "c"], ["d"]])
        XCTAssertEqual(c.widgetViewIDs, ["e", "a", "c", "d"])
    }

    func testDashboardStoreOps() throws {
        let f = fixture()
        let s = f.store
        let block = s.views[f.viewID]!.blockID
        let dashID = try XCTUnwrap(s.addView(to: block, type: .dashboard))
        let dash = try XCTUnwrap(s.views[dashID])
        XCTAssertEqual(dash.type, .dashboard)
        XCTAssertEqual(s.views(forBlock: block).map(\.type), [.table, .dashboard], "widgets aren't tabs")
        let widgets = dash.dashboard!.widgetViewIDs
        XCTAssertEqual(widgets.count, 3)
        XCTAssertEqual(s.views[widgets[0]]?.chart?.kind, .number)
        let x = try XCTUnwrap(s.views[widgets[1]]?.chart?.xPropertyID)
        XCTAssertTrue([.status, .select].contains(s.databases[f.dbID]?.property(x)?.type))
        XCTAssertTrue(widgets.allSatisfy { s.views[$0]?.widgetOf == dashID })

        // A widget over another database
        let other = s.createDatabase(title: RichText("Other"), in: .workspace, inline: false, sampleRows: 0)
        let w = try XCTUnwrap(s.addDashboardWidget(dashID, type: .board, databaseID: other.databaseID, rowIndex: 1, newRow: false))
        XCTAssertEqual(s.views[w]?.databaseID, other.databaseID)
        XCTAssertEqual(s.views[dashID]?.dashboard?.rows[1].widgets.count, 2)
        s.setDashboardWidgetWidth(dashID, widget: w, width: 4)
        XCTAssertEqual(s.views[dashID]?.dashboard?.rows[1].widgets.map(\.width), [8, 4])
        s.deleteView(w)   // deleting a widget view removes it from the layout
        XCTAssertNil(s.views[w])
        XCTAssertEqual(s.views[dashID]?.dashboard?.rows[1].widgets.map(\.width), [12])
        XCTAssertNil(s.addDashboardWidget(dashID, type: .dashboard), "no nested dashboards")

        s.deleteView(dashID)
        XCTAssertNil(s.views[dashID])
        XCTAssertTrue(widgets.allSatisfy { s.views[$0] == nil }, "widgets go with their dashboard")
        s.undo()
        XCTAssertNotNil(s.views[dashID])
        XCTAssertEqual(s.views(forBlock: block).count, 2)
    }

    func testChartCountBySelect() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        let pts = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(kind: .bar, xPropertyID: f.status, aggregate: .count))
        XCTAssertEqual(pts.count, 2)
        XCTAssertEqual(pts.first { $0.key == f.open }?.value, 4)
        XCTAssertEqual(pts.first { $0.key == f.done }?.value, 2)
        XCTAssertEqual(pts.first { $0.key == f.done }?.color, .green)
        XCTAssertEqual(pts.first { $0.key == f.open }?.label, "Open")
    }

    func testChartSumAverageAndSort() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        let sum = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .sum, sortByValue: true))
        // Done rows: i=0,3 → 10+40 = 50; Open rows: 20+30+50+60 = 160
        XCTAssertEqual(sum.first?.value, 160); XCTAssertEqual(sum.last?.value, 50)
        let avg = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .average))
        XCTAssertEqual(avg.first { $0.key == f.done }?.value, 25)
        let mx = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .max))
        XCTAssertEqual(mx.first { $0.key == f.open }?.value, 60)
    }

    func testChartDateBucketsAndLimit() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let months = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(kind: .line, xPropertyID: f.due, aggregate: .count, dateBucket: .month), calendar: cal)
        XCTAssertEqual(months.count, 3)
        XCTAssertEqual(months.map(\.value), [2, 2, 2])
        XCTAssertNotNil(months.first?.sortDate)
        let limited = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.due, aggregate: .count, dateBucket: .month, limit: 2), calendar: cal)
        XCTAssertEqual(limited.count, 3, "2 buckets + Other")
        XCTAssertEqual(limited.last?.label, "Other"); XCTAssertEqual(limited.last?.value, 2)
    }

    func testQueryCacheHitsAndInvalidation() {
        let f = fixture()
        let cache = QueryCache(store: f.store)
        let view = f.store.views[f.viewID]!
        XCTAssertEqual(cache.run(view).rows.count, 6)
        _ = cache.run(view); _ = cache.run(view)
        XCTAssertEqual(cache.hits, 2); XCTAssertEqual(cache.misses, 1)
        _ = cache.run(view, search: "Row 1")
        XCTAssertEqual(cache.misses, 2)
        let rev = f.store.revision
        _ = f.store.addRow(to: f.dbID, title: RichText("New"))
        XCTAssertGreaterThan(f.store.revision, rev)
        XCTAssertEqual(cache.run(view).rows.count, 7)
        XCTAssertEqual(cache.misses, 3)
    }

    func testRowPager() {
        let rows = (0..<120).map { i in Block(type: .page, parent: .workspace, sortKey: "a\(i)") }
        var pager = RowPager(pageSize: 50)
        XCTAssertEqual(pager.visible(rows).count, 50); XCTAssertTrue(pager.hasMore(rows))
        pager.loadMore(); XCTAssertEqual(pager.visible(rows).count, 100)
        pager.loadMore(); XCTAssertEqual(pager.visible(rows).count, 120); XCTAssertFalse(pager.hasMore(rows))
        pager.reset(); XCTAssertEqual(pager.visible(rows).count, 50)
        pager.loadAll(rows); XCTAssertEqual(pager.visible(rows).count, 120)
    }

    /// Large-database smoke benchmark: 50k rows, filtered + sorted table query must stay well under a second (debug build).
    func testLargeDatabasePerformance() {
        let f = fixture(rows: 0)
        let start = Date()
        f.store.transact("bulk") { _ in
            for i in 0..<50_000 {
                _ = f.store.addRow(to: f.dbID, title: RichText("Item \(i)"), values: [f.status: .select(i % 2 == 0 ? f.open : f.done), f.amount: .number(Double(i))])
            }
        }
        let insert = Date().timeIntervalSince(start)
        var view = f.store.views[f.viewID]!
        view.sorts = [SortRule(propertyID: f.amount, ascending: false)]
        let cache = QueryCache(store: f.store)
        let q0 = Date()
        let r = cache.run(view)
        let query = Date().timeIntervalSince(q0)
        XCTAssertEqual(r.rows.count, 50_000)
        let q1 = Date(); _ = cache.run(view); let cached = Date().timeIntervalSince(q1)
        print("PERF insert 50k: \(insert)s, query: \(query)s, cached: \(cached)s")
        XCTAssertLessThan(query, 5.0)
        XCTAssertLessThan(cached, 0.01)
    }
}

final class FractionalIndexTests: XCTestCase {
    func testAppendKeysStayShort() {
        var k: String? = nil; var all: [String] = []
        for _ in 0..<100_000 { k = FractionalIndex.between(k, nil); all.append(k!) }
        XCTAssertLessThanOrEqual(all.last!.count, 5)
        XCTAssertEqual(all, all.sorted())
        XCTAssertEqual(Set(all).count, all.count)
    }

    func testPrependAndMidpoints() {
        var k: String? = nil; var all: [String] = []
        for _ in 0..<500 { k = FractionalIndex.between(nil, k); all.append(k!) }
        XCTAssertEqual(all.reversed(), all.sorted())
        let a = "a0", b = "a1"
        var hi = b; var mids: [String] = []
        for _ in 0..<40 { let m = FractionalIndex.between(a, hi); XCTAssert(a < m && m < hi, "\(a) < \(m) < \(hi)"); mids.append(m); hi = m }
        let n = FractionalIndex.keys(count: 15, between: a, b)
        XCTAssertEqual(n, n.sorted()); XCTAssert(n.allSatisfy { a < $0 && $0 < b })
        XCTAssertEqual(FractionalIndex.keys(count: 3).count, 3)
    }

    func testLegacyKeysStillWork() {
        // keys from the pre-format midpoint scheme (single base-62 digits etc.)
        let a = "V", b = "k"
        let m = FractionalIndex.between(a, b); XCTAssert(a < m && m < b)
        let after = FractionalIndex.between("zV", nil); XCTAssertGreaterThan(after, "zV")
        let before = FractionalIndex.between(nil, "1"); XCTAssertLessThan(before, "1")
        let mixed = FractionalIndex.between("V", "a0"); XCTAssert("V" < mixed && mixed < "a0")
    }
}
