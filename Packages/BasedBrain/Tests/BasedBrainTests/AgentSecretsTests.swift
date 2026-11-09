import Foundation
import Testing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import BasedBrain
@testable import BasedCore

/// BSD-33: agent children never get the master token on the command line or secrets through the environment.
@Suite struct AgentSecretsTests {
    static let base: [String: String] = [
        "PATH": "/usr/bin:/bin", "HOME": "/home/u", "LANG": "de_AT.UTF-8", "LC_ALL": "de_AT.UTF-8", "XDG_CONFIG_HOME": "/home/u/.config",
        "TERM": "xterm", "HTTPS_PROXY": "http://proxy:3128", "CLAUDE_CONFIG_DIR": "/home/u/.claude", "CODEX_HOME": "/home/u/.codex",
        "BASED_TOKEN": "master-secret", "BASED_CIPHER_KEY": "cipher-secret", "BASED_DB": "/srv/based.sqlite",
        "ANTHROPIC_API_KEY": "sk-ant-x", "OPENAI_API_KEY": "sk-x", "GITHUB_TOKEN": "ghp_x", "AWS_SECRET_ACCESS_KEY": "aws",
        "GEMINI_API_KEY": "gem", "DATABASE_PASSWORD": "pw", "RANDOM_VAR": "x", "bad name": "x",
    ]

    @Test func childEnvironmentIsAllowlisted() {
        let env = ShellEnvironment.childEnvironment(base: Self.base)
        #expect(env["PATH"] == "/usr/bin:/bin" && env["HOME"] == "/home/u" && env["LANG"] != nil)
        #expect(env["LC_ALL"] != nil && env["XDG_CONFIG_HOME"] != nil && env["TERM"] != nil && env["HTTPS_PROXY"] != nil)
        for k in ["BASED_TOKEN", "BASED_CIPHER_KEY", "BASED_DB", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN",
                  "AWS_SECRET_ACCESS_KEY", "GEMINI_API_KEY", "DATABASE_PASSWORD", "RANDOM_VAR", "bad name", "CLAUDE_CONFIG_DIR"] {
            #expect(env[k] == nil, "\(k) must not reach agent children")
        }
        for v in ["master-secret", "cipher-secret", "sk-ant-x", "sk-x", "ghp_x"] { #expect(!env.values.contains(v)) }
    }

    @Test func agentSpecificPassthroughAndExplicitValues() {
        let claude = ShellEnvironment.childEnvironment(base: Self.base, passthrough: ShellEnvironment.agentDefaultPassthrough["claude"] ?? [])
        #expect(claude["CLAUDE_CONFIG_DIR"] == "/home/u/.claude")
        #expect(claude["CODEX_HOME"] == nil && claude["ANTHROPIC_API_KEY"] == nil)
        // A key passes only when the user approved it for this agent.
        let approved = ShellEnvironment.childEnvironment(base: Self.base, passthrough: ["ANTHROPIC_API_KEY"])
        #expect(approved["ANTHROPIC_API_KEY"] == "sk-ant-x" && approved["OPENAI_API_KEY"] == nil)
        // Values Based sets on purpose (Codex: BASED_MCP_TOKEN) are kept.
        let codex = ShellEnvironment.childEnvironment(base: Self.base, extra: ["BASED_MCP_TOKEN": "bds_x"])
        #expect(codex["BASED_MCP_TOKEN"] == "bds_x" && codex["BASED_TOKEN"] == nil)
    }

    @Test func approvedPassthroughComesFromDefaults() throws {
        let suite = "based.tests.\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        d.set("GEMINI_API_KEY, bad-name,GOOGLE_CLOUD_PROJECT", forKey: "based.agentEnv.gemini")
        #expect(ShellEnvironment.approvedPassthrough(for: "gemini", defaults: d) == ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"])
        #expect(ShellEnvironment.passthrough(for: "codex", defaults: d) == ["CODEX_HOME"])
        #expect(ShellEnvironment.passthrough(for: nil, defaults: d).isEmpty)
    }

    @Test func dockerCLIVariablesReachTheSandboxWrapper() {
        // `docker exec -i …` (BSD-53) runs as a host child: it needs DOCKER_HOST, the container only gets `-e NAME` values.
        #expect(ShellEnvironment.childMayInherit("DOCKER_HOST") && ShellEnvironment.childMayInherit("DOCKER_CONTEXT"))
        #expect(!ShellEnvironment.childMayInherit("DOCKER_AUTH_CONFIG"))
    }

    @Test func argumentsNeverContainTheMCPConfigJSON() {
        let token = "bds_SECRETTOKEN"
        let config: JSONValue = ["mcpServers": ["based": ["type": "http", "url": "http://127.0.0.1:1/mcp/session/s",
                                                          "headers": ["Authorization": .string("Bearer \(token)")]]]]
        let d = ClaudeCodeDriver(options: .init(executable: "/bin/true", cwd: "/tmp", mcpConfig: config))
        let a = d.arguments(mcpConfigPath: "/tmp/x/mcp-1.json")
        #expect(a.contains("--mcp-config") && a.contains("/tmp/x/mcp-1.json"))
        #expect(!a.joined(separator: " ").contains(token) && !a.joined(separator: " ").contains("mcpServers"))
        let p = ClaudePrint.streamArguments(prompt: "hi", mcpConfigPath: "/tmp/x/mcp-2.json")
        #expect(!p.joined(separator: " ").contains("mcpServers") && p.contains("/tmp/x/mcp-2.json"))
    }

    @Test func configFileIsPrivateAndRemovable() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mcpcfg-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let f = try MCPConfigFile.write(["mcpServers": ["based": ["headers": ["Authorization": "Bearer bds_x"]]]], in: dir)
        #if os(macOS) || os(Linux)
        let fileMode = try FileManager.default.attributesOfItem(atPath: f.path)[.posixPermissions] as? NSNumber
        let dirMode = try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? NSNumber
        #expect(fileMode?.intValue == 0o600)
        #expect(dirMode?.intValue == 0o700)
        #endif
        let back = try JSONValue.parse(try Data(contentsOf: f.url))
        #expect(back["mcpServers"]?["based"]?["headers"]?["Authorization"]?.string == "Bearer bds_x")
        f.remove()
        #expect(!FileManager.default.fileExists(atPath: f.path))
    }

    #if os(macOS) || os(Linux)
    /// A fake `claude` records its argv and environment: no token in argv, no secrets in env, config file gone after stop.
    @Test func launchedDriverGetsFileNotToken() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakeclaude-sec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("out.txt")
        let exe = dir.appendingPathComponent("claude")
        let script = """
        #!/bin/sh
        { echo "ARGS $*"; i=0; for a in "$@"; do if [ "$prev" = "--mcp-config" ]; then echo "CFG $(cat "$a")"; fi; prev="$a"; done; env | sed 's/^/ENV /'; } > "\(out.path)"
        echo '{"type":"system","subtype":"init","session_id":"s1","tools":[],"mcp_servers":[],"model":"m","permissionMode":"default"}'
        cat > /dev/null
        """
        try script.write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        let token = "bds_LAUNCHTOKEN123"
        let config: JSONValue = ["mcpServers": ["based": ["type": "http", "url": "http://127.0.0.1:1/mcp/session/s",
                                                          "headers": ["Authorization": .string("Bearer \(token)")]]]]
        var opts = ClaudeCodeDriver.Options(executable: exe.path, cwd: dir.path, mcpConfig: config)
        opts.environment = ["EXTRA_FLAG": "1"]
        let d = ClaudeCodeDriver(options: opts)
        try d.start()
        var text = ""
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 50_000_000)
            text = (try? String(contentsOf: out, encoding: .utf8)) ?? ""
            if text.contains("ENV ") && text.contains("CFG ") { break }
        }
        d.stop()
        let args = text.split(separator: "\n").first { $0.hasPrefix("ARGS ") }.map(String.init) ?? ""
        #expect(args.contains("--mcp-config"))
        #expect(!args.contains(token) && !args.contains("mcpServers"))
        #expect(text.contains("CFG ") && text.contains(token))   // the agent reads it from the file
        let envLines = text.split(separator: "\n").filter { $0.hasPrefix("ENV ") }.map { String($0.dropFirst(4)) }
        #expect(envLines.contains("EXTRA_FLAG=1") && envLines.contains("CLAUDE_CODE_ENTRYPOINT=sdk-based"))
        for line in envLines {
            let name = String(line.prefix { $0 != "=" })
            #expect(!name.hasPrefix("BASED_") && !SandboxEnvironmentPolicy.looksSecret(name), "\(name) leaked")
        }
        // The private config file is removed with the process.
        let path = args.split(separator: " ").map(String.init).drop { $0 != "--mcp-config" }.dropFirst().first ?? ""
        #expect(!path.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: path))
    }
    #endif

    @Test func sessionTokensAreScopedAndExpire() {
        let clock = Locked<Date>(Date(timeIntervalSince1970: 1_000))
        let t = MCPSessionTokens(lifetime: 60, now: { clock.sync { $0 } })
        let a = t.token(for: "s1")
        #expect(a.hasPrefix("bds_"))
        #expect(t.token(for: "s1") == a)
        #expect(t.isValid(a, session: "s1"))
        #expect(!t.isValid(a, session: "s2"))
        #expect(!t.isValid("master", session: "s1"))
        clock.sync { $0 = $0.addingTimeInterval(61) }
        #expect(!t.isValid(a, session: "s1"))
        let b = t.token(for: "s1")
        #expect(b != a && t.isValid(b, session: "s1"))
        t.revoke("s1")
        #expect(!t.isValid(b, session: "s1"))
    }

    @Test func sessionTokenOpensOnlyItsOwnMCPRoute() {
        let tokens = MCPSessionTokens()
        let s = tokens.token(for: "abc")
        func ok(_ bearer: String, _ path: String) -> Bool { LocalMCPHost.authorized(bearer: bearer, path: path, master: "M", sessions: tokens) }
        #expect(ok("M", "/mcp") && ok("M", "/mcp/session/abc") && ok("M", "/health"))
        #expect(ok(s, "/mcp/session/abc") && ok(s, "/mcp/session/abc/"))
        #expect(!ok(s, "/mcp") && !ok(s, "/health") && !ok(s, "/mcp/session/other") && !ok(s, "/sync/v2/pull"))
        #expect(!ok("", "/mcp/session/abc") && !ok("wrong", "/mcp"))
        tokens.revoke("abc")
        #expect(!ok(s, "/mcp/session/abc"))
    }

    @MainActor
    @Test func localHostHandsAgentsSessionTokensOverHTTP() async throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "test")
        let host = LocalMCPHost(tools: tools, runtime: runtime)
        let base = try host.start(runtime: runtime)
        defer { host.stop() }
        let cfg = try #require(host.claudeConfig(session: "abc"))
        let header = cfg["mcpServers"]?["based"]?["headers"]?["Authorization"]?.string ?? ""
        #expect(!header.contains(host.token))
        let sessionToken = String(header.dropFirst("Bearer ".count))
        #expect(runtime.mcpToken(for: "abc") == sessionToken)

        func post(_ path: String, _ token: String) async throws -> Int {
            var req = URLRequest(url: URL(string: base + path)!)
            req.httpMethod = "POST"
            req.httpBody = Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (_, r) = try await URLSession.shared.data(for: req)
            return (r as? HTTPURLResponse)?.statusCode ?? 0
        }
        #expect(try await post("/mcp/session/abc", sessionToken) == 200)
        #expect(try await post("/mcp", sessionToken) == 401)
        #expect(try await post("/mcp/session/xyz", sessionToken) == 401)
        runtime.stop("abc")   // session ends → token revoked
        #expect(try await post("/mcp/session/abc", sessionToken) == 401)
    }
}

/// BSD-110: approvals per agent from Settings and from `based-server --agent-env` / `BASED_AGENT_ENV`.
@Suite struct AgentEnvApprovalTests {
    func defaults() throws -> (UserDefaults, String) {
        let suite = "based.tests.\(UUID().uuidString)"
        return (try #require(UserDefaults(suiteName: suite)), suite)
    }

    @Test func serverOptionApprovalShowsUpInPassthrough() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        let parsed = ShellEnvironment.parseAgentEnvSpecs(["claude=ANTHROPIC_API_KEY", "gemini=GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT;codex=OPENAI_API_KEY",
                                                         "claude=CLAUDE_CODE_OAUTH_TOKEN", "broken", "x=bad-name"])
        #expect(parsed.approvals["claude"] == ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
        #expect(parsed.approvals["gemini"] == ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"])
        #expect(parsed.invalid == ["broken", "x=bad-name"])
        ShellEnvironment.applyAgentEnv(parsed.approvals, defaults: d)
        #expect(ShellEnvironment.passthrough(for: "claude", defaults: d) == ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
        #expect(ShellEnvironment.passthrough(for: "codex", defaults: d) == ["CODEX_HOME", "OPENAI_API_KEY"])
        let base = ["PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-ant-x", "OPENAI_API_KEY": "sk-o", "BASED_TOKEN": "t"]
        let env = ShellEnvironment.childEnvironment(base: base, passthrough: ShellEnvironment.passthrough(for: "claude", defaults: d))
        #expect(env["ANTHROPIC_API_KEY"] == "sk-ant-x" && env["OPENAI_API_KEY"] == nil && env["BASED_TOKEN"] == nil)
    }

    @Test func withoutApprovalNothingSecretPasses() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        let base = ["PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-ant-x", "GEMINI_API_KEY": "g"]
        for agent in ["claude", "gemini", "codex"] {
            let env = ShellEnvironment.childEnvironment(base: base, passthrough: ShellEnvironment.passthrough(for: agent, defaults: d))
            #expect(env["ANTHROPIC_API_KEY"] == nil && env["GEMINI_API_KEY"] == nil)
        }
        #expect(ShellEnvironment.unapprovedKeys(for: "claude", base: base, defaults: d) == ["ANTHROPIC_API_KEY"])
        #expect(ShellEnvironment.unapprovedKeys(for: "opencode", base: base, defaults: d).isEmpty)
    }

    @Test func settingsFieldWritesOnlyRealChangesAndClears() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        #expect(ShellEnvironment.setApprovedPassthrough([" GEMINI_API_KEY", "bad name", "GEMINI_API_KEY", "A_B"], for: "gemini", defaults: d) == ["A_B", "GEMINI_API_KEY"])
        #expect(d.string(forKey: "based.agentEnv.gemini") == "A_B,GEMINI_API_KEY")
        #expect(ShellEnvironment.unapprovedKeys(for: "gemini", base: ["GEMINI_API_KEY": "g"], defaults: d).isEmpty)
        ShellEnvironment.setApprovedPassthrough([], for: "gemini", defaults: d)
        #expect(d.object(forKey: "based.agentEnv.gemini") == nil)
        #expect(ShellEnvironment.approvedPassthrough(for: "gemini", defaults: d).isEmpty)
    }

    @Test func doctorFixCommandKeepsExistingApprovals() {
        #expect(AgentDoctor.approveCommand(agent: "claude", names: ["ANTHROPIC_API_KEY"], bundleID: "app.based.mac")
                == "defaults write app.based.mac based.agentEnv.claude ANTHROPIC_API_KEY")
        #expect(AgentDoctor.approveCommand(agent: "claude", names: ["X", "ANTHROPIC_API_KEY"], bundleID: nil)
                == "based-server --agent-env claude=X,ANTHROPIC_API_KEY")
    }
}
