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
