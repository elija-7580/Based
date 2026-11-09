import Foundation
import Testing
@testable import BasedCore

/// BSD-40: mentions show current titles without reloading the editor on every render.
@MainActor
@Suite struct MentionTextTests {
    func fixture() -> (s: WorkspaceStore, target: RecordID, note: RecordID, para: RecordID) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "m")
        let target = s.createPage(title: "Roadmap")
        let note = s.createPage(title: "Notes")
        let text = RichText(runs: [TextRun("See "), TextRun("Roadmap", mention: .page(target)), TextRun(" today")])
        let para = s.insertBlock(.text, text: text, in: .block(note))
        return (s, target, note, para)
    }

    @Test func renamingTheTargetLeavesTheStoredTextAlone() {
        let f = fixture()
        let before = f.s.blocks[f.para]!.text
        f.s.setText(f.target, "Plan 2027")
        #expect(f.s.blocks[f.para]!.text == before)
        #expect(f.s.displayText(before).plainText == "See Plan 2027 today")
        #expect(f.s.plainTextResolvingMentions(before) == "See Plan 2027 today")
    }

    @Test func missingTargetsKeepTheStoredText() {
        let rt = RichText(runs: [TextRun("Old", mention: .page("gone"))])
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "m2")
        #expect(s.displayText(rt).plainText == "Old")
        #expect(RichText("plain").resolvingMentions { _ in "x" } == RichText("plain"))
    }

    @Test func searchFindsTheNewTitleNotTheOld() {
        let f = fixture()
        f.s.setText(f.target, "Masterplan")
        let engine = SearchEngine(store: f.s)
        #expect(engine.search("Masterplan").contains { $0.pageID == f.note })
        #expect(!engine.search("Roadmap").contains { $0.pageID == f.note })
    }

    @Test func databaseRowSearchUsesCurrentTitles() {
        let f = fixture()
        let db = f.s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        _ = f.s.addRow(to: db.databaseID, title: RichText(runs: [TextRun("Roadmap", mention: .page(f.target))]))
        f.s.setText(f.target, "Masterplan")
        let q = QueryEngine(store: f.s)
        let view = f.s.views[db.viewID]!
        #expect(q.run(view, search: "Masterplan").rows.count == 1)
        #expect(q.run(view, search: "Roadmap").rows.isEmpty)
    }

    @Test func markdownExportShowsTheCurrentTitle() {
        let f = fixture()
        f.s.setText(f.target, "Masterplan")
        let md = MarkdownExporter(store: f.s).export(page: f.note)
        #expect(md.contains("Masterplan"))
        #expect(!md.contains("[Roadmap]"))
    }

    // MARK: Reload policy

    @Test func noReloadWhenOnlyTheDisplayDiffers() {
        let stored = RichText(runs: [TextRun("Roadmap", mention: .page("p"))])
        let shown = RichText(runs: [TextRun("Plan", mention: .page("p"))])
        // Loaded from `stored`, view shows the new title: renders must not reload.
        #expect(!TextReloadPolicy.needsReload(text: stored, applied: shown, loadedSource: stored,
                                              mentions: { ["Plan"] }, loadedMentions: ["Plan"]))
    }

    @Test func reloadOnceWhenAMentionDisplaysDifferently() {
        let stored = RichText(runs: [TextRun("Roadmap", mention: .page("p"))])
        #expect(TextReloadPolicy.needsReload(text: stored, applied: stored, loadedSource: stored,
                                             mentions: { ["Plan"] }, loadedMentions: ["Roadmap"]))
    }

    @Test func reloadWhenChangedElsewhere() {
        let a = RichText("a"), b = RichText("b")
        #expect(TextReloadPolicy.needsReload(text: b, applied: a, loadedSource: a, mentions: { [] }, loadedMentions: []))
        // Own edit written back: no reload.
        #expect(!TextReloadPolicy.needsReload(text: b, applied: b, loadedSource: a, mentions: { [] }, loadedMentions: []))
    }

    @Test func plainTextSkipsMentionWork() {
        var called = false
        let t = RichText("x")
        #expect(!TextReloadPolicy.needsReload(text: t, applied: t, loadedSource: t,
                                              mentions: { called = true; return [] }, loadedMentions: []))
        #expect(!called)
    }
}
