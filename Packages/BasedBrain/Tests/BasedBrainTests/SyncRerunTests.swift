import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-72: a local edit that asks for a push while a sync is running reaches the server in the same sync call
/// (it used to be dropped and waited for the 20 s tick).
@MainActor
struct SyncRerunTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rerun-\(UUID().uuidString)")

    @Test func pushRequestedDuringASyncIsNotLost() async throws {
        let server = SyncServer(store: WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("server.sqlite")), node: "server"))
        let local = WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("a.sqlite")), node: "a")
        let c = ServerSync(store: local, baseURL: URL(string: "https://example.invalid")!, token: "t")
        var editDuringPush: RecordID?
        c.transport = { req in
            await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch req.url!.path {
                case "/sync/v2/pull":
                    return (200, try! JSONEncoder().encode(server.pullPage(after: Int64(q["after"] ?? "0") ?? 0, limit: 500)))
                case "/sync/v2/push":
                    let p = try! JSONDecoder().decode(SyncPush.self, from: req.httpBody!)
                    let reply = server.pushV2(p)
                    if editDuringPush == nil {
                        // The user types while the first push is on the wire; the debounced push fires now.
                        editDuringPush = local.createPage(title: "Typed during sync")
                        Task { @MainActor in await c.syncNow() }
                    }
                    return (200, try! JSONEncoder().encode(reply))
                default:
                    return (404, Data())
                }
            }
        }
        local.createPage(title: "First")
        await c.syncNow()
        // Let the concurrent syncNow (which only flags a rerun) run first if it hasn't yet.
        for _ in 0..<20 where server.store.blocks[editDuringPush ?? ""] == nil { try await Task.sleep(nanoseconds: 5_000_000) }
        let id = try #require(editDuringPush)
        #expect(server.store.blocks[id] != nil)
    }
}
