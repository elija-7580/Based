import Foundation
import BasedCore

// BSD-51: budget per agent and schedules without double runs (ADR 0007: "a budget per agent, a heartbeat").
//
// - Lease: before a scheduled run the scheduler writes "Running since" + "Node" (and "Last run") into the agent row
//   in one change. Another node that sees a fresh lease skips the agent. The lease expires after twice the agent's
//   usual run time (at most one hour), so a crashed node does not block an agent forever.
// - Budget: "Monthly budget" (€) per agent; spending is the sum of the agent's runs this calendar month (cost, or an
//   estimate from tokens and model when a run has no cost). At 80 % a notice lands in the Inbox ("Needs you"), at 100 %
//   scheduled runs stop until the next month. The daily token budget is summed from Runs too (it used to live in RAM).
// - Host: by default the server runs schedules; the Mac only when no server is configured (or when set to).

/// Column names of the Agents database added by BSD-51.
enum AgentCol {
    static let monthlyBudget = "Monthly budget", spent = "Spent this month"
    static let runningSince = "Running since", node = "Node"
    /// BSD-52: "main" marks the main agent's row.
    static let kind = "Kind", mainKind = "main"
}

/// Where scheduled agents run.
public enum ScheduleHost: String, CaseIterable, Sendable {
    /// The server when one is configured, otherwise this device.
    case auto = "auto"
    case server = "server"
    case thisDevice = "device"

    public var label: String {
        switch self {
        case .auto: return "Automatic (server if configured)"
        case .server: return "Server only"
        case .thisDevice: return "This device"
        }
    }

    /// Whether the app on this device runs the scheduler. With "this device" and a server both run, and the lease
    /// keeps them from running the same agent twice.
    public func runsOnThisDevice(serverConfigured: Bool) -> Bool {
        switch self {
        case .auto: return !serverConfigured
        case .server: return false
        case .thisDevice: return true
        }
    }

    /// Reads the stored setting; builds before BSD-51 stored a Bool "run on this device too".
    public static func stored(_ raw: String?, legacyLocal: Bool?) -> ScheduleHost {
        if let raw, let h = ScheduleHost(rawValue: raw) { return h }
        switch legacyLocal {
        case true?: return .thisDevice
        case false?: return .server
        case nil: return .auto
        }
    }
}

/// Rough prices to estimate the cost of a run when the engine reports none (€ per million tokens).
public enum ModelPricing {
    public struct Price: Equatable, Sendable { public var input: Double; public var output: Double }

    public static let free = Price(input: 0, output: 0)
    public static let small = Price(input: 1, output: 5)
    public static let balanced = Price(input: 3, output: 15)
    public static let strong = Price(input: 5, output: 25)

    /// Price class from the model name (provider prefix allowed): local models cost nothing.
    public static func price(for model: String) -> Price {
        let m = model.lowercased()
        if m.hasPrefix("ollama/") || m.hasPrefix("apple/") || m.contains("on-device") { return free }
        if ["haiku", "mini", "flash", "nano", "small"].contains(where: m.contains) { return small }
        if ["opus", "gpt-5", "-pro", "ultra"].contains(where: m.contains) { return strong }
        return balanced
    }

    public static func estimate(model: String, usage: Usage) -> Double {
        let p = price(for: model)
        return (Double(usage.inputTokens) * p.input + Double(usage.outputTokens) * p.output) / 1_000_000
    }
}

/// Pure budget and lease rules (no store access, clock injected).
public enum AgentBudget {
    /// The agent's spending in `now`'s calendar month: run cost, or an estimate from tokens when a run has none.
    public static func spentThisMonth(_ runs: [AgentRun], agentID: RecordID, now: Date, calendar: Calendar = .current) -> Double {
        runs.filter { $0.agentID == agentID && calendar.isDate($0.startedAt, equalTo: now, toGranularity: .month) }
            .reduce(0) { sum, r in
                sum + (r.cost > 0 ? r.cost : ModelPricing.estimate(model: r.model, usage: Usage(inputTokens: r.tokens, outputTokens: 0)))
            }
    }

    /// Tokens of the agent's runs started on `now`'s calendar day.
    public static func tokensToday(_ runs: [AgentRun], agentID: RecordID, now: Date, calendar: Calendar = .current) -> Int {
        runs.filter { $0.agentID == agentID && calendar.isDate($0.startedAt, inSameDayAs: now) }.reduce(0) { $0 + $1.tokens }
    }

    /// How long a lease holds: twice the agent's usual run time (median of its finished runs, 10 min when unknown),
    /// at least 2 minutes and at most one hour.
    public static func leaseTTL(_ runs: [AgentRun], agentID: RecordID) -> TimeInterval {
        let durations = runs.filter { $0.agentID == agentID && $0.status.isTerminal }
            .compactMap { r in r.endedAt.map { $0.timeIntervalSince(r.startedAt) } }
            .filter { $0 >= 0 }.sorted()
        let expected = durations.isEmpty ? 600 : durations[durations.count / 2]
        return min(max(2 * expected, 120), 3600)
    }

    public enum Level: Equatable, Sendable { case ok, warning, exhausted }

    /// Budget level: warning from 80 %, exhausted from 100 %.
    public static func level(spent: Double, budget: Double?) -> Level {
        guard let budget, budget >= 0 else { return .ok }
        if spent >= budget { return .exhausted }
        if spent >= 0.8 * budget { return .warning }
        return .ok
    }

    /// Whether `agent` holds a lease that is still fresh at `now`.
    public static func leaseHeld(_ agent: Agent, now: Date, ttl: TimeInterval) -> Bool {
        guard let since = agent.runningSince, agent.runningNode?.isEmpty == false else { return false }
        return now.timeIntervalSince(since) < ttl && since <= now.addingTimeInterval(300)
    }

    public enum Decision: Equatable, Sendable {
        case run(warning: Bool)
        case skipLeased(node: String, since: Date)
        case skipBudget(String)
        case skipNotDue
    }

    /// Whether a scheduled run may start: not due any more (another node ran it) → skip; a fresh lease → skip;
    /// monthly budget or daily tokens used up → skip; otherwise run (with a warning from 80 % of the budget).
    public static func decide(_ agent: Agent, runs: [AgentRun], now: Date, calendar: Calendar = .current) -> Decision {
        let ttl = leaseTTL(runs, agentID: agent.id)
        if leaseHeld(agent, now: now, ttl: ttl), let node = agent.runningNode, let since = agent.runningSince {
            return .skipLeased(node: node, since: since)
        }
        if AgentScheduler.due([agent], now: now, calendar: calendar).isEmpty { return .skipNotDue }
        if let daily = agent.dailyTokenBudget, tokensToday(runs, agentID: agent.id, now: now, calendar: calendar) >= daily {
            return .skipBudget("daily token budget reached")
        }
        let spent = spentThisMonth(runs, agentID: agent.id, now: now, calendar: calendar)
        switch level(spent: spent, budget: agent.monthlyBudget) {
        case .exhausted: return .skipBudget(String(format: "monthly budget reached (€%.2f of €%.2f)", spent, agent.monthlyBudget ?? 0))
        case .warning: return .run(warning: true)
        case .ok: return .run(warning: false)
        }
    }

    static func monthKey(_ now: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month], from: now)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}

@MainActor
extension BrainStore {
    /// Adds the BSD-51 columns to an Agents database (older brains get them on first use).
    func agentBudgetColumns(_ db: RecordID) {
        ensureColumn(db, AgentCol.monthlyBudget, .number) { s in s.numberFormat = .euro }
        ensureColumn(db, AgentCol.spent, .number) { s in s.numberFormat = .euro }
        ensureColumn(db, AgentCol.runningSince, .date)
        ensureColumn(db, AgentCol.node, .text)
        ensureColumn(db, PermissionCol.name, .text)
    }

    /// Sets an agent's monthly budget in euros (nil = unlimited).
    public func setMonthlyBudget(agent id: RecordID, _ euros: Double?) {
        agentBudgetColumns(agentsDB)
        writeAgent(id, [(AgentCol.monthlyBudget, euros.map { .number($0) })], name: "Set agent budget")
    }

    /// Spending of an agent this month (from Runs).
    public func spentThisMonth(agent id: RecordID, now: Date = Date(), calendar: Calendar = .current) -> Double {
        AgentBudget.spentThisMonth(runs(RunFilter(agentID: id)), agentID: id, now: now, calendar: calendar)
    }

    /// Decides whether a scheduled run of `agent` may start and, if so, takes the lease in the same change:
    /// Running since + Node + Last run. Re-reads the row, so a lease another node wrote (and that synced) counts.
    /// Writes an Inbox notice at 80 % and at 100 % of the monthly budget (once per agent and month).
    public func beginScheduledRun(_ agent: Agent, node: String, now: Date = Date(), calendar: Calendar = .current) -> AgentBudget.Decision {
        let fresh = agents().first { $0.id == agent.id } ?? agent
        let runs = runs(RunFilter(agentID: agent.id))
        let d = AgentBudget.decide(fresh, runs: runs, now: now, calendar: calendar)
        let spent = AgentBudget.spentThisMonth(runs, agentID: agent.id, now: now, calendar: calendar)
        switch d {
        case .run(let warning):
            if warning { budgetNotice(fresh, spent: spent, exhausted: false, now: now, calendar: calendar) }
            agentBudgetColumns(agentsDB)
            writeAgent(agent.id, [(AgentCol.runningSince, .date(DateValue(start: now, includeTime: true))),
                                  (AgentCol.node, .text(RichText(node))),
                                  ("Last run", .date(DateValue(start: now, includeTime: true)))], name: "Start scheduled run")
        case .skipBudget where fresh.monthlyBudget != nil && spent >= (fresh.monthlyBudget ?? 0):
            budgetNotice(fresh, spent: spent, exhausted: true, now: now, calendar: calendar)
        default: break
        }
        return d
    }

    /// Clears the lease (only the node that holds it) and stores this month's spending on the agent row.
    public func releaseLease(agent id: RecordID, node: String, now: Date = Date(), calendar: Calendar = .current) {
        guard let a = agents().first(where: { $0.id == id }) else { return }
        var values: [(String, PropertyValue?)] = [(AgentCol.spent, .number((spentThisMonth(agent: id, now: now, calendar: calendar) * 100).rounded() / 100))]
        if a.runningNode == node { values += [(AgentCol.runningSince, nil), (AgentCol.node, nil)] }
        writeAgent(id, values, name: "Finish scheduled run")
    }

    private func budgetNotice(_ a: Agent, spent: Double, exhausted: Bool, now: Date, calendar: Calendar) {
        let month = AgentBudget.monthKey(now, calendar: calendar)
        let title = exhausted ? "Budget used up: \(a.name) (\(month))" : "Budget at 80 %: \(a.name) (\(month))"
        guard !inbox().contains(where: { $0.title == title }) else { return }
        let budget = a.monthlyBudget ?? 0
        let detail = String(format: "%@ has spent €%.2f of its €%.2f budget this month. ", a.name, spent, budget)
            + (exhausted ? "Scheduled runs are paused until next month or until you raise the budget in Agent Brain → Agents."
                         : "Scheduled runs stop at 100 %.")
        addInbox(title: title, kind: .notice, sessionID: nil, detail: detail)
    }

    private func writeAgent(_ id: RecordID, _ values: [(String, PropertyValue?)], name: String) {
        guard store.blocks[id] != nil else { return }
        let resolved: [(String, PropertyValue?)] = values.compactMap { col, v in propID(agentsDB, col).map { ($0, v) } }
        guard !resolved.isEmpty else { return }
        store.transact(name, undoable: false) { tx in
            tx.update(id) { b in for (pid, v) in resolved { b.values[pid] = v } }
        }
    }
}
