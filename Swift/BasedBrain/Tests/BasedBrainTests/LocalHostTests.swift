import Foundation
import Testing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import BasedBrain
@testable import BasedCore

@Suite struct LocalHostTests {
    @MainActor
    @Test func localMCPHostRequiresTokenAndServesTools() async throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "test")
        let host = LocalMCPHost(tools: tools, runtime: runtime)
        let base = try host.start(runtime: runtime)
        defer { host.stop() }
        #expect(base.hasPrefix("http://127.0.0.1:"))
        #expect(runtime.mcpEndpoint?.token == host.token)
        #expect(!tools.hostSpecs.isEmpty)

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
        #expect(denied == 401)
        let (ok, plain) = try await post("/mcp", token: host.token, body: list)
        #expect(ok == 200)
        #expect(!plain.contains("\"approval\""))
        let (ok2, scoped) = try await post("/mcp/session/abc", token: host.token, body: list)
        #expect(ok2 == 200)
        #expect(scoped.contains("approval"))
        #expect(scoped.contains("spawn_agent"))
        #expect(host.claudeConfig(session: "abc")?["mcpServers"]?["based"]?["url"]?.string != nil)
    }

    @Test func claudePrintArgumentsAndParse() {
        let a = ClaudePrint.arguments(prompt: "hi", resume: "s1", allowedTools: ["mcp__based"], maxTurns: 3)
        #expect(Array(a.prefix(4)) == ["-p", "hi", "--output-format", "json"])
        #expect(a.contains("--resume") && a.contains("s1") && a.contains("--allowedTools") && a.contains("--max-turns"))
        let out = "warning: something\n{\"type\":\"result\",\"is_error\":false,\"result\":\"Hello\",\"session_id\":\"abc\",\"total_cost_usd\":0.01}\n"
        let r = ClaudePrint.parse(Data(out.utf8))
        #expect(r?.text == "Hello")
        #expect(r?.sessionID == "abc")
        #expect(r?.isError == false)
        #expect(ClaudePrint.parse(Data("not json".utf8)) == nil)
    }

    #if os(Linux) || os(macOS)
    @Test func claudePrintRunsFakeExecutable() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakeclaude-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let exe = dir.appendingPathComponent("claude")
        try "#!/bin/sh\necho '{\"type\":\"result\",\"is_error\":false,\"result\":\"pong '\"$2\"'\",\"session_id\":\"s-9\"}'\n".write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        let r = await ClaudePrint.ask("ping", executable: exe.path, cwd: dir.path, timeout: 20)
        switch r {
        case .success(let reply): #expect(reply.text == "pong ping"); #expect(reply.sessionID == "s-9")
        case .failure(let e): Issue.record("\(e)")
        }
    }
    #endif
}
