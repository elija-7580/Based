import Foundation
import BasedCore

// Happier-style control room data, stored as ordinary Based databases inside the Agent Brain page so it syncs to
// every device (iPhone, Mac, server) through the normal sync channels.

public struct AgentSession: Sendable, Identifiable, Equatable {
    public enum Status: String, CaseIterable, Sendable { case idle = "Idle", running = "Running", waiting = "Waiting for you", done = "Done", failed = "Failed" }
    public var id: RecordID
    public var title: String
    public var agentID: String
    public var status: Status
    public var machine: String
    public var cwd: String
    public var acpSessionID: String?
    public var tokens: Int
    public var startedAt: Date
    public var updatedAt: Date
    public var encrypted: Bool
}

public struct InboxItem: Sendable, Identifiable, Equatable {
    public enum Kind: String, CaseIterable, Sendable { case permission = "Permission", question = "Question", notice = "Notice", review = "Review" }
    public enum Status: String, CaseIterable, Sendable { case pending = "Pending", approved = "Approved", rejected = "Rejected", done = "Done" }
    public var id: RecordID
    public var title: String
    public var kind: Kind
    public var status: Status
    public var sessionID: RecordID?
    public var detail: String
    public var options: [String]       // optionId|label pairs encoded "id=label"
    public var decision: String?
    public var createdAt: Date
}

public struct Connection: Sendable, Identifiable, Equatable {
    public enum Transport: String, CaseIterable, Sendable { case stdio = "Stdio", http = "HTTP" }
    public var id: RecordID
    public var name: String
    public var transport: Transport
    public var command: String          // command line (stdio) or URL (http)
    public var enabled: Bool
    public var exposeToAgents: Bool     // pass to ACP agents as mcpServers
    public var secretKey: String        // Keychain key for token / env secret
    public var envName: String          // env var name receiving the secret (stdio)
    public var status: String
}

@MainActor
extension BrainStore {
    static let happierMetaKey = "brain.happier"
    private struct HIDs: Codable { var sessions, inbox, connections: RecordID }

    private var hids: HIDs? {
        guard let d = store.persistence?.meta(Self.happierMetaKey), let ids = try? JSONDecoder().decode(HIDs.self, from: d),
              store.databases[ids.sessions] != nil, store.databases[ids.inbox] != nil, store.databases[ids.connections] != nil else { return nil }
        return ids
    }

    /// Creates the Sessions / Inbox / Connections databases on first use (or adopts synced ones).
    @discardableResult
    public func ensureHappier() -> (sessions: RecordID, inbox: RecordID, connections: RecordID) {
        if let h = hids { return (h.sessions, h.inbox, h.connections) }
        var sessions: RecordID?, inbox: RecordID?, connections: RecordID?
        for b in store.contentBlocks(of: rootID) {
            guard let db = store.database(forBlock: b.id) else { continue }
            switch db.title.plainText { case "Sessions": sessions = db.id; case "Inbox": inbox = db.id; case "Connections": connections = db.id; default: break }
        }
        if sessions == nil {
            let db = store.createDatabase(title: "Sessions", in: .block(rootID), inline: true, sampleRows: 0).databaseID
            if let p = store.addProperty(to: db, name: "Status", type: .select) { for s in AgentSession.Status.allCases { _ = store.addOption(db, p, name: s.rawValue) } }
            _ = store.addProperty(to: db, name: "Agent", type: .text)
            _ = store.addProperty(to: db, name: "Machine", type: .text)
            _ = store.addProperty(to: db, name: "Directory", type: .text)
            _ = store.addProperty(to: db, name: "ACP session", type: .text)
            _ = store.addProperty(to: db, name: "Tokens", type: .number)
            _ = store.addProperty(to: db, name: "Started", type: .date)
            _ = store.addProperty(to: db, name: "Encrypted", type: .checkbox)
            sessions = db
        }
        if inbox == nil {
            let db = store.createDatabase(title: "Inbox", in: .block(rootID), inline: true, sampleRows: 0).databaseID
            if let p = store.addProperty(to: db, name: "Kind", type: .select) { for k in InboxItem.Kind.allCases { _ = store.addOption(db, p, name: k.rawValue) } }
            if let p = store.addProperty(to: db, name: "Status", type: .select) { for s in InboxItem.Status.allCases { _ = store.addOption(db, p, name: s.rawValue) } }
            _ = store.addProperty(to: db, name: "Session", type: .text)
            _ = store.addProperty(to: db, name: "Options", type: .text)
            _ = store.addProperty(to: db, name: "Decision", type: .text)
            inbox = db
        }
        if connections == nil {
            let db = store.createDatabase(title: "Connections", in: .block(rootID), inline: true, sampleRows: 0).databaseID
            if let p = store.addProperty(to: db, name: "Transport", type: .select) { for t in Connection.Transport.allCases { _ = store.addOption(db, p, name: t.rawValue) } }
            _ = store.addProperty(to: db, name: "Command", type: .text)
            _ = store.addProperty(to: db, name: "Enabled", type: .checkbox)
            _ = store.addProperty(to: db, name: "Expose to agents", type: .checkbox)
            _ = store.addProperty(to: db, name: "Secret key", type: .text)
            _ = store.addProperty(to: db, name: "Env name", type: .text)
            _ = store.addProperty(to: db, name: "Status", type: .text)
            connections = db
        }
        let ids = HIDs(sessions: sessions!, inbox: inbox!, connections: connections!)
        store.persistence?.setMeta(Self.happierMetaKey, try? JSONEncoder().encode(ids))
        return (ids.sessions, ids.inbox, ids.connections)
    }

    public var sessionsDB: RecordID { ensureHappier().sessions }
    public var inboxDB: RecordID { ensureHappier().inbox }
    public var connectionsDB: RecordID { ensureHappier().connections }

    private func selectName(_ row: Block, _ db: RecordID, _ name: String) -> String? {
        guard let pid = propID(db, name), let schema = store.databases[db]?.properties.first(where: { $0.id == pid }) else { return nil }
        if case .select(let oid)? = row.values[pid] { return schema.option(oid)?.name }
        return nil
    }
    private func setSelect(_ row: RecordID, _ db: RecordID, _ name: String, _ value: String) {
        guard let pid = propID(db, name), let oid = store.addOption(db, pid, name: value) else { return }
        store.setValue(row, pid, .select(oid))
    }
    private func setText(_ row: RecordID, _ db: RecordID, _ name: String, _ value: String?) {
        guard let pid = propID(db, name) else { return }
        store.setValue(row, pid, value.map { .text(RichText($0)) })
    }
    private func setNumber(_ row: RecordID, _ db: RecordID, _ name: String, _ value: Double) {
        if let pid = propID(db, name) { store.setValue(row, pid, .number(value)) }
    }
    private func setBool(_ row: RecordID, _ db: RecordID, _ name: String, _ value: Bool) {
        if let pid = propID(db, name) { store.setValue(row, pid, .checkbox(value)) }
    }

    // MARK: Sessions

    public func sessions() -> [AgentSession] {
        let db = sessionsDB
        return store.rows(of: db).map { row in
            var started = row.createdAt
            if let p = propID(db, "Started"), case .date(let d)? = row.values[p] { started = d.start }
            var tokens = 0
            if let p = propID(db, "Tokens"), case .number(let n)? = row.values[p] { tokens = Int(n) }
            let acp = text(row, db, "ACP session")
            return AgentSession(id: row.id, title: row.title, agentID: text(row, db, "Agent"),
                                status: AgentSession.Status(rawValue: selectName(row, db, "Status") ?? "") ?? .idle,
                                machine: text(row, db, "Machine"), cwd: text(row, db, "Directory"), acpSessionID: acp.isEmpty ? nil : acp,
                                tokens: tokens, startedAt: started, updatedAt: row.updatedAt, encrypted: bool(row, db, "Encrypted", default: false))
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    @discardableResult
    public func createSession(title: String, agentID: String, machine: String, cwd: String, encrypted: Bool) -> RecordID {
        let db = sessionsDB
        let id = store.addRow(to: db, title: RichText(title))
        setText(id, db, "Agent", agentID); setText(id, db, "Machine", machine); setText(id, db, "Directory", cwd)
        setSelect(id, db, "Status", AgentSession.Status.idle.rawValue)
        if let p = propID(db, "Started") { store.setValue(id, p, .date(DateValue(start: Date(), includeTime: true))) }
        setBool(id, db, "Encrypted", encrypted)
        return id
    }

    public func updateSession(_ id: RecordID, status: AgentSession.Status? = nil, acpSessionID: String? = nil, addTokens: Int = 0, agentID: String? = nil) {
        let db = sessionsDB
        if let status { setSelect(id, db, "Status", status.rawValue) }
        if let acpSessionID { setText(id, db, "ACP session", acpSessionID) }
        if let agentID { setText(id, db, "Agent", agentID) }
        if addTokens != 0, let row = store.blocks[id], let p = propID(db, "Tokens") {
            var cur = 0.0
            if case .number(let n)? = row.values[p] { cur = n }
            store.setValue(id, p, .number(cur + Double(addTokens)))
        }
    }

    /// Append a transcript entry to the session page. Entries are Markdown; encrypted sessions store ciphertext in a code block.
    public func appendTranscript(_ sessionID: RecordID, role: String, markdown: String, cipher: SessionCipher? = nil) {
        var md = "**\(role)**\n\n" + markdown
        if let cipher, let sealed = try? cipher.seal(md) { md = "```based-encrypted\n\(sealed)\n```" }
        appendBody(sessionID, markdown: md)
    }

    /// Plain-text transcript (decrypting when a cipher is given).
    public func transcript(_ sessionID: RecordID, cipher: SessionCipher? = nil) -> String {
        let raw = body(of: sessionID)
        guard let cipher else { return raw }
        var out = raw
        let pattern = "```based-encrypted\n([A-Za-z0-9+/=\n]+?)\n```"
        if let re = try? NSRegularExpression(pattern: pattern) {
            let ns = raw as NSString
            var pieces: [String] = []; var last = 0
            for m in re.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
                pieces.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
                let b64 = ns.substring(with: m.range(at: 1)).replacingOccurrences(of: "\n", with: "")
                pieces.append((try? cipher.open(b64)) ?? "🔒 (cannot decrypt on this device)")
                last = m.range.location + m.range.length
            }
            pieces.append(ns.substring(from: last))
            out = pieces.joined()
        }
        return out
    }

    // MARK: Inbox

    public func inbox(pendingOnly: Bool = false) -> [InboxItem] {
        let db = inboxDB
        return store.rows(of: db).compactMap { row in
            let st = InboxItem.Status(rawValue: selectName(row, db, "Status") ?? "") ?? .pending
            if pendingOnly, st != .pending { return nil }
            let sess = text(row, db, "Session"); let dec = text(row, db, "Decision")
            return InboxItem(id: row.id, title: row.title, kind: InboxItem.Kind(rawValue: selectName(row, db, "Kind") ?? "") ?? .notice, status: st,
                             sessionID: sess.isEmpty ? nil : sess, detail: body(of: row.id),
                             options: text(row, db, "Options").split(separator: ";").map(String.init), decision: dec.isEmpty ? nil : dec, createdAt: row.createdAt)
        }.sorted { $0.createdAt > $1.createdAt }
    }

    @discardableResult
    public func addInbox(title: String, kind: InboxItem.Kind, sessionID: RecordID?, detail: String, options: [(id: String, label: String)] = []) -> RecordID {
        let db = inboxDB
        let id = store.addRow(to: db, title: RichText(title))
        setSelect(id, db, "Kind", kind.rawValue); setSelect(id, db, "Status", InboxItem.Status.pending.rawValue)
        setText(id, db, "Session", sessionID); setText(id, db, "Options", options.map { "\($0.id)=\($0.label)" }.joined(separator: ";"))
        if !detail.isEmpty { setBody(id, markdown: detail) }
        return id
    }

    public func resolveInbox(_ id: RecordID, decision: String, status: InboxItem.Status) {
        let db = inboxDB
        setText(id, db, "Decision", decision); setSelect(id, db, "Status", status.rawValue)
    }

    // MARK: Connections

    public func connections() -> [Connection] {
        let db = connectionsDB
        return store.rows(of: db).map { row in
            Connection(id: row.id, name: row.title, transport: Connection.Transport(rawValue: selectName(row, db, "Transport") ?? "") ?? .stdio,
                       command: text(row, db, "Command"), enabled: bool(row, db, "Enabled", default: true),
                       exposeToAgents: bool(row, db, "Expose to agents", default: true), secretKey: text(row, db, "Secret key"),
                       envName: text(row, db, "Env name"), status: text(row, db, "Status"))
        }
    }

    @discardableResult
    public func saveConnection(name: String, transport: Connection.Transport, command: String, envName: String = "", enabled: Bool = true, exposeToAgents: Bool = true) -> RecordID {
        let db = connectionsDB
        let id = connections().first { $0.name == name }?.id ?? store.addRow(to: db, title: RichText(name))
        setSelect(id, db, "Transport", transport.rawValue); setText(id, db, "Command", command); setText(id, db, "Env name", envName)
        setText(id, db, "Secret key", "connection.\(name.lowercased().replacingOccurrences(of: " ", with: "-"))")
        setBool(id, db, "Enabled", enabled); setBool(id, db, "Expose to agents", exposeToAgents)
        return id
    }

    public func setConnectionStatus(_ id: RecordID, _ status: String) { setText(id, connectionsDB, "Status", status) }
    public func deleteConnection(_ id: RecordID) { store.trash([id]) }

    /// Popular servers, pre-filled so the first connections take one click (secret entered in Settings).
    public static let connectionCatalog: [(name: String, transport: Connection.Transport, command: String, envName: String, hint: String)] = [
        ("GitHub", .http, "https://api.githubcopilot.com/mcp/", "", "Personal access token"),
        ("Slack", .stdio, "npx -y @modelcontextprotocol/server-slack", "SLACK_BOT_TOKEN", "Bot token (xoxb-…)"),
        ("Google Drive", .stdio, "npx -y @modelcontextprotocol/server-gdrive", "", "OAuth via browser on first run"),
        ("Gmail", .stdio, "npx -y @gongrzhe/server-gmail-autoauth-mcp", "", "OAuth via browser on first run"),
        ("Google Calendar", .stdio, "npx -y @cocal/google-calendar-mcp", "GOOGLE_OAUTH_CREDENTIALS", "Path to OAuth credentials JSON"),
        ("Linear", .http, "https://mcp.linear.app/mcp", "", "OAuth / API key"),
        ("Notion", .http, "https://mcp.notion.com/mcp", "", "OAuth / integration token"),
        ("Filesystem", .stdio, "npx -y @modelcontextprotocol/server-filesystem ~/Documents", "", "Directories as arguments"),
        ("Brave Search", .stdio, "npx -y @modelcontextprotocol/server-brave-search", "BRAVE_API_KEY", "API key"),
        ("Fetch (web)", .stdio, "uvx mcp-server-fetch", "", ""),
        ("Apple Notes/Reminders", .stdio, "npx -y apple-mcp", "", "macOS only"),
    ]
}

/// Splits a shell-ish command line into command + args (quotes honoured, `~` expanded).
public func splitCommandLine(_ s: String) -> (String, [String]) {
    var parts: [String] = []; var cur = ""; var quote: Character? = nil
    for ch in s {
        if let q = quote { if ch == q { quote = nil } else { cur.append(ch) } }
        else if ch == "\"" || ch == "'" { quote = ch }
        else if ch == " " { if !cur.isEmpty { parts.append(cur); cur = "" } }
        else { cur.append(ch) }
    }
    if !cur.isEmpty { parts.append(cur) }
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    parts = parts.map { $0.hasPrefix("~") ? home + $0.dropFirst() : $0 }
    return (parts.first ?? "", Array(parts.dropFirst()))
}
