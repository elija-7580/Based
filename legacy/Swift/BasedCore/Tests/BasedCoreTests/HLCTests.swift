import Foundation
import Testing
@testable import BasedCore

/// BSD-72: the hybrid logical clock stays sane with a wrong remote clock and a saturated counter.
@Suite struct HLCTests {
    @Test func stampsFromTheFarFutureDontMoveTheClock() {
        let c = StampClock(node: "a")
        let wall: Int64 = 1_800_000_000_000
        c.wallClock = { wall }
        #expect(c.observe(Stamp(millis: wall + StampClock.maxDrift + 1, counter: 0, node: "b")) == false)
        #expect(c.now().millis == wall)
        // Within the drift window the clock follows (classic HLC).
        #expect(c.observe(Stamp(millis: wall + 60_000, counter: 3, node: "b")))
        let s = c.now()
        #expect(s.millis == wall + 60_000 && s.counter == 4 && s.node == "a")
    }

    @Test func counterOverflowMovesToTheNextMillisecond() {
        let wall: Int64 = 1_800_000_000_000
        let c = StampClock(node: "a", last: Stamp(millis: wall, counter: .max - 1, node: "a"))
        c.wallClock = { wall }
        let a = c.now(), b = c.now(), d = c.now()
        #expect(a.counter == .max)
        #expect(b.millis == wall + 1 && b.counter == 0)
        #expect(a < b && b < d)
    }

    @Test @MainActor func farFutureRecordsAreStillApplied() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "local")
        let page = s.createPage(title: "x")
        var b = s.blocks[page]!
        b.text = RichText("from the future")
        b.stamp = Stamp(millis: Int64(Date().timeIntervalSince1970 * 1000) + 10 * StampClock.maxDrift, counter: 0, node: "remote")
        s.applyRemote([.block(b)])
        #expect(s.blocks[page]?.text.plainText == "from the future")
        #expect(s.clock.current.millis < b.stamp.millis)
    }
}
