import XCTest
@testable import BasedCore

@MainActor
final class VoiceProfileTests: XCTestCase {
    /// A "voice": a base direction plus a little per-recording noise.
    func voice(_ seed: Int, noise: Float = 0.15, variant: Int = 0) -> [Float] {
        var g = SplitMix(seed: UInt64(seed))
        let base = (0..<64).map { _ in Float(g.unit() * 2 - 1) }
        var n = SplitMix(seed: UInt64(seed * 1000 + variant + 1))
        return base.map { $0 + noise * Float(n.unit() * 2 - 1) }
    }

    func testCentroidsAreWeightedUnitVectors() {
        let a = voice(1), b = voice(2)
        let cs = VoicePrint.centroids([
            VoiceSample(speaker: "S1", embedding: a, weight: 10),
            VoiceSample(speaker: "S1", embedding: voice(1, variant: 1), weight: 5),
            VoiceSample(speaker: "S2", embedding: b, weight: 3),
            VoiceSample(speaker: "S3", embedding: [0, 0, 0], weight: 3),     // degenerate: ignored
            VoiceSample(speaker: "S4", embedding: a, weight: 0),             // no speech: ignored
        ])
        XCTAssertEqual(Set(cs.keys), ["S1", "S2"])
        XCTAssertEqual(cs["S1"]?.weight, 15)
        let norm = cs["S1"]!.embedding.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        XCTAssertEqual(norm, 1, accuracy: 1e-4)
        XCTAssertGreaterThan(VoicePrint.cosine(cs["S1"]!.embedding, a), 0.95)
    }

    func testMatchingIsOneToOneAndRespectsThreshold() {
        let anna = VoiceProfile(name: "Anna", embedding: voice(1), weight: 60)
        let ben = VoiceProfile(name: "Ben", embedding: voice(2), weight: 60)
        let clusters = ["S1": voice(2, variant: 3), "S2": voice(1, variant: 4), "S3": voice(3), "S4": voice(1, variant: 5)]
        let m = VoicePrint.match(clusters, profiles: [anna, ben])
        XCTAssertEqual(m["S1"]?.name, "Ben")
        XCTAssertEqual(m["S3"], nil, "a stranger stays unnamed")
        // Anna is assigned to exactly one of the two clusters that sound like her.
        XCTAssertEqual([m["S2"], m["S4"]].compactMap { $0?.name }, ["Anna"])
        XCTAssertLessThan(VoicePrint.cosine(voice(1), voice(3)), VoicePrint.defaultThreshold)
    }

    func testLearnRecogniseForgetAndPersist() {
        let db = MemoryPersistence()
        let store = VoiceProfileStore(persistence: db)
        // Meeting 1: nobody known yet; the user names Speaker S1 "Anna".
        XCTAssertTrue(store.recognise(meeting: "m1", samples: [VoiceSample(speaker: "S1", embedding: voice(1), weight: 40),
                                                               VoiceSample(speaker: "S2", embedding: voice(2), weight: 30)]).isEmpty)
        let anna = store.learn(meeting: "m1", speaker: "S1", name: " Anna ")
        XCTAssertEqual(anna?.name, "Anna")
        XCTAssertNil(store.learn(meeting: "m1", speaker: "S9", name: "Nobody"), "unknown cluster teaches nothing")

        // Meeting 2 (another session, reloaded from disk): Anna is recognised, the other voice isn't.
        let again = VoiceProfileStore(persistence: db)
        let found = again.recognise(meeting: "m2", samples: [VoiceSample(speaker: "X", embedding: voice(1, variant: 7), weight: 20),
                                                             VoiceSample(speaker: "Y", embedding: voice(4), weight: 20)])
        XCTAssertEqual(found["X"]?.id, anna?.id)
        XCTAssertNil(found["Y"])

        // Naming the matched speaker "Anna" again teaches the same profile; naming it someone else must not.
        let taught = again.learn(meeting: "m2", speaker: "X", name: "anna")
        XCTAssertEqual(taught?.id, anna?.id)
        XCTAssertEqual(taught?.weight, 60)
        let other = again.learn(meeting: "m2", speaker: "X", name: "Clara")
        XCTAssertNotEqual(other?.id, anna?.id)
        XCTAssertEqual(again.profiles.first { $0.id == anna?.id }?.weight, 60, "Anna untouched by the correction")

        again.forget(other!.id)
        XCTAssertEqual(again.profiles.map(\.name), ["Anna"])
        again.forgetAll()
        XCTAssertTrue(VoiceProfileStore(persistence: db).profiles.isEmpty)
        XCTAssertNil(db.meta("meeting.voices.v1"), "nothing left on disk")
    }

    func testOldMeetingsAreDropped() {
        let store = VoiceProfileStore(persistence: MemoryPersistence())
        for i in 0..<60 { store.recognise(meeting: "m\(i)", samples: [VoiceSample(speaker: "S", embedding: voice(i), weight: 1)]) }
        XCTAssertEqual(store.book.order.count, 50)
        XCTAssertEqual(store.book.clusters.count, 50)
        XCTAssertNil(store.book.clusters["m0"])
        XCTAssertNotNil(store.book.clusters["m59"])
    }
}

/// Deterministic generator for test vectors.
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}
