import Foundation

/// A computed value: what formulas produce and what filters, sorts and groups compare.
public indirect enum Value: Hashable, Sendable, CustomStringConvertible {
    case empty
    case string(String)
    case number(Double)
    case bool(Bool)
    case date(DateValue)
    case list([Value])
    case page(RecordID)
    case person(String)

    public var isEmpty: Bool {
        switch self {
        case .empty: return true
        case .string(let s): return s.isEmpty
        case .list(let l): return l.isEmpty || l.allSatisfy(\.isEmpty)
        default: return false
        }
    }

    public var typeName: String {
        switch self {
        case .empty: return "empty"
        case .string: return "text"
        case .number: return "number"
        case .bool: return "boolean"
        case .date: return "date"
        case .list: return "list"
        case .page: return "page"
        case .person: return "person"
        }
    }

    public var number: Double? {
        switch self {
        case .number(let n): return n
        case .bool(let b): return b ? 1 : 0
        case .string(let s): return Double(s.trimmingCharacters(in: .whitespaces))
        case .date(let d): return d.start.timeIntervalSince1970 * 1000
        default: return nil
        }
    }

    public var bool: Bool {
        switch self {
        case .empty: return false
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return !s.isEmpty
        case .list(let l): return !l.isEmpty
        default: return true
        }
    }

    public var list: [Value] {
        switch self {
        case .list(let l): return l
        case .empty: return []
        default: return [self]
        }
    }

    /// Text form, as Notion's `format()` produces it.
    public var description: String {
        switch self {
        case .empty: return ""
        case .string(let s): return s
        case .number(let n): return NumberFormatting.plain(n)
        case .bool(let b): return b ? "true" : "false"
        case .date(let d): return DateDisplay.long(d)
        case .list(let l): return l.map(\.description).joined(separator: ", ")
        case .page(let id): return id
        case .person(let p): return p
        }
    }

    /// Ordering used by sorts and comparisons. Mixed kinds order by kind.
    public static func compare(_ a: Value, _ b: Value) -> ComparisonResult {
        switch (a, b) {
        case (.number(let x), .number(let y)): return x < y ? .orderedAscending : (x > y ? .orderedDescending : .orderedSame)
        case (.bool(let x), .bool(let y)): return x == y ? .orderedSame : (!x ? .orderedAscending : .orderedDescending)
        case (.date(let x), .date(let y)): return x.start < y.start ? .orderedAscending : (x.start > y.start ? .orderedDescending : .orderedSame)
        case (.list(let x), .list(let y)):
            for (p, q) in zip(x, y) { let c = compare(p, q); if c != .orderedSame { return c } }
            return x.count == y.count ? .orderedSame : (x.count < y.count ? .orderedAscending : .orderedDescending)
        default:
            return a.description.localizedStandardCompare(b.description)
        }
    }
}

public enum DateDisplay {
    static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = format
        return f
    }
    static let longDay = formatter("MMMM d, yyyy")
    static let longTime = formatter("MMMM d, yyyy h:mm a")
    static let time = formatter("h:mm a")

    /// Notion's default "Full date" display: "May 4, 2025 3:15 PM".
    public static func long(_ d: DateValue) -> String {
        var s = (d.includeTime ? longTime : longDay).string(from: d.start)
        if let e = d.end {
            let sameDay = Calendar.current.isDate(d.start, inSameDayAs: e)
            s += " → " + (d.includeTime && sameDay ? time : (d.includeTime ? longTime : longDay)).string(from: e)
        }
        return s
    }

    /// Relative label used by date mentions ("Today", "Tomorrow", "Yesterday").
    public static func relative(_ date: Date, now: Date = Date()) -> String? {
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return "Today" }
        if let t = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(date, inSameDayAs: t) { return "Tomorrow" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) { return "Yesterday" }
        return nil
    }

    /// Converts a Notion/moment-style format ("MMMM D, YYYY h:mm A") to a DateFormatter pattern.
    public static func pattern(fromMoment fmt: String) -> String {
        var out = ""
        var i = fmt.startIndex
        let tokens: [(String, String)] = [
            ("YYYY", "yyyy"), ("YY", "yy"), ("MMMM", "MMMM"), ("MMM", "MMM"), ("MM", "MM"), ("M", "M"),
            ("Do", "d"), ("DD", "dd"), ("D", "d"), ("dddd", "EEEE"), ("ddd", "EEE"), ("dd", "EEEEEE"), ("d", "e"),
            ("HH", "HH"), ("H", "H"), ("hh", "hh"), ("h", "h"), ("mm", "mm"), ("m", "m"), ("ss", "ss"), ("s", "s"),
            ("A", "a"), ("a", "a"), ("ww", "ww"), ("w", "w"), ("WW", "ww"), ("W", "w"), ("Q", "Q"), ("ZZ", "xx"), ("Z", "xxx"),
        ]
        while i < fmt.endIndex {
            if fmt[i] == "[" , let close = fmt[i...].firstIndex(of: "]") {
                let lit = fmt[fmt.index(after: i)..<close]
                out += "'" + lit.replacingOccurrences(of: "'", with: "''") + "'"
                i = fmt.index(after: close)
                continue
            }
            var matched = false
            for (t, r) in tokens where fmt[i...].hasPrefix(t) {
                out += r
                i = fmt.index(i, offsetBy: t.count)
                matched = true
                break
            }
            if !matched {
                let c = fmt[i]
                if c.isLetter { out += "'\(c)'" } else if c == "'" { out += "''" } else { out.append(c) }
                i = fmt.index(after: i)
            }
        }
        return out
    }

    public static func format(_ date: Date, moment: String) -> String {
        var s = formatter(pattern(fromMoment: moment)).string(from: date)
        if moment.contains("Do") {
            // ordinal suffix for "Do"
            let day = Calendar.current.component(.day, from: date)
            let suffix: String
            switch day % 100 {
            case 11, 12, 13: suffix = "th"
            default: suffix = [1: "st", 2: "nd", 3: "rd"][day % 10] ?? "th"
            }
            if let r = s.range(of: String(day)) { s.replaceSubrange(r, with: "\(day)\(suffix)") }
        }
        return s
    }
}