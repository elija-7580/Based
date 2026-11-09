import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-113: voice notes over POST /capture (stored in the server's asset store, fetched with GET /assets/<id>),
/// and "Sort captures" on the router's Low level.
@MainActor
struct CapturePart3Tests {
    let routes = ServerRouterTests()

    private func fixture() throws -> (store: WorkspaceStore, router: ServerRouter, assets: FileAssetStore, root: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-assets-\(UUID().uuidString)")
        let assets = FileAssetStore(root: root)
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "server")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let happier = HappierRuntime(brain: brain, connections: nil, agents: [], machineName: "test")
        happier.mcpSessionTokens = MCPSessionTokens()
        let services = BasedServerServices(store: store, tools: tools, mcp: MCPServer(tools: tools), sync: SyncServer(store: store),
                                           runtime: AgentRuntime(registry: ModelRegistry(), tools: tools), happier: happier,
                                           share: ShareService(store: store), assets: assets)
        return (store, BasedServerRoutes.router(services, ownerToken: ServerRouterTests.owner, allowedOrigin: nil), assets, root)
    }

    private func post(_ r: ServerRouter, _ json: JSONValue, bearer: String? = ServerRouterTests.owner) async throws -> HTTPServer.Response {
        await r.handle(routes.req("POST", "/capture", bearer: bearer, body: try json.encoded()))
    }

    @Test func audioCaptureIsStoredAndWaitsForItsTranscript() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let audio = Data((0..<4096).map { UInt8($0 % 251) })
        let res = try await post(f.router, ["audio": .string(audio.base64EncodedString()), "audio_name": "../../etc/Walk idea.m4a",
                                            "audio_mime": "audio/mp4", "source": "watch"])
        #expect(res.status == 201)
        let id = try #require(JSONValue.parse(res.body)["id"]?.string)
        let c = try #require(BrainStore(store: f.store).capture(id))
        #expect(c.status == .new && c.needsTranscript && c.source == .watch)
        #expect(c.title.hasPrefix("Voice note "))
        let ref = try #require(c.audio?.asset)
        #expect(ref.name == "Walk idea.m4a" && ref.mime == "audio/mp4" && ref.size == audio.count)
        #expect(f.assets.url(for: ref).flatMap { try? Data(contentsOf: $0) } == audio)
        #expect(f.assets.url(for: ref)?.path.hasPrefix(f.root.path) == true, "no path escapes the asset folder")

        // The Mac fetches the bytes to transcribe them; owner only, unknown or malformed ids → 404/401.
        let get = await f.router.handle(routes.req("GET", "/assets/\(ref.id)", bearer: ServerRouterTests.owner))
        #expect(get.status == 200 && get.body == audio && get.headers["Content-Type"] == "audio/mp4")
        #expect(await f.router.handle(routes.req("GET", "/assets/\(ref.id)")).status == 401)
        #expect(await f.router.handle(routes.req("GET", "/assets/\(UUID().uuidString)", bearer: ServerRouterTests.owner)).status == 404)
        #expect(await f.router.handle(routes.req("GET", "/assets/..", bearer: ServerRouterTests.owner)).status == 404)

        // With a transcript the voice note is sortable right away.
        let t = try await post(f.router, ["audio": .string(audio.base64EncodedString()), "transcript": "Call Anna about the cover"])
        let tid = try #require(JSONValue.parse(t.body)["id"]?.string)
        #expect(BrainStore(store: f.store).capture(tid)?.status == .transcribed)
    }

    @Test func audioCaptureRejectsStrangersBadAndOversizedInput() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let small = Data([1, 2, 3]).base64EncodedString()
        #expect(try await post(f.router, ["audio": .string(small)], bearer: nil).status == 401)
        #expect(try await post(f.router, ["audio": "not base64 !!"]).status == 400)
        #expect(try await post(f.router, ["audio": ""]).status == 400)
        let big = Data(count: CaptureInput.maxAudioBytes + 1).base64EncodedString()
        #expect(try await post(f.router, ["audio": .string(big)]).status == 413)
        // The listener refuses bodies above the route's limit before reading them (413 in HTTPServer).
        #expect(f.router.bodyLimit(method: "POST", path: "/capture") == ServerRouter.largeBodyLimit)
        #expect(BrainStore(store: f.store).captures().isEmpty)

        // A server without an asset store says so instead of dropping the audio.
        let plain = try routes.fixture()
        let res = await plain.router.handle(routes.req("POST", "/capture", bearer: ServerRouterTests.owner,
                                                       body: try (["audio": .string(small)] as JSONValue).encoded()))
        #expect(res.status == 503)
    }

    @Test func fileNamesAreSanitised() {
        #expect(CaptureInput.audioFileName(nil) == "voice-note.m4a")
        #expect(CaptureInput.audioFileName("../../x.m4a") == "x.m4a")
        #expect(CaptureInput.audioFileName("C:\\Users\\a\\memo.wav") == "memo.wav")
        #expect(CaptureInput.audioFileName("..") == "voice-note.m4a")
        #expect(CaptureInput.audioFileName("a<b>|c.m4a") == "abc.m4a")
    }

    @Test func sortCapturesRunsOnTheLowLevel() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        brain.ensureCaptures()
        let sorter = brain.agents().first { $0.name == BrainStore.captureSorterName }
        #expect(sorter?.model == "auto:low")
        #expect(ModelRouter.autoLevel(sorter?.model) == .low)
    }
    /// Point 4: audio that only the server has is downloaded, stored locally and transcribed.
    @Test func transcriptionDownloadsAudioThatIsOnlyOnTheServer() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let audio = Data("RIFF....".utf8)
        let res = try await post(f.router, ["audio": .string(audio.base64EncodedString())])
        let id = try #require(JSONValue.parse(res.body)["id"]?.string)
        let brain = BrainStore(store: f.store)

        // "This Mac": an empty asset store; without a download the note waits.
        let macRoot = FileManager.default.temporaryDirectory.appendingPathComponent("mac-assets-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: macRoot) }
        let mac = FileAssetStore(root: macRoot)
        let waiting = await CaptureTranscription.run(brain, assets: mac) { _ in "never" }
        #expect(waiting.notOnDevice == 1 && waiting.transcribed == 0)

        let router = f.router, owner = ServerRouterTests.owner, routes = self.routes
        var fetched: [String] = []
        let report = await CaptureTranscription.run(brain, assets: mac, download: { ref in
            fetched.append(ref.id)
            let r = await router.handle(routes.req("GET", "/assets/\(ref.id)", bearer: owner))
            guard r.status == 200 else { return nil }
            try? mac.store(r.body, for: ref)
            return mac.url(for: ref)
        }) { url in
            #expect((try? Data(contentsOf: url)) == audio)
            return "Buy oat milk"
        }
        #expect(report.transcribed == 1 && fetched.count == 1)
        #expect(brain.capture(id)?.status == .transcribed && brain.capture(id)?.title == "Buy oat milk")
    }
}
