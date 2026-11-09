import Foundation
import Testing
@testable import BasedCore

/// BSD-66: transfer format and outbox of the Apple Watch app.
struct WatchCaptureTransferTests {
    @Test func metadataRoundTripsAndRejectsForeignOrNewer() throws {
        let m = WatchCaptureMeta(id: "abc", capturedAt: Date(timeIntervalSince1970: 1_800_000_000.5), duration: 4.2)
        let back = try WatchCaptureMeta(dictionary: m.dictionary)
        #expect(back == m)
        // Property-list types only (WCSession refuses anything else).
        #expect(m.dictionary.values.allSatisfy { $0 is String || $0 is Double || $0 is Int })

        // Numbers may arrive as Int/Double either way; a missing extension means m4a.
        let loose = try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "v": 1.0, "id": "x", "at": 1_800_000_000, "dur": 3])
        #expect(loose.capturedAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(loose.duration == 3 && loose.fileExtension == "m4a")

        #expect(throws: WatchCaptureMeta.DecodeError.notAWatchCapture) { try WatchCaptureMeta(dictionary: ["id": "x"]) }
        #expect(throws: WatchCaptureMeta.DecodeError.newerVersion(2)) { try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "v": 2, "id": "x", "at": 1.0]) }
        #expect(throws: WatchCaptureMeta.DecodeError.missing("at")) { try WatchCaptureMeta(dictionary: ["kind": WatchCaptureMeta.kind, "id": "x"]) }
    }

    @Test func outboxKeepsRecordingsUntilDeliveredAcrossRestarts() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        func recording(_ name: String) throws -> URL {
            let u = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString).m4a")
            try Data("audio".utf8).write(to: u)
            return u
        }
        let box = WatchOutbox(directory: dir.appendingPathComponent("outbox"))
        let a = try #require(try box.enqueue(recording: try recording("a"), meta: WatchCaptureMeta(id: "a", capturedAt: Date(), duration: 3)))
        let shortFile = try recording("short")
        #expect(try box.enqueue(recording: shortFile, meta: WatchCaptureMeta(id: "s", capturedAt: Date(), duration: 0.2)) == nil)
        #expect(!FileManager.default.fileExists(atPath: shortFile.path))   // accidental tap: discarded
        try box.enqueue(recording: try recording("b"), meta: WatchCaptureMeta(id: "b", capturedAt: Date(), duration: 5))
        #expect(FileManager.default.fileExists(atPath: box.url(of: a).path))

        #expect(box.toSend(inFlight: ["a"]).map(\.meta.id) == ["b"])
        box.markStarted("b")

        // Restart: the index comes back from disk.
        let again = WatchOutbox(directory: dir.appendingPathComponent("outbox"))
        #expect(again.pending.map(\.meta.id) == ["a", "b"])
        #expect(again.pending.last?.attempts == 1)
        again.markDelivered("a")
        #expect(again.pending.map(\.meta.id) == ["b"])
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("outbox/a.m4a").path))
        #expect(WatchOutbox(directory: dir.appendingPathComponent("outbox")).pending.map(\.meta.id) == ["b"])
    }

    @Test func statusLineAndLedger() {
        let s = WatchStatus(capturedToday: 3, sortTime: "23:00")
        #expect(s.line == "3 today · sorted at 23:00")
        let back = WatchStatus(context: s.context, waiting: 2)
        #expect(back.line == "3 today · 2 waiting for iPhone · sorted at 23:00")
        #expect(WatchStatus(context: [:]).line == "0 today")

        var ledger = WatchInboxLedger()
        ledger.limit = 2
        let first = ledger.accept("a"), again = ledger.accept("a"), b = ledger.accept("b"), c = ledger.accept("c")
        #expect(first && !again && b && c)
        #expect(ledger.seen == ["b", "c"])
    }
}
