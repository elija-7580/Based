import Foundation
import Testing
@testable import BasedCore

@Suite struct DiagnosticsReportTests {
    func entry(_ id: UInt64, _ level: LogLevel, _ cat: String, _ msg: String, _ md: [String: String]? = nil) -> LogEntry {
        LogEntry(id: id, date: Date(timeIntervalSince1970: 1_780_000_000 + Double(id)), level: level, category: cat, message: msg, metadata: md, thread: nil)
    }

    @Test func reportSectionsAndCompactLines() {
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
        #expect(text.hasPrefix("Based diagnostic report — "))
        #expect(text.contains("App           Based 0.1.0 (1) · debug build") || text.contains("App  "), Comment(rawValue: text))
        #expect(text.contains("PREVIOUS RUN\n  Frozen for 14 s, then force-quit"))
        #expect(text.contains("Main thread at the time:"))
        #expect(text.contains("15:31:23.100 navigate → Meeting"))
        #expect(text.contains("HANGS (1 this session, longest 524 ms"))
        #expect(text.contains("524 ms  after: navigate → Getting Started"))
        #expect(text.contains("in: BasedCore.WorkspaceStore.recentPages(limit: Int)"), Comment(rawValue: text))
        #expect(text.contains(" 1  Based.debug.dylib"), Comment(rawValue: text))
        #expect(text.contains("LOG (last 1 entries)"))
        // Redundant breadcrumbs metadata is dropped from log lines, other metadata kept.
        let hangLine = text.split(separator: "\n").first { $0.contains("Hang: main thread blocked") }!
        #expect(!hangLine.contains("breadcrumbs="))
        #expect(hangLine.contains("ms=524"))
        #expect(!hangLine.contains("2026-"), "compact lines carry the time only")
    }

    @Test func emptyReport() {
        let text = DiagnosticReport().render()
        #expect(text.contains("HANGS: none this session"))
        #expect(text.contains("(no entries)"))
        #expect(!text.contains("PREVIOUS RUN"))
    }

    @Test func demangleAndSimplify() {
        let d = StackSymbols.demangle("$s9BasedCore14WorkspaceStoreC9backlinks2toSaySSGSS_tF")
        #expect(d == "BasedCore.WorkspaceStore.backlinks(to: Swift.String) -> Swift.Array<Swift.String>")
        #expect(StackSymbols.simplify(d) == "BasedCore.WorkspaceStore.backlinks(to: String)")
        #expect(StackSymbols.demangle("_$s9BasedCore14WorkspaceStoreC9backlinks2toSaySSGSS_tF") == d)
        #expect(StackSymbols.demangle("objc_msgSend") == "objc_msgSend")
        #expect(StackSymbols.simplify("closure #1 () -> () in Based.AppModel.open(_: Swift.String) -> ()") == "closure #1 () -> () in Based.AppModel.open(_: String)")
        #expect(StackSymbols.simplify("-[NSView layout]") == "-[NSView layout]")
        let f = StackFrame(address: 0x10, image: "Based.debug.dylib", symbol: "x", offset: 1)
        #expect(f.isAppCode)
        #expect(!(StackFrame(address: 0x10, image: "SwiftUI", symbol: "y", offset: 1).isAppCode))
        #expect(StackFrame(address: 0x10, image: "SwiftUI", symbol: "closure #1 in BasedCore.X.y()", offset: 1).isAppCode)
        #expect(StackSymbols.culprit([StackFrame(address: 1, image: "libsystem_kernel.dylib", symbol: "a", offset: 0), f]) == f)
    }

    @Test func samplerIsSafeEverywhere() {
        // On Linux the sampler is unavailable and returns nothing; on Apple platforms it must not sample the caller.
        #expect(MainThreadSampler.sample().isEmpty || !Thread.isMainThread)
        #expect(StackSymbols.symbolicate([]).count == 0)
        #expect(StackSymbols.symbolicate([0x1234]).count == 1)
        _ = DebuggerCheck.isAttached
    }

    @Test func previousSessionTail() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("logtail-\(UUID().uuidString)")
        let a = Log(capacity: 100)
        a.configure(directory: dir, name: "t")
        for i in 0..<120 { a.log(.info, "line \(i)", category: "test") }
        a.flush()
        let b = Log(capacity: 100)
        b.configure(directory: dir, name: "t")
        let tail = b.previousSessionTail
        #expect(tail.count == 80)
        #expect(tail.last?.message == "line 119")
        #expect(tail.first?.message == "line 40")
        // Tail reading starts mid-file without decoding a partial line.
        let small = Log.readTail(of: dir.appendingPathComponent("t.log"), limit: 5, maxBytes: 300)
        #expect(!small.isEmpty)
        #expect(small.last?.message == "line 119")
        try? FileManager.default.removeItem(at: dir)
    }
}

@MainActor
@Suite struct PageListPerfTests {
    @Test func recentPagesCacheInvalidatesOnChange() {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let a = s.createPage(title: "A")
        let b = s.createPage(title: "B")
        let first = s.recentPages(limit: 5).map(\.id)
        #expect(first.contains(a) && first.contains(b))
        #expect(s.recentPages(limit: 5).map(\.id) == first, "served from cache")
        let c = s.createPage(title: "C")
        #expect(s.recentPages(limit: 1).first?.id == c)
        s.trash([c])
        #expect(!s.recentPages(limit: 5).map(\.id).contains(c))
        #expect(!s.allPages().map(\.id).contains(c))
        let child = s.createPage(title: "Child", in: .block(a))
        #expect(s.allPages().map(\.id).contains(child))
        s.trash([a])
        #expect(!s.recentPages(limit: 10).map(\.id).contains(child), "pages under a trashed parent are excluded")
        #expect(!s.allPages().map(\.id).contains(child))
    }

    @Test func backlinkIndexBuildsInBackground() async throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let target = s.createPage(title: "Target")
        let src = s.createPage(title: "Source")
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("see "), TextRun("Target", mention: .page(target))]), in: .block(src))
        s.prepareLinkIndexInBackground()
        // A change while the index is being built is picked up on install.
        let late = s.createPage(title: "Late")
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("Target", mention: .page(target))]), in: .block(late))
        for _ in 0..<200 where !s.isLinkIndexReady { try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(s.isLinkIndexReady)
        #expect(Set(s.backlinks(to: target)) == [src, late])
    }
}
