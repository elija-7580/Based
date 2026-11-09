import Foundation
import BasedCore

// BSD-33: coding agents (Claude Code, Codex, Gemini, ACP adapters) never see the server's master token, API keys
// or the session cipher key unless they need exactly that value.
//
// - The environment of every agent child is built from an allowlist (`ShellEnvironment.childEnvironment`), with the
//   same secret-name rule as the container sandbox (`SandboxEnvironmentPolicy.looksSecret`, BSD-53).
// - The MCP config with its bearer token goes into a private file (`MCPConfigFile`), never onto the command line.
// - The token in that config is a short-lived per-session token (`MCPSessionTokens`), valid only for that
//   session's `/mcp/session/<sid>` route — not for `/mcp`, `/sync/*` or anything else.

public extension ShellEnvironment {
    /// Variables every agent child may inherit from the login-shell environment (no values that grant access).
    static let childAllow: Set<String> = [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "COLORTERM", "NO_COLOR", "CI",
        // Proxies and CA bundles: agents talk to their APIs through the same network setup as the user.
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
        // Toolchains coding agents build with (paths only).
        "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR", "VOLTA_HOME", "BUN_INSTALL",
        "PNPM_HOME", "DEVELOPER_DIR", "ANDROID_HOME",
        // The docker CLI of a container sandbox (BSD-53 `docker exec -i …`); only `-e NAME` values enter the container.
        "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    ]
    /// Name prefixes on the allowlist (`LC_ALL`, `LC_CTYPE`, `XDG_CONFIG_HOME` …).
    static let childAllowPrefixes = ["LC_", "XDG_"]

    /// Agent-specific login variables that pass by default (config folders, never keys).
    static let agentDefaultPassthrough: [String: Set<String>] = [
        "claude": ["CLAUDE_CONFIG_DIR"],
        "codex": ["CODEX_HOME"],
    ]

    /// User-approved extra variables for an agent (e.g. `ANTHROPIC_API_KEY` for `claude`, `GEMINI_API_KEY` for
    /// `gemini`): comma-separated names in the defaults key `based.agentEnv.<agentID>`. Secret-looking names pass
    /// only through this explicit list.
    static func approvedPassthrough(for agentID: String, defaults: UserDefaults = .standard) -> Set<String> {
        let raw = defaults.string(forKey: "based.agentEnv.\(agentID)") ?? ""
        let names = raw.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)
        return Set(names.filter(SandboxEnvironmentPolicy.validName))
    }

    /// The defaults key holding the approved names for `agentID`.
    static func agentEnvKey(_ agentID: String) -> String { "based.agentEnv.\(agentID)" }

    /// BSD-110: stores the approved names for `agentID` (Settings → Agents & AI, `based-server --agent-env`).
    /// Invalid names are dropped, order and duplicates don't matter; an empty list removes the approval.
    /// Writes only when the stored value really changes. Returns the names now approved.
    @discardableResult
    static func setApprovedPassthrough(_ names: [String], for agentID: String, defaults: UserDefaults = .standard) -> [String] {
        let clean = Array(Set(names.map { $0.trimmingCharacters(in: .whitespaces) }.filter(SandboxEnvironmentPolicy.validName))).sorted()
        let key = agentEnvKey(agentID)
        if clean.isEmpty {
            if defaults.object(forKey: key) != nil { defaults.removeObject(forKey: key) }
        } else {
            let value = clean.joined(separator: ",")
            if defaults.string(forKey: key) != value { defaults.set(value, forKey: key) }
        }
        return clean
    }

    /// BSD-110: parses `id=NAME[,NAME]` specs (`--agent-env`, repeatable) and `BASED_AGENT_ENV`
    /// (`claude=ANTHROPIC_API_KEY;gemini=GEMINI_API_KEY,GOOGLE_CLOUD_PROJECT`). Specs for the same agent add up.
    /// Malformed parts are reported in `invalid` instead of being guessed.
    static func parseAgentEnvSpecs(_ specs: [String]) -> (approvals: [String: [String]], invalid: [String]) {
        var out: [String: Set<String>] = [:]
        var invalid: [String] = []
        for spec in specs.flatMap({ $0.split(separator: ";").map(String.init) }) {
            let part = spec.trimmingCharacters(in: .whitespacesAndNewlines)
            if part.isEmpty { continue }
            let kv = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard kv.count == 2, !kv[0].isEmpty, kv[0].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else {
                invalid.append(part); continue
            }
            let names = kv[1].split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init)
            let valid = names.filter(SandboxEnvironmentPolicy.validName)
            invalid += names.filter { !SandboxEnvironmentPolicy.validName($0) }.map { "\(kv[0])=\($0)" }
            out[kv[0], default: []].formUnion(valid)
        }
        return (out.mapValues { $0.sorted() }, invalid)
    }

    /// BSD-110: applies parsed specs: each named agent gets exactly these names (agents not named keep theirs).
    static func applyAgentEnv(_ approvals: [String: [String]], defaults: UserDefaults = .standard) {
        for (id, names) in approvals { setApprovedPassthrough(names, for: id, defaults: defaults) }
    }

    /// Login variables an agent typically needs to sign in with a key (offered as a fix when present but not approved).
    static let agentKeyHints: [String: [String]] = [
        "claude": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        "codex": ["OPENAI_API_KEY"],
        "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    ]

    /// BSD-110: key variables set in `base` (default: the login-shell environment) that `agentID` would need but
    /// that aren't approved for it.
    static func unapprovedKeys(for agentID: String, base: [String: String]? = nil, defaults: UserDefaults = .standard) -> [String] {
        guard let hints = agentKeyHints[agentID] else { return [] }
        let env = base ?? environment()
        let approved = passthrough(for: agentID, defaults: defaults)
        return hints.filter { env[$0]?.isEmpty == false && !approved.contains($0) }
    }

    /// Everything that passes for `agentID`: its defaults plus what the user approved.
    static func passthrough(for agentID: String?, defaults: UserDefaults = .standard) -> Set<String> {
        guard let agentID, !agentID.isEmpty else { return [] }
        return (agentDefaultPassthrough[agentID] ?? []).union(approvedPassthrough(for: agentID, defaults: defaults))
    }

    /// Whether a variable of the base environment may reach an agent child.
    static func childMayInherit(_ name: String, passthrough: Set<String> = []) -> Bool {
        guard SandboxEnvironmentPolicy.validName(name) else { return false }
        if passthrough.contains(name) { return true }
        if name.uppercased().hasPrefix("BASED_") || SandboxEnvironmentPolicy.looksSecret(name) { return false }
        return childAllow.contains(name) || childAllowPrefixes.contains { name.hasPrefix($0) }
    }

    /// The environment of an agent child: the allowlisted part of `base` (default: the login-shell environment),
    /// plus `passthrough` names, plus `extra` (values Based sets on purpose for this child, e.g. `BASED_MCP_TOKEN`).
    static func childEnvironment(base: [String: String]? = nil, extra: [String: String] = [:],
                                 passthrough: Set<String> = []) -> [String: String] {
        var env = (base ?? environment()).filter { childMayInherit($0.key, passthrough: passthrough) }
        for (k, v) in extra { env[k] = v }
        return env
    }

    /// Same, for a known agent id (`claude`, `codex`, `gemini` …): its default and user-approved variables pass.
    static func childEnvironment(agent agentID: String?, base: [String: String]? = nil, extra: [String: String] = [:]) -> [String: String] {
        childEnvironment(base: base, extra: extra, passthrough: passthrough(for: agentID))
    }
}

/// A private file holding an MCP config (`{"mcpServers": …}` with bearer tokens) for `claude --mcp-config <path>`.
/// The folder is 0700 and the file 0600, so other local users can't read it; `remove()` deletes it when the
/// session or call ends.
public struct MCPConfigFile: Sendable, Equatable {
    public let url: URL
    public var path: String { url.path }

    /// `<tmp>/based-mcp-<uid>/<random>.json`.
    public static var directory: URL {
        #if os(macOS) || os(Linux)
        let uid = String(getuid())
        #else
        let uid = "app"
        #endif
        return FileManager.default.temporaryDirectory.appendingPathComponent("based-mcp-\(uid)", isDirectory: true)
    }

    public static func write(_ config: JSONValue, in dir: URL = MCPConfigFile.directory) throws -> MCPConfigFile {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        let url = dir.appendingPathComponent(SecureToken.make(prefix: "mcp-", bytes: 12) + ".json")
        let data = try config.encoded()
        guard fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let h = try FileHandle(forWritingTo: url)
        defer { try? h.close() }
        try h.write(contentsOf: data)
        return MCPConfigFile(url: url)
    }

    public func remove() { try? FileManager.default.removeItem(at: url) }
}

/// Short-lived bearer tokens for one agent session's MCP route (`/mcp/session/<sid>`). A token is bound to its
/// session id, expires after `lifetime` without use and is revoked when the session stops. The master token is
/// never handed to agents.
public final class MCPSessionTokens: @unchecked Sendable {
    public static let prefix = "bds_"
    private struct Entry { var token: String; var expires: Date }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    public let lifetime: TimeInterval
    private let now: @Sendable () -> Date

    public init(lifetime: TimeInterval = 12 * 3600, now: @escaping @Sendable () -> Date = { Date() }) {
        self.lifetime = lifetime; self.now = now
    }

    /// The session's token (issued on first use, reused and extended while valid).
    public func token(for session: String) -> String {
        lock.lock(); defer { lock.unlock() }
        let t = now()
        if var e = entries[session], e.expires > t {
            e.expires = t.addingTimeInterval(lifetime)
            entries[session] = e
            return e.token
        }
        let e = Entry(token: SecureToken.make(prefix: Self.prefix), expires: t.addingTimeInterval(lifetime))
        entries[session] = e
        return e.token
    }

    /// Ends the session's token (session stopped).
    public func revoke(_ session: String) {
        lock.lock(); entries.removeValue(forKey: session); lock.unlock()
    }

    /// Whether `token` is the live token of `session`; a valid use extends it.
    public func isValid(_ token: String, session: String) -> Bool {
        guard token.hasPrefix(Self.prefix) else { return false }
        lock.lock(); defer { lock.unlock() }
        let t = now()
        guard var e = entries[session] else { return false }
        guard e.expires > t else { entries.removeValue(forKey: session); return false }
        guard SecureToken.equal(e.token, token) else { return false }
        e.expires = t.addingTimeInterval(lifetime)
        entries[session] = e
        return true
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }
}
