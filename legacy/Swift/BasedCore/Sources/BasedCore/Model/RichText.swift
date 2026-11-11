import Foundation

/// The ten-colour palette, as text colours and background colours.
public enum TColor: OpenRawEnum, Sendable {
    case `default`, gray, brown, orange, yellow, green, blue, purple, pink, red
    case grayBackground, brownBackground, orangeBackground, yellowBackground, greenBackground
    case blueBackground, purpleBackground, pinkBackground, redBackground
    /// BSD-130: a colour from a newer Based; drawn like `.default`, written back unchanged.
    case unknown(String)

    public static var allCases: [TColor] { textColors + backgroundColors }

    public var rawValue: String {
        switch self {
        case .default: return "default"
        case .gray: return "gray"
        case .brown: return "brown"
        case .orange: return "orange"
        case .yellow: return "yellow"
        case .green: return "green"
        case .blue: return "blue"
        case .purple: return "purple"
        case .pink: return "pink"
        case .red: return "red"
        case .grayBackground: return "grayBackground"
        case .brownBackground: return "brownBackground"
        case .orangeBackground: return "orangeBackground"
        case .yellowBackground: return "yellowBackground"
        case .greenBackground: return "greenBackground"
        case .blueBackground: return "blueBackground"
        case .purpleBackground: return "purpleBackground"
        case .pinkBackground: return "pinkBackground"
        case .redBackground: return "redBackground"
        case .unknown(let raw): return raw
        }
    }

    public var isBackground: Bool {
        if case .unknown = self { return false }
        return rawValue.hasSuffix("Background")
    }

    /// The hue without the background variant.
    public var hue: TColor {
        guard isBackground else { return self }
        return TColor(rawValue: String(rawValue.dropLast("Background".count))) ?? .default
    }

    public var background: TColor {
        if isBackground || self == .default { return self }
        return TColor(rawValue: rawValue + "Background") ?? self
    }

    public var displayName: String {
        if case .unknown = self { return "Unknown colour (newer version)" }
        let h = hue == .default ? "Default" : hue.rawValue.capitalized
        return isBackground ? "\(h) background" : h
    }

    public static let textColors: [TColor] = [.default, .gray, .brown, .orange, .yellow, .green, .blue, .purple, .pink, .red]
    public static let backgroundColors: [TColor] = [.grayBackground, .brownBackground, .orangeBackground, .yellowBackground,
                                                    .greenBackground, .blueBackground, .purpleBackground, .pinkBackground, .redBackground]
}

/// Inline formatting of a text run.
public struct Marks: Hashable, Sendable, Codable {
    public var bold = false
    public var italic = false
    public var underline = false
    public var strikethrough = false
    public var code = false
    public var color: TColor? = nil
    public var link: String? = nil

    public init(bold: Bool = false, italic: Bool = false, underline: Bool = false, strikethrough: Bool = false,
                code: Bool = false, color: TColor? = nil, link: String? = nil) {
        self.bold = bold; self.italic = italic; self.underline = underline
        self.strikethrough = strikethrough; self.code = code; self.color = color; self.link = link
    }

    public static let plain = Marks()
    public var isPlain: Bool { self == .plain }

    enum CodingKeys: String, CodingKey { case b, i, u, s, c, color, link }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bold = try c.decodeIfPresent(Bool.self, forKey: .b) ?? false
        italic = try c.decodeIfPresent(Bool.self, forKey: .i) ?? false
        underline = try c.decodeIfPresent(Bool.self, forKey: .u) ?? false
        strikethrough = try c.decodeIfPresent(Bool.self, forKey: .s) ?? false
        code = try c.decodeIfPresent(Bool.self, forKey: .c) ?? false
        color = try c.decodeIfPresent(TColor.self, forKey: .color)
        link = try c.decodeIfPresent(String.self, forKey: .link)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if bold { try c.encode(true, forKey: .b) }
        if italic { try c.encode(true, forKey: .i) }
        if underline { try c.encode(true, forKey: .u) }
        if strikethrough { try c.encode(true, forKey: .s) }
        if code { try c.encode(true, forKey: .c) }
        try c.encodeIfPresent(color, forKey: .color)
        try c.encodeIfPresent(link, forKey: .link)
    }

    /// Canonical compact string, used as an attributed-string attribute value.
    public var key: String {
        var parts: [String] = []
        if bold { parts.append("b") }
        if italic { parts.append("i") }
        if underline { parts.append("u") }
        if strikethrough { parts.append("s") }
        if code { parts.append("c") }
        if let color { parts.append("k=" + color.rawValue) }
        if let link { parts.append("l=" + link) }
        return parts.joined(separator: "\u{1F}")
    }

    public init(key: String) {
        self.init()
        for part in key.split(separator: "\u{1F}", omittingEmptySubsequences: true) {
            switch part {
            case "b": bold = true
            case "i": italic = true
            case "u": underline = true
            case "s": strikethrough = true
            case "c": code = true
            default:
                if part.hasPrefix("k=") { color = TColor(rawValue: String(part.dropFirst(2))) }
                else if part.hasPrefix("l=") { link = String(part.dropFirst(2)) }
            }
        }
    }
}

public enum MarkKind: String, CaseIterable, Sendable {
    case bold, italic, underline, strikethrough, code

    public func get(_ m: Marks) -> Bool {
        switch self {
        case .bold: return m.bold
        case .italic: return m.italic
        case .underline: return m.underline
        case .strikethrough: return m.strikethrough
        case .code: return m.code
        }
    }

    public func set(_ m: inout Marks, _ v: Bool) {
        switch self {
        case .bold: m.bold = v
        case .italic: m.italic = v
        case .underline: m.underline = v
        case .strikethrough: m.strikethrough = v
        case .code: m.code = v
        }
    }
}

/// A date, optional end, optional time.
public struct DateValue: Codable, Hashable, Sendable {
    public var start: Date
    public var end: Date?
    public var includeTime: Bool
    public var remind: Bool?

    public init(start: Date, end: Date? = nil, includeTime: Bool = false, remind: Bool? = nil) {
        self.start = start; self.end = end; self.includeTime = includeTime; self.remind = remind
    }
}

/// An inline reference inside rich text.
public enum Mention: Codable, Hashable, Sendable {
    case page(RecordID)
    case date(DateValue)
    case user(String)
    case link(String)

    public var key: String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    public init?(key: String) {
        guard let v = try? JSONDecoder().decode(Mention.self, from: Data(key.utf8)) else { return nil }
        self = v
    }
}

/// A run of text sharing the same formatting.
public struct TextRun: Codable, Hashable, Sendable {
    public var text: String
    public var marks: Marks
    public var mention: Mention?
    public var equation: String?

    public init(_ text: String, marks: Marks = .plain, mention: Mention? = nil, equation: String? = nil) {
        self.text = text; self.marks = marks; self.mention = mention; self.equation = equation
    }

    enum CodingKeys: String, CodingKey { case t, m, mention, eq }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .t) ?? ""
        marks = try c.decodeIfPresent(Marks.self, forKey: .m) ?? .plain
        mention = try c.decodeIfPresent(Mention.self, forKey: .mention)
        equation = try c.decodeIfPresent(String.self, forKey: .eq)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .t)
        if !marks.isPlain { try c.encode(marks, forKey: .m) }
        try c.encodeIfPresent(mention, forKey: .mention)
        try c.encodeIfPresent(equation, forKey: .eq)
    }

    /// Atomic runs (mentions, equations) are never merged with neighbours.
    public var isAtomic: Bool { mention != nil || equation != nil }
    public var length: Int { text.utf16.count }
}

extension String {
    /// Substring by UTF-16 offsets (the unit used by text views).
    public func utf16Slice(_ from: Int, _ to: Int) -> String {
        let u = utf16
        let lo = max(0, min(from, u.count)), hi = max(lo, min(to, u.count))
        let a = String.Index(utf16Offset: lo, in: self)
        let b = String.Index(utf16Offset: hi, in: self)
        return String(self[a..<b])
    }
}

/// Formatted text: an ordered list of runs. Offsets are UTF-16 based.
public struct RichText: Codable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public var runs: [TextRun]

    public init(runs: [TextRun] = []) {
        self.runs = runs
        normalize()
    }

    public init(_ plain: String, marks: Marks = .plain) {
        self.runs = plain.isEmpty ? [] : [TextRun(plain, marks: marks)]
    }

    public init(stringLiteral value: String) { self.init(value) }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self.init(s) }
        else { self.init(runs: try c.decode([TextRun].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if runs.isEmpty { try c.encode("") }
        else if runs.count == 1, runs[0].marks.isPlain, !runs[0].isAtomic { try c.encode(runs[0].text) }
        else { try c.encode(runs) }
    }

    public var plainText: String { runs.map(\.text).joined() }
    /// Whether any run is a page/date/user/link mention.
    public var hasMentions: Bool { runs.contains { $0.mention != nil } }

    /// BSD-40: the text with every page mention showing `title(id)` instead of the title stored when the mention
    /// was typed (nil keeps the stored text). The stored text may be stale after a rename; search and anything
    /// shown to people should use this.
    public func resolvingMentions(_ title: (RecordID) -> String?) -> RichText {
        guard hasMentions else { return self }
        var out = self
        for i in out.runs.indices {
            if case .page(let id)? = out.runs[i].mention, let t = title(id) { out.runs[i].text = t }
        }
        return out
    }
    public var description: String { plainText }
    public var length: Int { runs.reduce(0) { $0 + $1.length } }
    public var isEmpty: Bool { length == 0 }

    /// Merge adjacent runs with equal formatting and drop empty runs.
    public mutating func normalize() {
        var out: [TextRun] = []
        for run in runs where !run.text.isEmpty {
            if let last = out.last, !last.isAtomic, !run.isAtomic, last.marks == run.marks {
                out[out.count - 1].text += run.text
            } else {
                out.append(run)
            }
        }
        runs = out
    }

    public func slice(_ from: Int, _ to: Int) -> RichText {
        var out: [TextRun] = []
        var pos = 0
        for run in runs {
            let len = run.length
            let lo = max(from, pos), hi = min(to, pos + len)
            if lo < hi {
                if run.isAtomic {
                    out.append(run)
                } else {
                    var r = run
                    r.text = run.text.utf16Slice(lo - pos, hi - pos)
                    out.append(r)
                }
            }
            pos += len
        }
        return RichText(runs: out)
    }

    public func split(at offset: Int) -> (RichText, RichText) {
        (slice(0, offset), slice(offset, length))
    }

    public static func + (a: RichText, b: RichText) -> RichText { RichText(runs: a.runs + b.runs) }

    public mutating func append(_ other: RichText) { self = self + other }

    public func replacing(_ from: Int, _ to: Int, with other: RichText) -> RichText {
        slice(0, from) + other + slice(to, length)
    }

    /// Marks in effect at an offset (taken from the run before the caret).
    public func marks(at offset: Int) -> Marks {
        var pos = 0
        var last = Marks.plain
        for run in runs {
            if offset > pos && offset <= pos + run.length { return run.isAtomic ? .plain : run.marks }
            pos += run.length
            last = run.marks
        }
        return offset == 0 ? (runs.first?.marks ?? .plain) : last
    }

    /// Apply a transformation to the marks of every run in a range.
    public func applying(_ from: Int, _ to: Int, _ transform: (inout Marks) -> Void) -> RichText {
        guard from < to else { return self }
        let middle = slice(from, to)
        var changed = middle.runs
        for i in changed.indices { transform(&changed[i].marks) }
        return slice(0, from) + RichText(runs: changed) + slice(to, length)
    }

    /// True when every character in the range satisfies the predicate.
    public func all(_ from: Int, _ to: Int, _ predicate: (Marks) -> Bool) -> Bool {
        let middle = slice(from, to)
        return !middle.runs.isEmpty && middle.runs.allSatisfy { predicate($0.marks) }
    }

    /// Toggle a mark: if the whole range has it, remove it; otherwise add it.
    public func toggling(_ mark: MarkKind, _ from: Int, _ to: Int) -> RichText {
        let on = !all(from, to) { mark.get($0) }
        return applying(from, to) { mark.set(&$0, on) }
    }

    public func settingColor(_ color: TColor?, _ from: Int, _ to: Int) -> RichText {
        applying(from, to) { $0.color = (color == .default ? nil : color) }
    }

    public func settingLink(_ link: String?, _ from: Int, _ to: Int) -> RichText {
        applying(from, to) { $0.link = (link?.isEmpty ?? true) ? nil : link }
    }

    /// Page IDs referenced by mentions.
    public var mentionedPages: [RecordID] {
        runs.compactMap { if case .page(let id)? = $0.mention { return id } else { return nil } }
    }
}
