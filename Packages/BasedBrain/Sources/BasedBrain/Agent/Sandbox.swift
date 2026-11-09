import Foundation

// BSD-53: coding agents with a shell (Claude Code, Codex, Gemini …) run inside a sandbox. On the server that is one
// Docker container per run with the project folder mounted at /workspace/<project>; on the Mac it is the plain
// project folder (today's behaviour). Either way the sandbox can be snapshotted and restored.
//
// The Docker provider drives the `docker` CLI through a `CommandRunner`, so the exact command lines are unit-tested
// with a fake runner (there is no Docker in CI). Secrets never travel in argv: environment variables are passed as
// `-e NAME` (value taken from the docker CLI's own environment) and only names on the allowlist cross at all.

/// What a sandbox should look like.
public struct SandboxSpec: Sendable, Equatable {
    /// Project name; becomes part of the container name and the mount point (/workspace/<slug>).
    public var project: String
    /// Host folder with the project's files (bind-mounted read-write into the container).
    public var hostWorkspace: String
    public var image: String
    public var cpus: Double
    public var memoryMB: Int
    /// Network on by default (package installs); off = `--network none`.
    public var network: Bool
    /// Read-only mounts host → container, e.g. the agent CLIs' login config (`~/.claude` → /home/agent/.claude).
    public var readOnlyMounts: [(host: String, container: String)]
    /// Run that owns the sandbox (label only; one container per run).
    public var runID: String?

    public init(project: String, hostWorkspace: String, image: String = SandboxSpec.defaultImage, cpus: Double = 2, memoryMB: Int = 4096,
                network: Bool = true, readOnlyMounts: [(host: String, container: String)] = [], runID: String? = nil) {
        self.project = project; self.hostWorkspace = hostWorkspace; self.image = image; self.cpus = cpus; self.memoryMB = memoryMB
        self.network = network; self.readOnlyMounts = readOnlyMounts; self.runID = runID
    }

    public static let defaultImage = "based-sandbox:latest"

    public static func == (a: SandboxSpec, b: SandboxSpec) -> Bool {
        a.project == b.project && a.hostWorkspace == b.hostWorkspace && a.image == b.image && a.cpus == b.cpus && a.memoryMB == b.memoryMB
            && a.network == b.network && a.runID == b.runID
            && a.readOnlyMounts.map { "\($0.host)\u{0}\($0.container)" } == b.readOnlyMounts.map { "\($0.host)\u{0}\($0.container)" }
    }
}

/// A live sandbox.
public struct SandboxHandle: Sendable, Codable, Equatable, Hashable {
    /// "docker" or "local".
    public var provider: String
    /// Container id (docker) or the workspace path (local).
    public var id: String
    public var project: String
    /// Working directory as seen *inside* the sandbox.
    public var workdir: String
    /// Host folder with the project's files.
    public var hostWorkspace: String
    /// Image the sandbox was started from (docker; the snapshot image after a restore).
    public var image: String
    public var snapshots: [SandboxSnapshot]

    public init(provider: String, id: String, project: String, workdir: String, hostWorkspace: String, image: String = "", snapshots: [SandboxSnapshot] = []) {
        self.provider = provider; self.id = id; self.project = project; self.workdir = workdir; self.hostWorkspace = hostWorkspace
        self.image = image; self.snapshots = snapshots
    }

    /// "docker:<short id>" – what the Runs database stores.
    public var reference: String { "\(provider):\(provider == "docker" ? String(id.prefix(12)) : id)" }

    /// Host path for a path the agent reports from inside the sandbox (nil when it lies outside the workspace).
    public func hostPath(for sandboxPath: String) -> String? {
        if workdir == hostWorkspace { return sandboxPath }
        if sandboxPath == workdir { return hostWorkspace }
        guard sandboxPath.hasPrefix(workdir + "/") else { return nil }
        let rest = sandboxPath.dropFirst(workdir.count + 1)
        // No escaping the mount with "..".
        if rest.split(separator: "/").contains("..") { return nil }
        return hostWorkspace + "/" + rest
    }
}

/// A saved state: container image (docker) plus an archive of the workspace folder.
public struct SandboxSnapshot: Sendable, Codable, Equatable, Hashable {
    public var name: String
    /// Image tag (docker), empty for local.
    public var image: String
    /// tar.gz of the workspace folder on the host.
    public var archive: String
    public var createdAt: Date
    public init(name: String, image: String, archive: String, createdAt: Date) {
        self.name = name; self.image = image; self.archive = archive; self.createdAt = createdAt
    }
}

public struct SandboxExecResult: Sendable, Equatable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String
    public init(exitCode: Int32, stdout: String = "", stderr: String = "") { self.exitCode = exitCode; self.stdout = stdout; self.stderr = stderr }
}

public enum SandboxError: Error, Equatable, CustomStringConvertible {
    case invalidName(String)
    case commandFailed(command: String, exitCode: Int32, stderr: String)
    case unknownSnapshot(String)
    case unavailable(String)

    public var description: String {
        switch self {
        case .invalidName(let n): return "Invalid sandbox or snapshot name: \(n)"
        case .commandFailed(let c, let code, let err): return "\(c) failed (\(code)): \(err.prefix(300))"
        case .unknownSnapshot(let n): return "Unknown snapshot: \(n)"
        case .unavailable(let why): return "Sandbox unavailable: \(why)"
        }
    }
}

/// Runs a command line and collects its output. `environment` is the *complete* environment of the child.
public protocol CommandRunner: Sendable {
    func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult
}

/// Creates, uses, snapshots and removes sandboxes.
public protocol SandboxProvider: Sendable {
    var kind: String { get }
    func create(_ spec: SandboxSpec) async throws -> SandboxHandle
    /// Runs a command to completion inside the sandbox.
    func exec(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String]) async throws -> SandboxExecResult
    /// A long-running agent process (ACP over stdio) inside the sandbox: the same definition, wrapped.
    func wrap(_ agent: AgentDefinition, in sandbox: SandboxHandle, environment: [String: String]) -> AgentDefinition
    func snapshot(_ sandbox: SandboxHandle, name: String) async throws -> SandboxHandle
    func restore(_ sandbox: SandboxHandle, snapshot name: String) async throws -> SandboxHandle
    /// Removes the container. Never deletes the project folder.
    func destroy(_ sandbox: SandboxHandle) async throws
}

// MARK: - Environment allowlist

/// Which environment variables a sandboxed agent gets. Only names on the allowlist pass; secret-looking names
/// (TOKEN, KEY, SECRET, PASSWORD, …) additionally need to be listed in `secrets` explicitly. Logins come from
/// read-only mounted config folders, not from the environment.
public struct SandboxEnvironmentPolicy: Sendable, Equatable {
    public var allow: Set<String>
    public var secrets: Set<String>
    public init(allow: Set<String> = SandboxEnvironmentPolicy.defaultAllow, secrets: Set<String> = []) { self.allow = allow; self.secrets = secrets }

    public static let defaultAllow: Set<String> = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NO_COLOR", "CI", "COLORTERM"]

    public static func looksSecret(_ name: String) -> Bool {
        let n = name.uppercased()
        return ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "PRIVATE", "CREDENTIAL", "AUTH", "COOKIE", "SESSION"]
            .contains { n.contains($0) } || n.hasSuffix("_KEY") || n == "KEY"
    }

    public static func validName(_ name: String) -> Bool {
        guard let f = name.unicodeScalars.first, f == "_" || CharacterSet.letters.contains(f), f.isASCII else { return false }
        return name.unicodeScalars.allSatisfy { $0.isASCII && ($0 == "_" || CharacterSet.alphanumerics.contains($0)) }
    }

    /// The variables of `source` that may enter the sandbox.
    public func filter(_ source: [String: String]) -> [String: String] {
        source.filter { k, _ in
            Self.validName(k) && (secrets.contains(k) || (allow.contains(k) && !Self.looksSecret(k)))
        }
    }
}

enum SandboxNames {
    /// Lower-case slug usable in container names, image tags and paths.
    static func slug(_ s: String) -> String {
        let lowered = s.lowercased().map { c -> Character in (c.isASCII && (c.isLetter || c.isNumber)) ? c : "-" }
        let collapsed = String(lowered).split(separator: "-").joined(separator: "-")
        return collapsed.isEmpty ? "project" : String(collapsed.prefix(48))
    }

    /// Snapshot names: letters, digits, '.', '_', '-' (max 64), not starting with '.' or '-'.
    static func validSnapshot(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 64, let f = s.first, f != ".", f != "-" else { return false }
        return s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }
    }
}

// MARK: - Docker

/// One container per run, driven via the `docker` CLI.
public struct DockerSandboxProvider: SandboxProvider {
    public let kind = "docker"
    public var runner: CommandRunner
    public var docker: String
    /// Where workspace archives of snapshots are kept on the host.
    public var snapshotDirectory: String
    /// Environment of the docker CLI itself (PATH, DOCKER_HOST …); allowlisted values are added per call.
    public var baseEnvironment: [String: String]
    public var now: @Sendable () -> Date

    public init(runner: CommandRunner, docker: String = "docker", snapshotDirectory: String,
                baseEnvironment: [String: String] = DockerSandboxProvider.cliEnvironment(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.runner = runner; self.docker = docker; self.snapshotDirectory = snapshotDirectory; self.baseEnvironment = baseEnvironment; self.now = now
    }

    /// The few variables the docker CLI needs – nothing else of the server's environment is inherited.
    public static func cliEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var out = env.filter { ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].contains($0.key) }
        if out["PATH"] == nil { out["PATH"] = "/usr/local/bin:/usr/bin:/bin" }
        return out
    }

    static func workdir(_ project: String) -> String { "/workspace/" + SandboxNames.slug(project) }

    /// `docker run` arguments for a new sandbox container.
    public func runArguments(_ spec: SandboxSpec, image: String? = nil, name: String) -> [String] {
        var a = ["run", "-d", "--name", name, "--init",
                 "--label", "based.sandbox=1", "--label", "based.project=\(SandboxNames.slug(spec.project))"]
        if let run = spec.runID { a += ["--label", "based.run=\(run)"] }
        a += ["--cpus", String(format: "%g", spec.cpus), "--memory", "\(spec.memoryMB)m", "--pids-limit", "1024",
              "--security-opt", "no-new-privileges"]
        if !spec.network { a += ["--network", "none"] }
        let wd = Self.workdir(spec.project)
        a += ["-v", "\(spec.hostWorkspace):\(wd)"]
        for m in spec.readOnlyMounts { a += ["-v", "\(m.host):\(m.container):ro"] }
        a += ["-w", wd, image ?? spec.image, "sleep", "infinity"]
        return a
    }

    /// `docker exec` arguments; values never appear in argv, only `-e NAME`.
    public func execArguments(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String], interactive: Bool) -> [String] {
        var a = ["exec"]
        if interactive { a.append("-i") }
        a += ["-w", sandbox.workdir]
        for k in environment.keys.sorted() { a += ["-e", k] }
        a.append(sandbox.id)
        return a + command
    }

    private func call(_ args: [String], env: [String: String] = [:]) async throws -> SandboxExecResult {
        var e = baseEnvironment
        for (k, v) in env { e[k] = v }
        let r = try await runner.run(docker, args, environment: e, cwd: nil)
        guard r.exitCode == 0 else {
            throw SandboxError.commandFailed(command: "docker " + (args.first ?? ""), exitCode: r.exitCode, stderr: r.stderr)
        }
        return r
    }

    private func containerName(_ spec: SandboxSpec) -> String {
        let suffix = spec.runID.map(SandboxNames.slug) ?? String(UUID().uuidString.prefix(8)).lowercased()
        return "based-\(SandboxNames.slug(spec.project))-\(suffix.prefix(24))"
    }

    public func create(_ spec: SandboxSpec) async throws -> SandboxHandle {
        let r = try await call(runArguments(spec, name: containerName(spec)))
        let id = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { throw SandboxError.unavailable("docker run returned no container id") }
        return SandboxHandle(provider: kind, id: id, project: spec.project, workdir: Self.workdir(spec.project),
                             hostWorkspace: spec.hostWorkspace, image: spec.image)
    }

    public func exec(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String]) async throws -> SandboxExecResult {
        var e = baseEnvironment
        for (k, v) in environment { e[k] = v }
        return try await runner.run(docker, execArguments(sandbox, command, environment: environment, interactive: false), environment: e, cwd: nil)
    }

    public func wrap(_ agent: AgentDefinition, in sandbox: SandboxHandle, environment: [String: String]) -> AgentDefinition {
        var d = agent
        d.command = docker
        d.arguments = execArguments(sandbox, [agent.command] + agent.arguments, environment: environment, interactive: true)
        // The values reach `docker exec -e NAME` through the docker CLI's environment.
        d.environment = environment
        return d
    }

    func snapshotImage(_ sandbox: SandboxHandle, _ name: String) -> String { "based-snapshot/\(SandboxNames.slug(sandbox.project)):\(name)" }
    func archivePath(_ sandbox: SandboxHandle, _ name: String) -> String {
        snapshotDirectory + "/\(SandboxNames.slug(sandbox.project))-\(name).tar.gz"
    }

    /// Snapshot = `docker commit` of the container (installed packages, caches) + tar.gz of the workspace folder.
    public func snapshot(_ sandbox: SandboxHandle, name: String) async throws -> SandboxHandle {
        guard SandboxNames.validSnapshot(name) else { throw SandboxError.invalidName(name) }
        let image = snapshotImage(sandbox, name)
        _ = try await call(["commit", "--pause=true", "--message", "Based snapshot \(name)", sandbox.id, image])
        let archive = archivePath(sandbox, name)
        try await LocalSandboxProvider.archive(sandbox.hostWorkspace, to: archive, runner: runner, env: baseEnvironment)
        var h = sandbox
        h.snapshots.removeAll { $0.name == name }
        h.snapshots.append(SandboxSnapshot(name: name, image: image, archive: archive, createdAt: now()))
        return h
    }

    /// Restore = replace the container with one from the snapshot image and put the workspace archive back
    /// (the current folder is kept next to it as `<folder>.before-restore-<time>`, nothing is deleted).
    public func restore(_ sandbox: SandboxHandle, snapshot name: String) async throws -> SandboxHandle {
        guard let snap = sandbox.snapshots.first(where: { $0.name == name }) else { throw SandboxError.unknownSnapshot(name) }
        _ = try await call(["rm", "-f", sandbox.id])
        try await LocalSandboxProvider.unarchive(snap.archive, into: sandbox.hostWorkspace, runner: runner, env: baseEnvironment, now: now())
        let spec = SandboxSpec(project: sandbox.project, hostWorkspace: sandbox.hostWorkspace, image: snap.image)
        let r = try await call(runArguments(spec, image: snap.image, name: "based-\(SandboxNames.slug(sandbox.project))-\(SandboxNames.slug(name))-\(Int(now().timeIntervalSince1970))"))
        var h = sandbox
        h.id = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        h.image = snap.image
        return h
    }

    public func destroy(_ sandbox: SandboxHandle) async throws {
        _ = try await call(["rm", "-f", sandbox.id])
    }
}

// MARK: - Local

/// Today's behaviour on the Mac: the agent runs directly in the project folder. Snapshots are tar.gz archives.
public struct LocalSandboxProvider: SandboxProvider {
    public let kind = "local"
    public var runner: CommandRunner
    public var snapshotDirectory: String
    /// PATH etc. for the child (allowlisted values are added).
    public var baseEnvironment: [String: String]
    public var now: @Sendable () -> Date

    public init(runner: CommandRunner, snapshotDirectory: String, baseEnvironment: [String: String] = ["PATH": "/usr/local/bin:/usr/bin:/bin"],
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.runner = runner; self.snapshotDirectory = snapshotDirectory; self.baseEnvironment = baseEnvironment; self.now = now
    }

    public func create(_ spec: SandboxSpec) async throws -> SandboxHandle {
        SandboxHandle(provider: kind, id: spec.hostWorkspace, project: spec.project, workdir: spec.hostWorkspace, hostWorkspace: spec.hostWorkspace)
    }

    public func exec(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String]) async throws -> SandboxExecResult {
        guard let exe = command.first else { throw SandboxError.unavailable("empty command") }
        var e = baseEnvironment
        for (k, v) in environment { e[k] = v }
        return try await runner.run(exe, Array(command.dropFirst()), environment: e, cwd: sandbox.workdir)
    }

    public func wrap(_ agent: AgentDefinition, in sandbox: SandboxHandle, environment: [String: String]) -> AgentDefinition { agent }

    public func snapshot(_ sandbox: SandboxHandle, name: String) async throws -> SandboxHandle {
        guard SandboxNames.validSnapshot(name) else { throw SandboxError.invalidName(name) }
        let archive = snapshotDirectory + "/\(SandboxNames.slug(sandbox.project))-\(name).tar.gz"
        try await Self.archive(sandbox.hostWorkspace, to: archive, runner: runner, env: baseEnvironment)
        var h = sandbox
        h.snapshots.removeAll { $0.name == name }
        h.snapshots.append(SandboxSnapshot(name: name, image: "", archive: archive, createdAt: now()))
        return h
    }

    public func restore(_ sandbox: SandboxHandle, snapshot name: String) async throws -> SandboxHandle {
        guard let snap = sandbox.snapshots.first(where: { $0.name == name }) else { throw SandboxError.unknownSnapshot(name) }
        try await Self.unarchive(snap.archive, into: sandbox.hostWorkspace, runner: runner, env: baseEnvironment, now: now())
        return sandbox
    }

    public func destroy(_ sandbox: SandboxHandle) async throws {}

    static func archive(_ folder: String, to archive: String, runner: CommandRunner, env: [String: String]) async throws {
        let dir = (archive as NSString).deletingLastPathComponent
        let mk = try await runner.run("/bin/mkdir", ["-p", dir], environment: env, cwd: nil)
        guard mk.exitCode == 0 else { throw SandboxError.commandFailed(command: "mkdir", exitCode: mk.exitCode, stderr: mk.stderr) }
        let r = try await runner.run("/usr/bin/env", ["tar", "-C", folder, "-czf", archive, "."], environment: env, cwd: nil)
        guard r.exitCode == 0 else { throw SandboxError.commandFailed(command: "tar", exitCode: r.exitCode, stderr: r.stderr) }
    }

    static func unarchive(_ archive: String, into folder: String, runner: CommandRunner, env: [String: String], now: Date) async throws {
        let aside = folder + ".before-restore-" + String(Int(now.timeIntervalSince1970))
        for (exe, args, label) in [("/bin/mv", [folder, aside], "mv"), ("/bin/mkdir", ["-p", folder], "mkdir"),
                                   ("/usr/bin/env", ["tar", "-C", folder, "-xzf", archive], "tar")] {
            let r = try await runner.run(exe, args, environment: env, cwd: nil)
            guard r.exitCode == 0 else { throw SandboxError.commandFailed(command: label, exitCode: r.exitCode, stderr: r.stderr) }
        }
    }
}

// MARK: - Real runner

/// Runs commands with `Process` (macOS/Linux) and exactly the given environment (nothing inherited).
public struct ProcessCommandRunner: CommandRunner {
    public init() {}
    public func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult {
        #if os(macOS) || os(Linux)
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global().async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: executable.hasPrefix("/") ? executable : ProcessTransport.resolve(executable))
                p.arguments = arguments
                p.environment = environment
                if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
                let out = Pipe(), err = Pipe()
                p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch { cont.resume(throwing: error); return }
                // Read both pipes concurrently so a chatty stderr can't block the child.
                var errData = Data()
                let g = DispatchGroup()
                g.enter()
                DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); g.leave() }
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                g.wait()
                p.waitUntilExit()
                cont.resume(returning: SandboxExecResult(exitCode: p.terminationStatus, stdout: String(decoding: outData, as: UTF8.self),
                                                         stderr: String(decoding: errData, as: UTF8.self)))
            }
        }
        #else
        throw SandboxError.unavailable("processes are not available on this platform")
        #endif
    }
}
