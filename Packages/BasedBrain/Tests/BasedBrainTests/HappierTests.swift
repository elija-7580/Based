import XCTest
import BasedCore
@testable import BasedBrain

final class ChaChaPolyTests: XCTestCase {
    func hex(_ s: String) -> [UInt8] {
        let clean = s.filter { !$0.isWhitespace && $0 != ":" }
        var out: [UInt8] = []; var i = clean.startIndex
        while i < clean.endIndex { let j = clean.index(i, offsetBy: 2); out.append(UInt8(clean[i..<j], radix: 16)!); i = j }
        return out
    }

    /// RFC 8439 §2.8.2 AEAD test vector.
    func testRFC8439Vector() throws {
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        let nonce = hex("070000004041424344454647")
        let aad = hex("50515253c0c1c2c3c4c5c6c7")
        let plaintext = [UInt8]("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let sealed = try ChaChaPoly.seal(plaintext, key: key, nonce: nonce, aad: aad)
        XCTAssertEqual(Array(sealed.prefix(12)), nonce)
        let ct = Array(sealed[12..<(sealed.count - 16)])
        let tag = Array(sealed.suffix(16))
        XCTAssertEqual(Array(ct.prefix(16)), hex("d31a8d34648e60db7b86afbc53ef7ec2"))
        XCTAssertEqual(tag, hex("1ae10b594f09e26a7e902ecbd0600691"))
        let opened = try ChaChaPoly.open(sealed, key: key, aad: aad)
        XCTAssertEqual(opened, plaintext)
    }

    func testTamperDetected() throws {
        let c = SessionCipher.generate()
        let sealed = try c.seal("hello")
        XCTAssertEqual(try c.open(sealed), "hello")
        var bytes = [UInt8](Data(base64Encoded: sealed)!)
        bytes[bytes.count - 1] ^= 0x01
        XCTAssertThrowsError(try c.open(Data(bytes).base64EncodedString()))
        XCTAssertThrowsError(try SessionCipher.generate().open(sealed))
    }

    func testBase64RoundTrip() {
        let c = SessionCipher.generate()
        XCTAssertEqual(SessionCipher(base64: c.base64)?.key, c.key)
        XCTAssertNil(SessionCipher(base64: "short"))
    }
}

final class JSONRPCPeerTests: XCTestCase {
    /// Two peers wired back-to-back: a request from A is answered by B's handler.
    func testRequestResponse() async throws {
        final class Box: @unchecked Sendable { var a: JSONRPCPeer?; var b: JSONRPCPeer? }
        let box = Box()
        let a = JSONRPCPeer { data in box.b?.receive(data) }
        let b = JSONRPCPeer { data in box.a?.receive(data) }
        box.a = a; box.b = b
        b.onRequest = { method, params in
            if method == "echo" { return .success(params ?? .null) }
            return .failure(.methodNotFound(method))
        }
        let r = try await a.request("echo", .object(["x": .number(1)]))
        XCTAssertEqual(r["x"]?.int, 1)
        do { _ = try await a.request("nope"); XCTFail("expected error") }
        catch let e as JSONRPCPeer.RPCError { XCTAssertEqual(e.code, -32601) }
    }

    func testChunkedFraming() async throws {
        final class Box: @unchecked Sendable { var a: JSONRPCPeer?; var b: JSONRPCPeer? }
        let box = Box()
        let a = JSONRPCPeer { data in
            // deliver in two chunks to exercise the newline buffer
            let half = data.count / 2
            box.b?.receive(data.prefix(half)); box.b?.receive(data.suffix(from: half))
        }
        let b = JSONRPCPeer { data in box.a?.receive(data) }
        box.a = a; box.b = b
        b.onRequest = { _, _ in .success(.string("ok")) }
        let r = try await a.request("ping")
        XCTAssertEqual(r.string, "ok")
    }

    func testClosedFailsPending() async {
        let a = JSONRPCPeer { _ in }
        Task { try? await Task.sleep(nanoseconds: 50_000_000); a.closed() }
        do { _ = try await a.request("hang"); XCTFail() } catch { }
    }

    func testSplitCommandLine() {
        let (c, args) = splitCommandLine("npx -y \"@zed-industries/claude-code-acp\" --flag 'a b'")
        XCTAssertEqual(c, "npx")
        XCTAssertEqual(args, ["-y", "@zed-industries/claude-code-acp", "--flag", "a b"])
    }
}

@MainActor
final class HappierStoreTests: XCTestCase {
    func make() -> BrainStore {
        let store = WorkspaceStore(persistence: nil, node: "t")
        return BrainStore(store: store)
    }

    func testSessionsAndTranscript() throws {
        let brain = make()
        let ids = brain.ensureHappier()
        XCTAssertEqual(brain.ensureHappier().sessions, ids.sessions, "idempotent")
        let sid = brain.createSession(title: "Fix bug", agentID: "claude", machine: "mac", cwd: "/tmp", encrypted: true)
        var s = brain.sessions().first { $0.id == sid }
        XCTAssertEqual(s?.status, .idle); XCTAssertEqual(s?.agentID, "claude"); XCTAssertTrue(s?.encrypted ?? false)
        brain.updateSession(sid, status: .running, acpSessionID: "acp-1", addTokens: 120)
        brain.updateSession(sid, addTokens: 30, agentID: "codex")
        s = brain.sessions().first { $0.id == sid }
        XCTAssertEqual(s?.status, .running); XCTAssertEqual(s?.acpSessionID, "acp-1"); XCTAssertEqual(s?.tokens, 150); XCTAssertEqual(s?.agentID, "codex")

        let cipher = SessionCipher.generate()
        brain.appendTranscript(sid, role: "user", markdown: "Hello **agent**", cipher: cipher)
        brain.appendTranscript(sid, role: "agent", markdown: "Hi there", cipher: cipher)
        let plain = brain.transcript(sid, cipher: cipher)
        XCTAssertTrue(plain.contains("Hello **agent**")); XCTAssertTrue(plain.contains("Hi there"))
        let raw = brain.transcript(sid, cipher: nil)
        XCTAssertFalse(raw.contains("Hello **agent**"), "stored encrypted")
        XCTAssertTrue(raw.contains("based-encrypted"))
    }

    func testInbox() {
        let brain = make()
        let sid = brain.createSession(title: "s", agentID: "claude", machine: "m", cwd: "/", encrypted: false)
        let iid = brain.addInbox(title: "Allow write?", kind: .permission, sessionID: sid, detail: "write README.md",
                                 options: [("allow", "Allow"), ("reject", "Reject")])
        var items = brain.inbox(pendingOnly: true)
        XCTAssertEqual(items.count, 1); XCTAssertEqual(items[0].sessionID, sid); XCTAssertEqual(items[0].options, ["allow=Allow", "reject=Reject"])
        brain.resolveInbox(iid, decision: "allow", status: .approved)
        XCTAssertTrue(brain.inbox(pendingOnly: true).isEmpty)
        items = brain.inbox()
        XCTAssertEqual(items[0].status, .approved); XCTAssertEqual(items[0].decision, "allow")
    }

    func testConnections() {
        let brain = make()
        let id = brain.saveConnection(name: "GitHub", transport: .http, command: "https://api.githubcopilot.com/mcp/", envName: "", enabled: true, exposeToAgents: true)
        var c = brain.connections().first { $0.id == id }
        XCTAssertEqual(c?.transport, .http); XCTAssertTrue(c?.enabled ?? false)
        brain.setConnectionStatus(id, "connected (12 tools)")
        c = brain.connections().first { $0.id == id }
        XCTAssertEqual(c?.status, "connected (12 tools)")
        brain.deleteConnection(id)
        XCTAssertNil(brain.connections().first { $0.id == id })
        XCTAssertFalse(BrainStore.connectionCatalog.isEmpty)
    }

    func testAgentToolsExposeHappierSpecs() {
        let brain = make()
        let tools = AgentTools(store: brain.store, brain: brain)
        let names = Set(tools.specs.map(\.name))
        for n in ["create_chart", "add_html", "add_mermaid", "list_connections", "inbox"] { XCTAssertTrue(names.contains(n), n) }
        XCTAssertEqual(AgentTools.slug("Google Drive"), "google_drive")
    }
}
