import Foundation
import BasedCore

// BSD-43: every agent run is a record. A chat turn, a coding session, a scheduled agent run and a sub-agent are
// all the same thing — a *run* with a status, a kind, an optional agent and parent run, engine/model, usage and a
// short result. Runs live in the "Runs" database inside the Agent Brain page (like Sessions/Inbox), so they sync
// to every device and the start page, budgets and the MCP tools all read the same data.

/// One agent run (a row of the Runs database).
public struct AgentRun: Sendable, Identifiable, Equatable {
    public enum Status: String, CaseIterable, Sendable {
        case planned = "Planned", running = "Running", waiting = "Waiting", needsYou = "Needs you"
        case done = "Done", failed = "Failed", cancelled = "Cancelled"
        /// Finished one way or another; a terminal run has an end time.
        public var isTerminal: Bool { self == .done || self == .failed || self == .cancelled }
    }
    public enum Kind: String, CaseIterable, Sendable {
        case chat = "Chat", session = "Session", schedule = "Schedule", subagent = "Subagent", main = "Main"
    }
    public enum Compute: String, CaseIterable, Sendable { case low = "Low", auto = "Auto", high = "High" }

    public var id: RecordID
    public var title: String
    public var status: Status
    public var kind: Kind
    /// Row of the Agents database that ran (scheduled / custom agents).
    public var agentID: RecordID?
    /// Run that started this one (sub-agents).
    public var parentID: RecordID?
    /// Row of the Sessions database this run belongs to (chat and coding sessions).
    public var sessionID: RecordID?
    public var engine: String
    public var model: String
    public var compute: Compute?
    public var startedAt: Date
    public var endedAt: Date?
    public var tokens: Int
    /// Cost in euros (0 when unknown).
    public var cost: Double
    /// Short result (or the latest progress line while it runs).
    public var result: String
    /// Page that holds the full result, when the run wrote one.
    public var resultPageID: RecordID?
    /// Project the run belongs to (row of the Projects database, BSD-44).
    public var projectID: RecordID? = nil
}

/// Selects runs; nil fields match everything.
public struct RunFilter: Sendable, Equatable {
    public var statuses: Set<AgentRun.Status>?
    public var kinds: Set<AgentRun.Kind>?
    public var agentID: RecordID?
    public var sessionID: RecordID?
    public var parentID: RecordID?
    public var startedSince: Date?
    public init(statuses: Set<AgentRun.Status>? = nil, kinds: Set<AgentRun.Kind>? = nil, agentID: RecordID? = nil,
                sessionID: RecordID? = nil, parentID: RecordID? = nil, startedSince: Date? = nil) {
        self.statuses = statuses; self.kinds = kinds; self.agentID = agentID
        self.sessionID = sessionID; self.parentID = parentID; self.startedSince = startedSince
    }
    public static let all = RunFilter()

    public func matches(_ r: AgentRun) -> Bool {
        if let statuses, !statuses.contains(r.status) { return false }
        if let kinds, !kinds.contains(r.kind) { return false }
        if let agentID, r.agentID != agentID { return false }
        if let sessionID, r.sessionID != sessionID { return false }
        if let parentID, r.parentID != parentID { return false }
        if let startedSince, r.startedAt < startedSince { return false }
        return true
    }
}

@MainActor
extension BrainStore {
    static let runsMetaKey = "brain.runs"

    /// Column names of the Runs database. New columns are added to existing databases on first use (`ensureRuns`).
    enum RunCol {
        static let status = "Status", kind = "Kind", agent = "Agent", parent = "Parent run", session = "Session"
        static let engine = "Engine", model = "Model", compute = "Compute", started = "Started", ended = "Ended"
        static let tokens = "Tokens", cost = "Cost", result = "Result", resultPage = "Result page"
        static let project = "Project"
        static let sandbox = "Sandbox", snapshots = "Snapshots"
    }

    /// Creates the Runs database on first use, adopts a synced one by title, adds missing columns and protects it
    /// (its host block can't be trashed, like the other Agent Brain databases). Returns the database id.
    @discardableResult
    public func ensureRuns() -> RecordID {
        let (id, _) = ensureBrainDatabase(title: "Runs", metaKey: Self.runsMetaKey)
        ensureRunColumns(id)
        if let projects = existingProjectsDB { ensureRelation(id, RunCol.project, to: projects) }
        return id
    }

    /// The Runs database id when it exists already (never creates it).
    var existingRunsDB: RecordID? { existingBrainDatabase(title: "Runs", metaKey: Self.runsMetaKey) }

    // MARK: Shared helpers for the lazily created Brain databases (Runs, Projects)

    private struct OneID: Codable { var id: RecordID }

    /// The Brain database `title`: the oldest database of that title directly inside the Agent Brain page — also
    /// when its block sits in the Trash, so repair can find and restore it. Creation time and id are synced, so
    /// every device picks the same one (BSD-102; a device-local remembered id used to win and kept two devices
    /// writing into two databases). The remembered id only counts when no database has the title (renamed).
    func existingBrainDatabase(title: String, metaKey: String) -> RecordID? {
        if let oldest = brainDatabaseCandidates(title: title).first { return oldest.id }
        if let d = store.persistence?.meta(metaKey), let ids = try? JSONDecoder().decode(OneID.self, from: d),
           store.databases[ids.id] != nil { return ids.id }
        return nil
    }

    /// Finds or creates a Brain database, remembers its id and protects its host block (restoring it from the
    /// Trash when needed); duplicates of the same title (another device made one before syncing) are merged into
    /// it. `created` is true when it was made just now.
    func ensureBrainDatabase(title: String, metaKey: String) -> (id: RecordID, created: Bool) {
        var created = false
        let id: RecordID
        if let found = existingBrainDatabase(title: title, metaKey: metaKey) { id = found } else {
            id = store.createDatabase(title: RichText(title), in: .block(rootID), inline: true, sampleRows: 0).databaseID
            created = true
        }
        if brainDatabaseCandidates(title: title).count > 1 { _ = mergeDuplicates(title: title, into: id) }
        store.persistence?.setMeta(metaKey, try? JSONEncoder().encode(OneID(id: id)))
        if let host = store.databases[id]?.blockID {
            store.protectedIDs.insert(host)
            if store.blocks[host]?.trashedAt != nil { store.restorePages([host]) }
        }
        return (id, created)
    }

    /// Adds a column when it is missing (existing databases from older builds get new columns this way).
    func ensureColumn(_ db: RecordID, _ name: String, _ type: PropertyType, _ configure: ((inout PropertySchema) -> Void)? = nil) {
        guard propID(db, name) == nil, let pid = store.addProperty(to: db, name: name, type: type) else { return }
        if let configure { store.updateProperty(db, pid, name: "Set up \(name)", configure) }
    }

    /// Single-target relation column pointing at `target`.
    func ensureRelation(_ db: RecordID, _ name: String, to target: RecordID) {
        ensureColumn(db, name, .relation) { s in s.relation = RelationConfig(databaseID: target, limitOne: true) }
    }

    public var runsDB: RecordID { ensureRuns() }

    private func ensureRunColumns(_ db: RecordID) {
        func add(_ n: String, _ t: PropertyType, _ c: ((inout PropertySchema) -> Void)? = nil) { ensureColumn(db, n, t, c) }
        add(RunCol.status, .select) { s in s.options = AgentRun.Status.allCases.map { SelectOption(name: $0.rawValue, color: Self.color(for: $0)) } }
        add(RunCol.kind, .select) { s in s.options = AgentRun.Kind.allCases.map { SelectOption(name: $0.rawValue) } }
        add(RunCol.agent, .relation) { [agentsDB] s in s.relation = RelationConfig(databaseID: agentsDB, limitOne: true) }
        add(RunCol.parent, .relation) { s in s.relation = RelationConfig(databaseID: db, limitOne: true) }
        add(RunCol.session, .text)
        add(RunCol.engine, .text)
        add(RunCol.model, .text)
        add(RunCol.compute, .select) { s in s.options = AgentRun.Compute.allCases.map { SelectOption(name: $0.rawValue) } }
        add(RunCol.started, .date)
        add(RunCol.ended, .date)
        add(RunCol.tokens, .number)
        add(RunCol.cost, .number) { s in s.numberFormat = .euro }
        add(RunCol.result, .text)
        add(RunCol.resultPage, .text)
    }

    private static func color(for s: AgentRun.Status) -> TColor {
        switch s {
        case .planned: return .gray
        case .running: return .blue
        case .waiting: return .yellow
        case .needsYou: return .orange
        case .done: return .green
        case .failed: return .red
        case .cancelled: return .brown
        }
    }

    // MARK: Writing

    /// Option id for a select column, creating the option when a newer build added a value.
    private func runOption(_ db: RecordID, _ col: String, _ name: String) -> PropertyValue? {
        guard let pid = propID(db, col), let oid = store.addOption(db, pid, name: name) else { return nil }
        return .select(oid)
    }

    /// Writes several columns of a run as one non-undoable change (runs are written by agents, not by the user).
    /// `coalesce` merges rapid progress updates of the same run into one change record.
    private func writeRun(_ id: RecordID, _ db: RecordID, _ values: [(String, PropertyValue?)], title: String? = nil,
                          name: String = "Update run", coalesce: String? = nil) {
        guard store.blocks[id] != nil else { return }
        let resolved: [(String, PropertyValue?)] = values.compactMap { col, v in propID(db, col).map { ($0, v) } }
        store.transact(name, coalesce: coalesce, undoable: false) { tx in
            tx.update(id) { b in
                for (pid, v) in resolved { b.values[pid] = v }
                if let title { b.text = RichText(title) }
            }
        }
    }

    /// Starts a run and returns its id.
    @discardableResult
    public func startRun(title: String, kind: AgentRun.Kind, status: AgentRun.Status = .running,
                         agentID: RecordID? = nil, parentID: RecordID? = nil, sessionID: RecordID? = nil,
                         engine: String = "", model: String = "", compute: AgentRun.Compute? = nil,
                         projectID: RecordID? = nil, at date: Date = Date()) -> RecordID {
        let db = runsDB
        var values: [(String, PropertyValue?)] = [
            (RunCol.status, runOption(db, RunCol.status, status.rawValue)),
            (RunCol.kind, runOption(db, RunCol.kind, kind.rawValue)),
            (RunCol.started, .date(DateValue(start: date, includeTime: true))),
            (RunCol.tokens, .number(0)),
        ]
        if let agentID { values.append((RunCol.agent, .relation([agentID]))) }
        if let parentID { values.append((RunCol.parent, .relation([parentID]))) }
        if let sessionID { values.append((RunCol.session, .text(RichText(sessionID)))) }
        if let projectID { values.append((RunCol.project, .relation([projectID]))) }
        if !engine.isEmpty { values.append((RunCol.engine, .text(RichText(engine)))) }
        if !model.isEmpty { values.append((RunCol.model, .text(RichText(model)))) }
        if let compute { values.append((RunCol.compute, runOption(db, RunCol.compute, compute.rawValue))) }
        if status.isTerminal { values.append((RunCol.ended, .date(DateValue(start: date, includeTime: true)))) }
        let resolved: [String: PropertyValue] = Dictionary(values.compactMap { col, v in
            guard let v, let pid = propID(db, col) else { return nil }
            return (pid, v)
        }, uniquingKeysWith: { a, _ in a })
        let user = store.userID
        return store.transact("Start run", undoable: false) { tx in
            let row = Block(type: .page, parent: .database(db), sortKey: tx.sortKey(in: .database(db), .end),
                            text: RichText(String(title.prefix(200))), values: resolved, createdBy: user)
            tx.put(row)
            return row.id
        }
    }

    /// Changes a run's status and/or its progress line (shown as the result while it runs).
    public func update(run id: RecordID, status: AgentRun.Status? = nil, progress: String? = nil, at date: Date = Date()) {
        let db = runsDB
        var values: [(String, PropertyValue?)] = []
        if let status {
            values.append((RunCol.status, runOption(db, RunCol.status, status.rawValue)))
            // Terminal → stamp the end; back to active (a session that continues) → clear it.
            values.append((RunCol.ended, status.isTerminal ? .date(DateValue(start: date, includeTime: true)) : nil))
        }
        if let progress { values.append((RunCol.result, .text(RichText(String(progress.suffix(2000)))))) }
        guard !values.isEmpty else { return }
        writeRun(id, db, values, name: "Run progress", coalesce: "run:\(id)")
    }

    /// Adds usage to a run (tokens and cost accumulate).
    public func addUsage(run id: RecordID, tokens: Int, cost: Double = 0) {
        guard tokens != 0 || cost != 0, let cur = run(id) else { return }
        let db = runsDB
        var values: [(String, PropertyValue?)] = [(RunCol.tokens, .number(Double(cur.tokens + tokens)))]
        if cost != 0 { values.append((RunCol.cost, .number(cur.cost + cost))) }
        writeRun(id, db, values, name: "Run usage", coalesce: "run:\(id)")
    }

    /// Ends a run with a result and its usage.
    public func finish(run id: RecordID, status: AgentRun.Status = .done, result: String? = nil,
                       usage: Usage = Usage(), cost: Double = 0, resultPageID: RecordID? = nil, at date: Date = Date()) {
        guard let cur = run(id) else { return }
        let db = runsDB
        let final = status.isTerminal ? status : .done
        var values: [(String, PropertyValue?)] = [
            (RunCol.status, runOption(db, RunCol.status, final.rawValue)),
            (RunCol.ended, .date(DateValue(start: date, includeTime: true))),
        ]
        if let result { values.append((RunCol.result, .text(RichText(String(result.suffix(2000)))))) }
        if usage.total != 0 { values.append((RunCol.tokens, .number(Double(cur.tokens + usage.total)))) }
        if cost != 0 { values.append((RunCol.cost, .number(cur.cost + cost))) }
        if let resultPageID { values.append((RunCol.resultPage, .text(RichText(resultPageID)))) }
        writeRun(id, db, values, name: "Finish run")
    }

    /// BSD-49: records the router's decision on the session's current run (model, compute level) and logs why.
    public func noteRoute(session sid: RecordID, _ d: RouteDecision) {
        guard let r = latestRun(forSession: sid) else { return }
        let db = runsDB
        writeRun(r.id, db, [(RunCol.model, .text(RichText(ChatRouting.label(d.choice)))),
                            (RunCol.compute, runOption(db, RunCol.compute, d.compute.runCompute.rawValue))], name: "Run route")
        let route = d.route.map { "Route **\($0.name)**" } ?? "Model chosen in the picker"
        logRun(r.id, "\(route) · \(d.compute.title) → \(ChatRouting.label(d.choice)) — \(d.reason)")
    }

    /// BSD-53: records the sandbox of the session's current run ("docker:<id>" or "local:<path>") and its snapshot
    /// names (comma-separated). The two text columns are added on first use, older Runs databases included.
    public func noteSandbox(session sid: RecordID, _ sandbox: SandboxHandle, log line: String? = nil) {
        guard let r = latestRun(forSession: sid) else { return }
        let db = runsDB
        ensureColumn(db, RunCol.sandbox, .text)
        ensureColumn(db, RunCol.snapshots, .text)
        writeRun(r.id, db, [(RunCol.sandbox, .text(RichText(sandbox.reference))),
                            (RunCol.snapshots, .text(RichText(sandbox.snapshots.map(\.name).joined(separator: ", "))))], name: "Run sandbox")
        if let line { logRun(r.id, line) }
    }

    /// Sandbox reference and snapshot names stored on a run ("" / [] when none).
    public func sandboxInfo(run id: RecordID) -> (reference: String, snapshots: [String]) {
        guard let db = existingRunsDB, let row = store.blocks[id] else { return ("", []) }
        func text(_ col: String) -> String {
            guard let pid = propID(db, col), case .text(let t)? = row.values[pid] else { return "" }
            return t.plainText
        }
        let snaps = text(RunCol.snapshots).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return (text(RunCol.sandbox), snaps)
    }

    /// Appends a line to the run's short protocol (the page body; not the full transcript).
    public func logRun(_ id: RecordID, _ markdown: String) {
        guard store.blocks[id] != nil, !markdown.isEmpty else { return }
        appendBody(id, markdown: markdown)
    }

    // MARK: Reading

    public func runs(_ filter: RunFilter = .all) -> [AgentRun] {
        guard let db = existingRunsDB else { return [] }
        return store.rows(of: db).map { decodeRun($0, db) }.filter(filter.matches).sorted { $0.startedAt > $1.startedAt }
    }

    public func run(_ id: RecordID) -> AgentRun? {
        guard let row = store.blocks[id], row.trashedAt == nil, let db = existingRunsDB, case .database(db) = row.parent else { return nil }
        return decodeRun(row, db)
    }

    /// Direct child runs (sub-agents) of a run.
    public func children(ofRun id: RecordID) -> [AgentRun] { runs(RunFilter(parentID: id)) }

    /// Latest run of a session.
    public func latestRun(forSession sid: RecordID) -> AgentRun? { runs(RunFilter(sessionID: sid)).first }

    private func decodeRun(_ row: Block, _ db: RecordID) -> AgentRun {
        func select(_ col: String) -> String? {
            guard let pid = propID(db, col), case .select(let oid)? = row.values[pid] else { return nil }
            return store.databases[db]?.property(pid)?.option(oid)?.name
        }
        func relation(_ col: String) -> RecordID? {
            guard let pid = propID(db, col), case .relation(let ids)? = row.values[pid] else { return nil }
            return ids.first
        }
        func date(_ col: String) -> Date? {
            guard let pid = propID(db, col), case .date(let d)? = row.values[pid] else { return nil }
            return d.start
        }
        func number(_ col: String) -> Double {
            guard let pid = propID(db, col), case .number(let n)? = row.values[pid] else { return 0 }
            return n
        }
        let session = text(row, db, RunCol.session), page = text(row, db, RunCol.resultPage)
        return AgentRun(id: row.id, title: row.title,
                        status: select(RunCol.status).flatMap(AgentRun.Status.init(rawValue:)) ?? .planned,
                        kind: select(RunCol.kind).flatMap(AgentRun.Kind.init(rawValue:)) ?? .session,
                        agentID: relation(RunCol.agent), parentID: relation(RunCol.parent),
                        sessionID: session.isEmpty ? nil : session,
                        engine: text(row, db, RunCol.engine), model: text(row, db, RunCol.model),
                        compute: select(RunCol.compute).flatMap(AgentRun.Compute.init(rawValue:)),
                        startedAt: date(RunCol.started) ?? row.createdAt, endedAt: date(RunCol.ended),
                        tokens: Int(number(RunCol.tokens)), cost: number(RunCol.cost),
                        result: text(row, db, RunCol.result), resultPageID: page.isEmpty ? nil : page,
                        projectID: relation(RunCol.project))
    }

    // MARK: Sessions → runs

    /// Kind of run a session gets: chats ("based") are chat runs, sessions with a parent are sub-agents.
    static func runKind(agentID: String, parentID: RecordID?) -> AgentRun.Kind {
        if parentID != nil { return .subagent }
        if agentID == BrainStore.mainThreadAgentID { return .main }   // BSD-52: the main agent's thread
        return agentID == "based" ? .chat : .session
    }

    /// Called when a session is created: it gets a run that points at it (sub-agents under the parent's run).
    func startRun(forSession sid: RecordID, title: String, agentID: String, parentID: RecordID?) {
        let parentRun = parentID.flatMap { latestRun(forSession: $0)?.id }
        let kind = Self.runKind(agentID: agentID, parentID: parentID)
        startRun(title: title, kind: kind, status: .waiting, agentID: kind == .main ? mainAgent()?.id : nil,
                 parentID: parentRun, sessionID: sid, engine: agentID, projectID: projectID(ofSession: sid))
    }

    /// Mirrors a session change onto its run. Chats get one run per turn: a chat that starts running again after
    /// its last run ended starts a new run. Coding sessions keep one run that goes back to running.
    func mirrorSession(_ sid: RecordID, status: AgentSession.Status?, addTokens: Int, result: String?, agentID: String?) {
        guard existingRunsDB != nil || status != nil else { return }
        guard let s = store.blocks[sid], s.trashedAt == nil else { return }
        var current = latestRun(forSession: sid)
        if current == nil, status == nil { return }   // sessions from before BSD-43 get a run on their next status change
        if let status {
            let target: AgentRun.Status? = {
                switch status {
                case .running: return .running
                case .waiting: return .needsYou
                case .done: return .done
                case .failed: return .failed
                case .idle:
                    // Idle after a turn was running = cancelled; before the first turn = waiting; after an end: unchanged.
                    guard let c = current else { return nil }
                    if c.status.isTerminal { return nil }
                    return c.status == .running || c.status == .needsYou ? .cancelled : .waiting
                }
            }()
            if let target {
                if current == nil || (current!.status.isTerminal && !target.isTerminal && [.chat, .main].contains(current!.kind)) {
                    let sess = sessions().first { $0.id == sid }
                    let kind = Self.runKind(agentID: agentID ?? sess?.agentID ?? "", parentID: sess?.parentID)
                    let parentRun = sess?.parentID.flatMap { latestRun(forSession: $0)?.id }
                    let id = startRun(title: s.title.isEmpty ? "Run" : s.title, kind: kind, status: target,
                                      agentID: kind == .main ? mainAgent()?.id : nil, parentID: parentRun, sessionID: sid, engine: agentID ?? sess?.agentID ?? "",
                                      projectID: sess?.projectID)
                    current = run(id)
                } else if let c = current, c.status != target {
                    if target.isTerminal { finish(run: c.id, status: target) } else { update(run: c.id, status: target) }
                    current = run(c.id)
                }
            }
        }
        guard let c = current else { return }
        if addTokens != 0 { addUsage(run: c.id, tokens: addTokens) }
        if let result { update(run: c.id, progress: result) }
        if let agentID, c.engine != agentID { writeRun(c.id, runsDB, [(RunCol.engine, .text(RichText(agentID)))]) }
    }
}

/// Pure views over runs for the start page, widgets and MCP — no store access, clock injected.
public struct RunOverview: Sendable {
    public var runs: [AgentRun]
    public var inbox: [InboxItem]
    public var agents: [Agent]

    public init(runs: [AgentRun], inbox: [InboxItem] = [], agents: [Agent] = []) {
        self.runs = runs; self.inbox = inbox; self.agents = agents
    }

    /// Runs that are working right now, newest first.
    public var running: [AgentRun] { runs.filter { $0.status == .running }.sorted { $0.startedAt > $1.startedAt } }

    /// Runs that wait for the user: status "Needs you" or a pending inbox item for their session.
    public var needsYou: [AgentRun] {
        let pendingSessions = Set(inbox.filter { $0.status == .pending }.compactMap(\.sessionID))
        return runs.filter { r in
            guard !r.status.isTerminal else { return false }
            return r.status == .needsYou || r.sessionID.map(pendingSessions.contains) == true
        }.sorted { $0.startedAt > $1.startedAt }
    }

    /// Pending inbox items that belong to a run (through its session).
    public func pendingInbox(for run: AgentRun) -> [InboxItem] {
        guard let sid = run.sessionID else { return [] }
        return inbox.filter { $0.status == .pending && $0.sessionID == sid }
    }

    /// Runs that ended at or after `date`, latest first.
    public func finishedSince(_ date: Date) -> [AgentRun] {
        runs.filter { $0.status.isTerminal && ($0.endedAt ?? $0.startedAt) >= date }
            .sorted { ($0.endedAt ?? $0.startedAt) > ($1.endedAt ?? $1.startedAt) }
    }

    /// Next scheduled runs of enabled agents, soonest first.
    public func upcoming(now: Date, limit: Int = 10, calendar: Calendar = .current) -> [(agent: Agent, at: Date)] {
        agents.compactMap { a -> (agent: Agent, at: Date)? in
            guard a.enabled, let raw = a.schedule, let s = Schedule.parse(raw) else { return nil }
            return (a, s.nextRun(after: now, lastRun: a.lastRun, calendar: calendar))
        }.sorted { $0.at < $1.at }.prefix(limit).map { $0 }
    }

    /// Cost (€) of the runs started on `now`'s calendar day.
    public func costToday(now: Date, calendar: Calendar = .current) -> Double {
        runs.filter { calendar.isDate($0.startedAt, inSameDayAs: now) }.reduce(0) { $0 + $1.cost }
    }

    /// Tokens of the runs started on `now`'s calendar day.
    public func tokensToday(now: Date, calendar: Calendar = .current) -> Int {
        runs.filter { calendar.isDate($0.startedAt, inSameDayAs: now) }.reduce(0) { $0 + $1.tokens }
    }
}
