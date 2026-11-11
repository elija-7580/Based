import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-104: orphaned blocks land in the Trash; tombstones older than 90 days are compacted and clients that pulled
/// less than `oldestSeq` do a full pull.
@MainActor
struct TombstoneGCTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tombgc-\(UUID().uuidString)")

    func store(_ name: String) throws -> WorkspaceStore {
        WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite")), node: name)
    }

    func client(_ s: WorkspaceStore, server: SyncServer) -> ServerSync {
        let c = ServerSync(store: s, baseURL: URL(string: "https://example.invalid")!, token: "t")
        c.transport = { req in
            await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch req.url!.path {
                case "/sync/v2/info":
                    return (200, Data(#"{"protocol":2,"seq":\#((server.store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0),"oldestSeq":\#(server.oldestSeq)}"#.utf8))
                case "/sync/v2/pull":
                    let page = server.pullPage(after: Int64(q["after"] ?? "0") ?? 0, limit: 3)   // small pages
                    return (200, try! JSONEncoder().encode(page))
                case "/sync/v2/push":
                    let p = try! JSONDecoder().decode(SyncPush.self, from: req.httpBody!)
                    return (200, try! JSONEncoder().encode(server.pushV2(p)))
                default:
                    return (404, Data())
                }
            }
        }
        c.pageSize = 3
        return c
    }

    func tick() async throws { try await Task.sleep(nanoseconds: 3_000_000) }

    func keys(_ s: WorkspaceStore) -> Set<RecordKey> { Set(s.allRecords().map(\.key).filter { $0.kind != .workspace }) }

    /// A child edited after its page was deleted forever wins against the tombstone; its parent doesn't come back.
    /// Instead of staying invisible it shows up in the Trash ("Recovered blocks") on every device and can be restored.
    @Test func orphanedChildIsRecoveredIntoTheTrash() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let page = a.createPage(title: "Old")
        let line = a.insertBlock(.text, text: "v1", in: .block(page))
        await ca.syncNow(); await cb.syncNow()
        #expect(b.blocks[line] != nil)

        a.trashPages([page]); a.deleteForever([page])
        await ca.syncNow()
        try await tick()
        b.setText(line, RichText("edited later"))   // newer than A's delete
        await cb.syncNow()
        await cb.syncNow()
        await ca.syncNow()

        let holder = WorkspaceStore.recoveredBlocksPageID
        for s in [a, b] {
            #expect(s.blocks[page] == nil)
            #expect(s.blocks[line]?.text.plainText == "edited later")
            #expect(s.blocks[line]?.parent == .block(holder))
            #expect(s.trashedPages().map(\.id).contains(holder))
            #expect(s.orphanedBlocks(among: s.blocks.keys).isEmpty)
        }
        a.restorePages([holder])
        #expect(!a.isTrashed(line))
        #expect(a.childBlocks(of: .block(holder)).map(\.id) == [line])
    }

    /// Tombstones older than 90 days go, younger ones stay; a client that pulled before the compacted range pulls
    /// everything again and ends up with the server's records. Records themselves are never removed by the GC.
    @Test func oldTombstonesAreCompactedAndStaleClientsPullEverything() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let keep = a.createPage(title: "Keep")
        let old = a.createPage(title: "Old")
        let oldLine = a.insertBlock(.text, text: "x", in: .block(old))
        let young = a.createPage(title: "Young")
        await ca.syncNow(); await cb.syncNow()
        #expect(b.blocks[old] != nil)

        a.trashPages([old]); a.deleteForever([old])
        await ca.syncNow()
        let serverRecords = keys(srv)
        // 100 days later only the old deletion is past retention; delete `young` "now" (inside retention).
        let later = Date().addingTimeInterval(100 * 86_400)
        a.trashPages([young]); a.deleteForever([young])
        // (A hasn't pushed it yet: the compaction below can't see it.)
        let removedNone = server.compactTombstones(olderThanDays: 90)
        #expect(removedNone == 0)
        #expect(server.oldestSeq == 0)
        let removed = server.compactTombstones(olderThanDays: 90, now: later)
        #expect(removed >= 2)                      // page + line
        #expect(server.oldestSeq > 0)
        #expect(keys(srv) == serverRecords)        // GC never touches records
        let log = srv.persistence as! ChangeLogging
        #expect(log.tombstone(RecordKey(.block, old)) == nil)

        await ca.syncNow()                         // pushes the young deletion: its tombstone stays
        #expect(log.tombstone(RecordKey(.block, young)) != nil)

        // B was offline the whole time: its pulled seq is below oldestSeq → full pull.
        await cb.syncNow()
        #expect(b.blocks[old] == nil)
        #expect(b.blocks[oldLine] == nil)
        #expect(b.blocks[young] == nil)
        #expect(b.blocks[keep] != nil)
        #expect(keys(b) == keys(srv))
        #expect(keys(a) == keys(srv))
    }

    /// Old data: a v3 server file whose deletion rows predate stamps (NULL) keeps them; stamped old rows go.
    @Test func compactionKeepsUnstampedRowsFromOlderFiles() throws {
        let url = dir.appendingPathComponent("legacy.sqlite")
        let k1 = RecordKey(.block, "legacy"), k2 = RecordKey(.block, "stamped"), k3 = RecordKey(.block, "fresh")
        let ancient = Stamp(millis: Int64((Date().timeIntervalSince1970 - 200 * 86_400) * 1000), counter: 0, node: "x")
        do {
            let p = try SQLitePersistence(url: url)
            try p.write(upserts: [], deletions: [k1], local: false)                              // pre-v3 style row
            try p.write(upserts: [], deletions: [k2], tombstones: [k2: ancient], local: false)
            try p.write(upserts: [], deletions: [k3], tombstones: [k3: Stamp(millis: Int64(Date().timeIntervalSince1970 * 1000), counter: 0, node: "x")], local: false)
        }
        let s = WorkspaceStore(persistence: try SQLitePersistence(url: url), node: "server")
        let server = SyncServer(store: s)
        #expect(server.compactTombstones() == 1)
        let rows = try (s.persistence as! ChangeLogging).changes(after: 0, limit: 100).map(\.key.id)
        #expect(rows.contains("legacy"))
        #expect(rows.contains("fresh"))
        #expect(!rows.contains("stamped"))
        #expect(server.oldestSeq == 2)
        // Persisted across reopen.
        #expect(SyncServer(store: WorkspaceStore(persistence: try SQLitePersistence(url: url), node: "server")).oldestSeq == 2)
    }
}
