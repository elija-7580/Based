import Foundation

/// Configuration of a chart view (Notion "Chart" layout).
public struct ChartConfig: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case bar, horizontalBar, line, area, pie, donut
        public var displayName: String {
            switch self {
            case .bar: return "Vertical bar"
            case .horizontalBar: return "Horizontal bar"
            case .line: return "Line"
            case .area: return "Area"
            case .pie: return "Pie"
            case .donut: return "Donut"
            }
        }
    }
    public enum Aggregate: String, Codable, CaseIterable, Sendable {
        case count, sum, average, min, max, median
        public var displayName: String { rawValue.capitalized }
    }
    public enum DateBucket: String, Codable, CaseIterable, Sendable {
        case day, week, month, quarter, year
        public var displayName: String { rawValue.capitalized }
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
        case .month:
            let s = cal.dateInterval(of: .month, for: d)?.start ?? d; f.dateFormat = "MMM yyyy"; return (s, f.string(from: s))
        case .quarter:
            let s = cal.dateInterval(of: .quarter, for: d)?.start ?? d; let q = (cal.component(.month, from: s) - 1) / 3 + 1
            return (s, "Q\(q) \(cal.component(.year, from: s))")
        case .year:
            let s = cal.dateInterval(of: .year, for: d)?.start ?? d; return (s, "\(cal.component(.year, from: s))")
        }
    }

    private func reduce(_ xs: [Double], _ a: ChartConfig.Aggregate, countRows: Bool) -> Double {
        if countRows || a == .count { return Double(xs.count) }
        guard !xs.isEmpty else { return 0 }
        switch a {
        case .count: return Double(xs.count)
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
