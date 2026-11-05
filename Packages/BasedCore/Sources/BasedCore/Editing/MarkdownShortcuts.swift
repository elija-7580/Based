import Foundation

/// Result of a typed block-level Markdown shortcut such as "# " or "[] ".
public struct BlockShortcut: Equatable, Sendable {
    public var type: BlockType
    /// UTF-16 length of the trigger to remove from the start of the block.
    public var consumed: Int
    public var toggleable: Bool? = nil
    public var checked: Bool? = nil
}

public enum MarkdownShortcuts {
    /// Space-terminated triggers at the start of a block.
    static let spaceTriggers: [(String, BlockType, Bool?)] = [
        ("*", .bulletedList, nil), ("-", .bulletedList, nil), ("+", .bulletedList, nil),
        ("[]", .todo, nil), ("[ ]", .todo, nil),
        ("1.", .numberedList, nil), ("a.", .numberedList, nil), ("i.", .numberedList, nil),
        ("#", .heading1, nil), ("##", .heading2, nil), ("###", .heading3, nil), ("####", .heading4, nil),
        (">", .toggle, nil), ("\"", .quote, nil), ("|", .quote, nil),
        (">#", .heading1, true), (">##", .heading2, true), (">###", .heading3, true),
    ]

    /// Called after the user typed a space. `before` is the block text up to (and including) that space.
    public static func blockShortcut(before: String, currentType: BlockType) -> BlockShortcut? {
        guard currentType == .text || currentType.isList || currentType.isHeading || currentType == .quote,
              before.hasSuffix(" ") else { return nil }
        let trigger = String(before.dropLast())
        if trigger == "[x]" || trigger == "[X]" {
            return BlockShortcut(type: .todo, consumed: before.utf16.count, checked: true)
        }
        // Numbered list also accepts any number ("3. ")
        if trigger.count >= 2, trigger.hasSuffix("."), Int(trigger.dropLast()) != nil {
            return BlockShortcut(type: .numberedList, consumed: before.utf16.count)
        }
        for (t, type, toggle) in spaceTriggers where t == trigger {
            if type == currentType && toggle == nil { return nil }
            return BlockShortcut(type: type, consumed: before.utf16.count, toggleable: toggle)
        }
        return nil
    }

    /// Triggers that fire without a trailing space ("---", "```").
    public static func immediateShortcut(text: String, currentType: BlockType) -> BlockShortcut? {
        guard currentType == .text else { return nil }
        if text == "---" || text == "***" || text == "___" { return BlockShortcut(type: .divider, consumed: text.utf16.count) }
        if text == "```" { return BlockShortcut(type: .code, consumed: 3) }
        if text == "$$" { return nil }
        return nil
    }
}

/// Inline Markdown: **bold**, *italic*, _italic_, `code`, ~strike~, ~~strike~~, $equation$.
public enum InlineMarkdown {
    public struct Result: Equatable, Sendable {
        public var text: RichText
        public var caret: Int
    }

    /// Check whether the character just typed at `caret` closes an inline Markdown span.
    public static func apply(_ text: RichText, caret: Int) -> Result? {
        let plain = Array(text.plainText.utf16)
        guard caret > 0, caret <= plain.count else { return nil }
        let star = UInt16(UInt8(ascii: "*")), under = UInt16(UInt8(ascii: "_"))
        let tick = UInt16(UInt8(ascii: "`")), tilde = UInt16(UInt8(ascii: "~")), dollar = UInt16(UInt8(ascii: "$"))
        let last = plain[caret - 1]
        let candidates: [(String, (inout Marks) -> Void)]
        switch last {
        case star: candidates = [("**", { $0.bold = true }), ("*", { $0.italic = true })]
        case under: candidates = [("__", { $0.bold = true }), ("_", { $0.italic = true })]
        case tick: candidates = [("`", { $0.code = true })]
        case tilde: candidates = [("~~", { $0.strikethrough = true }), ("~", { $0.strikethrough = true })]
        case dollar: return equation(text, plain, caret)
        default: return nil
        }
        for (delim, transform) in candidates {
            let d = Array(delim.utf16)
            let n = d.count
            guard caret >= 2 * n + 1, Array(plain[(caret - n)..<caret]) == d else { continue }
            // Closing delimiter must not be part of a longer run (e.g. "***").
            let closeStart = caret - n
            if closeStart > 0, plain[closeStart - 1] == d[0], n == 1, delim != "`" {
                // "**" typed: let the two-char candidate handle it
                continue
            }
            // Find the opening delimiter scanning backwards.
            var i = closeStart - n
            while i >= 0 {
                if Array(plain[i..<(i + n)]) == d {
                    let contentStart = i + n
                    let contentEnd = closeStart
                    guard contentEnd > contentStart else { break }
                    // Opening must be at the start or after whitespace/punctuation, content not padded.
                    let before: UInt16? = i > 0 ? plain[i - 1] : nil
                    if let b = before, b == d[0] { i -= 1; continue }
                    if delim != "`" {
                        if isSpace(plain[contentStart]) || isSpace(plain[contentEnd - 1]) { break }
                        if let b = before, !isSpace(b) && !isPunct(b) && (delim == "_" || delim == "__") { break }
                    }
                    var t = text.applying(contentStart, contentEnd, transform)
                    // remove closing then opening delimiter
                    t = t.replacing(closeStart, caret, with: RichText())
                    t = t.replacing(i, contentStart, with: RichText())
                    return Result(text: t, caret: caret - 2 * n)
                }
                if delim == "`" ? false : plain[i] == UInt16(UInt8(ascii: "\n")) { break }
                i -= 1
            }
        }
        return nil
    }

    static func equation(_ text: RichText, _ plain: [UInt16], _ caret: Int) -> Result? {
        let dollar = UInt16(UInt8(ascii: "$"))
        let close = caret - 1
        var i = close - 1
        while i >= 0 {
            if plain[i] == dollar {
                guard close - i > 1 else { return nil }
                let expr = String(utf16CodeUnits: Array(plain[(i + 1)..<close]), count: close - i - 1)
                let run = TextRun("⁣", equation: expr)
                let t = text.replacing(i, caret, with: RichText(runs: [run]))
                return Result(text: t, caret: i + run.length)
            }
            i -= 1
        }
        return nil
    }

    static func isSpace(_ c: UInt16) -> Bool { c == 32 || c == 9 || c == 10 || c == 0xA0 }
    static func isPunct(_ c: UInt16) -> Bool {
        guard c < 128 else { return false }
        return "([{<\"'.,;:!?-/".utf16.contains(c)
    }
}

/// Characters that open a popup menu while typing.
public enum InlineTrigger: Equatable, Sendable {
    case slash        // "/" → block menu
    case mention      // "@" → people, pages, dates
    case pageLink     // "[[" → link to page
    case emoji        // ":" + letters → emoji picker
    case newPage      // "+" → link to new/existing page

    /// Detects a trigger right after the user typed at `caret` in `text`.
    public static func detect(_ text: String, caret: Int) -> InlineTrigger? {
        let u = Array(text.utf16)
        guard caret > 0, caret <= u.count else { return nil }
        let c = u[caret - 1]
        let prev: UInt16? = caret >= 2 ? u[caret - 2] : nil
        let atWordStart = prev == nil || InlineMarkdown.isSpace(prev!) || InlineMarkdown.isPunct(prev!)
        switch c {
        case UInt16(UInt8(ascii: "/")): return atWordStart ? .slash : nil
        case UInt16(UInt8(ascii: "@")): return atWordStart ? .mention : nil
        case UInt16(UInt8(ascii: "[")): return prev == UInt16(UInt8(ascii: "[")) ? .pageLink : nil
        case UInt16(UInt8(ascii: "+")): return (prev == nil || InlineMarkdown.isSpace(prev!)) ? .newPage : nil
        case UInt16(UInt8(ascii: ":")): return atWordStart ? .emoji : nil
        default: return nil
        }
    }

    public var triggerLength: Int { self == .pageLink ? 2 : 1 }
}