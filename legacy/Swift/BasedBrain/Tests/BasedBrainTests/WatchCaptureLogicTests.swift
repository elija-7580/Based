import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-66: the iPhone side of the watch app — status line and receiving voice notes.
@MainActor
struct WatchCaptureLogicTests {
    @Test func statusCountsTodayAndReadsTheSortTime() throws {
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let brain = BrainStore(store: store)
        let now = Date()
        _ = try brain.addCapture(CaptureInput(text: "today 1", capturedAt: now))
        _ = try brain.addCapture(CaptureInput(text: "today 2", source: .watch, capturedAt: now))
        _ = try brain.addCapture(CaptureInput(text: "old", capturedAt: now.addingTimeInterval(-3 * 86_400)))
        let s = WatchCaptureLogic.status(brain: brain, now: now)
        #expect(s.capturedToday == 2)
        #expect(s.sortTime == "23:00")   // the "Sort captures" agent is created with the Captures database
        #expect(s.line == "2 today · sorted at 23:00")
    }

    @Test func receivingTheSameTransferTwiceMakesOneCapture() throws {
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let brain = BrainStore(store: store)
        var ledger = WatchInboxLedger()
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let meta = WatchCaptureMeta(id: "w1", capturedAt: at, duration: 4)
        let audio = AssetRef(id: "a1", name: "watch.m4a", mime: "audio/mp4")
        guard case .saved(let id, _)? = WatchCaptureLogic.receive(meta: meta, audio: audio, brain: brain, ledger: &ledger) else {
            Issue.record("not saved"); return
        }
        let c = try #require(brain.capture(id))
        #expect(c.source == .watch)
        #expect(c.capturedAt == at)
        #expect(c.needsTranscript)
        #expect(WatchCaptureLogic.receive(meta: meta, audio: audio, brain: brain, ledger: &ledger) == nil)
        #expect(brain.captures().count == 1)
    }
}
