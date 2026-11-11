import Foundation
import Testing
@testable import BasedCore

/// BSD-35: links/sources in exported and published HTML keep only safe schemes; imported icons can't carry markup.
@MainActor
@Suite struct WebSafetyTests {
    @Test func safeURLKeepsAllowedSchemesAndRelativeReferences() {
        for ok in ["https://example.com/a?b#c", "http://x", "mailto:a@b.c", "based://page/1", "HTTPS://X",
                   "page.html", "Sub%20Page%201234.html", "#anchor", "/p/abc/def", "assets/a.png", "?q=1"] {
            #expect(SafeURL.sanitize(ok) == ok, "\(ok)")
        }
        for bad in ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)",
                    "java\nscript:alert(1)", "vbscript:x", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"] {
            #expect(SafeURL.sanitize(bad) == "#", "\(bad.debugDescription)")
        }
        #expect(SafeURL.sanitize("data:image/png;base64,AAAA", allowDataImages: true) == "data:image/png;base64,AAAA")
        #expect(SafeURL.sanitize("data:image/svg+xml,<svg onload=alert(1)>", allowDataImages: true) == "#")
        #expect(SafeURL.sanitize("data:image/png;base64,AAAA") == "#")
    }

    @Test func htmlExportDropsJavascriptLinks() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "test")
        let page = s.createPage(title: "Links", icon: .emoji("<img src=x onerror=alert(1)>"))
        var t = RichText("click")
        t.runs[0].marks.link = "javascript:alert(document.cookie)"
        t.runs.append(TextRun(" ok", marks: Marks(link: "https://example.com")))
        s.insertBlock(.text, text: t, in: .block(page))
        var bm = BlockProps(); bm.url = "javascript:alert(2)"
        s.insertBlock(.bookmark, text: "", props: bm, in: .block(page))
        var img = BlockProps(); img.url = "javascript:alert(3)"
        s.insertBlock(.image, text: "", props: img, in: .block(page))
        var embed = BlockProps(); embed.url = "data:text/html,<script>alert(4)</script>"
        s.insertBlock(.embed, text: "", props: embed, in: .block(page))
        let out = HTMLExporter(store: s).export(page: page)
        #expect(!out.lowercased().contains("=\"javascript:"), "no javascript: in href/src (shown as text is fine)")
        #expect(!out.contains("src=\"data:text/html"))
        #expect(out.contains("href=\"https://example.com\""))
        #expect(out.contains("href=\"#\""))
        #expect(!out.contains("<img src=x"), "the emoji icon is escaped")
    }

    @Test func importedIconIsOneGraphemeWithoutMarkup() throws {
        #expect(PageIcon.importedEmoji("  💡 ") == .emoji("💡"))
        #expect(PageIcon.importedEmoji("👩‍👩‍👧 family") == .emoji("👩‍👩‍👧"))
        #expect(PageIcon.importedEmoji("<img src=x onerror=alert(1)>") == nil)
        #expect(PageIcon.importedEmoji("   ") == nil)

        let id = "99999999999999999999999999999999"
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("evil-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("Evil \(id).html")
        try """
        <html><head><meta charset="utf-8"/><title>Evil</title></head><body>\
        <article id="\(ImportIDs.notion(id)!)" class="page sans"><header>\
        <div class="page-header-icon undefined"><span class="icon">&lt;img src=x onerror=alert(1)&gt;</span></div>\
        <h1 class="page-title">Evil</h1></header><div class="page-body"><p>body</p></div></article></body></html>
        """.write(to: f, atomically: true, encoding: .utf8)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        _ = try NotionImporter(store: store, assets: nil).importItems([f])
        let page = try #require(store.topLevelPages().first { $0.text.plainText == "Evil" })
        if case .emoji(let e)? = page.props.icon { #expect(!e.contains("<") && e.count == 1) }
    }
}

/// Published pages: HTML blocks can load from a URL (sandboxed by the server) instead of srcdoc.
@MainActor
@Suite struct HTMLBlockURLTests {
    @Test func htmlBlockUsesURLWhenSet() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "test")
        let page = s.createPage(title: "P")
        var html = BlockProps(); html.language = "html"
        let block = s.insertBlock(.code, text: "<b>x</b>", props: html, in: .block(page))
        #expect(HTMLExporter(store: s).export(page: page).contains("srcdoc="), "files keep srcdoc")
        var e = HTMLExporter(store: s)
        e.htmlBlockURL = { id in "/p/L/\(page)/html/\(id)" }
        let out = e.export(page: page)
        #expect(out.contains("<iframe sandbox=\"allow-scripts\" loading=\"lazy\" src=\"/p/L/\(page)/html/\(block)\">"))
        #expect(!out.contains("srcdoc="))
    }
}
