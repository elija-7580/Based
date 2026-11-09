import Foundation
import Testing
@testable import BasedCore

/// BSD-24 / ADR 0002: deletions are stamped tombstones; newer edits and restores win, older records stay deleted.
@MainActor
@Suite struct TombstoneTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tombstone-\(UUID().uuidString)")

    func sqliteStore(_ name: String) throws -> (WorkspaceStore, SQLitePersistence) {
        let p = try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite"))
        return (WorkspaceStore(persistence: p, node: name), p)
    }

    @Test func localDeletionLogsItsStamp() throws {
        let (s, p) = try sqliteStore("a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "x", in: .block(page))
        let before = s.blocks[line]!.stamp
        s.deleteBlocks([line])
        let entry = try p.changes(after: 0, limit: 100).first { $0.key == RecordKey(.block, line) }
        #expect(entry?.deleted == true)
        let ts = try #require(entry?.deletedStamp)
        #expect(ts > before)
        #expect(p.tombstone(RecordKey(.block, line)) == ts)
        // An upsert of a key clears its tombstone.
        #expect(p.tombstone(RecordKey(.block, page)) == nil)
    }

    @Test func olderRecordStaysDeletedNewerRecordComesBack() throws {
        let (s, _) = try sqliteStore("a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "old", in: .block(page))
        var offline = s.blocks[line]!
        offline.text = RichText("edited offline")
        offline.stamp = Stamp(millis: offline.stamp.millis, counter: offline.stamp.counter + 1, node: "0-other")
        s.deleteBlocks([line])   // deleted later than the offline edit

        let r = s.applyRemoteReporting([.block(offline)])
        #expect(s.blocks[line] == nil)
        #expect(r.tombstoned[RecordKey(.block, line)] != nil)

        var newer = offline
        newer.stamp = Stamp(millis: s.clock.current.millis + 10_000, counter: 0, node: "zz-other")
        let r2 = s.applyRemoteReporting([.block(newer)])
        #expect(r2.tombstoned.isEmpty)
        #expect(s.blocks[line]?.text.plainText == "edited offline")
    }

    @Test func stampedDeletionLosesAgainstNewerLocalCopy() throws {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "a")
        let page = s.createPage(title: "P")
        let key = RecordKey(.block, page)
        let old = Stamp(millis: 1, counter: 0, node: "b")
        let r = s.applyRemoteReporting([], deletions: [key], deletionStamps: [key: old])
        #expect(s.blocks[page] != nil)
        #expect(r.stale == [key])

        // A newer stamped deletion removes it; so does an unstamped one (older senders), unconditionally.
        let other = s.createPage(title: "Q")
        let newer = Stamp(millis: s.clock.current.millis + 1, counter: 0, node: "b")
        s.applyRemote([], deletions: [key], deletionStamps: [key: newer])
        #expect(s.blocks[page] == nil)
        s.applyRemote([], deletions: [RecordKey(.block, other)])
        #expect(s.blocks[other] == nil)
    }

    @Test func remoteDeletionKeepsSenderStampInLog() throws {
        let (s, p) = try sqliteStore("a")
        let page = s.createPage(title: "P")
        let key = RecordKey(.block, page)
        let ts = Stamp(millis: s.clock.current.millis + 5, counter: 3, node: "remote")
        s.applyRemote([], deletions: [key], deletionStamps: [key: ts])
        #expect(p.tombstone(key) == ts)
        #expect(try p.changes(after: 0, limit: 100).first { $0.key == key }?.local == false)
        // Unstamped remote deletion: logged without a stamp (cannot block later records).
        let q = s.createPage(title: "Q")
        s.applyRemote([], deletions: [RecordKey(.block, q)])
        #expect(p.tombstone(RecordKey(.block, q)) == nil)
    }

    @Test func restoreRestampsTheWholeSubtree() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "x", in: .block(page))
        let sub = s.createPage(title: "Sub", in: .block(page))
        let db = s.createDatabase(title: "DB", in: .block(page), inline: true, sampleRows: 1)
        let row = s.children(of: .database(db.databaseID))[0]
        let lineUpdated = s.blocks[line]!.updatedAt
        s.trashPages([page])
        let trashedStamp = s.blocks[page]!.stamp
        s.restorePages([page])
        for id in [line, sub, db.blockID, row] { #expect(s.blocks[id]!.stamp > trashedStamp) }
        #expect(s.databases[db.databaseID]!.stamp > trashedStamp)
        #expect(s.views[db.viewID]!.stamp > trashedStamp)
        // Content unchanged: "last edited" stays.
        #expect(s.blocks[line]!.updatedAt == lineUpdated)
        #expect(s.blocks[line]!.text.plainText == "x")
    }

    @Test func undoOfDeletionWinsAgainstItsOwnTombstone() throws {
        let (s, p) = try sqliteStore("a")
        let page = s.createPage(title: "P")
        let line = s.insertBlock(.text, text: "x", in: .block(page))
        s.deleteBlocks([line])
        let ts = try #require(p.tombstone(RecordKey(.block, line)))
        s.undo()
        #expect(s.blocks[line]!.stamp > ts)
        #expect(p.tombstone(RecordKey(.block, line)) == nil)
    }
}
