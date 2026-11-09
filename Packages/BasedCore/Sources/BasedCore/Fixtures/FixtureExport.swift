import Foundation

/// BSD-149 (ADR 0011): alle Golden-Fixture-Dateien, relativ zu `fixtures/`. Deterministisch.
/// Jedes Modul liefert eine oder mehrere Dateien; der Vitest-Runner in `packages/core` spielt sie ab.
public enum FixtureExport {
    public static func all() throws -> [String: String] {
        var files: [String: String] = [:]
        files["records/corpus.jsonl"] = try RecordFixtures.corpus().map(RecordFixtures.line).joined(separator: "\n") + "\n"
        files["records/schema.json"] = try pretty(RecordFixtures.schema())
        return files
    }

    /// Fixture-JSON: sortierte Schlüssel, eingerückt, `/` unmaskiert, Zeilenende am Schluss.
    static func pretty(_ value: JSONValue) throws -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return String(decoding: try e.encode(value), as: UTF8.self) + "\n"
    }
}
