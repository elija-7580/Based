import Foundation

/// BSD-149 (ADR 0011): alle Golden-Fixture-Dateien, relativ zu `fixtures/`. Deterministisch.
/// Jedes Modul liefert eine oder mehrere Dateien; der Vitest-Runner in `packages/core` spielt sie ab.
@MainActor
public enum FixtureExport {
    /// Läuft der Prozess in UTC? Nur dann entstehen die zeitzonenabhängigen Dateien (`swift run based-fixtures` setzt TZ=UTC).
    public nonisolated static var isUTC: Bool {
        let tz = TimeZone.current
        return tz.secondsFromGMT(for: Date(timeIntervalSince1970: 0)) == 0 && tz.secondsFromGMT(for: Date(timeIntervalSince1970: 15_552_000)) == 0
    }

    /// Dateien, deren Inhalt von der Zeitzone abhängt (Kalendertage, Datumsgruppen, relative Datumsfilter).
    public static let timeZoneDependent: Set<String> = ["formulas/formulas.utc.json", "queries/queries.utc.json", "queries/values.utc.json", "conversion/conversion.utc.json", "clipboard/export.utc.json",
                                                            "import/notion-html.utc.json", "import/markdown.utc.json", "import/reimport.json", "export/export.utc.json"]

    public static func all(includeTimeZoneDependent: Bool = FixtureExport.isUTC) throws -> [String: String] {
        var files: [String: String] = [:]
        files["records/corpus.jsonl"] = try RecordFixtures.corpus().map(RecordFixtures.line).joined(separator: "\n") + "\n"
        files["records/schema.json"] = try pretty(RecordFixtures.schema())
        files["hlc/hlc.json"] = try pretty(CoreFixtures.hlc())
        files["sortkeys/sortkeys.json"] = try pretty(CoreFixtures.sortKeys())
        files["formulas/formulas.json"] = try pretty(CoreFixtures.formulas(utc: false))
        files["merge/merge.json"] = try pretty(StoreFixtures.merge())
        files["search/search.json"] = try pretty(ExtraFixtures.search())
        files["search/fulltext.json"] = try pretty(SearchFixtures.fulltext())
        files["clipboard/clipboard.json"] = try pretty(ExtraFixtures.clipboard(export: false))
        files["undo-remote/undo-remote.json"] = try pretty(ExtraFixtures.undoRemote())
        files["archive/archive.json"] = try pretty(ImportFixtures.archive())
        if includeTimeZoneDependent {
            files["formulas/formulas.utc.json"] = try pretty(CoreFixtures.formulas(utc: true))
            files["queries/queries.utc.json"] = try pretty(StoreFixtures.queries())
            files["queries/values.utc.json"] = try pretty(StoreFixtures.values())
            files["conversion/conversion.utc.json"] = try pretty(ExtraFixtures.conversion())
            files["clipboard/export.utc.json"] = try pretty(ExtraFixtures.clipboard(export: true))
            // BSD-156: Datumsangaben im Import (Notion-Zeiten, CSV) und im Export hängen von der Zeitzone ab.
            files["import/notion-html.utc.json"] = try pretty(ImportFixtures.notionHTML())
            files["import/markdown.utc.json"] = try pretty(ImportFixtures.markdown())
            files["import/reimport.json"] = try pretty(ImportFixtures.reimport())
            files["export/export.utc.json"] = try pretty(ImportFixtures.export())
        }
        return files
    }

    /// Fixture-JSON: sortierte Schlüssel, eingerückt, `/` unmaskiert, Zeilenende am Schluss.
    static func pretty(_ value: JSONValue) throws -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return String(decoding: try e.encode(value), as: UTF8.self) + "\n"
    }
}
