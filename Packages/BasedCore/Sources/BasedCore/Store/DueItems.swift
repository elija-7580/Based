import Foundation

// BSD-119: what is due on a day — date mentions in text ("@Today", "@Nov 9 3 pm") and database dates with a
// reminder ("Remind" in the date editor). Used by the daily brief (BasedBrain DailyBrief) for its "Today" section.
// A full scan of the blocks: the brief runs once a day, so no index; trashed pages are left out.

/// One thing due on a day.
public struct DueItem: Sendable, Equatable {
    /// Page to open: the page that contains the mention, or the database row.
    public var pageID: RecordID
    /// Block that holds the mention (== pageID for a row's date property).
    public var blockID: RecordID
    public var pageTitle: String
    /// The line around the mention, or the date property's name for a row.
    public var text: String
    public var date: DateValue
    /// Set as a reminder (mention or property with `remind`).
    public var isReminder: Bool

    public init(pageID: RecordID, blockID: RecordID, pageTitle: String, text: String, date: DateValue, isReminder: Bool) {
        self.pageID = pageID; self.blockID = blockID; self.pageTitle = pageTitle; self.text = text; self.date = date; self.isReminder = isReminder
    }
}

extension DateValue {
    /// Whether the date (or range) touches `day` in `calendar`. Dates without a time count for their whole day.
    public func falls(on day: Date, calendar: Calendar = .current) -> Bool {
        let dayStart = calendar.startOfDay(for: day)
        guard let next = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return false }
        let from = includeTime ? start : calendar.startOfDay(for: start)
        let to = end ?? start
        return from < next && to >= dayStart
    }
}

extension WorkspaceStore {
    /// Date mentions in text and reminder dates of database rows that fall on `day`, earliest first.
    /// Database dates without a reminder are left out (every Runs/Briefs row has a date; that would be noise).
    public func dueItems(on day: Date, calendar: Calendar = .current, limit: Int = 50) -> [DueItem] {
        var out: [DueItem] = []
        var trashMemo: [RecordID: Bool] = [:]
        func trashed(_ id: RecordID) -> Bool {
            if let v = trashMemo[id] { return v }
            let v = isTrashed(id); trashMemo[id] = v; return v
        }
        func title(_ id: RecordID) -> String {
            let t = blocks[id]?.text.plainText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return t.isEmpty ? "Untitled" : t
        }
        for b in blocks.values where b.trashedAt == nil {
            // Date mentions in the block's own text (a page's title counts too).
            for run in b.text.runs {
                guard case .date(let d)? = run.mention, d.falls(on: day, calendar: calendar) else { continue }
                guard !trashed(b.id), let page = containingPage(of: b.id) else { continue }
                let line = b.type.isPageLike ? "" : b.text.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
                out.append(DueItem(pageID: page, blockID: b.id, pageTitle: title(page), text: String(line.prefix(140)),
                                   date: d, isReminder: d.remind == true))
            }
            // Reminder dates of database rows.
            guard case .database(let dbID) = b.parent, !b.values.isEmpty else { continue }
            for (pid, v) in b.values {
                guard case .date(let d) = v, d.remind == true, d.falls(on: day, calendar: calendar), !trashed(b.id) else { continue }
                let name = databases[dbID]?.properties.first { $0.id == pid }?.name ?? "Date"
                out.append(DueItem(pageID: b.id, blockID: b.id, pageTitle: title(b.id), text: name, date: d, isReminder: true))
            }
        }
        out.sort { a, b in
            // Untimed dates first (all-day), then by time, then by title for a stable order.
            if a.date.includeTime != b.date.includeTime { return !a.date.includeTime }
            if a.date.start != b.date.start { return a.date.start < b.date.start }
            if a.pageTitle != b.pageTitle { return a.pageTitle < b.pageTitle }
            return a.blockID < b.blockID
        }
        return Array(out.prefix(limit))
    }
}
