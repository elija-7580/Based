import Foundation
import Testing
@testable import BasedCore

/// BSD-119: date mentions and reminder dates of a day, for the daily brief.
@MainActor
@Suite struct DueItemsTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Europe/Vienna")!; return c }
    private func day(_ d: Int, _ h: Int = 0, _ m: Int = 0) -> Date {
        cal.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))!
    }

    @Test func dateFallsOnDay() {
        #expect(DateValue(start: day(9)).falls(on: day(9, 15), calendar: cal))
        #expect(!DateValue(start: day(10)).falls(on: day(9, 15), calendar: cal))
        #expect(DateValue(start: day(9, 23, 59), includeTime: true).falls(on: day(9), calendar: cal))
        #expect(!DateValue(start: day(10, 0, 0), includeTime: true).falls(on: day(9), calendar: cal))
        // A range touching the day counts.
        #expect(DateValue(start: day(7), end: day(11)).falls(on: day(9), calendar: cal))
        #expect(!DateValue(start: day(5), end: day(8)).falls(on: day(9), calendar: cal))
    }

    @Test func findsMentionsAndRowRemindersOfTheDay() throws {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "due")
        let notes = s.createPage(title: "Notes")
        let call = s.insertBlock(.todo, text: RichText(runs: [TextRun("Call the bank "),
                                                               TextRun("@15:00", mention: .date(DateValue(start: day(9, 15), includeTime: true, remind: true)))]),
                                 in: .block(notes))
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("Review "), TextRun("@Today", mention: .date(DateValue(start: day(9))))]), in: .block(notes))
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("Tomorrow "), TextRun("@Tomorrow", mention: .date(DateValue(start: day(10))))]), in: .block(notes))
        // Trashed page: left out.
        let old = s.createPage(title: "Old")
        _ = s.insertBlock(.text, text: RichText(runs: [TextRun("x", mention: .date(DateValue(start: day(9))))]), in: .block(old))
        _ = s.trashPages([old])

        // Database: the reminder date counts, a plain date of today does not.
        let db = s.createDatabase(title: "Tasks", in: .block(notes), inline: true, sampleRows: 0)
        let due = try #require(s.addProperty(to: db.databaseID, name: "Due", type: .date))
        let rowRemind = s.addRow(to: db.databaseID, title: "Pay invoice", values: [due: .date(DateValue(start: day(9), remind: true))])
        _ = s.addRow(to: db.databaseID, title: "Plain", values: [due: .date(DateValue(start: day(9)))])

        let items = s.dueItems(on: day(9, 8), calendar: cal)
        #expect(items.count == 3)
        // All-day first (by title), then timed.
        #expect(items.map(\.pageTitle) == ["Notes", "Pay invoice", "Notes"])
        #expect(items[0].text == "Review @Today" && !items[0].isReminder)
        #expect(items[1].pageID == rowRemind && items[1].text == "Due" && items[1].isReminder)
        #expect(items[2].blockID == call && items[2].pageID == notes && items[2].isReminder && items[2].text.hasPrefix("Call the bank"))
        #expect(s.dueItems(on: day(11), calendar: cal).isEmpty)
        #expect(s.dueItems(on: day(9), calendar: cal, limit: 1).count == 1)
    }
}
