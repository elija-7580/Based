import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-24 end to end: stamped tombstones between two clients and a server (each on its own SQLite file).
@MainActor
struct TombstoneSyncTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tomb-\(UUID().uuidString)")

    func store(_ name: String) throws -> WorkspaceStore {
        WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite")), node: name)
    }

    /// `stripStamps` simulates an older client: deletions go out as plain {kind, id}.
    func client(_ s: WorkspaceStore, server: SyncServer, stripStamps: Bool = false) -> ServerSync {
        let c = ServerSync(store: s, baseURL: URL(string: "https://example.invalid")!, token: "t")
        c.transport = { req in
            await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch req.url!.path {
                case "/sync/v2/pull":
                    let page = server.pullPage(after: Int64(q["after"] ?? "0") ?? 0, limit: 500)
                    return (200, try! JSONEncoder().encode(page))
                case "/sync/v2/push":
                    var body = req.httpBody!
                    if stripStamps {
                        var json = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
                        json["deletions"] = (json["deletions"] as! [[String: Any]]).map { d in d.filter { $0.key != "stamp" } }
                        body = try! JSONSerialization.data(withJSONObject: json)
                    }
                    let p = try! JSONDecoder().decode(SyncPush.self, from: body)
                    return (200, try! JSONEncoder().encode(server.pushV2(p)))
                default:
                    return (404, Data())
                }
            }
        }
        return c
    }

    func tick() async throws { try await Task.sleep(nanoseconds: 3_000_000) }

    /// 1. Purge on A (earlier) vs. restore on B (later): the page comes back with its content everywhere.
    @Test func laterRestoreWinsOverEarlierPurgeWithContent() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let page = a.createPage(title: "Plan")
        let line = a.insertBlock(.text, text: "keep me", in: .block(page))
        let sub = a.createPage(title: "Sub", in: .block(page))
        a.trashPages([page])
        await ca.syncNow(); await cb.syncNow()
        #expect(b.isTrashed(page))

        // A empties the Trash (earlier), B restores (later); A syncs first.
        a.deleteForever([page])
        try await tick()
        b.restorePages([page])
        await ca.syncNow()
        #expect(srv.blocks[page] == nil)
        await cb.syncNow()
        await ca.syncNow()
        for s in [a, b, srv] {
            #expect(s.blocks[page]?.trashedAt == nil)
            #expect(s.blocks[line]?.text.plainText == "keep me")
            #expect(s.blocks[sub] != nil)
        }
    }

    /// Same race, B syncs first: A's older purge loses on the server and A gets the page back.
    @Test func laterRestoreWinsWhenItReachesTheServerFirst() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let page = a.createPage(title: "Plan")
        let line = a.insertBlock(.text, text: "keep me", in: .block(page))
        a.trashPages([page])
        await ca.syncNow(); await cb.syncNow()
        a.deleteForever([page])
        try await tick()
        b.restorePages([page])
        await cb.syncNow()
        await ca.syncNow()
        for s in [a, b, srv] {
            #expect(s.blocks[page]?.trashedAt == nil)
            #expect(s.blocks[line]?.text.plainText == "keep me")
        }
    }

    /// 2. Edit on B (earlier, offline) vs. purge on A (later): the block stays deleted everywhere.
    @Test func laterPurgeBeatsEarlierOfflineEdit() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let page = a.createPage(title: "Old")
        let line = a.insertBlock(.text, text: "v1", in: .block(page))
        await ca.syncNow(); await cb.syncNow()
        #expect(b.blocks[line] != nil)

        b.setText(line, RichText("edited offline"))
        try await tick()
        a.trashPages([page]); a.deleteForever([page])
        await ca.syncNow()
        await cb.syncNow()
        await ca.syncNow()
        for s in [a, b, srv] {
            #expect(s.blocks[line] == nil)
            #expect(s.blocks[page] == nil)
        }
    }

    /// 2b. The offline edit reaches the server first: the later purge still wins.
    @Test func laterPurgeBeatsEarlierEditPushedFirst() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)
        let page = a.createPage(title: "Old")
        let line = a.insertBlock(.text, text: "v1", in: .block(page))
        await ca.syncNow(); await cb.syncNow()
        b.setText(line, RichText("edited"))
        try await tick()
        a.deleteBlocks([line])
        await cb.syncNow()
        await ca.syncNow()
        await cb.syncNow()
        for s in [a, b, srv] { #expect(s.blocks[line] == nil) }
    }

    /// 3. An older client without stamps: its deletions still work (the server stamps them on receipt).
    @Test func olderClientWithoutStampsStillDeletes() async throws {
        let srv = try store("server"); let server = SyncServer(store: srv)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server, stripStamps: true), cb = client(b, server: server)
        let page = a.createPage(title: "P")
        let line = a.insertBlock(.text, text: "x", in: .block(page))
        await ca.syncNow(); await cb.syncNow()
        a.deleteBlocks([line])
        await ca.syncNow()
        #expect(srv.blocks[line] == nil)
        #expect((srv.persistence as? ChangeLogging)?.tombstone(RecordKey(.block, line)) != nil)
        await cb.syncNow()
        #expect(b.blocks[line] == nil)
    }

    /// Wire format: a deletion carries its stamp; an old-format body (no stamp) still decodes.
    @Test func wireFormatIsBackwardCompatible() throws {
        let k = RecordKey(.block, "x")
        let s = Stamp(millis: 5, counter: 1, node: "n")
        let page = SyncPage(records: [], deletions: [k], deletionStamps: [k: s], next: 3, more: false)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(page)) as! [String: Any]
        let d = (json["deletions"] as! [[String: Any]])[0]
        #expect(d["kind"] as? String == "block" && d["id"] as? String == "x" && d["stamp"] != nil)
        // Old clients decode the deletion as a plain record key.
        struct OldPage: Decodable { var deletions: [RecordKey] }
        #expect(try JSONDecoder().decode(OldPage.self, from: JSONEncoder().encode(page)).deletions == [k])
        // Old body without stamps; old reply without `deleted`.
        let push = try JSONDecoder().decode(SyncPush.self, from: Data(#"{"records":[],"deletions":[{"kind":"block","id":"x"}]}"#.utf8))
        #expect(push.deletions == [k] && push.deletionStamps.isEmpty)
        let reply = try JSONDecoder().decode(SyncPushReply.self, from: Data(#"{"newer":[],"seq":4}"#.utf8))
        #expect(reply.deleted.isEmpty && reply.seq == 4)
        #expect(try JSONDecoder().decode(SyncPage.self, from: JSONEncoder().encode(page)) == page)
    }
}
