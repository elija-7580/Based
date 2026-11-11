import Foundation
import Testing
import BasedCore
@testable import BasedBrain

@Suite struct ChaChaPolyTests {
    func hex(_ s: String) -> [UInt8] {
        let clean = s.filter { !$0.isWhitespace && $0 != ":" }
        var out: [UInt8] = []; var i = clean.startIndex
        while i < clean.endIndex { let j = clean.index(i, offsetBy: 2); out.append(UInt8(clean[i..<j], radix: 16)!); i = j }
        return out
    }

    /// RFC 8439 §2.8.2 AEAD test vector.
    @Test func rfc8439Vector() throws {
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        let nonce = hex("070000004041424344454647")
        let aad = hex("50515253c0c1c2c3c4c5c6c7")
        let plaintext = [UInt8]("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let sealed = try ChaChaPoly.seal(plaintext, key: key, nonce: nonce, aad: aad)
        #expect(Array(sealed.prefix(12)) == nonce)
        let ct = Array(sealed[12..<(sealed.count - 16)])
        let tag = Array(sealed.suffix(16))
        #expect(Array(ct.prefix(16)) == hex("d31a8d34648e60db7b86afbc53ef7ec2"))
        #expect(tag == hex("1ae10b594f09e26a7e902ecbd0600691"))
        let opened = try ChaChaPoly.open(sealed, key: key, aad: aad)
        #expect(opened == plaintext)
    }

    @Test func tamperDetected() throws {
        let c = SessionCipher.generate()
        let sealed = try c.seal("hello")
        #expect(try c.open(sealed) == "hello")
        var bytes = [UInt8](Data(base64Encoded: sealed)!)
        bytes[bytes.count - 1] ^= 0x01
        #expect(throws: (any Error).self) { try c.open(Data(bytes).base64EncodedString()) }
        #expect(throws: (any Error).self) { try SessionCipher.generate().open(sealed) }
    }

    @Test func base64RoundTrip() {
        let c = SessionCipher.generate()
        #expect(SessionCipher(base64: c.base64)?.key == c.key)
        #expect(SessionCipher(base64: "short") == nil)
    }
}

@Suite struct JSONRPCPeerTests {
    /// Two peers wired back-to-back: a request from A is answered by B's handler.
    @Test func requestResponse() async throws {
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
        #expect(r["x"]?.int == 1)
        do { _ = try await a.request("nope"); Issue.record("expected error") }
        catch let e as JSONRPCPeer.RPCError { #expect(e.code == -32601) }
    }

    @Test func chunkedFraming() async throws {
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
        #expect(r.string == "ok")
    }

    @Test func closedFailsPending() async throws {
        let a = JSONRPCPeer { _ in }
        Task { try? await Task.sleep(nanoseconds: 50_000_000); a.closed() }
        do { _ = try await a.request("hang"); Issue.record() } catch { }
    }

    @Test func splitsCommandLine() {
        let (c, args) = splitCommandLine("npx -y \"@zed-industries/claude-code-acp\" --flag 'a b'")
        #expect(c == "npx")
        #expect(args == ["-y", "@zed-industries/claude-code-acp", "--flag", "a b"])
    }
}

@MainActor
@Suite struct HappierStoreTests {
    func make() -> BrainStore {
        let store = WorkspaceStore(persistence: nil, node: "t")
        return BrainStore(store: store)
    }

    @Test func sessionsAndTranscript() throws {
        let brain = make()
        let ids = brain.ensureHappier()
        #expect(brain.ensureHappier().sessions == ids.sessions, "idempotent")
        let sid = brain.createSession(title: "Fix bug", agentID: "claude", machine: "mac", cwd: "/tmp", encrypted: true)
        var s = brain.sessions().first { $0.id == sid }
        #expect(s?.status == .idle); #expect(s?.agentID == "claude"); #expect(s?.encrypted ?? false)
        brain.updateSession(sid, status: .running, acpSessionID: "acp-1", addTokens: 120)
        brain.updateSession(sid, addTokens: 30, agentID: "codex")
        s = brain.sessions().first { $0.id == sid }
        #expect(s?.status == .running); #expect(s?.acpSessionID == "acp-1"); #expect(s?.tokens == 150); #expect(s?.agentID == "codex")

        let cipher = SessionCipher.generate()
        brain.appendTranscript(sid, role: "user", markdown: "Hello **agent**", cipher: cipher)
        brain.appendTranscript(sid, role: "agent", markdown: "Hi there", cipher: cipher)
        let plain = brain.transcript(sid, cipher: cipher)
        #expect(plain.contains("Hello **agent**")); #expect(plain.contains("Hi there"))
        let raw = brain.transcript(sid, cipher: nil)
        #expect(!raw.contains("Hello **agent**"), "stored encrypted")
        #expect(raw.contains("based-encrypted"))
    }

    @Test func inbox() {
        let brain = make()
        let sid = brain.createSession(title: "s", agentID: "claude", machine: "m", cwd: "/", encrypted: false)
        let iid = brain.addInbox(title: "Allow write?", kind: .permission, sessionID: sid, detail: "write README.md",
                                 options: [("allow", "Allow"), ("reject", "Reject")])
        var items = brain.inbox(pendingOnly: true)
        #expect(items.count == 1); #expect(items[0].sessionID == sid); #expect(items[0].options == ["allow=Allow", "reject=Reject"])
        brain.resolveInbox(iid, decision: "allow", status: .approved)
        #expect(brain.inbox(pendingOnly: true).isEmpty)
        items = brain.inbox()
        #expect(items[0].status == .approved); #expect(items[0].decision == "allow")
    }

    @Test func connections() {
        let brain = make()
        let id = brain.saveConnection(name: "GitHub", transport: .http, command: "https://api.githubcopilot.com/mcp/", envName: "", enabled: true, exposeToAgents: true)
        var c = brain.connections().first { $0.id == id }
        #expect(c?.transport == .http); #expect(c?.enabled ?? false)
        brain.setConnectionStatus(id, "connected (12 tools)")
        c = brain.connections().first { $0.id == id }
        #expect(c?.status == "connected (12 tools)")
        brain.deleteConnection(id)
        #expect(brain.connections().first { $0.id == id } == nil)
        #expect(!BrainStore.connectionCatalog.isEmpty)
    }

    @Test func agentToolsExposeHappierSpecs() {
        let brain = make()
        let tools = AgentTools(store: brain.store, brain: brain)
        let names = Set(tools.specs.map(\.name))
        for n in ["create_chart", "add_html", "add_mermaid", "list_connections", "inbox"] { #expect(names.contains(n), Comment(rawValue: n)) }
        #expect(AgentTools.slug("Google Drive") == "google_drive")
    }
}
