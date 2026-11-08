import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct VoiceProfileTests {
    /// A "voice": a base direction plus a little per-recording noise.
    func voice(_ seed: Int, noise: Float = 0.15, variant: Int = 0) -> [Float] {
        var g = SplitMix(seed: UInt64(seed))
        let base = (0..<64).map { _ in Float(g.unit() * 2 - 1) }
        var n = SplitMix(seed: UInt64(seed * 1000 + variant + 1))
        return base.map { $0 + noise * Float(n.unit() * 2 - 1) }
    }

    @Test func centroidsAreWeightedUnitVectors() {
        let a = voice(1), b = voice(2)
        let cs = VoicePrint.centroids([
            VoiceSample(speaker: "S1", embedding: a, weight: 10),
            VoiceSample(speaker: "S1", embedding: voice(1, variant: 1), weight: 5),
            VoiceSample(speaker: "S2", embedding: b, weight: 3),
            VoiceSample(speaker: "S3", embedding: [0, 0, 0], weight: 3),     // degenerate: ignored
            VoiceSample(speaker: "S4", embedding: a, weight: 0),             // no speech: ignored
        ])
        #expect(Set(cs.keys) == ["S1", "S2"])
        #expect(cs["S1"]?.weight == 15)
        let norm = cs["S1"]!.embedding.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        #expect(abs(norm - 1) <= 1e-4)
        #expect(VoicePrint.cosine(cs["S1"]!.embedding, a) > 0.95)
    }

    @Test func matchingIsOneToOneAndRespectsThreshold() {
        let anna = VoiceProfile(name: "Anna", embedding: voice(1), weight: 60)
        let ben = VoiceProfile(name: "Ben", embedding: voice(2), weight: 60)
        let clusters = ["S1": voice(2, variant: 3), "S2": voice(1, variant: 4), "S3": voice(3), "S4": voice(1, variant: 5)]
        let m = VoicePrint.match(clusters, profiles: [anna, ben])
        #expect(m["S1"]?.name == "Ben")
        #expect(m["S3"] == nil, "a stranger stays unnamed")
        // Anna is assigned to exactly one of the two clusters that sound like her.
        #expect([m["S2"], m["S4"]].compactMap { $0?.name } == ["Anna"])
        #expect(VoicePrint.cosine(voice(1), voice(3)) < VoicePrint.defaultThreshold)
    }

    @Test func learnRecogniseForgetAndPersist() {
        let db = MemoryPersistence()
        let store = VoiceProfileStore(persistence: db)
        // Meeting 1: nobody known yet; the user names Speaker S1 "Anna".
        #expect(store.recognise(meeting: "m1", samples: [VoiceSample(speaker: "S1", embedding: voice(1), weight: 40),
                                                               VoiceSample(speaker: "S2", embedding: voice(2), weight: 30)]).isEmpty)
        let anna = store.learn(meeting: "m1", speaker: "S1", name: " Anna ")
        #expect(anna?.name == "Anna")
        #expect(store.learn(meeting: "m1", speaker: "S9", name: "Nobody") == nil, "unknown cluster teaches nothing")

        // Meeting 2 (another session, reloaded from disk): Anna is recognised, the other voice isn't.
        let again = VoiceProfileStore(persistence: db)
        let found = again.recognise(meeting: "m2", samples: [VoiceSample(speaker: "X", embedding: voice(1, variant: 7), weight: 20),
                                                             VoiceSample(speaker: "Y", embedding: voice(4), weight: 20)])
        #expect(found["X"]?.id == anna?.id)
        #expect(found["Y"] == nil)

        // Naming the matched speaker "Anna" again teaches the same profile; naming it someone else must not.
        let taught = again.learn(meeting: "m2", speaker: "X", name: "anna")
        #expect(taught?.id == anna?.id)
        #expect(taught?.weight == 60)
        let other = again.learn(meeting: "m2", speaker: "X", name: "Clara")
        #expect(other?.id != anna?.id)
        #expect(again.profiles.first { $0.id == anna?.id }?.weight == 60, "Anna untouched by the correction")

        again.forget(other!.id)
        #expect(again.profiles.map(\.name) == ["Anna"])
        again.forgetAll()
        #expect(VoiceProfileStore(persistence: db).profiles.isEmpty)
        #expect(db.meta("meeting.voices.v1") == nil, "nothing left on disk")
    }

    @Test func oldMeetingsAreDropped() {
        let store = VoiceProfileStore(persistence: MemoryPersistence())
        for i in 0..<60 { store.recognise(meeting: "m\(i)", samples: [VoiceSample(speaker: "S", embedding: voice(i), weight: 1)]) }
        #expect(store.book.order.count == 50)
        #expect(store.book.clusters.count == 50)
        #expect(store.book.clusters["m0"] == nil)
        #expect(store.book.clusters["m59"] != nil)
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
