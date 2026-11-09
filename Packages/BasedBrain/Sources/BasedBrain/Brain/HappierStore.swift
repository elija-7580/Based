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
    /// Project the session belongs to (defaults to the working directory's name).
    public var project: String = ""
    /// Parent session for sub-agents.
    public var parentID: RecordID?
    /// The task a sub-agent was spawned with (or the first prompt of a session).
    public var task: String = ""
    /// Final answer of the last finished turn (what a sub-agent reports back to its parent).
    public var result: String = ""
    /// Row of the Projects database (BSD-44); `project` stays the display name / folder name.
    public var projectID: RecordID? = nil
    /// "based" = built-in AI chat; otherwise a coding agent id.
    public var isChat: Bool { agentID == "based" }
}

extension AgentSession {
    /// Nesting level of `sid` in a session map (0 = top level); stops at cycles and missing parents.
    public static func depth(of sid: RecordID, in all: [RecordID: AgentSession]) -> Int {
        var d = 0, seen: Set<RecordID> = [sid], cur = all[sid]?.parentID
        while let p = cur, let s = all[p], !seen.contains(p) { d += 1; seen.insert(p); cur = s.parentID }
        return d
    }
    /// Running or waiting for the user.
    public var isActive: Bool { status == .running || status == .waiting }
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

    public var sessionsDB: RecordID {
        let db = ensureHappier().sessions
        // Columns added in Pass 9 (project dashboard, sub-agents).
        if propID(db, "Project") == nil { _ = store.addProperty(to: db, name: "Project", type: .text) }
        if propID(db, "Parent") == nil { _ = store.addProperty(to: db, name: "Parent", type: .text) }
        // Pass 12 (agent hierarchy): the task a session was given and its latest final answer.
        if propID(db, "Task") == nil { _ = store.addProperty(to: db, name: "Task", type: .text) }
        if propID(db, "Result") == nil { _ = store.addProperty(to: db, name: "Result", type: .text) }
        return db
    }
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
            let parent = text(row, db, "Parent")
            let cwd = text(row, db, "Directory")
            var project = text(row, db, "Project")
            if project.isEmpty { project = cwd.isEmpty ? "" : URL(fileURLWithPath: cwd).lastPathComponent }
            return AgentSession(id: row.id, title: row.title, agentID: text(row, db, "Agent"),
                                status: AgentSession.Status(rawValue: selectName(row, db, "Status") ?? "") ?? .idle,
                                machine: text(row, db, "Machine"), cwd: cwd, acpSessionID: acp.isEmpty ? nil : acp,
                                tokens: tokens, startedAt: started, updatedAt: row.updatedAt, encrypted: bool(row, db, "Encrypted", default: false),
                                project: project, parentID: parent.isEmpty ? nil : parent,
                                task: text(row, db, "Task"), result: text(row, db, "Result"),
                                projectID: relationValue(row.id, db, ProjectCol.sessionLink))
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Direct sub-agents of a session.
    public func children(of sid: RecordID) -> [AgentSession] { sessions().filter { $0.parentID == sid } }

    /// Nesting level (0 = top-level session). Cycles are cut off.
    public func depth(of sid: RecordID) -> Int {
        let all = Dictionary(sessions().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return AgentSession.depth(of: sid, in: all)
    }

    @discardableResult
    public func createSession(title: String, agentID: String, machine: String, cwd: String, encrypted: Bool,
                              project: String? = nil, parentID: RecordID? = nil, task: String? = nil) -> RecordID {
        let db = sessionsDB
        let id = store.addRow(to: db, title: RichText(title))
        if let task, !task.isEmpty { setText(id, db, "Task", String(task.prefix(4000))) }
        setText(id, db, "Agent", agentID); setText(id, db, "Machine", machine); setText(id, db, "Directory", cwd)
        if let project, !project.isEmpty { setText(id, db, "Project", project) }
        if let parentID { setText(id, db, "Parent", parentID) }
        setSelect(id, db, "Status", AgentSession.Status.idle.rawValue)
        if let p = propID(db, "Started") { store.setValue(id, p, .date(DateValue(start: Date(), includeTime: true))) }
        setBool(id, db, "Encrypted", encrypted)
        linkSessionToProject(id, folder: cwd, name: project)   // BSD-44
        startRun(forSession: id, title: title, agentID: agentID, parentID: parentID)   // BSD-43
        return id
    }

    public func updateSession(_ id: RecordID, status: AgentSession.Status? = nil, acpSessionID: String? = nil, addTokens: Int = 0,
                              agentID: String? = nil, title: String? = nil, project: String? = nil,
                              result: String? = nil, task: String? = nil) {
        let db = sessionsDB
        if let result { setText(id, db, "Result", String(result.suffix(8000))) }
        if let task, store.blocks[id] != nil { setText(id, db, "Task", String(task.prefix(4000))) }
        if let title, !title.isEmpty, store.blocks[id] != nil { store.setText(id, RichText(title)) }
        if let project { setText(id, db, "Project", project) }
        if let status { setSelect(id, db, "Status", status.rawValue) }
        if let acpSessionID { setText(id, db, "ACP session", acpSessionID) }
        if let agentID { setText(id, db, "Agent", agentID) }
        if addTokens != 0, let row = store.blocks[id], let p = propID(db, "Tokens") {
            var cur = 0.0
            if case .number(let n)? = row.values[p] { cur = n }
            store.setValue(id, p, .number(cur + Double(addTokens)))
        }
        // BSD-43: the session's run follows its status, tokens and result.
        if status != nil || addTokens != 0 || result != nil {
            mirrorSession(id, status: status, addTokens: addTokens, result: result, agentID: agentID)
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

    /// Answers an inbox item once: only a pending item is resolved (BSD-50 — two devices answering no longer
    /// overwrite each other; the first answer wins). `device` is recorded with the decision. Returns false when the
    /// item was already answered or is gone.
    @discardableResult
    public func resolveInbox(_ id: RecordID, decision: String, status: InboxItem.Status, device: String? = nil) -> Bool {
        let db = inboxDB
        guard let row = store.blocks[id], row.trashedAt == nil,
              (InboxItem.Status(rawValue: selectName(row, db, "Status") ?? "") ?? .pending) == .pending else { return false }
        let recorded = device.map { decision + " · " + $0 } ?? decision
        setText(id, db, "Decision", recorded); setSelect(id, db, "Status", status.rawValue)
        return true
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
