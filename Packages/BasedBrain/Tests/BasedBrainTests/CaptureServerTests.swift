import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-111: POST /capture on based-server (owner only) and the later transcription of waiting voice notes.
@MainActor
struct CaptureServerTests {
    let routes = ServerRouterTests()

    func post(_ f: ServerRouterTests.Fixture, _ body: String, bearer: String? = ServerRouterTests.owner) async -> HTTPServer.Response {
        await f.router.handle(routes.req("POST", "/capture", bearer: bearer, body: Data(body.utf8)))
    }

    @Test func postCaptureNeedsTheOwnerAndValidInput() async throws {
        let f = try routes.fixture()
        let ok = await post(f, #"{"text": "Idee: EPUB-Export für Publit\nmit Kapiteln"}"#)
        #expect(ok.status == 201)
        let reply = try JSONValue.parse(ok.body)
        let id = try #require(reply["id"]?.string)
        #expect(reply["title"]?.string == "Idee: EPUB-Export für Publit")

        let brain = BrainStore(store: f.store)
        let c = try #require(brain.capture(id))
        #expect(c.source == .shortcut, "default source for HTTP")
        #expect(c.status == .new)
        #expect(c.text.contains("mit Kapiteln"))

        let link = await post(f, #"{"url": "https://example.com/article", "source": "iphone"}"#)
        #expect(link.status == 201)
        let linkID = try #require(JSONValue.parse(link.body)["id"]?.string)
        let l = try #require(brain.capture(linkID))
        #expect(l.link == "https://example.com/article" && l.source == .iPhone)

        #expect(await post(f, #"{"text": "x"}"#, bearer: nil).status == 401)
        #expect(await post(f, #"{"text": "x"}"#, bearer: "wrong").status == 401)
        #expect(await post(f, "").status == 400)
        #expect(await post(f, "[1, 2]").status == 400)
        let empty = await post(f, #"{"text": "   "}"#)
        #expect(empty.status == 400)
        #expect(try JSONValue.parse(empty.body)["error"]?.string?.isEmpty == false)
        #expect(await post(f, #"{"url": "javascript:alert(1)"}"#).status == 400)
        #expect(brain.captures().count == 2, "nothing written for rejected requests")
        // Owner-only by default: not among the public routes.
        #expect(f.router.routes.first { $0.pattern == "/capture" }?.access == .owner)
    }

    @Test func waitingVoiceNotesGetTheirTranscript() async throws {
        let store = WorkspaceStore(persistence: nil, node: "mac")
        let brain = BrainStore(store: store)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bsd111-\(UUID().uuidString)")
        let assets = FileAssetStore(root: root)
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        func note(_ name: String, _ minutes: Double, keepFile: Bool = true) throws -> RecordID {
            let ref = try assets.importData(Data("AAC".utf8), name: name, mime: "audio/mp4")
            if !keepFile { assets.delete(ref) }
            return try brain.addCapture(CaptureInput(audio: ref, source: .watch, capturedAt: t0.addingTimeInterval(minutes * 60)))
        }
        let good = try note("good.m4a", 1)
        let missing = try note("later.m4a", 2, keepFile: false)   // not downloaded to this Mac yet
        let broken = try note("broken.m4a", 3)
        let silent = try note("silent.m4a", 4)
        _ = try brain.addCapture(CaptureInput(text: "Plain text", capturedAt: t0))
        let alreadyDone = try brain.addCapture(CaptureInput(audio: try assets.importData(Data("x".utf8), name: "done.m4a", mime: nil),
                                                            transcript: "Done on the phone", capturedAt: t0))

        #expect(CaptureTranscription.waiting(brain).map(\.id) == [good, missing, broken, silent], "oldest first, only voice notes without text")
        #expect(!brain.pendingCaptures().contains { $0.id == good }, "not sortable before its transcript")

        struct Boom: Error {}
        var asked: [String] = []
        let report = await CaptureTranscription.run(brain, assets: assets) { url in
            asked.append(url.lastPathComponent)
            switch url.lastPathComponent {
            case "broken.m4a": throw Boom()
            case "silent.m4a": return "  "
            default: return "Call the printer about the EPUB proofs"
            }
        }
        #expect(asked == ["good.m4a", "broken.m4a", "silent.m4a"])
        #expect(report.transcribed == 1 && report.notOnDevice == 1 && report.failed.count == 2)

        let g = try #require(brain.capture(good))
        #expect(g.status == .transcribed)
        #expect(g.title == "Call the printer about the EPUB proofs")
        #expect(brain.pendingCaptures().contains { $0.id == good }, "sortable now")
        #expect(brain.capture(alreadyDone)?.status == .transcribed)
        #expect(Set(CaptureTranscription.waiting(brain).map(\.id)) == [missing, broken, silent], "retried next time")
    }

    @Test func schedulerTranscribesBeforeSortCapturesRuns() async throws {
        let store = WorkspaceStore(persistence: nil, node: "mac")
        let brain = BrainStore(store: store)
        let id = brain.saveAgent(name: BrainStore.captureSorterName, instructions: "Sort.", schedule: "every 15m", model: nil)
        let rt = AgentRuntime(registry: ModelRegistry(), tools: AgentTools(store: store, brain: brain))
        let scheduler = AgentScheduler(runtime: rt, node: "Mac")
        final class Seen: @unchecked Sendable { var names: [String] = [] }
        let seen = Seen()
        scheduler.beforeRun = { agent in seen.names.append(agent.name) }
        await scheduler.runDue(now: Date().addingTimeInterval(3600))
        #expect(seen.names == [BrainStore.captureSorterName])
        #expect(brain.agents().first { $0.id == id }?.runningSince == nil, "lease released")
    }
}
