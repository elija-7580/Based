import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Records every command and answers from a script (no Docker needed).
private final class FakeRunner: CommandRunner, @unchecked Sendable {
    struct Call: Equatable { var exe: String; var args: [String]; var env: [String: String]; var cwd: String? }
    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return _calls }
    /// Answer per first argument ("run", "exec", "commit", "rm", "tar" …).
    var answers: [String: SandboxExecResult] = [:]
    var containerCounter = 0

    func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult {
        lock.lock()
        _calls.append(Call(exe: executable, args: arguments, env: environment, cwd: cwd))
        let key = arguments.first ?? executable
        var answer = answers[key] ?? SandboxExecResult(exitCode: 0)
        if key == "run" && answers[key] == nil { containerCounter += 1; answer = SandboxExecResult(exitCode: 0, stdout: "c0ffee\(containerCounter)\n") }
        lock.unlock()
        return answer
    }
}

private func dockerProvider(_ runner: FakeRunner) -> DockerSandboxProvider {
    DockerSandboxProvider(runner: runner, snapshotDirectory: "/srv/based/snaps", baseEnvironment: ["PATH": "/usr/bin"],
                          now: { Date(timeIntervalSince1970: 1_800_000_000) })
}

private let spec = SandboxSpec(project: "Based App", hostWorkspace: "/srv/projects/based", image: "based-sandbox:1", cpus: 2, memoryMB: 4096,
                               network: true, readOnlyMounts: [(host: "/home/based/.claude", container: "/root/.claude")], runID: "run42")

@Suite struct SandboxProviderTests {
    @Test func dockerCreateBuildsTheRunCommandLine() async throws {
        let runner = FakeRunner()
        let h = try await dockerProvider(runner).create(spec)
        #expect(h.id == "c0ffee1")
        #expect(h.workdir == "/workspace/based-app")
        #expect(h.reference == "docker:c0ffee1")
        let call = try #require(runner.calls.first)
        #expect(call.exe == "docker")
        #expect(call.args == ["run", "-d", "--name", "based-based-app-run42", "--init",
                              "--label", "based.sandbox=1", "--label", "based.project=based-app", "--label", "based.run=run42",
                              "--cpus", "2", "--memory", "4096m", "--pids-limit", "1024", "--security-opt", "no-new-privileges",
                              "-v", "/srv/projects/based:/workspace/based-app", "-v", "/home/based/.claude:/root/.claude:ro",
                              "-w", "/workspace/based-app", "based-sandbox:1", "sleep", "infinity"])
        #expect(call.env == ["PATH": "/usr/bin"], "the docker CLI gets only its own minimal environment")
    }

    @Test func networkOffAddsNetworkNone() {
        var s = spec; s.network = false
        let args = dockerProvider(FakeRunner()).runArguments(s, name: "x")
        #expect(args.contains("--network") && args[args.firstIndex(of: "--network")! + 1] == "none")
        #expect(!dockerProvider(FakeRunner()).runArguments(spec, name: "x").contains("--network"))
    }

    @Test func execPassesOnlyVariableNamesInArgv() async throws {
        let runner = FakeRunner()
        let p = dockerProvider(runner)
        let h = SandboxHandle(provider: "docker", id: "abc", project: "p", workdir: "/workspace/p", hostWorkspace: "/h/p")
        _ = try await p.exec(h, ["swift", "test"], environment: ["LANG": "C.UTF-8", "GH_TOKEN": "s3cret"])
        let call = try #require(runner.calls.last)
        #expect(call.args == ["exec", "-w", "/workspace/p", "-e", "GH_TOKEN", "-e", "LANG", "abc", "swift", "test"])
        #expect(!call.args.joined(separator: " ").contains("s3cret"), "values never appear on the command line")
        #expect(call.env["GH_TOKEN"] == "s3cret" && call.env["PATH"] == "/usr/bin")
    }

    @Test func wrapTurnsAnAgentIntoDockerExecInteractive() {
        let p = dockerProvider(FakeRunner())
        let h = SandboxHandle(provider: "docker", id: "abc", project: "p", workdir: "/workspace/p", hostWorkspace: "/h/p")
        let def = AgentDefinition(id: "codex", name: "Codex", command: "npx", arguments: ["-y", "@zed-industries/codex-acp"])
        let w = p.wrap(def, in: h, environment: ["LANG": "C"])
        #expect(w.command == "docker")
        #expect(w.arguments == ["exec", "-i", "-w", "/workspace/p", "-e", "LANG", "abc", "npx", "-y", "@zed-industries/codex-acp"])
        #expect(w.environment == ["LANG": "C"])
        #expect(w.id == "codex" && w.name == "Codex")
        #expect(LocalSandboxProvider(runner: FakeRunner(), snapshotDirectory: "/s").wrap(def, in: h, environment: [:]) == def)
    }

    @Test func snapshotCommitsAndArchivesThenRestoreReplacesTheContainer() async throws {
        let runner = FakeRunner()
        let p = dockerProvider(runner)
        var h = try await p.create(spec)
        h = try await p.snapshot(h, name: "before-tests")
        #expect(h.snapshots.map(\.name) == ["before-tests"])
        #expect(h.snapshots[0].image == "based-snapshot/based-app:before-tests")
        #expect(h.snapshots[0].archive == "/srv/based/snaps/based-app-before-tests.tar.gz")
        let commit = try #require(runner.calls.first { $0.args.first == "commit" })
        #expect(commit.args == ["commit", "--pause=true", "--message", "Based snapshot before-tests", "c0ffee1", "based-snapshot/based-app:before-tests"])
        let tar = try #require(runner.calls.first { $0.args.first == "tar" })
        #expect(tar.args == ["tar", "-C", "/srv/projects/based", "-czf", "/srv/based/snaps/based-app-before-tests.tar.gz", "."])

        let before = runner.calls.count
        let r = try await p.restore(h, snapshot: "before-tests")
        let steps = runner.calls.dropFirst(before).map { $0.args.first == "-p" ? "mkdir" : ($0.args.first ?? $0.exe) }
        #expect(steps == ["rm", "/srv/projects/based", "mkdir", "tar", "run"], "remove container, move folder aside, unpack, start from snapshot image")
        let mv = runner.calls[before + 1]
        #expect(mv.exe == "/bin/mv" && mv.args == ["/srv/projects/based", "/srv/projects/based.before-restore-1800000000"], "old folder is kept, not deleted")
        let run = try #require(runner.calls.last)
        #expect(run.args.contains("based-snapshot/based-app:before-tests"))
        #expect(r.id == "c0ffee2" && r.image == "based-snapshot/based-app:before-tests")
        #expect(r.snapshots == h.snapshots)
    }

    @Test func errorsAndInvalidNames() async throws {
        let runner = FakeRunner()
        runner.answers["run"] = SandboxExecResult(exitCode: 125, stderr: "Unable to find image")
        let p = dockerProvider(runner)
        await #expect(throws: SandboxError.commandFailed(command: "docker run", exitCode: 125, stderr: "Unable to find image")) {
            _ = try await p.create(spec)
        }
        let h = SandboxHandle(provider: "docker", id: "abc", project: "p", workdir: "/workspace/p", hostWorkspace: "/h/p")
        for bad in ["", "../x", "a b", "x;rm", "-rf", String(repeating: "a", count: 65)] {
            await #expect(throws: SandboxError.invalidName(bad)) { _ = try await p.snapshot(h, name: bad) }
        }
        await #expect(throws: SandboxError.unknownSnapshot("nope")) { _ = try await p.restore(h, snapshot: "nope") }
        #expect(runner.calls.allSatisfy { $0.args.first != "commit" && $0.args.first != "rm" }, "nothing ran for invalid input")
        runner.answers["commit"] = SandboxExecResult(exitCode: 1, stderr: "no such container")
        await #expect(throws: SandboxError.self) { _ = try await p.snapshot(h, name: "ok") }
    }

    @Test func environmentAllowlistKeepsSecretsOut() {
        let source = ["LANG": "de_AT.UTF-8", "PATH": "/x", "ANTHROPIC_API_KEY": "k", "GH_TOKEN": "t", "BASED_TOKEN": "b",
                      "AWS_SECRET_ACCESS_KEY": "a", "HOME": "/root", "TERM": "xterm", "CI": "1", "MY_VAR": "v", "bad-name": "x"]
        #expect(SandboxEnvironmentPolicy().filter(source) == ["LANG": "de_AT.UTF-8", "TERM": "xterm", "CI": "1"])
        var p = SandboxEnvironmentPolicy()
        p.allow.formUnion(["MY_VAR", "GH_TOKEN", "bad-name"])
        #expect(p.filter(source) == ["LANG": "de_AT.UTF-8", "TERM": "xterm", "CI": "1", "MY_VAR": "v"],
                "a secret-looking name on the plain allowlist still stays out")
        p.secrets = ["GH_TOKEN"]
        #expect(p.filter(source)["GH_TOKEN"] == "t", "only an explicit secret entry lets a token through")
        #expect(DockerSandboxProvider.cliEnvironment(["PATH": "/p", "DOCKER_HOST": "unix:///x", "BASED_TOKEN": "b", "OPENAI_API_KEY": "o"])
                == ["PATH": "/p", "DOCKER_HOST": "unix:///x"])
    }

    @Test func hostPathMappingStaysInsideTheWorkspace() {
        let h = SandboxHandle(provider: "docker", id: "abc", project: "p", workdir: "/workspace/p", hostWorkspace: "/srv/p")
        #expect(h.hostPath(for: "/workspace/p/Sources/a.swift") == "/srv/p/Sources/a.swift")
        #expect(h.hostPath(for: "/workspace/p") == "/srv/p")
        #expect(h.hostPath(for: "/workspace/p/../q/x") == nil)
        #expect(h.hostPath(for: "/workspace/pq/x") == nil)
        #expect(h.hostPath(for: "/etc/passwd") == nil)
        let c = ACPClient(definition: AgentDefinition(id: "x", name: "x", command: "x"))
        #expect(c.hostPath("/etc/passwd") == "/etc/passwd")
        c.pathMap = { h.hostPath(for: $0) }
        #expect(c.hostPath("/workspace/p/a") == "/srv/p/a")
        #expect(c.hostPath("/etc/passwd") == nil)
    }

    #if os(macOS) || os(Linux)
    @Test func localSnapshotAndRestoreWithRealTar() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("based-sandbox-\(UUID().uuidString)").path
        let ws = root + "/proj"
        try fm.createDirectory(atPath: ws + "/src", withIntermediateDirectories: true)
        try "one".write(toFile: ws + "/src/a.txt", atomically: true, encoding: .utf8)
        defer { try? fm.removeItem(atPath: root) }
        let p = LocalSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: root + "/snaps")
        var h = try await p.create(SandboxSpec(project: "proj", hostWorkspace: ws))
        #expect(h.workdir == ws && h.reference == "local:\(ws)")
        let echo = try await p.exec(h, ["/bin/sh", "-c", "cat src/a.txt; echo \"[$LANG][$SECRET_X]\""], environment: ["LANG": "C"])
        #expect(echo.exitCode == 0 && echo.stdout == "one[C][]\n", "runs in the folder with exactly the given environment")
        h = try await p.snapshot(h, name: "s1")
        try "two".write(toFile: ws + "/src/a.txt", atomically: true, encoding: .utf8)
        try "new".write(toFile: ws + "/b.txt", atomically: true, encoding: .utf8)
        _ = try await p.restore(h, snapshot: "s1")
        #expect(try String(contentsOfFile: ws + "/src/a.txt", encoding: .utf8) == "one")
        #expect(!fm.fileExists(atPath: ws + "/b.txt"))
        let aside = try fm.contentsOfDirectory(atPath: root).filter { $0.hasPrefix("proj.before-restore-") }
        #expect(aside.count == 1)
        #expect(try String(contentsOfFile: root + "/" + aside[0] + "/src/a.txt", encoding: .utf8) == "two", "the replaced state is kept")
        try await p.destroy(h)
        #expect(fm.fileExists(atPath: ws + "/src/a.txt"), "destroy never deletes the project folder")
    }
    #endif
}

/// The runtime creates one sandbox per session, records it on the run and drives snapshot/restore.
@MainActor
@Suite struct SandboxRuntimeTests {
    @Test func runtimeRecordsSandboxAndSnapshotsOnTheRun() async throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "server")
        let runner = FakeRunner()
        runtime.sandbox = dockerProvider(runner)
        runtime.sandboxTemplate = SandboxSpec(project: "", hostWorkspace: "", image: "img:1", cpus: 1, memoryMB: 1024, network: false)
        #expect(runtime.usesContainerSandbox)
        let sid = brain.createSession(title: "Fix tests", agentID: "codex", machine: "server", cwd: "/srv/projects/based", encrypted: false, project: "Based")
        let run = brain.latestRun(forSession: sid)?.id ?? brain.startRun(title: "Fix tests", kind: .session, sessionID: sid)

        let h = try await runtime.ensureSandbox(sid, cwd: "/srv/projects/based")
        #expect(try await runtime.ensureSandbox(sid, cwd: "/srv/projects/based") == h, "one sandbox per session")
        #expect(runner.calls.filter { $0.args.first == "run" }.count == 1)
        let args = runner.calls[0].args
        #expect(args.contains("img:1") && args.contains("--network") && args.contains("based.run=\(sid)"))
        #expect(brain.sandboxInfo(run: run).reference == "docker:c0ffee1")

        _ = try await runtime.snapshotSandbox(sid, name: "green")
        #expect(brain.sandboxInfo(run: run).snapshots == ["green"])
        let restored = try await runtime.restoreSandbox(sid, snapshot: "green")
        #expect(restored.id == "c0ffee2" && runtime.sandboxHandle(for: sid)?.id == "c0ffee2")
        #expect(brain.sandboxInfo(run: run).reference == "docker:c0ffee2")

        await runtime.destroySandbox(sid)
        #expect(runtime.sandboxHandle(for: sid) == nil)
        #expect(runner.calls.last?.args == ["rm", "-f", "c0ffee2"])
    }

    @Test func localProviderIsNotAContainerAndSnapshotsTheFolder() async throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let runtime = HappierRuntime(brain: brain, connections: nil, machineName: "mac")
        #expect(!runtime.usesContainerSandbox)
        let runner = FakeRunner()
        runtime.sandbox = LocalSandboxProvider(runner: runner, snapshotDirectory: "/snaps")
        #expect(!runtime.usesContainerSandbox)
        let sid = brain.createSession(title: "x", agentID: "claude", machine: "mac", cwd: "/Users/e/p", encrypted: false, project: "p")
        await #expect(throws: SandboxError.self) { _ = try await runtime.restoreSandbox(sid, snapshot: "s") }
        let h = try await runtime.snapshotSandbox(sid, name: "s")
        #expect(h.provider == "local" && h.snapshots.map(\.name) == ["s"])
        #expect(runner.calls.contains { $0.args == ["tar", "-C", "/Users/e/p", "-czf", "/snaps/p-s.tar.gz", "."] })
    }
}
