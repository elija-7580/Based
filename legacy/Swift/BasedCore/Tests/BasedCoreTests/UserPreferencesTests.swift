import Foundation
import Testing
@testable import BasedCore

/// BSD-71: start page and default style of new pages.
@MainActor
@Suite struct UserPreferencesTests {
    @Test func startTargetFollowsThePreference() {
        let ok: Set<RecordID> = ["a", "b", "c"]
        func t(_ pref: String?, last: RecordID?, fallback: RecordID? = "c") -> UserPreferences.StartTarget {
            UserPreferences.startTarget(pref: pref, lastPage: last, fallback: fallback, isOpenable: { ok.contains($0) })
        }
        #expect(t(nil, last: "a") == .page("a"))             // default "last"
        #expect(t("last", last: "b") == .page("b"))
        #expect(t("last", last: "gone") == .page("c"))       // deleted last page → first page
        #expect(t("last", last: nil, fallback: nil) == .home)
        #expect(t("home", last: "a") == .home)
        #expect(t("b", last: "a") == .page("b"))             // a fixed page
        #expect(t("gone", last: "a") == .page("a"))          // fixed page deleted → last visited
    }

    @Test func newPagesGetTheDefaultStyle() {
        #expect(UserPreferences.newPageFormat(font: "default", smallText: false, fullWidth: false) == nil)
        #expect(UserPreferences.newPageFormat(font: nil, smallText: false, fullWidth: false) == nil)
        #expect(UserPreferences.newPageFormat(font: "serif", smallText: false, fullWidth: true) == PageFormat(font: .serif, fullWidth: true))
        #expect(UserPreferences.newPageFormat(font: "unknown", smallText: true, fullWidth: false) == PageFormat(smallText: true))
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "up")
        let f = UserPreferences.newPageFormat(font: "mono", smallText: true, fullWidth: false)
        let p = s.createPage(format: f)
        #expect(s.blocks[p]?.props.format == PageFormat(font: .mono, smallText: true))
        let top = s.createTopLevelPage(in: .privatePages, format: f)
        #expect(s.blocks[top]?.props.format?.font == .mono)
        let plain = s.createPage()
        #expect(s.blocks[plain]?.props.format == nil)
        // Page and style are one undo step.
        s.undo()
        #expect(s.blocks[plain] == nil)
        s.undo()
        #expect(s.blocks[top] == nil && s.blocks[p] != nil)
    }
}
