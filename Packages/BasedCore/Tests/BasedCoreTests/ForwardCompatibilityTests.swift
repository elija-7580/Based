import Foundation
import Testing
@testable import BasedCore

/// BSD-25 / ADR 0002: fields and types written by a newer version survive decoding, editing and encoding here.
@MainActor
@Suite struct ForwardCompatibilityTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fwdcompat-\(UUID().uuidString)")

    static func json(_ data: Data) throws -> JSONValue { try JSONValue.parse(data) }

    /// Re-encodes `data` after `edit` and returns the result as JSON.
    static func object(_ r: Record) throws -> [String: JSONValue] { try json(r.encoded()).object ?? [:] }

    static let futureBlock = """
    {"id":"b1","type":"text","parent":"w","sk":"a0","text":"Old title",
     "props":{"color":"blue","futureProp":[1,2,{"x":true}]},
     "createdAt":0,"updatedAt":0,"stamp":{"millis":5,"counter":0,"node":"z"},
     "futureField":{"a":1},"anotherOne":"kept"}
    """

    @Test func unknownBlockFieldsSurviveAnEdit() throws {
        guard case .block(var b) = try Record.decode(kind: .block, data: Data(Self.futureBlock.utf8)) else { Issue.record(); return }
        #expect(b.extra["futureField"] == ["a": 1])
        #expect(b.extra["anotherOne"] == "kept")
        #expect(b.props.extra["futureProp"] == [1, 2, ["x": true]])
        #expect(b.props.color == .blue)

        b.text = RichText("New title")
        b.props.color = .red
        let out = try Self.object(.block(b))
        #expect(out["futureField"] == ["a": 1])
        #expect(out["anotherOne"] == "kept")
        #expect(out["props"]?["futureProp"] == [1, 2, ["x": true]])
        #expect(out["props"]?["color"] == "red")
        #expect(out["type"] == "text")
        // And back once more: nothing doubles or drifts.
        guard case .block(let again) = try Record.decode(kind: .block, data: try Record.block(b).encoded()) else { Issue.record(); return }
        #expect(again == b)
    }

    @Test func unknownBlockTypeRoundTrips() throws {
        let json = Self.futureBlock.replacingOccurrences(of: "\"type\":\"text\"", with: "\"type\":\"hologram\"")
        guard case .block(let b) = try Record.decode(kind: .block, data: Data(json.utf8)) else { Issue.record(); return }
        #expect(b.type == .unknown)
        #expect(b.extra["type"] == "hologram")
        #expect(!b.type.isTextEditable && !b.type.supportsChildren && !b.type.isPageLike)
        let out = try Self.object(.block(b))
        #expect(out["type"] == "hologram")
        #expect(out["futureField"] == ["a": 1])

        // A known type set later replaces the stale original.
        var known = b
        known.type = .quote
        #expect(try Self.object(.block(known))["type"] == "quote")
    }

    @Test func unknownBlockInStoreIsKeptAndNotTurnedInto() throws {
        let url = dir.appendingPathComponent("w.sqlite")
        var page = "", line = ""
        do {
            let p = try SQLitePersistence(url: url)
            let s = WorkspaceStore(persistence: p, node: "a")
            page = s.createPage(title: "Page")
            line = s.insertBlock(.text, text: "x", in: .block(page), at: .end)
            let raw = String(decoding: try Record.block(s.blocks[line]!).encoded(), as: UTF8.self)
                .replacingOccurrences(of: "\"type\":\"text\"", with: "\"type\":\"hologram\"")
                .replacingOccurrences(of: "\"stamp\":", with: "\"futureField\":{\"a\":1},\"stamp\":")
            try p.writeRawRow(kind: .block, id: line, data: Data(raw.utf8))
        }
        let p = try SQLitePersistence(url: url)
        let s = WorkspaceStore(persistence: p, node: "a")
        #expect(s.frozenKeys.isEmpty)
        #expect(s.blocks[line]?.type == .unknown)
        s.turnInto([line], .heading1)
        #expect(s.blocks[line]?.type == .unknown)
        // Moving it (a local write) keeps the unknown content on disk.
        s.updateBlock(line) { $0.sortKey = "zz" }
        let row = try Self.json(p.rawRow(RecordKey(.block, line))!)
        #expect(row["type"] == "hologram")
        #expect(row["futureField"] == ["a": 1])
        #expect(row["sk"] == "zz")
    }

    @Test func databaseViewWorkspaceKeepUnknownFieldsAndTypes() throws {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "P")
        let created = s.createDatabase(title: "Tasks", in: .block(page), inline: true, viewType: .board, sampleRows: 0)

        // Database with an unknown property type and unknown fields at both levels.
        var dbJSON = try Self.object(.database(s.databases[created.databaseID]!))
        var props = dbJSON["properties"]!.array!
        props.append(["id": "p9", "name": "Hologram", "type": "hologramProp", "hologramConfig": ["depth": 3]])
        dbJSON["properties"] = .array(props)
        dbJSON["futureDB"] = "yes"
        guard case .database(var db) = try Record.decode(kind: .database, data: JSONValue.object(dbJSON).encoded()) else { Issue.record(); return }
        #expect(db.extra["futureDB"] == "yes")
        let p9 = db.property("p9")!
        #expect(p9.type == .unknown)
        #expect(p9.extra["type"] == "hologramProp")
        #expect(p9.extra["hologramConfig"] == ["depth": 3])
        db.title = RichText("Renamed")
        let dbOut = try Self.object(.database(db))
        #expect(dbOut["futureDB"] == "yes")
        let p9Out = dbOut["properties"]!.array!.first { $0["id"] == "p9" }!
        #expect(p9Out["type"] == "hologramProp")
        #expect(p9Out["hologramConfig"] == ["depth": 3])

        // View with an unknown layout.
        var vJSON = try Self.object(.view(s.views[created.viewID]!))
        vJSON["type"] = "spiral"
        vJSON["spiralTurns"] = 7
        guard case .view(var v) = try Record.decode(kind: .view, data: JSONValue.object(vJSON).encoded()) else { Issue.record(); return }
        #expect(v.type == .unknown)
        v.name = "Renamed view"
        let vOut = try Self.object(.view(v))
        #expect(vOut["type"] == "spiral")
        #expect(vOut["spiralTurns"] == 7)
        #expect(vOut["name"] == "Renamed view")

        // Workspace.
        var wJSON = try Self.object(.workspace(s.workspace))
        wJSON["futureSetting"] = ["on": true]
        guard case .workspace(var w) = try Record.decode(kind: .workspace, data: JSONValue.object(wJSON).encoded()) else { Issue.record(); return }
        w.name = "Renamed"
        #expect(try Self.object(.workspace(w))["futureSetting"] == ["on": true])
    }

    /// Data written before BSD-25 reads unchanged and re-encodes to the same JSON (no format change on disk).
    @Test func oldRecordsReadUnchanged() throws {
        let s = WorkspaceStore(persistence: nil, node: "a")
        let page = s.createPage(title: "Plans")
        s.setPageCover(page, .gradient(3))
        _ = s.insertBlock(.todo, text: "Ship it", in: .block(page), at: .end)
        let db = s.createDatabase(title: "Tasks", in: .block(page), inline: true, viewType: .board, sampleRows: 2)
        _ = s.addView(to: db.blockID, type: .table, name: "All")
        // A literal row as v3 wrote it (no catch-all, known type).
        let old = """
        {"id":"o1","type":"callout","parent":"b:\(page)","sk":"a1","text":"Hi","props":{"icon":"💡","color":"grayBackground"},\
        "createdAt":1,"updatedAt":2,"createdBy":"me","stamp":{"millis":3,"counter":1,"node":"a"}}
        """
        let oldRecord = try Record.decode(kind: .block, data: Data(old.utf8))
        guard case .block(let ob) = oldRecord else { Issue.record(); return }
        #expect(ob.extra.isEmpty && ob.props.extra.isEmpty && ob.type == .callout)
        #expect(try Self.json(oldRecord.encoded()) == Self.json(Data(old.utf8)))

        for rec in s.allRecords() + [oldRecord] {
            let data = try rec.encoded()
            let back = try Record.decode(kind: rec.key.kind, data: data)
            #expect(back == rec)
            #expect(try Self.json(back.encoded()) == Self.json(data))
        }
    }

    @Test func archiveRoundTripKeepsUnknownContent() throws {
        let a = WorkspaceStore(persistence: nil, node: "a")
        let page = a.createPage(title: "P")
        let line = a.insertBlock(.text, text: "x", in: .block(page), at: .end)
        a.updateBlock(line) { $0.extra["futureField"] = ["a": 1]; $0.props.extra["futureProp"] = "p" }
        let b = WorkspaceStore(persistence: nil, node: "b")
        let r = try WorkspaceArchive.importArchive(try WorkspaceArchive.write(a), into: b)
        #expect(r.skipped == 0)
        #expect(b.blocks[line]?.extra["futureField"] == ["a": 1])
        #expect(b.blocks[line]?.props.extra["futureProp"] == "p")
    }

    /// The hand-written Codable code must list every stored property, or it silently stops being saved.
    // MARK: BSD-107: nested values

    @Test func unknownPropertyValueKindSurvivesATitleEdit() throws {
        var row = Block(type: .page, parent: .database("db"), sortKey: "a0", text: "Row")
        row.values["n"] = .number(3)
        var obj = try Self.object(.block(row))
        // Known values keep the synthesized form.
        #expect(obj["values"]?["n"] == ["number": ["_0": 3]])
        var values = obj["values"]?.object ?? [:]
        values["p"] = ["hologram": ["depth": 2, "colors": ["red", "blue"]]]
        obj["values"] = .object(values)
        let data = try JSONEncoder().encode(JSONValue.object(obj))
        guard case .block(var b) = try Record.decode(kind: .block, data: data) else { Issue.record(); return }
        #expect(b.values["p"]?.isUnknown == true)
        #expect(b.values["n"] == .number(3))
        #expect(QueryEngine.value(of: b.values["p"], PropertySchema(name: "P", type: .text)) == .empty)

        b.text = RichText("Renamed")
        let out = try Self.object(.block(b))
        #expect(out["values"]?["p"] == ["hologram": ["depth": 2, "colors": ["red", "blue"]]])
        #expect(out["values"]?["n"] == ["number": ["_0": 3]])
    }

    @Test func damagedKnownPropertyValueStillFails() {
        let bad = Data(#"{"number":{"_0":"not a number"}}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(PropertyValue.self, from: bad) }
    }

    @Test func everyKnownPropertyValueRoundTrips() throws {
        let all: [PropertyValue] = [.text("t"), .number(1.5), .select("o"), .multiSelect(["a", "b"]), .status("s"),
                                    .date(DateValue(start: Date(timeIntervalSince1970: 0))), .person(["u"]), .files([]),
                                    .checkbox(true), .url("u"), .email("e"), .phone("p"), .relation(["r"]), .uniqueID(4),
                                    .place("x")]
        for v in all {
            let data = try JSONEncoder().encode(v)
            #expect(try JSONDecoder().decode(PropertyValue.self, from: data) == v)
            #expect(v.isUnknown == false)
        }
    }

    @Test func unknownFilterOperatorAndValueRoundTrip() throws {
        var view = DatabaseView(databaseID: "db", blockID: "blk", name: "V", type: .table, sortKey: "a")
        view.filter = FilterGroup(items: [.condition(FilterCondition(id: "c1", propertyID: "p", op: .equals, value: .text("x"))),
                                          .condition(FilterCondition(id: "c2", propertyID: "p", op: .contains, value: .text("y")))])
        var text = String(decoding: try Record.view(view).encoded(), as: UTF8.self)
        text = text.replacingOccurrences(of: #""op":"equals""#, with: #""op":"isSimilarTo","futureKnob":7"#)
        text = text.replacingOccurrences(of: #"{"text":{"_0":"y"}}"#, with: #"{"vector":[1,2]}"#)
        guard case .view(let decoded) = try Record.decode(kind: .view, data: Data(text.utf8)),
              case .condition(let c1)? = decoded.filter?.items.first,
              case .condition(let c2)? = decoded.filter?.items.last else { Issue.record(); return }
        #expect(c1.op == .unknown)
        #expect(c2.op == .contains)
        #expect(c2.value == nil)
        #expect(!FilterOp.allCases.contains(.unknown))

        // Unknown operators hide nothing.
        let s = WorkspaceStore()
        let db = Database(blockID: "blk", title: "D", properties: [PropertySchema(id: "p", name: "P", type: .checkbox)])
        let row = Block(type: .page, parent: .database(db.id), sortKey: "a")
        #expect(QueryEngine(store: s).matches(row, c1, db))

        let out = String(decoding: try Record.view(decoded).encoded(), as: UTF8.self)
        #expect(out.contains(#""op":"isSimilarTo""#))
        #expect(out.contains(#""futureKnob":7"#))
        #expect(out.contains(#""vector":[1,2]"#))
        guard case .view(let again) = try Record.decode(kind: .view, data: Data(out.utf8)) else { Issue.record(); return }
        #expect(again == decoded)
    }

    @Test func everyStoredPropertyHasACodingKey() {
        func labels(_ v: Any) -> Set<String> { Set(Mirror(reflecting: v).children.compactMap(\.label)).subtracting(["extra"]) }
        #expect(labels(BlockProps()) == BlockProps.knownKeys)
        #expect(labels(PropertySchema(name: "n", type: .text)) == PropertySchema.knownKeys)
        #expect(labels(Database(blockID: "b", title: RichText(), properties: [])) == Database.knownKeys)
        #expect(labels(DatabaseView(databaseID: "d", blockID: "b", name: "v", type: .table, sortKey: "a")) == DatabaseView.knownKeys)
        #expect(labels(Workspace()) == Workspace.knownKeys)
        let blockLabels = labels(Block(type: .text, parent: .workspace, sortKey: "a"))
            .subtracting(["_props", "sortKey"]).union(["props", "sk"])
        #expect(blockLabels == Block.knownKeys)
    }
}
