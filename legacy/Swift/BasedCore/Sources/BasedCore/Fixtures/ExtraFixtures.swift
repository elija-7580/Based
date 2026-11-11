import Foundation

/// BSD-169 (ADR 0011): Golden Fixtures Teil 2 – Property-Umwandlung, Suchindex, Clipboard-HTML (rein/raus),
/// Undo gegen Remote. Gleiches Format wie `CoreFixtures`.
@MainActor
public enum ExtraFixtures {
    typealias C = CoreFixtures
    typealias S = StoreFixtures

    // MARK: Property-Umwandlung

    /// Jede Property der Aufgaben-Datenbank in jeden Zieltyp. Neue Optionen bekommen in Swift zufällige IDs;
    /// im Export heißen sie `new:<Name>`, neue Status-Gruppen `group:<Name>` (der Port muss sie gleich benennen
    /// oder vor dem Vergleich genauso normalisieren). Kalender-abhängig (Datum ↔ Text) → nur UTC.
    public static func conversion() -> JSONValue {
        let records = S.queryWorkspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        guard let db = store.databases["tasks"] else { return C.file("conversion", []) }
        var cases: [JSONValue] = []
        let targets = PropertyType.creatable.filter { ![.formula, .rollup, .createdTime, .createdBy, .lastEditedTime, .lastEditedBy, .uniqueID].contains($0) }
        for p in db.properties where p.type != .title && !p.type.isComputed {
            for to in targets where to != p.type {
                guard let plan = store.propertyConversion("tasks", p.id, to: to) else { continue }
                let oldIDs = Set((p.options ?? []).map(\.id))
                var rename: [String: String] = [:]
                for o in plan.schema.options ?? [] where !oldIDs.contains(o.id) { rename[o.id] = "new:" + o.name }
                for g in plan.schema.statusGroups ?? [] where !(p.statusGroups ?? []).contains(where: { $0.id == g.id }) { rename[g.id] = "group:" + g.name }
                func norm(_ v: JSONValue) -> JSONValue {
                    switch v {
                    case .string(let s): return .string(rename[s] ?? s)
                    case .array(let a): return .array(a.map(norm))
                    case .object(let o): return .object(o.mapValues(norm))
                    default: return v
                    }
                }
                var values: [String: JSONValue] = [:]
                for (row, v) in plan.values { values[row] = v.map { norm(C.json($0)) } ?? .null }
                let loss = store.conversionLoss("tasks", p.id, to: to)
                cases.append(C.testCase("\(p.id) (\(p.type.rawValue)) → \(to.rawValue)",
                                        ["database": "tasks", "property": .string(p.id), "to": .string(to.rawValue)],
                                        ["schema": norm(C.json(plan.schema)), "values": .object(values), "lossCells": .number(Double(loss.cells))]))
            }
        }
        return C.file("conversion", cases, meta: [
            "records": .array(records.map(S.line)),
            "note": "values: nur Zeilen mit Wert in der alten Property (auch im Papierkorb); null = Wert entfällt. Neue IDs: new:<Name>, group:<Name>.",
        ])
    }

    // MARK: Suche

    static func searchWorkspace() -> [Record] {
        var out = S.queryWorkspace()
        let t0 = S.t0
        func block(_ id: String, _ type: BlockType, _ text: String, parent: ParentRef, sk: String, minutes: Double = 0, by: String = "user-1", trashed: Bool = false) {
            var b = Block(id: id, type: type, parent: parent, sortKey: sk, text: RichText(text), createdAt: t0.addingTimeInterval(minutes * 60), createdBy: by)
            b.updatedAt = t0.addingTimeInterval(minutes * 120); b.stamp = Stamp(millis: 5, counter: 0, node: "fx")
            if trashed { b.trashedAt = t0 }
            out.append(.block(b))
        }
        block("doc-1", .page, "Architektur-Review", parent: .workspace, sk: "b0", minutes: 10)
        block("doc-1-a", .heading1, "Ziel", parent: .block("doc-1"), sk: "a0")
        block("doc-1-b", .text, "Based soll auf allen Plattformen laufen: Mac, iPhone, Android, Windows und Linux.", parent: .block("doc-1"), sk: "a1")
        block("doc-1-c", .text, "Der Sync nutzt hybride logische Uhren (HLC) und Tombstones.", parent: .block("doc-1"), sk: "a2")
        block("doc-2", .page, "Einkaufsliste", parent: .workspace, sk: "b1", minutes: 20, by: "user-2")
        block("doc-2-a", .todo, "Äpfel und Birnen", parent: .block("doc-2"), sk: "a0")
        block("doc-2-b", .todo, "Café-Bohnen (Crème)", parent: .block("doc-2"), sk: "a1")
        block("doc-3", .page, "Sub-Seite im Review", parent: .block("doc-1"), sk: "a3", minutes: 30)
        block("doc-3-a", .text, "Plattformen: Tauri statt Electron, wegen RAM.", parent: .block("doc-3"), sk: "a0")
        block("doc-4", .page, "Alte Notiz Plattform", parent: .workspace, sk: "b2", minutes: 5, trashed: true)
        block("doc-5", .page, "", parent: .workspace, sk: "b3", minutes: 40)
        block("doc-5-a", .code, "let plattform = \"linux\"", parent: .block("doc-5"), sk: "a0")
        return out
    }

    public static func search() -> JSONValue {
        let records = searchWorkspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        guard let corpus = SearchCorpus.build(blocks: store.blocks, databases: store.databases, revision: 0) else { return C.file("search", []) }
        var cases: [JSONValue] = []
        func run(_ name: String, _ q: String, _ edit: (inout SearchFilters) -> Void = { _ in }, sort: SearchSort = .bestMatch, limit: Int = 50) {
            var f = SearchFilters(); edit(&f)
            cases.append(C.testCase(name, searchInput(q, f, sort, limit), searchOutput(store, corpus, q, f, sort, limit)))
        }
        for q in ["plattform", "Plattformen", "PLATTFORM", "platt", "review", "architektur review", "apfel", "äpfel", "cafe", "creme", "hlc",
                  "tauri electron", "login", "typo", "crash", "zebra", "alpha", "🚀", "linux", "x", "nichtvorhanden", "  sync  "] {
            run("Suche \"\(q)\"", q)
        }
        run("nur Titel", "plattform") { $0.titleOnly = true }
        run("in Seite doc-1", "plattform") { $0.inPage = "doc-1" }
        run("von user-2", "e") { $0.createdBy = "user-2" }
        run("bearbeitet nach", "e") { $0.editedAfter = S.t0.addingTimeInterval(1800) }
        run("bearbeitet vor", "e") { $0.editedBefore = S.t0.addingTimeInterval(1800) }
        for sort in SearchSort.allCases { run("Sortierung \(sort.rawValue)", "e", sort: sort) }
        run("Limit 3", "e", limit: 3)
        return C.file("search", cases, meta: ["records": .array(records.map(S.line)), "now": .number(C.now.timeIntervalSince1970 * 1000),
                                               "note": searchNote])
    }

    static let searchNote: JSONValue = "Index: SearchCorpus.build über alle Blöcke und Datenbanken (Papierkorb ausgenommen). Inhaltstreffer: snippetBlocks = alle Blöcke der Seite, die passen; Swift wählt einen davon (Dictionary-Reihenfolge), der Port soll den ersten in Dokumentreihenfolge nehmen. Zeilen-Treffer: snippet über die Werte nach Property-ID sortiert. Reihenfolge: Swift-Kriterium (bestMatch: Score absteigend, dann Titel), bei Gleichstand pageID aufsteigend; limit erst danach."

    static func searchInput(_ q: String, _ f: SearchFilters, _ sort: SearchSort, _ limit: Int) -> JSONValue {
        var filters: [String: JSONValue] = ["titleOnly": .bool(f.titleOnly)]
        if let p = f.inPage { filters["inPage"] = .string(p) }
        if let u = f.createdBy { filters["createdBy"] = .string(u) }
        if let d = f.editedAfter { filters["editedAfter"] = .number(d.timeIntervalSinceReferenceDate) }
        if let d = f.editedBefore { filters["editedBefore"] = .number(d.timeIntervalSinceReferenceDate) }
        return ["query": .string(q), "filters": .object(filters), "sort": .string(sort.rawValue), "limit": .number(Double(limit))]
    }

    /// Treffer einer Suche im Fixture-Format (Gleichstand nach pageID, Snippet-Block als Kandidatenliste).
    static func searchOutput(_ store: WorkspaceStore, _ corpus: SearchCorpus, _ q: String, _ f: SearchFilters, _ sort: SearchSort, _ limit: Int) -> JSONValue {
        // Swift lässt die Reihenfolge bei Gleichstand offen (instabile Sortierung über Dictionary-Reihenfolge):
        // alle Treffer holen, mit pageID als letztem Kriterium sortieren, dann kürzen.
        let blocks = store.blocks
        func key(_ h: SearchHit) -> Date { (sort == .createdNewest || sort == .createdOldest ? blocks[h.pageID]?.createdAt : blocks[h.pageID]?.updatedAt) ?? .distantPast }
        let all = corpus.search(q, filters: f, sort: sort, limit: 100_000, now: C.now) ?? []
        let hits = Array(all.sorted { a, b in
            switch sort {
            case .bestMatch:
                if a.score != b.score { return a.score > b.score }
                let ta = store.title(of: a.pageID), tb = store.title(of: b.pageID)
                if ta != tb { return ta < tb }
            case .lastEditedNewest, .createdNewest: if key(a) != key(b) { return key(a) > key(b) }
            case .lastEditedOldest, .createdOldest: if key(a) != key(b) { return key(a) < key(b) }
            }
            return a.pageID < b.pageID
        }.prefix(limit))
        return .array(hits.map { h in
            var o: [String: JSONValue] = ["pageID": .string(h.pageID), "score": .number(h.score)]
            if h.blockID != nil {
                // Swift nimmt den ersten Treffer in Dictionary-Reihenfolge (nicht stabil): alle passenden Blöcke.
                let terms = SearchCorpus.fold(q.trimmingCharacters(in: .whitespacesAndNewlines)).split(separator: " ").map(String.init)
                let cands = corpus.contents.filter { e in e.page == h.pageID && terms.allSatisfy { SearchCorpus.has(e.folded, $0) } }
                o["snippetBlocks"] = .array(cands.map(\.blockID).sorted().map(JSONValue.string))
            } else if h.snippet != nil, let row = blocks[h.pageID], row.isRow {
                // Zeilenwerte stehen in Swift in Dictionary-Reihenfolge (nicht stabil): Ausschnitt über die Werte
                // nach Property-ID sortiert, wie der Port ihn bildet.
                let text = row.values.sorted { $0.key < $1.key }.compactMap { _, v -> String? in
                    switch v {
                    case .text(let t): return t.plainText
                    case .url(let s), .email(let s), .phone(let s): return s
                    case .place(let s): return PlaceValue.display(s)
                    default: return nil
                    }
                }.joined(separator: " ")
                let terms = SearchCorpus.fold(q.trimmingCharacters(in: .whitespacesAndNewlines)).split(separator: " ").map(String.init)
                o["snippet"] = .string(SearchEngine.snippet(text, SearchCorpus.fold(text), terms[0]))
            } else {
                o["snippet"] = h.snippet.map(JSONValue.string) ?? .null
            }
            return .object(o)
        })
    }

    // MARK: Clipboard-HTML

    static func imported(_ b: ImportedBlock) -> JSONValue {
        var o: [String: JSONValue] = ["type": .string(b.type.rawValue), "text": C.json(b.text), "children": .array(b.children.map(imported))]
        if b.props != BlockProps() { o["props"] = C.json(b.props) }
        if let l = b.linkTarget { o["linkTarget"] = .string(l) }
        return .object(o)
    }

    static let clipboardSamples: [(String, String)] = [
        ("Notion-Zwischenablage", """
        <meta charset="utf-8"><h2>Plan</h2>
        <p>Some <strong>bold</strong> and <span class="highlight-red">red</span> text with a
        <a href="https://www.notion.so/Tasks-1fe618c1167e80f8946ec1a7918dfc28">Tasks</a> link.</p>
        <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div><span class="to-do-children-checked">Done thing</span></li>
        <li><div class="checkbox checkbox-off"></div><span>Open thing</span></li></ul>
        <ul><li>Bullet<ul><li>Nested</li></ul></li></ul>
        <details><summary>Toggle title</summary><p>Inside toggle</p></details>
        <aside><span class="icon">💡</span><div>Callout text</div></aside>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        <pre><code class="language-swift">let x = 1</code></pre><hr>
        """),
        ("Überschriften und Absätze", "<h1>Eins</h1><h2>Zwei</h2><h3>Drei</h3><h4>Vier</h4><h5>Fünf</h5><p>Text <em>kursiv</em> <u>unter</u> <s>durch</s> <code>code</code></p><p>zweiter</p>"),
        ("Listen verschachtelt", "<ol><li>Eins<ol><li>Eins.a</li></ol></li><li>Zwei</li></ol><ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>"),
        ("Zitat, Bild, Figure", "<blockquote>Zitat <b>fett</b></blockquote><img src=\"https://example.com/a.png\" alt=\"Bild\"><figure><img src=\"https://example.com/b.png\"><figcaption>Unterschrift</figcaption></figure>"),
        ("Farben", "<p class=\"block-color-blue_background\">Blau hinterlegt</p><p><span class=\"highlight-yellow_background\">gelb</span> <mark class=\"highlight-teal\">unbekannt</mark></p>"),
        ("Links", "<p><a href=\"https://example.com\">extern</a> <a href=\"based://page/doc-1\">intern</a> <a href=\"mailto:a@b.c\">Mail</a></p>"),
        ("Google Docs", "<meta charset=\"utf-8\"><b style=\"font-weight:normal;\" id=\"docs-internal-guid-1\"><p dir=\"ltr\"><span style=\"font-weight:700\">Fett</span><span> normal</span></p><ul><li dir=\"ltr\"><p dir=\"ltr\"><span>Punkt</span></p></li></ul></b>"),
        ("Leer und Text", "<span>just text</span>"),
        ("Entities und Leerraum", "<p>  A &amp; B &lt;tag&gt; &quot;x&quot; &#x1F680; &nbsp;Ende  </p>\n\n<p></p>"),
        ("Tabelle mit Kopfspalte", "<table><tbody><tr><td><strong>K</strong></td><td>V</td></tr><tr><td>a</td><td>1</td></tr></tbody></table>"),
    ]

    public static func clipboard(export: Bool) -> JSONValue {
        var cases: [JSONValue] = []
        let known = "1fe618c1-167e-80f8-946e-c1a7918dfc28"
        let importer = ClipboardHTMLImporter(resolvePage: ClipboardHTMLImporter.pageResolver { $0 == known || $0 == "doc-1" })
        for (name, html) in clipboardSamples {
            cases.append(C.testCase("einlesen: " + name, ["op": "parse", "html": .string(html)],
                                    ["isStructured": .bool(ClipboardHTMLImporter.isStructured(html)), "blocks": .array(importer.parse(html).map(imported))]))
        }
        if !export {
            return C.file("clipboard", cases, meta: ["resolvePage": .array([.string(known), "doc-1"]), "note": "parse: ImportedBlock ohne id."])
        }
        cases = []
        // Export (HTMLExporter.blocks) der Korpus-Seite und wieder einlesen. Datumszellen → zeitzonenabhängig (UTC).
        let records = (try? RecordFixtures.corpus()) ?? []
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        var exporter = HTMLExporter(store: store, pageLink: { id in (store.title(of: id), PageLink.url(id)) })
        exporter.headingOffset = 0
        for page in ["p-root", "p-asset", "p-url"] {
            let html = exporter.blocks(store.contentBlocks(of: page))
            cases.append(C.testCase("ausgeben: " + page, ["op": "export", "page": .string(page)],
                                    ["html": .string(html), "reparsed": .array(ClipboardHTMLImporter().parse(html).map(imported))]))
        }
        return C.file("clipboard", cases, meta: [
            "records": .array(records.map(S.line)),
            "note": "export: HTMLExporter(headingOffset 0, Seitenlinks based://page/<id>) über RecordFixtures.corpus; reparsed: ClipboardHTMLImporter ohne Seitenauflösung.",
        ])
    }

    // MARK: Undo gegen Remote

    public static func undoRemote() -> JSONValue {
        func baseRecords() -> [Record] {
            var out: [Record] = []
            var ws = Workspace(); ws.createdAt = S.t0; ws.updatedAt = S.t0; ws.stamp = Stamp(millis: 1, counter: 0, node: "fx")
            out.append(.workspace(ws))
            func b(_ id: String, _ type: BlockType, _ text: String, parent: ParentRef, sk: String) {
                var x = Block(id: id, type: type, parent: parent, sortKey: sk, text: RichText(text), createdAt: S.t0)
                x.updatedAt = S.t0; x.stamp = Stamp(millis: 1_000, counter: 0, node: "fx"); out.append(.block(x))
            }
            b("page", .page, "Seite", parent: .workspace, sk: "a0")
            b("l1", .text, "eins", parent: .block("page"), sk: "a0")
            b("l2", .text, "zwei", parent: .block("page"), sk: "a1")
            b("l3", .todo, "drei", parent: .block("page"), sk: "a2")
            return out
        }
        enum Op { case setText(String, String), delete([String]), remoteEdit(String, String), remoteDelete(String), undo, redo }
        let scenarios: [(String, [Op])] = [
            ("Remote-Änderung desselben Blocks bleibt", [.setText("l1", "lokal"), .remoteEdit("l1", "von drüben"), .undo, .redo]),
            ("lokales Löschen wird wiederhergestellt", [.delete(["l1"]), .remoteEdit("l2", "remote"), .undo, .redo]),
            ("remote gelöschter Block lebt nicht wieder auf", [.setText("l1", "lokal"), .remoteDelete("l1"), .undo, .redo]),
            ("unabhängige Schritte", [.setText("l1", "A"), .setText("l2", "B"), .remoteEdit("l2", "B remote"), .undo, .undo, .redo, .redo]),
            ("mehrere Blöcke in einem Schritt", [.delete(["l1", "l2"]), .remoteEdit("l2", "x"), .undo]),
            ("nichts rückgängig zu machen", [.undo, .redo]),
            ("Undo, dann Remote, dann Redo", [.setText("l3", "neu"), .undo, .remoteEdit("l3", "remote"), .redo]),
        ]
        var cases: [JSONValue] = []
        for (name, ops) in scenarios {
            let store = WorkspaceStore(persistence: MemoryPersistence(baseRecords()), node: "local")
            var wall: Int64 = 2_000
            store.clock.wallClock = { wall }
            store.clearUndoHistory()
            var stepsIn: [JSONValue] = [], stepsOut: [JSONValue] = []
            for op in ops {
                wall += 10
                var result: JSONValue = .null
                switch op {
                case .setText(let id, let t):
                    store.setText(id, RichText(t)); stepsIn.append(["op": "setText", "id": .string(id), "text": .string(t)])
                case .delete(let ids):
                    store.deleteBlocks(ids); stepsIn.append(["op": "delete", "ids": .array(ids.map(JSONValue.string))])
                case .remoteEdit(let id, let t):
                    var b = store.blocks[id] ?? Block(id: id, type: .text, parent: .block("page"), sortKey: "a9", createdAt: S.t0)
                    b.text = RichText(t); b.stamp = Stamp(millis: b.stamp.millis + 60_000, counter: 0, node: "zz-other")
                    b.updatedAt = S.t0.addingTimeInterval(Double(wall)); b.updatedBy = "zz-other"
                    store.applyRemote([.block(b)])
                    stepsIn.append(["op": "remote", "record": S.line(.block(b))])
                case .remoteDelete(let id):
                    let st = Stamp(millis: (store.blocks[id]?.stamp.millis ?? 0) + 60_000, counter: 0, node: "zz-other")
                    store.applyRemote([], deletions: [RecordKey(.block, id)], deletionStamps: [RecordKey(.block, id): st])
                    stepsIn.append(["op": "remoteDelete", "id": .string(id), "stamp": C.json(st)])
                case .undo, .redo:
                    let isUndo: Bool = { if case .undo = op { return true } else { return false } }()
                    let r = isUndo ? store.undo() : store.redo()
                    stepsIn.append(["op": .string(isUndo ? "undo" : "redo")])
                    result = ["name": r.name.map(JSONValue.string) ?? .null, "applied": .number(Double(r.applied)),
                              "skipped": .number(Double(r.skipped)), "droppedSteps": .number(Double(r.droppedSteps))]
                }
                var state: [String: JSONValue] = [:]
                for id in ["l1", "l2", "l3"] {
                    if let b = store.blocks[id] {
                        state[id] = ["text": .string(b.title), "trashed": .bool(b.trashedAt != nil), "parent": .string(b.parent.key)]
                    } else { state[id] = .null }
                }
                stepsOut.append(["result": result, "blocks": .object(state), "canUndo": .bool(store.canUndo), "canRedo": .bool(store.canRedo)])
            }
            cases.append(C.testCase(name, .array(stepsIn), .array(stepsOut)))
        }
        return C.file("undo-remote", cases, meta: ["records": .array(baseRecords().map(S.line)),
                                                     "note": "Lokale Uhr: node local, Wanduhr ab 2000 ms, +10 je Schritt; Undo-Verlauf vor dem ersten Schritt geleert."])
    }
}
