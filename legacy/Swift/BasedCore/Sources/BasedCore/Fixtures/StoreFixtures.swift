import Foundation

/// BSD-149 (ADR 0011): Fixtures, die einen WorkspaceStore brauchen (Abfragen, Relationen/Rollups,
/// Berechnungen, Suche in Ansichten, Merge/Tombstones). Eingabe sind immer Records im Wire-Format,
/// damit die TS-Portierung denselben Stand laden kann.
@MainActor
public enum StoreFixtures {
    typealias C = CoreFixtures
    static let t0 = Date(timeIntervalSinceReferenceDate: 784_000_000)

    static func line(_ r: Record) -> JSONValue {
        (try? JSONValue.parse(Data(RecordFixtures.line(r).utf8))) ?? .null
    }

    // MARK: Datenstand für Abfragen

    /// Zwei Datenbanken (Aufgaben, Projekte) mit Relation, Rollup, Formel und Zufallszeilen (fester Seed).
    static func queryWorkspace() -> [Record] {
        var out: [Record] = []
        var ws = Workspace(); ws.createdAt = t0; ws.updatedAt = t0; ws.stamp = Stamp(millis: 1, counter: 0, node: "fx")
        out.append(.workspace(ws))
        func pageBlock(_ id: String, _ title: String, parent: ParentRef, sk: String, values: [String: PropertyValue] = [:], type: BlockType = .page) -> Block {
            var b = Block(id: id, type: type, parent: parent, sortKey: sk, text: RichText(title), values: values, createdAt: t0, createdBy: "user-1")
            b.updatedAt = t0; b.stamp = Stamp(millis: 2, counter: 0, node: "fx"); return b
        }
        out.append(.block(pageBlock("home", "Home", parent: .workspace, sk: "a0")))
        out.append(.block(pageBlock("tasks-block", "Aufgaben", parent: .block("home"), sk: "a0", type: .databaseInline)))
        out.append(.block(pageBlock("projects-block", "Projekte", parent: .block("home"), sk: "a1", type: .databaseInline)))

        func p(_ id: String, _ name: String, _ type: PropertyType, _ edit: (inout PropertySchema) -> Void = { _ in }) -> PropertySchema {
            var s = PropertySchema(id: id, name: name, type: type); edit(&s); return s
        }
        let kinds = [SelectOption(id: "k-bug", name: "Bug", color: .red), SelectOption(id: "k-feat", name: "Feature", color: .blue),
                     SelectOption(id: "k-chore", name: "Chore", color: .gray)]
        let tags = [SelectOption(id: "t-ui", name: "UI", color: .purple), SelectOption(id: "t-sync", name: "Sync", color: .green),
                    SelectOption(id: "t-ai", name: "AI", color: .orange)]
        var tasks = Database(id: "tasks", blockID: "tasks-block", title: "Aufgaben", properties: [
            p("title", "Name", .title),
            p("points", "Points", .number) { $0.numberFormat = .number },
            p("kind", "Kind", .select) { $0.options = kinds },
            p("tags", "Tags", .multiSelect) { $0.options = tags },
            p("status", "Status", .status) {
                $0.options = [SelectOption(id: "s-open", name: "Offen", color: .default), SelectOption(id: "s-doing", name: "In Arbeit", color: .blue),
                              SelectOption(id: "s-done", name: "Erledigt", color: .green)]
                $0.statusGroups = [StatusGroup(id: "g-todo", name: "To-do", color: .gray, optionIDs: ["s-open"]),
                                   StatusGroup(id: "g-prog", name: "In progress", color: .blue, optionIDs: ["s-doing"]),
                                   StatusGroup(id: "g-done", name: "Complete", color: .green, optionIDs: ["s-done"])]
            },
            p("done", "Done", .checkbox),
            p("due", "Due", .date),
            p("note", "Note", .text),
            p("who", "Who", .person),
            p("double", "Double", .formula) { $0.formula = "prop(\"Points\") * 2" },
            p("label", "Label", .formula) { $0.formula = "prop(\"Name\") + \" (\" + format(prop(\"Points\")) + \")\"" },
            p("project", "Project", .relation) { $0.relation = RelationConfig(databaseID: "projects", syncedPropertyID: "ptasks") },
            p("pname", "Project name", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "project", targetPropertyID: "title", function: .showOriginal) },
            p("uid", "ID", .uniqueID) { $0.idPrefix = "T" },
            p("created", "Created", .createdTime),
        ])
        tasks.createdAt = t0; tasks.updatedAt = t0; tasks.stamp = Stamp(millis: 3, counter: 0, node: "fx")
        var projects = Database(id: "projects", blockID: "projects-block", title: "Projekte", properties: [
            p("title", "Name", .title),
            p("ptasks", "Tasks", .relation) { $0.relation = RelationConfig(databaseID: "tasks", syncedPropertyID: "project") },
            p("total", "Total", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "ptasks", targetPropertyID: "points", function: .sum) },
            p("avg", "Average", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "ptasks", targetPropertyID: "points", function: .average) },
            p("count", "Count", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "ptasks", targetPropertyID: "title", function: .countAll) },
            p("pct", "Done %", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "ptasks", targetPropertyID: "done", function: .percentChecked) },
            p("latest", "Latest due", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "ptasks", targetPropertyID: "due", function: .latest) },
            p("open", "Open tasks", .formula) { $0.formula = "prop(\"Tasks\").filter(current.prop(\"Done\") == false).length()" },
        ])
        projects.createdAt = t0; projects.updatedAt = t0; projects.stamp = Stamp(millis: 3, counter: 1, node: "fx")
        out.append(.database(tasks)); out.append(.database(projects))

        let projectIDs = ["pr-1", "pr-2", "pr-3"]
        var rng = C.Seeded(state: 0x7A5C)
        var taskIDsByProject: [String: [String]] = [:]
        let names = ["Crash beim Start", "Login", "Typo", "Sync-Konflikt", "Dark Mode", "Export", "Import", "Suche", "Kalender", "Agent",
                     "Sidebar", "Formeln", "Rollup", "Board", "Leere Zeile", "ÄÖÜ Umlaute", "emoji 🚀", "zebra", "Alpha", "alpha"]
        let sks = FractionalIndex.keys(count: names.count)
        for (i, name) in names.enumerated() {
            var values: [String: PropertyValue] = [:]
            if rng.int(5) > 0 { values["points"] = .number(Double(rng.int(13)) - (rng.int(4) == 0 ? 2.5 : 0)) }
            if rng.int(4) > 0 { values["kind"] = .select(kinds[rng.int(kinds.count)].id) }
            if rng.int(3) > 0 { values["tags"] = .multiSelect((0..<rng.int(3)).map { _ in tags[rng.int(tags.count)].id }) }
            values["status"] = .status(["s-open", "s-doing", "s-done"][rng.int(3)])
            if rng.int(2) == 0 { values["done"] = .checkbox(rng.int(2) == 0) }
            if rng.int(3) > 0 {
                let day = Date(timeIntervalSince1970: 1_700_000_000 + Double(rng.int(60) - 30) * 86_400)
                values["due"] = .date(DateValue(start: day, includeTime: rng.int(2) == 0))
            }
            if rng.int(3) == 0 { values["note"] = .text(RichText(["wichtig", "später", "Notiz mit Text"][rng.int(3)])) }
            if rng.int(3) == 0 { values["who"] = .person(rng.int(2) == 0 ? ["user-1"] : ["user-2", "user-1"]) }
            values["uid"] = .uniqueID(i + 1)
            let id = "task-\(i + 1)"
            if rng.int(4) > 0 {
                let pr = projectIDs[rng.int(projectIDs.count)]
                values["project"] = .relation([pr]); taskIDsByProject[pr, default: []].append(id)
            }
            if name == "Leere Zeile" { values = ["uid": .uniqueID(i + 1)] }
            var b = pageBlock(id, name == "Leere Zeile" ? "" : name, parent: .database("tasks"), sk: sks[i], values: values)
            b.createdAt = Date(timeIntervalSinceReferenceDate: 784_000_000 + Double(i) * 3600)
            out.append(.block(b))
        }
        for (i, pr) in projectIDs.enumerated() {
            out.append(.block(pageBlock(pr, ["Based", "Publit", "Leer"][i], parent: .database("projects"), sk: "a\(i)",
                                        values: ["ptasks": .relation(taskIDsByProject[pr] ?? [])])))
        }
        return out
    }

    static func viewJSON(_ v: DatabaseView) -> JSONValue { C.json(v) }

    static func view(_ id: String, _ type: ViewType = .table, _ edit: (inout DatabaseView) -> Void) -> DatabaseView {
        var v = DatabaseView(id: id, databaseID: "tasks", blockID: "tasks-block", name: id, type: type, sortKey: "a0")
        v.createdAt = t0; v.updatedAt = t0; v.stamp = Stamp(millis: 4, counter: 0, node: "fx"); edit(&v); return v
    }

    static func cond(_ prop: String, _ op: FilterOp, _ value: FilterValue? = nil) -> FilterItem {
        .condition(FilterCondition(id: "c-\(prop)-\(op.rawValue)", propertyID: prop, op: op, value: value))
    }

    static func queryViews() -> [(String, DatabaseView, String?)] {
        var out: [(String, DatabaseView, String?)] = []
        out.append(("alles, Standardreihenfolge", view("v0") { _ in }, nil))
        for prop in ["title", "points", "kind", "tags", "status", "done", "due", "note", "who", "double", "label", "project", "pname", "uid", "created"] {
            for asc in [true, false] {
                out.append(("sortiert nach \(prop) \(asc ? "auf" : "ab")", view("v-s-\(prop)-\(asc)") { $0.sorts = [SortRule(propertyID: prop, ascending: asc)] }, nil))
            }
        }
        out.append(("zwei Sortierungen", view("v-s2") { $0.sorts = [SortRule(propertyID: "kind"), SortRule(propertyID: "points", ascending: false)] }, nil))
        let filters: [(String, FilterItem)] = [
            ("Text enthält", cond("title", .contains, .text("a"))), ("Text beginnt", cond("title", .startsWith, .text("s"))),
            ("Text endet", cond("title", .endsWith, .text("t"))), ("Text gleich", cond("title", .equals, .text("Login"))),
            ("Text ungleich", cond("title", .notEquals, .text("Login"))), ("Text enthält nicht", cond("title", .notContains, .text("e"))),
            ("Titel leer", cond("title", .isEmpty)), ("Notiz nicht leer", cond("note", .isNotEmpty)),
            ("Zahl >", cond("points", .greater, .number(5))), ("Zahl <=", cond("points", .lessOrEqual, .number(3))),
            ("Zahl =", cond("points", .equals, .number(0))), ("Zahl leer", cond("points", .isEmpty)),
            ("Select =", cond("kind", .equals, .options(["k-bug"]))), ("Select ≠", cond("kind", .notEquals, .options(["k-bug"]))),
            ("Select leer", cond("kind", .isEmpty)), ("Multi enthält", cond("tags", .contains, .options(["t-ui"]))),
            ("Multi enthält nicht", cond("tags", .notContains, .options(["t-ui"]))), ("Status =", cond("status", .equals, .options(["s-done"]))),
            ("Checkbox ja", cond("done", .equals, .bool(true))), ("Checkbox nein", cond("done", .equals, .bool(false))),
            ("Datum vor", cond("due", .before, .date(Date(timeIntervalSince1970: 1_700_000_000)))),
            ("Datum ab", cond("due", .onOrAfter, .date(Date(timeIntervalSince1970: 1_700_000_000)))),
            ("Datum nächste Woche", cond("due", .within, .relative(.nextWeek))), ("Datum letzter Monat", cond("due", .within, .relative(.pastMonth))),
            ("Datum leer", cond("due", .isEmpty)), ("Person enthält", cond("who", .contains, .options(["user-2"]))),
            ("Formel > ", cond("double", .greater, .number(10))), ("Relation enthält", cond("project", .contains, .options(["pr-1"]))),
            ("Relation leer", cond("project", .isEmpty)), ("Rollup enthält", cond("pname", .contains, .text("Based"))),
            ("unbekannter Operator", .condition(FilterCondition(id: "c-u", propertyID: "title", op: .unknown))),
            ("fehlende Property", cond("gibts-nicht", .equals, .text("x"))),
        ]
        for (name, item) in filters {
            out.append(("Filter: \(name)", view("v-f-\(name)") { $0.filter = FilterGroup(combinator: .and, items: [item]); $0.sorts = [SortRule(propertyID: "uid")] }, nil))
        }
        out.append(("Filter: und/oder verschachtelt", view("v-f-nest") {
            $0.filter = FilterGroup(combinator: .or, items: [
                cond("points", .greater, .number(8)),
                .group(FilterGroup(combinator: .and, items: [cond("kind", .equals, .options(["k-bug"])), cond("done", .equals, .bool(true))])),
            ])
        }, nil))
        out.append(("Filter: unbekannte Verknüpfung", view("v-f-xor") { $0.filter = FilterGroup(combinator: .unknown("xor"), items: [cond("done", .equals, .bool(true))]) }, nil))
        for prop in ["kind", "tags", "status", "done", "who", "project", "points", "title"] {
            out.append(("Gruppiert nach \(prop)", view("v-g-\(prop)", .board) { $0.groupBy = GroupRule(propertyID: prop) }, nil))
        }
        for g in DateGrouping.allCases {
            out.append(("Gruppiert nach Datum (\(g.rawValue))", view("v-g-due-\(g.rawValue)", .board) {
                var r = GroupRule(propertyID: "due"); r.dateGrouping = g; $0.groupBy = r
            }, nil))
        }
        out.append(("Gruppen: versteckt, leere aus, eigene Reihenfolge", view("v-g-opts", .board) {
            var r = GroupRule(propertyID: "kind"); r.hiddenGroups = ["k-chore"]; r.hideEmptyGroups = true; r.groupOrder = ["k-feat", "", "k-bug"]
            $0.groupBy = r; $0.sorts = [SortRule(propertyID: "points", ascending: false)]
        }, nil))
        for term in ["log", "LOG", "ä", "a b", "🚀", "", "T-3", "zzz"] {
            out.append(("Suche \"\(term)\"", view("v-q") { _ in }, term))
        }
        return out
    }

    // MARK: Abfragen

    public static func queries() -> JSONValue {
        let records = queryWorkspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        let q = QueryEngine(store: store, now: C.now)
        var cases: [JSONValue] = []
        for (name, v, search) in queryViews() {
            let result = q.run(v, search: search)
            var out: [String: JSONValue] = ["rows": .array(result.rows.map { .string($0.id) })]
            if let groups = result.groups {
                out["groups"] = .array(groups.map { g in
                    ["id": .string(g.id), "title": .string(g.title), "color": g.color.map { .string($0.rawValue) } ?? .null,
                     "rows": .array(g.rows.map { .string($0.id) })]
                })
            }
            cases.append(C.testCase(name, ["view": viewJSON(v), "search": search.map(JSONValue.string) ?? .null], .object(out)))
        }
        return C.file("queries", cases, meta: ["records": .array(records.map(line)), "now": .number(C.now.timeIntervalSince1970 * 1000)])
    }

    /// Berechnete Werte (Formeln, Rollups, Relationen) jeder Zeile und Spalten-Berechnungen.
    public static func values() -> JSONValue {
        let records = queryWorkspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        let q = QueryEngine(store: store, now: C.now)
        var cases: [JSONValue] = []
        for dbID in ["tasks", "projects"] {
            guard let db = store.databases[dbID] else { continue }
            let rows = store.rows(of: dbID)
            for row in rows {
                var vals: [String: JSONValue] = [:]
                for p in db.properties { vals[p.id] = C.value(q.value(row, p, db)) }
                cases.append(C.testCase("Werte \(dbID)/\(row.id)", ["op": "values", "database": .string(dbID), "row": .string(row.id)], .object(vals)))
            }
            for p in db.properties {
                var calcs: [String: JSONValue] = [:]
                for fn in CalculationType.allCases where fn != .none {
                    calcs[fn.rawValue] = C.value(QueryEngine.aggregate(rows.map { q.value($0, p, db) }, fn, p))
                }
                cases.append(C.testCase("Berechnungen \(dbID)/\(p.id)", ["op": "aggregate", "database": .string(dbID), "property": .string(p.id)], .object(calcs)))
            }
        }
        return C.file("values", cases, meta: ["records": .array(records.map(line)), "now": .number(C.now.timeIntervalSince1970 * 1000), "rowOrder": "store.rows(of:)"])
    }

    // MARK: Merge und Tombstones

    /// Folgen von Remote-Batches auf einen leeren Store; nach jedem Schritt Ergebnis und Stand.
    public static func merge() -> JSONValue {
        func page(_ id: String, _ title: String, _ millis: Int64, counter: UInt32 = 0, node: String = "r") -> Record {
            var b = Block(id: id, type: .page, parent: .workspace, sortKey: "a0", text: RichText(title), createdAt: t0)
            b.updatedAt = t0; b.stamp = Stamp(millis: millis, counter: counter, node: node); return .block(b)
        }
        typealias Step = (records: [Record], deletions: [(String, Stamp?)])
        let scenarios: [(String, [Step])] = [
            ("neuer Record kommt an", [([page("a", "A", 10)], [])]),
            ("neuer gewinnt (millis)", [([page("a", "A1", 10)], []), ([page("a", "A2", 11)], [])]),
            ("älterer verliert und ist stale", [([page("a", "A1", 10)], []), ([page("a", "A0", 9)], [])]),
            ("gleiche millis: counter entscheidet", [([page("a", "A1", 10, counter: 1)], []), ([page("a", "A2", 10, counter: 2)], []), ([page("a", "A3", 10, counter: 0)], [])]),
            ("gleiche millis+counter: node entscheidet", [([page("a", "A1", 10, node: "m")], []), ([page("a", "A2", 10, node: "n")], []), ([page("a", "A3", 10, node: "l")], [])]),
            ("identischer Stempel: nichts passiert", [([page("a", "A1", 10)], []), ([page("a", "anders", 10)], [])]),
            ("Löschung mit neuerem Stempel entfernt", [([page("a", "A", 10)], []), ([], [("a", Stamp(millis: 11, counter: 0, node: "r"))])]),
            ("Löschung mit älterem Stempel verliert", [([page("a", "A", 10)], []), ([], [("a", Stamp(millis: 9, counter: 0, node: "r"))])]),
            ("Löschung ohne Stempel entfernt immer", [([page("a", "A", 10)], []), ([], [("a", nil)])]),
            ("kein Wiederbeleben durch älteren Record", [([page("a", "A", 10)], []), ([], [("a", Stamp(millis: 20, counter: 0, node: "r"))]), ([page("a", "A alt", 15)], [])]),
            ("neuerer Record nach Löschung gewinnt", [([page("a", "A", 10)], []), ([], [("a", Stamp(millis: 20, counter: 0, node: "r"))]), ([page("a", "A neu", 25)], [])]),
            ("Löschung unbekannter Records", [([], [("x", Stamp(millis: 5, counter: 0, node: "r"))]), ([page("x", "X", 4)], []), ([page("x", "X2", 6)], [])]),
            ("Batch mit mehreren Records", [([page("a", "A", 10), page("b", "B", 10), page("c", "C", 10)], []),
                                           ([page("a", "A2", 12), page("b", "B0", 8)], [("c", Stamp(millis: 11, counter: 0, node: "r"))])]),
        ]
        var cases: [JSONValue] = []
        for (name, steps) in scenarios {
            let store = WorkspaceStore(persistence: MemoryPersistence(), node: "local")
            store.clock.wallClock = { 1 }
            var stepsOut: [JSONValue] = []
            var stepsIn: [JSONValue] = []
            for step in steps {
                let keys = step.deletions.map { RecordKey(.block, $0.0) }
                var stamps: [RecordKey: Stamp] = [:]
                for (id, s) in step.deletions { if let s { stamps[RecordKey(.block, id)] = s } }
                let r = store.applyRemoteReporting(step.records, deletions: keys, deletionStamps: stamps)
                stepsIn.append(["records": .array(step.records.map(line)),
                                "deletions": .array(step.deletions.map { ["kind": "block", "id": .string($0.0), "stamp": $0.1.map(C.json) ?? .null] })])
                var state: [String: JSONValue] = [:]
                for (id, b) in store.blocks.sorted(by: { $0.key < $1.key }) {
                    state["block:" + id] = ["stamp": C.json(b.stamp), "title": .string(b.title)]
                }
                var tomb: [String: JSONValue] = [:]
                for (k, s) in r.tombstoned { tomb[k.description] = C.json(s) }
                stepsOut.append(["stale": .array(r.stale.sorted().map { .string($0.description) }), "tombstoned": .object(tomb), "blocks": .object(state)])
            }
            cases.append(C.testCase(name, .array(stepsIn), .array(stepsOut)))
        }
        return C.file("merge", cases, meta: ["note": "Store startet leer (Workspace wird lokal angelegt und ist nicht Teil von blocks)."])
    }
}
