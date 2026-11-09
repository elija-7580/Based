import Foundation
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension NSAttributedString.Key {
    static let basedMarks = NSAttributedString.Key("based.marks")
    static let basedMention = NSAttributedString.Key("based.mention")
    static let basedEquation = NSAttributedString.Key("based.equation")
}

struct TextStyle: Equatable {
    var type: BlockType
    var format: PageFormat?
    var color: TColor?
    var checked = false
    /// Code blocks: language for syntax highlighting.
    var language: String?
}

/// How a block's text view looks and behaves.
struct RichTextConfig: Equatable {
    var style: TextStyle
    var placeholder: String = ""
    /// Show the placeholder even when the view is not focused (headings, titles).
    var alwaysShowPlaceholder = false
    /// Plain text editing (code blocks).
    var plain = false
    var editable = true
}

/// RichText ⇄ NSAttributedString. The source of truth is stored in custom attributes;
/// fonts and colours are derived for display only.
@MainActor
enum AttributedBridge {
    static func font(_ base: PlatformFont, bold: Bool, italic: Bool) -> PlatformFont {
        guard bold || italic else { return base }
        #if os(macOS)
        var f = base
        if bold { f = NSFontManager.shared.convert(f, toHaveTrait: .boldFontMask) }
        if italic { f = NSFontManager.shared.convert(f, toHaveTrait: .italicFontMask) }
        return f
        #else
        var traits = base.fontDescriptor.symbolicTraits
        if bold { traits.insert(.traitBold) }
        if italic { traits.insert(.traitItalic) }
        guard let d = base.fontDescriptor.withSymbolicTraits(traits) else { return base }
        return UIFont(descriptor: d, size: base.pointSize)
        #endif
    }

    static func paragraphStyle(_ style: TextStyle) -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineHeightMultiple = style.type == .code ? 1.2 : (style.type.isHeading || style.type == .page ? 1.05 : 1.18)
        return p
    }

    static func attributes(_ marks: Marks, style: TextStyle) -> [NSAttributedString.Key: Any] {
        let base = Theme.baseFont(for: style.type, format: style.format)
        var a: [NSAttributedString.Key: Any] = [:]
        var font = font(base, bold: marks.bold, italic: marks.italic)
        var fg: PlatformColor = style.color.map { $0.isBackground ? Theme.textPrimary : Theme.platformColor($0) } ?? Theme.textPrimary
        if style.type == .page && style.color == nil { fg = Theme.textPrimary }
        if marks.code, style.type != .code {
            font = PlatformFont.monospacedSystemFont(ofSize: base.pointSize * 0.85, weight: marks.bold ? .bold : .regular)
            a[.backgroundColor] = Theme.codeBackground
            fg = Theme.inlineCode
        }
        if let c = marks.color {
            if c.isBackground { a[.backgroundColor] = Theme.platformColor(c) } else { fg = Theme.platformColor(c) }
        }
        if marks.underline || marks.link != nil { a[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if marks.link != nil {
            a[.underlineColor] = Theme.textSecondary
            #if os(macOS)
            if let link = marks.link, let url = URL(string: link) { a[.link] = url }
            #endif
        }
        if marks.strikethrough || style.checked { a[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if style.checked { fg = Theme.textSecondary }
        a[.font] = font
        a[.foregroundColor] = fg
        a[.paragraphStyle] = paragraphStyle(style)
        if !marks.isPlain { a[.basedMarks] = marks.key }
        return a
    }

    /// Colours code by `SyntaxHighlighter` tokens (foreground only — text and other attributes stay).
    static func highlight(_ s: NSMutableAttributedString, language: String?) {
        let all = NSRange(location: 0, length: s.length)
        guard all.length > 0, all.length < 200_000 else { return }
        s.beginEditing()
        s.addAttribute(.foregroundColor, value: Theme.textPrimary, range: all)
        for t in SyntaxHighlighter.tokens(s.string, language: language) {
            let r = NSRange(location: t.location, length: t.length)
            guard NSMaxRange(r) <= all.length else { continue }
            s.addAttribute(.foregroundColor, value: Theme.codeColor(t.kind), range: r)
        }
        s.endEditing()
    }

    static func attributed(_ rt: RichText, style: TextStyle, store: WorkspaceStore) -> NSAttributedString {
        let out = NSMutableAttributedString(string: "")
        if style.type == .code {
            let a = attributes(.plain, style: style)
            out.append(NSAttributedString(string: rt.plainText, attributes: a))
            highlight(out, language: style.language)
            return out
        }
        for run in rt.runs {
            var text = run.text
            var a = attributes(run.marks, style: style)
            if let m = run.mention {
                a[.basedMention] = m.key
                switch m {
                case .page(let id):
                    text = mentionText(m, run: run, store: store)
                    a[.underlineStyle] = NSUnderlineStyle.single.rawValue
                    a[.underlineColor] = Theme.divider
                    a[.font] = font(Theme.baseFont(for: style.type, format: style.format), bold: true, italic: run.marks.italic)
                    #if os(macOS)
                    a[.link] = URL(string: "based://page/" + id)
                    #endif
                case .date:
                    text = mentionText(m, run: run, store: store)
                    a[.foregroundColor] = Theme.textSecondary
                case .user:
                    text = mentionText(m, run: run, store: store)
                    a[.foregroundColor] = Theme.textSecondary
                case .link:
                    text = mentionText(m, run: run, store: store)
                    a[.underlineStyle] = NSUnderlineStyle.single.rawValue
                }
            }
            if let eq = run.equation {
                a[.basedEquation] = eq
                text = eq.isEmpty ? "ƒ" : eq
                a[.font] = PlatformFont.monospacedSystemFont(ofSize: Theme.baseFont(for: style.type, format: style.format).pointSize * 0.9, weight: .regular)
                a[.backgroundColor] = Theme.codeBackground
            }
            out.append(NSAttributedString(string: text, attributes: a))
        }
        return out
    }

    /// What a mention shows: the page's current title, a relative date („Today“), a person (BSD-40: also used to
    /// notice renames / a new day without comparing against the stored text).
    static func mentionText(_ m: Mention, run: TextRun, store: WorkspaceStore) -> String {
        switch m {
        case .page(let id): return store.title(of: id)
        case .date(let d): return "@" + (DateDisplay.relative(d.start) ?? DateDisplay.long(DateValue(start: d.start, includeTime: d.includeTime)))
        case .user(let u): return "@" + (u == "me" ? "Me" : u)
        case .link(let u): return run.text.isEmpty ? u : run.text
        }
    }

    /// The displayed text of every mention in `rt`, in order (empty without mentions).
    static func mentionSignature(_ rt: RichText, store: WorkspaceStore) -> [String] {
        guard rt.hasMentions else { return [] }
        return rt.runs.compactMap { r in r.mention.map { mentionText($0, run: r, store: store) } }
    }

    static func richText(_ s: NSAttributedString, plain: Bool = false) -> RichText {
        if plain { return RichText(s.string) }
        var runs: [TextRun] = []
        let ns = s.string as NSString
        s.enumerateAttributes(in: NSRange(location: 0, length: s.length)) { attrs, range, _ in
            let text = ns.substring(with: range)
            let marks = (attrs[.basedMarks] as? String).map { Marks(key: $0) } ?? .plain
            let mention = (attrs[.basedMention] as? String).flatMap { Mention(key: $0) }
            let eq = attrs[.basedEquation] as? String
            if let last = runs.last, last.mention == mention, last.equation == eq, mention != nil || eq != nil, last.marks == marks {
                runs[runs.count - 1].text += text
            } else {
                runs.append(TextRun(text, marks: marks, mention: mention, equation: eq))
            }
        }
        // Equations keep their expression as text
        for i in runs.indices where runs[i].equation != nil { runs[i].text = runs[i].equation ?? runs[i].text }
        return RichText(runs: runs)
    }

    /// Attributes for newly typed text: inherit marks but never mentions/equations.
    static func typingAttributes(_ marks: Marks, style: TextStyle) -> [NSAttributedString.Key: Any] {
        var m = marks
        m.link = nil
        return attributes(m, style: style)
    }
}