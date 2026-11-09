import BasedCore
import Foundation

// BSD-148/149 (ADR 0011): schreibt die Golden Fixtures für den TypeScript-Stack.
//   swift run based-fixtures [<ausgabe-ordner>]          (Standard: ../../fixtures)
//   swift run based-fixtures --records-from <based.sqlite> <ausgabe.jsonl>
//       exportiert alle Records einer echten Datenbank als JSONL (eine Zeile pro Record, Swift-Bytes),
//       z. B. für `BASED_RECORDS=<ausgabe.jsonl> pnpm --filter @based/core test`.
// Zeitzonenabhängige Fixtures entstehen immer in UTC, damit jede Maschine dieselben Dateien schreibt.
setenv("TZ", "UTC", 1)
let args = Array(CommandLine.arguments.dropFirst())

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

if args.first == "--records-from" {
    guard args.count == 3 else { fail("usage: based-fixtures --records-from <based.sqlite> <out.jsonl>") }
    let persistence = try SQLitePersistence(url: URL(fileURLWithPath: args[1]))
    let records = try persistence.loadAll().sorted { $0.key < $1.key }
    let lines = try records.map(RecordFixtures.line)
    try (lines.joined(separator: "\n") + "\n").write(toFile: args[2], atomically: true, encoding: .utf8)
    print("\(records.count) Records → \(args[2])")
    exit(0)
}

let here = URL(fileURLWithPath: #filePath)
let defaultOut = here.deletingLastPathComponent().appendingPathComponent("../../../../fixtures").standardizedFileURL
let out = args.first.map { URL(fileURLWithPath: $0) } ?? defaultOut
do {
    guard FixtureExport.isUTC else { fail("based-fixtures: Zeitzone ist nicht UTC (\(TimeZone.current.identifier))") }
    let files = try MainActor.assumeIsolated { try FixtureExport.all() }
    for (path, text) in files.sorted(by: { $0.key < $1.key }) {
        let url = out.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
    print("\(files.count) Fixture-Dateien → \(out.path)")
} catch {
    fail("based-fixtures: \(error)")
}
