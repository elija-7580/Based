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

    public func now() -> Stamp {
        lock.lock(); defer { lock.unlock() }
        let wall = Int64(Date().timeIntervalSince1970 * 1000)
        if wall > last.millis {
            last = Stamp(millis: wall, counter: 0, node: node)
        } else {
            last = Stamp(millis: last.millis, counter: last.counter &+ 1, node: node)
        }
        return last
    }

    /// Advance past a stamp seen from another device.
    public func observe(_ remote: Stamp) {
        lock.lock(); defer { lock.unlock() }
        if remote.millis > last.millis || (remote.millis == last.millis && remote.counter > last.counter) {
            last = Stamp(millis: remote.millis, counter: remote.counter, node: node)
        }
    }
}

/// Fractional index keys: strings that sort lexicographically and always
/// allow a new key between any two keys. Base-62 digits, no trailing "0".
public enum FractionalIndex {
    static let digits: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    static let lookup: [Character: Int] = {
        var d: [Character: Int] = [:]
        for (i, c) in digits.enumerated() { d[c] = i }
        return d
    }()

    /// A key strictly between `a` and `b` (nil = unbounded).
    public static func between(_ a: String?, _ b: String?) -> String {
        var lo = a ?? ""
        var hi = b
        if let h = hi, !lo.isEmpty, h <= lo { hi = nil } // repair invalid order
        if lo.hasSuffix("0") { lo = String(lo.reversed().drop(while: { $0 == "0" }).reversed()) }
        return midpoint(Array(lo), hi.map { Array($0) })
    }

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

    /// `count` evenly spaced keys between `a` and `b`.
    public static func keys(count: Int, between a: String? = nil, _ b: String? = nil) -> [String] {
        guard count > 0 else { return [] }
        if a == nil && b == nil {
            var width = 1
            var capacity = digits.count
            while capacity < count + 1 { width += 1; capacity *= digits.count }
            var result: [String] = []
            result.reserveCapacity(count)
            for i in 1...count {
                var value = Int((Double(i) * Double(capacity) / Double(count + 1)).rounded(.down))
                var chars = [Character](repeating: "0", count: width)
                for pos in stride(from: width - 1, through: 0, by: -1) {
                    chars[pos] = digits[value % digits.count]
                    value /= digits.count
                }
                while chars.last == "0" { chars.removeLast() }
                result.append(String(chars))
            }
            return result
        }
        var result: [String] = []
        var lo = a
        for _ in 0..<count {
            let k = between(lo, b)
            result.append(k)
            lo = k
        }
        return result
    }
}
