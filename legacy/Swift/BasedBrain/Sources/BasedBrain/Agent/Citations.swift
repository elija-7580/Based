import Foundation
import BasedCore

// MARK: - Answers with sources (BSD-61)
//
// When an agent answers from the user's pages it cites them inline as `[[block:<id>]]` or `[[page:<id>]]` (the ids
// come from `search` and `read_page` with `block_ids: true`). The saved transcript keeps the markers; when a reply is
// shown, `Citations.render` turns them into numbered links (¹ ² …) and appends a "Sources" list (page title and the
// cited text). A link opens the page and scrolls to the block. Ids that do not exist (any more) are dropped. While
// a reply is still streaming, a marker that is cut off at the end is hidden until its chunk arrives.

public struct Citation: Sendable, Equatable {
    public var number: Int
    public var pageID: RecordID
    /// nil when the whole page is cited.
    public var blockID: RecordID?
    public var title: String
    public var snippet: String
}

public struct CitedText: Sendable, Equatable {
    /// Markdown with numbered links in place of the markers and the source list at the end.
    public var markdown: String
    public var citations: [Citation]
}

public enum Citations {
    /// What the system prompt asks of agents that answer from the workspace.
    public static let instruction = """
    When your answer uses the user's pages, cite each statement right after it with [[block:<block id>]] (or \
    [[page:<page id>]] for a whole page), using ids from search results or read_page with block_ids: true. \
    Cite only ids you actually read; no source list of your own — Based shows the sources.
    """

    static let pattern = try! NSRegularExpression(pattern: #"\s?\[\[(block|page):\s*([A-Za-z0-9_-]{1,64})\s*\]\]"#)

    /// The raw markers in order of appearance (kind, id), duplicates included.
    public static func markers(in text: String) -> [(kind: String, id: String)] {
        let ns = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map {
            (ns.substring(with: $0.range(at: 1)), ns.substring(with: $0.range(at: 2)))
        }
    }

    /// Hides a marker that is still being streamed ("… [[blo", "[[block:12ab") at the end of `text`.
    public static func streamingSafe(_ text: String) -> String {
        guard let open = text.range(of: "[[", options: .backwards) else {
            return text.hasSuffix("[") ? String(text.dropLast()) : text
        }
        let tail = text[open.lowerBound...]
        if tail.contains("]]") { return text.hasSuffix("[") ? String(text.dropLast()) : text }
        let inner = tail.dropFirst(2)
        let looksLikeMarker = "block:".hasPrefix(inner.prefix(6)) || "page:".hasPrefix(inner.prefix(5))
            || inner.hasPrefix("block:") || inner.hasPrefix("page:")
        return looksLikeMarker ? String(text[..<open.lowerBound]).replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) : text
    }

    /// The link a citation opens: the page (any Based link handler opens it) plus the block to scroll to.
    public static func link(page: RecordID, block: RecordID?) -> String {
        PageLink.url(page) + (block.map { "?block=\($0)" } ?? "")
    }

    /// Page and block of a citation link (nil for other links).
    public static func target(of url: URL) -> (page: RecordID, block: RecordID?)? {
        guard url.scheme == PageLink.scheme, url.host == "page", let page = PageLink.id(from: url.absoluteString) else { return nil }
        let block = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "block" }?.value
        return (page, block?.isEmpty == false ? block : nil)
    }

    static let superscripts: [Character] = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"]
    static func superscript(_ n: Int) -> String { String(String(n).compactMap { $0.wholeNumberValue.map { superscripts[$0] } }) }

    /// Replaces the markers with numbered links and appends the sources. `resolve` maps (kind, id) to the page,
    /// block, title and cited text — nil drops the marker. The same source cited twice keeps its number.
    public static func render(_ text: String, streaming: Bool = false,
                              resolve: (_ kind: String, _ id: String) -> Citation?) -> CitedText {
        let source = streaming ? streamingSafe(text) : text
        let ns = source as NSString
        var out = "", last = 0
        var cites: [Citation] = []
        var numbers: [String: Int] = [:]
        for m in pattern.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            last = m.range.location + m.range.length
            let kind = ns.substring(with: m.range(at: 1)), id = ns.substring(with: m.range(at: 2))
            guard var c = resolve(kind, id) else { continue }
            let key = c.pageID + "/" + (c.blockID ?? "")
            let n: Int
            if let known = numbers[key] { n = known } else {
                n = cites.count + 1; numbers[key] = n; c.number = n; cites.append(c)
            }
            let current = cites[n - 1]
            out += "[\(superscript(n))](\(link(page: current.pageID, block: current.blockID)))"
        }
        out += ns.substring(from: last)
        guard !cites.isEmpty else { return CitedText(markdown: out, citations: []) }
        out += "\n\n**Sources**\n\n" + cites.map { c in
            let title = c.title.isEmpty ? "Untitled" : c.title.replacingOccurrences(of: "]", with: "\\]")
            let snippet = c.snippet.isEmpty ? "" : " — " + c.snippet
            return "\(c.number). [\(title)](\(link(page: c.pageID, block: c.blockID)))\(snippet)"
        }.joined(separator: "\n")
        return CitedText(markdown: out, citations: cites)
    }

    /// `render` against the workspace: blocks must exist, not be in the trash and sit on a page; the snippet is the
    /// block's text (mentions shown with current titles), shortened.
    @MainActor
    public static func render(_ text: String, store: WorkspaceStore, streaming: Bool = false) -> CitedText {
        guard text.contains("[[") else { return CitedText(markdown: text, citations: []) }
        return render(text, streaming: streaming) { kind, id in
            guard let b = store.blocks[id], b.trashedAt == nil else { return nil }
            if kind == "page" || b.type == .page {
                return Citation(number: 0, pageID: id, blockID: nil, title: store.title(of: id), snippet: "")
            }
            guard let page = store.containingPage(of: id), store.blocks[page]?.trashedAt == nil else { return nil }
            let raw = store.plainTextResolvingMentions(b.text).trimmingCharacters(in: .whitespacesAndNewlines)
            let snippet = raw.count > 120 ? String(raw.prefix(117)) + "…" : raw
            return Citation(number: 0, pageID: page, blockID: id, title: store.title(of: page), snippet: snippet)
        }
    }

    /// The page's top-level blocks with their ids, for citing (`read_page` with `block_ids: true`).
    @MainActor
    public static func pageWithBlockIDs(_ page: RecordID, store: WorkspaceStore) -> String {
        let exporter = MarkdownExporter(store: store)
        return store.contentBlocks(of: page).map { b in
            "[block:\(b.id)]\n" + exporter.exportBlocks([b], indent: 0).trimmingCharacters(in: .newlines)
        }.joined(separator: "\n\n")
    }
}
