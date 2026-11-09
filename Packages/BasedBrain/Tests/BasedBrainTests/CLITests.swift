import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-54: `based` — argument parsing, configuration without secrets on the command line, commands against an
/// in-process MCP server.
@MainActor
struct CLITests {
    private func parse(_ s: [String]) throws -> CLICommand { try CLIArguments.parse(s).0 }

    @Test func parsesTheCommands() throws {
        #expect(try parse([]) == .help)
        #expect(try parse(["--help"]) == .help)
        #expect(try parse(["ask", "Summarise", "today"]) == .ask(task: "Summarise today", kind: nil, project: nil))
        #expect(try parse(["ask", "Fix it", "--kind", "code", "--project=Based"]) == .ask(task: "Fix it", kind: "code", project: "Based"))
        #expect(try parse(["runs"]) == .runs(status: nil, limit: nil))
        #expect(try parse(["runs", "--running"]) == .runs(status: "Running", limit: nil))
        #expect(try parse(["runs", "--status", "needs you", "--limit", "5"]) == .runs(status: "Needs you", limit: 5))
        #expect(try parse(["run", "abc"]) == .run(id: "abc"))
        #expect(try parse(["page", "get", "Meeting", "notes"]) == .pageGet(ref: "Meeting notes"))
        #expect(try parse(["page", "new", "--title", "Idea", "--project", "Based"]) == .pageNew(title: "Idea", project: "Based", parent: nil))
        #expect(try parse(["search", "--", "--weird"]) == .search(query: "--weird", limit: nil))
        #expect(try parse(["sandbox", "shell", "r1"]) == .sandboxShell(runID: "r1"))
        #expect(try parse(["login", "--url", "https://b.example"]) == .login(url: "https://b.example"))
        let (_, o) = try CLIArguments.parse(["inbox", "--json", "--url", "https://x", "--token-file", "/tmp/t"])
        #expect(o == CLIOptions(url: "https://x", tokenFile: "/tmp/t", json: true))
    }

    @Test func rejectsBadInputAndSecretsOnTheCommandLine() {
        for argv in [["ask"], ["runs", "--running", "--status", "Done"], ["runs", "--status", "Sleeping"], ["runs", "--limit", "0"],
                     ["run"], ["run", "a", "b"], ["page"], ["page", "new"], ["page", "new", "--title", "x", "--project", "a", "--parent", "b"],
                     ["page", "new", "--title", "x", "body"], ["ask", "x", "--kind", "dance"], ["runs", "--title", "x"],
                     ["frobnicate"], ["search"], ["login"], ["login", "secret", "--url", "https://x"], ["runs", "--bogus"],
                     ["runs", "--limit"]] {
            #expect(throws: CLIError.self, "\(argv)") { try CLIArguments.parse(argv) }
        }
        for flag in ["--token", "--token=abc", "-t", "--api-key=sk"] {
            do { _ = try CLIArguments.parse(["runs", flag, "abc"]); Issue.record("accepted \(flag)") }
            catch let e as CLIError { #expect(e.message.contains("BASED_TOKEN") && !e.message.contains("abc")) }
            catch { Issue.record("\(error)") }
        }
    }

    @Test func resolvesTheConfigurationInOrder() throws {
        let home = "/home/u"
        let cfg = CLIConfig.path(home: home)
        #expect(cfg == "/home/u/.config/based/config.json")
        var files: [String: String] = [cfg: CLIConfig.fileContents(url: "https://file.example", token: "file-token")]
        var modes: [String: Int] = [cfg: 0o600]
        func resolve(_ o: CLIOptions = CLIOptions(), _ env: [String: String] = [:]) throws -> CLIConfig {
            try CLIConfig.resolve(options: o, env: env, home: home, readFile: { files[$0] }, fileMode: { modes[$0] })
        }
        #expect(try resolve() == CLIConfig(url: "https://file.example", token: "file-token", tokenSource: cfg))
        #expect(try resolve(CLIOptions(), ["BASED_URL": "https://env.example", "BASED_TOKEN": "env"]).token == "env")
        #expect(try resolve(CLIOptions(url: "http://127.0.0.1:8787"), ["BASED_URL": "https://env.example"]).url == "http://127.0.0.1:8787")
        files["/run/secrets/based"] = "secret-from-file\n"; modes["/run/secrets/based"] = 0o400
        let f = try resolve(CLIOptions(tokenFile: "/run/secrets/based"))
        #expect(f.token == "secret-from-file" && f.tokenSource == "file /run/secrets/based")
        #expect(try resolve(CLIOptions(), ["BASED_TOKEN_FILE": "/run/secrets/based"]).token == "secret-from-file")
        // Readable by others → refused (token file and config file).
        modes["/run/secrets/based"] = 0o644
        #expect(throws: CLIError.self) { try resolve(CLIOptions(tokenFile: "/run/secrets/based")) }
        modes[cfg] = 0o644
        #expect(throws: CLIError.self) { try resolve() }
        modes[cfg] = 0o600
        // Plain http only for localhost; no URL or no token → a hint.
        #expect(throws: CLIError.self) { try resolve(CLIOptions(url: "http://based.example")) }
        files = [:]
        #expect(throws: CLIError.self) { try resolve() }
        #expect(throws: CLIError.self) { try resolve(CLIOptions(url: "https://x")) }
        files[cfg] = "not json"
        #expect(throws: CLIError.self) { try resolve() }
        // The file `based login` writes round-trips.
        let v = try JSONValue.parse(CLIConfig.fileContents(url: "https://a", token: "t\"q"))
        #expect(v["url"]?.string == "https://a" && v["token"]?.string == "t\"q")
    }

    private func make() -> (BrainStore, BasedCLI, Locked<[String]>) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let mcp = MCPServer(tools: AgentTools(store: store, brain: brain))
        let sent = Locked<[String]>([])
        let cli = BasedCLI(transport: { body in
            let v = try JSONValue.parse(body)
            sent.sync { $0.append(v["params"]?["name"]?.string ?? "") }
            let out = await mcp.handle(body) ?? Data()
            return (200, out)
        })
        return (brain, cli, sent)
    }

    private func run(_ cli: BasedCLI, _ argv: [String], stdin: String = "") async throws -> String {
        var lines: [String] = []
        try await cli.execute(try CLIArguments.parse(argv).0, stdin: { stdin }, out: { lines.append($0) })
        return lines.joined(separator: "\n")
    }

    @Test func commandsTalkToTheServer() async throws {
        let (brain, cli, sent) = make()
        let r = brain.startRun(title: "Market analysis", kind: .subagent)
        let done = brain.startRun(title: "Old job", kind: .schedule)
        brain.finish(run: done, status: .done, result: "ok")

        let running = try await run(cli, ["runs", "--running"])
        #expect(running.contains("Market analysis") && !running.contains("Old job"))
        #expect(try await run(cli, ["run", r]).contains("Market analysis"))

        // page new under a project (by name), body from stdin; page get by title and by id.
        let project = brain.createProject(name: "Based")
        let created = try await run(cli, ["page", "new", "--title", "CLI idea", "--project", "Based"], stdin: "Hello from the terminal")
        let pageID = try #require(BasedCLI.ids(in: created).first)
        #expect(brain.store.blocks[pageID]?.parent == .block(project))
        let byTitle = try await run(cli, ["page", "get", "CLI idea"])
        #expect(byTitle.contains("Hello from the terminal"))
        #expect(try await run(cli, ["page", "get", pageID]).contains("Hello from the terminal"))
        #expect(try await run(cli, ["search", "terminal"]).contains("CLI idea"))
        #expect(sent.current.contains("get_project") && sent.current.contains("create_page"))

        // Tool errors become CLI errors (non-zero exit in the executable).
        await #expect(throws: CLIError.self) { _ = try await run(cli, ["run", "no-such-run"]) }
        await #expect(throws: CLIError.self) { _ = try await run(cli, ["page", "get", "nothing like this"]) }
        await #expect(throws: CLIError.self) { _ = try await run(cli, ["sandbox", "shell", r]) }
    }

    @Test func sandboxShellAndHTTPErrors() async throws {
        #expect(try BasedCLI.shellCommand(sandbox: "docker:based-run-1", runID: "r") == "docker exec -it based-run-1 /bin/sh")
        #expect(try BasedCLI.shellCommand(sandbox: "local:/tmp/sb/r1", runID: "r") == "cd /tmp/sb/r1 && exec \"${SHELL:-/bin/sh}\"")
        #expect(throws: CLIError.self) { try BasedCLI.shellCommand(sandbox: "docker:x;rm -rf /", runID: "r") }
        #expect(throws: CLIError.self) { try BasedCLI.shellCommand(sandbox: "local:/tmp/$(id)", runID: "r") }

        // get_run reports the sandbox, `based sandbox shell` turns it into the command.
        let (brain, cli, _) = make()
        let sid = brain.createSession(title: "Coding", agentID: "claude", machine: "", cwd: "", encrypted: false)
        brain.updateSession(sid, status: .running)
        let run = try #require(brain.latestRun(forSession: sid))
        brain.noteSandbox(session: sid, SandboxHandle(provider: "docker", id: "basedsb1", project: "p", workdir: "/w", hostWorkspace: "/h", image: "img", snapshots: []))
        let out = try await self.run(cli, ["sandbox", "shell", run.id])
        #expect(out == "docker exec -it basedsb1 /bin/sh")

        let denied = BasedCLI(transport: { _ in (401, Data()) })
        await #expect(throws: CLIError.self) { try await denied.execute(.inbox, out: { _ in }) }
        let broken = BasedCLI(transport: { _ in (500, Data("boom".utf8)) })
        do { try await broken.execute(.inbox, out: { _ in }); Issue.record("no error") }
        catch let e as CLIError { #expect(e.message.contains("500") && e.message.contains("boom")) }
    }
}
