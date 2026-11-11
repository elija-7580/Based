import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct InteropTests {
    @Test func inlineCodecRoundTrip() {
        let t = RichText(runs: [TextRun("plain "), TextRun("bold", marks: Marks(bold: true)), TextRun(" and "),
                                TextRun("code", marks: Marks(code: true)), TextRun(" "), TextRun("link", marks: Marks(link: "https://a.b"))])
        let md = InlineMarkdownCodec.encode(t)
        #expect(md == "plain **bold** and `code` [link](https://a.b)")
        #expect(InlineMarkdownCodec.decode(md) == t)
        #expect(InlineMarkdownCodec.decode("a \\*not italic\\*").plainText == "a *not italic*")
        #expect(InlineMarkdownCodec.decode("~~gone~~").marks(at: 1).strikethrough)
    }

    @Test func markdownImportExport() {
        let md = """
        # Heading

        Some **bold** text

        - item one
            - nested
        - [x] done task
        1. first
        2. second

        > quoted

        ```swift
        let x = 1
        ```

        ---

        | A | B |
        | --- | --- |
        | 1 | 2 |

        <details>
        <summary>More</summary>

        hidden

        </details>
        """
        let blocks = MarkdownImporter().parse(md)
        #expect(blocks.map(\.type) == [.heading1, .text, .bulletedList, .todo, .numberedList, .numberedList, .quote, .code, .divider, .table, .toggle])
        #expect(blocks[2].children.first?.text.plainText == "nested")
        #expect(blocks[3].props.checked == true)
        #expect(blocks[7].props.language == "swift")
        #expect(blocks[9].children.count == 2)
        #expect(blocks[10].children.first?.text.plainText == "hidden")

        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "m")
        let page = s.createPage(title: "Doc")
        s.insertImported(blocks, in: .block(page))
        let out = MarkdownExporter(store: s).export(page: page)
        #expect(out.hasPrefix("# Doc\n"))
        #expect(out.contains("Some **bold** text"))
        #expect(out.contains("- item one\n    - nested"))
        #expect(out.contains("- [x] done task"))
        #expect(out.contains("2. second"))
        #expect(out.contains("```swift\nlet x = 1\n```"))
        #expect(out.contains("| 1 | 2 |"))
        // re-import gives the same structure
        let again = MarkdownImporter().parse(MarkdownImporter.splitTitle(out).body)
        #expect(again.map(\.type) == blocks.map(\.type))
    }

    @Test func csv() {
        let rows = [["Name", "Notes"], ["A, B", "say \"hi\"\nnext"], ["C", ""]]
        #expect(CSV.decode(CSV.encode(rows)) == rows)
    }

    @Test func notionExportImport() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString)")
        let fm = FileManager.default
        let hex1 = "0123456789abcdef0123456789abcdef", hex2 = "fedcba9876543210fedcba9876543210", hex3 = "11112222333344445555666677778888"
        try fm.createDirectory(at: root.appendingPathComponent("Home \(hex1)/Tasks \(hex3)"), withIntermediateDirectories: true)
        try """
        # Home

        Welcome to **Home**.

        [Child](Home%20\(hex1)/Child%20\(hex2).md)

        [Tasks](Home%20\(hex1)/Tasks%20\(hex3).csv)
        """.write(to: root.appendingPathComponent("Home \(hex1).md"), atomically: true, encoding: .utf8)
        try "# Child\n\nBack to [Home](../Home%20\(hex1).md)\n".write(to: root.appendingPathComponent("Home \(hex1)/Child \(hex2).md"), atomically: true, encoding: .utf8)
        try "Name,Status,Estimate,Done,Tags\nWrite docs,In progress,3,No,\"docs, writing\"\nShip,Done,5,Yes,release\n"
            .write(to: root.appendingPathComponent("Home \(hex1)/Tasks \(hex3).csv"), atomically: true, encoding: .utf8)
        try "Name,Status,Estimate,Done,Tags\nWrite docs,In progress,3,No,\"docs, writing\"\nShip,Done,5,Yes,release\n"
            .write(to: root.appendingPathComponent("Home \(hex1)/Tasks \(hex3)_all.csv"), atomically: true, encoding: .utf8)
        try "# Ship\n\nStatus: Done\nEstimate: 5\n\nRelease notes here.\n"
            .write(to: root.appendingPathComponent("Home \(hex1)/Tasks \(hex3)/Ship \(hex2.prefix(16))\(hex1.prefix(16)).md"), atomically: true, encoding: .utf8)

        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "i")
        let report = try NotionImporter(store: s, assets: nil).importItems([root])
        #expect(report.databases == 1)
        let home = s.topLevelPages().first { s.title(of: $0.id) == "Home" }!
        let content = s.contentBlocks(of: home.id)
        #expect(content.map(\.type) == [.text, .page, .databaseInline])
        let child = content[1]
        #expect(s.title(of: child.id) == "Child")
        // link back to Home resolved as a page mention
        let backlink = s.contentBlocks(of: child.id).first!
        #expect(backlink.text.mentionedPages == [home.id])
        let db = s.database(forBlock: content[2].id)!
        #expect(db.title.plainText == "Tasks")
        #expect(db.property(named: "Estimate")?.type == .number)
        #expect(db.property(named: "Done")?.type == .checkbox)
        #expect(db.property(named: "Status")?.type == .status)
        #expect(db.property(named: "Tags")?.type == .multiSelect)
        let rows = s.rows(of: db.id)
        #expect(rows.map(\.title) == ["Write docs", "Ship"])
        let ship = rows[1]
        #expect(s.contentBlocks(of: ship.id).first?.text.plainText == "Release notes here.")
        try? fm.removeItem(at: root)
    }

    @Test func search() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "s")
        let a = s.createPage(title: "Meeting notes")
        let b = s.createPage(title: "Groceries")
        s.insertBlock(.text, text: "Discuss the quarterly meeting agenda", in: .block(b))
        let hits = SearchEngine(store: s).search("meeting")
        #expect(hits.first?.pageID == a)
        #expect(hits.count == 2)
        #expect(hits.first { $0.pageID == b }?.snippet != nil)
        var f = SearchFilters(); f.titleOnly = true
        #expect(SearchEngine(store: s).search("meeting", filters: f).map(\.pageID) == [a])
    }
}