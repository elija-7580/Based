import Foundation

/// Stable identifier of any record (lowercase UUID string).
public typealias RecordID = String

public enum RecordIDs {
    public static func make() -> RecordID { UUID().uuidString.lowercased() }
}

/// The record tables of a workspace.
public enum RecordKind: String, Codable, Sendable, CaseIterable {
    case block, database, view, workspace
}

/// Uniquely addresses a record across tables. String form: `kind:id`.
public struct RecordKey: Hashable, Codable, Sendable, CustomStringConvertible, Comparable {
    public var kind: RecordKind
    public var id: RecordID

    public init(_ kind: RecordKind, _ id: RecordID) {
        self.kind = kind
        self.id = id
    }

    public init?(string: String) {
        guard let colon = string.firstIndex(of: ":"),
              let kind = RecordKind(rawValue: String(string[..<colon])) else { return nil }
        self.kind = kind
        self.id = String(string[string.index(after: colon)...])
    }

    public var description: String { "\(kind.rawValue):\(id)" }

    public static func < (a: RecordKey, b: RecordKey) -> Bool { a.description < b.description }
}

/// Hybrid logical clock stamp: wall time, logical counter, node id.
/// Total order used for last-writer-wins merges.
public struct Stamp: Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
    public var millis: Int64
    public var counter: UInt32
    public var node: String

    public init(millis: Int64, counter: UInt32, node: String) {
        self.millis = millis
        self.counter = counter
        self.node = node
    }

    public static let zero = Stamp(millis: 0, counter: 0, node: "")

    public static func < (a: Stamp, b: Stamp) -> Bool {
        if a.millis != b.millis { return a.millis < b.millis }
        if a.counter != b.counter { return a.counter < b.counter }
        return a.node < b.node
    }

    /// Sortable string form, e.g. `0001730000000000-000003-node`.
    public var description: String {
        let m = String(millis)
        let c = String(counter)
        return String(repeating: "0", count: max(0, 16 - m.count)) + m + "-"
            + String(repeating: "0", count: max(0, 6 - c.count)) + c + "-" + node
    }

    public init?(string: String) {
        let parts = string.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let m = Int64(parts[0]), let c = UInt32(parts[1]) else { return nil }
        self.init(millis: m, counter: c, node: String(parts[2]))
    }
}

/// Generates monotonically increasing stamps for one device.
public final class StampClock: @unchecked Sendable {
    public let node: String
    private var last: Stamp
    private let lock = NSLock()

    public init(node: String, last: Stamp = .zero) {
        self.node = node
        self.last = last
    }

    public var current: Stamp {
        lock.lock(); defer { lock.unlock() }
        return last
    }

    /// BSD-72: stamps further than this ahead of the local wall clock are not adopted by `observe` (a device
    /// with a wrong clock would otherwise freeze every other device's time base at its future time).
    public static let maxDrift: Int64 = 3_600_000
    /// Wall clock in ms (test hook).
    public var wallClock: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    public func now() -> Stamp {
        lock.lock(); defer { lock.unlock() }
        let wall = wallClock()
        if wall > last.millis {
            last = Stamp(millis: wall, counter: 0, node: node)
        } else if last.counter == .max {
            // BSD-72: the counter would wrap to 0 and go backwards; move to the next millisecond instead.
            last = Stamp(millis: last.millis + 1, counter: 0, node: node)
        } else {
            last = Stamp(millis: last.millis, counter: last.counter + 1, node: node)
        }
        return last
    }

    /// Advance past a stamp seen from another device. A stamp more than `maxDrift` ahead of this device's
    /// clock is still applied by the store, but the clock doesn't jump to it (BSD-72); it returns false then.
    @discardableResult
    public func observe(_ remote: Stamp) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if remote.millis > wallClock() + Self.maxDrift { return false }
        if remote.millis > last.millis || (remote.millis == last.millis && remote.counter > last.counter) {
            last = Stamp(millis: remote.millis, counter: remote.counter, node: node)
        }
        return true
    }
}

/// Fractional index keys: strings that sort lexicographically and always allow a new key between any two keys.
///
/// Format (compatible with the widely used "fractional-indexing" scheme): an *integer part* whose first
/// character encodes its length (`a`…`z` → 2…27 digits, `A`…`Z` → 27…2 digits for the negative range)
/// followed by an optional *fractional part* in base‑62 with no trailing `0`. Appending at the end of a
/// list increments the integer part, so keys stay short (≈4 characters for 100k rows) instead of growing
/// with every insert. Older keys produced by a pure midpoint scheme are still accepted through a fallback.
public enum FractionalIndex {
    static let digits: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    static let lookup: [Character: Int] = {
        var d: [Character: Int] = [:]
        for (i, c) in digits.enumerated() { d[c] = i }
        return d
    }()
    static let smallestInteger = "A" + String(repeating: "0", count: 26)
    public static let first = "a0"

    // MARK: Integer part

    static func integerLength(_ head: Character) -> Int? {
        guard let v = head.asciiValue else { return nil }
        if v >= 97 && v <= 122 { return Int(v - 97) + 2 }        // a…z
        if v >= 65 && v <= 90 { return Int(90 - v) + 2 }         // A…Z
        return nil
    }

    static func integerPart(_ key: String) -> Substring? {
        guard let h = key.first, let len = integerLength(h), len <= key.count else { return nil }
        return key.prefix(len)
    }

    /// True when `key` follows the length‑prefixed format.
    public static func isValid(_ key: String) -> Bool {
        guard let int = integerPart(key) else { return false }
        let frac = key.dropFirst(int.count)
        if frac.last == "0" { return false }
        return key.dropFirst().allSatisfy { lookup[$0] != nil }
    }

    static func increment(_ x: Substring) -> String? {
        var chars = Array(x)
        let head = chars.removeFirst()
        var i = chars.count - 1
        while i >= 0 {
            let d = (lookup[chars[i]] ?? 0) + 1
            if d == digits.count { chars[i] = "0"; i -= 1 } else { chars[i] = digits[d]; return String(head) + String(chars) }
        }
        if head == "Z" { return "a0" }
        if head == "z" { return nil }
        let h = Character(UnicodeScalar(head.asciiValue! + 1))
        if h > "a" { chars.append("0") } else { chars.removeLast() }
        return String(h) + String(chars)
    }

    static func decrement(_ x: Substring) -> String? {
        var chars = Array(x)
        let head = chars.removeFirst()
        var i = chars.count - 1
        while i >= 0 {
            let d = (lookup[chars[i]] ?? 0) - 1
            if d < 0 { chars[i] = digits[digits.count - 1]; i -= 1 } else { chars[i] = digits[d]; return String(head) + String(chars) }
        }
        if head == "a" { return "Z" + String(digits[digits.count - 1]) }
        if head == "A" { return nil }
        let h = Character(UnicodeScalar(head.asciiValue! - 1))
        if h < "Z" { chars.append(digits[digits.count - 1]) } else { chars.removeLast() }
        return String(h) + String(chars)
    }

    // MARK: Public API

    /// A key strictly between `a` and `b` (nil = unbounded).
    public static func between(_ a: String?, _ b: String?) -> String {
        if let a, let b, a >= b { return legacyBetween(a, nil) }          // repair invalid order
        if let a, !isValid(a) { return legacyBetween(a, b) }
        if let b, !isValid(b) { return legacyBetween(a, b) }
        guard let a else {
            guard let b else { return first }
            let ib = integerPart(b)!
            let fb = b.dropFirst(ib.count)
            if ib == smallestInteger { return String(ib) + midpoint([], Array(fb)) }
            if !fb.isEmpty { return String(ib) }
            return decrement(ib) ?? legacyBetween(nil, b)
        }
        let ia = integerPart(a)!
        let fa = a.dropFirst(ia.count)
        guard let b else {
            return increment(ia) ?? String(ia) + midpoint(Array(fa), nil)
        }
        let ib = integerPart(b)!
        let fb = b.dropFirst(ib.count)
        if ia == ib { return String(ia) + midpoint(Array(fa), Array(fb)) }
        if let i = increment(ia), i < b { return i }
        return String(ia) + midpoint(Array(fa), nil)
    }

    /// `count` evenly spaced keys between `a` and `b`.
    public static func keys(count: Int, between a: String? = nil, _ b: String? = nil) -> [String] {
        guard count > 0 else { return [] }
        if count == 1 { return [between(a, b)] }
        if b == nil {
            var c = between(a, nil); var out = [c]
            for _ in 1..<count { c = between(c, nil); out.append(c) }
            return out
        }
        if a == nil {
            var c = between(nil, b); var out = [c]
            for _ in 1..<count { c = between(nil, c); out.append(c) }
            return out.reversed()
        }
        let mid = count / 2
        let c = between(a, b)
        return keys(count: mid, between: a, c) + [c] + keys(count: count - mid - 1, between: c, b)
    }

    // MARK: Fractional midpoint (shared with the legacy scheme)

    private static func midpoint(_ a: [Character], _ b: [Character]?) -> String {
        if let b {
            var n = 0
            while n < b.count && (n < a.count ? a[n] : "0") == b[n] { n += 1 }
            if n > 0 {
                let rest = midpoint(n < a.count ? Array(a[n...]) : [], Array(b[n...]))
                return String(b[0..<n]) + rest
            }
        }
        let digitA = a.isEmpty ? 0 : (lookup[a[0]] ?? 0)
        let digitB = b.map { $0.isEmpty ? digits.count : (lookup[$0[0]] ?? digits.count) } ?? digits.count
        if digitB - digitA > 1 {
            let mid = Int((Double(digitA + digitB) * 0.5).rounded())
            return String(digits[mid])
        }
        if let b, b.count > 1 { return String(b[0]) }
        return String(digits[digitA]) + midpoint(a.isEmpty ? [] : Array(a.dropFirst()), nil)
    }

    /// Pure midpoint keys (pre‑format data). Still correct, just grows with repeated appends.
    static func legacyBetween(_ a: String?, _ b: String?) -> String {
        var lo = a ?? ""
        var hi = b
        if let h = hi, !lo.isEmpty, h <= lo { hi = nil }
        if lo.hasSuffix("0") { lo = String(lo.reversed().drop(while: { $0 == "0" }).reversed()) }
        return midpoint(Array(lo), hi.map { Array($0) })
    }
}
