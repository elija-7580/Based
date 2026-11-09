import Foundation

/// Configuration of a chart view (Notion "Chart" layout).
public struct ChartConfig: Codable, Hashable, Sendable {
    public enum Kind: OpenRawEnum, Sendable {
        case bar, horizontalBar, line, area, pie, donut, number
        /// BSD-130: a chart type from a newer Based; drawn as a bar chart, written back unchanged.
        case unknown(String)
        public static let allCases: [Kind] = [.bar, .horizontalBar, .line, .area, .pie, .donut, .number]
        public var rawValue: String {
            switch self {
            case .bar: return "bar"
            case .horizontalBar: return "horizontalBar"
            case .line: return "line"
            case .area: return "area"
            case .pie: return "pie"
            case .donut: return "donut"
            case .number: return "number"
            case .unknown(let raw): return raw
            }
        }
        public var displayName: String {
            switch self {
            case .unknown: return "Needs a newer version"
            case .number: return "Number"
            case .bar: return "Vertical bar"
            case .horizontalBar: return "Horizontal bar"
            case .line: return "Line"
            case .area: return "Area"
            case .pie: return "Pie"
            case .donut: return "Donut"
            }
        }
    }
    public enum Aggregate: OpenRawEnum, Sendable {
        case count, sum, average, min, max, median
        /// BSD-130: an aggregation from a newer Based; counts rows, written back unchanged.
        case unknown(String)
        public static let allCases: [Aggregate] = [.count, .sum, .average, .min, .max, .median]
        public var rawValue: String {
            switch self {
            case .count: return "count"
            case .sum: return "sum"
            case .average: return "average"
            case .min: return "min"
            case .max: return "max"
            case .median: return "median"
            case .unknown(let raw): return raw
            }
        }
        public var displayName: String { isUnknown ? "Needs a newer version" : rawValue.capitalized }
    }
    public enum DateBucket: OpenRawEnum, Sendable {
        case day, week, month, quarter, year
        /// BSD-130: a bucket from a newer Based; groups by month, written back unchanged.
        case unknown(String)
        public static let allCases: [DateBucket] = [.day, .week, .month, .quarter, .year]
        public var rawValue: String {
            switch self {
            case .day: return "day"
            case .week: return "week"
            case .month: return "month"
            case .quarter: return "quarter"
            case .year: return "year"
            case .unknown(let raw): return raw
            }
        }
        public var displayName: String { isUnknown ? "Needs a newer version" : rawValue.capitalized }
    }
    public var kind: Kind
    /// Property used for the x axis / slices. `nil` groups everything into one bucket.
    public var xPropertyID: String?
    /// Numeric property aggregated on the y axis. `nil` → count rows.
    public var yPropertyID: String?
    public var aggregate: Aggregate
    public var dateBucket: DateBucket
    public var showLegend: Bool
    public var showValues: Bool
    public var sortByValue: Bool
    public var limit: Int?
    /// Text shown under the chart (Notion `caption`).
    public var caption: String?
    /// Notion colour theme: gray, blue, yellow, green, purple, teal, orange, pink, red, auto, colorful.
    public var colorTheme: String?
    /// small / medium / large / extra_large.
    public var height: String?
    /// BSD-130: keys this version doesn't know; written back unchanged.
    var extra: [String: JSONValue] = [:]

    /// Chart height in points for Notion's height presets.
    public var heightPoints: Double {
        switch height {
        case "small"?: return 200
        case "large"?: return 400
        case "extra_large"?: return 520
        default: return 280
        }
    }

    public init(kind: Kind = .bar, xPropertyID: String? = nil, yPropertyID: String? = nil, aggregate: Aggregate = .count,
                dateBucket: DateBucket = .month, showLegend: Bool = true, showValues: Bool = true, sortByValue: Bool = false, limit: Int? = nil) {
        self.kind = kind; self.xPropertyID = xPropertyID; self.yPropertyID = yPropertyID; self.aggregate = aggregate
        self.dateBucket = dateBucket; self.showLegend = showLegend; self.showValues = showValues; self.sortByValue = sortByValue; self.limit = limit
    }
}

public struct ChartPoint: Hashable, Sendable, Identifiable {
    public var id: String { key }
    public var key: String        // stable id (option id / bucket key)
    public var label: String
    public var value: Double
    public var color: TColor?
    public var sortDate: Date?
    public init(key: String, label: String, value: Double, color: TColor? = nil, sortDate: Date? = nil) {
        self.key = key; self.label = label; self.value = value; self.color = color; self.sortDate = sortDate
    }
}

/// Aggregates database rows for a chart. Pure, so it is unit-tested on Linux.
@MainActor
public struct ChartData {
    public let engine: QueryEngine
    public init(engine: QueryEngine) { self.engine = engine }

    public func points(rows: [Block], db: Database, config: ChartConfig, calendar: Calendar = .current) -> [ChartPoint] {
        var buckets: [String: (label: String, values: [Double], color: TColor?, date: Date?)] = [:]
        var order: [String] = []
        let xProp = config.xPropertyID.flatMap { db.property($0) }
        let yProp = config.yPropertyID.flatMap { db.property($0) }
        for row in rows {
            let keys = bucketKeys(row, xProp, db, config, calendar)
            let y: Double
            if let yProp {
                let v = engine.value(row, yProp, db)
                guard let n = v.number else { continue }
                y = n
            } else { y = 1 }
            for k in keys {
                if buckets[k.key] == nil { buckets[k.key] = (k.label, [], k.color, k.date); order.append(k.key) }
                buckets[k.key]!.values.append(y)
            }
        }
        var pts = order.map { k -> ChartPoint in
            let b = buckets[k]!
            return ChartPoint(key: k, label: b.label, value: reduce(b.values, config.aggregate, countRows: config.yPropertyID == nil), color: b.color, sortDate: b.date)
        }
        if let xProp, xProp.type == .select || xProp.type == .status || xProp.type == .multiSelect {
            let optionOrder = (xProp.options ?? []).map(\.id)
            pts.sort { (optionOrder.firstIndex(of: $0.key) ?? .max) < (optionOrder.firstIndex(of: $1.key) ?? .max) }
        } else if pts.allSatisfy({ $0.sortDate != nil }) {
            pts.sort { $0.sortDate! < $1.sortDate! }
        } else {
            pts.sort { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
        }
        if config.sortByValue { pts.sort { $0.value > $1.value } }
        if let limit = config.limit, limit > 0, pts.count > limit {
            let rest = pts[limit...].reduce(0) { $0 + $1.value }
            pts = Array(pts.prefix(limit)) + [ChartPoint(key: "__other", label: "Other", value: rest, color: .gray)]
        }
        return pts
    }

    /// Single value for "Number" charts: the aggregate over all rows (count when no y property).
    public func number(rows: [Block], db: Database, config: ChartConfig) -> Double {
        guard let yProp = config.yPropertyID.flatMap({ db.property($0) }) else { return Double(rows.count) }
        let xs = rows.compactMap { engine.value($0, yProp, db).number }
        return reduce(xs, config.aggregate, countRows: false)
    }

    private struct Bucket { var key: String; var label: String; var color: TColor?; var date: Date? }

    private func bucketKeys(_ row: Block, _ p: PropertySchema?, _ db: Database, _ c: ChartConfig, _ cal: Calendar) -> [Bucket] {
        guard let p else { return [Bucket(key: "all", label: "All", color: nil, date: nil)] }
        func empty(_ label: String = "Empty") -> [Bucket] { [Bucket(key: "__empty", label: label, color: .gray, date: nil)] }
        func options(_ ids: [String]) -> [Bucket] {
            if ids.isEmpty { return empty() }
            return ids.map { id in let o = p.option(id); return Bucket(key: id, label: o?.name ?? id, color: o?.color, date: nil) }
        }
        switch p.type {
        case .select, .status, .multiSelect:
            switch row.values[p.id] {
            case .select(let id)?, .status(let id)?: return options([id])
            case .multiSelect(let ids)?: return options(ids)
            default: return empty()
            }
        case .checkbox:
            if case .checkbox(let b)? = row.values[p.id], b { return [Bucket(key: "yes", label: "Checked", color: .green, date: nil)] }
            return [Bucket(key: "no", label: "Unchecked", color: .gray, date: nil)]
        default: break
        }
        let v = engine.value(row, p, db)
        switch v {
        case .date(let d):
            let (start, label) = bucketDate(d.start, c.dateBucket, cal)
            return [Bucket(key: "d:\(Int(start.timeIntervalSince1970))", label: label, color: nil, date: start)]
        case .bool(let b):
            return [Bucket(key: b ? "yes" : "no", label: b ? "Checked" : "Unchecked", color: b ? .green : .gray, date: nil)]
        case .number(let n):
            return [Bucket(key: "n:\(n)", label: CellFormatter.number(n, p.numberFormat), color: nil, date: nil)]
        case .empty:
            return empty(p.type == .date ? "No date" : "Empty")
        default:
            let t = CellFormatter.text(v, store: engine.store)
            return t.isEmpty ? empty() : [Bucket(key: "t:\(t)", label: t, color: nil, date: nil)]
        }
    }

    private func bucketDate(_ d: Date, _ b: ChartConfig.DateBucket, _ cal: Calendar) -> (Date, String) {
        let f = DateFormatter(); f.calendar = cal
        switch b {
        case .day:
            let s = cal.startOfDay(for: d); f.dateStyle = .medium; f.timeStyle = .none; return (s, f.string(from: s))
        case .week:
            let s = cal.dateInterval(of: .weekOfYear, for: d)?.start ?? d; f.dateFormat = "d MMM"; return (s, "Wk " + f.string(from: s))
        case .month, .unknown:
            let s = cal.dateInterval(of: .month, for: d)?.start ?? d; f.dateFormat = "MMM yyyy"; return (s, f.string(from: s))
        case .quarter:
            let s = cal.dateInterval(of: .quarter, for: d)?.start ?? d; let q = (cal.component(.month, from: s) - 1) / 3 + 1
            return (s, "Q\(q) \(cal.component(.year, from: s))")
        case .year:
            let s = cal.dateInterval(of: .year, for: d)?.start ?? d; return (s, "\(cal.component(.year, from: s))")
        }
    }

    private func reduce(_ xs: [Double], _ a: ChartConfig.Aggregate, countRows: Bool) -> Double {
        if countRows || a == .count || a.isUnknown { return Double(xs.count) }
        guard !xs.isEmpty else { return 0 }
        switch a {
        case .count, .unknown: return Double(xs.count)
        case .sum: return xs.reduce(0, +)
        case .average: return xs.reduce(0, +) / Double(xs.count)
        case .min: return xs.min() ?? 0
        case .max: return xs.max() ?? 0
        case .median:
            let s = xs.sorted(); let m = s.count / 2
            return s.count % 2 == 0 ? (s[m - 1] + s[m]) / 2 : s[m]
        }
    }
}

/// Notion dashboard layout: rows (max. 4 widgets each) on a 12-column grid. Each widget shows a view.
public struct DashboardConfig: Codable, Hashable, Sendable {
    public struct Widget: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var viewID: RecordID
        /// Columns out of 12.
        public var width: Int
        /// BSD-130: keys this version doesn't know; written back unchanged.
        var extra: [String: JSONValue] = [:]
        public init(id: String = RecordIDs.make(), viewID: RecordID, width: Int = 12) {
            self.id = id; self.viewID = viewID; self.width = width
        }
    }
    public struct Row: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var widgets: [Widget]
        /// Fixed row height in points (nil = automatic).
        public var height: Double?
        /// BSD-130: keys this version doesn't know; written back unchanged.
        var extra: [String: JSONValue] = [:]
        public init(id: String = RecordIDs.make(), widgets: [Widget], height: Double? = nil) {
            self.id = id; self.widgets = widgets; self.height = height
        }
    }
    public static let columns = 12
    public static let maxWidgetsPerRow = 4

    public var rows: [Row]
    /// BSD-130: keys this version doesn't know; written back unchanged.
    var extra: [String: JSONValue] = [:]
    public init(rows: [Row] = []) { self.rows = rows }

    public var widgetViewIDs: [RecordID] { rows.flatMap { $0.widgets.map(\.viewID) } }

    /// Splits 12 columns evenly (remainder to the first widgets).
    public static func evenWidths(_ n: Int) -> [Int] {
        guard n > 0 else { return [] }
        let base = columns / n, extra = columns % n
        return (0..<n).map { base + ($0 < extra ? 1 : 0) }
    }

    /// Adds a widget in a new row (`rowIndex` nil or ≥ count / row full) or next to the widgets of `rowIndex`.
    public mutating func insert(_ viewID: RecordID, rowIndex: Int?, newRow: Bool) {
        if !newRow, let r = rowIndex, rows.indices.contains(r), rows[r].widgets.count < Self.maxWidgetsPerRow {
            rows[r].widgets.append(Widget(viewID: viewID))
            let w = Self.evenWidths(rows[r].widgets.count)
            for i in rows[r].widgets.indices { rows[r].widgets[i].width = w[i] }
        } else {
            let row = Row(widgets: [Widget(viewID: viewID, width: Self.columns)])
            // newRow: insert at rowIndex; a full existing row: put the new row right below it.
            let at = rowIndex.map { newRow ? $0 : $0 + 1 }
            if let r = at, r >= 0, r <= rows.count { rows.insert(row, at: r) } else { rows.append(row) }
        }
    }

    /// Removes a widget; its row's remaining widgets share the freed columns, empty rows disappear.
    public mutating func remove(viewID: RecordID) {
        for r in rows.indices.reversed() {
            guard let i = rows[r].widgets.firstIndex(where: { $0.viewID == viewID }) else { continue }
            rows[r].widgets.remove(at: i)
            if rows[r].widgets.isEmpty { rows.remove(at: r); continue }
            let w = Self.evenWidths(rows[r].widgets.count)
            for j in rows[r].widgets.indices { rows[r].widgets[j].width = w[j] }
        }
    }

    /// Sets a widget's width (1…12); the neighbour to its right (or left) absorbs the difference so the row
    /// keeps filling 12 columns.
    public mutating func setWidth(viewID: RecordID, _ width: Int) {
        for r in rows.indices {
            guard let i = rows[r].widgets.firstIndex(where: { $0.viewID == viewID }) else { continue }
            let n = rows[r].widgets.count
            if n == 1 { rows[r].widgets[i].width = Self.columns; return }
            let j = i + 1 < n ? i + 1 : i - 1
            let pair = rows[r].widgets[i].width + rows[r].widgets[j].width
            let w = min(max(1, width), pair - 1)
            rows[r].widgets[i].width = w
            rows[r].widgets[j].width = pair - w
            return
        }
    }

    /// Moves a widget into row `toRow` at `index` (or into a new row at `toRow` when `newRow`).
    public mutating func move(viewID: RecordID, toRow: Int, index: Int? = nil, newRow: Bool = false) {
        guard let from = rows.firstIndex(where: { $0.widgets.contains { $0.viewID == viewID } }) else { return }
        let target = rows[from].id
        let destID = rows.indices.contains(toRow) ? rows[toRow].id : nil
        if !newRow, destID == target, let i = index {
            var ws = rows[from].widgets
            guard let cur = ws.firstIndex(where: { $0.viewID == viewID }) else { return }
            let w = ws.remove(at: cur)
            ws.insert(w, at: min(max(0, i > cur ? i - 1 : i), ws.count))
            rows[from].widgets = ws
            return
        }
        if !newRow, let d = destID, let dest = rows.firstIndex(where: { $0.id == d }), rows[dest].widgets.count >= Self.maxWidgetsPerRow { return }
        remove(viewID: viewID)
        if newRow || destID == nil {
            let at = min(max(0, toRow), rows.count)
            rows.insert(Row(widgets: [Widget(viewID: viewID, width: Self.columns)]), at: at)
        } else if let d = destID, let dest = rows.firstIndex(where: { $0.id == d }) {
            let at = min(max(0, index ?? rows[dest].widgets.count), rows[dest].widgets.count)
            rows[dest].widgets.insert(Widget(viewID: viewID), at: at)
            let w = Self.evenWidths(rows[dest].widgets.count)
            for j in rows[dest].widgets.indices { rows[dest].widgets[j].width = w[j] }
        }
    }
}
