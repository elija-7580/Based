import Foundation
import Testing
@testable import BasedCore

/// BSD-32: re-importing from Notion never overwrites what was changed in Based and never hard-deletes local work.
@MainActor
@Suite struct ReimportProtectionTests {
    let page: RecordID = "11111111-0000-0000-0000-000000000001"
    let sub: RecordID = "11111111-0000-0000-0000-000000000002"
    func id(_ n: Int) -> RecordID { "22222222-0000-0000-0000-" + String(format: "%012d", n) }

    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    /// A page with paragraphs `texts` (id n → text) and, optionally, a sub-page; the page's content is complete.
    func source(_ texts: [Int: String], subPage: Bool = true, nested: [Int: [Int: String]] = [:]) -> ImportBuilder {
        let b = ImportBuilder()
        b.add(Block(id: page, type: .page, parent: .workspace, sortKey: "", text: "Notes"), root: true)
        for n in texts.keys.sorted() {
            b.append(.text, in: .block(page), id: id(n), text: RichText(texts[n]!))
            for (m, t) in (nested[n] ?? [:]).sorted(by: { $0.key < $1.key }) {
                b.append(.text, in: .block(id(n)), id: id(m), text: RichText(t))
            }
            b.markComplete(.block(id(n)))
        }
        if subPage { b.append(.page, in: .block(page), id: sub, text: "Sub") }
        b.markComplete(.block(page))
        return b
    }

    func text(_ s: WorkspaceStore, _ n: Int) -> String? { s.blocks[id(n)]?.text.plainText }

    @Test func importStoresAFingerprintThatSurvivesEncoding() throws {
        let s = store()
        s.commitImport(source([1: "a"]))
        let b = try #require(s.blocks[id(1)])
        #expect(b.importFingerprint == b.contentFingerprint)
        #expect(!b.changedSinceImport)
        let back = try JSONDecoder().decode(Block.self, from: JSONEncoder().encode(b))
        #expect(back.importFingerprint == b.importFingerprint && !back.changedSinceImport)
        // Moving a block or touching timestamps is not a content change.
        var moved = b; moved.sortKey = "zz"; moved.updatedAt = Date(); moved.updatedBy = "someone"
        #expect(!moved.changedSinceImport)
    }

    @Test func unchangedBlocksAreOverwritten() {
        let s = store()
        s.commitImport(source([1: "a", 2: "b"]))
        let r = s.commitImport(source([1: "a2", 2: "b2"]))
        #expect(text(s, 1) == "a2" && text(s, 2) == "b2")
        #expect(r.keptLocalChanges == 0 && r.keptLocalAdditions == 0)
        #expect(s.blocks[id(1)]?.changedSinceImport == false, "fingerprint follows the new import")
    }

    @Test func locallyChangedBlockIsKept() {
        let s = store()
        s.commitImport(source([1: "a", 2: "b"]))
        s.setText(id(1), "edited in Based")
        let r = s.commitImport(source([1: "changed in Notion", 2: "b2"]))
        #expect(text(s, 1) == "edited in Based")
        #expect(text(s, 2) == "b2")
        #expect(r.keptLocalChanges == 1)
        #expect(r.warnings.contains { $0.contains("changed in Based") })
        // Still protected on the next import.
        s.commitImport(source([1: "again", 2: "b3"]))
        #expect(text(s, 1) == "edited in Based" && text(s, 2) == "b3")
    }

    @Test func locallyAddedBlocksStay() {
        let s = store()
        s.commitImport(source([1: "a"]))
        let mine = s.insertBlock(.text, text: "my own note", in: .block(page))
        let child = s.insertBlock(.text, text: "nested note", in: .block(id(1)))
        let r = s.commitImport(source([1: "a2"]))
        #expect(s.blocks[mine]?.text.plainText == "my own note")
        #expect(s.blocks[child]?.parent == .block(id(1)))
        #expect(text(s, 1) == "a2")
        #expect(r.keptLocalAdditions == 2)
    }

    @Test func deletedInNotionGoesAwayOnlyWhenUntouched() {
        let s = store()
        s.commitImport(source([1: "a", 2: "b", 3: "c", 4: "d"], nested: [4: [5: "inside d"]]))
        s.setText(id(2), "edited b")                                  // changed locally
        let note = s.insertBlock(.text, text: "mine", in: .block(id(4)))  // local child of an imported block
        let r = s.commitImport(source([1: "a"], subPage: false))
        #expect(s.blocks[id(3)] == nil, "unchanged imported block removed with the source")
        #expect(text(s, 2) == "edited b", "local edit survives the deletion in Notion")
        #expect(s.blocks[id(4)] != nil && s.blocks[note] != nil && text(s, 5) == "inside d",
                "a block holding local content stays with all of it")
        // Pages only go to the Trash.
        #expect(s.blocks[sub]?.trashedAt != nil)
        #expect(r.keptLocalChanges == 2)   // id 2 itself, id 4 because of the local child
    }

    @Test func removedBlockRescuesNestedPagesToTheTrash() {
        let s = store()
        let b = source([1: "a", 2: "toggle"], subPage: false)
        b.append(.page, in: .block(id(2)), id: sub, text: "Inside toggle")
        s.commitImport(b)
        s.commitImport(source([1: "a"], subPage: false))
        #expect(s.blocks[id(2)] == nil)
        #expect(s.blocks[sub]?.trashedAt != nil, "nested page is in the Trash, not deleted")
    }

    @Test func blocksFromOlderImportsWithoutFingerprintBehaveAsBefore() {
        let s = store()
        s.commitImport(source([1: "a", 2: "b"]))
        // Simulate data written before BSD-32.
        s.transact("strip", undoable: false) { tx in
            for n in [1, 2] { tx.update(id(n)) { $0.extra[Block.importFingerprintKey] = nil } }
        }
        #expect(s.blocks[id(1)]?.importFingerprint == nil)
        s.commitImport(source([1: "a2"], subPage: true))
        #expect(text(s, 1) == "a2", "still in the source → updated as before")
        #expect(text(s, 2) == "b", "gone from the source but can't be told from a local block → kept")
        #expect(s.blocks[id(1)]?.importFingerprint != nil, "fingerprinted from now on")
    }

    @Test func reimportIsOneUndoStep() {
        let s = store()
        s.commitImport(source([1: "a"]))
        s.commitImport(source([1: "a2"]))
        #expect(text(s, 1) == "a2")
        s.undo()
        #expect(text(s, 1) == "a")
    }
}
