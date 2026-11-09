import Foundation

public struct FormulaError: Error, Equatable, CustomStringConvertible, Sendable {
    public enum Kind: Sendable, Equatable {
        case general, invalidArgument, divisionByZero, cycle, tooDeep
    }
    public var message: String
    public var kind: Kind
    public init(_ m: String, kind: Kind = .general) { message = m; self.kind = kind }
    public var description: String { message }

    public static func invalidArgument(_ fn: String, _ detail: String) -> FormulaError {
        FormulaError("\(fn)(): \(detail)", kind: .invalidArgument)
    }
    public static let divisionByZero = FormulaError("Division by zero", kind: .divisionByZero)
    public static let cycle = FormulaError("Circular reference", kind: .cycle)
    public static let tooDeep = FormulaError("Too many nested formulas or rollups", kind: .tooDeep)
}

/// Limits that keep user formulas from trapping or exhausting memory (BSD-17).
enum FormulaLimits {
    /// Largest magnitude accepted where a whole number is needed (indices, counts, date amounts).
    static let maxInt = 1_000_000_000.0
    /// Longest string `repeat` / `padStart` / `padEnd` may build.
    static let maxStringLength = 100_000
}

/// A whole number from a formula number: rejects NaN, ±inf and values beyond ±1e9 instead of trapping.
func formulaInt(_ d: Double, _ fn: String) throws -> Int {
    guard d.isFinite else { throw FormulaError.invalidArgument(fn, "expected a finite number") }
    guard abs(d) <= FormulaLimits.maxInt else { throw FormulaError.invalidArgument(fn, "number out of range") }
    return Int(d.rounded(.towardZero))
}

// MARK: - Lexer

enum Token: Equatable {
    case number(Double), string(String), ident(String), op(String), eof
}

struct Lexer {
    static func tokens(_ src: String) throws -> [Token] {
        var out: [Token] = []
        let chars = Array(src)
        var i = 0
        let ops3: Set<String> = []
        let ops2: Set<String> = ["==", "!=", ">=", "<=", "&&", "||", "**"]
        while i < chars.count {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            if c == "/" && i + 1 < chars.count && chars[i + 1] == "*" {
                i += 2
                while i + 1 < chars.count && !(chars[i] == "*" && chars[i + 1] == "/") { i += 1 }
                i += 2; continue
            }
            if c.isNumber || (c == "." && i + 1 < chars.count && chars[i + 1].isNumber) {
                var j = i
                while j < chars.count && (chars[j].isNumber || chars[j] == ".") { j += 1 }
                if j < chars.count && (chars[j] == "e" || chars[j] == "E"),
                   j + 1 < chars.count, chars[j + 1].isNumber || ((chars[j + 1] == "-" || chars[j + 1] == "+") && j + 2 < chars.count && chars[j + 2].isNumber) {
                    j += 2
                    while j < chars.count && chars[j].isNumber { j += 1 }
                }
                guard let n = Double(String(chars[i..<j])) else { throw FormulaError("Invalid number") }
                out.append(.number(n)); i = j; continue
            }
            if c == "\"" || c == "'" || c == "“" {
                let close: Character = c == "“" ? "”" : c
                var s = ""
                var j = i + 1
                var closed = false
                while j < chars.count {
                    let d = chars[j]
                    if d == "\\" && j + 1 < chars.count {
                        let n = chars[j + 1]
                        switch n {
                        case "n": s.append("\n")
                        case "t": s.append("\t")
                        default: s.append(n)
                        }
                        j += 2; continue
                    }
                    if d == close { closed = true; j += 1; break }
                    s.append(d); j += 1
                }
                guard closed else { throw FormulaError("Unterminated string") }
                out.append(.string(s)); i = j; continue
            }
            if c.isLetter || c == "_" {
                var j = i
                while j < chars.count && (chars[j].isLetter || chars[j].isNumber || chars[j] == "_") { j += 1 }
                out.append(.ident(String(chars[i..<j]))); i = j; continue
            }
            if i + 2 < chars.count, ops3.contains(String(chars[i...(i + 2)])) {
                out.append(.op(String(chars[i...(i + 2)]))); i += 3; continue
            }
            if i + 1 < chars.count, ops2.contains(String(chars[i...(i + 1)])) {
                let o = String(chars[i...(i + 1)])
                out.append(.op(o == "**" ? "^" : o)); i += 2; continue
            }
            if "+-*/%^()[],.?:<>!=".contains(c) {
                out.append(.op(String(c))); i += 1; continue
            }
            if c == "≥" { out.append(.op(">=")); i += 1; continue }
            if c == "≤" { out.append(.op("<=")); i += 1; continue }
            if c == "≠" { out.append(.op("!=")); i += 1; continue }
            throw FormulaError("Unexpected character “\(c)”")
        }
        out.append(.eof)
        return out
    }
}

// MARK: - AST & Parser

public indirect enum FormulaExpr: Equatable, Sendable {
    case number(Double)
    case string(String)
    case bool(Bool)
    case list([FormulaExpr])
    case ident(String)
    case call(String, [FormulaExpr])
    case unary(String, FormulaExpr)
    case binary(String, FormulaExpr, FormulaExpr)
    case ternary(FormulaExpr, FormulaExpr, FormulaExpr)

    /// Property names referenced through prop("…").
    public var referencedProperties: Set<String> {
        switch self {
        case .call(let n, let args):
            var s = Set(args.flatMap(\.referencedProperties))
            if n == "prop", case .string(let p)? = args.first { s.insert(p) }
            return s
        case .list(let l): return Set(l.flatMap(\.referencedProperties))
        case .unary(_, let e): return e.referencedProperties
        case .binary(_, let a, let b): return a.referencedProperties.union(b.referencedProperties)
        case .ternary(let a, let b, let c): return a.referencedProperties.union(b.referencedProperties).union(c.referencedProperties)
        default: return []
        }
    }
}

struct Parser {
    var tokens: [Token]
    var pos = 0

    static func parse(_ src: String) throws -> FormulaExpr {
        var p = Parser(tokens: try Lexer.tokens(src))
        if p.peek == .eof { return .string("") }
        let e = try p.expression()
        guard p.peek == .eof else { throw FormulaError("Unexpected \(p.describe(p.peek))") }
        return e
    }

    var peek: Token { tokens[pos] }
    mutating func next() -> Token { let t = tokens[pos]; if pos < tokens.count - 1 { pos += 1 }; return t }
    func describe(_ t: Token) -> String {
        switch t {
        case .number(let n): return "number \(NumberFormatting.plain(n))"
        case .string(let s): return "\"\(s)\""
        case .ident(let s): return s
        case .op(let o): return "“\(o)”"
        case .eof: return "end of formula"
        }
    }
    mutating func expect(_ o: String) throws {
        guard case .op(let x) = next(), x == o else { throw FormulaError("Expected “\(o)”") }
    }
    mutating func accept(_ o: String) -> Bool {
        if case .op(let x) = peek, x == o { pos += 1; return true }
        return false
    }
    mutating func acceptWord(_ w: String) -> Bool {
        if case .ident(let x) = peek, x == w { pos += 1; return true }
        return false
    }

    mutating func expression() throws -> FormulaExpr { try ternary() }

    mutating func ternary() throws -> FormulaExpr {
        let c = try orExpr()
        if accept("?") {
            let a = try expression()
            try expect(":")
            let b = try expression()
            return .ternary(c, a, b)
        }
        return c
    }
    mutating func orExpr() throws -> FormulaExpr {
        var l = try andExpr()
        while accept("||") || acceptWord("or") { l = .binary("or", l, try andExpr()) }
        return l
    }
    mutating func andExpr() throws -> FormulaExpr {
        var l = try equality()
        while accept("&&") || acceptWord("and") { l = .binary("and", l, try equality()) }
        return l
    }
    mutating func equality() throws -> FormulaExpr {
        var l = try comparison()
        while true {
            if accept("==") { l = .binary("==", l, try comparison()) }
            else if accept("!=") { l = .binary("!=", l, try comparison()) }
            else { return l }
        }
    }
    mutating func comparison() throws -> FormulaExpr {
        var l = try additive()
        while true {
            if accept(">=") { l = .binary(">=", l, try additive()) }
            else if accept("<=") { l = .binary("<=", l, try additive()) }
            else if accept(">") { l = .binary(">", l, try additive()) }
            else if accept("<") { l = .binary("<", l, try additive()) }
            else { return l }
        }
    }
    mutating func additive() throws -> FormulaExpr {
        var l = try multiplicative()
        while true {
            if accept("+") { l = .binary("+", l, try multiplicative()) }
            else if accept("-") { l = .binary("-", l, try multiplicative()) }
            else { return l }
        }
    }
    mutating func multiplicative() throws -> FormulaExpr {
        var l = try unary()
        while true {
            if accept("*") { l = .binary("*", l, try unary()) }
            else if accept("/") { l = .binary("/", l, try unary()) }
            else if accept("%") { l = .binary("%", l, try unary()) }
            else { return l }
        }
    }
    mutating func unary() throws -> FormulaExpr {
        if accept("-") { return .unary("-", try unary()) }
        if accept("+") { return try unary() }
        if accept("!") || acceptWord("not") { return .unary("not", try unary()) }
        return try power()
    }
    mutating func power() throws -> FormulaExpr {
        let base = try postfix()
        if accept("^") { return .binary("^", base, try unary()) }
        return base
    }
    mutating func postfix() throws -> FormulaExpr {
        var e = try primary()
        while true {
            if accept(".") {
                guard case .ident(let name) = next() else { throw FormulaError("Expected a function name after “.”") }
                var args: [FormulaExpr] = [e]
                if accept("(") { args += try arguments() }
                e = .call(name, args)
            } else if case .op("[") = peek, pos > 0 {
                _ = next()
                let idx = try expression()
                try expect("]")
                e = .call("at", [e, idx])
            } else {
                return e
            }
        }
    }
    mutating func arguments() throws -> [FormulaExpr] {
        var args: [FormulaExpr] = []
        if accept(")") { return args }
        repeat { args.append(try expression()) } while accept(",")
        try expect(")")
        return args
    }
    mutating func primary() throws -> FormulaExpr {
        switch next() {
        case .number(let n): return .number(n)
        case .string(let s): return .string(s)
        case .ident(let name):
            if name == "true" { return .bool(true) }
            if name == "false" { return .bool(false) }
            if accept("(") { return .call(name, try arguments()) }
            return .ident(name)
        case .op("("):
            let e = try expression()
            try expect(")")
            return e
        case .op("["):
            var items: [FormulaExpr] = []
            if !accept("]") {
                repeat { items.append(try expression()) } while accept(",")
                try expect("]")
            }
            return .list(items)
        case let t:
            throw FormulaError("Unexpected \(describe(t))")
        }
    }
}

// MARK: - Evaluation

public struct FormulaEnvironment {
    /// Value of a property of the current row, by name.
    public var prop: (String) throws -> Value
    /// Value of a property of another page (relation items), by name.
    public var pageProp: (RecordID, String) throws -> Value
    public var pageTitle: (RecordID) -> String
    public var personName: (String) -> String
    public var personEmail: (String) -> String
    public var currentPage: RecordID?
    public var now: Date

    public init(prop: @escaping (String) throws -> Value,
                pageProp: @escaping (RecordID, String) throws -> Value = { _, _ in .empty },
                pageTitle: @escaping (RecordID) -> String = { $0 },
                personName: @escaping (String) -> String = { $0 },
                personEmail: @escaping (String) -> String = { _ in "" },
                currentPage: RecordID? = nil, now: Date = Date()) {
        self.prop = prop; self.pageProp = pageProp; self.pageTitle = pageTitle
        self.personName = personName; self.personEmail = personEmail
        self.currentPage = currentPage; self.now = now
    }
}

public final class Formula {
    public let source: String
    public let expr: FormulaExpr

    public init(_ source: String) throws {
        self.source = source
        self.expr = try Parser.parse(source)
    }

    public func evaluate(_ env: FormulaEnvironment) throws -> Value {
        var ev = Evaluator(env: env)
        return try ev.eval(expr)
    }

    /// One-shot helper.
    public static func evaluate(_ source: String, _ env: FormulaEnvironment) throws -> Value {
        try Formula(source).evaluate(env)
    }

    public static let functionNames: [String] = Evaluator.known.sorted()
}

struct Evaluator {
    var env: FormulaEnvironment
    var scopes: [[String: Value]] = []
    var depth = 0

    static let known: Set<String> = [
        "prop", "if", "ifs", "and", "or", "not", "empty", "length", "substring", "contains", "test", "match",
        "replace", "replaceAll", "lower", "upper", "repeat", "padStart", "padEnd", "link", "style", "unstyle",
        "format", "toNumber", "trim", "split", "join", "concat", "add", "subtract", "multiply", "divide", "pow",
        "mod", "abs", "ceil", "floor", "exp", "ln", "log10", "log2", "max", "min", "round", "sign", "sqrt", "cbrt",
        "pi", "e", "sum", "mean", "median", "now", "today", "minute", "hour", "day", "date", "week", "month",
        "year", "dateAdd", "dateSubtract", "dateBetween", "dateRange", "dateStart", "dateEnd", "timestamp",
        "fromTimestamp", "formatDate", "parseDate", "name", "email", "at", "first", "last", "slice", "sort",
        "reverse", "unique", "includes", "find", "findIndex", "filter", "some", "every", "map", "flat", "count",
        "let", "lets", "id", "equal", "unequal", "larger", "largerEq", "smaller", "smallerEq", "toString", "start", "end",
        "splice", "sortBy",
    ]

    func lookup(_ name: String) -> Value? {
        for s in scopes.reversed() { if let v = s[name] { return v } }
        return nil
    }

    mutating func eval(_ e: FormulaExpr) throws -> Value {
        depth += 1
        defer { depth -= 1 }
        guard depth < 200 else { throw FormulaError("Formula is too deeply nested") }
        switch e {
        case .number(let n): return .number(n)
        case .string(let s): return .string(s)
        case .bool(let b): return .bool(b)
        case .list(let items): return .list(try items.map { try eval($0) })
        case .ident(let name):
            if let v = lookup(name) { return v }
            switch name {
            case "pi": return .number(Double.pi)
            case "e": return .number(M_E)
            case "current", "index": throw FormulaError("“\(name)” can only be used inside map, filter and similar")
            default: throw FormulaError("Unknown name “\(name)”")
            }
        case .unary(let op, let x):
            let v = try eval(x)
            if op == "-" { return .number(-(try num(v, "-"))) }
            return .bool(!v.bool)
        case .ternary(let c, let a, let b):
            return try eval(c).bool ? try eval(a) : try eval(b)
        case .binary(let op, let a, let b):
            if op == "and" { return .bool(try eval(a).bool && (try eval(b).bool)) }
            if op == "or" { return .bool(try eval(a).bool || (try eval(b).bool)) }
            return try binary(op, try eval(a), try eval(b))
        case .call(let name, let args):
            return try call(name, args)
        }
    }

    func num(_ v: Value, _ fn: String) throws -> Double {
        switch v {
        case .number(let n): return n
        case .bool(let b): return b ? 1 : 0
        case .empty: return 0
        default: throw FormulaError("\(fn) expects a number, got \(v.typeName)")
        }
    }

    func str(_ v: Value) -> String { v.description }

    func date(_ v: Value, _ fn: String) throws -> DateValue {
        if case .date(let d) = v { return d }
        if case .list(let l) = v, let f = l.first, case .date(let d) = f { return d }
        throw FormulaError("\(fn) expects a date, got \(v.typeName)")
    }

    func equal(_ a: Value, _ b: Value) -> Bool {
        switch (a, b) {
        case (.number(let x), .number(let y)): return x == y
        case (.date(let x), .date(let y)): return x.start == y.start && x.end == y.end
        case (.empty, _): return b.isEmpty
        case (_, .empty): return a.isEmpty
        default: return a == b
        }
    }

    func binary(_ op: String, _ a: Value, _ b: Value) throws -> Value {
        switch op {
        case "+":
            if case .number(let x) = a, case .number(let y) = b { return .number(x + y) }
            if case .string = a { return .string(str(a) + str(b)) }
            if case .string = b { return .string(str(a) + str(b)) }
            if case .list(let x) = a, case .list(let y) = b { return .list(x + y) }
            return .number(try num(a, "+") + (try num(b, "+")))
        case "-": return .number(try num(a, "-") - (try num(b, "-")))
        case "*": return .number(try num(a, "*") * (try num(b, "*")))
        case "/":
            let d = try num(b, "/")
            guard d != 0 else { throw FormulaError.divisionByZero }
            return .number(try num(a, "/") / d)
        case "%":
            let d = try num(b, "%")
            guard d != 0 else { throw FormulaError.divisionByZero }
            return .number(fmod(try num(a, "%"), d))
        case "^": return .number(pow(try num(a, "^"), try num(b, "^")))
        case "==": return .bool(equal(a, b))
        case "!=": return .bool(!equal(a, b))
        case ">", "<", ">=", "<=":
            let c = Value.compare(a, b)
            switch op {
            case ">": return .bool(c == .orderedDescending)
            case "<": return .bool(c == .orderedAscending)
            case ">=": return .bool(c != .orderedAscending)
            default: return .bool(c != .orderedDescending)
            }
        default: throw FormulaError("Unknown operator \(op)")
        }
    }

    /// Evaluate `body` once per element with `current` and `index` bound.
    mutating func each(_ list: [Value], _ body: FormulaExpr, _ f: (Int, Value, Value) throws -> Bool) throws {
        for (i, item) in list.enumerated() {
            scopes.append(["current": item, "index": .number(Double(i))])
            let r: Value
            do { r = try eval(body) } catch { scopes.removeLast(); throw error }
            scopes.removeLast()
            if try !f(i, item, r) { break }
        }
    }

    mutating func call(_ name: String, _ argExprs: [FormulaExpr]) throws -> Value {
        // Lazy forms first.
        switch name {
        case "if":
            guard argExprs.count == 3 else { throw FormulaError("if() takes 3 arguments") }
            return try eval(argExprs[0]).bool ? try eval(argExprs[1]) : try eval(argExprs[2])
        case "ifs":
            var i = 0
            while i + 1 < argExprs.count {
                if try eval(argExprs[i]).bool { return try eval(argExprs[i + 1]) }
                i += 2
            }
            return i < argExprs.count ? try eval(argExprs[i]) : .empty
        case "and":
            for a in argExprs where !(try eval(a).bool) { return .bool(false) }
            return .bool(true)
        case "or":
            for a in argExprs where try eval(a).bool { return .bool(true) }
            return .bool(false)
        case "let":
            guard argExprs.count == 3, case .ident(let v) = argExprs[0] else { throw FormulaError("let(name, value, expression)") }
            let value = try eval(argExprs[1])
            scopes.append([v: value]); defer { scopes.removeLast() }
            return try eval(argExprs[2])
        case "lets":
            guard argExprs.count >= 3, argExprs.count % 2 == 1 else { throw FormulaError("lets(name, value, …, expression)") }
            var scope: [String: Value] = [:]
            scopes.append(scope)
            defer { scopes.removeLast() }
            var i = 0
            while i + 1 < argExprs.count {
                guard case .ident(let v) = argExprs[i] else { throw FormulaError("lets() expects variable names") }
                scope[v] = try eval(argExprs[i + 1])
                scopes[scopes.count - 1] = scope
                i += 2
            }
            return try eval(argExprs[argExprs.count - 1])
        case "map", "filter", "find", "findIndex", "some", "every", "count", "sortBy":
            guard let first = argExprs.first else { throw FormulaError("\(name)() needs a list") }
            let list = try eval(first).list
            guard argExprs.count >= 2 else {
                if name == "count" { return .number(Double(list.count)) }
                throw FormulaError("\(name)() needs an expression")
            }
            let body = argExprs[1]
            switch name {
            case "map":
                var out: [Value] = []
                try each(list, body) { _, _, r in out.append(r); return true }
                return .list(out)
            case "filter":
                var out: [Value] = []
                try each(list, body) { _, item, r in if r.bool { out.append(item) }; return true }
                return .list(out)
            case "count":
                var n = 0
                try each(list, body) { _, _, r in if r.bool { n += 1 }; return true }
                return .number(Double(n))
            case "find":
                var found: Value = .empty
                try each(list, body) { _, item, r in if r.bool { found = item; return false }; return true }
                return found
            case "findIndex":
                var idx = -1
                try each(list, body) { i, _, r in if r.bool { idx = i; return false }; return true }
                return .number(Double(idx))
            case "some":
                var any = false
                try each(list, body) { _, _, r in if r.bool { any = true; return false }; return true }
                return .bool(any)
            case "every":
                var all = true
                try each(list, body) { _, _, r in if !r.bool { all = false; return false }; return true }
                return .bool(all)
            default: // sortBy
                var keyed: [(Value, Value)] = []
                try each(list, body) { _, item, r in keyed.append((r, item)); return true }
                return .list(keyed.sorted { Value.compare($0.0, $1.0) == .orderedAscending }.map(\.1))
            }
        default: break
        }

        var args = try argExprs.map { try eval($0) }
        func arg(_ i: Int) throws -> Value {
            guard i < args.count else { throw FormulaError("\(name)() is missing an argument") }
            return args[i]
        }
        func n(_ i: Int) throws -> Double { try num(try arg(i), name) }
        func int(_ i: Int) throws -> Int { try formulaInt(try n(i), name) }
        func s(_ i: Int) throws -> String { str(try arg(i)) }
        func d(_ i: Int) throws -> DateValue { try date(try arg(i), name) }
        func numbers() throws -> [Double] {
            try args.flatMap { $0.list }.filter { !$0.isEmpty }.map { try num($0, name) }
        }
        let cal = Calendar.current

        switch name {
        case "prop":
            if args.count == 2, case .page(let pid) = args[0] { return try env.pageProp(pid, try s(1)) }
            return try env.prop(try s(0))
        case "not": return .bool(!(try arg(0)).bool)
        case "empty": return .bool(args.isEmpty ? true : args[0].isEmpty)
        case "length":
            let v = try arg(0)
            if case .list(let l) = v { return .number(Double(l.count)) }
            return .number(Double(str(v).count))
        case "substring":
            let chars = Array(try s(0))
            let a = max(0, min(chars.count, try int(1)))
            let b = args.count > 2 ? max(a, min(chars.count, try int(2))) : chars.count
            return .string(String(chars[a..<b]))
        case "contains":
            let v = try arg(0)
            if case .list(let l) = v { return .bool(l.contains { equal($0, args.count > 1 ? args[1] : .empty) || str($0) == str(args.count > 1 ? args[1] : .empty) }) }
            return .bool(str(v).contains(try s(1)))
        case "includes":
            let needle = try arg(1)
            return .bool(try arg(0).list.contains { equal($0, needle) })
        case "test":
            return .bool(try regex(try s(1)).firstMatch(in: try s(0), range: nsRange(try s(0))) != nil)
        case "match":
            let text = try s(0)
            let ms = try regex(try s(1)).matches(in: text, range: nsRange(text))
            return .list(ms.compactMap { Range($0.range, in: text).map { .string(String(text[$0])) } })
        case "replace", "replaceAll":
            let text = try s(0)
            let re = try regex(try s(1))
            let repl = args.count > 2 ? str(args[2]) : ""
            let template = repl.replacingOccurrences(of: "\\", with: "\\\\")
            if name == "replaceAll" {
                return .string(re.stringByReplacingMatches(in: text, range: nsRange(text), withTemplate: template))
            }
            guard let m = re.firstMatch(in: text, range: nsRange(text)) else { return .string(text) }
            let ns = NSMutableString(string: text)
            let r = re.replacementString(for: m, in: text, offset: 0, template: template)
            ns.replaceCharacters(in: m.range, with: r)
            return .string(ns as String)
        case "lower": return .string(try s(0).lowercased())
        case "upper": return .string(try s(0).uppercased())
        case "trim": return .string(try s(0).trimmingCharacters(in: .whitespacesAndNewlines))
        case "repeat":
            let text = try s(0)
            let count = max(0, try int(1))
            guard text.isEmpty || count <= FormulaLimits.maxStringLength / text.count else {
                throw FormulaError.invalidArgument(name, "result longer than \(FormulaLimits.maxStringLength) characters")
            }
            return .string(String(repeating: text, count: count))
        case "padStart", "padEnd":
            var text = try s(0)
            let len = try int(1)
            guard len <= FormulaLimits.maxStringLength else {
                throw FormulaError.invalidArgument(name, "result longer than \(FormulaLimits.maxStringLength) characters")
            }
            let pad = args.count > 2 ? str(args[2]) : " "
            let needed = len - text.count
            guard !pad.isEmpty, needed > 0 else { return .string(text) }
            let padding = String(String(repeating: pad, count: needed / pad.count + 1).prefix(needed))
            text = name == "padStart" ? padding + text : text + padding
            return .string(text)
        case "link": return .string(try s(0))
        case "style", "unstyle": return .string(try s(0))
        case "format", "toString": return .string(str(try arg(0)))
        case "toNumber":
            let v = try arg(0)
            if case .date(let dt) = v { return .number(dt.start.timeIntervalSince1970 * 1000) }
            if case .bool(let b) = v { return .number(b ? 1 : 0) }
            if case .number = v { return v }
            let digits = str(v).trimmingCharacters(in: .whitespaces)
            if let x = Double(digits) { return .number(x) }
            // Notion parses a leading number ("12 apples" → 12)
            let prefix = digits.prefix { $0.isNumber || $0 == "." || $0 == "-" }
            return Double(prefix).map(Value.number) ?? .empty
        case "split":
            let sep = args.count > 1 ? str(args[1]) : ""
            let text = try s(0)
            if sep.isEmpty { return .list(text.map { .string(String($0)) }) }
            return .list(text.components(separatedBy: sep).map(Value.string))
        case "join":
            let sep = args.count > 1 ? str(args[1]) : ""
            return .string(try arg(0).list.map(str).joined(separator: sep))
        case "concat": return .list(args.flatMap { $0.list })
        case "add": return try binary("+", try arg(0), try arg(1))
        case "subtract": return .number(try n(0) - (try n(1)))
        case "multiply": return .number(try n(0) * (try n(1)))
        case "divide":
            let d = try n(1)
            guard d != 0 else { throw FormulaError.divisionByZero }
            return .number(try n(0) / d)
        case "pow": return .number(pow(try n(0), try n(1)))
        case "mod":
            let d = try n(1)
            guard d != 0 else { throw FormulaError.divisionByZero }
            return .number(fmod(try n(0), d))
        case "equal": return .bool(equal(try arg(0), try arg(1)))
        case "unequal": return .bool(!equal(try arg(0), try arg(1)))
        case "larger": return try binary(">", try arg(0), try arg(1))
        case "largerEq": return try binary(">=", try arg(0), try arg(1))
        case "smaller": return try binary("<", try arg(0), try arg(1))
        case "smallerEq": return try binary("<=", try arg(0), try arg(1))
        case "abs": return .number(abs(try n(0)))
        case "ceil": return .number((try n(0)).rounded(.up))
        case "floor": return .number((try n(0)).rounded(.down))
        case "exp": return .number(Foundation.exp(try n(0)))
        case "ln": return .number(Foundation.log(try n(0)))
        case "log10": return .number(Foundation.log10(try n(0)))
        case "log2": return .number(Foundation.log2(try n(0)))
        case "sqrt": return .number((try n(0)).squareRoot())
        case "cbrt": return .number(Foundation.cbrt(try n(0)))
        case "sign": let x = try n(0); return .number(x > 0 ? 1 : (x < 0 ? -1 : 0))
        case "pi": return .number(Double.pi)
        case "e": return .number(M_E)
        case "round":
            let x = try n(0)
            let places = args.count > 1 ? try n(1) : 0
            let f = pow(10, places)
            return .number((x * f).rounded(.toNearestOrAwayFromZero) / f)
        case "max", "min":
            let xs = try numbers()
            guard !xs.isEmpty else { return .empty }
            return .number(name == "max" ? xs.max()! : xs.min()!)
        case "sum": return .number(try numbers().reduce(0, +))
        case "mean":
            let xs = try numbers()
            return xs.isEmpty ? .empty : .number(xs.reduce(0, +) / Double(xs.count))
        case "median":
            let xs = try numbers().sorted()
            guard !xs.isEmpty else { return .empty }
            return .number(xs.count % 2 == 1 ? xs[xs.count / 2] : (xs[xs.count / 2 - 1] + xs[xs.count / 2]) / 2)
        case "now": return .date(DateValue(start: env.now, includeTime: true))
        case "today": return .date(DateValue(start: cal.startOfDay(for: env.now)))
        case "minute": return .number(Double(cal.component(.minute, from: try d(0).start)))
        case "hour": return .number(Double(cal.component(.hour, from: try d(0).start)))
        case "day":
            let wd = cal.component(.weekday, from: try d(0).start) // 1 = Sunday
            return .number(Double(wd == 1 ? 7 : wd - 1))           // 1 = Monday … 7 = Sunday
        case "date": return .number(Double(cal.component(.day, from: try d(0).start)))
        case "week":
            var iso = Calendar(identifier: .iso8601); iso.timeZone = cal.timeZone
            return .number(Double(iso.component(.weekOfYear, from: try d(0).start)))
        case "month": return .number(Double(cal.component(.month, from: try d(0).start)))
        case "year": return .number(Double(cal.component(.year, from: try d(0).start)))
        case "dateAdd", "dateSubtract":
            var dv = try d(0)
            let amount = try int(1) * (name == "dateSubtract" ? -1 : 1)
            let unit = try component(try s(2))
            // |amount| ≤ 1e9 and unit.1 ≤ 1e6, so the product can't overflow; keep the shift within ±~30 000 years.
            let secondsPerUnit: Double = [.year: 31_556_952, .month: 2_629_746, .day: 86_400, .hour: 3_600,
                                          .minute: 60, .second: 1, .nanosecond: 1e-9][unit.0] ?? 1
            guard abs(Double(amount * unit.1) * secondsPerUnit) <= 1e12 else {
                throw FormulaError.invalidArgument(name, "amount out of range")
            }
            dv.start = cal.date(byAdding: unit.0, value: amount * unit.1, to: dv.start) ?? dv.start
            if let e = dv.end { dv.end = cal.date(byAdding: unit.0, value: amount * unit.1, to: e) }
            if unit.0 == .hour || unit.0 == .minute || unit.0 == .second { dv.includeTime = true }
            return .date(dv)
        case "dateBetween":
            let a = try d(0).start, b = try d(1).start
            let unit = try component(try s(2))
            if unit.0 == .second || unit.0 == .minute || unit.0 == .hour || unit.0 == .day {
                let secs = a.timeIntervalSince(b)
                let per: Double = [Calendar.Component.second: 1, .minute: 60, .hour: 3600, .day: 86400][unit.0]! * Double(unit.1)
                return .number((secs / per).rounded(.towardZero))
            }
            let comps = cal.dateComponents([unit.0], from: b, to: a)
            let v = comps.value(for: unit.0) ?? 0
            return .number(Double(v / unit.1))
        case "dateRange":
            let a = try d(0), b = try d(1)
            return .date(DateValue(start: a.start, end: b.start, includeTime: a.includeTime || b.includeTime))
        case "dateStart", "start":
            let dv = try d(0)
            return .date(DateValue(start: dv.start, includeTime: dv.includeTime))
        case "dateEnd", "end":
            let dv = try d(0)
            return .date(DateValue(start: dv.end ?? dv.start, includeTime: dv.includeTime))
        case "timestamp": return .number((try d(0)).start.timeIntervalSince1970 * 1000)
        case "fromTimestamp": return .date(DateValue(start: Date(timeIntervalSince1970: try n(0) / 1000), includeTime: true))
        case "formatDate":
            let dv = try d(0)
            return .string(DateDisplay.format(dv.start, moment: args.count > 1 ? str(args[1]) : "MMMM D, YYYY"))
        case "parseDate":
            guard let dv = DateParsing.parse(try s(0)) else { throw FormulaError("parseDate() could not read “\(try s(0))”") }
            return .date(dv)
        case "name":
            let v = try arg(0)
            if case .list(let l) = v { return .list(l.map { if case .person(let p) = $0 { return .string(env.personName(p)) }; return $0 }) }
            if case .person(let p) = v { return .string(env.personName(p)) }
            if case .page(let pid) = v { return .string(env.pageTitle(pid)) }
            return .string(str(v))
        case "email":
            let v = try arg(0)
            if case .person(let p) = v { return .string(env.personEmail(p)) }
            if case .list(let l) = v { return .list(l.map { if case .person(let p) = $0 { return .string(env.personEmail(p)) }; return .empty }) }
            return .empty
        case "id":
            if args.isEmpty { return .string(env.currentPage ?? "") }
            if case .page(let pid) = args[0] { return .string(pid) }
            return .string(str(args[0]))
        case "at":
            let l = try arg(0).list
            var i = try int(1)
            if i < 0 { i += l.count }
            return i >= 0 && i < l.count ? l[i] : .empty
        case "first": return try arg(0).list.first ?? .empty
        case "last": return try arg(0).list.last ?? .empty
        case "slice":
            let l = try arg(0).list
            var a = try int(1); if a < 0 { a += l.count }
            var b = args.count > 2 ? try int(2) : l.count; if b < 0 { b += l.count }
            a = max(0, min(a, l.count)); b = max(a, min(b, l.count))
            return .list(Array(l[a..<b]))
        case "splice":
            var l = try arg(0).list
            let a = max(0, min(try int(1), l.count))
            let count = args.count > 2 ? max(0, min(try int(2), l.count - a)) : l.count - a
            l.removeSubrange(a..<(a + count))
            l.insert(contentsOf: args.dropFirst(3), at: a)
            return .list(l)
        case "sort": return .list(try arg(0).list.sorted { Value.compare($0, $1) == .orderedAscending })
        case "reverse": return .list(try arg(0).list.reversed())
        case "unique":
            var seen: [Value] = []
            for v in try arg(0).list where !seen.contains(where: { equal($0, v) }) { seen.append(v) }
            return .list(seen)
        case "flat": return .list(try arg(0).list.flatMap { $0.list })
        default:
            args.removeAll()
            throw FormulaError("Unknown function “\(name)”")
        }
    }

    func component(_ unit: String) throws -> (Calendar.Component, Int) {
        switch unit.lowercased() {
        case "years", "year", "y": return (.year, 1)
        case "quarters", "quarter", "q": return (.month, 3)
        case "months", "month", "m": return (.month, 1)
        case "weeks", "week", "w": return (.day, 7)
        case "days", "day", "d": return (.day, 1)
        case "hours", "hour", "h": return (.hour, 1)
        case "minutes", "minute": return (.minute, 1)
        case "seconds", "second", "s": return (.second, 1)
        case "milliseconds", "millisecond", "ms": return (.nanosecond, 1_000_000)
        default: throw FormulaError("Unknown date unit “\(unit)”")
        }
    }

    func regex(_ p: String) throws -> NSRegularExpression {
        do { return try NSRegularExpression(pattern: p) } catch { throw FormulaError("Invalid regular expression") }
    }
    func nsRange(_ s: String) -> NSRange { NSRange(s.startIndex..., in: s) }
}