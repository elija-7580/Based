import Foundation

public struct RowGroup: Identifiable, Hashable {
    /// Option id, person id, "true"/"false", a date bucket key, or "" for the empty group.
    public var id: String
    public var title: String
    public var color: TColor?
    public var rows: [Block]
    public var isEmptyGroup: Bool { id.isEmpty }
}

public struct QueryResult {
    public var rows: [Block]
    public var groups: [RowGroup]?
}

/// Evaluates property values (incl. formulas and rollups), filters, sorts, groups and calculations.
@MainActor
public final class QueryEngine {
    public let store: WorkspaceStore
    public var now: Date
    private var formulas: [String: Result<Formula, FormulaError>] = [:]
    /// Memoized cell values: row id → property id → value (BSD-39: per row, so a change drops only its rows).
    private var memo: [RecordID: [String: Value]] = [:]
    /// Rows with memoized values or errors, per database (for `invalidate(database:)`).
    private var rowsByDB: [RecordID: Set<RecordID>] = [:]
    /// Whether a formula evaluated since the last reset reads the clock (`now()` / `today()`).
    public private(set) var usesNow = false
    /// Formula / rollup cells being evaluated right now, innermost last (cycle and depth guard, BSD-17).
    private var stack: [String] = []
    private var onStack: Set<String> = []
    /// Longest chain of formulas / rollups (also across relations) before evaluation stops with `.tooDeep`.
    /// 32, not 64: each level costs several formula-evaluator frames, and 64 levels overflowed the 512 KB stack
    /// of a non-main thread in tests (48 still passed).
    public static let defaultMaxDepth = 32
    public var maxDepth = QueryEngine.defaultMaxDepth
    /// Errors per cell (row id → property id): cycles, too deep, invalid arguments, division by zero.
    private var cellErrors: [RecordID: [String: FormulaError]] = [:]
    /// An error message per property id (any failing row).
    public var errors: [String: String] {
        var out: [String: String] = [:]
        for row in cellErrors.values { for (prop, e) in row { out[prop] = e.message } }
        return out
    }
    /// Property ids with at least one failing cell.
    public var failingProperties: Set<String> { Set(cellErrors.values.flatMap(\.keys)) }

    public init(store: WorkspaceStore, now: Date = Date()) {
        self.store = store
        self.now = now
    }

    /// Drop memoized values (call after edits).
    public func reset(now: Date = Date()) {
        memo.removeAll(); rowsByDB.removeAll(); cellErrors.removeAll(); usesNow = false; self.now = now
    }

    /// BSD-39: drops memoized values and errors of these rows of a database, or of all its rows (`rows == nil`).
    public func invalidate(database id: RecordID, rows: Set<RecordID>? = nil) {
        guard let known = rowsByDB[id] else { return }
        let drop = rows.map { known.intersection($0) } ?? known
        for r in drop { memo[r] = nil; cellErrors[r] = nil }
        if rows == nil { rowsByDB[id] = nil } else { rowsByDB[id] = known.subtracting(drop) }
    }

    /// Databases that hold memoized values right now.
    public var memoizedDatabases: Set<RecordID> { Set(rowsByDB.keys) }

    // MARK: Values

    public func value(_ rowID: RecordID, _ propertyID: String) -> Value {
        guard let row = store.blocks[rowID], let db = store.database(ofRow: rowID),
              let p = db.property(propertyID) ?? (propertyID == Database.titlePropertyID ? db.titleProperty : nil) else { return .empty }
        return value(row, p, db)
    }

    /// The error of a formula or rollup cell (after its value was computed), nil if it's fine.
    public func error(row: RecordID, prop: String) -> FormulaError? { cellErrors[row]?[prop] }

    private static func split(_ key: String) -> (row: RecordID, prop: String) {
        let parts = key.split(separator: "\u{1}", maxSplits: 1, omittingEmptySubsequences: false)
        return (String(parts.first ?? ""), parts.count > 1 ? String(parts[1]) : "")
    }

    private func fail(_ key: String, _ propID: String, _ e: FormulaError) {
        let row = Self.split(key).row
        // A cycle / depth error explains the cell best; follow-up errors (empty input) don't replace it.
        if let old = cellErrors[row]?[propID], old.kind == .cycle || old.kind == .tooDeep { return }
        cellErrors[row, default: [:]][propID] = e
        if let b = store.blocks[row], case .database(let d) = b.parent { rowsByDB[d, default: []].insert(row) }
    }

    public func value(_ row: Block, _ p: PropertySchema, _ db: Database) -> Value {
        let key = row.id + "\u{1}" + p.id
        if let v = memo[row.id]?[p.id] { return v }
        let v: Value
        switch p.type {
        case .title: v = .string(row.text.plainText)
        case .formula, .rollup:
            // One guard for formulas and rollups, across rows and relations: a cell already being evaluated
            // is a cycle; a chain deeper than `maxDepth` stops. Both give an empty cell with an error.
            if onStack.contains(key) {
                // Every cell on the cycle is wrong, not only the one that noticed.
                if let i = stack.lastIndex(of: key) {
                    for k in stack[i...] { if let pid = k.split(separator: "\u{1}", maxSplits: 1).last { fail(k, String(pid), .cycle) } }
                }
                return .empty
            }
            guard stack.count < maxDepth else {
                // The whole chain is cut off: mark every cell on it.
                fail(key, p.id, .tooDeep)
                for k in stack { if let pid = k.split(separator: "\u{1}", maxSplits: 1).last { fail(k, String(pid), .tooDeep) } }
                return .empty
            }
            stack.append(key); onStack.insert(key)
            let computed = p.type == .formula ? formulaValue(row, p, db, key: key) : rollupValue(row, p, db)
            stack.removeLast(); onStack.remove(key)
            if let e = cellErrors[row.id]?[p.id], e.kind == .cycle || e.kind == .tooDeep { v = .empty } else { v = computed }
        case .createdTime: v = .date(DateValue(start: row.createdAt, includeTime: true))
        case .lastEditedTime: v = .date(DateValue(start: row.updatedAt, includeTime: true))
        case .createdBy: v = row.createdBy.map(Value.person) ?? .empty
        case .lastEditedBy: v = row.updatedBy.map(Value.person) ?? .empty
        case .button, .verification: v = .empty
        case .relation:
            // Linked pages in the Trash (or gone) don't show up, like in Notion (BSD-31).
            if case .relation(let ids)? = row.values[p.id] { v = .list(liveRelationTargets(ids).map(Value.page)) }
            else { v = Self.value(of: row.values[p.id], p) }
        default: v = Self.value(of: row.values[p.id], p)
        }
        memo[row.id, default: [:]][p.id] = v
        rowsByDB[db.id, default: []].insert(row.id)
        return v
    }

    /// Relation targets that still exist and aren't in the Trash.
    public func liveRelationTargets(_ ids: [RecordID]) -> [RecordID] {
        store.liveRelationTargets(ids)
    }

    /// Stored value → computed value.
    public static func value(of pv: PropertyValue?, _ p: PropertySchema) -> Value {
        guard let pv else { return p.type == .checkbox ? .bool(false) : .empty }
        switch pv {
        case .unknown: return .empty   // BSD-107: value kind from a newer version
        case .text(let t): return .string(t.plainText)
        case .number(let n): return .number(n)
        case .select(let id), .status(let id): return p.option(id).map { .string($0.name) } ?? .empty
        case .multiSelect(let ids): return .list(ids.compactMap { p.option($0).map { .string($0.name) } })
        case .date(let d): return .date(d)
        case .person(let ids): return .list(ids.map(Value.person))
        case .files(let f): return .list(f.map { .string($0.name) })
        case .checkbox(let b): return .bool(b)
        case .url(let s), .email(let s), .phone(let s): return .string(s)
        case .place(let s): return .string(PlaceValue.display(s))
        case .relation(let ids): return .list(ids.map(Value.page))
        case .uniqueID(let n): return .number(Double(n))
        }
    }

    func compiled(_ src: String) -> Result<Formula, FormulaError> {
        if let f = formulas[src] { return f }
        let r: Result<Formula, FormulaError>
        do { r = .success(try Formula(src)) } catch let e as FormulaError { r = .failure(e) } catch { r = .failure(FormulaError("\(error)")) }
        formulas[src] = r
        return r
    }

    func formulaValue(_ row: Block, _ p: PropertySchema, _ db: Database, key: String) -> Value {
        guard let src = p.formula, !src.trimmingCharacters(in: .whitespaces).isEmpty else { return .empty }
        if !usesNow { let l = src.lowercased(); if l.contains("now(") || l.contains("today(") { usesNow = true } }
        switch compiled(src) {
        case .failure(let e):
            fail(key, p.id, e)
            return .empty
        case .success(let f):
            do {
                let v = try f.evaluate(environment(row, db))
                // inf / NaN (e.g. ln(0), pow overflow) shows as an error, not as "inf".
                if case .number(let n) = v, !n.isFinite {
                    fail(key, p.id, FormulaError("Result is not a finite number", kind: .invalidArgument))
                    return .empty
                }
                return v
            } catch let e as FormulaError {
                fail(key, p.id, e)
                return .empty
            } catch {
                fail(key, p.id, FormulaError("\(error)"))
                return .empty
            }
        }
    }

    public func environment(_ row: Block, _ db: Database) -> FormulaEnvironment {
        FormulaEnvironment(
            prop: { [unowned self] name in
                guard let q = db.property(named: name) else { throw FormulaError("Property “\(name)” not found") }
                return self.value(row, q, db)
            },
            pageProp: { [unowned self] pid, name in
                guard let r = self.store.blocks[pid], let d = self.store.database(ofRow: pid) else {
                    if name.lowercased() == "title" || name.lowercased() == "name" { return .string(self.store.title(of: pid)) }
                    return .empty
                }
                guard let q = d.property(named: name) else { throw FormulaError("Property “\(name)” not found") }
                return self.value(r, q, d)
            },
            pageTitle: { [unowned self] in self.store.title(of: $0) },
            personName: { $0 == "me" ? "Me" : $0 },
            personEmail: { _ in "" },
            currentPage: row.id,
            now: now)
    }

    func rollupValue(_ row: Block, _ p: PropertySchema, _ db: Database) -> Value {
        guard let cfg = p.rollup, let rel = db.property(cfg.relationPropertyID), let rc = rel.relation,
              let target = store.databases[rc.databaseID] else { return .empty }
        guard case .relation(let ids)? = row.values[rel.id] else { return Self.aggregate([], cfg.function, nil) }
        let tp = target.property(cfg.targetPropertyID) ?? target.titleProperty
        let values = ids.compactMap { store.blocks[$0] }.filter { !store.isTrashed($0.id) }.map { value($0, tp, target) }
        return Self.aggregate(values, cfg.function, tp)
    }

    // MARK: Aggregation (rollups and footer calculations)

    public static func aggregate(_ values: [Value], _ fn: CalculationType, _ p: PropertySchema?) -> Value {
        let flat = values.flatMap { v -> [Value] in if case .list(let l) = v { return l.isEmpty ? [.empty] : l } else { return [v] } }
        let nonEmpty = values.filter { !$0.isEmpty }
        let total = Double(values.count)
        func pct(_ x: Int) -> Value { .number(total == 0 ? 0 : Double(x) / total) }
        let nums = flat.compactMap { v -> Double? in if case .number(let n) = v { return n } else { return nil } }
        let dates = flat.compactMap { v -> Date? in if case .date(let d) = v { return d.start } else { return nil } }
        let bools = values.map { v -> Bool in if case .bool(let b) = v { return b } else { return false } }
        switch fn {
        case .none, .unknown: return .empty
        case .showOriginal: return .list(flat.filter { !$0.isEmpty })
        case .countAll: return .number(total)
        case .countValues: return .number(Double(flat.filter { !$0.isEmpty }.count))
        case .countUnique: return .number(Double(Set(flat.filter { !$0.isEmpty }).count))
        case .countEmpty: return .number(Double(values.count - nonEmpty.count))
        case .countNotEmpty: return .number(Double(nonEmpty.count))
        case .percentEmpty: return pct(values.count - nonEmpty.count)
        case .percentNotEmpty: return pct(nonEmpty.count)
        case .sum: return .number(nums.reduce(0, +))
        case .average: return nums.isEmpty ? .empty : .number(nums.reduce(0, +) / Double(nums.count))
        case .median:
            let s = nums.sorted()
            guard !s.isEmpty else { return .empty }
            return .number(s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2)
        case .min: return nums.min().map(Value.number) ?? .empty
        case .max: return nums.max().map(Value.number) ?? .empty
        case .range: return nums.isEmpty ? .empty : .number(nums.max()! - nums.min()!)
        case .earliest: return dates.min().map { .date(DateValue(start: $0)) } ?? .empty
        case .latest: return dates.max().map { .date(DateValue(start: $0)) } ?? .empty
        case .dateRange:
            guard let a = dates.min(), let b = dates.max() else { return .empty }
            return .string(durationText(b.timeIntervalSince(a)))
        case .checked: return .number(Double(bools.filter { $0 }.count))
        case .unchecked: return .number(Double(bools.filter { !$0 }.count))
        case .percentChecked: return pct(bools.filter { $0 }.count)
        case .percentUnchecked: return pct(bools.filter { !$0 }.count)
        }
    }

    static func durationText(_ seconds: TimeInterval) -> String {
        let days = Int(seconds / 86_400)
        if days >= 365 { return "\(days / 365) year\(days / 365 == 1 ? "" : "s")" }
        if days >= 30 { return "\(days / 30) month\(days / 30 == 1 ? "" : "s")" }
        if days >= 7 { return "\(days / 7) week\(days / 7 == 1 ? "" : "s")" }
        return "\(days) day\(days == 1 ? "" : "s")"
    }

    /// Footer calculation for a column, formatted for display.
    public func calculation(_ fn: CalculationType, _ p: PropertySchema, rows: [Block], db: Database) -> String? {
        guard fn != .none else { return nil }
        let values = rows.map { value($0, p, db) }
        let v = Self.aggregate(values, fn, p)
        switch fn {
        case .percentEmpty, .percentNotEmpty, .percentChecked, .percentUnchecked:
            if case .number(let n) = v { return String(format: "%.0f%%", n * 100) }
        case .sum, .average, .median, .min, .max, .range:
            if case .number(let n) = v { return CellFormatter.number(n, p.numberFormat) }
        default: break
        }
        return CellFormatter.text(v, store: store)
    }

    // MARK: Run a view

    public func run(_ view: DatabaseView, search: String? = nil) -> QueryResult {
        guard let db = store.databases[view.databaseID] else { return QueryResult(rows: [], groups: nil) }
        var rows = store.rows(of: db.id).filter { $0.props.isTemplate != true }
        if let f = view.filter, !f.isEmpty { rows = rows.filter { matches($0, f, db) } }
        if let q = search?.trimmingCharacters(in: .whitespaces), !q.isEmpty { rows = rows.filter { matchesSearch($0, q, db) } }
        rows = sorted(rows, view.sorts ?? [], db)
        var groups: [RowGroup]? = nil
        if let g = view.groupBy, let p = db.property(g.propertyID) ?? (g.propertyID == db.titleProperty.id ? db.titleProperty : nil) {
            groups = group(rows, rule: g, p, db)
        } else if view.type == .board, let p = db.properties.first(where: { $0.type == .status || $0.type == .select }) {
            groups = group(rows, rule: GroupRule(propertyID: p.id), p, db)
        }
        return QueryResult(rows: rows, groups: groups)
    }

    func matchesSearch(_ row: Block, _ q: String, _ db: Database) -> Bool {
        if store.plainTextResolvingMentions(row.text).localizedCaseInsensitiveContains(q) { return true }
        for p in db.properties where p.type != .title {
            let v = value(row, p, db)
            if !v.isEmpty, CellFormatter.text(v, store: store).localizedCaseInsensitiveContains(q) { return true }
        }
        return false
    }

    // MARK: Filters

    public func matches(_ row: Block, _ g: FilterGroup, _ db: Database) -> Bool {
        if g.items.isEmpty { return true }
        let results = g.items.lazy.map { item -> Bool in
            switch item {
            case .condition(let c): return self.matches(row, c, db)
            case .group(let sub): return self.matches(row, sub, db)
            case .unknown: return true    // BSD-130: a filter kind from a newer version hides nothing
            }
        }
        switch g.combinator {
        case .and: return results.allSatisfy { $0 }
        case .or: return results.contains(true)
        case .unknown: return true        // BSD-130: unknown combinator hides nothing
        }
    }

    public func matches(_ row: Block, _ c: FilterCondition, _ db: Database) -> Bool {
        if c.op == .unknown { return true }   // BSD-107: operator from a newer version hides nothing
        guard let p = db.property(c.propertyID) ?? (c.propertyID == Database.titlePropertyID ? db.titleProperty : nil) else { return true }
        let v = value(row, p, db)
        switch c.op {
        case .isEmpty: return v.isEmpty
        case .isNotEmpty: return !v.isEmpty
        default: break
        }
        guard let fv = c.value else { return true } // incomplete filters don't hide anything
        switch p.type {
        case .select, .status:
            let id: String? = { if case .select(let x)? = row.values[p.id] { return x }; if case .status(let x)? = row.values[p.id] { return x }; return nil }()
            let wanted = optionIDs(fv, p)
            if wanted.isEmpty { return true }
            let hit = id.map(wanted.contains) ?? false
            switch c.op {
            case .equals, .contains: return hit
            case .notEquals, .notContains: return !hit
            default: return true
            }
        case .multiSelect, .person, .relation, .files, .createdBy, .lastEditedBy:
            let have: [String] = {
                switch row.values[p.id] {
                case .multiSelect(let ids)?: return ids
                case .person(let ids)?: return ids
                case .relation(let ids)?: return liveRelationTargets(ids)
                case .files(let f)?: return f.map(\.name)
                default:
                    if p.type == .createdBy { return row.createdBy.map { [$0] } ?? [] }
                    if p.type == .lastEditedBy { return row.updatedBy.map { [$0] } ?? [] }
                    return []
                }
            }()
            let wanted = p.type == .multiSelect ? optionIDs(fv, p) : rawStrings(fv)
            if wanted.isEmpty { return true }
            let hit = have.contains { wanted.contains($0) }
            switch c.op {
            case .contains, .equals: return hit
            case .notContains, .notEquals: return !hit
            default: return true
            }
        case .checkbox:
            let want: Bool = { if case .bool(let b) = fv { return b }; if case .text(let t) = fv { return t == "true" }; return true }()
            return c.op == .notEquals ? v.bool != want : v.bool == want
        default:
            return compare(v, c.op, fv)
        }
    }

    func optionIDs(_ fv: FilterValue, _ p: PropertySchema) -> Set<String> {
        switch fv {
        case .options(let ids): return Set(ids)
        case .text(let name): return Set([p.option(named: name)?.id ?? name])
        default: return []
        }
    }

    func rawStrings(_ fv: FilterValue) -> Set<String> {
        switch fv {
        case .options(let ids): return Set(ids)
        case .text(let t): return Set([t])
        default: return []
        }
    }

    func compare(_ v: Value, _ op: FilterOp, _ fv: FilterValue) -> Bool {
        switch v {
        case .date(let d):
            guard let (lo, hi) = dateBounds(fv) else { return true }
            let start = d.start
            let dayStart = Calendar.current.startOfDay(for: start)
            switch op {
            case .equals: return dayStart >= lo && dayStart < hi
            case .notEquals: return !(dayStart >= lo && dayStart < hi)
            case .before, .less: return dayStart < lo
            case .after, .greater: return dayStart >= hi
            case .onOrBefore, .lessOrEqual: return dayStart < hi
            case .onOrAfter, .greaterOrEqual: return dayStart >= lo
            case .within: return start >= lo && start < hi
            default: return true
            }
        case .empty:
            switch op {
            case .notEquals, .notContains: return true
            default: return false
            }
        case .number(let n):
            let target: Double? = { if case .number(let x) = fv { return x }; if case .text(let t) = fv { return Double(t) }; return nil }()
            guard let t = target else { return true }
            switch op {
            case .equals: return n == t
            case .notEquals: return n != t
            case .greater: return n > t
            case .less: return n < t
            case .greaterOrEqual: return n >= t
            case .lessOrEqual: return n <= t
            case .contains: return NumberFormatting.plain(n).contains(NumberFormatting.plain(t))
            default: return true
            }
        case .bool(let b):
            let want: Bool = { if case .bool(let x) = fv { return x }; if case .text(let t) = fv { return t == "true" }; return true }()
            return op == .notEquals ? b != want : b == want
        default:
            let s = CellFormatter.text(v, store: store).lowercased()
            let t: String = { if case .text(let x) = fv { return x.lowercased() }; if case .number(let n) = fv { return NumberFormatting.plain(n) }; return "" }()
            if t.isEmpty { return true }
            switch op {
            case .equals: return s == t
            case .notEquals: return s != t
            case .contains: return s.contains(t)
            case .notContains: return !s.contains(t)
            case .startsWith: return s.hasPrefix(t)
            case .endsWith: return s.hasSuffix(t)
            default: return true
            }
        }
    }

    /// Inclusive-exclusive bounds for a date filter value.
    func dateBounds(_ fv: FilterValue) -> (Date, Date)? {
        let cal = Calendar.current
        let today = cal.startOfDay(for: now)
        func day(_ offset: Int) -> Date { cal.date(byAdding: .day, value: offset, to: today)! }
        switch fv {
        case .date(let d):
            let s = cal.startOfDay(for: d)
            return (s, cal.date(byAdding: .day, value: 1, to: s)!)
        case .relative(let r):
            switch r {
            case .today: return (today, day(1))
            case .tomorrow: return (day(1), day(2))
            case .yesterday: return (day(-1), today)
            case .pastWeek: return (day(-7), day(1))
            case .nextWeek: return (today, day(8))
            case .pastMonth: return (cal.date(byAdding: .month, value: -1, to: today)!, day(1))
            case .nextMonth: return (today, cal.date(byAdding: .month, value: 1, to: day(1))!)
            case .pastYear: return (cal.date(byAdding: .year, value: -1, to: today)!, day(1))
            case .nextYear: return (today, cal.date(byAdding: .year, value: 1, to: day(1))!)
            case .unknown: return nil     // BSD-130: hides nothing
            }
        case .text(let t):
            guard let d = DateParsing.parse(t) else { return nil }
            let s = cal.startOfDay(for: d.start)
            return (s, cal.date(byAdding: .day, value: 1, to: s)!)
        default: return nil
        }
    }

    // MARK: Sorting

    public func sorted(_ rows: [Block], _ sorts: [SortRule], _ db: Database) -> [Block] {
        guard !sorts.isEmpty else { return rows }
        let props = sorts.compactMap { s -> (SortRule, PropertySchema)? in
            guard let p = db.property(s.propertyID) ?? (s.propertyID == Database.titlePropertyID ? db.titleProperty : nil) else { return nil }
            return (s, p)
        }
        let keyed = rows.enumerated().map { (i, r) in (i, r, props.map { sortKey(r, $0.1, db) }) }
        return keyed.sorted { a, b in
            for (k, (rule, _)) in props.enumerated() {
                let x = a.2[k], y = b.2[k]
                if x.isEmpty != y.isEmpty { return !x.isEmpty } // empties last
                if x.isEmpty { continue }
                let c = Value.compare(x, y)
                if c != .orderedSame { return rule.ascending ? c == .orderedAscending : c == .orderedDescending }
            }
            return a.0 < b.0
        }.map(\.1)
    }

    /// Selects sort by option order, like Notion.
    func sortKey(_ row: Block, _ p: PropertySchema, _ db: Database) -> Value {
        switch (p.type, row.values[p.id]) {
        case (.select, .select(let id)?), (.status, .status(let id)?):
            return (p.options?.firstIndex { $0.id == id }).map { .number(Double($0)) } ?? .empty
        case (.multiSelect, .multiSelect(let ids)?):
            return .list(ids.compactMap { id in p.options?.firstIndex { $0.id == id } }.sorted().map { .number(Double($0)) })
        case (.relation, .relation(let ids)?):
            return .list(ids.map { .string(store.title(of: $0)) })
        default:
            return value(row, p, db)
        }
    }

    // MARK: Grouping

    public func group(_ rows: [Block], rule: GroupRule, _ p: PropertySchema, _ db: Database) -> [RowGroup] {
        var buckets: [String: [Block]] = [:]
        var order: [(String, String, TColor?)] = []
        var seen = Set<String>()
        func add(_ key: String, _ row: Block) { buckets[key, default: []].append(row) }

        switch p.type {
        case .select, .status, .multiSelect:
            for o in p.options ?? [] { order.append((o.id, o.name, o.color)) }
            for r in rows {
                switch r.values[p.id] {
                case .select(let id)?, .status(let id)?: add(p.option(id) != nil ? id : "", r)
                case .multiSelect(let ids)?:
                    let valid = ids.filter { p.option($0) != nil }
                    if valid.isEmpty { add("", r) } else { valid.forEach { add($0, r) } }
                default: add("", r)
                }
            }
        case .checkbox:
            order = [("true", "Checked", nil), ("false", "Unchecked", nil)]
            for r in rows { add(value(r, p, db).bool ? "true" : "false", r) }
        case .person, .createdBy, .lastEditedBy:
            for r in rows {
                let people = value(r, p, db).list.compactMap { v -> String? in if case .person(let x) = v { return x }; return nil }
                if people.isEmpty { add("", r) }
                for x in people {
                    if seen.insert(x).inserted { order.append((x, x == "me" ? "Me" : x, nil)) }
                    add(x, r)
                }
            }
        case .date, .createdTime, .lastEditedTime:
            var keys: [(String, String, Date)] = []
            for r in rows {
                guard case .date(let d) = value(r, p, db) else { add("", r); continue }
                let (k, title, sortDate) = dateBucket(d.start, rule.dateGrouping ?? .relative)
                if seen.insert(k).inserted { keys.append((k, title, sortDate)) }
                add(k, r)
            }
            order = keys.sorted { $0.2 < $1.2 }.map { ($0.0, $0.1, nil) }
        default:
            for r in rows {
                let v = value(r, p, db)
                let text = CellFormatter.text(v, store: store)
                if v.isEmpty || text.isEmpty { add("", r); continue }
                if seen.insert(text).inserted { order.append((text, text, nil)) }
                add(text, r)
            }
            order.sort { $0.1.localizedStandardCompare($1.1) == .orderedAscending }
        }
        if p.type != .checkbox { order.insert(("", "No \(p.name)", nil), at: 0) }

        if let custom = rule.groupOrder, !custom.isEmpty {
            order.sort { a, b in
                let ia = custom.firstIndex(of: a.0) ?? Int.max, ib = custom.firstIndex(of: b.0) ?? Int.max
                return ia < ib
            }
        }
        let hidden = Set(rule.hiddenGroups ?? [])
        var out: [RowGroup] = []
        for (k, title, color) in order where !hidden.contains(k) {
            let rs = buckets[k] ?? []
            if rs.isEmpty, rule.hideEmptyGroups == true { continue }
            if rs.isEmpty, k.isEmpty, p.type != .select, p.type != .status, p.type != .multiSelect { continue }
            out.append(RowGroup(id: k, title: title, color: color, rows: rs))
        }
        return out
    }

    func dateBucket(_ d: Date, _ g: DateGrouping) -> (String, String, Date) {
        let cal = Calendar.current
        let day = cal.startOfDay(for: d)
        let today = cal.startOfDay(for: now)
        switch g {
        case .day:
            return (DateParsing.isoDay.string(from: day), DateDisplay.longDay.string(from: day), day)
        case .week:
            let start = cal.dateInterval(of: .weekOfYear, for: d)?.start ?? day
            return ("w" + DateParsing.isoDay.string(from: start), "Week of " + DateDisplay.longDay.string(from: start), start)
        case .month:
            let start = cal.dateInterval(of: .month, for: d)?.start ?? day
            return ("m" + DateParsing.isoDay.string(from: start), DateDisplay.formatter("MMMM yyyy").string(from: start), start)
        case .year:
            let y = cal.component(.year, from: d)
            return ("y\(y)", String(y), cal.date(from: DateComponents(year: y)) ?? day)
        case .relative:
            let diff = cal.dateComponents([.day], from: today, to: day).day ?? 0
            switch diff {
            case 0: return ("r0", "Today", today)
            case 1: return ("r1", "Tomorrow", day)
            case -1: return ("r-1", "Yesterday", day)
            case 2...7: return ("r7", "Next 7 days", cal.date(byAdding: .day, value: 2, to: today)!)
            case -7 ... -2: return ("r-7", "Last 7 days", cal.date(byAdding: .day, value: -7, to: today)!)
            case 8...30: return ("r30", "Next 30 days", cal.date(byAdding: .day, value: 8, to: today)!)
            case -30 ... -8: return ("r-30", "Last 30 days", cal.date(byAdding: .day, value: -30, to: today)!)
            default:
                let start = cal.dateInterval(of: .month, for: d)?.start ?? day
                return ("m" + DateParsing.isoDay.string(from: start), DateDisplay.formatter("MMMM yyyy").string(from: start), start)
            }
        }
    }

    /// Values to assign when a card is dropped into a group (board drag & drop).
    public func valueForGroup(_ groupID: String, _ p: PropertySchema, existing: PropertyValue?, from oldGroup: String?) -> PropertyValue? {
        switch p.type {
        case .select: return groupID.isEmpty ? nil : .select(groupID)
        case .status: return groupID.isEmpty ? nil : .status(groupID)
        case .multiSelect:
            var ids: [String] = { if case .multiSelect(let x)? = existing { return x }; return [] }()
            if let old = oldGroup { ids.removeAll { $0 == old } }
            if !groupID.isEmpty, !ids.contains(groupID) { ids.append(groupID) }
            return ids.isEmpty ? nil : .multiSelect(ids)
        case .checkbox: return .checkbox(groupID == "true")
        case .person: return groupID.isEmpty ? nil : .person([groupID])
        case .text: return groupID.isEmpty ? nil : .text(RichText(groupID))
        default: return existing
        }
    }
}

/// Display formatting for cells.
@MainActor
public enum CellFormatter {
    public static func text(_ v: Value, store: WorkspaceStore?) -> String {
        switch v {
        case .page(let id): return store?.title(of: id) ?? id
        case .person(let p): return p == "me" ? "Me" : p
        case .list(let l): return l.map { text($0, store: store) }.filter { !$0.isEmpty }.joined(separator: ", ")
        case .number(let n): return NumberFormatting.plain(n)
        default: return v.description
        }
    }

    nonisolated public static func number(_ n: Double, _ format: NumberFormat?) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = 2
        switch format ?? .number {
        case .number:
            return NumberFormatting.plain(n)
        case .numberWithCommas:
            f.numberStyle = .decimal
        case .percent:
            f.numberStyle = .percent
            f.maximumFractionDigits = 2
            return f.string(from: NSNumber(value: n / 100)) ?? "\(n)%"
        default:
            f.numberStyle = .currency
            f.currencySymbol = (format ?? .dollar).symbol
            if format == .yen || format == .won { f.maximumFractionDigits = 0 }
        }
        return f.string(from: NSNumber(value: n)) ?? NumberFormatting.plain(n)
    }
}

public extension NumberFormat {
    var symbol: String {
        switch self {
        case .dollar: return "$"
        case .euro: return "€"
        case .pound: return "£"
        case .yen: return "¥"
        case .franc: return "CHF "
        case .rupee: return "₹"
        case .won: return "₩"
        case .yuan: return "CN¥"
        case .real: return "R$"
        case .ruble: return "₽"
        case .lira: return "₺"
        default: return ""
        }
    }
}