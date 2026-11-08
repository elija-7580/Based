import Foundation
import Testing
@testable import BasedCore

/// A realistic Notion "HTML" export (markup as written by Notion's exporter) imported with full fidelity.
@MainActor
@Suite struct NotionHTMLImportTests {
    let home = "11111111111111111111111111111111"
    let tasks = "22222222222222222222222222222222"
    let people = "33333333333333333333333333333333"
    let rowA = "44444444444444444444444444444444"
    let rowB = "55555555555555555555555555555555"
    let ada = "66666666666666666666666666666666"
    let sub = "77777777777777777777777777777777"

    func dashed(_ h: String) -> String { ImportIDs.notion(h)! }

    func makeExport(homeExtra: String = "") throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nh-" + UUID().uuidString)
        let fm = FileManager.default
        let homeDir = root.appendingPathComponent("Home \(home)")
        let tasksDir = homeDir.appendingPathComponent("Tasks \(tasks)")
        let peopleDir = root.appendingPathComponent("People \(people)")
        for d in [homeDir, tasksDir, peopleDir] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
        try Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]).write(to: homeDir.appendingPathComponent("diagram.png"))
        try Data("pdf".utf8).write(to: homeDir.appendingPathComponent("report.pdf"))

        func page(_ id: String, _ header: String, _ body: String, cls: String = "page sans") -> String {
            """
            <html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>x</title><style>body{}</style></head><body>\
            <article id="\(dashed(id))" class="\(cls)"><header>\(header)</header><div class="page-body">\(body)</div></article>\
            <span class="sans" style="font-size:14px;padding-top:2em"></span></body></html>
            """
        }
        let homeBody = """
        <p id="a0000000-0000-4000-8000-000000000001" class="">Plain <strong>bold</strong> <em>it</em> <span style="border-bottom:0.05em solid">under</span> \
        <del>gone</del> <code>x()</code> <mark class="highlight-red">red</mark> <mark class="highlight-blue_background">blue bg</mark> \
        <a href="https://example.com">link</a> <a href="Home%20\(home)/Sub%20\(sub).html">Sub</a> <span class="user">@Ada Lovelace</span> \
        <time>@May 4, 2024</time> <span class="notion-text-equation-token"><span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span></span></p>
        <p id="a0000000-0000-4000-8000-000000000002" class="block-color-purple">Purple line<br/>second line</p>
        <figure class="block-color-gray_background callout" style="white-space:pre-wrap;display:flex" id="a0000000-0000-4000-8000-000000000003">\
        <div style="font-size:1.5em"><span class="icon">💡</span></div><div style="width:100%">Callout <strong>text</strong></div></figure>
        <ul id="a0000000-0000-4000-8000-000000000004" class="toggle"><li><details open=""><summary style="font-weight:600;font-size:1.5em;line-height:1.3;margin:0">Toggle heading</summary>\
        <div class="indented"><p id="a0000000-0000-4000-8000-000000000005" class="">Hidden child</p></div></details></li></ul>
        <ol type="1" id="a0000000-0000-4000-8000-000000000006" class="numbered-list" start="1"><li>First</li></ol>\
        <ol type="1" id="a0000000-0000-4000-8000-000000000007" class="numbered-list" start="2"><li>Second<ul id="a0000000-0000-4000-8000-000000000008" class="bulleted-list"><li style="list-style-type:disc">Nested</li></ul></li></ol>
        <ul id="a0000000-0000-4000-8000-000000000009" class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Shipped</span></li></ul>
        <blockquote id="a0000000-0000-4000-8000-000000000010" class="block-color-brown">Quote</blockquote><hr id="a0000000-0000-4000-8000-000000000011"/>
        <figure id="a0000000-0000-4000-8000-000000000012" class="equation"><div class="equation-container"><span class="katex-display"><span class="katex">\
        <span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span></span></span></div></figure>
        <div id="a0000000-0000-4000-8000-000000000013" class="column-list"><div id="a0000000-0000-4000-8000-000000000014" style="width:25%" class="column">\
        <p id="a0000000-0000-4000-8000-000000000015" class="">Left</p></div><div id="a0000000-0000-4000-8000-000000000016" style="width:75%" class="column">\
        <figure id="a0000000-0000-4000-8000-000000000017" class="image"><a href="Home%20\(home)/diagram.png"><img style="width:320px" src="Home%20\(home)/diagram.png"/></a><figcaption>The diagram</figcaption></figure></div></div>
        <figure id="a0000000-0000-4000-8000-000000000018"><a href="https://swift.org" class="bookmark source"><div class="bookmark-info"><div class="bookmark-text">\
        <div class="bookmark-title">Swift</div><div class="bookmark-description">The language</div></div><div class="bookmark-href">https://swift.org</div></div>\
        <img src="https://swift.org/og.png" class="bookmark-image"/></a></figure>
        <figure id="a0000000-0000-4000-8000-000000000019"><div class="source"><a href="Home%20\(home)/report.pdf">report.pdf</a></div></figure>
        <table id="a0000000-0000-4000-8000-000000000020" class="simple-table"><thead class="simple-table-header"><tr id="a0000000-0000-4000-8000-000000000021">\
        <th id="x1" class="simple-table-header-color simple-table-header">Key</th><th id="x2" class="simple-table-header-color simple-table-header">Value</th></tr></thead>\
        <tbody><tr id="a0000000-0000-4000-8000-000000000022"><td id="y1" class="">a</td><td id="y2" class=""><strong>1</strong></td></tr></tbody></table>
        <nav id="a0000000-0000-4000-8000-000000000023" class="block-color-gray table_of_contents"><div class="table_of_contents-item table_of_contents-indent-0">\
        <a class="table_of_contents-link" href="#a0000000-0000-4000-8000-000000000004">Toggle heading</a></div></nav>
        <pre id="a0000000-0000-4000-8000-000000000024" class="code code-wrap"><code class="language-JavaScript" style="white-space:pre-wrap">const a = 1;
        if (a &lt; 2) { log() }</code></pre>
        <figure id="a0000000-0000-4000-8000-000000000025" class="link-to-page"><a href="Home%20\(home)/Sub%20\(sub).html"><span class="icon">📄</span>Sub</a></figure>
        <figure id="a0000000-0000-4000-8000-000000000026" class="link-to-page"><a href="People%20\(people).html"><span class="icon">👥</span>People</a></figure>
        <div id="a0000000-0000-4000-8000-000000000027" class="collection-content"><h4 class="collection-title">Tasks</h4><table class="collection-content">\
        <thead><tr><th><span class="icon property-icon"><svg role="graphics-symbol" class="typesTitle"><path d=""></path></svg></span>Name</th>\
        <th><span class="icon property-icon"><svg class="typesStatus"></svg></span>Status</th><th><span class="icon property-icon"><svg class="typesMultipleSelect"></svg></span>Tags</th>\
        <th><span class="icon property-icon"><svg class="typesDate"></svg></span>Due</th><th><span class="icon property-icon"><svg class="typesNumber"></svg></span>Budget</th>\
        <th><span class="icon property-icon"><svg class="typesCheckbox"></svg></span>Done</th><th><span class="icon property-icon"><svg class="typesRelation"></svg></span>Owner</th></tr></thead><tbody>\
        <tr id="\(dashed(rowA))"><td class="cell-title"><a href="Home%20\(home)/Tasks%20\(tasks)/Write%20docs%20\(rowA).html"><span class="icon">📝</span>Write docs</a></td>\
        <td class="cell-AbCd"><span class="status-value select-value-color-green"><div class="status-dot status-dot-color-green"></div>Done</span></td>\
        <td class="cell-EfGh"><span class="selected-value select-value-color-blue">docs</span><span class="selected-value select-value-color-pink">urgent</span></td>\
        <td class="cell-IjKl"><time>@May 1, 2024</time></td><td class="cell-MnOp">$1,200.50</td><td class="cell-QrSt"><div class="checkbox checkbox-on"></div></td>\
        <td class="cell-UvWx"><a href="People%20\(people)/Ada%20\(ada).html">Ada</a></td></tr>\
        <tr id="\(dashed(rowB))"><td class="cell-title"><a href="Home%20\(home)/Tasks%20\(tasks)/Plan%20\(rowB).html">Plan</a></td>\
        <td class="cell-AbCd"><span class="status-value select-value-color-blue"><div class="status-dot status-dot-color-blue"></div>In progress</span></td>\
        <td class="cell-EfGh"><span class="selected-value select-value-color-blue">docs</span></td><td class="cell-IjKl"></td><td class="cell-MnOp">$80.00</td>\
        <td class="cell-QrSt"><div class="checkbox checkbox-off"></div></td><td class="cell-UvWx"></td></tr></tbody></table></div>
        <div class="mystery-widget" id="a0000000-0000-4000-8000-000000000028"><marquee>Fancy</marquee></div>
        \(homeExtra)
        """
        try page(home, """
            <img class="page-cover-image" src="https://www.notion.so/images/page-cover/gradients_8.png" style="object-position:center 40%"/>\
            <div class="page-header-icon page-header-icon-with-cover"><span class="icon">🏠</span></div><h1 class="page-title">Home</h1><p class="page-description"></p>
            """, homeBody, cls: "page serif").write(to: root.appendingPathComponent("Home \(home).html"), atomically: true, encoding: .utf8)
        try page(sub, "<h1 class=\"page-title\">Sub</h1>", "<p>Sub body</p>").write(to: homeDir.appendingPathComponent("Sub \(sub).html"), atomically: true, encoding: .utf8)
        try page(rowA, """
            <div class="page-header-icon undefined"><span class="icon">📝</span></div><h1 class="page-title">Write docs</h1><table class="properties"><tbody>\
            <tr class="property-row property-row-status"><th>Status</th><td><span class="status-value select-value-color-green">Done</span></td></tr>\
            <tr class="property-row property-row-multi_select"><th>Tags</th><td><span class="selected-value select-value-color-blue">docs</span><span class="selected-value select-value-color-pink">urgent</span></td></tr>\
            <tr class="property-row property-row-date"><th>Due</th><td><time>@May 1, 2024</time></td></tr>\
            <tr class="property-row property-row-number"><th>Budget</th><td>$1,200.50</td></tr>\
            <tr class="property-row property-row-checkbox"><th>Done</th><td><div class="checkbox checkbox-on"></div></td></tr>\
            <tr class="property-row property-row-relation"><th>Owner</th><td><a href="../../People%20\(people)/Ada%20\(ada).html">Ada</a></td></tr>\
            <tr class="property-row property-row-created_time"><th>Created</th><td>March 3, 2024 9:15 AM</td></tr>\
            <tr class="property-row property-row-auto_increment_id"><th>ID</th><td>TASK-7</td></tr>\
            <tr class="property-row property-row-formula"><th>Score</th><td>42</td></tr></tbody></table>
            """, "<p id=\"b0000000-0000-4000-8000-000000000001\">Row body text</p>").write(to: tasksDir.appendingPathComponent("Write docs \(rowA).html"), atomically: true, encoding: .utf8)
        // Full-page database at the top level with its own row
        try """
        <html><body><article id="\(dashed(people))" class="page sans"><header><div class="page-header-icon undefined"><span class="icon">👥</span></div>\
        <h1 class="page-title">People</h1><p class="page-description">Everyone on the team</p></header><table class="collection-content"><thead><tr>\
        <th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th><th><span class="icon property-icon"><svg class="typesEmail"></svg></span>Email</th></tr></thead>\
        <tbody><tr id="\(dashed(ada))"><td class="cell-title"><a href="People%20\(people)/Ada%20\(ada).html">Ada</a></td><td class="cell-Em"><a href="mailto:ada@example.com" class="email-value">ada@example.com</a></td></tr></tbody></table></article></body></html>
        """.write(to: root.appendingPathComponent("People \(people).html"), atomically: true, encoding: .utf8)
        return root
    }

    @Test func fullFidelityHTMLExport() throws {
        let root = try makeExport()
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let assets = FileAssetStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("as-" + UUID().uuidString))
        let r = try NotionImporter(store: store, assets: assets).importItems([root])
        #expect(r.databases == 2, "\(r)")
        #expect(r.rows == 3, "\(r)")
        #expect(r.assets == 2, "\(r)")

        let homeID = dashed(home)
        guard let homePage = store.blocks[homeID] else { Issue.record("home missing \(r)"); return }
        #expect(homePage.text.plainText == "Home")
        #expect(homePage.props.icon == .emoji("🏠"))
        #expect(homePage.props.cover == .url("https://www.notion.so/images/page-cover/gradients_8.png"))
        #expect(homePage.props.format?.font == .serif)
        let kids = store.childBlocks(of: .block(homeID))
        func block(_ n: Int) -> Block? { store.blocks[String(format: "a0000000-0000-4000-8000-%012d", n)] }

        // Inline formatting & mentions
        let p1 = try #require(block(1))
        let runs = p1.text.runs
        #expect(runs.contains { $0.text == "bold" && $0.marks.bold })
        #expect(runs.contains { $0.text == "it" && $0.marks.italic })
        #expect(runs.contains { $0.text == "under" && $0.marks.underline })
        #expect(runs.contains { $0.text == "gone" && $0.marks.strikethrough })
        #expect(runs.contains { $0.text == "x()" && $0.marks.code })
        #expect(runs.contains { $0.text == "red" && $0.marks.color == .red })
        #expect(runs.contains { $0.text == "blue bg" && $0.marks.color == .blueBackground })
        #expect(runs.contains { $0.text == "link" && $0.marks.link == "https://example.com" })
        #expect(runs.contains { $0.mention == .page(dashed(sub)) }, "\(runs)")
        #expect(runs.contains { $0.mention == .user("Ada Lovelace") })
        #expect(runs.contains { if case .date? = $0.mention { return true }; return false })
        #expect(runs.contains { $0.equation == "x^2" })
        #expect(block(2)?.props.color == .purple)
        #expect(block(2)?.text.plainText == "Purple line\nsecond line")

        // Blocks
        #expect(block(3)?.type == .callout)
        #expect(block(3)?.props.icon == .emoji("💡"))
        #expect(block(3)?.props.color == .grayBackground)
        #expect(block(3)?.text.plainText == "Callout text")
        #expect(block(4)?.type == .heading2)
        #expect(block(4)?.props.toggleable == true)
        #expect(block(5)?.parent == .block(block(4)!.id))
        #expect(block(6)?.type == .numberedList)
        #expect(block(7)?.text.plainText == "Second")
        #expect(block(8)?.parent == .block(block(7)!.id))
        #expect(block(8)?.type == .bulletedList)
        #expect(block(9)?.props.checked == true)
        #expect(block(10)?.type == .quote)
        #expect(block(10)?.props.color == .brown)
        #expect(block(11)?.type == .divider)
        #expect(block(12)?.props.expression == "E=mc^2")
        #expect(block(13)?.type == .columnList)
        #expect(block(14)?.props.ratio == 0.25)
        #expect(block(16)?.props.ratio == 0.75)
        #expect(block(17)?.type == .image)
        #expect(block(17)?.parent == .block(block(16)!.id))
        #expect(block(17)?.props.width == 320)
        #expect(block(17)?.props.caption?.plainText == "The diagram")
        #expect(block(17)?.props.asset.flatMap { assets.url(for: $0) } != nil)
        #expect(block(18)?.type == .bookmark)
        #expect(block(18)?.props.bookmark?.title == "Swift")
        #expect(block(19)?.type == .pdf)
        #expect(block(19)?.props.asset != nil)
        #expect(block(20)?.type == .table)
        #expect(block(20)?.props.tableHeaderRow == true)
        #expect(block(20)?.props.tableColumns == 2)
        #expect(block(22)?.props.cells?.map(\.plainText) == ["a", "1"])
        #expect(block(22)?.props.cells?[1].runs.first?.marks.bold == true)
        #expect(block(23)?.type == .tableOfContents)
        #expect(block(24)?.type == .code)
        #expect(block(24)?.props.language == "javascript")
        #expect(block(24)?.props.wrap == true)
        #expect(block(24)?.text.plainText.contains("if (a < 2)") == true)
        // Subpage nested in place of its link; link to a page elsewhere stays a link
        #expect(store.blocks[dashed(sub)]?.parent == .block(homeID))
        #expect(store.childBlocks(of: .block(dashed(sub))).first?.text.plainText == "Sub body")
        #expect(block(26)?.type == .linkToPage)
        #expect(block(26)?.props.linkTarget == dashed(people))
        // Unknown markup is kept as an HTML block with preview
        let html = try #require(block(28))
        #expect(html.type == .code)
        #expect(html.props.language == "html")
        #expect(html.props.url == "preview")
        #expect(html.text.plainText.contains("<marquee>Fancy</marquee>"))
        #expect(kids.count >= 20)

        // Inline database with typed properties
        let dbBlock = try #require(block(27))
        #expect(dbBlock.type == .databaseInline)
        let db = try #require(store.database(forBlock: dbBlock.id))
        #expect(db.title.plainText == "Tasks")
        func prop(_ n: String) -> PropertySchema? { db.property(named: n) }
        #expect(prop("Status")?.type == .status)
        #expect(prop("Status")?.option(named: "Done")?.color == .green)
        #expect(prop("Tags")?.type == .multiSelect)
        #expect(prop("Tags")?.option(named: "urgent")?.color == .pink)
        #expect(prop("Due")?.type == .date)
        #expect(prop("Budget")?.type == .number)
        #expect(prop("Budget")?.numberFormat == .dollar)
        #expect(prop("Done")?.type == .checkbox)
        #expect(prop("Owner")?.type == .relation)
        #expect(prop("Created")?.type == .createdTime)
        #expect(prop("ID")?.type == .uniqueID)
        #expect(prop("ID")?.idPrefix == "TASK")
        #expect(prop("Score")?.type == .number)   // formula values kept statically
        let view = try #require(store.views(forBlock: dbBlock.id).first)
        #expect(view.visiblePropertyIDs(in: db).map { db.property($0)?.name ?? "" } == ["Name", "Status", "Tags", "Due", "Budget", "Done", "Owner"])

        let a = try #require(store.blocks[dashed(rowA)])
        #expect(a.parent == .database(db.id))
        #expect(a.text.plainText == "Write docs")
        #expect(a.props.icon == .emoji("📝"))
        #expect(a.values[prop("Status")!.id] == .status(prop("Status")!.option(named: "Done")!.id))
        #expect(a.values[prop("Budget")!.id] == .number(1200.5))
        #expect(a.values[prop("Done")!.id] == .checkbox(true))
        #expect(a.values[prop("ID")!.id] == .uniqueID(7))
        #expect(a.values[prop("Owner")!.id] == .relation([dashed(ada)]))
        let cal = Calendar.current
        #expect(cal.component(.year, from: a.createdAt) == 2024)
        #expect(cal.component(.month, from: a.createdAt) == 3)
        #expect(store.childBlocks(of: .block(a.id)).map(\.text.plainText) == ["Row body text"])
        let b = try #require(store.blocks[dashed(rowB)])
        #expect(b.values[prop("Done")!.id] == .checkbox(false))
        #expect(db.nextUniqueID == 8)

        // Full-page database + relation target
        let peopleBlock = try #require(store.blocks[dashed(people)])
        #expect(peopleBlock.type == .databasePage)
        #expect(peopleBlock.props.icon == .emoji("👥"))
        let pdb = try #require(store.database(forBlock: peopleBlock.id))
        #expect(pdb.summary?.plainText == "Everyone on the team")
        #expect(pdb.property(named: "Email")?.type == .email)
        #expect(prop("Owner")?.relation?.databaseID == pdb.id)
        #expect(store.blocks[dashed(ada)]?.values[pdb.property(named: "Email")!.id] == .email("ada@example.com"))
    }

    @Test func reimportUpdatesInPlace() throws {
        let root = try makeExport()
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        _ = try NotionImporter(store: store, assets: nil).importItems([root])
        let count = store.blocks.count
        // Edit locally, then import the same export again: same records, no duplicates.
        store.transact("edit") { tx in tx.update(self.dashed(self.home)) { $0.text = RichText("Renamed") } }
        let extra = store.transact("add") { tx -> RecordID in
            let b = Block(type: .text, parent: .block(self.dashed(self.home)), sortKey: "zz", text: "stale")
            tx.put(b); return b.id
        }
        let r2 = try NotionImporter(store: store, assets: nil).importItems([root])
        #expect(store.blocks.count == count, "\(r2)")
        #expect(store.blocks[extra] == nil)
        #expect(store.blocks[dashed(home)]?.text.plainText == "Home")
        #expect(store.topLevelPages().filter { $0.text.plainText == "Home" }.count == 1)
        #expect(r2.warnings.contains { $0.contains("Updated") })
    }

    @Test func genericHTMLFileKeepsContent() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("gh-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent("notes.html")
        try """
        <!doctype html><html><head><title>My notes</title></head><body>
          <h1>Intro</h1>
          <p>Some
             <b>text</b> here</p>
          <ul><li>one</li><li>two</li></ul>
          <svg width="10" height="10"><circle r="4"/></svg>
        </body></html>
        """.write(to: f, atomically: true, encoding: .utf8)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let r = try NotionImporter(store: store, assets: nil).importItems([f])
        #expect(r.pages == 1)
        let page = try #require(store.topLevelPages().first { $0.text.plainText == "My notes" })
        let kids = store.childBlocks(of: .block(page.id))
        #expect(kids.map(\.type) == [.heading1, .text, .bulletedList, .bulletedList, .code])
        #expect(kids[1].text.plainText == "Some text here")
        #expect(kids[4].props.language == "html")
        #expect(kids[4].text.plainText.hasPrefix("<svg"))
    }

    @Test func ids() {
        #expect(ImportIDs.notion("1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D") == "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")
        #expect(ImportIDs.notionID(inName: "Project Plan 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.html") == "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")
        #expect(ImportIDs.notionID(inName: "https://www.notion.so/team/Plan-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=ffffffffffffffffffffffffffffffff") == "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")
        #expect(ImportIDs.derived("a", "b") == ImportIDs.derived("a", "b"))
        #expect(ImportIDs.derived("a", "b") != ImportIDs.derived("ab"))
        #expect(NotionHTMLImporter.columnRatio("calc((100% - 46px) * 0.5)") == 0.5)
    }
}
