import Foundation
import Testing
@testable import BasedBrain
@testable import BasedCore

/// BSD-217: Golden Fixtures für den Notion-API-Import (ADR 0011). Eingabe = Routen-Tabelle der Fake-API
/// (wie NotionAPIImportTests), Ausgabe = Bericht + Records (ohne Stempel, sortiert). Der TS-Port spielt sie ab.
/// Schreiben: `BASED_WRITE_FIXTURES=1 swift test --filter NotionAPIFixtureExport`; sonst Vergleich mit der Datei.
@MainActor
@Suite struct NotionAPIFixtureExport {
    let t = NotionAPIImportTests()
    static let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../../fixtures/import/notion-api.utc.json").standardized

    func routesJSON(_ f: FakeNotion) -> JSONValue {
        ["routes": .object(f.routes), "failFirst": .object(f.failFirst.mapValues { .number(Double($0)) }),
         "files": .object(f.files.mapValues { .string($0.base64EncodedString()) })]
    }

    func errorCode(_ e: Error) -> String {
        guard let n = e as? NotionAPIError else { return "other" }
        switch n {
        case .unauthorized: return "unauthorized"
        case .notFound: return "notFound"
        case .restricted: return "restricted"
        case .http(let c, _): return "http \(c)"
        case .cancelled: return "cancelled"
        }
    }

    func run(_ f: FakeNotion, targets: [String], store: WorkspaceStore) async -> JSONValue {
        let importer = NotionWorkspaceImport(client: NotionClient(token: "secret_x", transport: f, requestsPerSecond: 0), options: NotionImportOptions())
        do {
            let r = try await importer.run(targets.compactMap { NotionTarget($0) }, into: store, assets: ImportFixtures.FixtureAssets())
            return ImportFixtures.reportJSON(r)
        } catch {
            return ["error": .string(errorCode(error))]
        }
    }

    func importCase(_ name: String, _ f: FakeNotion, targets: [String]) async -> JSONValue {
        let start = Date()
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
        let api = routesJSON(f)   // vor dem Lauf: failFirst zählt beim Lauf herunter
        let report = await run(f, targets: targets, store: store)
        return CoreFixtures.testCase(name, ["targets": .array(targets.map(JSONValue.string)), "api": api],
                                     ["report": report, "records": ImportFixtures.dump(store, since: start)])
    }

    func patch(_ v: JSONValue?, _ change: (inout [String: JSONValue]) -> Void) -> JSONValue {
        guard case .object(var o)? = v else { return v ?? .null }
        change(&o)
        return .object(o)
    }

    func build() async -> JSONValue {
        let hubLink = "https://www.notion.so/Project-Hub-\(t.hub.replacingOccurrences(of: "-", with: ""))?pvs=4"
        var cases: [JSONValue] = []
        cases.append(await importCase("Voller Import (Seiten, Blöcke, Datenbanken, Views, Dateien, 429)", t.makeFake(), targets: [hubLink]))

        // Dashboard (NotionAPIImportTests.dashboardImport)
        do {
            let f = t.makeFake()
            let dash = "99999999-9999-4999-8999-000000000003", w1 = "99999999-9999-4999-8999-000000000004"
            let w2 = "99999999-9999-4999-8999-000000000005", w3 = "99999999-9999-4999-8999-000000000006"
            f.routes["GET views?database_id=\(t.tasksDB)"] = t.list([["object": "view", "id": .string(t.viewAll)], ["object": "view", "id": .string(t.viewBoard)],
                                                                   ["object": "view", "id": .string(dash)], ["object": "view", "id": .string(w1)]])
            f.routes["GET views/\(dash)"] = ["object": "view", "id": .string(dash), "name": "Overview", "type": "dashboard", "data_source_id": .null,
                "parent": ["type": "database_id", "database_id": .string(t.tasksDB)],
                "configuration": ["type": "dashboard", "rows": [
                    ["id": "r1", "height": 320, "widgets": [["id": "x1", "view_id": .string(w1), "width": 4, "row_index": 0],
                                                            ["id": "x2", "view_id": .string(w2), "width": 8, "row_index": 0]]],
                    ["id": "r2", "widgets": [["id": "x3", "view_id": .string(w3), "row_index": 1]]]]]]
            f.routes["GET views/\(w1)"] = ["object": "view", "id": .string(w1), "name": "Total", "type": "chart", "data_source_id": .string(t.tasksDS),
                "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(t.tasksDB)],
                "configuration": ["type": "chart", "chart_type": "number", "caption": "All tasks", "color_theme": "green", "height": "small"]]
            f.routes["GET views/\(w2)"] = ["object": "view", "id": .string(w2), "name": "Projects", "type": "table", "data_source_id": .string(t.projDS),
                "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(t.projDB)]]
            f.routes["GET views/\(w3)"] = ["object": "view", "id": .string(w3), "name": "By status", "type": "chart", "data_source_id": .string(t.tasksDS),
                "dashboard_view_id": .string(dash), "parent": ["type": "database_id", "database_id": .string(t.tasksDB)],
                "configuration": ["type": "chart", "chart_type": "column", "x_axis": ["type": "status", "property_id": "st%3A1", "group_by": "option"]]]
            cases.append(await importCase("Dashboard mit Widgets", f, targets: [t.hub]))
        }

        // Karte und Orte (NotionAPIImportTests.mapViewAndPlaceImport)
        do {
            let f = t.makeFake()
            let mapView = "99999999-9999-4999-8999-000000000007"
            f.routes["GET data_sources/\(t.tasksDS)"] = patch(f.routes["GET data_sources/\(t.tasksDS)"]) { ds in
                ds["properties"] = patch(ds["properties"]) { $0["Where"] = ["id": "pl", "name": "Where", "type": "place", "place": [:]] }
            }
            let row1 = t.row1
            f.routes["POST data_sources/\(t.tasksDS)/query"] = patch(f.routes["POST data_sources/\(t.tasksDS)/query"]) { q in
                q["results"] = .array((q["results"]?.array ?? []).map { row in
                    patch(row) { r in
                        let isFirst = r["id"]?.string == row1
                        r["properties"] = patch(r["properties"]) {
                            $0["Where"] = ["id": "pl", "type": "place", "place": isFirst
                                ? ["name": "Office", "address": "Main St 1, Berlin", "lat": 52.52, "lon": 13.405, "google_place_id": "g-1"] : .null]
                        }
                    }
                })
            }
            f.routes["GET views?database_id=\(t.tasksDB)"] = t.list([["object": "view", "id": .string(t.viewAll)], ["object": "view", "id": .string(t.viewBoard)],
                                                                   ["object": "view", "id": .string(mapView)]])
            f.routes["GET views/\(mapView)"] = ["object": "view", "id": .string(mapView), "name": "Map", "type": "map", "data_source_id": .string(t.tasksDS),
                "parent": ["type": "database_id", "database_id": .string(t.tasksDB)],
                "configuration": ["type": "map", "map_by": "pl", "height": "large"]]
            cases.append(await importCase("Kartenansicht und Orte", f, targets: [t.hub]))
        }

        // Alles Freigegebene (Suche)
        do {
            let f = t.makeFake()
            f.routes["POST search"] = t.list([
                f.routes["GET pages/\(t.hub)"]!,
                ["object": "data_source", "id": .string(t.tasksDS), "parent": ["type": "database_id", "database_id": .string(t.tasksDB)],
                 "database_parent": ["type": "page_id", "page_id": .string(t.hub)]],
            ])
            cases.append(await importCase("Alles Freigegebene (Suche)", f, targets: []))
        }

        // Ungültiges Token
        do {
            final class Deny: NotionTransport, @unchecked Sendable {
                func send(method: String, url: URL, headers: [String: String], body: Data?) async throws -> (status: Int, headers: [String: String], data: Data) {
                    (401, [:], Data(#"{"code":"unauthorized","message":"API token is invalid."}"#.utf8))
                }
            }
            let start = Date()
            let store = WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
            var report: JSONValue
            do {
                let r = try await NotionWorkspaceImport(client: NotionClient(token: "bad", transport: Deny(), requestsPerSecond: 0), options: NotionImportOptions())
                    .run([NotionTarget(t.hub)!], into: store, assets: nil)
                report = ImportFixtures.reportJSON(r)
            } catch { report = ["error": .string(errorCode(error))] }
            cases.append(CoreFixtures.testCase("Ungültiges Token", ["targets": [.string(t.hub)], "api": ["status": 401]],
                                               ["report": report, "records": ImportFixtures.dump(store, since: start)]))
        }

        // Reimport (BSD-32): lokale Änderung und lokaler Block bleiben, in Notion gelöschter Block geht.
        do {
            let start = Date()
            let store = WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
            let first = t.makeFake()
            let api1 = routesJSON(first)
            let r1 = await run(first, targets: [t.hub], store: store)
            store.transact("edit") { tx in tx.update(t.b(1)) { $0.text = RichText("Edited in Based") } }
            store.transact("add") { tx in tx.put(Block(id: "local-1", type: .text, parent: .block(t.hub), sortKey: "zz", text: "Added in Based")) }
            let second = t.makeFake()
            var kids = second.routes["GET blocks/\(t.hub)/children"]!["results"]!.array!
            kids.removeAll { $0["id"]?.string == t.b(3) }
            second.routes["GET blocks/\(t.hub)/children"] = t.list(kids)
            let api2 = routesJSON(second)
            let r2 = await run(second, targets: [t.hub], store: store)
            cases.append(CoreFixtures.testCase("Reimport aktualisiert an Ort und Stelle (BSD-32)",
                ["targets": [.string(t.hub)], "api": api1, "edits": ["b1 → Edited in Based", "local-1 (text, parent hub, sk zz) Added in Based"],
                 "api2": api2],
                ["reports": [r1, r2], "records": ImportFixtures.dump(store, since: start)]))
        }
        return ["module": "notion-api", "cases": .array(cases)]
    }

    @Test func notionAPIFixturesAreCurrent() async throws {
        let text = try ImportFixtures.prettyForExport(await build())
        if ProcessInfo.processInfo.environment["BASED_WRITE_FIXTURES"] != nil {
            try text.write(to: Self.file, atomically: true, encoding: .utf8)
            return
        }
        guard let committed = try? String(contentsOf: Self.file, encoding: .utf8) else { return }
        #expect(committed == text, "fixtures/import/notion-api.utc.json is stale – regenerate with BASED_WRITE_FIXTURES=1")
    }
}

extension ImportFixtures {
    static func prettyForExport(_ value: JSONValue) throws -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return String(decoding: try e.encode(value), as: UTF8.self) + "\n"
    }
}
