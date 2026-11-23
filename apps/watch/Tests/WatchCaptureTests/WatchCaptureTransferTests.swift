// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import Foundation
import XCTest
@testable import WatchCapture

/// BSD-66: transfer format and outbox of the Apple Watch app
/// (from legacy/Swift/BasedCore/Tests/BasedCoreTests/WatchCaptureTransferTests.swift, plus text notes and the day count).
final class WatchCaptureTransferTests: XCTestCase {
    func testMetadataRoundTripsAndRejectsForeignOrNewer() throws {
        let m = WatchCaptureMeta(id: "abc", capturedAt: Date(timeIntervalSince1970: 1_800_000_000.5), duration: 4.2)
        XCTAssertEqual(try WatchCaptureMeta(dictionary: m.dictionary), m)
        // Property-list types only (WCSession refuses anything else).
        XCTAssertTrue(m.dictionary.values.allSatisfy { $0 is String || $0 is Double || $0 is Int })

        // Numbers may arrive as Int/Double either way; a missing extension means m4a.
        let loose = try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "v": 1.0, "id": "x", "at": 1_800_000_000, "dur": 3])
        XCTAssertEqual(loose.capturedAt, Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(loose.duration, 3)
        XCTAssertEqual(loose.fileExtension, "m4a")
        XCTAssertFalse(loose.isText)

        XCTAssertThrowsError(try WatchCaptureMeta(dictionary: ["id": "x"])) { XCTAssertEqual($0 as? WatchCaptureMeta.DecodeError, .notAWatchCapture) }
        XCTAssertThrowsError(try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "v": 2, "id": "x", "at": 1.0])) {
            XCTAssertEqual($0 as? WatchCaptureMeta.DecodeError, .newerVersion(2))
        }
        XCTAssertThrowsError(try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "id": "x"])) {
            XCTAssertEqual($0 as? WatchCaptureMeta.DecodeError, .missing("at"))
        }
    }

    func testOutboxKeepsNotesUntilDeliveredAcrossRestarts() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        func recording(_ name: String) throws -> URL {
            let u = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString).m4a")
            try Data("audio".utf8).write(to: u)
            return u
        }
        let box = WatchOutbox(directory: dir.appendingPathComponent("outbox"))
        let a = try XCTUnwrap(try box.enqueue(recording: try recording("a"), meta: WatchCaptureMeta(id: "a", capturedAt: Date(), duration: 3)))
        let shortFile = try recording("short")
        XCTAssertNil(try box.enqueue(recording: shortFile, meta: WatchCaptureMeta(id: "s", capturedAt: Date(), duration: 0.2)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: shortFile.path))   // accidental tap: discarded
        try box.enqueue(recording: try recording("b"), meta: WatchCaptureMeta(id: "b", capturedAt: Date(), duration: 5))
        XCTAssertTrue(FileManager.default.fileExists(atPath: box.url(of: a).path))

        XCTAssertEqual(box.toSend(inFlight: ["a"]).map(\.meta.id), ["b"])
        box.markStarted("a")
        XCTAssertEqual(box.pending.first?.attempts, 1)

        // Restart: the index and the files are still there.
        let again = WatchOutbox(directory: dir.appendingPathComponent("outbox"))
        XCTAssertEqual(again.pending.map(\.meta.id), ["a", "b"])
        again.markDelivered("a")
        XCTAssertEqual(again.pending.map(\.meta.id), ["b"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: again.url(of: a).path))
        XCTAssertEqual(WatchOutbox(directory: dir.appendingPathComponent("outbox")).pending.map(\.meta.id), ["b"])
    }

    func testTextNotesTravelAsSmallFiles() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = WatchOutbox(directory: dir)
        XCTAssertNil(try box.enqueue(text: "  \n "))
        let item = try XCTUnwrap(try box.enqueue(text: "  Call the roofer \n", id: "t", capturedAt: Date(timeIntervalSince1970: 10)))
        XCTAssertTrue(item.meta.isText)
        XCTAssertEqual(item.meta.duration, 0)
        XCTAssertEqual(item.file, "t.txt")
        XCTAssertEqual(try String(contentsOf: box.url(of: item), encoding: .utf8), "Call the roofer")
        XCTAssertEqual(try WatchCaptureMeta(dictionary: item.meta.dictionary), item.meta)
    }

    func testDayCountStartsAgainOnANewDayAndStatusLine() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let evening = Date(timeIntervalSince1970: 1_795_470_000)   // 23 Nov 2026, 22:40 in Berlin
        var c = WatchDayCount()
        c.add(evening, calendar: cal)
        c.add(evening.addingTimeInterval(600), calendar: cal)
        XCTAssertEqual(c.today(evening, calendar: cal), 2)
        let nextDay = evening.addingTimeInterval(2 * 3600)
        XCTAssertEqual(c.today(nextDay, calendar: cal), 0)
        c.add(nextDay, calendar: cal)
        XCTAssertEqual(c, WatchDayCount(day: "2026-11-24", count: 1))

        XCTAssertEqual(watchStatusLine(today: 0, waiting: 0), "Notes go to Based on your iPhone")
        XCTAssertEqual(watchStatusLine(today: 3, waiting: 0), "3 today")
        XCTAssertEqual(watchStatusLine(today: 3, waiting: 1), "3 today · 1 waiting for iPhone")
    }
}
