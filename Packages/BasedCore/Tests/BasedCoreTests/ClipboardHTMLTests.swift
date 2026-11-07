import XCTest
@testable import BasedCore

final class ClipboardHTMLTests: XCTestCase {
    func testNotionStyleClipboard() {
        let html = """
        <meta charset="utf-8"><h2>Plan</h2>
        <p>Some <strong>bold</strong> and <span class="highlight-red">red</span> text with a
        <a href="https://www.notion.so/Tasks-1fe618c1167e80f8946ec1a7918dfc28">Tasks</a> link.</p>
        <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div><span class="to-do-children-checked">Done thing</span></li>
        <li><div class="checkbox checkbox-off"></div><span>Open thing</span></li></ul>
        <ul><li>Bullet<ul><li>Nested</li></ul></li></ul>
        <details><summary>Toggle title</summary><p>Inside toggle</p></details>
        <aside><span class="icon">💡</span><div>Callout text</div></aside>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        <pre><code class="language-swift">let x = 1</code></pre><hr>
        """
        let known = "1fe618c1-167e-80f8-946e-c1a7918dfc28"
        let blocks = ClipboardHTMLImporter(resolvePage: ClipboardHTMLImporter.pageResolver { $0 == known }).parse(html)
        XCTAssertEqual(blocks.map(\.type), [.heading2, .text, .todo, .todo, .bulletedList, .toggle, .callout, .table, .code, .divider])
        XCTAssertTrue(blocks[1].text.runs.contains { $0.marks.bold && $0.text == "bold" })
        XCTAssertTrue(blocks[1].text.runs.contains { $0.marks.color == .red })
        XCTAssertTrue(blocks[1].text.runs.contains { $0.mention == .page(known) })
        XCTAssertEqual(blocks[2].props.checked, true)
        XCTAssertEqual(blocks[3].props.checked, false)
        XCTAssertEqual(blocks[3].text.plainText, "Open thing")
        XCTAssertEqual(blocks[4].children.first?.text.plainText, "Nested")
        XCTAssertEqual(blocks[5].children.first?.text.plainText, "Inside toggle")
        XCTAssertEqual(blocks[6].props.icon, .emoji("💡"))
        XCTAssertEqual(blocks[6].text.plainText, "Callout text")
        XCTAssertEqual(blocks[7].props.tableColumns, 2)
        XCTAssertEqual(blocks[7].props.tableHeaderRow, true)
        XCTAssertEqual(blocks[8].props.language, "swift")
        XCTAssertTrue(ClipboardHTMLImporter.isStructured(html))
        XCTAssertFalse(ClipboardHTMLImporter.isStructured("<span>just text</span>"))
    }
}

final class ClipboardRoundTripTests: XCTestCase {
    @MainActor
    func testBasedHTMLCopyPastesBackAsSameBlocks() throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let page = store.createPage(title: RichText("P"), in: .workspace)
        let md = "## Head\n\n- [x] done\n- bullet\n\n> [!NOTE] callout\n\n<details><summary>T</summary>\n\ninside\n\n</details>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n"
        store.insertImported(MarkdownImporter().parse(md), in: .block(page))
        let blocks = store.contentBlocks(of: page)
        var exporter = HTMLExporter(store: store, pageLink: { id in (store.title(of: id), PageLink.url(id)) })
        exporter.headingOffset = 0
        let html = exporter.blocks(blocks)
        let back = ClipboardHTMLImporter().parse(html)
        XCTAssertEqual(back.map(\.type), blocks.map(\.type), html)
    }
}
