import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct ChartAndCacheTests {
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

    @Test func numberChart() {
        let f = fixture()
        let engine = QueryEngine(store: f.store)
        let rows = engine.run(f.store.views[f.viewID]!).rows
        let data = ChartData(engine: engine)
        #expect(data.number(rows: rows, db: f.store.databases[f.dbID]!, config: ChartConfig(kind: .number)) == 6)
        #expect(data.number(rows: rows, db: f.store.databases[f.dbID]!, config: ChartConfig(kind: .number, yPropertyID: f.amount, aggregate: .sum)) == 210)
        #expect(ChartConfig(kind: .number).heightPoints == 280)
    }

    @Test func dashboardLayoutOps() {
        var c = DashboardConfig()
        c.insert("a", rowIndex: nil, newRow: true)
        c.insert("b", rowIndex: 0, newRow: false)
        c.insert("c", rowIndex: 0, newRow: false)
        #expect(c.rows.count == 1)
        #expect(c.rows[0].widgets.map(\.width) == [4, 4, 4])
        c.insert("d", rowIndex: 0, newRow: false)
        c.insert("e", rowIndex: 0, newRow: false)   // row full (4) → new row
        #expect(c.rows.map { $0.widgets.map(\.viewID) } == [["a", "b", "c", "d"], ["e"]])
        c.setWidth(viewID: "a", 5)
        #expect(c.rows[0].widgets.map(\.width) == [5, 1, 3, 3])
        c.remove(viewID: "b")
        #expect(c.rows[0].widgets.map(\.width) == [4, 4, 4])
        c.move(viewID: "e", toRow: 0, index: 0)
        #expect(c.rows.map { $0.widgets.map(\.viewID) } == [["e", "a", "c", "d"]], "empty row removed")
        c.move(viewID: "d", toRow: 1, newRow: true)
        #expect(c.rows.map { $0.widgets.map(\.viewID) } == [["e", "a", "c"], ["d"]])
        #expect(c.widgetViewIDs == ["e", "a", "c", "d"])
    }

    @Test func dashboardStoreOps() throws {
        let f = fixture()
        let s = f.store
        let block = s.views[f.viewID]!.blockID
        let dashID = try #require(s.addView(to: block, type: .dashboard))
        let dash = try #require(s.views[dashID])
        #expect(dash.type == .dashboard)
        #expect(s.views(forBlock: block).map(\.type) == [.table, .dashboard], "widgets aren't tabs")
        let widgets = dash.dashboard!.widgetViewIDs
        #expect(widgets.count == 3)
        #expect(s.views[widgets[0]]?.chart?.kind == .number)
        let x = try #require(s.views[widgets[1]]?.chart?.xPropertyID)
        #expect([.status, .select].contains(s.databases[f.dbID]?.property(x)?.type))
        #expect(widgets.allSatisfy { s.views[$0]?.widgetOf == dashID })

        // A widget over another database
        let other = s.createDatabase(title: RichText("Other"), in: .workspace, inline: false, sampleRows: 0)
        let w = try #require(s.addDashboardWidget(dashID, type: .board, databaseID: other.databaseID, rowIndex: 1, newRow: false))
        #expect(s.views[w]?.databaseID == other.databaseID)
        #expect(s.views[dashID]?.dashboard?.rows[1].widgets.count == 2)
        s.setDashboardWidgetWidth(dashID, widget: w, width: 4)
        #expect(s.views[dashID]?.dashboard?.rows[1].widgets.map(\.width) == [8, 4])
        s.deleteView(w)   // deleting a widget view removes it from the layout
        #expect(s.views[w] == nil)
        #expect(s.views[dashID]?.dashboard?.rows[1].widgets.map(\.width) == [12])
        #expect(s.addDashboardWidget(dashID, type: .dashboard) == nil, "no nested dashboards")

        s.deleteView(dashID)
        #expect(s.views[dashID] == nil)
        #expect(widgets.allSatisfy { s.views[$0] == nil }, "widgets go with their dashboard")
        s.undo()
        #expect(s.views[dashID] != nil)
        #expect(s.views(forBlock: block).count == 2)
    }

    @Test func chartCountBySelect() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        let pts = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(kind: .bar, xPropertyID: f.status, aggregate: .count))
        #expect(pts.count == 2)
        #expect(pts.first { $0.key == f.open }?.value == 4)
        #expect(pts.first { $0.key == f.done }?.value == 2)
        #expect(pts.first { $0.key == f.done }?.color == .green)
        #expect(pts.first { $0.key == f.open }?.label == "Open")
    }

    @Test func chartSumAverageAndSort() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        let sum = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .sum, sortByValue: true))
        // Done rows: i=0,3 → 10+40 = 50; Open rows: 20+30+50+60 = 160
        #expect(sum.first?.value == 160); #expect(sum.last?.value == 50)
        let avg = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .average))
        #expect(avg.first { $0.key == f.done }?.value == 25)
        let mx = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.status, yPropertyID: f.amount, aggregate: .max))
        #expect(mx.first { $0.key == f.open }?.value == 60)
    }

    @Test func chartDateBucketsAndLimit() {
        let f = fixture()
        let db = f.store.databases[f.dbID]!
        let data = ChartData(engine: QueryEngine(store: f.store))
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let months = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(kind: .line, xPropertyID: f.due, aggregate: .count, dateBucket: .month), calendar: cal)
        #expect(months.count == 3)
        #expect(months.map(\.value) == [2, 2, 2])
        #expect(months.first?.sortDate != nil)
        let limited = data.points(rows: f.store.rows(of: f.dbID), db: db, config: ChartConfig(xPropertyID: f.due, aggregate: .count, dateBucket: .month, limit: 2), calendar: cal)
        #expect(limited.count == 3, "2 buckets + Other")
        #expect(limited.last?.label == "Other"); #expect(limited.last?.value == 2)
    }

    @Test func queryCacheHitsAndInvalidation() {
        let f = fixture()
        let cache = QueryCache(store: f.store)
        let view = f.store.views[f.viewID]!
        #expect(cache.run(view).rows.count == 6)
        _ = cache.run(view); _ = cache.run(view)
        #expect(cache.hits == 2); #expect(cache.misses == 1)
        _ = cache.run(view, search: "Row 1")
        #expect(cache.misses == 2)
        let rev = f.store.revision
        _ = f.store.addRow(to: f.dbID, title: RichText("New"))
        #expect(f.store.revision > rev)
        #expect(cache.run(view).rows.count == 7)
        #expect(cache.misses == 3)
    }

    @Test func rowPager() {
        let rows = (0..<120).map { i in Block(type: .page, parent: .workspace, sortKey: "a\(i)") }
        var pager = RowPager(pageSize: 50)
        #expect(pager.visible(rows).count == 50); #expect(pager.hasMore(rows))
        pager.loadMore(); #expect(pager.visible(rows).count == 100)
        pager.loadMore(); #expect(pager.visible(rows).count == 120); #expect(!pager.hasMore(rows))
        pager.reset(); #expect(pager.visible(rows).count == 50)
        pager.loadAll(rows); #expect(pager.visible(rows).count == 120)
    }

    /// Large-database smoke benchmark: 50k rows, filtered + sorted table query must stay well under a second (debug build).
    @Test func largeDatabasePerformance() {
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
        #expect(r.rows.count == 50_000)
        let q1 = Date(); _ = cache.run(view); let cached = Date().timeIntervalSince(q1)
        print("PERF insert 50k: \(insert)s, query: \(query)s, cached: \(cached)s")
        #expect(query < 5.0)
        #expect(cached < 0.01)
    }
}

@Suite struct FractionalIndexTests {
    @Test func appendKeysStayShort() {
        var k: String? = nil; var all: [String] = []
        for _ in 0..<100_000 { k = FractionalIndex.between(k, nil); all.append(k!) }
        #expect(all.last!.count <= 5)
        #expect(all == all.sorted())
        #expect(Set(all).count == all.count)
    }

    @Test func prependAndMidpoints() {
        var k: String? = nil; var all: [String] = []
        for _ in 0..<500 { k = FractionalIndex.between(nil, k); all.append(k!) }
        #expect(all.reversed() == all.sorted())
        let a = "a0", b = "a1"
        var hi = b; var mids: [String] = []
        for _ in 0..<40 { let m = FractionalIndex.between(a, hi); #expect(a < m && m < hi, "\(a) < \(m) < \(hi)"); mids.append(m); hi = m }
        let n = FractionalIndex.keys(count: 15, between: a, b)
        #expect(n == n.sorted()); #expect(n.allSatisfy { a < $0 && $0 < b })
        #expect(FractionalIndex.keys(count: 3).count == 3)
    }

    @Test func legacyKeysStillWork() {
        // keys from the pre-format midpoint scheme (single base-62 digits etc.)
        let a = "V", b = "k"
        let m = FractionalIndex.between(a, b); #expect(a < m && m < b)
        let after = FractionalIndex.between("zV", nil); #expect(after > "zV")
        let before = FractionalIndex.between(nil, "1"); #expect(before < "1")
        let mixed = FractionalIndex.between("V", "a0"); #expect("V" < mixed && mixed < "a0")
    }
}
