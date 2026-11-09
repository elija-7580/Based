import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-11: Share extension → Captures, and the widgets' snapshot.
@MainActor
struct ShareInboxTests {
    private func dir() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)") }

    @Test func sharedItemsBecomeCapturesOldestFirstAndFilesGo() throws {
        let d = dir()
        defer { try? FileManager.default.removeItem(at: d) }
        let brain = BrainStore(store: WorkspaceStore(persistence: MemoryPersistence(), node: "t"))
        let inbox = ShareInbox(directory: d)
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        try inbox.drop(SharedItem(id: "b", text: "", link: "https://example.com/article", pageTitle: "A good article", sharedAt: t0.addingTimeInterval(60)))
        try inbox.drop(SharedItem(id: "a", text: "Read later", sharedAt: t0))
        try Data("not json".utf8).write(to: d.appendingPathComponent("broken.json"))
        var future = SharedItem(id: "f", text: "from a newer app")
        future.version = 99
        try inbox.drop(future)

        let r = inbox.drain(into: brain)
        #expect(r.filed.count == 2 && r.rejected == 1)
        let first = try #require(brain.capture(r.filed[0]))
        let second = try #require(brain.capture(r.filed[1]))
        #expect(first.text.contains("Read later"))
        #expect(second.text.contains("A good article"))
        #expect(second.link == "https://example.com/article")
        #expect(second.source == .share)
        #expect(second.capturedAt == t0.addingTimeInterval(60))

        let left = try FileManager.default.contentsOfDirectory(atPath: d.path).sorted()
        #expect(left == ["broken.bad", "f.json"])           // bad file parked, newer format kept for later
        #expect(inbox.drain(into: brain).filed.isEmpty)       // nothing twice
    }

    @Test func widgetSnapshotCountsAndRoundTrips() throws {
        let brain = BrainStore(store: WorkspaceStore(persistence: MemoryPersistence(), node: "t"))
        _ = try brain.addCapture(CaptureInput(text: "today"))
        let s = WidgetSnapshot.make(brain: brain)
        #expect(s.capturesToday == 1)
        #expect(s.running == 0 && s.needsYou == 0)
        let back = WidgetSnapshot.decode(try s.encoded())
        #expect(back == s)
        #expect(WidgetSnapshot.decode(Data("{}".utf8)) == .empty)
        #expect(WidgetSnapshot.decode(nil) == .empty)
        var later = s
        later.updatedAt = s.updatedAt.addingTimeInterval(30)
        #expect(later.sameContent(as: s))
        later.capturesToday = 2
        #expect(!later.sameContent(as: s))
    }
}
