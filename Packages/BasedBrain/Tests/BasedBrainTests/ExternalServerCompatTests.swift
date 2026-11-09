import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-158: the unchanged Swift client (`ServerSync`) against a real, external Sync v2 server over HTTP – the
/// TypeScript `based-server` (apps/server) in CI (`ci/server/swift-client-compat.sh`). Runs only when
/// `BASED_COMPAT_SERVER_URL` and `BASED_COMPAT_SERVER_TOKEN` are set; otherwise every test is skipped. The server is
/// shared by the tests, so each test uses fresh record ids and never assumes an empty server.
private let compatEnv = ProcessInfo.processInfo.environment
private let compatConfigured = compatEnv["BASED_COMPAT_SERVER_URL"] != nil && compatEnv["BASED_COMPAT_SERVER_TOKEN"] != nil

@MainActor
@Suite(.enabled(if: compatConfigured))
struct ExternalServerCompatTests {
    let baseURL = URL(string: compatEnv["BASED_COMPAT_SERVER_URL"] ?? "http://127.0.0.1:1")!
    let token = compatEnv["BASED_COMPAT_SERVER_TOKEN"] ?? ""
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ext-compat-\(UUID().uuidString)")

    func store(_ name: String) throws -> WorkspaceStore {
        WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite")), node: name)
    }

    final class Box: @unchecked Sendable { var paths: [String] = [] }

    /// A client on the real network. `log` records request paths; `stripStamps` sends deletions like an older client
    /// (plain {kind, id}); `token` overrides the server token.
    func client(_ s: WorkspaceStore, pageSize: Int = 500, log: Box? = nil, stripStamps: Bool = false, token: String? = nil) -> ServerSync {
        let c = ServerSync(store: s, baseURL: baseURL, token: token ?? self.token)
        c.pageSize = pageSize
        if log != nil || stripStamps {
            c.transport = { req in
                var req = req
                log?.paths.append(req.url!.path)
                if stripStamps, req.url!.path.hasSuffix("/sync/v2/push"), let body = req.httpBody,
                   var json = try JSONSerialization.jsonObject(with: body) as? [String: Any] {
                    json["deletions"] = (json["deletions"] as? [[String: Any]] ?? []).map { d in d.filter { $0.key != "stamp" } }
                    req.httpBody = try JSONSerialization.data(withJSONObject: json)
                }
                let (data, resp) = try await URLSession.shared.data(for: req)
                return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
            }
        }
        return c
    }

    func info() async throws -> (seq: Int64, oldestSeq: Int64, proto: Int) {
        var req = URLRequest(url: baseURL.appendingPathComponent("sync/v2/info"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        let v = try JSONDecoder().decode([String: Int64].self, from: data)
        return (v["seq"] ?? -1, v["oldestSeq"] ?? -1, Int(v["protocol"] ?? 0))
    }

    func tick() async throws { try await Task.sleep(nanoseconds: 3_000_000) }

    static func canonical(_ r: Record?) -> String {
        guard let r else { return "<missing>" }
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        return String(decoding: (try? e.encode(r)) ?? Data(), as: UTF8.self)
    }

    @Test func infoSpeaksV2() async throws {
        let i = try await info()
        #expect(i.proto == 2)
        #expect(i.seq >= 0 && i.oldestSeq >= 0)
    }

    /// SyncV2Tests.roundTripLateOfflineChangeRestartAndDeletion, over HTTP.
    @Test func roundTripLateOfflineChangeRestartAndDeletion() async throws {
        let a = try store("a"), b = try store("b")
        let ca = client(a), cb = client(b)

        let p1 = a.createPage(title: RichText("From A"))
        await ca.syncNow()
        #expect(ca.usesV2 == true)
        #expect(ca.lastError == nil)
        await cb.syncNow()
        #expect(b.title(of: p1) == "From A")

        let late = b.createPage(title: RichText("Written offline on B"))
        try await Task.sleep(nanoseconds: 5_000_000)
        let p2 = a.createPage(title: RichText("Later on A"))
        await ca.syncNow()
        await cb.syncNow()
        #expect(b.title(of: p2) == "Later on A")
        await ca.syncNow()
        #expect(a.title(of: late) == "Written offline on B")

        let unsynced = a.createPage(title: RichText("Before quit"))
        let restarted = client(a)
        await restarted.syncNow()
        await cb.syncNow()
        #expect(b.title(of: unsynced) == "Before quit")

        let line = a.insertBlock(.text, text: RichText("to delete"), in: .block(p2), at: .end)
        await restarted.syncNow()
        await cb.syncNow()
        #expect(b.blocks[line] != nil)
        a.deleteBlocks([p1, line])
        await restarted.syncNow()
        await cb.syncNow()
        #expect(b.blocks[p1]?.trashedAt != nil)
        #expect(b.blocks[line] == nil)

        // Nothing pulled back as "local": a second sync of the same client pushes nothing.
        let log = Box()
        let quiet = client(b, log: log)
        await quiet.syncNow()
        log.paths.removeAll()
        await quiet.syncNow()
        #expect(!log.paths.contains("/sync/v2/push"))
        #expect(log.paths.contains("/sync/v2/pull"))
    }

    /// TombstoneSyncTests: a later restore wins over an earlier purge, with its content.
    @Test func laterRestoreWinsOverEarlierPurgeWithContent() async throws {
        let a = try store("a"), b = try store("b")
        let ca = client(a), cb = client(b)
        let page = a.createPage(title: "Plan")
        let line = a.insertBlock(.text, text: "keep me", in: .block(page))
        let sub = a.createPage(title: "Sub", in: .block(page))
        a.trashPages([page])
        await ca.syncNow(); await cb.syncNow()
        #expect(b.isTrashed(page))

        a.deleteForever([page])
        try await tick()
        b.restorePages([page])
        await ca.syncNow()
        await cb.syncNow()
        await ca.syncNow()
        for s in [a, b] {
            #expect(s.blocks[page]?.trashedAt == nil)
            #expect(s.blocks[line]?.text.plainText == "keep me")
            #expect(s.blocks[sub] != nil)
        }
    }

    /// A newer tombstone on the server beats an older offline edit (`deleted` in the push reply), and a newer edit
    /// beats an older deletion (`newer`).
    @Test func tombstonesBothWays() async throws {
        let a = try store("a"), b = try store("b")
        let ca = client(a), cb = client(b)
        let host = a.createPage(title: "Host")
        let x = a.insertBlock(.text, text: "x", in: .block(host))
        let y = a.insertBlock(.text, text: "y", in: .block(host))
        await ca.syncNow(); await cb.syncNow()
        #expect(b.blocks[x] != nil && b.blocks[y] != nil)

        // x: B edits first (offline), A deletes later and syncs first → stays deleted on B.
        b.transact("edit") { $0.update(x) { $0.text = "B earlier" } }
        try await tick()
        a.transact("delete") { $0.remove(RecordKey(.block, x)) }
        // y: A deletes first, B edits later → the edit wins everywhere.
        a.transact("delete") { $0.remove(RecordKey(.block, y)) }
        try await tick()
        b.transact("edit") { $0.update(y) { $0.text = "B later" } }

        await ca.syncNow()
        await cb.syncNow()
        await ca.syncNow()
        #expect(a.blocks[x] == nil && b.blocks[x] == nil)
        #expect(a.blocks[y]?.text.plainText == "B later")
        #expect(b.blocks[y]?.text.plainText == "B later")
        #expect(cb.lastError == nil && ca.lastError == nil)
    }

    /// An older client sends deletions without stamps: the server stamps them on receipt.
    @Test func unstampedDeletionFromOlderClient() async throws {
        let a = try store("a"), b = try store("b")
        let old = client(a, stripStamps: true), cb = client(b)
        let page = a.createPage(title: "Old client")
        let line = a.insertBlock(.text, text: "gone", in: .block(page))
        await old.syncNow(); await cb.syncNow()
        #expect(b.blocks[line] != nil)
        a.transact("delete") { $0.remove(RecordKey(.block, line)) }
        await old.syncNow(); await cb.syncNow()
        #expect(old.lastError == nil)
        #expect(b.blocks[line] == nil)
        #expect((b.persistence as? SQLitePersistence)?.tombstone(RecordKey(.block, line)) != nil)
    }

    /// Paging with small pages in both directions; cursors end at the server's seq.
    @Test func pagedPushAndPull() async throws {
        let a = try store("a"), b = try store("b")
        let host = a.createPage(title: "Many")
        for i in 0..<23 { a.insertBlock(.text, text: RichText("line \(i)"), in: .block(host), at: .end) }
        await client(a, pageSize: 4).syncNow()
        let cb = client(b, pageSize: 3)
        await cb.syncNow()
        #expect(cb.lastError == nil)
        #expect(b.children(of: .block(host)).count == 23)
        // Other tests share the server and may push meanwhile: the cursor is at most the server's seq.
        let seq = try await info().seq
        let pulled = b.persistence?.meta("sync.v2.pulled").flatMap { Int64(String(decoding: $0, as: UTF8.self)) } ?? 0
        #expect(pulled > 0 && pulled <= seq)
    }

    /// The shared record corpus (fixtures/records/corpus.jsonl, every block/property/view type) goes Swift → server →
    /// Swift unchanged: the server must keep every field, including ones it doesn't know.
    @Test func recordCorpusSurvivesTheServer() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/records/corpus.jsonl")
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n").filter { !$0.isEmpty }
        let records = try lines.map { try JSONDecoder().decode(Record.self, from: Data($0.utf8)) }.filter { $0.key.kind != .workspace }
        #expect(records.count > 50)
        let a = try store("a"), b = try store("b")
        a.transact("corpus") { tx in
            tx.preserveTimestamps = true
            for r in records { tx.put(r) }
        }
        let ca = client(a, pageSize: 50)
        await ca.syncNow()
        #expect(ca.lastError == nil)
        let cb = client(b, pageSize: 40)
        await cb.syncNow()
        #expect(cb.lastError == nil)
        var mismatched: [String] = []
        for r in records where Self.canonical(a.record(r.key)) != Self.canonical(b.record(r.key)) { mismatched.append(r.key.description) }
        #expect(mismatched.isEmpty, "differ after the round trip: \(mismatched.prefix(10))")
    }

    @Test func wrongTokenIsAVisibleError() async throws {
        let a = try store("a")
        _ = a.createPage(title: "Never sent")
        let c = client(a, token: "wrong")
        await c.syncNow()
        #expect(c.lastError?.contains("401") == true)
        #expect(a.persistence?.meta("sync.v2.pushed") == nil)
    }
}
