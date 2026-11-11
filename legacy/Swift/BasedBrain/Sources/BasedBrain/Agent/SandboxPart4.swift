import Foundation

// BSD-132: Sandbox part 4 (first cut) — the cleanup of old snapshots becomes usable: the runtime knows where its
// provider keeps archives and which snapshots are still in use; the server offers it behind the owner token
// (GET /sandbox/leftovers, POST /sandbox/cleanup) and Settings → Agents → Sandbox shows it with a confirmation.

extension SandboxLeftover {
    /// JSON for the server routes / the app.
    public var json: JSONValue {
        var o: [String: JSONValue] = ["kind": .string(kind.rawValue), "reference": .string(reference), "label": .string(label)]
        if let modified { o["modified"] = .string(ISO8601DateFormatter().string(from: modified)) }
        return .object(o)
    }

    public init?(json v: JSONValue) {
        guard let k = v["kind"]?.string.flatMap(Kind.init(rawValue:)), let r = v["reference"]?.string, !r.isEmpty else { return nil }
        self.init(kind: k, reference: r, modified: v["modified"]?.string.flatMap { ISO8601DateFormatter().date(from: $0) })
    }
}

extension HappierRuntime {
    /// Where the configured provider keeps snapshot archives, and how it calls docker (nil = no sandbox provider).
    var sandboxStorage: (directory: String, runner: CommandRunner, docker: String?, environment: [String: String])? {
        switch sandbox {
        case let p as DockerSandboxProvider: return (p.snapshotDirectory, p.runner, p.docker, p.baseEnvironment)
        case let p as DockerEngineSandboxProvider: return (p.cli.snapshotDirectory, p.cli.runner, p.cli.docker, p.cli.baseEnvironment)
        case let p as LocalSandboxProvider: return (p.snapshotDirectory, p.runner, nil, p.baseEnvironment)
        default: return nil
        }
    }

    /// Snapshots that live sandboxes still use (never offered for removal).
    var snapshotsInUse: [SandboxSnapshot] { sandboxes.values.flatMap(\.snapshots) }

    /// Old snapshot archives, snapshot images and restore backups this runtime's provider left behind.
    public func sandboxLeftovers() async -> [SandboxLeftover] {
        guard let s = sandboxStorage else { return [] }
        let keep = snapshotsInUse
        var workspaces = Set(sandboxes.values.map(\.hostWorkspace))
        let cwds = await mainQueue.run { self.brain.sessions().map(\.cwd) }
        workspaces.formUnion(cwds.filter { !$0.isEmpty })
        var out = SandboxCleanup.scan(snapshotDirectory: s.directory, workspaces: workspaces.sorted(), keep: keep)
        if let docker = s.docker {
            out += await SandboxCleanup.images(runner: s.runner, docker: docker, environment: s.environment, keep: keep)
        }
        return out
    }

    /// Removes the leftovers named by `references` — only those a fresh scan still reports (a caller can't name
    /// arbitrary paths), and only with `confirmed`. Returns what was removed.
    public func cleanUpSandbox(references: [String], confirmed: Bool) async throws -> [SandboxLeftover] {
        guard confirmed else { throw SandboxCleanup.NotConfirmed() }
        guard let s = sandboxStorage else { return [] }
        let wanted = Set(references)
        let items = await sandboxLeftovers().filter { wanted.contains($0.reference) }
        let removed = try await SandboxCleanup.remove(items, confirmed: true, snapshotDirectory: s.directory, runner: s.runner,
                                                      docker: s.docker ?? "docker", environment: s.environment)
        if !removed.isEmpty { Log.notice("sandbox cleanup removed \(removed.count) item(s)", category: "agents") }
        return removed
    }
}
