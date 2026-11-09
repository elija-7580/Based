import Foundation
import Testing
@testable import BasedCore

/// BSD-67: exports carry their images/files, never overwrite a page with another of the same name, report
/// what went wrong; the workspace archive v2 (.based.zip) carries asset bytes and v1 stays readable.
@MainActor
struct WorkspaceExporterTests {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("bsd67-" + UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    func read(_ root: URL, _ path: String) -> String? {
        try? String(contentsOf: ExportPlan.url(root, path), encoding: .utf8)
    }

    @discardableResult
    func image(_ s: WorkspaceStore, _ assets: FileAssetStore, on page: RecordID, name: String, bytes: String) throws -> AssetRef {
        let ref = try assets.importData(Data(bytes.utf8), name: name, mime: nil)
        var p = BlockProps(); p.asset = ref
        s.insertBlock(.image, text: "", props: p, in: .block(page))
        return ref
    }

    @Test func assetsAreCopiedAndLinkedRelatively() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let assets = FileAssetStore(root: tempDir())
        let trip = s.createPage(title: "Trip")
        try image(s, assets, on: trip, name: "photo.png", bytes: "PNG-A")
        let day = s.createPage(title: "Day 1", in: .block(trip))
        try image(s, assets, on: day, name: "photo.png", bytes: "PNG-B")   // same name, other file
        var f = BlockProps(); f.asset = try assets.importData(Data("PDF".utf8), name: "Plan.pdf", mime: nil)
        s.insertBlock(.file, text: "", props: f, in: .block(day))

        for format in [WorkspaceExporter.Format.markdown, .html] {
            let out = tempDir()
            let report = WorkspaceExporter(store: s, assets: assets).export([s.blocks[trip]!], format: format, to: out)
            #expect(report.failures.isEmpty, "\(report.failures)")
            #expect(report.pages == 2 && report.assets == 3)
            let ext = format == .html ? "html" : "md"
            let top = try #require(read(out, "Trip.\(ext)"))
            let sub = try #require(read(out, "Trip/Day 1.\(ext)"))
            #expect(top.contains("assets/photo.png"))
            #expect(!top.contains("../assets"))
            #expect(sub.contains("../assets/photo%20%282%29.png"), "the second photo gets its own name, linked from the sub-folder")
            #expect(sub.contains("../assets/Plan.pdf"))
            #expect(top.contains("Trip/Day%201.\(ext)"), "link to the sub-page file")
            #expect(read(out, "assets/photo.png") == "PNG-A")
            #expect(read(out, "assets/photo (2).png") == "PNG-B")
            #expect(read(out, "assets/Plan.pdf") == "PDF")
        }
    }

    @Test func sameNamedPagesNeverOverwriteEachOther() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let a = s.createPage(title: "Notes")
        let b = s.createPage(title: "notes")          // differs only in case (APFS is case-insensitive)
        let c = s.createPage(title: "Notes")
        s.insertBlock(.text, text: "first", in: .block(a))
        s.insertBlock(.text, text: "second", in: .block(b))
        s.insertBlock(.text, text: "third", in: .block(c))
        _ = s.createPage(title: "Child", in: .block(b))
        _ = s.createPage(title: "Child", in: .block(c))
        // A link to the third page must point at its renamed file.
        var link = BlockProps(); link.linkTarget = c
        s.insertBlock(.linkToPage, text: "", props: link, in: .block(a))
        let assetsPage = s.createPage(title: "assets")  // must not mix with the attachment folder
        _ = s.createPage(title: "Inside", in: .block(assetsPage))

        let out = tempDir()
        let report = WorkspaceExporter(store: s, assets: nil).export(s.topLevelPages(), format: .markdown, to: out)
        #expect(report.failures.isEmpty)
        #expect(report.pages == 7)
        #expect(read(out, "Notes.md")?.contains("first") == true)
        #expect(read(out, "notes (2).md")?.contains("second") == true)
        #expect(read(out, "Notes (3).md")?.contains("third") == true)
        #expect(read(out, "notes (2)/Child.md") != nil)
        #expect(read(out, "Notes (3)/Child.md") != nil)
        #expect(read(out, "Notes.md")?.contains("](Notes%20%283%29.md)") == true)
        #expect(read(out, "assets (2)/Inside.md") != nil)
    }

    @Test func problemsAreReportedAndTheRestIsWritten() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let assets = FileAssetStore(root: tempDir())
        let page = s.createPage(title: "Album")
        let ref = try image(s, assets, on: page, name: "gone.jpg", bytes: "x")
        assets.delete(ref)                               // e.g. not downloaded from iCloud yet
        let blocked = s.createPage(title: "Blocked")
        _ = s.createPage(title: "Kid", in: .block(blocked))
        let out = tempDir()
        // A plain file where the "Blocked" folder has to go: its child can't be written.
        try Data("in the way".utf8).write(to: out.appendingPathComponent("Blocked"))

        let report = WorkspaceExporter(store: s, assets: assets).export(s.topLevelPages(), format: .markdown, to: out)
        #expect(report.pages == 2, "Album.md and Blocked.md are still written")
        #expect(report.failures.contains { $0.path == "assets/gone.jpg" && $0.message.contains("isn't on this device") })
        #expect(report.failures.contains { $0.path == "Blocked/Kid.md" })
        #expect(report.summary.contains("problem"))
        #expect(read(out, "Album.md")?.contains("assets/gone.jpg") == true)
    }

    @Test func pathHelpers() {
        #expect(ExportPlan.relative(from: "", to: "a.md") == "a.md")
        #expect(ExportPlan.relative(from: "A/B", to: "A/C/x.md") == "../C/x.md")
        #expect(ExportPlan.relative(from: "A", to: "assets/p.png") == "../assets/p.png")
        #expect(ExportPlan.relative(from: "A", to: "A/B/x.md") == "B/x.md")
        #expect(ExportPlan.encode("Notes (2)/a b.md") == "Notes%20%282%29/a%20b.md")
        var used: Set<String> = []
        #expect(ExportPlan.uniqueName("photo", ext: "png", in: &used) == "photo.png")
        #expect(ExportPlan.uniqueName("Photo", ext: "PNG", in: &used) == "Photo (2).PNG")
    }

    // MARK: Archive v2

    @Test func archivePackageRoundTripsAssetBytes() throws {
        let a = WorkspaceStore(persistence: nil, node: "a")
        let assetsA = FileAssetStore(root: tempDir())
        let page = a.createPage(title: "Trip")
        let img = try image(a, assetsA, on: page, name: "photo.png", bytes: "PNG-BYTES")
        let icon = try assetsA.importData(Data("ICON".utf8), name: "icon.png", mime: nil)
        a.setPageIcon(page, .asset(icon))
        let cover = try assetsA.importData(Data("COVER".utf8), name: "cover.jpg", mime: nil)
        a.setPageCover(page, .asset(cover))
        let missing = try image(a, assetsA, on: page, name: "later.png", bytes: "?")
        assetsA.delete(missing)

        let refs = Set(WorkspaceArchive.assetRefs(in: a.allRecords()).map(\.id))
        #expect(refs == [img.id, icon.id, cover.id, missing.id], "block, icon and cover assets are all found")

        let zipURL = tempDir().appendingPathComponent("Based Workspace.based.zip")
        let result = try WorkspaceArchive.package(a, assets: assetsA).write(to: zipURL)
        #expect(result.assets == 3)
        #expect(result.missing.map(\.id) == [missing.id])
        #expect(WorkspaceArchive.isArchive(zipURL))
        let zip = try ZipArchive(url: zipURL)
        #expect(zip.entries.first?.path == WorkspaceArchive.packageRecords)
        #expect(zip.entries.contains { $0.path == "assets/\(img.id)/photo.png" })

        let rootB = tempDir()
        let loaded = try WorkspaceArchive.load(zipURL, assetsRoot: rootB)
        #expect(loaded.read.header?.version == 2)
        #expect(loaded.read.header?.assets == 4)
        #expect(loaded.assetsRestored == 3 && loaded.assetFailures.isEmpty)
        let b = WorkspaceStore(persistence: nil, node: "b")
        let r = try WorkspaceArchive.importRecords(loaded.read, into: b)
        #expect(r.skipped == 0)
        for rec in a.allRecords() where rec.key.kind != .workspace { #expect(b.record(rec.key) == rec) }
        let assetsB = FileAssetStore(root: rootB)
        #expect(try Data(contentsOf: #require(assetsB.url(for: img))) == Data("PNG-BYTES".utf8))
        #expect(try Data(contentsOf: #require(assetsB.url(for: cover))) == Data("COVER".utf8))
        #expect(!assetsB.contains(missing))
    }

    @Test func version1ArchivesStayReadable() throws {
        // A v1 file exactly as builds before BSD-67 wrote it (no "assets" in the header).
        let a = WorkspaceStore(persistence: nil, node: "a")
        let page = a.createPage(title: "Old")
        a.insertBlock(.text, text: "still here", in: .block(page))
        let v1 = try WorkspaceArchive.write(a)
        let headerLine = String(decoding: v1.prefix { $0 != 0x0A }, as: UTF8.self)
        #expect(headerLine.contains("\"version\":1"))
        #expect(!headerLine.contains("assets"))
        let legacy = Data(#"{"exportedAt":"2026-10-01T10:00:00Z","format":"based-archive","records":0,"version":1}"#.utf8)
        #expect(try WorkspaceArchive.read(legacy).header?.version == 1)

        let url = tempDir().appendingPathComponent("Based Workspace.based.jsonl")
        try v1.write(to: url)
        #expect(WorkspaceArchive.isArchive(url))
        let loaded = try WorkspaceArchive.load(url, assetsRoot: tempDir())
        let b = WorkspaceStore(persistence: nil, node: "b")
        try WorkspaceArchive.importRecords(loaded.read, into: b)
        #expect(b.title(of: page) == "Old")
        #expect(b.contentBlocks(of: page).first?.text.plainText == "still here")

        // A newer format than this build knows is refused, not half-imported.
        let v3 = Data(#"{"exportedAt":"2026-10-01T10:00:00Z","format":"based-archive","records":0,"version":3}"#.utf8)
        #expect(throws: WorkspaceArchive.ArchiveError.self) { try WorkspaceArchive.read(v3) }
    }

    @Test func packageEntriesCannotEscapeTheAssetFolder() throws {
        #expect(WorkspaceArchive.assetRef(forEntry: "assets/abc-1/photo.png")?.name == "photo.png")
        #expect(WorkspaceArchive.assetRef(forEntry: "assets/../evil") == nil)
        #expect(WorkspaceArchive.assetRef(forEntry: "assets/abc/../../evil") == nil)
        #expect(WorkspaceArchive.assetRef(forEntry: "assets/abc/..") == nil)
        #expect(WorkspaceArchive.assetRef(forEntry: "assets/a.b/x") == nil)
        #expect(WorkspaceArchive.assetRef(forEntry: "other/abc/x") == nil)

        // A zip with a hostile entry: the entry is reported and nothing lands outside the asset root.
        let dir = tempDir()
        let zipURL = dir.appendingPathComponent("evil.based.zip")
        let w = try ZipWriter(url: zipURL)
        try w.add(path: WorkspaceArchive.packageRecords, data: Data(#"{"exportedAt":"2026-10-01T10:00:00Z","format":"based-archive","records":0,"version":2}"#.utf8))
        try w.add(path: "assets/x/../../../escaped.txt", data: Data("bad".utf8))
        try w.finish()
        let root = dir.appendingPathComponent("Assets", isDirectory: true)
        let loaded = try WorkspaceArchive.load(zipURL, assetsRoot: root)
        #expect(loaded.assetFailures.count == 1)
        #expect(!FileManager.default.fileExists(atPath: dir.deletingLastPathComponent().appendingPathComponent("escaped.txt").path))

        // A zip that isn't a Based package is not taken for one.
        let other = dir.appendingPathComponent("other.zip")
        let o = try ZipWriter(url: other)
        try o.add(path: "readme.txt", data: Data("hi".utf8))
        try o.finish()
        #expect(!WorkspaceArchive.isArchive(other))
        #expect(throws: WorkspaceArchive.ArchiveError.self) { try WorkspaceArchive.load(other, assetsRoot: root) }
    }
}
