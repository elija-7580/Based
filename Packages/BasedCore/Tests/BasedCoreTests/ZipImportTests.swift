import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct ZipImportTests {
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

    @Test func inflateDynamicFixedAndStored() throws {
        let expected = Array(generatedLines(1500).utf8)
        #expect(try Inflate.decompress(bytes(ZipFixtures.deflate9)) == expected)
        #expect(try Inflate.decompress(bytes(ZipFixtures.deflate1)) == expected)
        let small = Array(String(repeating: "hello hello hello stored block ", count: 20).utf8)
        #expect(try Inflate.decompress(bytes(ZipFixtures.deflate0)) == small)
        #expect(throws: (any Error).self) { try Inflate.decompress([0xFF, 0xFF, 0xFF]) }
    }

    @Test func crc32() {
        #expect(CRC32.checksum(Array("The quick brown fox jumps over the lazy dog".utf8)) == 0x414F_A339)
    }

    @Test func zipEntriesAndNestedExtraction() throws {
        let url = try tempFile("Export-abc.zip", ZipFixtures.notionMarkdownZip)
        let zip = try ZipArchive(url: url)
        #expect(zip.entries.map(\.path) == ["Export-abc-Part-1.zip"])
        let out = url.deletingLastPathComponent().appendingPathComponent("out")
        let n = try zip.extractAll(to: out)
        #expect(n >= 7)
        let part = out.appendingPathComponent("Export-abc-Part-1")
        let files = try FileManager.default.subpathsOfDirectory(atPath: part.path)
        #expect(files.contains { $0.hasSuffix("image.png") })
        #expect(!FileManager.default.fileExists(atPath: out.appendingPathComponent("Export-abc-Part-1.zip").path))
        #expect(ZipArchive.sanitized("../../etc/passwd") == nil)
        #expect(ZipArchive.sanitized("/a/./b") == "a/b")
    }

    @Test func importNotionMarkdownZip() throws {
        let url = try tempFile("Export-abc.zip", ZipFixtures.notionMarkdownZip)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let assetsDir = url.deletingLastPathComponent().appendingPathComponent("assets")
        let r = try NotionImporter(store: store, assets: FileAssetStore(root: assetsDir)).importItems([url])
        #expect(r.databases == 1, "\(r)")
        #expect(r.rows == 2, "\(r)")
        #expect(r.pages >= 4, "\(r)")
        #expect(r.assets == 1, "\(r)")
        let titles = store.blocks.values.filter { $0.type == .page }.map { store.title(of: $0.id) }
        #expect(titles.contains("Projects"))
        #expect(titles.contains("Notes"))
        #expect(titles.contains("Log"))
        guard let spec = store.blocks.values.first(where: { store.title(of: $0.id) == "Write spec" }) else { Issue.record("row missing"); return }
        let body = store.visibleOrder(in: spec.id).map { store.blocks[$0]!.text.plainText }
        #expect(body == ["Body of the row."])
        guard let log = store.blocks.values.first(where: { store.title(of: $0.id) == "Log" }) else { Issue.record(); return }
        #expect(store.visibleOrder(in: log.id).count == 1500)
    }

    @Test func htmlConverter() {
        let html = String(decoding: Data(base64Encoded: ZipFixtures.notionHTMLZip, options: .ignoreUnknownCharacters)!, as: UTF8.self)
        #expect(!html.isEmpty)
        let page = HTMLPageConverter(html: """
        <html><body><article class="page sans"><header><div class="page-header-icon"><span class="icon">🏠</span></div>
        <h1 class="page-title">Home</h1></header><div class="page-body"><h2>Plans &amp; Ideas</h2>
        <p>Hello <strong>bold</strong> and <a href="Sub%20x.html">sub</a>.</p>
        <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span>Done</span></li></ul>
        <ul class="bulleted-list"><li>One<ul class="bulleted-list"><li>Nested</li></ul></li></ul>
        <pre class="code"><code class="language-Swift">let x = 1 &lt; 2</code></pre></div></article></body></html>
        """)
        let lines = page.markdown.components(separatedBy: "\n")
        #expect(lines.first == "# 🏠 Home")
        #expect(lines.contains("## Plans & Ideas"), Comment(rawValue: page.markdown))
        #expect(lines.contains("Hello **bold** and [sub](Sub%20x.md)."), Comment(rawValue: page.markdown))
        #expect(lines.contains("- [x] Done"), Comment(rawValue: page.markdown))
        #expect(lines.contains("- One"), Comment(rawValue: page.markdown))
        #expect(lines.contains("    - Nested"), Comment(rawValue: page.markdown))
        #expect(lines.contains("```swift"), Comment(rawValue: page.markdown))
        #expect(lines.contains("let x = 1 < 2"), Comment(rawValue: page.markdown))
    }

    @Test func importNotionHTMLZip() throws {
        let url = try tempFile("Export-html.zip", ZipFixtures.notionHTMLZip)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let r = try NotionImporter(store: store, assets: nil).importItems([url])
        #expect(r.databases == 1, "\(r)")
        #expect(r.rows == 2, "\(r)")
        guard let home = store.topLevelPages().first(where: { store.title(of: $0.id) == "Home" }) else {
            Issue.record("Home missing: \(store.topLevelPages().map { store.title(of: $0.id) }) \(r)"); return
        }
        #expect(home.props.icon == .emoji("🏠"))
        let kids = store.visibleOrder(in: home.id).compactMap { store.blocks[$0] }
        #expect(kids.contains { $0.type == .todo && $0.props.checked == true && $0.text.plainText == "Done thing" }, "\(kids.map { ($0.type, $0.text.plainText) })")
        #expect(kids.contains { $0.type == .toggle && $0.text.plainText == "Toggle head" })
        #expect(kids.contains { $0.type == .code })
        #expect(store.subpages(of: home.id).contains { store.title(of: $0.id) == "Child" })
        guard let dune = store.blocks.values.first(where: { store.title(of: $0.id) == "Dune" }) else { Issue.record("Dune missing"); return }
        #expect(store.visibleOrder(in: dune.id).map { store.blocks[$0]!.text.plainText } == ["Spice must flow"])
    }

    @Test func unsupportedFileWarning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("zt-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent("notes.docx")
        try Data("x".utf8).write(to: f)
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let r = try NotionImporter(store: store, assets: nil).importItems([f])
        #expect(r.pages == 0)
        #expect(r.warnings.first?.contains("not a Markdown") == true)
    }
}

@Suite struct LogTests {
    @Test func ringBufferFilteringAndFile() throws {
        let log = Log(capacity: 10)
        log.minimumLevel = .debug
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("log-" + UUID().uuidString)
        log.configure(directory: dir, name: "test", maxFileBytes: 600, maxFiles: 3)
        for i in 0..<25 { log.log(i % 5 == 0 ? .warning : .info, "message \(i)", category: i % 2 == 0 ? "even" : "odd") }
        #expect(log.recent(limit: 100).count == 10)
        #expect(log.recent(limit: 100).last?.message == "message 24")
        #expect(log.recent(minLevel: .warning).map(\.message) == ["message 15", "message 20"])
        #expect(log.recent(category: "even").count == 5)
        #expect(log.recent(search: "message 2").map(\.message) == ["message 20", "message 21", "message 22", "message 23", "message 24"])
        log.flush()
        let files = log.logFiles
        #expect(files.count > 1, "rotation expected")
        #expect(files.count <= 3)
        let current = Log.read(file: files[0])
        #expect(current.last?.message == "message 24")
        #expect(current.last?.category == "even")
        log.breadcrumb("opened page")
        #expect(log.exportText().contains("opened page"))
    }

    @Test func minimumLevelSkipsWork() {
        let log = Log(capacity: 10)
        log.minimumLevel = .warning
        var evaluated = false
        log.log(.debug, { evaluated = true; return "x" }(), category: "c")
        #expect(!evaluated)
        #expect(log.recent().isEmpty)
    }
}

@MainActor
@Suite struct BacklinkIndexTests {
    @Test func backlinksFollowEdits() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let target = s.createPage(title: "Target")
        let a = s.createPage(title: "A")
        #expect(s.backlinks(to: target) == [])
        var t = RichText("see ")
        t.append(RichText(runs: [TextRun("Target", mention: .page(target))]))
        let blk = s.insertBlock(.text, text: "", in: .block(a))
        s.transact("mention") { tx in tx.update(blk) { $0.text = t } }
        #expect(s.backlinks(to: target) == [a])
        s.transact("clear") { tx in tx.update(blk) { $0.text = RichText("plain") } }
        #expect(s.backlinks(to: target) == [])
        s.undo()
        #expect(s.backlinks(to: target) == [a])
    }
}
