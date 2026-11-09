import Foundation

// BSD-115: one permission vocabulary. The coding-agent sessions (`HappierRuntime`) use `PermissionMode` like the
// chat; the old setting (ask / allowReads / allowAll) is migrated. A second answer to an Inbox item from another
// device gets 409 with the device that answered first, and the clients say so.

public extension PermissionMode {
    /// The old `acp.permissions` value: allowAll → bypass; ask and allowReads → ask (reads are free in ask anyway).
    init(legacyPolicy raw: String) {
        self = raw == "allowAll" ? .bypass : .ask
    }

    /// The stored mode, else the migrated old setting, else ask.
    static func stored(_ raw: String?, legacyPolicy: String?) -> PermissionMode {
        if let raw, let m = PermissionMode(rawValue: raw) { return m }
        if let legacyPolicy { return PermissionMode(legacyPolicy: legacyPolicy) }
        return .ask
    }

    /// How a coding agent's permission request of ACP kind `kind` is answered without asking: true = allow,
    /// false = refuse, nil = ask in the Inbox. Rules (allow / deny / ask) are checked before this.
    func autoAnswer(kind: String?) -> Bool? {
        let k = (kind ?? "").lowercased()
        let reads: Set<String> = ["read", "search", "fetch", "think"]
        let edits: Set<String> = ["edit", "delete", "move"]
        switch self {
        case .bypass: return true
        case .acceptEdits: return reads.contains(k) || edits.contains(k) ? true : nil
        case .ask: return reads.contains(k) ? true : nil
        case .plan: return reads.contains(k)
        }
    }

    /// Claude Code's own `--permission-mode` for this mode.
    var claudePermissionMode: String {
        switch self {
        case .ask: return "default"
        case .acceptEdits: return "acceptEdits"
        case .plan: return "plan"
        case .bypass: return "bypassPermissions"
        }
    }
}

public extension InboxItem {
    /// The device that answered ("allow_once · Mac" → "Mac"), nil while pending or when unknown.
    var answeredOn: String? {
        guard status != .pending, let d = decision, let r = d.range(of: " · ", options: .backwards) else { return nil }
        let device = String(d[r.upperBound...]).trimmingCharacters(in: .whitespaces)
        return device.isEmpty ? nil : device
    }
}

/// What `POST /inbox/<id>/resolve` answered.
public enum InboxResolveOutcome: Equatable, Sendable {
    case ok
    case alreadyAnswered(device: String?)
    case failed(String)

    public static func parse(status: Int, body: JSONValue) -> InboxResolveOutcome {
        if (200..<300).contains(status), body["ok"]?.bool != false { return .ok }
        if status == 409 { return .alreadyAnswered(device: body["device"]?.string) }
        return .failed(body["error"]?.string ?? "HTTP \(status)")
    }

    /// The hint for the user (nil when it worked).
    public var message: String? {
        switch self {
        case .ok: return nil
        case .alreadyAnswered(let d): return d.map { "Already answered on \($0)" } ?? "Already answered on another device"
        case .failed(let e): return "Could not answer: \(e)"
        }
    }
}
