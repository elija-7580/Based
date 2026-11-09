import Foundation

/// BSD-157 (ADR 0011): Volltext-Fälle der Quick-Find-Suche aus `SearchCorpusTests` (Erwähnungen mit aktuellem
/// Titel, Toggle-Inhalt, Tabellenzellen, Bildunterschrift, Transkript, Papierkorb, Vorlagen, Zeilenwerte) für jede
/// Kombination aus Filter und Sortierung – plus inkrementelle Schritte: Records werden wie vom Sync eingespielt
/// (`applyRemote`), danach wird der Index neu gebaut. Der TS-Port aktualisiert seinen Index stattdessen über
/// `store.observe` und muss dieselben Treffer liefern.
@MainActor
public enum SearchFixtures {
    typealias C = CoreFixtures
    typealias S = StoreFixtures
    typealias E = ExtraFixtures

    static let t0 = C.now.addingTimeInterval(-10 * 86_400)

    static func block(_ id: String, _ type: BlockType, _ text: RichText, parent: ParentRef, sk: String, day: Double = 0,
                      props: BlockProps = BlockProps(), values: [String: PropertyValue] = [:], by: String = "user-1",
                      trashed: Bool = false, millis: Int64 = 10) -> Block {
        var b = Block(id: id, type: type, parent: parent, sortKey: sk, text: text, props: props, values: values,
                      createdAt: t0.addingTimeInterval(day * 3_600), createdBy: by)
        b.updatedAt = t0.addingTimeInterval(day * 86_400)
        b.stamp = Stamp(millis: millis, counter: 0, node: "fx")
        if trashed { b.trashedAt = t0 }
        return b
    }

    /// Der Datenstand aus `SearchCorpusTests.fixture()` mit festen IDs, ergänzt um Bildunterschrift, Transkript,
    /// Ort/E-Mail/Telefon in Zeilen, eine ganzseitige Datenbank und einen Block im Papierkorb.
    static func workspace() -> [Record] {
        var out: [Record] = []
        var ws = Workspace(); ws.createdAt = t0; ws.updatedAt = t0; ws.stamp = Stamp(millis: 1, counter: 0, node: "fx")
        out.append(.workspace(ws))
        func add(_ b: Block) { out.append(.block(b)) }
        add(block("roadmap", .page, "Roadmap Café", parent: .workspace, sk: "a0", day: 1))
        add(block("notes", .page, "Notes", parent: .workspace, sk: "a1", day: 9))
        add(block("n-mention", .text, RichText(runs: [TextRun("See "), TextRun("Roadmap", mention: .page("roadmap")), TextRun(" for the plan")]),
                  parent: .block("notes"), sk: "a0"))
        add(block("n-plan", .text, "Another PLAN line in notes", parent: .block("notes"), sk: "a1"))
        add(block("n-toggle", .toggle, "Details", parent: .block("notes"), sk: "a2"))
        add(block("n-resume", .text, "Résumé deep inside the toggle", parent: .block("n-toggle"), sk: "a0"))
        var table = BlockProps(); table.cells = [RichText("Budget"), RichText("Zürich")]
        add(block("n-cells", .text, "", parent: .block("notes"), sk: "a3", props: table))
        var img = BlockProps(); img.url = "https://example.com/d.png"; img.caption = RichText("Plan diagram")
        add(block("n-image", .image, "", parent: .block("notes"), sk: "a4", props: img))
        var tr = BlockProps()
        tr.segments = [TranscriptSegment(id: "s1", start: 0, end: 2, text: "we discussed the budget"),
                       TranscriptSegment(id: "s2", start: 2, end: 3, text: "pending zebra words", partial: true)]
        add(block("n-transcript", .transcript, "", parent: .block("notes"), sk: "a5", props: tr))
        add(block("n-gone", .text, "plan in a deleted block", parent: .block("notes"), sk: "a6", trashed: true))
        add(block("child", .page, "Plan child", parent: .block("notes"), sk: "a7", day: 5))
        add(block("child-a", .text, "child content about the café", parent: .block("child"), sk: "a0"))
        add(block("old", .page, "Old plan", parent: .workspace, sk: "a2", day: 2, trashed: true))
        add(block("old-a", .text, "plan in the trash", parent: .block("old"), sk: "a0"))
        var tpl = BlockProps(); tpl.isTemplate = true
        add(block("template", .page, "Plan template", parent: .workspace, sk: "a3", day: 3, props: tpl))
        // Inline-Datenbank „Plan tracker“ in Notes
        var dbp = BlockProps(); dbp.databaseID = "tracker"
        add(block("tracker-block", .databaseInline, "", parent: .block("notes"), sk: "a8", props: dbp))
        var db = Database(id: "tracker", blockID: "tracker-block", title: "Plan tracker", properties: [
            PropertySchema(id: "title", name: "Name", type: .title),
            PropertySchema(id: "link", name: "Link", type: .url),
            PropertySchema(id: "note", name: "Note", type: .text),
            PropertySchema(id: "where", name: "Where", type: .place),
            PropertySchema(id: "mail", name: "Mail", type: .email),
            PropertySchema(id: "done", name: "Done", type: .checkbox),
        ])
        db.createdAt = t0; db.updatedAt = t0; db.stamp = Stamp(millis: 10, counter: 0, node: "fx")
        out.append(.database(db))
        add(block("row-ship", .page, "Ship it", parent: .database("tracker"), sk: "a0", day: 7,
                  values: ["link": .url("https://example.com/plan"), "note": .text(RichText("Ëxtra notes")), "done": .checkbox(true)]))
        add(block("row-second", .page, "Second row", parent: .database("tracker"), sk: "a1", day: 6,
                  values: ["note": .text(RichText("nothing")), "where": .place(#"{"name":"Café Central","address":"Herrengasse 14, Wien","lat":48.21,"lon":16.36}"#),
                           "mail": .email("plan@example.org")], by: "user-2"))
        // Ganzseitige Datenbank: Titel aus der Datenbank
        var fp = BlockProps(); fp.databaseID = "archive"
        add(block("archive-block", .databasePage, "", parent: .workspace, sk: "a4", day: 4, props: fp))
        var archive = Database(id: "archive", blockID: "archive-block", title: "Plan archive", properties: [PropertySchema(id: "title", name: "Name", type: .title)])
        archive.createdAt = t0; archive.updatedAt = t0; archive.stamp = Stamp(millis: 10, counter: 0, node: "fx")
        out.append(.database(archive))
        add(block("archive-row", .page, "Café ledger", parent: .database("archive"), sk: "a0", day: 8))
        return out
    }

    static let queries = ["plan", "PLAN", "cafe", "café", "resume", "zurich", "budget", "roadmap", "example.com",
                          "extra", "ship", "plan child", "notes plan", "nothing here", "tracker", "  plan  ",
                          "diagram", "zebra", "wien", "ledger", "archive", "plan@example"]

    /// Inkrementelle Schritte: was eingespielt wird (Records/Löschungen) und welche Anfragen danach laufen.
    struct Step {
        var name: String
        var records: [Record] = []
        var deletions: [RecordKey] = []
        var queries: [String]
    }

    static func steps(_ base: [Record]) -> [Step] {
        var blocks: [RecordID: Block] = [:]
        var dbs: [RecordID: Database] = [:]
        for r in base {
            if case .block(let b) = r { blocks[b.id] = b }
            if case .database(let d) = r { dbs[d.id] = d }
        }
        var millis: Int64 = 1_000
        func edit(_ id: RecordID, _ f: (inout Block) -> Void) -> Record {
            var b = blocks[id]!
            f(&b)
            millis += 10
            b.stamp = Stamp(millis: millis, counter: 0, node: "remote")
            blocks[id] = b
            return .block(b)
        }
        func editDB(_ id: RecordID, _ f: (inout Database) -> Void) -> Record {
            var d = dbs[id]!
            f(&d)
            millis += 10
            d.stamp = Stamp(millis: millis, counter: 0, node: "remote")
            dbs[id] = d
            return .database(d)
        }
        func new(_ b: Block) -> Record {
            var b = b
            millis += 10
            b.stamp = Stamp(millis: millis, counter: 0, node: "remote")
            blocks[b.id] = b
            return .block(b)
        }
        var out: [Step] = []
        out.append(Step(name: "Erwähntes Ziel umbenannt", records: [edit("roadmap") { $0.text = "Masterplan" }],
                        queries: ["masterplan", "roadmap", "cafe"]))
        out.append(Step(name: "Unterseite in den Papierkorb", records: [edit("child") { $0.trashedAt = t0 }],
                        queries: ["cafe", "plan child", "child"]))
        out.append(Step(name: "Block verschoben", records: [edit("n-resume") { $0.parent = .block("roadmap"); $0.sortKey = "a0" }],
                        queries: ["resume", "details"]))
        out.append(Step(name: "Zeile gelöscht", deletions: [RecordKey(.block, "row-ship")], queries: ["example.com", "extra", "ship", "plan"]))
        out.append(Step(name: "Datenbank umbenannt", records: [editDB("tracker") { $0.title = "Zebra tracker" }], queries: ["zebra", "tracker", "plan tracker"]))
        out.append(Step(name: "Neue Seite und Wiederherstellen",
                        records: [new(block("fresh", .page, "Fresh zebra notes", parent: .block("notes"), sk: "a9", day: 10, millis: 0)),
                                  new(block("fresh-a", .text, "brand new plan content", parent: .block("fresh"), sk: "a0", millis: 0)),
                                  edit("child") { $0.trashedAt = nil }],
                        queries: ["zebra", "brand new", "cafe", "plan"]))
        out.append(Step(name: "Text geändert", records: [edit("n-plan") { $0.text = "Another line without the word" }, edit("n-mention") { $0.text = "Plain text now" }],
                        queries: ["plan", "masterplan", "another"]))
        out.append(Step(name: "Elternseite gelöscht (Waisen)", deletions: [RecordKey(.block, "notes")], queries: ["plan", "cafe", "budget", "zebra", "second"]))
        return out
    }

    public static func fulltext() -> JSONValue {
        let records = workspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        var cases: [JSONValue] = []
        guard let corpus = SearchCorpus.build(blocks: store.blocks, databases: store.databases, revision: 0) else { return C.file("search", []) }
        var inPage = SearchFilters(); inPage.inPage = "notes"
        var titleOnly = SearchFilters(); titleOnly.titleOnly = true
        var editedAfter = SearchFilters(); editedAfter.editedAfter = C.now.addingTimeInterval(-3 * 86_400)
        var by = SearchFilters(); by.createdBy = "user-2"
        let filters: [(String, SearchFilters)] = [("ohne Filter", SearchFilters()), ("in Notes", inPage), ("nur Titel", titleOnly),
                                                  ("bearbeitet nach", editedAfter), ("von user-2", by)]
        for q in queries {
            for (fname, f) in filters {
                let sorts: [SearchSort] = fname == "ohne Filter" ? SearchSort.allCases : [.bestMatch]
                for sort in sorts {
                    cases.append(C.testCase("\"\(q)\" · \(fname) · \(sort.rawValue)", E.searchInput(q, f, sort, 60),
                                            E.searchOutput(store, corpus, q, f, sort, 60)))
                }
            }
        }
        // Inkrementell: Schritte nacheinander auf einem Store; jeder Fall enthält alle Schritte bis zu sich.
        var applied: [JSONValue] = []
        for step in steps(records) {
            _ = store.applyRemote(step.records, deletions: step.deletions)
            applied.append(["name": .string(step.name), "records": .array(step.records.map(S.line)),
                            "deletions": .array(step.deletions.map { .string($0.id) })])
            guard let c = SearchCorpus.build(blocks: store.blocks, databases: store.databases, revision: 0) else { continue }
            var results: [JSONValue] = []
            for q in step.queries { results.append(E.searchOutput(store, c, q, SearchFilters(), .bestMatch, 60)) }
            cases.append(C.testCase("inkrementell: " + step.name,
                                    ["steps": .array(applied), "queries": .array(step.queries.map(JSONValue.string))],
                                    .array(results)))
        }
        return C.file("search", cases, meta: [
            "records": .array(records.map(S.line)), "now": .number(C.now.timeIntervalSince1970 * 1000),
            "note": .string("Volltext (BSD-157) über den Datenstand aus SearchCorpusTests. " + (E.searchNote.string ?? "")
                + " Inkrementell: die Schritte werden nacheinander als Remote-Records eingespielt (applyRemote; deletions = Block-IDs); "
                + "danach Suche ohne Filter, bestMatch, limit 60 – je Anfrage eine Trefferliste."),
        ])
    }
}
