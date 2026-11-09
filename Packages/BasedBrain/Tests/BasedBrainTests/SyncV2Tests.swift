import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// Sync v2 end to end: a server and two clients, each on its own SQLite file, talking JSON through the
/// client's transport hook (no network).
@MainActor
struct SyncV2Tests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("syncv2-\(UUID().uuidString)")

    /// Server stores open like based-server does (BSD-121: behind a `PersistenceWriter`); clients write directly.
    func store(_ name: String) throws -> WorkspaceStore {
        let url = dir.appendingPathComponent("\(name).sqlite")
        if name.hasPrefix("server") { return try ServerStorage.openStore(url: url) }
        return WorkspaceStore(persistence: try SQLitePersistence(url: url), node: name)
    }

    func client(_ s: WorkspaceStore, server: SyncServer, pageSize: Int = 500, log: Box? = nil) -> ServerSync {
        let c = ServerSync(store: s, baseURL: URL(string: "https://example.invalid")!, token: "t")
        c.pageSize = pageSize
        c.transport = { req in
            let path = req.url!.path
            log?.paths.append(path)
            return await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch path {
                case "/sync/v2/pull":
                    let page = server.pullPage(after: Int64(q["after"] ?? "0") ?? 0, limit: Int(q["limit"] ?? "500") ?? 500)
                    return (200, try! JSONEncoder().encode(page))
                case "/sync/v2/push":
                    let p = try! JSONDecoder().decode(SyncPush.self, from: req.httpBody!)
                    return (200, try! JSONEncoder().encode(server.pushV2(p)))
                default:
                    return (404, Data())
                }
            }
        }
        return c
    }

    final class Box { var paths: [String] = [] }

    /// BSD-121: the server store saves in the background; after 1 000 pushes and a flush (what SIGTERM does),
    /// a fresh open of the file has every record, and pulls see all of them in the change log.
    @Test func serverWriterKeepsEveryPushAcrossARestart() async throws {
        let srvURL = dir.appendingPathComponent("server-writer.sqlite")
        let srvStore = try ServerStorage.openStore(url: srvURL)
        #expect(srvStore.persistence is PersistenceWriter)
        let server = SyncServer(store: srvStore)
        let client = try store("writer-client")
        var ids: [RecordID] = []
        for i in 0..<1_000 {
            let id = client.createPage(title: RichText("Pushed \(i)"))
            ids.append(id)
            _ = server.pushV2(SyncPush(records: [client.record(RecordKey(.block, id))!], deletions: []))
        }
        // Reads through the writer see everything at once (they wait for the queue).
        let pulled = server.pullPage(after: 0, limit: 5_000).records.compactMap { r -> RecordID? in
            if case .block(let b) = r { return b.id } else { return nil }
        }
        #expect(Set(ids).isSubset(of: Set(pulled)))
        #expect(ServerStorage.flush(srvStore, reason: "test"))
        #expect(srvStore.unsavedChangeCount == 0)
        let reopened = WorkspaceStore(persistence: try SQLitePersistence(url: srvURL), node: "check")
        #expect(ids.allSatisfy { reopened.blocks[$0] != nil })
        #expect(reopened.title(of: ids[999]) == "Pushed 999")
    }

    @Test func roundTripLateOfflineChangeRestartAndDeletion() async throws {
        let srvStore = try store("server")
        let server = SyncServer(store: srvStore)
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)

        let p1 = a.createPage(title: RichText("From A"))
        await ca.syncNow()
        #expect(ca.usesV2 == true)
        #expect(srvStore.title(of: p1) == "From A")
        await cb.syncNow()
        #expect(b.title(of: p1) == "From A")

        // B goes offline and writes (older stamp) …
        let late = b.createPage(title: RichText("Written offline on B"))
        // … while A keeps working and syncing (the server sequence moves on, A's cursor too).
        try await Task.sleep(nanoseconds: 5_000_000)
        let p2 = a.createPage(title: RichText("Later on A"))
        await ca.syncNow()
        // B comes back.
        await cb.syncNow()
        #expect(b.title(of: p2) == "Later on A")
        // v1 lost this one: its stamp is older than A's cursor. v2 delivers it.
        await ca.syncNow()
        #expect(a.title(of: late) == "Written offline on B")

        // A change made just before quitting is pushed by a fresh client (no in-memory pending set).
        let unsynced = a.createPage(title: RichText("Before quit"))
        let restarted = client(a, server: server)
        await restarted.syncNow()
        #expect(srvStore.title(of: unsynced) == "Before quit")

        // Trash (pages) and hard deletion (blocks) travel.
        let line = a.insertBlock(.text, text: RichText("to delete"), in: .block(p2), at: .end)
        await restarted.syncNow()
        await cb.syncNow()
        #expect(b.blocks[line] != nil)
        a.deleteBlocks([p1, line])
        await restarted.syncNow()
        await cb.syncNow()
        #expect(b.blocks[p1]?.trashedAt != nil)
        #expect(b.blocks[line] == nil)

        // Nothing pulled back as "local": a second B sync pushes nothing.
        let log = Box()
        let quiet = client(b, server: server, log: log)
        await quiet.syncNow()   // first run of a new client on B: pushes B's backlog once
        log.paths.removeAll()
        await quiet.syncNow()
        #expect(!log.paths.contains("/sync/v2/push"))
    }

    /// BSD-26: an archive restored on a fresh device reaches the server (origin `.import` logs `local=1`).
    @Test func archiveRestoreIsPushedToServer() async throws {
        let original = try store("orig26")
        let page = original.createPage(title: RichText("Archived page"))
        let line = original.insertBlock(.text, text: RichText("archived line"), in: .block(page), at: .end)
        let archive = try WorkspaceArchive.write(original)

        let srvStore = try store("server26")
        let server = SyncServer(store: srvStore)
        let fresh = try store("fresh26")
        let c = client(fresh, server: server)
        await c.syncNow()                       // a client that has already synced once (cursor set)
        let result = try WorkspaceArchive.importArchive(archive, into: fresh)
        #expect(result.imported >= 2)
        // Stamps are the archive's (not restamped on import).
        #expect(fresh.blocks[page]?.stamp == original.blocks[page]?.stamp)
        await c.syncNow()
        #expect(srvStore.title(of: page) == "Archived page")
        #expect(srvStore.blocks[line]?.text.plainText == "archived line")
        // A second device gets the restore from the server.
        let other = try store("other26")
        await client(other, server: server).syncNow()
        #expect(other.title(of: page) == "Archived page")
    }

    @Test func pagesLargeWorkspaces() async throws {
        let srvStore = try store("server2")
        let server = SyncServer(store: srvStore)
        let a = try store("a2"), b = try store("b2")
        let parent = a.createPage(title: RichText("Big"))
        for i in 0..<1_200 { _ = a.insertBlock(.text, text: RichText("line \(i)"), in: .block(parent), at: .end) }
        let log = Box()
        let ca = client(a, server: server, pageSize: 100, log: log)
        await ca.syncNow()
        #expect(log.paths.filter { $0 == "/sync/v2/push" }.count >= 12)
        let cb = client(b, server: server, pageSize: 100)
        await cb.syncNow()
        #expect(b.children(of: .block(parent)).count == 1_200)
        #expect(server.pullPage(after: 0, limit: 100).more)
    }

    @Test func fallsBackToV1OnOldServers() async throws {
        let a = try store("a3")
        let c = ServerSync(store: a, baseURL: URL(string: "https://example.invalid")!, token: "t")
        var paths: [String] = []
        c.transport = { req in
            paths.append(req.url!.path)
            if req.url!.path.hasPrefix("/sync/v2") { return (404, Data()) }
            let env = SyncEnvelope(records: [], deletions: [], cursor: .zero)
            return (200, try JSONEncoder().encode(env))
        }
        _ = a.createPage(title: RichText("x"))
        await c.syncNow()
        #expect(c.usesV2 == false)
        #expect(paths.contains("/sync/push") && paths.contains("/sync/pull"))
    }

    /// BSD-16: a row a client can't decode (newer app, decoding bug) is never pushed as a deletion.
    @Test func frozenRecordIsNeverPushedAsDeletion() async throws {
        let srvStore = try store("server")
        let server = SyncServer(store: srvStore)
        let url = dir.appendingPathComponent("a.sqlite")
        let a = try store("a")
        let page = a.createPage(title: RichText("Shared"))
        let line = a.insertBlock(.text, text: RichText("from the future"), in: .block(page), at: .end)
        await client(a, server: server).syncNow()
        #expect(srvStore.blocks[line] != nil)

        // The row becomes undecodable on A (and is logged as a fresh local change, like a newer app would).
        let pa = a.persistence as! SQLitePersistence
        try pa.writeRawRow(kind: .block, id: line, data: Data("{\"type\":\"futureBlock\"".utf8))
        let reopened = WorkspaceStore(persistence: try SQLitePersistence(url: url), node: "a")
        #expect(reopened.frozenKeys.contains(RecordKey(.block, line)))
        let log = Box()
        await client(reopened, server: server, log: log).syncNow()
        #expect(srvStore.blocks[line]?.text.plainText == "from the future")

        // A real deletion still travels.
        reopened.deleteBlocks([page])
        reopened.purgeTrash(olderThan: 0, now: Date().addingTimeInterval(3600))
        await client(reopened, server: server).syncNow()
        #expect(srvStore.blocks[page] == nil)
    }

    /// BSD-16: a row the server can't decode is skipped when clients pull, not served as a deletion.
    @Test func frozenRecordOnServerIsNeverPulledAsDeletion() async throws {
        let srvURL = dir.appendingPathComponent("server.sqlite")
        let srvStore = try store("server")
        let a = try store("a"), b = try store("b")
        let page = a.createPage(title: RichText("Kept"))
        await client(a, server: SyncServer(store: srvStore)).syncNow()
        await client(b, server: SyncServer(store: srvStore)).syncNow()
        #expect(b.blocks[page] != nil)

        #expect(srvStore.flushSync(timeout: 5))
        let ps = (srvStore.persistence as! PersistenceWriter).sqlite!
        try ps.writeRawRow(kind: .block, id: page, data: Data("broken".utf8))
        let server2 = SyncServer(store: try ServerStorage.openStore(url: srvURL))
        #expect(server2.store.frozenKeys.contains(RecordKey(.block, page)))
        let pageOfChanges = server2.pullPage(after: 0)
        #expect(!pageOfChanges.deletions.contains(RecordKey(.block, page)))
        await client(b, server: server2).syncNow()
        #expect(b.blocks[page]?.text.plainText == "Kept")
        #expect(ps.rawRow(RecordKey(.block, page)) == Data("broken".utf8))
    }
}

@MainActor
struct SyncWaitTests {
    @Test func longPollReturnsOnChangeOrTimeout() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("wait-\(UUID().uuidString).sqlite")
        let store = try ServerStorage.openStore(url: url, node: "s")   // BSD-121: like based-server
        let server = SyncServer(store: store)
        let now = (store.persistence as! ChangeLogging).lastChangeSeq
        // Already newer → immediate.
        var t = Date()
        #expect(await server.waitForChanges(after: now - 1, timeout: 5) == now)
        #expect(Date().timeIntervalSince(t) < 0.5)
        // Nothing new → waits for the timeout.
        t = Date()
        #expect(await server.waitForChanges(after: now, timeout: 1) == now)
        #expect(Date().timeIntervalSince(t) >= 0.9)
        // A change during the wait wakes it up.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            _ = store.createPage(title: RichText("new"))
        }
        t = Date()
        let seq = await server.waitForChanges(after: now, timeout: 10)
        #expect(seq > now)
        #expect(Date().timeIntervalSince(t) < 3)
    }
}
