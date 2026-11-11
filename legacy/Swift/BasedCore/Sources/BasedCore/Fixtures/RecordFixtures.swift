import Foundation

/// BSD-148/149 (ADR 0011): Golden Fixtures für den TypeScript-Stack. Alles hier ist deterministisch
/// (feste IDs, feste Zeiten, sortierte Schlüssel), damit zwei Läufe identische Dateien schreiben.
/// Der TS-Kern prüft damit: Records parsen und serialisieren byte-gleich, Schema-Schlüssel und
/// Enum-Werte stimmen mit Swift überein.
public enum RecordFixtures {
    /// Encoder wie für die Fixture-Dateien: sortierte Schlüssel, `/` unmaskiert (sonst wie `Record.encoder`).
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// Ein Record als eine JSONL-Zeile `{"data":{…},"kind":"block"}`, Bytes so, wie Swift sie schreibt.
    public static func line(_ record: Record) throws -> String {
        let e = encoder()
        let data: Data
        switch record {
        case .block(let b): data = try e.encode(b)
        case .database(let d): data = try e.encode(d)
        case .view(let v): data = try e.encode(v)
        case .workspace(let w): data = try e.encode(w)
        }
        return "{\"data\":" + String(decoding: data, as: UTF8.self) + ",\"kind\":\"" + record.key.kind.rawValue + "\"}"
    }

    /// Stichprobe, die jedes Feld, jeden Blocktyp, jeden Property- und View-Typ und die
    /// Vorwärtskompatibilität (unbekannte Felder, Typen und Fälle) mindestens einmal abdeckt.
    public static func corpus() throws -> [Record] {
        var out: [Record] = []
        let t0 = Date(timeIntervalSinceReferenceDate: 784_000_000.25)
        let t1 = Date(timeIntervalSinceReferenceDate: 784_003_600.5)
        var n = 0
        func id(_ p: String) -> RecordID { n += 1; return String(format: "%@-%04d-0000-4000-8000-000000000000", p, n) }
        func stamp(_ i: Int) -> Stamp { Stamp(millis: 1_793_974_300_000 + Int64(i), counter: UInt32(i % 7), node: "3c8ed7c0") }

        // Workspace
        var ws = Workspace(id: Workspace.mainID, name: "Elijas Workspace / Test \"Ä\" 🚀")
        ws.icon = .emoji("🧠"); ws.favorites = ["p-root"]; ws.homePageID = "p-root"
        ws.teamspaces = [Teamspace(id: "team-1", name: "Team", icon: .symbol("person.2"), createdAt: t0)]
        ws.createdAt = t0; ws.updatedAt = t1; ws.stamp = stamp(1)
        out.append(.workspace(ws))

        // Rich text in allen Formen
        let rich = RichText(runs: [
            TextRun("fett ", marks: Marks(bold: true)),
            TextRun("kursiv+farbig ", marks: Marks(italic: true, underline: true, strikethrough: true, code: true, color: .redBackground, link: "https://example.com/a?b=c")),
            TextRun("Seite", mention: .page("p-root")),
            TextRun("Datum", mention: .date(DateValue(start: t0, end: t1, includeTime: true, remind: true))),
            TextRun("Elija", mention: .user("user-1")),
            TextRun("Link", mention: .link("https://friedrich-ulrich.com")),
            TextRun("x", equation: "e^{i\\pi}+1=0"),
            TextRun(" Ende \n\t\u{1F} <tag> & ' \" \\"),
        ])

        // Wurzelseite mit allen Icon/Cover/Format-Varianten verteilt auf mehrere Seiten
        func page(_ bid: RecordID, _ parent: ParentRef, _ sk: String, _ title: RichText, _ edit: (inout BlockProps) -> Void) -> Block {
            var p = BlockProps(); edit(&p)
            var b = Block(id: bid, type: .page, parent: parent, sortKey: sk, text: title, props: p, createdAt: t0, createdBy: "user-1")
            b.updatedAt = t1; b.stamp = stamp(n); b.updatedBy = "user-2"
            return b
        }
        out.append(.block(page("p-root", .workspace, "a0", "Startseite") {
            $0.icon = .emoji("🏠"); $0.cover = .gradient(3)
            $0.format = PageFormat(font: .serif, smallText: true, fullWidth: false, locked: true)
            $0.format?.coverPosition = 0.35; $0.format?.hideBacklinks = true; $0.format?.hideOutline = false
            $0.teamspace = "team-1"
        }))
        out.append(.block(page("p-asset", .block("p-root"), "a0", rich) {
            $0.icon = .asset(AssetRef(id: "asset-1", name: "icon.png", size: 2048, mime: "image/png"))
            $0.cover = .asset(AssetRef(id: "asset-2", name: "cover.jpg"))
        }))
        out.append(.block(page("p-url", .block("p-root"), "a1", "URL-Icon") {
            $0.icon = .url("https://example.com/i.png"); $0.cover = .url("https://example.com/c.jpg")
            $0.isTemplate = true
        }))
        out.append(.block(page("p-symbol", .block("p-root"), "a2", "") {
            $0.icon = .symbol("star.fill"); $0.cover = .color(.blue)
            $0.format = PageFormat(font: .mono)
        }))
        var trashed = page("p-trash", .workspace, "a1", "Im Papierkorb") { _ in }
        trashed.trashedAt = t1
        out.append(.block(trashed))

        // Ein Block pro Typ
        func block(_ type: BlockType, _ text: RichText = RichText(), _ edit: (inout BlockProps) -> Void = { _ in }) -> Block {
            var p = BlockProps(); edit(&p)
            let bid = id("b" + String(type.rawValue.prefix(3)))
            var b = Block(id: bid, type: type, parent: .block("p-root"), sortKey: "a" + String(n), text: text, props: p, createdAt: t0)
            b.updatedAt = t1; b.stamp = stamp(n)
            return b
        }
        out.append(.block(block(.text, "Einfacher Text")))
        out.append(.block(block(.text, rich) { $0.color = .gray }))
        for h in [BlockType.heading1, .heading2, .heading3, .heading4] { out.append(.block(block(h, "Überschrift") { $0.toggleable = h == .heading2; $0.isOpen = false })) }
        out.append(.block(block(.bulletedList, "Punkt")))
        out.append(.block(block(.numberedList, "Nummer")))
        out.append(.block(block(.todo, "Aufgabe") { $0.checked = true }))
        out.append(.block(block(.todo, "Offen") { $0.checked = false }))
        out.append(.block(block(.toggle, "Toggle") { $0.isOpen = true }))
        out.append(.block(block(.quote, "Zitat") { $0.color = .unknown("magentaBackground") }))
        out.append(.block(block(.callout, "Hinweis") { $0.icon = .emoji("💡"); $0.color = .yellowBackground }))
        out.append(.block(block(.divider)))
        out.append(.block(block(.code, "let x = 1\nprint(\"/pfad\")") { $0.language = "swift"; $0.wrap = true; $0.caption = "Beispiel" }))
        out.append(.block(block(.equation) { $0.expression = "\\int_0^1 x^2\\,dx" }))
        out.append(.block(block(.image) { $0.asset = AssetRef(id: "asset-3", name: "bild.heic", size: 123_456, mime: "image/heic"); $0.width = 0.75; $0.caption = rich }))
        out.append(.block(block(.video) { $0.url = "https://youtube.com/watch?v=x"; $0.ratio = 1.7777777777777777 }))
        out.append(.block(block(.audio) { $0.asset = AssetRef(id: "asset-4", name: "ton.m4a") }))
        out.append(.block(block(.file) { $0.asset = AssetRef(id: "asset-5", name: "datei.zip", size: 0) }))
        out.append(.block(block(.pdf) { $0.url = "https://example.com/doc.pdf" }))
        out.append(.block(block(.bookmark) { $0.url = "https://example.com"; $0.bookmark = BookmarkMeta(title: "Titel", summary: "Kurz", imageURL: "https://example.com/og.png", iconURL: "https://example.com/fav.ico") }))
        out.append(.block(block(.embed) { $0.url = "https://figma.com/x"; $0.ratio = 0.5 }))
        out.append(.block(block(.tableOfContents) { $0.color = .blue }))
        out.append(.block(block(.breadcrumb)))
        out.append(.block(block(.columnList)))
        out.append(.block(block(.column) { $0.ratio = 0.333 }))
        out.append(.block(block(.table) {
            $0.tableColumns = 3; $0.tableHeaderRow = true; $0.tableHeaderColumn = false
            $0.tableColumnWidths = [120, 80.5, 200]; $0.tableColumnColors = [nil, .green, nil]
        }))
        out.append(.block(block(.tableRow) { $0.cells = ["a", rich, ""]; $0.cellColors = [.redBackground, nil, nil] }))
        out.append(.block(block(.databaseInline) { $0.databaseID = "db-1"; $0.viewIDs = ["v-table", "v-board"] }))
        out.append(.block(block(.databasePage, "Aufgaben") { $0.databaseID = "db-1"; $0.icon = .emoji("✅") }))
        out.append(.block(block(.linkToPage) { $0.linkTarget = "p-asset" }))
        out.append(.block(block(.syncedBlock) { $0.syncSource = "p-url" }))
        out.append(.block(block(.button) {
            $0.buttonLabel = "Neue Aufgabe"
            $0.buttonAction = ButtonAction(kind: .addPage, targetID: "db-1", openAfter: true,
                                           values: ["status": .status("opt-s1"), "prio": .number(2.5)], title: "Neu", mode: .centerPeek)
            $0.buttonActions = [
                ButtonAction(kind: .insertBlocks, targetID: "p-url", step: 1),
                ButtonAction(kind: .openURL, url: "https://example.com"),
                ButtonAction(kind: .confirm, message: "Sicher?"),
                ButtonAction(kind: .unknown("sendMail")),
            ]
        }))
        var info = MeetingInfo(status: .done)
        info.startedAt = t0; info.endedAt = t1; info.duration = 3600.25
        info.tracks = [MeetingTrack(role: .microphone, asset: AssetRef(id: "asset-6", name: "mic.m4a"), offset: 0.5, duration: 3599)]
        info.speakers = [MeetingSpeaker(id: "me", name: "Elija", isMe: true, color: .blue), MeetingSpeaker(id: "s2", name: "Gast")]
        info.context = [MeetingContextItem(id: "ctx-1", kind: .page, pageID: "p-root", title: "Kontext"),
                        MeetingContextItem(id: "ctx-2", kind: .text, text: "Agenda")]
        info.attendees = ["Elija", "Gast"]; info.vocabulary = ["Based", "Yjs"]; info.language = "de"; info.engine = "whisper"
        info.summary = .done; info.summaryEngine = "claude"; info.summaryInstructions = "kurz"; info.consentNotice = true; info.error = nil
        out.append(.block(block(.meeting, "Meeting") { $0.meeting = info }))
        out.append(.block(block(.meetingSection) { $0.meetingSection = .summary }))
        out.append(.block(block(.meetingSection) { $0.meetingSection = .unknown("actionItems") }))
        out.append(.block(block(.transcript) {
            $0.segments = [TranscriptSegment(id: "seg-1", start: 0, end: 4.25, speaker: "me", track: .microphone, text: "Hallo"),
                           TranscriptSegment(id: "seg-2", start: 4.25, end: 9, text: "…", partial: true)]
            $0.meetingTime = 12.5
        }))

        // Datenbank mit jedem Property-Typ
        func prop(_ pid: String, _ name: String, _ type: PropertyType, _ edit: (inout PropertySchema) -> Void = { _ in }) -> PropertySchema {
            var p = PropertySchema(id: pid, name: name, type: type); edit(&p); return p
        }
        let statusProp = prop("status", "Status", .status) {
            $0.options = [SelectOption(id: "opt-s1", name: "Offen", color: .default), SelectOption(id: "opt-s2", name: "Fertig", color: .green)]
            $0.statusGroups = [StatusGroup(id: "g1", name: "To-do", color: .gray, optionIDs: ["opt-s1"]),
                               StatusGroup(id: "g2", name: "Complete", color: .green, optionIDs: ["opt-s2"])]
        }
        var db = Database(id: "db-1", blockID: id("bdbp"), title: rich, properties: [
            prop("title", "Name", .title),
            prop("text", "Notiz", .text) { $0.description = "Freitext" },
            prop("prio", "Priorität", .number) { $0.numberFormat = .euro },
            prop("pct", "Anteil", .number) { $0.numberFormat = .unknown("permille") },
            prop("tag", "Tag", .select) { $0.options = [SelectOption(id: "opt-1", name: "A", color: .purple)] },
            prop("tags", "Tags", .multiSelect) { $0.options = [SelectOption(id: "opt-2", name: "B", color: .unknown("teal"))] },
            statusProp,
            prop("due", "Fällig", .date) { $0.dateFormat = "dd.MM.yyyy" },
            prop("who", "Person", .person),
            prop("files", "Dateien", .files),
            prop("done", "Erledigt", .checkbox),
            prop("url", "URL", .url), prop("mail", "Mail", .email), prop("tel", "Telefon", .phone),
            prop("f", "Formel", .formula) { $0.formula = "prop(\"prio\") * 2 + if(prop(\"done\"), 1, 0)" },
            prop("rel", "Relation", .relation) { $0.relation = RelationConfig(databaseID: "db-1", syncedPropertyID: "rel2", limitOne: true) },
            prop("rel2", "Relation zurück", .relation) { $0.relation = RelationConfig(databaseID: "db-1") },
            prop("roll", "Rollup", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "rel", targetPropertyID: "prio", function: .sum) },
            prop("roll2", "Rollup 2", .rollup) { $0.rollup = RollupConfig(relationPropertyID: "rel", targetPropertyID: "prio", function: .unknown("geomean")) },
            prop("ct", "Erstellt", .createdTime), prop("cb", "Von", .createdBy),
            prop("lt", "Geändert", .lastEditedTime), prop("lb", "Geändert von", .lastEditedBy),
            prop("btn", "Knopf", .button), prop("uid", "ID", .uniqueID) { $0.idPrefix = "BSD" },
            prop("place", "Ort", .place), prop("ver", "Verifiziert", .verification),
        ])
        db.summary = "Alle Aufgaben"; db.templateIDs = ["p-url"]; db.defaultTemplateID = "p-url"; db.nextUniqueID = 168; db.locked = false
        db.createdAt = t0; db.updatedAt = t1; db.stamp = stamp(500)
        out.append(.database(db))

        // Zeilen mit jedem PropertyValue
        var row = Block(id: "row-1", type: .page, parent: .database("db-1"), sortKey: "a0", text: "Zeile 1", values: [
            "text": .text(rich), "prio": .number(-3.75), "tag": .select("opt-1"), "tags": .multiSelect(["opt-2", "opt-x"]),
            "status": .status("opt-s2"), "due": .date(DateValue(start: t0)), "who": .person(["user-1", "user-2"]),
            "files": .files([FileValue(name: "a.pdf", asset: AssetRef(id: "asset-7", name: "a.pdf", size: 10, mime: "application/pdf")),
                             FileValue(name: "Link", url: "https://example.com/f")]),
            "done": .checkbox(true), "url": .url("https://example.com/x?y=1&z=2"), "mail": .email("a@b.c"), "tel": .phone("+43 1 234"),
            "rel": .relation(["row-2"]), "rel2": .relation([]), "uid": .uniqueID(42), "place": .place("{\"name\":\"Wien\",\"lat\":48.2}"),
        ], createdAt: t0, createdBy: "user-1")
        row.updatedAt = t1; row.stamp = stamp(600); row.props.icon = .emoji("📌")
        out.append(.block(row))
        var row2 = Block(id: "row-2", type: .page, parent: .database("db-1"), sortKey: "a1", text: "", values: ["prio": .number(1e15), "done": .checkbox(false)], createdAt: t0)
        row2.updatedAt = t0; row2.stamp = stamp(601)
        out.append(.block(row2))

        // Views: jeder Typ, Filter in allen Formen
        func view(_ vid: RecordID, _ type: ViewType, _ sk: String, _ edit: (inout DatabaseView) -> Void = { _ in }) -> DatabaseView {
            var v = DatabaseView(id: vid, databaseID: "db-1", blockID: db.blockID, name: "Ansicht " + type.rawValue, type: type, sortKey: sk)
            v.createdAt = t0; v.updatedAt = t1; v.stamp = stamp(700 + sk.count); edit(&v); return v
        }
        out.append(.view(view("v-table", .table, "a0") {
            $0.filter = FilterGroup(combinator: .and, items: [
                .condition(FilterCondition(id: "fc1", propertyID: "text", op: .contains, value: .text("x"))),
                .condition(FilterCondition(id: "fc2", propertyID: "prio", op: .greaterOrEqual, value: .number(2))),
                .condition(FilterCondition(id: "fc3", propertyID: "done", op: .equals, value: .bool(true))),
                .condition(FilterCondition(id: "fc4", propertyID: "due", op: .onOrAfter, value: .date(t0))),
                .condition(FilterCondition(id: "fc5", propertyID: "due", op: .within, value: .relative(.nextWeek))),
                .condition(FilterCondition(id: "fc6", propertyID: "tags", op: .contains, value: .options(["opt-2"]))),
                .condition(FilterCondition(id: "fc7", propertyID: "url", op: .isEmpty)),
                .group(FilterGroup(combinator: .or, items: [
                    .condition(FilterCondition(id: "fc8", propertyID: "tag", op: .notEquals, value: .options(["opt-1"]))),
                ])),
            ])
            $0.sorts = [SortRule(propertyID: "prio", ascending: false), SortRule(propertyID: "title")]
            $0.properties = [ViewProperty(id: "title", width: 280), ViewProperty(id: "prio", visible: false)]
            $0.calculations = ["prio": .sum, "done": .percentChecked, "title": .countAll, "tags": .unknown("countDistinctTags")]
            $0.wrapCells = true; $0.openIn = .sidePeek; $0.showIcons = true; $0.loadLimit = 50
        }))
        out.append(.view(view("v-board", .board, "a1") {
            var g = GroupRule(propertyID: "status"); g.hiddenGroups = ["opt-s2"]; g.hideEmptyGroups = true; g.groupOrder = ["opt-s1", "opt-s2"]
            $0.groupBy = g; $0.cardCover = .pageCover; $0.cardSize = .large; $0.openIn = .unknown("popover")
        }))
        out.append(.view(view("v-list", .list, "a2") { $0.cardCover = CardCover.none }))
        out.append(.view(view("v-gallery", .gallery, "a3") { $0.cardCover = .property("files"); $0.cardSize = .small }))
        out.append(.view(view("v-gallery2", .gallery, "a4") { $0.cardCover = .pageContent }))
        out.append(.view(view("v-gallery3", .gallery, "a5") { $0.cardCover = .pageIcon; $0.cardSize = .medium }))
        out.append(.view(view("v-cal", .calendar, "a6") {
            $0.datePropertyID = "due"; var g = GroupRule(propertyID: "due"); g.dateGrouping = .week; $0.groupBy = g
        }))
        out.append(.view(view("v-time", .timeline, "a7") { $0.datePropertyID = "ct"; $0.endDatePropertyID = "due" }))
        out.append(.view(view("v-chart", .chart, "a8") {
            var c = ChartConfig(kind: .donut, xPropertyID: "status", yPropertyID: "prio", aggregate: .median, dateBucket: .quarter,
                                showLegend: false, showValues: true, sortByValue: true, limit: 10)
            c.caption = "Verteilung"; c.colorTheme = "warm"; c.height = "large"
            $0.chart = c; $0.widgetOf = "v-dash"
        }))
        out.append(.view(view("v-chart2", .chart, "a9") { $0.chart = ChartConfig(kind: .unknown("radar"), aggregate: .unknown("p90"), dateBucket: .unknown("decade")) }))
        out.append(.view(view("v-feed", .feed, "b0")))
        out.append(.view(view("v-map", .map, "b1") { $0.mapPropertyID = "place"; $0.mapHeight = "medium" }))
        out.append(.view(view("v-form", .form, "b2")))
        out.append(.view(view("v-dash", .dashboard, "b3") {
            $0.dashboard = DashboardConfig(rows: [
                DashboardConfig.Row(id: "r1", widgets: [DashboardConfig.Widget(id: "w1", viewID: "v-chart", width: 8),
                                                        DashboardConfig.Widget(id: "w2", viewID: "v-table", width: 4)], height: 320),
                DashboardConfig.Row(id: "r2", widgets: [DashboardConfig.Widget(id: "w3", viewID: "v-board")]),
            ])
        }))

        // Vorwärtskompatibilität: so, wie eine neuere Version sie schreiben würde (über Swift dekodiert und neu kodiert).
        for (kind, json) in futureRecords {
            out.append(try Record.decode(kind: kind, data: Data(json.utf8)))
        }
        return out
    }

    /// Records einer neueren Version: unbekannte Felder, Block-/Property-/View-Typen und Enum-Fälle.
    static let futureRecords: [(RecordKind, String)] = [
        (.block, #"{"id":"fut-1","type":"kanbanCard","parent":"b:p-root","sk":"z0","text":"Neu","props":{"color":"blue","glow":true,"nested":{"a":[1,2.5,null,"x"]}},"createdAt":784000000,"updatedAt":784000001.5,"stamp":{"millis":1793974309999,"counter":3,"node":"ffff0000"},"aiSummary":"neu","version":7}"#),
        (.block, #"{"id":"fut-2","type":"page","parent":"d:db-1","sk":"a2","values":{"rating":{"stars":{"_0":4}},"prio":{"number":{"_0":3}}},"createdAt":784000000,"updatedAt":784000000,"stamp":{"millis":1793974310000,"counter":0,"node":"ffff0000"}}"#),
        (.database, #"{"id":"db-fut","blockID":"fut-blk","title":"Zukunft","properties":[{"id":"title","name":"Name","type":"title"},{"id":"vote","name":"Abstimmung","type":"poll","choices":3}],"createdAt":784000000,"updatedAt":784000000,"stamp":{"millis":1,"counter":0,"node":"a"},"aiAutofill":{"enabled":true}}"#),
        (.view, #"{"id":"v-fut","databaseID":"db-fut","blockID":"fut-blk","name":"Neu","type":"whiteboard","filter":{"combinator":"xor","items":[{"condition":{"_0":{"id":"c1","propertyID":"vote","op":"isTopVoted","value":{"vote":{"_0":1}},"hint":"neu"}}},{"aiFilter":{"prompt":"nur wichtige"}}],"mode":"strict"},"sorts":[{"propertyID":"title","ascending":true,"nulls":"last"}],"cardCover":{"aiImage":{}},"sortKey":"c0","createdAt":784000000,"updatedAt":784000000,"stamp":{"millis":2,"counter":1,"node":"b"},"chart":{"kind":"bar","aggregate":"count","dateBucket":"month","showLegend":true,"showValues":false,"sortByValue":false,"stacked":true},"dashboard":{"rows":[{"id":"r","widgets":[{"id":"w","viewID":"v-fut","width":12,"pinned":true}],"collapsed":false}],"theme":"dark"}}"#),
        (.workspace, #"{"id":"workspace-2","name":"Zweiter","favorites":[],"createdAt":784000000,"updatedAt":784000000,"stamp":{"millis":3,"counter":2,"node":"c"},"plan":"pro"}"#),
    ]

    /// Bekannte Schlüssel und Enum-Werte aus Swift; der TS-Kern vergleicht seine Schemas damit (Drift-Check).
    public static func schema() -> JSONValue {
        func keys(_ s: Set<String>) -> JSONValue { .array(s.sorted().map(JSONValue.string)) }
        func cases<E: RawRepresentable>(_ c: [E]) -> JSONValue where E.RawValue == String { .array(c.map(\.rawValue).sorted().map(JSONValue.string)) }
        return .object([
            "keys": .object([
                "Block": keys(Block.knownKeys),
                "BlockProps": keys(BlockProps.knownKeys),
                "PropertySchema": keys(PropertySchema.knownKeys),
                "Database": keys(Database.knownKeys),
                "DatabaseView": keys(DatabaseView.knownKeys),
                "Workspace": keys(Workspace.knownKeys),
                "FilterCondition": keys(Set(FilterCondition.CodingKeys.allCases.map(\.rawValue))),
                "FilterGroup": keys(FilterGroup.knownKeys),
                "SortRule": keys(SortRule.knownKeys),
                "ChartConfig": keys(ChartConfig.knownKeys),
                "DashboardConfig": keys(DashboardConfig.knownKeys),
                "DashboardRow": keys(DashboardConfig.Row.knownKeys),
                "DashboardWidget": keys(DashboardConfig.Widget.knownKeys),
            ]),
            "enums": .object([
                "BlockType": cases(BlockType.allCases.filter { $0 != .unknown }),
                "PropertyType": cases(PropertyType.allCases.filter { $0 != .unknown }),
                "ViewType": cases(ViewType.allCases.filter { $0 != .unknown }),
                "FilterOp": cases(FilterOp.allCases),
                "TColor": cases(TColor.allCases),
                "NumberFormat": cases(NumberFormat.allCases),
                "CalculationType": cases(CalculationType.allCases),
                "Combinator": cases(Combinator.allCases),
                "RelativeDate": cases(RelativeDate.allCases),
                "OpenMode": cases(OpenMode.allCases),
                "ChartKind": cases(ChartConfig.Kind.allCases),
                "ChartAggregate": cases(ChartConfig.Aggregate.allCases),
                "ChartDateBucket": cases(ChartConfig.DateBucket.allCases),
                "ButtonActionKind": cases(ButtonAction.Kind.allCases),
                "MeetingSectionKind": cases(MeetingSectionKind.allCases),
                "CardSize": cases(CardSize.allCases),
                "DateGrouping": cases(DateGrouping.allCases),
                "PageFont": cases(PageFont.allCases),
                "AudioTrackRole": cases(AudioTrackRole.allCases),
                "RecordKind": cases(RecordKind.allCases),
                "PropertyValueCase": .array(PropertyValue.knownCaseNames.sorted().map(JSONValue.string)),
                "CardCoverCase": .array(CardCover.knownCaseNames.sorted().map(JSONValue.string)),
            ]),
        ])
    }
}
