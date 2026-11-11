import Foundation

/// BSD-248 (ADR 0011): Golden Fixtures für Datenbank-Schreiboperationen (DatabaseOps, RelationIntegrity,
/// UniqueIDRepair, Zeilen im Papierkorb). Ausgangsdaten: `StoreFixtures.queryWorkspace()` plus zwei Ansichten.
/// Jeder Fall: Schritte (Operation + Argumente) → alle geänderten Records nach dem letzten Schritt, normalisiert:
/// ohne Zeiten/Stempel (`createdAt`, `updatedAt`, `stamp`), `trashedAt` als "now", neu erzeugte IDs als "new".
/// Nur Fixture-Export (Swift-App eingefroren).
@MainActor
enum DatabaseOpsFixtures {
    typealias C = CoreFixtures
    typealias Step = (op: String, args: [String: JSONValue])

    static func records() -> [Record] {
        var out = StoreFixtures.queryWorkspace()
        var v1 = StoreFixtures.view("v-table") {
            $0.filter = FilterGroup(combinator: .and, items: [StoreFixtures.cond("kind", .equals, .options(["k-bug", "k-feat"])),
                                                              StoreFixtures.cond("points", .greater, .number(2))])
            $0.sorts = [SortRule(propertyID: "points", ascending: false), SortRule(propertyID: "kind")]
            $0.calculations = ["points": .sum, "kind": .countValues]
        }
        v1.name = "Tabelle"
        var v2 = StoreFixtures.view("v-board", .board) {
            var g = GroupRule(propertyID: "status"); g.hiddenGroups = ["s-doing"]; g.groupOrder = ["s-done", "s-doing", "s-open"]
            $0.groupBy = g
        }
        v2.name = "Board"; v2.sortKey = "a1"
        var block = out.compactMap { r -> Block? in if case .block(let b) = r, b.id == "tasks-block" { return b }; return nil }.first!
        block.props.viewIDs = ["v-table", "v-board"]
        out = out.map { r in if case .block(let b) = r, b.id == "tasks-block" { return .block(block) }; return r }
        out.append(.view(v1)); out.append(.view(v2))
        return out
    }

    static let steps: [(String, [Step])] = [
        ("Property umbenennen: Formeln hier und in der verknüpften Datenbank", [("renameProperty", ["db": "tasks", "prop": "points", "name": "Punkte"])]),
        ("Property umbenennen: current.prop in der anderen Datenbank", [("renameProperty", ["db": "tasks", "prop": "done", "name": "Fertig"])]),
        ("Relation löschen: Gegenseite wird one-way und behält Werte", [("deleteProperty", ["db": "tasks", "prop": "project"])]),
        ("Spiegel löschen: Quelle bleibt", [("deleteProperty", ["db": "projects", "prop": "ptasks"])]),
        ("Property löschen: Ansichten und fremde Rollups", [("deleteProperty", ["db": "tasks", "prop": "points"])]),
        ("Select löschen: Filter, Sortierung, Berechnung", [("deleteProperty", ["db": "tasks", "prop": "kind"])]),
        ("Status löschen: Gruppierung", [("deleteProperty", ["db": "tasks", "prop": "status"])]),
        ("Relationsziel ändern: Spiegel, Werte und Rollups fallen weg", [("setRelationTarget", ["db": "tasks", "prop": "project", "target": "tasks"])]),
        ("Relationsziel entfernen", [("setRelationTarget", ["db": "tasks", "prop": "project", "target": .null])]),
        ("Typwechsel weg von Relation entfernt den Spiegel", [("changePropertyType", ["db": "tasks", "prop": "project", "type": "text"])]),
        ("Typwechsel Select → Multi-Select", [("changePropertyType", ["db": "tasks", "prop": "kind", "type": "multiSelect"])]),
        ("Typwechsel Zahl → Text", [("changePropertyType", ["db": "tasks", "prop": "points", "type": "text"])]),
        ("Relation duplizieren ist one-way", [("duplicateProperty", ["db": "tasks", "prop": "project"])]),
        ("Zahl duplizieren kopiert Werte", [("duplicateProperty", ["db": "tasks", "prop": "points"])]),
        ("Option löschen: Werte, Filter", [("deleteOption", ["db": "tasks", "prop": "kind", "option": "k-bug"])]),
        ("Status-Option löschen: Gruppen", [("deleteOption", ["db": "tasks", "prop": "status", "option": "s-doing"])]),
        ("Multi-Select-Option löschen", [("deleteOption", ["db": "tasks", "prop": "tags", "option": "t-ui"])]),
        ("Relation setzen aktualisiert beide Seiten", [("setRelation", ["row": "task-1", "prop": "project", "targets": ["pr-2", "pr-3"]])]),
        ("Relation leeren", [("setRelation", ["row": "task-2", "prop": "project", "targets": []])]),
        ("ID-Nummern reparieren: doppelte und fehlende", [
            ("setValue", ["row": "task-2", "prop": "uid", "value": ["uniqueID": ["_0": 1]]]),
            ("setValue", ["row": "task-5", "prop": "uid", "value": .null]),
            ("repairUniqueIDs", ["dbs": ["tasks"]]),
        ]),
        ("Option löschen erreicht Zeilen im Papierkorb", [
            ("trash", ["ids": ["task-1", "task-2"]]),
            ("deleteOption", ["db": "tasks", "prop": "kind", "option": "k-feat"]),
        ]),
        ("Typwechsel erreicht Zeilen im Papierkorb", [
            ("trash", ["ids": ["task-3"]]),
            ("changePropertyType", ["db": "tasks", "prop": "points", "type": "text"]),
        ]),
        ("Wiederherstellen lässt unpassende Werte fallen", [
            ("trash", ["ids": ["task-4"]]),
            ("deleteOption", ["db": "tasks", "prop": "status", "option": "s-done"]),
            ("restore", ["ids": ["task-4"]]),
        ]),
        ("Gelöschte Zeile verschwindet aus der Relation der Gegenseite", [("deleteForever", ["ids": ["task-1"]])]),
    ]

    static func str(_ v: JSONValue?) -> String? { if case .string(let s)? = v { return s }; return nil }
    static func strs(_ v: JSONValue?) -> [String] { if case .array(let a)? = v { return a.compactMap { str($0) } }; return [] }

    static func run(_ store: WorkspaceStore, _ step: Step) {
        let a = step.args
        switch step.op {
        case "renameProperty": store.renameProperty(str(a["db"])!, str(a["prop"])!, to: str(a["name"])!)
        case "deleteProperty": store.deleteProperty(str(a["db"])!, str(a["prop"])!)
        case "setRelationTarget": store.setRelationTarget(str(a["db"])!, str(a["prop"])!, to: str(a["target"]))
        case "changePropertyType": store.changePropertyType(str(a["db"])!, str(a["prop"])!, to: PropertyType(rawValue: str(a["type"])!)!)
        case "duplicateProperty": _ = store.duplicateProperty(str(a["db"])!, str(a["prop"])!)
        case "deleteOption": store.deleteOption(str(a["db"])!, str(a["prop"])!, str(a["option"])!)
        case "setRelation": store.setRelation(str(a["row"])!, str(a["prop"])!, strs(a["targets"]))
        case "setValue":
            let v: PropertyValue? = a["value"].flatMap { $0 == .null ? nil : try? JSONDecoder().decode(PropertyValue.self, from: JSONEncoder().encode($0)) }
            store.setValue(str(a["row"])!, str(a["prop"])!, v)
        case "repairUniqueIDs": store.repairUniqueIDs(in: Set(strs(a["dbs"])))
        case "trash": store.trash(strs(a["ids"]))
        case "restore": store.restorePages(strs(a["ids"]))
        case "deleteForever": store.deleteForever(strs(a["ids"]))
        default: fatalError("unknown op \(step.op)")
        }
    }

    /// Alle Zeichenketten (Werte und Schlüssel) eines JSON-Werts.
    static func strings(_ v: JSONValue, into out: inout Set<String>) {
        switch v {
        case .string(let s): out.insert(s)
        case .array(let a): for x in a { strings(x, into: &out) }
        case .object(let o): for (k, x) in o { out.insert(k); strings(x, into: &out) }
        default: break
        }
    }

    static let uuid = try! NSRegularExpression(pattern: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
    static func isNew(_ s: String, _ known: Set<String>) -> Bool {
        !known.contains(s) && uuid.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func normalize(_ v: JSONValue, _ known: Set<String>, top: Bool = false) -> JSONValue {
        switch v {
        case .string(let s): return isNew(s, known) ? "new" : v
        case .array(let a): return .array(a.map { normalize($0, known) })
        case .object(let o):
            var out: [String: JSONValue] = [:]
            for (k, x) in o {
                if top && ["createdAt", "updatedAt", "stamp"].contains(k) { continue }
                if top && k == "trashedAt" { out[k] = "now"; continue }
                out[isNew(k, known) ? "new" : k] = normalize(x, known)
            }
            return .object(out)
        default: return v
        }
    }

    static func snapshot(_ store: WorkspaceStore) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for r in store.allRecords() {
            let line = StoreFixtures.line(r)
            guard case .object(let o) = line, let kind = str(o["kind"]), case .object(let d)? = o["data"], let id = str(d["id"]) else { continue }
            out[kind + ":" + id] = line
        }
        return out
    }

    static func all() -> JSONValue {
        let records = records()
        var known = Set<String>()
        for r in records { strings(StoreFixtures.line(r), into: &known) }
        var cases: [JSONValue] = []
        for (name, steps) in steps {
            let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
            let before = snapshot(store)
            for s in steps { run(store, s) }
            let after = snapshot(store)
            var changed: [(String, JSONValue)] = []
            for key in Set(before.keys).union(after.keys) where before[key] != after[key] {
                let rec: JSONValue
                if let r = after[key], case .object(var o) = r, let data = o["data"] {
                    o["data"] = normalize(data, known, top: true)
                    rec = .object(o)
                } else { rec = .null }
                changed.append((isNew(String(key.split(separator: ":", maxSplits: 1)[1]), known) ? key.split(separator: ":")[0] + ":new" : key, rec))
            }
            func sortKey(_ e: (String, JSONValue)) -> String { e.0 + "\u{1}" + e.1.description }
            changed.sort { sortKey($0) < sortKey($1) }
            let input: JSONValue = .array(steps.map { ["op": .string($0.op), "args": .object($0.args)] })
            cases.append(C.testCase(name, input, .array(changed.map { .array([.string($0.0), $0.1]) })))
        }
        return C.file("dbops", cases, meta: ["records": .array(records.map(StoreFixtures.line)),
                                              "note": "Geänderte Records nach den Schritten: [Schlüssel, Record oder null]; ohne createdAt/updatedAt/stamp, trashedAt = \"now\", neue IDs = \"new\"."])
    }
}
