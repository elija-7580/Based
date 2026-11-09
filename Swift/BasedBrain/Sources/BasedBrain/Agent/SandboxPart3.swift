import Foundation

// BSD-127: Sandbox part 3 — Based's MCP tools for agents inside a container (HTTP, session token only) and
// cleaning up old snapshots on request (never automatically).

public enum SandboxMCP {
    /// The host as seen from inside a sandbox container (`--add-host host.docker.internal:host-gateway`).
    public static let hostName = "host.docker.internal"

    /// `base` as reachable from inside the container: loopback addresses become `host.docker.internal`.
    /// (The endpoint must listen on an address the Docker bridge reaches, e.g. 0.0.0.0 on the server.)
    public static func containerURL(_ base: String) -> String {
        guard var c = URLComponents(string: base), let host = c.host?.lowercased() else { return base }
        if ["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"].contains(host) { c.host = hostName }
        return c.string ?? base
    }

    /// The MCP servers an agent in a container gets: Based over HTTP with the session's own token. None without an
    /// endpoint, without a session token (the master token never enters a container) or without network.
    public static func servers(endpoint: (base: String, token: String)?, sessionToken: String?, session: String,
                               network: Bool) -> [MCPServerConfig] {
        guard network, let ep = endpoint, let token = sessionToken, !token.isEmpty, token != ep.token else { return [] }
        return [MCPServerConfig(name: "based", url: containerURL(ep.base) + "/mcp/session/\(session)",
                                headers: ["Authorization": "Bearer \(token)"])]
    }
}

/// Something old a sandbox left behind.
public struct SandboxLeftover: Sendable, Equatable, Hashable {
    public enum Kind: String, Sendable { case archive, restoreBackup, image }
    public var kind: Kind
    /// File or folder path (archive, backup) or image reference (`based-snapshot/<project>:<name>`).
    public var reference: String
    public var modified: Date?

    public init(kind: Kind, reference: String, modified: Date? = nil) {
        self.kind = kind; self.reference = reference; self.modified = modified
    }

    public var label: String {
        switch kind {
        case .archive: return "Snapshot archive " + (reference as NSString).lastPathComponent
        case .restoreBackup: return "Folder before restore " + (reference as NSString).lastPathComponent
        case .image: return "Snapshot image " + reference
        }
    }
}

/// Lists and removes old snapshot archives, snapshot images and `<folder>.before-restore-<time>` folders. Nothing
/// is removed without `confirmed: true` (the UI asks first), and only things that match Based's own naming.
public enum SandboxCleanup {
    static let backupMarker = ".before-restore-"
    public static let imagePrefix = "based-snapshot/"

    /// Archives in `snapshotDirectory` that no snapshot in `keep` uses, and restore backups next to `workspaces`.
    public static func scan(snapshotDirectory: String, workspaces: [String], keep: [SandboxSnapshot] = [],
                            fileManager fm: FileManager = .default) -> [SandboxLeftover] {
        let kept = Set(keep.map { ($0.archive as NSString).standardizingPath })
        var out: [SandboxLeftover] = []
        func modified(_ path: String) -> Date? { (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date }
        for name in ((try? fm.contentsOfDirectory(atPath: snapshotDirectory)) ?? []).sorted() where name.hasSuffix(".tar.gz") {
            let path = ((snapshotDirectory as NSString).appendingPathComponent(name) as NSString).standardizingPath
            if !kept.contains(path) { out.append(SandboxLeftover(kind: .archive, reference: path, modified: modified(path))) }
        }
        var seen: Set<String> = []
        for ws in workspaces {
            let folder = (ws as NSString).standardizingPath
            let parent = (folder as NSString).deletingLastPathComponent, base = (folder as NSString).lastPathComponent
            for name in ((try? fm.contentsOfDirectory(atPath: parent)) ?? []).sorted() where isBackup(name, of: base) {
                let path = (parent as NSString).appendingPathComponent(name)
                if seen.insert(path).inserted { out.append(SandboxLeftover(kind: .restoreBackup, reference: path, modified: modified(path))) }
            }
        }
        return out
    }

    /// "<base>.before-restore-<digits>".
    static func isBackup(_ name: String, of base: String) -> Bool {
        guard name.hasPrefix(base + backupMarker) else { return false }
        let stamp = name.dropFirst(base.count + backupMarker.count)
        return !stamp.isEmpty && stamp.allSatisfy(\.isNumber)
    }

    /// Snapshot images (`docker images`) that no snapshot in `keep` uses.
    public static func images(runner: CommandRunner, docker: String = "docker", environment: [String: String],
                              keep: [SandboxSnapshot] = []) async -> [SandboxLeftover] {
        guard let r = try? await runner.run(docker, ["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference=\(imagePrefix)*"],
                                            environment: environment, cwd: nil), r.exitCode == 0 else { return [] }
        let kept = Set(keep.map(\.image))
        return r.stdout.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix(imagePrefix) && !$0.hasSuffix(":<none>") && !kept.contains($0) }
            .map { SandboxLeftover(kind: .image, reference: $0) }
    }

    public struct NotConfirmed: Error, CustomStringConvertible {
        public var description: String { "Cleaning up snapshots needs a confirmation." }
    }

    /// Removes `items` (only after confirmation). Returns what was removed; anything that does not look like
    /// Based's own leftovers is skipped.
    @discardableResult
    public static func remove(_ items: [SandboxLeftover], confirmed: Bool, snapshotDirectory: String,
                              runner: CommandRunner?, docker: String = "docker", environment: [String: String] = [:],
                              fileManager fm: FileManager = .default) async throws -> [SandboxLeftover] {
        guard confirmed else { throw NotConfirmed() }
        let dir = (snapshotDirectory as NSString).standardizingPath
        var removed: [SandboxLeftover] = []
        for item in items {
            switch item.kind {
            case .archive:
                let path = (item.reference as NSString).standardizingPath
                guard (path as NSString).deletingLastPathComponent == dir, path.hasSuffix(".tar.gz") else { continue }
                if (try? fm.removeItem(atPath: path)) != nil { removed.append(item) }
            case .restoreBackup:
                let path = (item.reference as NSString).standardizingPath
                guard (path as NSString).lastPathComponent.contains(backupMarker) else { continue }
                if (try? fm.removeItem(atPath: path)) != nil { removed.append(item) }
            case .image:
                guard item.reference.hasPrefix(imagePrefix), let runner,
                      let r = try? await runner.run(docker, ["rmi", item.reference], environment: environment, cwd: nil),
                      r.exitCode == 0 else { continue }
                removed.append(item)
            }
        }
        return removed
    }
}
