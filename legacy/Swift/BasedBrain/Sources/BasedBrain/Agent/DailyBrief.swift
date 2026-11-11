import Foundation
import BasedCore

// BSD-57: the daily brief as a shipped agent. SetupPlan.apply (BSD-56) creates the agent row "Daily brief"
// (daily 06:30); here is what its run does: collect what finished/failed since the last brief, what waits for the
// user and what is planned today (BriefInput, pure), write it as one page per day in the "Briefs" database and post
// the short version into the main agent's thread. Nothing happened → one sentence from a template, no model call.

/// What the brief is made of (pure; built from a RunOverview, clock injected).
public struct BriefInput: Sendable, Equatable {
    public struct Line: Sendable, Equatable {
        public var title: String
        public var detail: String
        public var runID: RecordID?
    }
    public var day: Date
    public var since: Date
    public var finished: [Line]
    public var failed: [Line]
    /// Pending questions/permissions and runs with status "Needs you".
    public var needsYou: [Line]
    /// Scheduled agent runs later today.
    public var plannedToday: [Line]
    /// "Project: latest update" of active projects.
    public var projectUpdates: [String]
    /// BSD-119: date mentions and reminders of today (page title — time · line).
    public var dueToday: [Line] = []

    /// Nothing worth a model call.
    public var isEmpty: Bool {
        finished.isEmpty && failed.isEmpty && needsYou.isEmpty && plannedToday.isEmpty && projectUpdates.isEmpty && dueToday.isEmpty
    }

    /// Run kinds that count as work in the brief (chat turns and heartbeats are conversation, not work).
    static let workKinds: Set<AgentRun.Kind> = [.session, .schedule, .subagent]

    /// - Parameters:
    ///   - since: start of the window (the brief's previous run); nil = start of yesterday.
    ///   - briefAgentID: the brief agent itself (its own runs and next run are left out).
    public static func make(overview: RunOverview, now: Date, since: Date? = nil, briefAgentID: RecordID? = nil,
                            projectUpdates: [String] = [], due: [DueItem] = [], calendar: Calendar = .current) -> BriefInput {
        let today = calendar.startOfDay(for: now)
        let start = since ?? calendar.date(byAdding: .day, value: -1, to: today)!
        func short(_ s: String) -> String {
            let one = s.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            return one.count > 140 ? String(one.prefix(139)) + "…" : one
        }
        let ended = overview.finishedSince(start)
            .filter { workKinds.contains($0.kind) && (briefAgentID == nil || $0.agentID != briefAgentID) }
        let finished = ended.filter { $0.status == .done }.map { Line(title: $0.title, detail: short($0.result), runID: $0.id) }
        let failed = ended.filter { $0.status == .failed }.map { Line(title: $0.title, detail: short($0.result), runID: $0.id) }

        var needs: [Line] = []
        var seenSessions = Set<RecordID>()
        for i in overview.inbox where i.status == .pending && i.kind != .notice {
            if let s = i.sessionID { seenSessions.insert(s) }
            needs.append(Line(title: i.title, detail: short(i.detail), runID: nil))
        }
        for r in overview.needsYou where r.sessionID.map({ !seenSessions.contains($0) }) ?? true {
            needs.append(Line(title: r.title, detail: short(r.result), runID: r.id))
        }

        let endOfDay = calendar.date(byAdding: .day, value: 1, to: today)!
        let planned = overview.upcoming(now: now, limit: 50, calendar: calendar)
            .filter { !$0.agent.isMain && $0.agent.id != briefAgentID && $0.at < endOfDay }
            .map { u -> Line in
                let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
                f.timeZone = calendar.timeZone; f.dateFormat = "HH:mm"
                return Line(title: u.agent.name, detail: f.string(from: u.at), runID: nil)
            }
        let dueLines = due.map { d -> Line in
            var detail: [String] = []
            if d.date.includeTime {
                let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
                f.timeZone = calendar.timeZone; f.dateFormat = "HH:mm"
                detail.append(f.string(from: d.date.start))
            }
            if d.isReminder { detail.append("reminder") }
            if !d.text.isEmpty { detail.append(short(d.text)) }
            return Line(title: d.pageTitle, detail: detail.joined(separator: " · "), runID: nil)
        }
        return BriefInput(day: today, since: start, finished: finished, failed: failed, needsYou: needs,
                          plannedToday: planned, projectUpdates: projectUpdates, dueToday: dueLines)
    }

    /// The sentence used when nothing happened (no model call).
    public static let quietDay = "Quiet night — nothing finished, nothing waits for you, nothing is planned today."

    /// One line for the start page and the main thread: "3 finished, 1 failed, 2 need you, 4 planned today."
    public var headline: String {
        guard !isEmpty else { return Self.quietDay }
        var parts: [String] = []
        if !finished.isEmpty { parts.append("\(finished.count) finished") }
        if !failed.isEmpty { parts.append("\(failed.count) failed") }
        if !needsYou.isEmpty { parts.append(needsYou.count == 1 ? "1 needs you" : "\(needsYou.count) need you") }
        if !plannedToday.isEmpty { parts.append("\(plannedToday.count) planned today") }
        if !dueToday.isEmpty { parts.append("\(dueToday.count) due today") }
        if parts.isEmpty { parts.append("\(projectUpdates.count) project update\(projectUpdates.count == 1 ? "" : "s")") }
        return parts.joined(separator: ", ") + "."
    }

    /// The brief without a model: most important first (needs you, today, failed, finished, planned, projects).
    public var markdown: String {
        guard !isEmpty else { return Self.quietDay }
        var out: [String] = []
        func section(_ title: String, _ lines: [Line]) {
            guard !lines.isEmpty else { return }
            out.append("## \(title)")
            out.append(lines.map { "- \($0.title)" + ($0.detail.isEmpty ? "" : " — \($0.detail)") }.joined(separator: "\n"))
        }
        section("Needs you", needsYou)
        section("Today", dueToday)
        section("Failed", failed)
        section("Finished", finished)
        section("Planned today", plannedToday)
        if !projectUpdates.isEmpty {
            out.append("## Projects")
            out.append(projectUpdates.map { "- " + $0 }.joined(separator: "\n"))
        }
        return out.joined(separator: "\n\n")
    }

    /// Prompt for the model: the facts, in the order above.
    public var prompt: String {
        "Write today's brief from these facts. Keep it under ten lines, most important first, plain Markdown, " +
        "no greeting. Do not invent anything and do not start new work.\n\n" + markdown
    }
}

@MainActor
extension BrainStore {
    static let briefsMetaKey = "brain.briefs"
    enum BriefCol { static let date = "Date", summary = "Summary" }

    /// Whether `agent` is the shipped daily brief: Kind "brief" (set by SetupPlan.apply). A user's own agent that
    /// happens to be called "Daily brief" stays a normal agent.
    public nonisolated static func isDailyBrief(_ agent: Agent) -> Bool {
        !agent.isMain && agent.kind == AgentCol.briefKind
    }

    /// Marks `id` as the shipped daily brief (Kind column, created when missing).
    func markDailyBrief(_ id: RecordID) {
        ensureColumn(agentsDB, AgentCol.kind, .text)
        if let p = propID(agentsDB, AgentCol.kind), let row = store.blocks[id], text(row, agentsDB, AgentCol.kind) != AgentCol.briefKind {
            store.setValue(id, p, .text(RichText(AgentCol.briefKind)))
        }
    }

    /// The "Briefs" database (one row per day), created on first use and protected like the other Brain databases.
    @discardableResult
    public func ensureBriefs() -> RecordID {
        let (db, _) = ensureBrainDatabase(title: "Briefs", metaKey: Self.briefsMetaKey)
        ensureColumn(db, BriefCol.date, .date)
        ensureColumn(db, BriefCol.summary, .text)
        return db
    }

    var existingBriefsDB: RecordID? { existingBrainDatabase(title: "Briefs", metaKey: Self.briefsMetaKey) }

    static func briefTitle(_ day: Date, calendar: Calendar = .current) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
        f.timeZone = calendar.timeZone; f.dateFormat = "yyyy-MM-dd"
        return "Brief " + f.string(from: day)
    }

    /// The brief page of `day` (row of Briefs), if one exists.
    public func briefPage(on day: Date, calendar: Calendar = .current) -> RecordID? {
        guard let db = existingBriefsDB else { return nil }
        let title = Self.briefTitle(calendar.startOfDay(for: day), calendar: calendar)
        return store.rows(of: db).first { $0.trashedAt == nil && $0.text.plainText == title }?.id
    }

    /// Today's brief for the start page: (page, summary line), nil when there is none yet.
    public func todaysBrief(now: Date = Date(), calendar: Calendar = .current) -> (page: RecordID, summary: String)? {
        guard let db = existingBriefsDB, let id = briefPage(on: now, calendar: calendar), let row = store.blocks[id] else { return nil }
        return (id, text(row, db, BriefCol.summary))
    }

    /// Writes the day's brief: a new row, or — when the brief ran again the same day — a new section appended
    /// below the earlier one (nothing is overwritten). Returns the page id.
    @discardableResult
    public func saveBrief(day: Date, summary: String, markdown: String, at now: Date = Date(), calendar: Calendar = .current) -> RecordID {
        let db = ensureBriefs()
        let dayStart = calendar.startOfDay(for: day)
        if let existing = briefPage(on: dayStart, calendar: calendar) {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
            f.timeZone = calendar.timeZone; f.dateFormat = "HH:mm"
            store.insertImported(MarkdownImporter().parse("## Update \(f.string(from: now))\n\n" + markdown), in: .block(existing), name: "Update brief")
            if let pid = propID(db, BriefCol.summary) { store.setValue(existing, pid, .text(RichText(summary))) }
            return existing
        }
        var values: [String: PropertyValue] = [:]
        if let pid = propID(db, BriefCol.date) { values[pid] = .date(DateValue(start: dayStart, includeTime: false)) }
        if let pid = propID(db, BriefCol.summary) { values[pid] = .text(RichText(summary)) }
        let id = store.addRow(to: db, title: RichText(Self.briefTitle(dayStart, calendar: calendar)), values: values)
        store.insertImported(MarkdownImporter().parse(markdown), in: .block(id), name: "Daily brief")
        return id
    }

    /// The input for a brief run now (reads only).
    public func briefInput(for agent: Agent, now: Date = Date(), calendar: Calendar = .current) -> BriefInput {
        let overview = RunOverview(runs: runs(), inbox: inbox(pendingOnly: true), agents: agents())
        let updates = projects().filter { $0.status == .active }
            .compactMap { p in latestUpdates(ofProject: p.id, limit: 1).first.map { "\(p.name): \($0)" } }
        // BSD-119: date mentions and reminders of today (the Brain's own databases carry no reminders).
        let due = store.dueItems(on: now, calendar: calendar, limit: 30)
        return BriefInput.make(overview: overview, now: now, since: agent.lastRun, briefAgentID: agent.id,
                               projectUpdates: updates, due: due, calendar: calendar)
    }
}

extension AgentRuntime {
    /// The daily brief's run: facts → (model, only when something happened) → page in Briefs + line in the main
    /// thread. Without a model (none configured, or the call fails) the facts themselves are the brief.
    @discardableResult
    public func runDailyBrief(agent: Agent, trigger: String, now: Date = Date()) async -> Outcome? {
        let brain = tools.brain
        let (input, runID) = await MainActor.run { () -> (BriefInput, RecordID) in
            let id = brain.startRun(title: agent.name, kind: .schedule, agentID: agent.id, engine: "based", model: agent.model ?? "", at: now)
            brain.logRun(id, "Trigger: \(trigger)")
            return (brain.briefInput(for: agent, now: now), id)
        }
        var body = input.markdown
        var usage = Usage()
        var cost = 0.0
        var note: String?
        if !input.isEmpty, registry.resolve(agent.model ?? "") != nil {
            do {
                let resolved = registry.resolve(agent.model ?? "").map { "\($0.0.id)/\($0.1)" } ?? (agent.model ?? "")
                let o = try await run(prompt: input.prompt, modelRef: agent.model, systemExtra: agent.instructions,
                                      permissions: AgentPermissions(mode: .plan))
                let t = o.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { body = t }
                usage = o.usage
                cost = ModelPricing.estimate(model: resolved, usage: o.usage)
            } catch {
                note = "Model unavailable (\(error)); the brief lists the facts."
            }
        }
        let headline = input.headline
        let text = body
        let n = note
        let u = usage, c = cost
        await MainActor.run {
            let page = brain.saveBrief(day: now, summary: headline, markdown: text, at: now)
            let thread = brain.mainAgent() != nil ? brain.ensureMainThread() : brain.mainThread()
            if let thread { brain.appendTranscript(thread, role: "Notice", markdown: "**Daily brief** — \(headline) (page \(page))") }
            if let n { brain.logRun(runID, n) }
            brain.markRun(agent.id); brain.logRun(agent.id, summary: headline, usage: u)
            brain.finish(run: runID, status: .done, result: headline, usage: u, cost: c, resultPageID: page, at: now)
        }
        return Outcome(text: body, usage: usage, steps: 0, transcript: [])
    }
}
