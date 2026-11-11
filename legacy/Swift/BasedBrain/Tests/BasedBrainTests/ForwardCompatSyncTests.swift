import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-25: unknown fields survive a round trip through an older client, and one bad record no longer stalls a pull.
@MainActor
struct ForwardCompatSyncTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fwdsync-\(UUID().uuidString)")

    func store(_ name: String) throws -> WorkspaceStore {
        WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite")), node: name)
    }

    func client(_ s: WorkspaceStore, server: SyncServer) -> ServerSync {
        let c = ServerSync(store: s, baseURL: URL(string: "https://example.invalid")!, token: "t")
        c.transport = { req in
            await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch req.url!.path {
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

    @Test func pullPageWithABrokenRecordAppliesTheRest() throws {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let p1 = s.createPage(title: RichText("One"))
        let p2 = s.createPage(title: RichText("Two"))
        let good1 = String(decoding: try JSONEncoder().encode(Record.block(s.blocks[p1]!)), as: UTF8.self)
        let good2 = String(decoding: try JSONEncoder().encode(Record.block(s.blocks[p2]!)), as: UTF8.self)
            .replacingOccurrences(of: "\"type\":\"page\"", with: "\"type\":\"hologram\"")
        let broken = "{\"kind\":\"block\",\"data\":{\"id\":\"bad\",\"type\":\"text\"}}"
        let alien = "{\"kind\":\"spaceship\",\"data\":{\"id\":\"ufo\"}}"
        let json = "{\"records\":[\(good1),\(broken),\(alien),\(good2)],\"deletions\":[],\"next\":9,\"more\":false}"
        let page = try JSONDecoder().decode(SyncPage.self, from: Data(json.utf8))
        #expect(page.records.map(\.key.id) == [p1, p2])
        guard case .block(let b2) = page.records[1] else { Issue.record(); return }
        #expect(b2.type == .unknown && b2.extra["type"] == "hologram")
        #expect(page.next == 9)

        let reply = "{\"newer\":[\(broken),\(good1)],\"seq\":3}"
        #expect(try JSONDecoder().decode(SyncPushReply.self, from: Data(reply.utf8)).newer.map(\.key.id) == [p1])
    }

    @Test func olderClientKeepsNewerFieldsThroughAnEdit() async throws {
        let srv = try store("server")
        let server = SyncServer(store: srv)
        let newer = try store("newer"), older = try store("older")
        let page = newer.createPage(title: RichText("Shared"))
        let line = newer.insertBlock(.text, text: RichText("Line"), in: .block(page), at: .end)
        // What a newer app version would have written.
        newer.updateBlock(line) { $0.extra["futureField"] = ["a": 1]; $0.props.extra["futureProp"] = "p" }
        newer.updateBlock(page) { $0.type = .unknown; $0.extra["type"] = "superPage" }
        await client(newer, server: server).syncNow()

        await client(older, server: server).syncNow()
        #expect(older.blocks[line]?.extra["futureField"] == ["a": 1])
        older.setText(line, RichText("Edited on the older client"))
        await client(older, server: server).syncNow()

        #expect(srv.blocks[line]?.extra["futureField"] == ["a": 1])
        #expect(srv.blocks[line]?.props.extra["futureProp"] == "p")
        #expect(srv.blocks[page]?.extra["type"] == "superPage")
        await client(newer, server: server).syncNow()
        #expect(newer.blocks[line]?.text.plainText == "Edited on the older client")
        #expect(newer.blocks[line]?.extra["futureField"] == ["a": 1])
        #expect(newer.blocks[line]?.props.extra["futureProp"] == "p")
    }
}
