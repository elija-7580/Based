import Foundation
import BasedCore

/// Human schedule strings: "every 15m", "every 2h", "hourly", "daily 07:30", "weekly mon 09:00",
/// "weekdays 18:00", "monthly 1 08:00", or 5-field cron ("*/30 * * * *", "0 7 * * 1-5").
public struct Schedule: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case every(TimeInterval)
        case daily(hour: Int, minute: Int, weekdays: Set<Int>?)   // weekdays: 1 = Sunday … 7 = Saturday (Calendar)
        case monthly(day: Int, hour: Int, minute: Int)
        case cron(minute: Set<Int>, hour: Set<Int>, day: Set<Int>, month: Set<Int>, weekday: Set<Int>) // weekday 0-6, 0 = Sunday
    }
    public var kind: Kind
    public var source: String

    public static func parse(_ raw: String) -> Schedule? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty else { return nil }
        let parts = s.split(separator: " ").map(String.init)
        if parts.count == 5, let c = parseCron(parts) { return Schedule(kind: c, source: raw) }
        func hm(_ t: String?) -> (Int, Int)? {
            guard let t else { return nil }
            let p = t.split(separator: ":"); guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
            return (h, m)
        }
        let days: [String: Int] = ["sun": 1, "mon": 2, "tue": 3, "wed": 4, "thu": 5, "fri": 6, "sat": 7]
        switch parts[0] {
        case "hourly": return Schedule(kind: .every(3600), source: raw)
        case "every":
            guard parts.count >= 2 else { return nil }
            let v = parts[1]
            if let n = Double(v.dropLast()), let u = v.last {
                switch u { case "m": return Schedule(kind: .every(n * 60), source: raw)
                case "h": return Schedule(kind: .every(n * 3600), source: raw)
                case "d": return Schedule(kind: .every(n * 86400), source: raw)
                default: return nil }
            }
            if parts.count >= 3, let n = Double(v) {
                if parts[2].hasPrefix("min") { return Schedule(kind: .every(n * 60), source: raw) }
                if parts[2].hasPrefix("hour") { return Schedule(kind: .every(n * 3600), source: raw) }
                if parts[2].hasPrefix("day") { return Schedule(kind: .every(n * 86400), source: raw) }
            }
            return nil
        case "daily":
            let (h, m) = hm(parts.count > 1 ? parts[1] : nil) ?? (9, 0)
            return Schedule(kind: .daily(hour: h, minute: m, weekdays: nil), source: raw)
        case "weekdays":
            let (h, m) = hm(parts.count > 1 ? parts[1] : nil) ?? (9, 0)
            return Schedule(kind: .daily(hour: h, minute: m, weekdays: [2, 3, 4, 5, 6]), source: raw)
        case "weekly":
            guard parts.count >= 2 else { return nil }
            let ds = Set(parts[1].split(separator: ",").compactMap { days[String($0.prefix(3))] })
            guard !ds.isEmpty else { return nil }
            let (h, m) = hm(parts.count > 2 ? parts[2] : nil) ?? (9, 0)
            return Schedule(kind: .daily(hour: h, minute: m, weekdays: ds), source: raw)
        case "monthly":
            guard parts.count >= 2, let d = Int(parts[1]), (1...31).contains(d) else { return nil }
            let (h, m) = hm(parts.count > 2 ? parts[2] : nil) ?? (9, 0)
            return Schedule(kind: .monthly(day: d, hour: h, minute: m), source: raw)
        default: return nil
        }
    }

    private static func parseCron(_ f: [String]) -> Kind? {
        func field(_ s: String, _ range: ClosedRange<Int>) -> Set<Int>? {
            var out = Set<Int>()
            for part in s.split(separator: ",") {
                let p = String(part)
                let (base, step) = p.contains("/") ? (String(p.split(separator: "/")[0]), Int(p.split(separator: "/")[1]) ?? 1) : (p, 1)
                var lo = range.lowerBound, hi = range.upperBound
                if base != "*" {
                    let r = base.split(separator: "-").compactMap { Int($0) }
                    guard let first = r.first else { return nil }
                    lo = first; hi = r.count > 1 ? r[1] : (p.contains("/") ? range.upperBound : first)
                }
                guard lo >= range.lowerBound, hi <= range.upperBound, lo <= hi, step > 0 else { return nil }
                for v in stride(from: lo, through: hi, by: step) { out.insert(v) }
            }
            return out
        }
        guard let mi = field(f[0], 0...59), let h = field(f[1], 0...23), let d = field(f[2], 1...31), let mo = field(f[3], 1...12), let wd = field(f[4], 0...7) else { return nil }
        return .cron(minute: mi, hour: h, day: d, month: mo, weekday: Set(wd.map { $0 == 7 ? 0 : $0 }))
    }

    /// Next fire time strictly after `after`, given the last run (for interval schedules).
    public func nextRun(after: Date, lastRun: Date?, calendar: Calendar = .current) -> Date {
        switch kind {
        case .every(let interval):
            guard let lastRun else { return after }
            return max(after, lastRun.addingTimeInterval(interval))
        case .daily(let hour, let minute, let weekdays):
            var t = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: after) ?? after
            if t <= after { t = calendar.date(byAdding: .day, value: 1, to: t) ?? t }
            if let weekdays {
                var guardCount = 0
                while !weekdays.contains(calendar.component(.weekday, from: t)), guardCount < 8 {
                    t = calendar.date(byAdding: .day, value: 1, to: t) ?? t; guardCount += 1
                }
            }
            return t
        case .monthly(let day, let hour, let minute):
            var comps = calendar.dateComponents([.year, .month], from: after)
            comps.day = day; comps.hour = hour; comps.minute = minute
            var t = calendar.date(from: comps) ?? after
            if t <= after { comps.month = (comps.month ?? 1) + 1; t = calendar.date(from: comps) ?? t }
            return t
        case .cron(let minute, let hour, let day, let month, let weekday):
            var t = calendar.date(bySetting: .second, value: 0, of: after).map { $0 <= after ? $0.addingTimeInterval(60) : $0 } ?? after
            t = calendar.date(bySetting: .second, value: 0, of: t) ?? t
            for _ in 0..<(60 * 24 * 366) {
                let c = calendar.dateComponents([.minute, .hour, .day, .month, .weekday], from: t)
                if minute.contains(c.minute!), hour.contains(c.hour!), day.contains(c.day!), month.contains(c.month!), weekday.contains(c.weekday! - 1) { return t }
                t = t.addingTimeInterval(60)
            }
            return t
        }
    }

    public func isDue(now: Date, lastRun: Date?) -> Bool {
        switch kind {
        case .every: return lastRun.map { nextRun(after: $0, lastRun: $0) <= now } ?? true
        default:
            // Due when the most recent fire time (<= now) is after the last run.
            let probe = lastRun ?? now.addingTimeInterval(-86400 * 32)
            return nextRun(after: probe, lastRun: lastRun) <= now
        }
    }
}

/// Runs scheduled agents. Owned by the server (always on) and by the Mac app (while it runs).
public final class AgentScheduler: @unchecked Sendable {
    public let runtime: AgentRuntime
    public var tick: TimeInterval = 60
    public var onEvent: (@Sendable (String) -> Void)?
    private var task: Task<Void, Never>?
    private var tokensToday: [RecordID: (day: String, used: Int)] = [:]
    private let lock = NSLock()

    public init(runtime: AgentRuntime) { self.runtime = runtime }

    public func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.runDue()
                try? await Task.sleep(nanoseconds: UInt64((self?.tick ?? 60) * 1_000_000_000))
            }
        }
    }
    public func stop() { task?.cancel(); task = nil }

    /// Agents whose schedule is due now (pure; used by tests and by the UI).
    public static func due(_ agents: [Agent], now: Date = Date()) -> [Agent] {
        agents.filter { a in
            guard a.enabled, let s = a.schedule, let sched = Schedule.parse(s) else { return false }
            return sched.isDue(now: now, lastRun: a.lastRun)
        }
    }

    public func runDue(now: Date = Date()) async {
        let agents = await MainActor.run { runtime.tools.brain.agents() }
        for a in Self.due(agents, now: now) {
            if let budget = a.dailyTokenBudget, usedToday(a.id) >= budget { onEvent?("Skip \(a.name): daily token budget reached"); continue }
            onEvent?("Run \(a.name) (\(a.schedule ?? ""))")
            if let o = await runtime.run(agent: a, trigger: "schedule \(a.schedule ?? "")") { addUsage(a.id, o.usage.total); onEvent?("Done \(a.name): \(o.usage.total) tokens") }
        }
    }

    private func dayKey() -> String { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date()) }
    private func usedToday(_ id: RecordID) -> Int { lock.lock(); defer { lock.unlock() }; let e = tokensToday[id]; return e?.day == dayKey() ? e!.used : 0 }
    private func addUsage(_ id: RecordID, _ n: Int) {
        lock.lock(); defer { lock.unlock() }
        let day = dayKey(), prev = tokensToday[id]
        tokensToday[id] = (day, (prev?.day == day ? prev!.used : 0) + n)
    }
}
