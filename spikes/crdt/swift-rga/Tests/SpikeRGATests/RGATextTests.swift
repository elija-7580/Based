import Foundation
import Testing
@testable import SpikeRGA

private let base = "Der schnelle braune Fuchs springt über den faulen Hund."

private func pair() -> (RGAText, RGAText) {
    var a = RGAText(replica: 1); a.insert(base, at: 0)
    var b = RGAText(replica: 2); b.merge(a)
    return (a, b)
}

@Test func concurrentTypingConverges() {
    var (a, b) = pair()
    a.insert("schnelle ", at: 4)
    b.insert(" Wirklich.", at: base.count)
    b.mark("bold", "true", from: 0, to: 3)
    let a0 = a
    a.merge(b); b.merge(a0)
    #expect(a.string == b.string)
    #expect(a.spans == b.spans)
    #expect(a.string == "Der schnelle schnelle braune Fuchs springt über den faulen Hund. Wirklich.")
    #expect(a.spans.first == Span(text: "Der", marks: ["bold": "true"]))
}

@Test func sameSpotTypingDoesNotInterleaveForwardRuns() {
    var a = RGAText(replica: 1); a.insert("Hallo Welt", at: 0)
    var b = RGAText(replica: 2); b.merge(a)
    a.insert("abc", at: 5); b.insert("xyz", at: 5)
    let a0 = a; a.merge(b); b.merge(a0)
    #expect(a.string == b.string)
    #expect(a.string == "Halloxyzabc Welt" || a.string == "Halloabcxyz Welt")
}

@Test func deleteVersusInsertAndMarkExpandsInside() {
    var (a, b) = pair()
    a.delete(at: 4, count: 9)                 // „schnelle “ weg
    b.mark("link", "https://example.com", from: 0, to: 12)
    b.insert("!", at: 6)                      // innerhalb des Link-Bereichs
    let a0 = a; a.merge(b); b.merge(a0)
    #expect(a.string == b.string)
    #expect(a.spans == b.spans)
    #expect(a.string.hasPrefix("Der !braune"))
}

@Test func outOfOrderDeliveryIsBuffered() {
    var a = RGAText(replica: 1); a.insert("abc", at: 0); a.mark("bold", "true", from: 0, to: 3)
    var c = RGAText(replica: 3)
    c.apply(a.log.reversed())                 // Ops in umgekehrter Reihenfolge
    #expect(c.string == "abc")
    #expect(c.spans == a.spans)
}

@Test func opsRoundTripAsJSON() throws {
    var a = RGAText(replica: 1); a.insert("ä😀b", at: 0); a.mark("bold", "true", from: 0, to: 2); a.delete(at: 2, count: 1)
    let data = try JSONEncoder().encode(a.log)
    var b = RGAText(replica: 2); b.apply(try JSONDecoder().decode([TextOp].self, from: data))
    #expect(b.string == "ä😀")
    #expect(b.spans == a.spans)
}

/// Messung wie im JS-Benchmark: je 500 Tipp-Ops pro Replikat, dann beidseitiger Merge (1000 Ops).
@Test func benchmarkThousandOps() throws {
    var (a, b) = pair()
    let clock = ContinuousClock()
    let edit = clock.measure {
        for i in 0 ..< 500 { a.insert(String(UnicodeScalar(97 + (i * 7 + 1) % 26)!), at: 10 + i) }
        for i in 0 ..< 500 { b.insert(String(UnicodeScalar(97 + (i * 7 + 3) % 26)!), at: base.count + i) }
        b.mark("bold", "true", from: 0, to: 9)
        b.mark("link", "https://example.com", from: 20, to: 30)
    }
    let a0 = a
    let merge = clock.measure { a.merge(b); b.merge(a0) }
    #expect(a.string == b.string && a.spans == b.spans)
    let bytes = try JSONEncoder().encode(a.log).count
    print("RGA-Spike: edit \(edit), merge \(merge), Zeichen \(a.string.count), Elemente \(a.storedElements), Op-Log JSON \(bytes) B")
}

/// Zufallstest: drei Replikate, zufällige Einfüge-/Lösch-/Mark-Ops, Merge in verschiedener Reihenfolge.
@Test(arguments: 0 ..< 20) func randomizedThreeReplicasConverge(seed: Int) {
    var rng = SplitMix(seed: UInt64(seed + 1))
    var reps = (1 ... 3).map { RGAText(replica: UInt32($0)) }
    for _ in 0 ..< 6 {
        for r in reps.indices {
            for _ in 0 ..< 8 {
                let n = reps[r].string.count
                switch rng.next() % 4 {
                case 0 where n > 0: reps[r].delete(at: Int(rng.next() % UInt64(n)), count: 1)
                case 1 where n > 1:
                    let a = Int(rng.next() % UInt64(n - 1)); let b = a + 1 + Int(rng.next() % UInt64(n - a - 1 + 1)) - 1
                    reps[r].mark("bold", rng.next() % 2 == 0 ? "true" : nil, from: a, to: max(b, a + 1))
                default: reps[r].insert(String(UnicodeScalar(97 + Int(rng.next() % 26))!), at: Int(rng.next() % UInt64(n + 1)))
                }
            }
        }
        // Teilweiser Austausch: 1 bekommt 2, 3 bekommt 1
        reps[0].merge(reps[1]); reps[2].merge(reps[0])
    }
    let snapshot = reps
    for i in reps.indices { for j in snapshot.indices { reps[i].merge(snapshot[j]) } }
    #expect(reps[0].string == reps[1].string && reps[1].string == reps[2].string)
    #expect(reps[0].spans == reps[1].spans && reps[1].spans == reps[2].spans)
}

struct SplitMix { var s: UInt64; init(seed: UInt64) { s = seed }
    mutating func next() -> UInt64 { s &+= 0x9E3779B97F4A7C15; var z = s
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) &* 0x94D049BB133111EB; return z ^ (z >> 31) } }
