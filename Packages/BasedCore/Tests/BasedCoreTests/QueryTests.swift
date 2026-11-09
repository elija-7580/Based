import Foundation
import Testing
@testable import BasedCore

@MainActor
@Suite struct QueryTests {
    func eval(_ src: String, props: [String: Value] = [:]) throws -> Value {
        let env = FormulaEnvironment(prop: { name in
            guard let v = props[name] else { throw FormulaError("Property “\(name)” not found") }
            return v
        }, now: Date(timeIntervalSince1970: 1_700_000_000))
        return try Formula.evaluate(src, env)
    }

    @Test func formulaBasics() throws {
        #expect(try eval("1 + 2 * 3") == .number(7))
        #expect(try eval("2 ^ 3 ^ 2") == .number(512))
        #expect(try eval("-2 ^ 2") == .number(-4))
        #expect(try eval("\"a\" + 1") == .string("a1"))
        #expect(try eval("if(true, \"yes\", \"no\")") == .string("yes"))
        #expect(try eval("ifs(false, 1, true, 2, 3)") == .number(2))
        #expect(try eval("1 < 2 and not false") == .bool(true))
        #expect(try eval("5 > 3 ? \"big\" : \"small\"") == .string("big"))
        #expect(try eval("prop(\"Price\") * prop(\"Qty\")", props: ["Price": .number(2.5), "Qty": .number(4)]) == .number(10))
        #expect(try eval("\"Hello\".length()") == .number(5))
        #expect(try eval("upper(\"abc\")") == .string("ABC"))
        #expect(try eval("\"a,b,c\".split(\",\").join(\"-\")") == .string("a-b-c"))
        #expect(try eval("replaceAll(\"a1b2\", \"[0-9]\", \"#\")") == .string("a#b#"))
        #expect(try eval("round(3.14159, 2)") == .number(3.14))
        #expect(try eval("max(1, 5, 3)") == .number(5))
        #expect(try eval("sum([1, 2, 3])") == .number(6))
        #expect(try eval("[3, 1, 2].sort()") == .list([.number(1), .number(2), .number(3)]))
        #expect(try eval("[1, 2, 3].map(current * 2)") == .list([.number(2), .number(4), .number(6)]))
        #expect(try eval("[1, 2, 3, 4].filter(current % 2 == 0)") == .list([.number(2), .number(4)]))
        #expect(try eval("let(x, 5, x * x)") == .number(25))
        #expect(try eval("lets(a, 1, b, a + 1, a + b)") == .number(3))
        #expect(try eval("padStart(\"7\", 3, \"0\")") == .string("007"))
        #expect(try eval("toNumber(\"42\")") == .number(42))
        #expect(try eval("empty(\"\")") == .bool(true))
        #expect(throws: (any Error).self) { try eval("prop(\"Missing\")") }
        #expect(throws: (any Error).self) { try eval("1 +") }
    }

    @Test func formulaDates() throws {
        let d = try eval("dateAdd(parseDate(\"2024-01-31\"), 1, \"months\")")
        guard case .date(let dv) = d else { Issue.record(); return }
        #expect(DateParsing.isoDay.string(from: dv.start) == "2024-02-29")
        #expect(try eval("dateBetween(parseDate(\"2024-03-10\"), parseDate(\"2024-03-01\"), \"days\")") == .number(9))
        #expect(try eval("formatDate(parseDate(\"2024-03-05\"), \"YYYY/MM/DD\")") == .string("2024/03/05"))
        #expect(try eval("year(parseDate(\"2024-03-05\"))") == .number(2024))
        #expect(try eval("month(parseDate(\"2024-03-05\"))") == .number(3))
    }

    func makeDB() -> (WorkspaceStore, Database, DatabaseView) {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "q")
        let page = s.createPage(title: "P")
        let c = s.createDatabase(title: "Tasks", in: .block(page), inline: true, sampleRows: 0)
        let prio = s.addProperty(to: c.databaseID, name: "Points", type: .number)!
        let tags = s.addProperty(to: c.databaseID, name: "Kind", type: .select)!
        let bug = s.addOption(c.databaseID, tags, name: "Bug")!
        let feat = s.addOption(c.databaseID, tags, name: "Feature")!
        let done = s.addProperty(to: c.databaseID, name: "Done", type: .checkbox)!
        let f = s.addProperty(to: c.databaseID, name: "Double", type: .formula)!
        s.updateProperty(c.databaseID, f) { $0.formula = "prop(\"Points\") * 2" }
        s.addRow(to: c.databaseID, title: "Crash", values: [prio: .number(5), tags: .select(bug)])
        s.addRow(to: c.databaseID, title: "Login", values: [prio: .number(3), tags: .select(feat), done: .checkbox(true)])
        s.addRow(to: c.databaseID, title: "Typo", values: [prio: .number(1), tags: .select(bug), done: .checkbox(true)])
        s.addRow(to: c.databaseID, title: "Empty")
        return (s, s.databases[c.databaseID]!, s.views[c.viewID]!)
    }

    @Test func filterSortGroupCalc() {
        let (s, db, view) = makeDB()
        let q = QueryEngine(store: s)
        let points = db.property(named: "Points")!, kind = db.property(named: "Kind")!, done = db.property(named: "Done")!
        var v = view
        v.sorts = [SortRule(propertyID: points.id, ascending: false)]
        #expect(q.run(v).rows.map(\.title) == ["Crash", "Login", "Typo", "Empty"], "empty values sort last")
        v.filter = FilterGroup(combinator: .and, items: [.condition(FilterCondition(propertyID: kind.id, op: .equals, value: .options([kind.option(named: "Bug")!.id])))])
        #expect(q.run(v).rows.map(\.title) == ["Crash", "Typo"])
        v.filter = FilterGroup(combinator: .or, items: [
            .condition(FilterCondition(propertyID: points.id, op: .greater, value: .number(4))),
            .condition(FilterCondition(propertyID: done.id, op: .equals, value: .bool(true))),
        ])
        #expect(Set(q.run(v).rows.map(\.title)) == ["Crash", "Login", "Typo"])
        v.filter = nil
        v.groupBy = GroupRule(propertyID: kind.id)
        let groups = q.run(v).groups!
        #expect(groups.map(\.title) == ["No Kind", "Bug", "Feature"])
        #expect(groups[1].rows.count == 2)
        let rows = q.run(view).rows
        #expect(q.calculation(.sum, points, rows: rows, db: db) == "9")
        #expect(q.calculation(.percentChecked, done, rows: rows, db: db) == "50%")
        let formula = db.property(named: "Double")!
        #expect(q.value(rows[0], formula, db) == .number(10))
        #expect(q.run(view, search: "typ").rows.map(\.title) == ["Typo"])
    }

    @Test func relationRollupTwoWay() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "r")
        let projects = s.createDatabase(title: "Projects", in: .workspace, inline: false, sampleRows: 0)
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0)
        let est = s.addProperty(to: tasks.databaseID, name: "Hours", type: .number)!
        let rel = s.addProperty(to: projects.databaseID, name: "Tasks", type: .relation)!
        s.updateProperty(projects.databaseID, rel) { $0.relation = RelationConfig(databaseID: tasks.databaseID) }
        s.makeRelationTwoWay(projects.databaseID, rel)
        let roll = s.addProperty(to: projects.databaseID, name: "Total", type: .rollup)!
        s.updateProperty(projects.databaseID, roll) { $0.rollup = RollupConfig(relationPropertyID: rel, targetPropertyID: est, function: .sum) }
        let p = s.addRow(to: projects.databaseID, title: "Launch")
        let t1 = s.addRow(to: tasks.databaseID, title: "Write", values: [est: .number(2)])
        let t2 = s.addRow(to: tasks.databaseID, title: "Ship", values: [est: .number(3)])
        s.setRelation(p, rel, [t1, t2])
        let mirror = s.databases[projects.databaseID]!.property(rel)!.relation!.syncedPropertyID!
        #expect(s.blocks[t1]?.values[mirror] == .relation([p]))
        let q = QueryEngine(store: s)
        #expect(q.value(p, roll) == .number(5))
        s.setRelation(p, rel, [t2])
        #expect(s.blocks[t1]?.values[mirror] == nil)
    }

    @Test func changePropertyType() {
        let (s, db, _) = makeDB()
        let points = db.property(named: "Points")!
        s.changePropertyType(db.id, points.id, to: .text)
        let row = s.rows(of: db.id).first { $0.title == "Crash" }!
        #expect(s.blocks[row.id]?.values[points.id] == .text("5"))
        s.changePropertyType(db.id, points.id, to: .select)
        let opt = s.databases[db.id]!.property(points.id)!.option(named: "5")
        #expect(opt != nil)
        #expect(s.blocks[row.id]?.values[points.id] == .select(opt!.id))
    }
}

@MainActor
@Suite struct EditingTests {
    @Test func blockShortcuts() {
        #expect(MarkdownShortcuts.blockShortcut(before: "# ", currentType: .text)?.type == .heading1)
        #expect(MarkdownShortcuts.blockShortcut(before: "### ", currentType: .text)?.type == .heading3)
        #expect(MarkdownShortcuts.blockShortcut(before: "- ", currentType: .text)?.type == .bulletedList)
        #expect(MarkdownShortcuts.blockShortcut(before: "[] ", currentType: .text)?.type == .todo)
        #expect(MarkdownShortcuts.blockShortcut(before: "1. ", currentType: .text)?.type == .numberedList)
        #expect(MarkdownShortcuts.blockShortcut(before: "> ", currentType: .text)?.type == .toggle)
        #expect(MarkdownShortcuts.blockShortcut(before: "\" ", currentType: .text)?.type == .quote)
        #expect(MarkdownShortcuts.blockShortcut(before: "hello ", currentType: .text) == nil)
        #expect(MarkdownShortcuts.immediateShortcut(text: "---", currentType: .text)?.type == .divider)
    }

    @Test func inlineMarkdown() {
        let r = InlineMarkdown.apply("say **hi**", caret: 10)!
        #expect(r.text.plainText == "say hi")
        #expect(r.caret == 6)
        #expect(r.text.marks(at: 5).bold)
        let c = InlineMarkdown.apply("run `ls`", caret: 8)!
        #expect(c.text.plainText == "run ls")
        #expect(c.text.marks(at: 5).code)
        #expect(InlineMarkdown.apply("a * b *", caret: 7) == nil)
        let i = InlineMarkdown.apply("x *y*", caret: 5)!
        #expect(i.text.marks(at: 3).italic)
    }

    @Test func slashSearch() {
        #expect(SlashCommands.search("h2").first?.title == "Heading 2")
        #expect(SlashCommands.search("todo").first?.title == "To-do list")
        #expect(SlashCommands.search("board").first?.title == "Board view")
        #expect(SlashCommands.search("red").first?.action == .color(.red))
        #expect(!(SlashCommands.search("").contains { $0.section == .color }))
    }

    @Test func triggers() {
        #expect(InlineTrigger.detect("/", caret: 1) == .slash)
        #expect(InlineTrigger.detect("a /", caret: 3) == .slash)
        #expect(InlineTrigger.detect("a/", caret: 2) == nil)
        #expect(InlineTrigger.detect("x [[", caret: 4) == .pageLink)
        #expect(InlineTrigger.detect("@", caret: 1) == .mention)
    }

    @Test func richTextOps() throws {
        var t = RichText("Hello world")
        t = t.toggling(.bold, 0, 5)
        #expect(t.marks(at: 2).bold)
        #expect(!(t.marks(at: 7).bold))
        let (a, b) = t.split(at: 3)
        #expect(a.plainText + b.plainText == "Hello world")
        #expect((a + b) == t)
        let linked = t.settingLink("https://x.y", 6, 11)
        #expect(linked.marks(at: 8).link == "https://x.y")
        let data = try! JSONEncoder().encode(linked)
        #expect(try JSONDecoder().decode(RichText.self, from: data) == linked)
    }
}