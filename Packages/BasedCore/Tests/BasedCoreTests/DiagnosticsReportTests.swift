import XCTest
@testable import BasedCore

final class DiagnosticsReportTests: XCTestCase {
    func entry(_ id: UInt64, _ level: LogLevel, _ cat: String, _ msg: String, _ md: [String: String]? = nil) -> LogEntry {
        LogEntry(id: id, date: Date(timeIntervalSince1970: 1_780_000_000 + Double(id)), level: level, category: cat, message: msg, metadata: md, thread: nil)
    }

    func testReportSectionsAndCompactLines() {
        var r = DiagnosticReport()
        r.created = Date(timeIntervalSince1970: 1_780_000_000)
        r.facts = [.init("App", "Based 0.1.0 (1) · debug build"), .init("Workspace", "53086 blocks · 221 databases")]
        r.previousRun = .init(summary: "Frozen for 14 s, then force-quit", breadcrumbs: ["15:31:23.100 navigate → Meeting"],
                              hangFrames: ["Based.debug.dylib  WorkspaceStore.backlinks(to:) + 12"],
                              logTail: [entry(1, .warning, "store", "Store observers took 80 ms")])
        let frames = [StackFrame(address: 0x1000, image: "libsystem_kernel.dylib", symbol: "mach_msg2_trap", offset: 8),
                      StackFrame(address: 0x2000, image: "Based.debug.dylib", symbol: "BasedCore.WorkspaceStore.recentPages(limit: Int)", offset: 120)]
        r.hangs = [.init(date: Date(timeIntervalSince1970: 1_780_000_100), milliseconds: 524, breadcrumbs: ["15:35:29.517 navigate → Getting Started"], frames: frames, samples: 1)]
        r.breadcrumbs = ["15:35:29.517 navigate → Getting Started"]
        r.entries = [entry(2, .warning, "hang", "Hang: main thread blocked 524 ms", ["ms": "524", "breadcrumbs": "a | b | c"])]
        r.entriesNote = "last 1 entries"
        let text = r.render()
        XCTAssertTrue(text.hasPrefix("Based diagnostic report — "))
        XCTAssertTrue(text.contains("App           Based 0.1.0 (1) · debug build") || text.contains("App  "), text)
        XCTAssertTrue(text.contains("PREVIOUS RUN\n  Frozen for 14 s, then force-quit"))
        XCTAssertTrue(text.contains("Main thread at the time:"))
        XCTAssertTrue(text.contains("15:31:23.100 navigate → Meeting"))
        XCTAssertTrue(text.contains("HANGS (1 this session, longest 524 ms"))
        XCTAssertTrue(text.contains("524 ms  after: navigate → Getting Started"))
        XCTAssertTrue(text.contains("in: BasedCore.WorkspaceStore.recentPages(limit: Int)"), text)
        XCTAssertTrue(text.contains(" 1  Based.debug.dylib"), text)
        XCTAssertTrue(text.contains("LOG (last 1 entries)"))
        // Redundant breadcrumbs metadata is dropped from log lines, other metadata kept.
        let hangLine = text.split(separator: "\n").first { $0.contains("Hang: main thread blocked") }!
        XCTAssertFalse(hangLine.contains("breadcrumbs="))
        XCTAssertTrue(hangLine.contains("ms=524"))
        XCTAssertFalse(hangLine.contains("2026-"), "compact lines carry the time only")
    }

    func testEmptyReport() {
        let text = DiagnosticReport().render()
        XCTAssertTrue(text.contains("HANGS: none this session"))
        XCTAssertTrue(text.contains("(no entries)"))
        XCTAssertFalse(text.contains("PREVIOUS RUN"))
    }

    func testDemangleAndSimplify() {
        let d = StackSymbols.demangle("$s9BasedCore14WorkspaceStoreC9backlinks2toSaySSGSS_tF")
        XCTAssertEqual(d, "BasedCore.WorkspaceStore.backlinks(to: Swift.String) -> Swift.Array<Swift.String>")
        XCTAssertEqual(StackSymbols.simplify(d), "BasedCore.WorkspaceStore.backlinks(to: String)")
        XCTAssertEqual(StackSymbols.demangle("_$s9BasedCore14WorkspaceStoreC9backlinks2toSaySSGSS_tF"), d)
        XCTAssertEqual(StackSymbols.demangle("objc_msgSend"), "objc_msgSend")
        XCTAssertEqual(StackSymbols.simplify("closure #1 () -> () in Based.AppModel.open(_: Swift.String) -> ()"),
                       "closure #1 () -> () in Based.AppModel.open(_: String)")
        XCTAssertEqual(StackSymbols.simplify("-[NSView layout]"), "-[NSView layout]")
        let f = StackFrame(address: 0x10, image: "Based.debug.dylib", symbol: "x", offset: 1)
        XCTAssertTrue(f.isAppCode)
        XCTAssertFalse(StackFrame(address: 0x10, image: "SwiftUI", symbol: "y", offset: 1).isAppCode)
        XCTAssertTrue(StackFrame(address: 0x10, image: "SwiftUI", symbol: "closure #1 in BasedCore.X.y()", offset: 1).isAppCode)
        XCTAssertEqual(StackSymbols.culprit([StackFrame(address: 1, image: "libsystem_kernel.dylib", symbol: "a", offset: 0), f]), f)
    }

    func testSamplerIsSafeEverywhere() {
        // On Linux the sampler is unavailable and returns nothing; on Apple platforms it must not sample the caller.
        XCTAssertTrue(MainThreadSampler.sample().isEmpty || !Thread.isMainThread)
        XCTAssertEqual(StackSymbols.symbolicate([]).count, 0)
        XCTAssertEqual(StackSymbols.symbolicate([0x1234]).count, 1)
        _ = DebuggerCheck.isAttached
    }

    func testPreviousSessionTail() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("logtail-\(UUID().uuidString)")
        let a = Log(capacity: 100)
        a.configure(directory: dir, name: "t")
        for i in 0..<120 { a.log(.info, "line \(i)", category: "test") }
        a.flush()
        let b = Log(capacity: 100)
        b.configure(directory: dir, name: "t")
        let tail = b.previousSessionTail
        XCTAssertEqual(tail.count, 80)
        XCTAssertEqual(tail.last?.message, "line 119")
        XCTAssertEqual(tail.first?.message, "line 40")
        // Tail reading starts mid-file without decoding a partial line.
        let small = Log.readTail(of: dir.appendingPathComponent("t.log"), limit: 5, maxBytes: 300)
        XCTAssertFalse(small.isEmpty)
        XCTAssertEqual(small.last?.message, "line 119")
        try? FileManager.default.removeItem(at: dir)
    }
}

@MainActor
final class PageListPerfTests: XCTestCase {
    func testRecentPagesCacheInvalidatesOnChange() {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let a = s.createPage(title: "A")
        let b = s.createPage(title: "B")
        let first = s.recentPages(limit: 5).map(\.id)
        XCTAssertTrue(first.contains(a) && first.contains(b))
        XCTAssertEqual(s.recentPages(limit: 5).map(\.id), first, "served from cache")
        let c = s.createPage(title: "C")
        XCTAssertEqual(s.recentPages(limit: 1).first?.id, c)
        s.trash([c])
        XCTAssertFalse(s.recentPages(limit: 5).map(\.id).contains(c))
        XCTAssertFalse(s.allPages().map(\.id).contains(c))
        let child = s.createPage(title: "Child", in: .block(a))
        XCTAssertTrue(s.allPages().map(\.id).contains(child))
        s.trash([a])
        XCTAssertFalse(s.recentPages(limit: 10).map(\.id).contains(child), "pages under a trashed parent are excluded")
        XCTAssertFalse(s.allPages().map(\.id).contains(child))
    }

    func testBacklinkIndexBuildsInBackground() async throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let target = s.createPage(title: "Target")
        let src = s.createPage(title: "Source")
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("see "), TextRun("Target", mention: .page(target))]), in: .block(src))
        s.prepareLinkIndexInBackground()
        // A change while the index is being built is picked up on install.
        let late = s.createPage(title: "Late")
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("Target", mention: .page(target))]), in: .block(late))
        for _ in 0..<200 where !s.isLinkIndexReady { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(s.isLinkIndexReady)
        XCTAssertEqual(Set(s.backlinks(to: target)), [src, late])
    }
}
