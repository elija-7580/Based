import Foundation

/// BSD-73 (ADR 0011): Versionsverlauf (Store/VersionHistory.swift) für den TS-Port – Kodierung und Hash der Blöcke,
/// Manifeste und Dedup beim Aufzeichnen, `versionBlocks`, Ausdünnen und Aufräumen, Wiederherstellen samt Undo.
/// Beim Wiederherstellen nur Fälle, in denen der TS-Port bewusst gleich bleibt (keine Blöcke, die inzwischen auf
/// einer anderen Seite stehen; keine Inline-Datenbanken).
@MainActor
public enum HistoryFixtures {
    typealias C = CoreFixtures
    typealias S = StoreFixtures
    static let t0 = Date(timeIntervalSinceReferenceDate: 784_000_000)

    static func block(_ id: String, _ type: BlockType, _ text: RichText, parent: ParentRef, sk: String,
                      _ edit: (inout Block) -> Void = { _ in }) -> Block {
        var b = Block(id: id, type: type, parent: parent, sortKey: sk, text: text, createdAt: t0)
        b.updatedAt = t0; b.stamp = Stamp(millis: 1_000, counter: 0, node: "fx"); edit(&b); return b
    }

    static func workspace() -> Workspace {
        var ws = Workspace(); ws.createdAt = t0; ws.updatedAt = t0; ws.stamp = Stamp(millis: 1, counter: 0, node: "fx")
        return ws
    }

    static func baseBlocks() -> [Block] {
        [
            block("page", .page, "Notizen", parent: .workspace, sk: "a0") { $0.props.icon = .emoji("📓") },
            block("h", .heading1, "Überschrift", parent: .block("page"), sk: "a0"),
            block("p1", .text, RichText(runs: [TextRun("Erster Absatz mit "), TextRun("Link", marks: Marks(link: "https://example.com/a/b"))]),
                  parent: .block("page"), sk: "a1"),
            block("tg", .toggle, "Mehr", parent: .block("page"), sk: "a2"),
            block("tg1", .text, "im Toggle", parent: .block("tg"), sk: "a0"),
            block("sub", .page, "Unterseite", parent: .block("tg"), sk: "a1"),
            block("subc", .text, "in der Unterseite", parent: .block("sub"), sk: "a0"),
            block("td", .todo, "Aufgabe  mit   Leerraum", parent: .block("page"), sk: "a3") { $0.props.checked = true },
            block("tr", .text, "im Papierkorb", parent: .block("page"), sk: "a4") { $0.trashedAt = t0 },
            block("eq", .equation, "", parent: .block("page"), sk: "a5") { $0.props.expression = "\\frac{a}{b}" },
        ]
    }

    static func baseRecords() -> [Record] { [.workspace(workspace())] + baseBlocks().map { .block($0) } }

    static func blockJSON(_ b: Block) -> JSONValue { C.json(b) }

    static func versionJSON(_ v: VersionHistory.Version?) -> JSONValue {
        guard let v else { return .null }
        return ["id": .number(Double(v.id)), "at": .number(v.date.timeIntervalSince1970), "manifest": .string(v.manifest),
                "title": .string(v.title), "blockCount": .number(Double(v.blockCount)), "wordCount": .number(Double(v.wordCount)),
                "reason": .string(v.reason)]
    }

    static func statsJSON(_ s: VersionHistory.Stats) -> JSONValue {
        ["versions": .number(Double(s.versions)), "objects": .number(Double(s.objects)), "bytes": .number(Double(s.bytes))]
    }

    /// Alle Blöcke des Stores, ohne Zeiten und Stempel.
    static func summary(_ store: WorkspaceStore) -> JSONValue {
        var o: [String: JSONValue] = [:]
        for b in store.blocks.values {
            var e: [String: JSONValue] = ["type": .string(b.type.rawValue), "parent": .string(b.parent.key), "sk": .string(b.sortKey),
                                          "text": .string(b.text.plainText), "trashed": .bool(b.trashedAt != nil)]
            if let c = b.props.checked { e["checked"] = .bool(c) }
            o[b.id] = .object(e)
        }
        return .object(o)
    }

    public static func all() -> JSONValue {
        var cases: [JSONValue] = []

        // Kodierung und Hash einzelner Blöcke (byte-genau, `/` maskiert wie JSONEncoder ohne .withoutEscapingSlashes).
        var special = baseBlocks()
        special.append(block("x", .text, "Tab\tNeu\nZeile \u{1} Steuer / Schräg \"Zitat\" \\ Ä 🚀 \u{2028}", parent: .block("page"), sk: "a9") {
            $0.createdAt = t0.addingTimeInterval(0.25); $0.createdBy = "user-1"; $0.updatedBy = "user-1"
        })
        special.append(Block(id: "leer", type: .text, parent: .block("page"), sortKey: "b0", createdAt: t0))
        cases.append(C.testCase("Blöcke kodieren und hashen", ["op": "encode", "blocks": .array(special.map(blockJSON))],
                                .array(special.map { b in
                                    let d = VersionHistory.encode(b)!
                                    return ["json": .string(String(decoding: d, as: UTF8.self)), "hash": .string(VersionHistory.hash(d))]
                                })))
        let texts = ["", "a", "page\tabc", String(repeating: "Based ", count: 300), "ÄÖÜ🚀"]
        cases.append(C.testCase("Hash von Bytes", ["op": "hash", "texts": .array(texts.map(JSONValue.string))],
                                .array(texts.map { .string(VersionHistory.hash(Data($0.utf8))) })))

        // versionBlocks auf `records` (Metadaten): Unterseite als eigener Block, ihr Inhalt nicht; Papierkorb fehlt.
        do {
            let store = WorkspaceStore(persistence: MemoryPersistence(baseRecords()), node: "local")
            for page in ["page", "sub", "fehlt"] {
                cases.append(C.testCase("versionBlocks \(page)", ["op": "versionBlocks", "pageID": .string(page)],
                                        .array(store.versionBlocks(of: page).map { .string($0.id) })))
            }
        }

        // Aufzeichnen: Dedup (gleiches Manifest wie die letzte Version = keine neue), Zählwerte, Lesen.
        do {
            let history = try! VersionHistory(url: nil)
            var steps: [[Block]] = []
            let base = WorkspaceStore(persistence: MemoryPersistence(baseRecords()), node: "local").versionBlocks(of: "page")
            steps.append(base)
            steps.append(base)
            var changed = base
            changed[2].text = "Erster Absatz, geändert"; changed[2].updatedAt = t0.addingTimeInterval(60)
            steps.append(changed)
            var added = changed
            added.append(block("neu", .bulletedList, "neuer Punkt eins zwei", parent: .block("page"), sk: "a6"))
            steps.append(added)
            steps.append(base)
            steps.append(base)
            var stepsIn: [JSONValue] = [], stepsOut: [JSONValue] = []
            for (i, blocks) in steps.enumerated() {
                let at = Date(timeIntervalSince1970: 1_800_000_000 + Double(i) * 60)
                let reason = i == 0 ? "opened" : "edit"
                let v = history.record(page: "page", blocks: blocks, title: "Notizen", reason: reason, at: at)
                stepsIn.append(["blocks": .array(blocks.map(blockJSON)), "title": "Notizen", "reason": .string(reason),
                                "at": .number(at.timeIntervalSince1970)])
                var out: [String: JSONValue] = ["version": versionJSON(v), "stats": statsJSON(history.stats())]
                if let v { out["read"] = .array(history.blocks(of: v).map(blockJSON)) }
                stepsOut.append(.object(out))
            }
            let list = history.versions(of: "page").map(versionJSON)
            cases.append(C.testCase("Aufzeichnen mit Dedup", ["op": "record", "steps": .array(stepsIn)],
                                    ["steps": .array(stepsOut), "versions": .array(list)]))
        }

        // Ausdünnen und Aufräumen.
        do {
            let history = try! VersionHistory(url: nil)
            let now = Date(timeIntervalSince1970: 1_800_000_000)
            let ages: [(String, Double)] = [("A", 0.5), ("A", 2), ("A", 25), ("A", 25.5), ("A", 30), ("A", 72), ("A", 73), ("A", 192),
                                            ("A", 194), ("A", 480), ("A", 2400), ("A", 2424), ("A", 2880), ("B", 26), ("B", 26.2)]
            var stepsIn: [JSONValue] = []
            for (i, (page, hours)) in ages.enumerated() {
                let blocks = [block(page, .page, RichText(page), parent: .workspace, sk: "a0"),
                              block(page + "-t", .text, RichText("Fassung \(i % 9)"), parent: .block(page), sk: "a0") {
                                  $0.updatedAt = t0.addingTimeInterval(Double(i))  // Swift cacht Hashes pro updatedAt
                              }]
                let at = now.addingTimeInterval(-hours * 3600)
                history.record(page: page, blocks: blocks, title: page, at: at)
                stepsIn.append(["pageID": .string(page), "at": .number(at.timeIntervalSince1970), "blocks": .array(blocks.map(blockJSON))])
            }
            let removed = history.prune(now: now)
            let garbage = history.collectGarbage()
            let remaining: [JSONValue] = ["A", "B"].flatMap { p in history.versions(of: p).map { v in
                ["pageID": .string(p), "at": .number(v.date.timeIntervalSince1970)] as JSONValue } }
            cases.append(C.testCase("Ausdünnen und Aufräumen", ["op": "prune", "now": .number(now.timeIntervalSince1970), "steps": .array(stepsIn)],
                                    ["removed": .number(Double(removed)), "garbage": .number(Double(garbage)),
                                     "remaining": .array(remaining), "stats": statsJSON(history.stats())]))
        }

        // Wiederherstellen (ein Undo-Schritt) und Undo.
        // Änderungen direkt an den Records (der Store stempelt `updatedAt` mit der echten Uhr).
        typealias Blocks = [RecordID: Block]
        let scenarios: [(String, (inout Blocks) -> Void)] = [
            ("Text und Häkchen geändert", { d in
                d["p1"]!.text = "geändert"
                d["td"]!.props.checked = false
            }),
            ("Blöcke gelöscht", { d in d["tg1"] = nil; d["h"] = nil }),
            ("Blöcke hinzugefügt", { d in
                d["neu"] = block("neu", .text, "neu", parent: .block("page"), sk: "a9")
                d["neu1"] = block("neu1", .text, "darin", parent: .block("neu"), sk: "a0")
            }),
            ("innerhalb der Seite verschoben", { d in
                d["tg1"]!.parent = .block("page"); d["tg1"]!.sortKey = "a6"
                d["td"]!.parent = .block("tg"); d["td"]!.sortKey = "a5"
            }),
            ("Unterseite in neuem Block rückt nach oben", { d in
                d["nt"] = block("nt", .toggle, "neuer Toggle", parent: .block("page"), sk: "a8")
                d["np"] = block("np", .page, "neue Unterseite", parent: .block("nt"), sk: "a0")
                d["sub"]!.parent = .block("page"); d["sub"]!.sortKey = "a7"
            }),
            ("Block im Papierkorb kommt zurück", { d in d["td"]!.trashedAt = t0 }),
            ("Seitentitel und Icon", { d in d["page"]!.text = "Neuer Titel"; d["page"]!.props.icon = nil }),
        ]
        let version = WorkspaceStore(persistence: MemoryPersistence(baseRecords()), node: "local").versionBlocks(of: "page")
        for (name, modify) in scenarios {
            var d = Dictionary(uniqueKeysWithValues: baseBlocks().map { ($0.id, $0) })
            modify(&d)
            let blocks = d.values.sorted { $0.id < $1.id }
            let records: [Record] = [.workspace(workspace())] + blocks.map { .block($0) }
            let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "local")
            store.clock.wallClock = { 2_000 }
            store.restoreVersion(of: "page", blocks: version)
            let after = summary(store)
            let undo = store.undo()
            cases.append(C.testCase("Wiederherstellen: \(name)", ["op": "restore", "records": .array(records.map(S.line)), "version": .array(version.map(blockJSON))],
                                    ["after": after, "undo": summary(store), "undoName": undo.name.map(JSONValue.string) ?? .null]))
        }

        return C.file("history", cases, meta: ["records": .array(baseRecords().map(S.line)), "note": "Zeiten der Versionen in Unix-Sekunden (Spalte `at`); Objekte roh gespeichert (Linux), daher `bytes` = 1 + Länge."])
    }
}
