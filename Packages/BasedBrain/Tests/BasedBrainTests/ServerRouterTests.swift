import Foundation
import Testing
import BasedCore
@testable import BasedBrain
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// BSD-34 (ADR 0006): based-server's route table behind one router – auth from the header only, owner-only by default,
/// body limits, CORS only for BASED_PUBLIC_URL, loopback without a token. Everything in-process except the
/// socket-level limits, which use a real HTTPServer on 127.0.0.1.
@MainActor
@Suite struct ServerRouterTests {
    static let owner = "owner-secret-token"

    struct Fixture {
        let store: WorkspaceStore
        let share: ShareService
        let happier: HappierRuntime
        let router: ServerRouter
    }

    func fixture(token: String = ServerRouterTests.owner, origin: String? = nil,
                 persistence: Persistence? = nil) throws -> Fixture {
        let store = WorkspaceStore(persistence: try persistence ?? SQLitePersistence(url: nil), node: "server")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let runtime = AgentRuntime(registry: ModelRegistry(), tools: tools)
        let happier = HappierRuntime(brain: brain, connections: nil, agents: [], machineName: "test")
        happier.mcpSessionTokens = MCPSessionTokens()
        let mcp = MCPServer(tools: tools)
        let share = ShareService(store: store)
        let services = BasedServerServices(store: store, tools: tools, mcp: mcp, sync: SyncServer(store: store), runtime: runtime,
                                           happier: happier, share: share)
        return Fixture(store: store, share: share, happier: happier,
                       router: BasedServerRoutes.router(services, ownerToken: token, allowedOrigin: origin))
    }

    func req(_ method: String, _ path: String, bearer: String? = nil, query: [String: String] = [:], body: Data = Data(),
             headers: [String: String] = [:]) -> HTTPServer.Request {
        var h = headers
        if let bearer { h["authorization"] = "Bearer \(bearer)" }
        return HTTPServer.Request(method: method, path: path, query: query, headers: h, body: body)
    }

    // MARK: The table

    @Test func everyProtectedRouteRejectsCallersWithoutTheOwnerToken() async throws {
        let f = try fixture()
        let protected = f.router.routes.filter { $0.access != .public }
        #expect(protected.count >= 35, "the whole server is in the table")
        for route in protected {
            let path = route.samplePath()
            for r in [req(route.method, path),
                      req(route.method, path, query: ["token": Self.owner]),       // ?token= is never read
                      req(route.method, path, bearer: "wrong"),
                      req(route.method, path, bearer: MCPSessionTokens.prefix + "forged")] {
                let resp = await f.router.handle(r)
                #expect(resp.status == 401, "\(route.method) \(route.pattern) → \(resp.status)")
            }
        }
    }

    @Test func onlyTheKnownRoutesArePublic() throws {
        let f = try fixture()
        let open = Set(f.router.routes.filter { $0.access == .public }.map { "\($0.method) \($0.pattern)" })
        #expect(open == ["GET /health", "GET /", "GET /mcp", "GET /app", "GET /.well-known/apple-app-site-association",
                         "GET /s/*", "GET /p/*", "GET /p/*/*", "GET /p/*/*/html/*", "POST /share/v1/invites/accept"])
        let configured = Set(f.router.routes.filter { $0.access == .ownerConfigured }.map(\.pattern))
        #expect(configured == ["/sandboxes", "/sandboxes/*/snapshot", "/sandboxes/*/restore", "/sandboxes/*/destroy"])
        #expect(f.router.routes.filter { $0.access == .session }.map(\.pattern) == ["/mcp/session/*"])
    }

    // MARK: Published pages

    /// HTML blocks on published pages: the page's nonce CSP would block a srcdoc frame's scripts, so the block loads
    /// from its own URL in a CSP sandbox (opaque origin) – and only blocks inside the published page are served.
    @Test func publishedHTMLBlocksLoadSandboxedFromTheirOwnURL() async throws {
        let f = try fixture()
        let page = f.store.createPage(title: "Published")
        var props = BlockProps(); props.language = "html"
        let block = f.store.insertBlock(.code, text: "<script>document.body.textContent = 1</script>", props: props, in: .block(page))
        let other = f.store.createPage(title: "Private")
        let secret = f.store.insertBlock(.code, text: "<b>private</b>", props: props, in: .block(other))
        let link = try f.share.createLink(.publish, pageID: page, role: .view, by: .owner).link

        let html = await f.router.handle(req("GET", "/p/\(link.id)"))
        #expect(html.status == 200)
        let body = String(decoding: html.body, as: UTF8.self)
        #expect(body.contains("src=\"/p/\(link.id)/\(page)/html/\(block)\""))
        #expect(!body.contains("srcdoc="))
        #expect(html.headers["Content-Security-Policy"]?.contains("frame-src 'self' https:") == true)

        let frame = await f.router.handle(req("GET", "/p/\(link.id)/\(page)/html/\(block)"))
        #expect(frame.status == 200)
        #expect(frame.headers["Content-Security-Policy"] == "sandbox allow-scripts")
        #expect(String(decoding: frame.body, as: UTF8.self).contains("<script>"))

        #expect(await f.router.handle(req("GET", "/p/\(link.id)/\(page)/html/\(secret)")).status == 404, "outside the published page")
        #expect(await f.router.handle(req("GET", "/p/unknown/\(page)/html/\(block)")).status == 404)
    }

    // MARK: Existing behaviour

    @Test func publicAndOwnerRoutesBehaveAsBefore() async throws {
        let f = try fixture()
        let health = await f.router.handle(req("GET", "/health"))
        #expect(health.status == 200)
        #expect(try JSONValue.parse(health.body)["name"]?.string == "based-server")
        #expect(await f.router.handle(req("GET", "/")).status == 200)
        #expect(await f.router.handle(req("GET", "/mcp")).status == 405)
        let app = await f.router.handle(req("GET", "/app/"))
        #expect(app.status == 200 && app.headers["Content-Security-Policy"]?.contains("nonce-") == true)
        #expect(await f.router.handle(req("GET", "/nope", bearer: Self.owner)).status == 404)
        #expect(await f.router.handle(req("GET", "/s/bdl_unknown")).status == 404)
        #expect(await f.router.handle(req("GET", "/p/unknown")).status == 404)
        // Wrong method on a known path: 405 with Allow.
        let wrong = await f.router.handle(req("DELETE", "/inbox", bearer: Self.owner))
        #expect(wrong.status == 405 && wrong.headers["Allow"] == "GET")

        let info = await f.router.handle(req("GET", "/sync/v2/info", bearer: Self.owner))
        #expect(info.status == 200)
        #expect(try JSONValue.parse(info.body)["protocol"]?.number == 2)

        // Sync v2 round trip with the owner token.
        let page = f.store.createPage(title: "Router")
        let pull = await f.router.handle(req("GET", "/sync/v2/pull", bearer: Self.owner, query: ["after": "0"]))
        #expect(pull.status == 200)
        let decoded = try JSONDecoder().decode(SyncPage.self, from: pull.body)
        #expect(decoded.records.contains { $0.key.id == page })

        // Inbox: the first answer wins, the second gets 409 (BSD-50).
        let item = f.happier.brain.addInbox(title: "Allow?", kind: .permission, sessionID: nil, detail: "", options: [(id: "allow_once", label: "Allow"), (id: "reject_once", label: "Reject")])
        let body = try JSONValue.object(["decision": "allow_once"]).encoded()
        #expect(await f.router.handle(req("POST", "/inbox/\(item)/resolve", bearer: Self.owner, body: body)).status == 200)
        #expect(await f.router.handle(req("POST", "/inbox/\(item)/resolve", bearer: Self.owner, body: body)).status == 409)

        #expect(await f.router.handle(req("GET", "/sandboxes", bearer: Self.owner)).status == 200)
        #expect(await f.router.handle(req("GET", "/connections", bearer: Self.owner)).status == 200)
    }

    @Test func sessionTokenOpensOnlyItsOwnMCPSession() async throws {
        let f = try fixture()
        let token = try #require(f.happier.mcpSessionTokens).token(for: "s1")
        let initialize = try JSONValue.object(["jsonrpc": "2.0", "id": 1, "method": "initialize",
                                               "params": ["protocolVersion": "2025-06-18", "capabilities": [:],
                                                          "clientInfo": ["name": "t", "version": "1"]]]).encoded()
        #expect(await f.router.handle(req("POST", "/mcp/session/s1", bearer: token, body: initialize)).status == 200)
        #expect(await f.router.handle(req("POST", "/mcp/session/s2", bearer: token, body: initialize)).status == 401)
        #expect(await f.router.handle(req("POST", "/mcp", bearer: token, body: initialize)).status == 401)
        #expect(await f.router.handle(req("GET", "/sync/v2/info", bearer: token)).status == 401)
        // The owner token opens every session.
        #expect(await f.router.handle(req("POST", "/mcp/session/s2", bearer: Self.owner, body: initialize)).status == 200)
    }

    @Test func sharedViewerCanReadButNotPushOrUseOwnerRoutes() async throws {
        let f = try fixture()
        let shared = f.store.createPage(title: "Shared")
        let para = f.store.insertBlock(.text, text: "hello", in: .block(shared))
        let link = try f.share.createLink(.access, pageID: shared, role: .view, by: .owner)

        let me = await f.router.handle(req("GET", "/share/v1/me", bearer: link.secret))
        #expect(me.status == 200)
        #expect(try JSONValue.parse(me.body)["kind"]?.string == "link")
        let pull = await f.router.handle(req("GET", "/sync/v2/pull", bearer: link.secret))
        #expect(pull.status == 200)

        var b = try #require(f.store.blocks[para]); b.text = RichText("changed"); b.stamp = Stamp(millis: Int64.max / 4, counter: 0, node: "web")
        let push = try JSONEncoder().encode(SyncPush(records: [.block(b)], deletions: []))
        let pushed = await f.router.handle(req("POST", "/sync/v2/push", bearer: link.secret, body: push))
        #expect(pushed.status == 200)
        #expect(f.store.blocks[para]?.text.plainText == "hello", "a view role can't change anything")
        let insert = try JSONValue.object(["after": .string(para), "text": "x"]).encoded()
        #expect(await f.router.handle(req("POST", "/api/blocks/insert-after", bearer: link.secret, body: insert)).status == 403)

        // Owner-only routes: 403 for a shared principal (it is someone, just not the owner).
        for (m, p) in [("GET", "/sync/v2/info"), ("GET", "/inbox"), ("POST", "/mcp"), ("GET", "/sync/pull"), ("GET", "/sandboxes")] {
            let s = await f.router.handle(req(m, p, bearer: link.secret)).status
            #expect(s == (p == "/sandboxes" ? 401 : 403), "\(m) \(p) → \(s)")
        }
        #expect(await f.router.handle(req("GET", "/share/v1/resolve", bearer: link.secret)).status == 403)
    }

    @Test func openServerTreatsEveryoneAsOwnerButHidesSandboxes() async throws {
        let f = try fixture(token: "")
        #expect(await f.router.handle(req("GET", "/sync/v2/info")).status == 200)
        #expect(await f.router.handle(req("GET", "/sandboxes")).status == 401)
    }

    // MARK: Limits, errors, CORS

    @Test func bodiesOverTheLimitGet413() async throws {
        let f = try fixture()
        let big = Data(repeating: 0x20, count: ServerRouter.defaultBodyLimit + 1)
        #expect(await f.router.handle(req("POST", "/ask", bearer: Self.owner, body: big)).status == 413)
        #expect(f.router.bodyLimit(method: "POST", path: "/ask") == ServerRouter.defaultBodyLimit)
        #expect(f.router.bodyLimit(method: "POST", path: "/sync/v2/push") == ServerRouter.largeBodyLimit)
        #expect(f.router.bodyLimit(method: "POST", path: "/mcp/session/abc") == ServerRouter.largeBodyLimit)
        // A large push is accepted by the limit (and then rejected as a bad body, not as too large).
        let s = await f.router.handle(req("POST", "/sync/v2/push", bearer: Self.owner, body: big)).status
        #expect(s == 400)
    }

    final class BrokenLog: ChangeLogging {
        struct Broken: Error {}
        func loadAll() throws -> [Record] { [] }
        func write(upserts: [Record], deletions: [RecordKey]) throws {}
        func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {}
        func meta(_ key: String) -> Data? { nil }
        func setMeta(_ key: String, _ value: Data?) {}
        func changes(after: Int64, limit: Int) throws -> [ChangeEntry] { throw Broken() }
        var lastChangeSeq: Int64 { 7 }
    }

    @Test func changeLogErrorIs500NotAnEmptyPage() async throws {
        let f = try fixture(persistence: BrokenLog())
        let r = await f.router.handle(req("GET", "/sync/v2/pull", bearer: Self.owner, query: ["after": "3"]))
        #expect(r.status == 500)
        #expect(throws: BrokenLog.Broken.self) { try SyncServer(store: f.store).tryPullPage(after: 3) }
    }

    @Test func corsOnlyForThePublicOrigin() async throws {
        let f = try fixture(origin: ServerExposure.allowedOrigin(publicURL: "https://Based.example.com:8443/"))
        let ok = await f.router.handle(req("GET", "/health", headers: ["origin": "https://based.example.com:8443"]))
        #expect(ok.headers["Access-Control-Allow-Origin"] == "https://based.example.com:8443")
        let evil = await f.router.handle(req("GET", "/health", headers: ["origin": "https://evil.example"]))
        #expect(evil.headers["Access-Control-Allow-Origin"] == nil)
        let pre = await f.router.handle(req("OPTIONS", "/sync/v2/pull", headers: ["origin": "https://evil.example"]))
        #expect(pre.status == 204 && pre.headers["Access-Control-Allow-Origin"] == nil)
        let none = try fixture()
        #expect(await none.router.handle(req("GET", "/health", headers: ["origin": "https://x.example"])).headers["Access-Control-Allow-Origin"] == nil)
    }

    @Test func noTokenMeansLoopback() {
        #expect(ServerExposure.binding(token: "", insecurePublic: false).loopbackOnly)
        #expect(ServerExposure.binding(token: "", insecurePublic: false).warning != nil)
        let open = ServerExposure.binding(token: "", insecurePublic: true)
        #expect(!open.loopbackOnly && open.warning?.contains("insecure") == true)
        #expect(ServerExposure.binding(token: "t", insecurePublic: false) == .init(loopbackOnly: false, warning: nil))
        #expect(ServerExposure.allowedOrigin(publicURL: nil) == nil)
        #expect(ServerExposure.allowedOrigin(publicURL: "ftp://x") == nil)
        #expect(ServerExposure.allowedOrigin(publicURL: "http://127.0.0.1:8787") == "http://127.0.0.1:8787")
    }

    @Test func bearerComesFromTheHeaderOnly() {
        #expect(HTTPServer.Request(method: "GET", path: "/", query: ["token": "x"]).bearerToken == nil)
        #expect(HTTPServer.Request(method: "GET", path: "/", headers: ["authorization": "Bearer abc "]).bearerToken == "abc")
    }

    // MARK: Socket level

    nonisolated static func connect(_ port: UInt16) -> Int32 {
        #if canImport(Darwin)
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #else
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: UInt32(0x7F00_0001).bigEndian)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Glibc_connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        return fd
    }

    /// Sends `text` and reads until the server closes. A 30 s receive timeout only guards against a hung test.
    nonisolated static func exchange(_ fd: Int32, _ text: String) -> String {
        var tv = timeval(); tv.tv_sec = 30
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        if !text.isEmpty { _ = text.withCString { send(fd, $0, strlen($0), 0) } }
        var out = Data(), buf = [UInt8](repeating: 0, count: 4096)
        while true { let n = recv(fd, &buf, buf.count, 0); if n <= 0 { break }; out.append(buf, count: n) }
        close(fd)
        return String(decoding: out, as: UTF8.self)
    }

    /// Runs blocking socket work on its own thread, so it never occupies the (small) cooperative pool that the
    /// server's request handlers need.
    nonisolated static func offPool<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { cont in Thread { cont.resume(returning: body()) }.start() }
    }

    nonisolated static func request(_ port: UInt16, _ text: String) async -> String {
        await offPool { exchange(connect(port), text) }
    }

    /// BSD-114: no sleeps and no timing assumptions – the test waits for the server's own connection count
    /// (signalled) and the silent client ends its connection itself.
    @Test func socketLimits() async throws {
        let server = HTTPServer(port: 0, loopbackOnly: true, maxConnections: 1, receiveTimeout: 120,
                                bodyLimit: { _, path in path == "/big" ? 10 << 20 : 1 << 10 }) { _ in .json(["ok": true]) }
        try server.start()
        defer { server.stop() }
        let port = server.boundPort

        // Announced body over the limit: 413 without reading it.
        let tooLarge = await Self.request(port, "POST /small HTTP/1.1\r\nContent-Length: 5000\r\n\r\n")
        #expect(tooLarge.hasPrefix("HTTP/1.1 413"))
        // The slot is free as soon as the client sees the end of the answer: back-to-back requests never get 503.
        for _ in 0..<20 {
            let ok = await Self.request(port, "GET /x?token=abc HTTP/1.1\r\n\r\n")
            #expect(ok.hasPrefix("HTTP/1.1 200") && !ok.contains("Access-Control-Allow-Origin"))
        }

        // One silent client holds the only slot: the next one gets 503.
        let idle = Self.connect(port)
        #expect(await Self.offPool { server.waitForActiveConnections { $0 == 1 } })
        let busy = await Self.request(port, "")
        #expect(busy.hasPrefix("HTTP/1.1 503"))
        // The silent client hangs up → the slot is free again.
        close(idle)
        #expect(await Self.offPool { server.waitForActiveConnections { $0 == 0 } })
        #expect(await Self.request(port, "GET /x HTTP/1.1\r\n\r\n").hasPrefix("HTTP/1.1 200"))
    }

    /// SO_RCVTIMEO drops a client that never sends anything (the read ends by itself; no clock in the test).
    @Test func silentClientIsDroppedAfterTheReceiveTimeout() async throws {
        let server = HTTPServer(port: 0, loopbackOnly: true, maxConnections: 1, receiveTimeout: 0.2) { _ in .json(["ok": true]) }
        try server.start()
        defer { server.stop() }
        let port = server.boundPort
        #expect(await Self.request(port, "").isEmpty)
        #expect(await Self.offPool { server.waitForActiveConnections { $0 == 0 } })
        #expect(await Self.request(port, "GET /x HTTP/1.1\r\n\r\n").hasPrefix("HTTP/1.1 200"))
    }
}

#if canImport(Glibc)
private let Glibc_connect = Glibc.connect
#else
private let Glibc_connect = Darwin.connect
#endif
