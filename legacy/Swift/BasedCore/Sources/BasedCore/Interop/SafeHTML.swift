import Foundation

/// BSD-35: rules for content that ends up in HTML (export, published pages, web client).
public enum SafeURL {
    /// Schemes a link may use. Everything else (`javascript:`, `vbscript:`, `data:` …) becomes `#`.
    public static let linkSchemes: Set<String> = ["http", "https", "mailto", "based"]

    /// The scheme of `s` (lower-cased), or nil for a relative reference (`page.html`, `#id`, `/p/x`, `assets/a.png`).
    /// Like browsers, ASCII control characters and whitespace inside the scheme are ignored (`java\tscript:`).
    public static func scheme(of s: String) -> String? {
        var scheme = ""
        for u in s.unicodeScalars {
            if u.value <= 0x20 || u.value == 0x7F { continue }
            if u == ":" { return scheme.isEmpty ? nil : scheme.lowercased() }
            if u == "/" || u == "?" || u == "#" { return nil }
            guard u.isASCII, CharacterSet.alphanumerics.contains(u) || u == "+" || u == "-" || u == "." else { return nil }
            scheme.unicodeScalars.append(u)
        }
        return nil
    }

    /// `s` when it is relative or uses an allowed scheme, else `#`. `allowDataImages` also lets `data:image/…`
    /// through (for `<img src>`; SVG excluded).
    public static func sanitize(_ s: String, allowDataImages: Bool = false) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let scheme = scheme(of: t) else { return t }
        if linkSchemes.contains(scheme) { return t }
        if allowDataImages, scheme == "data" {
            let lower = t.lowercased()
            if lower.hasPrefix("data:image/"), !lower.hasPrefix("data:image/svg") { return t }
        }
        return "#"
    }
}

public extension PageIcon {
    /// An emoji icon read from imported HTML: whitespace trimmed and cut to its first grapheme cluster, so an
    /// export can't smuggle markup or long text into the icon field. Nil when nothing is left.
    static func importedEmoji(_ raw: String) -> PageIcon? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.first else { return nil }
        let e = String(first)
        guard !e.contains("<"), !e.contains(">"), !e.contains("&") else { return nil }
        return .emoji(e)
    }
}
