import Foundation
import Testing
import BasedCore
@testable import BasedBrain

private struct NoRunner: CommandRunner {
    func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult {
        SandboxExecResult(exitCode: 1, stdout: "", stderr: "not in tests")
    }
}

/// BSD-132: the snapshot cleanup through the runtime and the server (owner only, confirmation, fresh scan).
@MainActor
struct SandboxPart4Tests {
    let routes = ServerRouterTests()

    @Test func serverListsAndRemovesOnlyConfirmedLeftoversOfAFreshScan() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("sb4-\(UUID().uuidString)").path
        defer { try? fm.removeItem(atPath: root) }
        let snaps = root + "/snaps", ws = root + "/projects/app"
        for d in [snaps, ws, root + "/projects/app.before-restore-1800000000"] { try fm.createDirectory(atPath: d, withIntermediateDirectories: true) }
        for f in ["app-v1.tar.gz", "app-v2.tar.gz"] { try Data("x".utf8).write(to: URL(fileURLWithPath: snaps + "/" + f)) }

        let f = try routes.fixture()
        let owner = ServerRouterTests.owner
        // No provider: nothing to clean.
        let none = try JSONValue.parse(await f.router.handle(routes.req("GET", "/sandbox/leftovers", bearer: owner)).body)
        #expect(none["sandbox"]?.string == "none" && none["leftovers"]?.array?.isEmpty == true)

        f.happier.sandbox = LocalSandboxProvider(runner: NoRunner(), snapshotDirectory: snaps)
        let brain = BrainStore(store: f.store)
        let sid = brain.createSession(title: "App", agentID: "claude", machine: "", cwd: ws, encrypted: false)
        // A live sandbox: its folder's restore backups are found too.
        _ = try await f.happier.ensureSandbox(sid, cwd: ws)

        #expect(await f.router.handle(routes.req("GET", "/sandbox/leftovers")).status == 401)
        let listed = try JSONValue.parse(await f.router.handle(routes.req("GET", "/sandbox/leftovers", bearer: owner)).body)
        let items = (listed["leftovers"]?.array ?? []).compactMap(SandboxLeftover.init(json:))
        #expect(listed["sandbox"]?.string == "local")
        #expect(Set(items.map(\.kind)) == [.archive, .restoreBackup])
        #expect(items.contains { $0.reference.hasSuffix("app.before-restore-1800000000") })

        func cleanup(_ body: JSONValue) async throws -> HTTPServer.Response {
            await f.router.handle(routes.req("POST", "/sandbox/cleanup", bearer: owner, body: try body.encoded()))
        }
        let refs: [JSONValue] = items.map { .string($0.reference) } + [.string(ws), .string(root)]
        #expect(try await cleanup(["references": .array(refs)]).status == 400, "confirm missing")
        #expect(fm.fileExists(atPath: snaps + "/app-v1.tar.gz"))
        let res = try await cleanup(["references": .array(refs), "confirm": true])
        #expect(res.status == 200)
        let removed = try JSONValue.parse(res.body)["removed"]?.array ?? []
        #expect(removed.count == items.count, "foreign paths (the project, the root) are not in the scan and stay")
        #expect(fm.fileExists(atPath: ws) && fm.fileExists(atPath: root))
        #expect(!fm.fileExists(atPath: root + "/projects/app.before-restore-1800000000"))

        // Without confirmation the runtime refuses too.
        await #expect(throws: SandboxCleanup.NotConfirmed.self) { _ = try await f.happier.cleanUpSandbox(references: [], confirmed: false) }
        #expect(SandboxLeftover(json: ["kind": "nope", "reference": "x"]) == nil)
        let rt = SandboxLeftover(kind: .image, reference: "based-snapshot/app:v1", modified: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(SandboxLeftover(json: rt.json) == rt)
    }
}
