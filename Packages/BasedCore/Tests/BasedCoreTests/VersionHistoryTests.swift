import Foundation
import Testing
@testable import BasedCore

@MainActor
struct VersionHistoryTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    @Test func unchangedBlocksAreSharedAndNoOpSnapshotsSkipped() throws {
        let s = store()
        let h = try VersionHistory(url: nil)
        let page = s.createPage(title: "Notes")
        var ids: [RecordID] = []
        for i in 0..<50 { ids.append(s.insertBlock(.text, text: RichText("Paragraph \(i) with some words"), in: .block(page))) }

        let v1 = h.record(page: page, blocks: s.versionBlocks(of: page), title: "Notes")
        #expect(v1?.blockCount == 50)
        #expect(h.record(page: page, blocks: s.versionBlocks(of: page), title: "Notes") == nil)   // nothing changed

        let before = h.stats().objects
        s.setText(ids[7], RichText("Changed paragraph"))
        let v2 = h.record(page: page, blocks: s.versionBlocks(of: page), title: "Notes")
        #expect(v2 != nil)
        // One new block object + one new manifest; the 49 unchanged blocks are shared.
        #expect(h.stats().objects == before + 2)
        #expect(h.versions(of: page).map(\.id) == [v2!.id, v1!.id])
    }

    @Test func restoreBringsBackDeletedAndRemovesAddedBlocks() throws {
        let s = store()
        let h = try VersionHistory(url: nil)
        let page = s.createPage(title: "Draft")
        let a = s.insertBlock(.text, text: RichText("First"), in: .block(page))
        let toggle = s.insertBlock(.toggle, text: RichText("Toggle"), in: .block(page))
        let inner = s.insertBlock(.text, text: RichText("Inside"), in: .block(toggle))
        let sub = s.createPage(title: "Sub", in: .block(page))
        let v = try #require(h.record(page: page, blocks: s.versionBlocks(of: page), title: "Draft"))

        s.setText(a, RichText("Rewritten"))
        s.deleteBlocks([toggle])
        let added = s.insertBlock(.text, text: RichText("New"), in: .block(page))
        s.renamePage(sub, to: "Sub renamed")

        s.restoreVersion(of: page, blocks: h.blocks(of: v))
        #expect(s.blocks[a]?.text.plainText == "First")
        #expect(s.blocks[inner]?.text.plainText == "Inside")
        #expect(s.blocks[inner]?.parent == .block(toggle))
        #expect(s.blocks[added] == nil)
        #expect(s.title(of: sub) == "Sub renamed")   // sub-pages keep their own state
        s.undo()
        #expect(s.blocks[a]?.text.plainText == "Rewritten")
        #expect(s.blocks[added] != nil)
    }

    @Test func pruneThinsOldVersionsAndGarbageCollects() throws {
        let s = store()
        let h = try VersionHistory(url: nil)
        let page = s.createPage(title: "Log")
        let b = s.insertBlock(.text, text: RichText("0"), in: .block(page))
        let now = Date()
        // 30 versions, 10 minutes apart, 3 days ago (same few hours) + one recent.
        for i in 0..<30 {
            s.setText(b, RichText("v\(i)"))
            h.record(page: page, blocks: s.versionBlocks(of: page), title: "Log", at: now.addingTimeInterval(-3 * 86_400 + Double(i) * 600))
        }
        s.setText(b, RichText("latest"))
        h.record(page: page, blocks: s.versionBlocks(of: page), title: "Log", at: now)
        let removed = h.prune(now: now)
        #expect(removed > 20)
        #expect(h.versions(of: page).count == 31 - removed)
        #expect(h.collectGarbage() > 0)
        // Every remaining version still decodes.
        for v in h.versions(of: page) { #expect(h.blocks(of: v).count == 2) }
    }

    @Test func compressionRoundTrip() {
        let d = Data(String(repeating: "hello block ", count: 50).utf8)
        #expect(VersionHistory.decompress(VersionHistory.compress(d)) == d)
        #expect(VersionHistory.hash(d) != VersionHistory.hash(d + Data([0])))
        #expect(VersionHistory.hash(d).count == 32)
    }
}
