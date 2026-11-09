import Foundation
import Testing
@testable import BasedCore

/// BSD-148/149 (ADR 0011): Golden Fixtures für den TypeScript-Stack.
@MainActor
@Suite struct FixtureExportTests {
    @Test func exportIsDeterministic() throws {
        #expect(try FixtureExport.all() == FixtureExport.all())
    }

    /// Jeder Korpus-Record übersteht Swift-Dekodieren/Kodieren unverändert (die Fixtures sind Swift-kanonisch).
    @Test func corpusRoundTripsThroughSwift() throws {
        for record in try RecordFixtures.corpus() {
            let line = try RecordFixtures.line(record)
            let wire = try JSONDecoder().decode([String: JSONValue].self, from: Data(line.utf8))
            let kind = try #require(wire["kind"]?.string.flatMap(RecordKind.init(rawValue:)))
            let data = try JSONEncoder().encode(try #require(wire["data"]))
            #expect(try RecordFixtures.line(Record.decode(kind: kind, data: data)) == line)
        }
    }

    /// Die eingecheckten Dateien unter fixtures/ sind aktuell. Bei Fehlschlag: `swift run based-fixtures`.
    @Test func committedFixturesAreCurrent() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../fixtures").standardizedFileURL
        // Auf einem Mac in Wien fehlen die *.utc.json-Dateien hier (andere Zeitzone); die prüft Linux/CI.
        for (path, text) in try FixtureExport.all() {
            let onDisk = try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
            #expect(onDisk == text, "fixtures/\(path) ist veraltet – swift run based-fixtures")
        }
    }
}
