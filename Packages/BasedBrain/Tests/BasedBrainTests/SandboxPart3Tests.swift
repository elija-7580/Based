import Foundation
import Testing
import BasedCore
@testable import BasedBrain

private final class ImageRunner: CommandRunner, @unchecked Sendable {
    let calls = Locked<[[String]]>([])
    var images = ""
    func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult {
        calls.sync { $0.append(arguments) }
        if arguments.first == "images" { return SandboxExecResult(exitCode: 0, stdout: images) }
        return SandboxExecResult(exitCode: 0)
    }
}

/// A "container" provider that runs the agent on the host (so the fake ACP agent can start) but counts as Docker.
private struct HostAsContainer: SandboxProvider {
    let kind = "docker"
    let specs = Locked<[SandboxSpec]>([])
    func create(_ spec: SandboxSpec) async throws -> SandboxHandle {
        specs.sync { $0.append(spec) }
        return SandboxHandle(provider: kind, id: "c1", project: spec.project, workdir: spec.hostWorkspace, hostWorkspace: spec.hostWorkspace)
    }
    func exec(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String]) async throws -> SandboxExecResult { .init(exitCode: 0) }
    func wrap(_ agent: AgentDefinition, in sandbox: SandboxHandle, environment: [String: String]) -> AgentDefinition { agent }
    func snapshot(_ sandbox: SandboxHandle, name: String) async throws -> SandboxHandle { sandbox }
    func restore(_ sandbox: SandboxHandle, snapshot name: String) async throws -> SandboxHandle { sandbox }
    func destroy(_ sandbox: SandboxHandle) async throws {}
}

private func python3Here() -> Bool { ShellEnvironment.which("python3") != nil }

/// BSD-127: Based MCP inside the container, snapshot cleanup.
@Suite struct SandboxPart3Tests {
    @Test func httpServerConfigAndOldDataStillDecodes() throws {
        let http = MCPServerConfig(name: "based", url: "http://host.docker.internal:7000/mcp/session/s1", headers: ["Authorization": "Bearer bds_x"])
        #expect(http.json["type"]?.string == "http")
        #expect(http.json["url"]?.string == "http://host.docker.internal:7000/mcp/session/s1")
        #expect(http.json["headers"] == [["name": "Authorization", "value": "Bearer bds_x"]])
        #expect(http.json["command"] == nil)
        // A stored stdio server from before BSD-127 (no url/headers keys) still decodes as stdio.
        let old = Data(#"{"id":"1","name":"fs","command":"/usr/bin/mcp-fs","args":["-r"],"env":{}}"#.utf8)
        let decoded = try JSONDecoder().decode(MCPServerConfig.self, from: old)
        #expect(decoded.url == nil && decoded.command == "/usr/bin/mcp-fs" && decoded.json["type"] == nil)
    }

    @Test func containerGetsSessionTokenNeverTheMasterToken() {
        #expect(SandboxMCP.containerURL("http://127.0.0.1:7123") == "http://host.docker.internal:7123")
        #expect(SandboxMCP.containerURL("http://localhost:80/x") == "http://host.docker.internal:80/x")
        #expect(SandboxMCP.containerURL("https://based.example.org") == "https://based.example.org")
        let ep = (base: "http://127.0.0.1:7123", token: "MASTER")
        let s = SandboxMCP.servers(endpoint: ep, sessionToken: "bds_abc", session: "s1", network: true)
        #expect(s.count == 1)
        #expect(s.first?.url == "http://host.docker.internal:7123/mcp/session/s1")
        #expect(s.first?.headers == ["Authorization": "Bearer bds_abc"])
        #expect(SandboxMCP.servers(endpoint: ep, sessionToken: nil, session: "s1", network: true).isEmpty, "no session token → nothing")
        #expect(SandboxMCP.servers(endpoint: ep, sessionToken: "MASTER", session: "s1", network: true).isEmpty, "never the master token")
        #expect(SandboxMCP.servers(endpoint: ep, sessionToken: "bds_abc", session: "s1", network: false).isEmpty, "--network none")
        #expect(SandboxMCP.servers(endpoint: nil, sessionToken: "bds_abc", session: "s1", network: true).isEmpty)
    }

    @Test func hostGatewayInRunArgumentsAndCreateBody() {
        var spec = SandboxSpec(project: "P", hostWorkspace: "/w", network: true)
        let cli = DockerSandboxProvider(runner: ImageRunner(), snapshotDirectory: "/s", baseEnvironment: [:])
        #expect(!cli.runArguments(spec, name: "x").contains("--add-host"))
        spec.hostGateway = true
        let a = cli.runArguments(spec, name: "x")
        #expect(a.firstIndex(of: "--add-host").map { a[$0 + 1] } == "host.docker.internal:host-gateway")
        let body = DockerEngineSandboxProvider(api: UnixSocketHTTPTransport(socketPath: "/nope"), cli: cli).createBody(spec)
        #expect(body["HostConfig"]?["ExtraHosts"] == ["host.docker.internal:host-gateway"])
        spec.network = false
        #expect(!cli.runArguments(spec, name: "x").contains("--add-host"))
    }

    @MainActor
    @Test(.enabled(if: python3Here(), "python3 not available"))
    func agentInContainerGetsBasedOverHTTPWithSessionToken() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sbx-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let dump = dir.appendingPathComponent("new.json").path
        let script = #"""
        import sys, json
        def send(o):
            sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
        for line in sys.stdin:
            m = json.loads(line); mid = m.get("id"); meth = m.get("method")
            if meth == "initialize":
                send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {"mcpCapabilities": {"http": True}}}})
            elif meth == "session/new":
                open(sys.argv[1], "w").write(json.dumps(m["params"]))
                send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "x-1"}})
            elif mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
        """#
        try script.write(to: dir.appendingPathComponent("agent.py"), atomically: true, encoding: .utf8)
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let def = AgentDefinition(id: "codex", name: "Codex", command: "/usr/bin/env",
                                  arguments: ["python3", dir.appendingPathComponent("agent.py").path, dump])
        let runtime = HappierRuntime(brain: brain, connections: nil, agents: [def], machineName: "test")
        let provider = HostAsContainer()
        runtime.sandbox = provider
        runtime.mcpEndpoint = (base: "http://127.0.0.1:7123", token: "MASTER-TOKEN")
        let tokens = MCPSessionTokens()
        runtime.mcpSessionTokens = tokens
        let sid = try await runtime.startSession(agentID: "codex", cwd: dir.path, title: "Box")
        defer { runtime.stop(sid) }
        let params = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: dump)))
        let servers = try #require(params["mcpServers"]?.array)
        #expect(servers.count == 1)
        let based = try #require(servers.first)
        #expect(based["type"]?.string == "http" && based["name"]?.string == "based")
        #expect(based["url"]?.string == "http://host.docker.internal:7123/mcp/session/\(sid)")
        let auth = based["headers"]?.array?.first { $0["name"]?.string == "Authorization" }?["value"]?.string ?? ""
        #expect(auth == "Bearer " + tokens.token(for: sid))
        #expect(!String(decoding: try Data(contentsOf: URL(fileURLWithPath: dump)), as: UTF8.self).contains("MASTER-TOKEN"))
        #expect(provider.specs.current.first?.hostGateway == true)
    }

    // MARK: Cleanup

    @Test func cleanupListsOnlyBasedLeftoversAndNeedsConfirmation() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("clean-\(UUID().uuidString)").path
        defer { try? fm.removeItem(atPath: root) }
        let snaps = root + "/snaps", ws = root + "/projects/app"
        for d in [snaps, ws, root + "/projects/app.before-restore-1800000000", root + "/projects/app.before-restore-x",
                  root + "/projects/other.before-restore-1"] {
            try fm.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
        for f in ["app-v1.tar.gz", "app-v2.tar.gz", "notes.txt"] { try Data("x".utf8).write(to: URL(fileURLWithPath: snaps + "/" + f)) }
        let keep = [SandboxSnapshot(name: "v2", image: "based-snapshot/app:v2", archive: snaps + "/app-v2.tar.gz", createdAt: Date())]
        let found = SandboxCleanup.scan(snapshotDirectory: snaps, workspaces: [ws], keep: keep)
        #expect(found.map(\.kind) == [.archive, .restoreBackup])
        #expect(found[0].reference.hasSuffix("app-v1.tar.gz"))
        #expect(found[1].reference.hasSuffix("app.before-restore-1800000000"))

        let runner = ImageRunner()
        runner.images = "based-snapshot/app:v1\nbased-snapshot/app:v2\nbased-snapshot/app:<none>\n"
        let images = await SandboxCleanup.images(runner: runner, environment: [:], keep: keep)
        #expect(images == [SandboxLeftover(kind: .image, reference: "based-snapshot/app:v1")])

        await #expect(throws: SandboxCleanup.NotConfirmed.self) {
            try await SandboxCleanup.remove(found + images, confirmed: false, snapshotDirectory: snaps, runner: runner)
        }
        #expect(fm.fileExists(atPath: snaps + "/app-v1.tar.gz"), "nothing removed without confirmation")
        // Foreign paths are skipped even when passed in.
        let foreign = SandboxLeftover(kind: .archive, reference: ws)
        let removed = try await SandboxCleanup.remove(found + images + [foreign], confirmed: true, snapshotDirectory: snaps, runner: runner)
        #expect(removed.count == 3)
        #expect(!fm.fileExists(atPath: snaps + "/app-v1.tar.gz") && fm.fileExists(atPath: snaps + "/app-v2.tar.gz"))
        #expect(!fm.fileExists(atPath: root + "/projects/app.before-restore-1800000000"))
        #expect(fm.fileExists(atPath: ws) && fm.fileExists(atPath: root + "/projects/app.before-restore-x"))
        #expect(runner.calls.current.contains(["rmi", "based-snapshot/app:v1"]))
    }
}
