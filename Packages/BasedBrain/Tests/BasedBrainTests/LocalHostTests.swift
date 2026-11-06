import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import BasedBrain
@testable import BasedCore

final class LocalHostTests: XCTestCase {
    @MainActor
    func testLocalMCPHostRequiresTokenAndServesTools() async throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "test")
        let host = LocalMCPHost(tools: tools, runtime: runtime)
        let base = try host.start(runtime: runtime)
        defer { host.stop() }
        XCTAssertTrue(base.hasPrefix("http://127.0.0.1:"))
        XCTAssertEqual(runtime.mcpEndpoint?.token, host.token)
        XCTAssertFalse(tools.hostSpecs.isEmpty)

        func post(_ path: String, token: String?, body: String) async throws -> (Int, String) {
            var req = URLRequest(url: URL(string: base + path)!)
            req.httpMethod = "POST"
            req.httpBody = Data(body.utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (d, r) = try await URLSession.shared.data(for: req)
            return ((r as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: d, as: UTF8.self))
        }
        let list = #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
        let (denied, _) = try await post("/mcp", token: "wrong", body: list)
        XCTAssertEqual(denied, 401)
        let (ok, plain) = try await post("/mcp", token: host.token, body: list)
        XCTAssertEqual(ok, 200)
        XCTAssertFalse(plain.contains("\"approval\""))
        let (ok2, scoped) = try await post("/mcp/session/abc", token: host.token, body: list)
        XCTAssertEqual(ok2, 200)
        XCTAssertTrue(scoped.contains("approval"))
        XCTAssertTrue(scoped.contains("spawn_agent"))
        XCTAssertNotNil(host.claudeConfig(session: "abc")?["mcpServers"]?["based"]?["url"]?.string)
    }

    func testClaudePrintArgumentsAndParse() {
        let a = ClaudePrint.arguments(prompt: "hi", resume: "s1", allowedTools: ["mcp__based"], maxTurns: 3)
        XCTAssertEqual(Array(a.prefix(4)), ["-p", "hi", "--output-format", "json"])
        XCTAssertTrue(a.contains("--resume") && a.contains("s1") && a.contains("--allowedTools") && a.contains("--max-turns"))
        let out = "warning: something\n{\"type\":\"result\",\"is_error\":false,\"result\":\"Hello\",\"session_id\":\"abc\",\"total_cost_usd\":0.01}\n"
        let r = ClaudePrint.parse(Data(out.utf8))
        XCTAssertEqual(r?.text, "Hello")
        XCTAssertEqual(r?.sessionID, "abc")
        XCTAssertEqual(r?.isError, false)
        XCTAssertNil(ClaudePrint.parse(Data("not json".utf8)))
    }

    #if os(Linux) || os(macOS)
    func testClaudePrintRunsFakeExecutable() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakeclaude-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let exe = dir.appendingPathComponent("claude")
        try "#!/bin/sh\necho '{\"type\":\"result\",\"is_error\":false,\"result\":\"pong '\"$2\"'\",\"session_id\":\"s-9\"}'\n".write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        let r = await ClaudePrint.ask("ping", executable: exe.path, cwd: dir.path, timeout: 20)
        switch r {
        case .success(let reply): XCTAssertEqual(reply.text, "pong ping"); XCTAssertEqual(reply.sessionID, "s-9")
        case .failure(let e): XCTFail("\(e)")
        }
    }
    #endif
}
