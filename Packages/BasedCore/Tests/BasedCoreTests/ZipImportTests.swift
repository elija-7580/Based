import XCTest
@testable import BasedCore

@MainActor
final class ZipImportTests: XCTestCase {
    func bytes(_ b64: String) -> [UInt8] { [UInt8](Data(base64Encoded: b64, options: .ignoreUnknownCharacters)!) }

    func generatedLines(_ n: Int) -> String {
        let s = "alpha beta gamma"
        return (0..<n).map { i in "Line \(i): value \((i * 7919) % 1000) \(String(s.prefix(i % 16)))" }.joined(separator: "\n") + "\n"
    }

    func tempFile(_ name: String, _ b64: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("zt-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let u = dir.appendingPathComponent(name)
        try Data(base64Encoded: b64, options: .ignoreUnknownCharacters)!.write(to: u)
        return u
    }

    func testInflateDynamicFixedAndStored() throws {
        let expected = Array(generatedLines(1500).utf8)
        XCTAssertEqual(try Inflate.decompress(bytes(ZipFixtures.deflate9)), expected)
        XCTAssertEqual(try Inflate.decompress(bytes(ZipFixtures.deflate1)), expected)
        let small = Array(String(repeating: "hello hello hello stored block ", count: 20).utf8)
        XCTAssertEqual(try Inflate.decompress(bytes(ZipFixtures.deflate0)), small)
        XCTAssertThrowsError(try Inflate.decompress([0xFF, 0xFF, 0xFF]))
    }

    func testCRC32() {
        XCTAssertEqual(CRC32.checksum(Array("The quick brown fox jumps over the lazy dog".utf8)), 0x414F_A339)
    }

    func testZipEntriesAndNestedExtraction() throws {
        let url = try tempFile("Export-abc.zip", ZipFixtures.notionMarkdownZip)
        let zip = try ZipArchive(url: url)
        XCTAssertEqual(zip.entries.map(\.path), ["Export-abc-Part-1.zip"])
        let out = url.deletingLastPathComponent().appendingPathComponent("out")
        let n = try zip.extractAll(to: out)
        XCTAssertGreaterThanOrEqual(n, 7)
        let part = out.appendingPathComponent("Export-abc-Part-1")
        let files = try FileManager.default.subpathsOfDirectory(atPath: part.path)
        XCTAssertTrue(files.contains { $0.hasSuffix("image.png") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.appendingPathComponent("Export-abc-Part-1.zip").path))
        XCTAssertNil(ZipArchive.sanitized("../../etc/passwd"))
        XCTAssertEqual(ZipArchive.sanitized("/a/./b"), "a/b")
    }

    func testImportNotionMarkdownZip() throws {
        let url = try tempFile("Export-abc.zip", ZipFixtures.notionMarkdownZip)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let assetsDir = url.deletingLastPathComponent().appendingPathComponent("assets")
        let r = try NotionImporter(store: store, assets: FileAssetStore(root: assetsDir)).importItems([url])
        XCTAssertEqual(r.databases, 1, "\(r)")
        XCTAssertEqual(r.rows, 2, "\(r)")
        XCTAssertGreaterThanOrEqual(r.pages, 4, "\(r)")
        XCTAssertEqual(r.assets, 1, "\(r)")
        let titles = store.blocks.values.filter { $0.type == .page }.map { store.title(of: $0.id) }
        XCTAssertTrue(titles.contains("Projects"))
        XCTAssertTrue(titles.contains("Notes"))
        XCTAssertTrue(titles.contains("Log"))
        guard let spec = store.blocks.values.first(where: { store.title(of: $0.id) == "Write spec" }) else { return XCTFail("row missing") }
        let body = store.visibleOrder(in: spec.id).map { store.blocks[$0]!.text.plainText }
        XCTAssertEqual(body, ["Body of the row."])
        guard let log = store.blocks.values.first(where: { store.title(of: $0.id) == "Log" }) else { return XCTFail() }
        XCTAssertEqual(store.visibleOrder(in: log.id).count, 1500)
    }

    func testHTMLConverter() {
        let html = String(decoding: Data(base64Encoded: ZipFixtures.notionHTMLZip, options: .ignoreUnknownCharacters)!, as: UTF8.self)
        XCTAssertFalse(html.isEmpty)
        let page = HTMLPageConverter(html: """
        <html><body><article class="page sans"><header><div class="page-header-icon"><span class="icon">🏠</span></div>
        <h1 class="page-title">Home</h1></header><div class="page-body"><h2>Plans &amp; Ideas</h2>
        <p>Hello <strong>bold</strong> and <a href="Sub%20x.html">sub</a>.</p>
        <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span>Done</span></li></ul>
        <ul class="bulleted-list"><li>One<ul class="bulleted-list"><li>Nested</li></ul></li></ul>
        <pre class="code"><code class="language-Swift">let x = 1 &lt; 2</code></pre></div></article></body></html>
        """)
        let lines = page.markdown.components(separatedBy: "\n")
        XCTAssertEqual(lines.first, "# 🏠 Home")
        XCTAssertTrue(lines.contains("## Plans & Ideas"), page.markdown)
        XCTAssertTrue(lines.contains("Hello **bold** and [sub](Sub%20x.md)."), page.markdown)
        XCTAssertTrue(lines.contains("- [x] Done"), page.markdown)
        XCTAssertTrue(lines.contains("- One"), page.markdown)
        XCTAssertTrue(lines.contains("    - Nested"), page.markdown)
        XCTAssertTrue(lines.contains("```swift"), page.markdown)
        XCTAssertTrue(lines.contains("let x = 1 < 2"), page.markdown)
    }

    func testImportNotionHTMLZip() throws {
        let url = try tempFile("Export-html.zip", ZipFixtures.notionHTMLZip)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let r = try NotionImporter(store: store, assets: nil).importItems([url])
        XCTAssertEqual(r.databases, 1, "\(r)")
        XCTAssertEqual(r.rows, 2, "\(r)")
        guard let home = store.topLevelPages().first(where: { store.title(of: $0.id) == "Home" }) else {
            return XCTFail("Home missing: \(store.topLevelPages().map { store.title(of: $0.id) }) \(r)")
        }
        XCTAssertEqual(home.props.icon, .emoji("🏠"))
        let kids = store.visibleOrder(in: home.id).compactMap { store.blocks[$0] }
        XCTAssertTrue(kids.contains { $0.type == .todo && $0.props.checked == true && $0.text.plainText == "Done thing" }, "\(kids.map { ($0.type, $0.text.plainText) })")
        XCTAssertTrue(kids.contains { $0.type == .toggle && $0.text.plainText == "Toggle head" })
        XCTAssertTrue(kids.contains { $0.type == .code })
        XCTAssertTrue(store.subpages(of: home.id).contains { store.title(of: $0.id) == "Child" })
        guard let dune = store.blocks.values.first(where: { store.title(of: $0.id) == "Dune" }) else { return XCTFail("Dune missing") }
        XCTAssertEqual(store.visibleOrder(in: dune.id).map { store.blocks[$0]!.text.plainText }, ["Spice must flow"])
    }

    func testUnsupportedFileWarning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("zt-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent("notes.docx")
        try Data("x".utf8).write(to: f)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let r = try NotionImporter(store: store, assets: nil).importItems([f])
        XCTAssertEqual(r.pages, 0)
        XCTAssertTrue(r.warnings.first?.contains("not a Markdown") == true)
    }
}

final class LogTests: XCTestCase {
    func testRingBufferFilteringAndFile() throws {
        let log = Log(capacity: 10)
        log.minimumLevel = .debug
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("log-" + UUID().uuidString)
        log.configure(directory: dir, name: "test", maxFileBytes: 600, maxFiles: 3)
        for i in 0..<25 { log.log(i % 5 == 0 ? .warning : .info, "message \(i)", category: i % 2 == 0 ? "even" : "odd") }
        XCTAssertEqual(log.recent(limit: 100).count, 10)
        XCTAssertEqual(log.recent(limit: 100).last?.message, "message 24")
        XCTAssertEqual(log.recent(minLevel: .warning).map(\.message), ["message 15", "message 20"])
        XCTAssertEqual(log.recent(category: "even").count, 5)
        XCTAssertEqual(log.recent(search: "message 2").map(\.message), ["message 20", "message 21", "message 22", "message 23", "message 24"])
        log.flush()
        let files = log.logFiles
        XCTAssertGreaterThan(files.count, 1, "rotation expected")
        XCTAssertLessThanOrEqual(files.count, 3)
        let current = Log.read(file: files[0])
        XCTAssertEqual(current.last?.message, "message 24")
        XCTAssertEqual(current.last?.category, "even")
        log.breadcrumb("opened page")
        XCTAssertTrue(log.exportText().contains("opened page"))
    }

    func testMinimumLevelSkipsWork() {
        let log = Log(capacity: 10)
        log.minimumLevel = .warning
        var evaluated = false
        log.log(.debug, { evaluated = true; return "x" }(), category: "c")
        XCTAssertFalse(evaluated)
        XCTAssertTrue(log.recent().isEmpty)
    }
}

@MainActor
final class BacklinkIndexTests: XCTestCase {
    func testBacklinksFollowEdits() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let target = s.createPage(title: "Target")
        let a = s.createPage(title: "A")
        XCTAssertEqual(s.backlinks(to: target), [])
        var t = RichText("see ")
        t.append(RichText(runs: [TextRun("Target", mention: .page(target))]))
        let blk = s.insertBlock(.text, text: "", in: .block(a))
        s.transact("mention") { tx in tx.update(blk) { $0.text = t } }
        XCTAssertEqual(s.backlinks(to: target), [a])
        s.transact("clear") { tx in tx.update(blk) { $0.text = RichText("plain") } }
        XCTAssertEqual(s.backlinks(to: target), [])
        s.undo()
        XCTAssertEqual(s.backlinks(to: target), [a])
    }
}
