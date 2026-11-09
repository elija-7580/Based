import Foundation

/// BSD-149 (ADR 0011): Eingabe→Ausgabe-Paare der Swift-Kernlogik als Orakel für die TS-Portierung.
/// Dateiformat je Modul: `{"module": "…", "cases": [{"name": "…", "input": …, "output": …}]}`.
/// Fehler erscheinen als `{"error": "…"}`. Werte (`Value`) als `{"t": "<typ>", "v": …}`.
/// Zeit ist fest (`now`), Zufall hat feste Seeds. Zeitzonen-abhängige Fälle stehen in eigenen Dateien
/// (`*.utc.json`) und werden mit TZ=UTC erzeugt (`swift run based-fixtures` setzt das selbst).
public enum CoreFixtures {
    /// Fester Zeitpunkt für alle Fälle: 2023-11-14T22:13:20Z.
    public static let now = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: Hilfen

    static func json<T: Encodable>(_ v: T) -> JSONValue {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        return (try? JSONValue.parse(e.encode(v))) ?? .null
    }

    static func file(_ module: String, _ cases: [JSONValue], meta: [String: JSONValue] = [:]) -> JSONValue {
        var o: [String: JSONValue] = ["module": .string(module), "cases": .array(cases)]
        for (k, v) in meta { o[k] = v }
        return .object(o)
    }

    static func testCase(_ name: String, _ input: JSONValue, _ output: JSONValue) -> JSONValue {
        .object(["name": .string(name), "input": input, "output": output])
    }

    /// Deterministischer Zufall (SplitMix64), damit Zufallsfälle bei jedem Lauf gleich sind.
    struct Seeded {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
        mutating func int(_ n: Int) -> Int { Int(next() % UInt64(n)) }
    }

    public static func value(_ v: Value) -> JSONValue {
        switch v {
        case .empty: return ["t": "empty"]
        case .string(let s): return ["t": "string", "v": .string(s)]
        case .number(let n): return n.isFinite ? ["t": "number", "v": .number(n)] : ["t": "number", "v": .string(String(n))]
        case .bool(let b): return ["t": "bool", "v": .bool(b)]
        case .date(let d): return ["t": "date", "v": json(d)]
        case .list(let l): return ["t": "list", "v": .array(l.map(value))]
        case .page(let id): return ["t": "page", "v": .string(id)]
        case .person(let p): return ["t": "person", "v": .string(p)]
        }
    }

    static func stampJSON(_ s: Stamp) -> JSONValue { json(s) }

    // MARK: HLC

    public static func hlc() -> JSONValue {
        var cases: [JSONValue] = []
        // Ordnung und Textform
        let stamps = [Stamp(millis: 5, counter: 0, node: "b"), Stamp(millis: 5, counter: 0, node: "a"), Stamp(millis: 5, counter: 2, node: "a"),
                      Stamp(millis: 4, counter: 9, node: "z"), .zero, Stamp(millis: 1_793_974_300_424, counter: 201, node: "3c8ed7c0"),
                      Stamp(millis: 5, counter: UInt32.max, node: "")]
        for a in stamps { for b in stamps {
            cases.append(testCase("compare", ["op": "compare", "a": stampJSON(a), "b": stampJSON(b)], .number(a < b ? -1 : (b < a ? 1 : 0))))
        } }
        for s in stamps { cases.append(testCase("description", ["op": "description", "stamp": stampJSON(s)], .string(s.description))) }
        for text in ["0000000000000005-000000-a", "1-2-node-with-dash", "x-1-a", "5-1", "", "0000001793974300424-000201-3c8ed7c0"] {
            cases.append(testCase("parse", ["op": "parse", "text": .string(text)], Stamp(string: text).map(stampJSON) ?? .null))
        }
        // Uhr: Folgen aus now (mit Wanduhr) und observe (Fremdstempel)
        var rng = Seeded(state: 0xBA5ED)
        for seq in 0..<12 {
            var wall: Int64 = 1_000_000 + Int64(rng.int(1000))
            let clock = StampClock(node: "n\(seq)", last: seq % 3 == 0 ? .zero : Stamp(millis: wall + 50, counter: UInt32(rng.int(5)), node: "old"))
            if seq == 11 { clock.observe(Stamp(millis: wall + 10, counter: UInt32.max - 1, node: "x")) }
            let initial = clock.current
            var steps: [JSONValue] = []
            for _ in 0..<20 {
                let r = rng.int(10)
                if r < 3 { wall += Int64(rng.int(3)) }                          // Wanduhr springt (oder bleibt stehen)
                let w = wall
                clock.wallClock = { w }
                if r < 6 {
                    let s = clock.now()
                    steps.append(["op": "now", "wall": .number(Double(w)), "result": stampJSON(s)])
                } else {
                    let drift: Int64 = r == 9 ? StampClock.maxDrift + 1 : Int64(rng.int(200)) - 100
                    let remote = Stamp(millis: w + drift, counter: UInt32(rng.int(4)), node: "r\(rng.int(3))")
                    let accepted = clock.observe(remote)
                    steps.append(["op": "observe", "wall": .number(Double(w)), "remote": stampJSON(remote),
                                  "result": .bool(accepted), "current": stampJSON(clock.current)])
                }
            }
            cases.append(testCase("clock-\(seq)", ["op": "clock", "node": .string("n\(seq)"), "last": stampJSON(initial), "maxDrift": .number(Double(StampClock.maxDrift))], .array(steps)))
        }
        return file("hlc", cases)
    }

    // MARK: Sortierschlüssel

    public static func sortKeys() -> JSONValue {
        var cases: [JSONValue] = []
        func between(_ a: String?, _ b: String?, _ name: String) {
            cases.append(testCase(name, ["op": "between", "a": a.map(JSONValue.string) ?? .null, "b": b.map(JSONValue.string) ?? .null],
                                  .string(FractionalIndex.between(a, b))))
        }
        let fixed: [(String?, String?)] = [
            (nil, nil), ("a0", nil), (nil, "a0"), ("a0", "a1"), ("a0", "a0V"), ("a1", "a0"), ("a0", "a0"),
            ("Zz", "a0"), ("zz", nil), ("A00000000000000000000000000", nil), (nil, "A00000000000000000000000000"),
            (nil, "A000000000000000000000000001"), ("a0", "b00"), ("b00", "b01"), ("az", nil), ("Zz", nil), (nil, "Zz"),
            // Altbestand (vor dem Fraktions-Index): ungültige Schlüssel gehen auf das alte Verfahren zurück
            ("m", nil), ("m", "n"), (nil, "m"), ("V", "W"), ("a00", nil), ("", nil), (nil, ""), ("U", "Ua"),
        ]
        for (a, b) in fixed { between(a, b, "fest") }
        for k in ["a0", "a1V", "Zz", "a0", "a00", "b000", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "A00000000000000000000000000", "a!", "0", ""] {
            cases.append(testCase("isValid", ["op": "isValid", "key": .string(k)], .bool(FractionalIndex.isValid(k))))
        }
        for (count, a, b) in [(0, nil, nil), (1, nil, nil), (5, nil, nil), (5, "a3", nil), (5, nil, "a3"), (7, "a0", "a1"), (3, "a0", "a0V")] as [(Int, String?, String?)] {
            cases.append(testCase("keys", ["op": "keys", "count": .number(Double(count)), "a": a.map(JSONValue.string) ?? .null, "b": b.map(JSONValue.string) ?? .null],
                                  .array(FractionalIndex.keys(count: count, between: a, b).map(JSONValue.string))))
        }
        // Zufallsfolge: Einfügen an zufälligen Stellen einer sortierten Liste
        var rng = Seeded(state: 0x50_47)
        var list: [String] = []
        for i in 0..<300 {
            let pos = list.isEmpty ? 0 : rng.int(list.count + 1)
            let a = pos > 0 ? list[pos - 1] : nil, b = pos < list.count ? list[pos] : nil
            between(a, b, "zufall-\(i)")
            list.insert(FractionalIndex.between(a, b), at: pos)
        }
        return file("sortkeys", cases)
    }

    // MARK: Formeln

    static let formulaProps: [String: Value] = [
        "Price": .number(2.5), "Qty": .number(4), "Name": .string("Based App"), "Done": .bool(true), "Empty": .empty,
        "Tags": .list([.string("b"), .string("a"), .string("c")]), "Owner": .person("user-1"), "Linked": .list([.page("p1"), .page("p2")]),
        "Due": .date(DateValue(start: Date(timeIntervalSince1970: 1_700_600_000), end: Date(timeIntervalSince1970: 1_700_900_000), includeTime: true)),
        "Day": .date(DateValue(start: Date(timeIntervalSince1970: 1_699_920_000))),
    ]

    static let formulaSources: [String] = [
        // Arithmetik, Vorrang, Typen
        "1 + 2 * 3", "2 ^ 3 ^ 2", "-2 ^ 2", "10 / 4", "10 % 3", "-7 % 3", "1 / 0", "0 / 0", "1e3 + .5", "\"a\" + 1", "1 + \"a\"", "true + 1",
        "1 == 1", "1 != 2", "\"a\" == \"a\"", "1 < 2 and not false", "true or false and false", "5 > 3 ? \"big\" : \"small\"", "1 > 2 ? 1 : 2 > 1 ? 3 : 4",
        "if(true, \"yes\", \"no\")", "ifs(false, 1, true, 2, 3)", "ifs(false, 1)", "empty(\"\")", "empty(0)", "empty([])", "not empty(prop(\"Name\"))",
        // Properties
        "prop(\"Price\") * prop(\"Qty\")", "prop(\"Name\")", "prop(\"Empty\")", "prop(\"Missing\")", "prop(\"Tags\")", "prop(\"Done\") ? 1 : 0",
        "prop(\"Tags\").sort()", "prop(\"Tags\").length()", "prop(\"Owner\")", "prop(\"Linked\")", "prop(\"Due\")",
        // Text
        "\"Hello\".length()", "upper(\"abc\")", "lower(\"ÄBC\")", "\"a,b,c\".split(\",\").join(\"-\")", "replaceAll(\"a1b2\", \"[0-9]\", \"#\")",
        "replace(\"a1b2\", \"[0-9]\", \"#\")", "test(\"abc\", \"b\")", "match(\"a1b22\", \"[0-9]+\")", "substring(\"Based\", 1, 3)", "substring(\"Based\", 2)",
        "contains(\"Based\", \"as\")", "repeat(\"ab\", 3)", "padStart(\"7\", 3, \"0\")", "padEnd(\"7\", 3, \"_\")", "trim(\"  x  \")", "concat([1], [2, 3])",
        "format(1.5)", "format(true)", "toNumber(\"42\")", "toNumber(\"x\")", "toNumber(true)", "\"x\".style(\"b\")", "link(\"Based\", \"https://x.y\")",
        // Zahlen
        "round(3.14159, 2)", "round(2.5)", "round(-2.5)", "ceil(1.2)", "floor(-1.2)", "abs(-3)", "sqrt(16)", "cbrt(27)", "exp(0)", "ln(e)", "log10(1000)", "log2(8)",
        "sign(-4)", "min(3, 1, 2)", "max(1, 5, 3)", "sum([1, 2, 3])", "sum(1, 2, 3)", "mean([1, 2, 3, 4])", "median([3, 1, 2])", "pi", "e", "pow(2, 10)", "mod(10, 3)",
        "add(1, 2)", "subtract(5, 2)", "multiply(3, 4)", "divide(9, 3)",
        // Listen
        "[3, 1, 2].sort()", "[1, 2, 3].map(current * 2)", "[1, 2, 3, 4].filter(current % 2 == 0)", "[1, 2, 3].map(index)", "[1, 2, 3].reverse()",
        "[1, 2, 3].first()", "[1, 2, 3].last()", "[1, 2, 3].at(1)", "[1, 2, 3].at(5)", "[1, 2, 2, 3].unique()", "[1, [2, [3]]].flat()", "[1, 2, 3].slice(1)",
        "[1, 2, 3].find(current > 1)", "[1, 2, 3].findIndex(current > 1)", "[1, 2, 3].some(current > 2)", "[1, 2, 3].every(current > 0)", "[1, 2, 3].includes(2)",
        "[\"b\", \"a\"].sort().join(\", \")", "[].length()", "[1, 2, 3].count()",
        // let / lets
        "let(x, 5, x * x)", "lets(a, 1, b, a + 1, a + b)",
        // Datum (zeitzonenfrei: Rechnen mit Zeitstempeln)
        "timestamp(now())", "dateBetween(prop(\"Due\").dateEnd(), prop(\"Due\").dateStart(), \"hours\")", "fromTimestamp(1700000000000)",
        "dateBetween(fromTimestamp(1700086400000), fromTimestamp(1700000000000), \"days\")", "dateAdd(fromTimestamp(1700000000000), 90, \"minutes\")",
"timestamp(dateAdd(fromTimestamp(1700000000000), 1, \"seconds\"))",
        // Fehler
        "1 +", "foo(1)", "if(true)", "\"unterminated", "prop(1)", "[1, 2", "let(1, 2, 3)", "upper()",
    ]

    /// Zeitzonenabhängige Formeln (Kalendertage, Formatierung); nur unter TZ=UTC erzeugt.
    static let formulaSourcesUTC: [String] = [
        "dateAdd(parseDate(\"2024-01-31\"), 1, \"months\")", "dateBetween(parseDate(\"2024-03-10\"), parseDate(\"2024-03-01\"), \"days\")",
        "formatDate(parseDate(\"2024-03-05\"), \"YYYY/MM/DD\")", "year(parseDate(\"2024-03-05\"))", "month(parseDate(\"2024-03-05\"))",
        "date(parseDate(\"2024-03-05\"))", "day(parseDate(\"2024-03-05\"))", "week(parseDate(\"2024-03-05\"))", "hour(fromTimestamp(1700000000000))",
        "minute(fromTimestamp(1700000000000))", "formatDate(now(), \"MMMM D, YYYY\")", "formatDate(prop(\"Due\"), \"YYYY-MM-DD HH:mm\")",
        "dateStart(prop(\"Due\"))", "dateSubtract(fromTimestamp(1700000000000), 2, \"weeks\")", "dateRange(parseDate(\"2024-01-01\"), parseDate(\"2024-01-31\"))", "today()", "parseDate(\"2024-02-30\")",
        "parseDate(\"2024-02-29T13:45\")", "dateBetween(today(), prop(\"Day\"), \"days\")", "formatDate(prop(\"Day\"), \"dddd\")",
    ]

    static func formulaEnv() -> FormulaEnvironment {
        FormulaEnvironment(prop: { name in
            guard let v = formulaProps[name] else { throw FormulaError("Property “\(name)” not found") }
            return v
        }, pageTitle: { "Titel " + $0 }, personName: { "Name " + $0 }, personEmail: { $0 + "@example.com" }, currentPage: "p0", now: now)
    }

    public static func formulas(utc: Bool) -> JSONValue {
        let env = formulaEnv()
        let cases = (utc ? formulaSourcesUTC : formulaSources).map { src -> JSONValue in
            let out: JSONValue
            do { out = value(try Formula.evaluate(src, env)) } catch { out = ["error": .string(String(describing: error))] }
            return testCase(src, ["source": .string(src)], out)
        }
        var props: [String: JSONValue] = [:]
        for (k, v) in formulaProps { props[k] = value(v) }
        return file("formulas", cases, meta: [
            "env": ["props": .object(props), "now": .number(now.timeIntervalSince1970 * 1000), "currentPage": "p0",
                    "pageTitle": "Titel <id>", "personName": "Name <id>", "personEmail": "<id>@example.com"],
            "timeZone": utc ? "UTC" : .null,
        ])
    }
}
