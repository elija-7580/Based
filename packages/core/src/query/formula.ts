// Notion-Formeln, portiert aus BasedCore Query/Formula.swift (Lexer, Parser, Auswertung, absturzsicher: BSD-17).
// Fehlermeldungen wörtlich wie in Swift. Verifiziert über fixtures/formulas/*.json (BSD-172).
import {
  addCalendar, asList, asNumber, bool, compareValues, date, describe, EMPTY, formatMoment, fromJSDate, isEmptyValue,
  isoWeek, list, monthsBetween, num, parseDate, parseSwiftDouble, plainNumber, sameValue, startOfDay, str, toJSDate,
  truthy, typeName, unixMillis, type CalendarUnit, type DateValue, type Value,
} from "./value.js";

export type FormulaErrorKind = "general" | "invalidArgument" | "divisionByZero" | "cycle" | "tooDeep";

export class FormulaError extends Error {
  constructor(message: string, readonly kind: FormulaErrorKind = "general") {
    super(message);
    this.name = "FormulaError";
  }
  static invalidArgument(fn: string, detail: string) {
    return new FormulaError(`${fn}(): ${detail}`, "invalidArgument");
  }
  static divisionByZero() {
    return new FormulaError("Division by zero", "divisionByZero");
  }
}

const MAX_INT = 1_000_000_000;
const MAX_STRING = 100_000;

function formulaInt(d: number, fn: string): number {
  if (!Number.isFinite(d)) throw FormulaError.invalidArgument(fn, "expected a finite number");
  if (Math.abs(d) > MAX_INT) throw FormulaError.invalidArgument(fn, "number out of range");
  return Math.trunc(d);
}

// MARK: Graphem-Hilfen (Swift zählt Characters)

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => [...segmenter.segment(s)].map((x) => x.segment);
const isLetter = (c: string) => /^\p{L}/u.test(c);
const isNumberChar = (c: string) => /^\p{N}/u.test(c);
const isWhitespace = (c: string) => /^[\s\u0085\u2028\u2029]/u.test(c);

// MARK: Lexer

type Token = { k: "number"; v: number } | { k: "string"; v: string } | { k: "ident"; v: string } | { k: "op"; v: string } | { k: "eof" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const chars = graphemes(src);
  const ops2 = new Set(["==", "!=", ">=", "<=", "&&", "||", "**"]);
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (isWhitespace(c)) { i++; continue; }
    if (c === "/" && chars[i + 1] === "*") {
      i += 2;
      while (i + 1 < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (isNumberChar(c) || (c === "." && i + 1 < chars.length && isNumberChar(chars[i + 1]!))) {
      let j = i;
      while (j < chars.length && (isNumberChar(chars[j]!) || chars[j] === ".")) j++;
      if (j < chars.length && (chars[j] === "e" || chars[j] === "E") && j + 1 < chars.length &&
          (isNumberChar(chars[j + 1]!) || ((chars[j + 1] === "-" || chars[j + 1] === "+") && j + 2 < chars.length && isNumberChar(chars[j + 2]!)))) {
        j += 2;
        while (j < chars.length && isNumberChar(chars[j]!)) j++;
      }
      const n = parseSwiftDouble(chars.slice(i, j).join(""));
      if (n === undefined) throw new FormulaError("Invalid number");
      out.push({ k: "number", v: n });
      i = j;
      continue;
    }
    if (c === "\"" || c === "'" || c === "“") {
      const close = c === "“" ? "”" : c;
      let s = "";
      let j = i + 1;
      let closed = false;
      while (j < chars.length) {
        const d = chars[j]!;
        if (d === "\\" && j + 1 < chars.length) {
          const n = chars[j + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
          continue;
        }
        if (d === close) { closed = true; j++; break; }
        s += d;
        j++;
      }
      if (!closed) throw new FormulaError("Unterminated string");
      out.push({ k: "string", v: s });
      i = j;
      continue;
    }
    if (isLetter(c) || c === "_") {
      let j = i;
      while (j < chars.length && (isLetter(chars[j]!) || isNumberChar(chars[j]!) || chars[j] === "_")) j++;
      out.push({ k: "ident", v: chars.slice(i, j).join("") });
      i = j;
      continue;
    }
    if (i + 1 < chars.length && ops2.has(c + chars[i + 1])) {
      const o = c + chars[i + 1];
      out.push({ k: "op", v: o === "**" ? "^" : o });
      i += 2;
      continue;
    }
    if ("+-*/%^()[],.?:<>!=".includes(c) && c.length === 1) { out.push({ k: "op", v: c }); i++; continue; }
    if (c === "≥") { out.push({ k: "op", v: ">=" }); i++; continue; }
    if (c === "≤") { out.push({ k: "op", v: "<=" }); i++; continue; }
    if (c === "≠") { out.push({ k: "op", v: "!=" }); i++; continue; }
    throw new FormulaError(`Unexpected character “${c}”`);
  }
  out.push({ k: "eof" });
  return out;
}

// MARK: AST + Parser

export type FormulaExpr =
  | { k: "number"; v: number }
  | { k: "string"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "list"; items: FormulaExpr[] }
  | { k: "ident"; name: string }
  | { k: "call"; name: string; args: FormulaExpr[] }
  | { k: "unary"; op: string; x: FormulaExpr }
  | { k: "binary"; op: string; a: FormulaExpr; b: FormulaExpr }
  | { k: "ternary"; c: FormulaExpr; a: FormulaExpr; b: FormulaExpr };

/** Über prop("…") benutzte Property-Namen. */
export function referencedProperties(e: FormulaExpr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case "call":
      if (e.name === "prop" && e.args[0]?.k === "string") out.add(e.args[0].v);
      e.args.forEach((a) => referencedProperties(a, out));
      break;
    case "list": e.items.forEach((a) => referencedProperties(a, out)); break;
    case "unary": referencedProperties(e.x, out); break;
    case "binary": referencedProperties(e.a, out); referencedProperties(e.b, out); break;
    case "ternary": referencedProperties(e.c, out); referencedProperties(e.a, out); referencedProperties(e.b, out); break;
  }
  return out;
}

class Parser {
  pos = 0;
  constructor(private readonly tokens: Token[]) {}

  static parse(src: string): FormulaExpr {
    const p = new Parser(tokenize(src));
    if ((p.peek as Token).k === "eof") return { k: "string", v: "" };
    const e = p.expression();
    if ((p.peek as Token).k !== "eof") throw new FormulaError(`Unexpected ${p.describe(p.peek)}`);
    return e;
  }

  get peek(): Token {
    return this.tokens[this.pos]!;
  }
  next(): Token {
    const t = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  describe(t: Token): string {
    switch (t.k) {
      case "number": return `number ${plainNumber(t.v)}`;
      case "string": return `"${t.v}"`;
      case "ident": return t.v;
      case "op": return `“${t.v}”`;
      case "eof": return "end of formula";
    }
  }
  expect(o: string) {
    const t = this.next();
    if (t.k !== "op" || t.v !== o) throw new FormulaError(`Expected “${o}”`);
  }
  accept(o: string): boolean {
    const t = this.peek;
    if (t.k === "op" && t.v === o) { this.pos++; return true; }
    return false;
  }
  acceptWord(w: string): boolean {
    const t = this.peek;
    if (t.k === "ident" && t.v === w) { this.pos++; return true; }
    return false;
  }

  expression(): FormulaExpr {
    return this.ternary();
  }
  ternary(): FormulaExpr {
    const c = this.orExpr();
    if (this.accept("?")) {
      const a = this.expression();
      this.expect(":");
      const b = this.expression();
      return { k: "ternary", c, a, b };
    }
    return c;
  }
  orExpr(): FormulaExpr {
    let l = this.andExpr();
    while (this.accept("||") || this.acceptWord("or")) l = { k: "binary", op: "or", a: l, b: this.andExpr() };
    return l;
  }
  andExpr(): FormulaExpr {
    let l = this.equality();
    while (this.accept("&&") || this.acceptWord("and")) l = { k: "binary", op: "and", a: l, b: this.equality() };
    return l;
  }
  equality(): FormulaExpr {
    let l = this.comparison();
    for (;;) {
      if (this.accept("==")) l = { k: "binary", op: "==", a: l, b: this.comparison() };
      else if (this.accept("!=")) l = { k: "binary", op: "!=", a: l, b: this.comparison() };
      else return l;
    }
  }
  comparison(): FormulaExpr {
    let l = this.additive();
    for (;;) {
      const op = [">=", "<=", ">", "<"].find((o) => this.accept(o));
      if (!op) return l;
      l = { k: "binary", op, a: l, b: this.additive() };
    }
  }
  additive(): FormulaExpr {
    let l = this.multiplicative();
    for (;;) {
      const op = ["+", "-"].find((o) => this.accept(o));
      if (!op) return l;
      l = { k: "binary", op, a: l, b: this.multiplicative() };
    }
  }
  multiplicative(): FormulaExpr {
    let l = this.unary();
    for (;;) {
      const op = ["*", "/", "%"].find((o) => this.accept(o));
      if (!op) return l;
      l = { k: "binary", op, a: l, b: this.unary() };
    }
  }
  unary(): FormulaExpr {
    if (this.accept("-")) return { k: "unary", op: "-", x: this.unary() };
    if (this.accept("+")) return this.unary();
    if (this.accept("!") || this.acceptWord("not")) return { k: "unary", op: "not", x: this.unary() };
    return this.power();
  }
  power(): FormulaExpr {
    const base = this.postfix();
    if (this.accept("^")) return { k: "binary", op: "^", a: base, b: this.unary() };
    return base;
  }
  postfix(): FormulaExpr {
    let e = this.primary();
    for (;;) {
      if (this.accept(".")) {
        const t = this.next();
        if (t.k !== "ident") throw new FormulaError("Expected a function name after “.”");
        const args: FormulaExpr[] = [e];
        if (this.accept("(")) args.push(...this.arguments());
        e = { k: "call", name: t.v, args };
      } else if (this.peek.k === "op" && (this.peek as { v: string }).v === "[" && this.pos > 0) {
        this.next();
        const idx = this.expression();
        this.expect("]");
        e = { k: "call", name: "at", args: [e, idx] };
      } else return e;
    }
  }
  arguments(): FormulaExpr[] {
    const args: FormulaExpr[] = [];
    if (this.accept(")")) return args;
    do args.push(this.expression()); while (this.accept(","));
    this.expect(")");
    return args;
  }
  primary(): FormulaExpr {
    const t = this.next();
    switch (t.k) {
      case "number": return { k: "number", v: t.v };
      case "string": return { k: "string", v: t.v };
      case "ident":
        if (t.v === "true") return { k: "bool", v: true };
        if (t.v === "false") return { k: "bool", v: false };
        if (this.accept("(")) return { k: "call", name: t.v, args: this.arguments() };
        return { k: "ident", name: t.v };
      case "op":
        if (t.v === "(") {
          const e = this.expression();
          this.expect(")");
          return e;
        }
        if (t.v === "[") {
          const items: FormulaExpr[] = [];
          if (!this.accept("]")) {
            do items.push(this.expression()); while (this.accept(","));
            this.expect("]");
          }
          return { k: "list", items };
        }
    }
    throw new FormulaError(`Unexpected ${this.describe(t)}`);
  }
}

// MARK: Auswertung

export interface FormulaEnvironment {
  /** Wert einer Property der aktuellen Zeile, nach Name. */
  prop(name: string): Value;
  /** Wert einer Property einer anderen Seite (Relationen). */
  pageProp?(page: string, name: string): Value;
  pageTitle?(id: string): string;
  personName?(id: string): string;
  personEmail?(id: string): string;
  currentPage?: string;
  /** Jetzt, als Swift-Datum (Sekunden seit 2001). */
  now: number;
}

export const FUNCTION_NAMES = [
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
].sort();

/** Swift `round(.toNearestOrAwayFromZero)`. */
const roundHalfAway = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x)) || 0;
/** fmod: Rest mit dem Vorzeichen des Dividenden (wie JS %). */
const fmod = (a: number, b: number) => a % b;

/** JS-RegExp aus einem ICU-Muster (NSRegularExpression); Unicode-Modus wie ICU. */
function regex(p: string, global = false): RegExp {
  try {
    return new RegExp(p, global ? "gu" : "u");
  } catch {
    try {
      return new RegExp(p, global ? "g" : "");
    } catch {
      throw new FormulaError("Invalid regular expression");
    }
  }
}

/** NSRegularExpression-Vorlage: `$n` = Gruppe n, `\x` = x wörtlich. */
function expandTemplate(template: string, m: RegExpExecArray): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === "\\" && i + 1 < template.length) { out += template[++i]; continue; }
    if (c === "$" && /\d/.test(template[i + 1] ?? "")) {
      let digits = template[++i]!;
      while (/\d/.test(template[i + 1] ?? "") && Number(digits + template[i + 1]) < m.length) digits += template[++i];
      out += m[Number(digits)] ?? "";
      continue;
    }
    out += c;
  }
  return out;
}

function unitOf(unit: string): [CalendarUnit, number] {
  switch (unit.toLowerCase()) {
    case "years": case "year": case "y": return ["year", 1];
    case "quarters": case "quarter": case "q": return ["month", 3];
    case "months": case "month": case "m": return ["month", 1];
    case "weeks": case "week": case "w": return ["day", 7];
    case "days": case "day": case "d": return ["day", 1];
    case "hours": case "hour": case "h": return ["hour", 1];
    case "minutes": case "minute": return ["minute", 1];
    case "seconds": case "second": case "s": return ["second", 1];
    case "milliseconds": case "millisecond": case "ms": return ["nanosecond", 1_000_000];
    default: throw new FormulaError(`Unknown date unit “${unit}”`);
  }
}

class Evaluator {
  scopes: Map<string, Value>[] = [];
  depth = 0;
  constructor(readonly env: FormulaEnvironment) {}

  lookup(name: string): Value | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i]!.get(name);
      if (v) return v;
    }
    return undefined;
  }

  eval(e: FormulaExpr): Value {
    this.depth++;
    try {
      if (this.depth >= 200) throw new FormulaError("Formula is too deeply nested");
      switch (e.k) {
        case "number": return num(e.v);
        case "string": return str(e.v);
        case "bool": return bool(e.v);
        case "list": return list(e.items.map((x) => this.eval(x)));
        case "ident": {
          const v = this.lookup(e.name);
          if (v) return v;
          if (e.name === "pi") return num(Math.PI);
          if (e.name === "e") return num(Math.E);
          if (e.name === "current" || e.name === "index") throw new FormulaError(`“${e.name}” can only be used inside map, filter and similar`);
          throw new FormulaError(`Unknown name “${e.name}”`);
        }
        case "unary": {
          const v = this.eval(e.x);
          if (e.op === "-") return num(-this.num(v, "-"));
          return bool(!truthy(v));
        }
        case "ternary": return truthy(this.eval(e.c)) ? this.eval(e.a) : this.eval(e.b);
        case "binary":
          if (e.op === "and") return bool(truthy(this.eval(e.a)) && truthy(this.eval(e.b)));
          if (e.op === "or") return bool(truthy(this.eval(e.a)) || truthy(this.eval(e.b)));
          return this.binary(e.op, this.eval(e.a), this.eval(e.b));
        case "call": return this.call(e.name, e.args);
      }
    } finally {
      this.depth--;
    }
  }

  num(v: Value, fn: string): number {
    switch (v.t) {
      case "number": return v.v;
      case "bool": return v.v ? 1 : 0;
      case "empty": return 0;
      default: throw new FormulaError(`${fn} expects a number, got ${typeName(v)}`);
    }
  }

  date(v: Value, fn: string): DateValue {
    if (v.t === "date") return v.v;
    if (v.t === "list" && v.v[0]?.t === "date") return v.v[0].v;
    throw new FormulaError(`${fn} expects a date, got ${typeName(v)}`);
  }

  equal(a: Value, b: Value): boolean {
    if (a.t === "number" && b.t === "number") return a.v === b.v;
    if (a.t === "date" && b.t === "date") return a.v.start === b.v.start && a.v.end === b.v.end;
    if (a.t === "empty") return isEmptyValue(b);
    if (b.t === "empty") return isEmptyValue(a);
    return sameValue(a, b);
  }

  binary(op: string, a: Value, b: Value): Value {
    switch (op) {
      case "+":
        if (a.t === "number" && b.t === "number") return num(a.v + b.v);
        if (a.t === "string" || b.t === "string") return str(describe(a) + describe(b));
        if (a.t === "list" && b.t === "list") return list([...a.v, ...b.v]);
        return num(this.num(a, "+") + this.num(b, "+"));
      case "-": return num(this.num(a, "-") - this.num(b, "-"));
      case "*": return num(this.num(a, "*") * this.num(b, "*"));
      case "/": {
        const d = this.num(b, "/");
        if (d === 0) throw FormulaError.divisionByZero();
        return num(this.num(a, "/") / d);
      }
      case "%": {
        const d = this.num(b, "%");
        if (d === 0) throw FormulaError.divisionByZero();
        return num(fmod(this.num(a, "%"), d));
      }
      case "^": return num(Math.pow(this.num(a, "^"), this.num(b, "^")));
      case "==": return bool(this.equal(a, b));
      case "!=": return bool(!this.equal(a, b));
      case ">": return bool(compareValues(a, b) > 0);
      case "<": return bool(compareValues(a, b) < 0);
      case ">=": return bool(compareValues(a, b) >= 0);
      case "<=": return bool(compareValues(a, b) <= 0);
      default: throw new FormulaError(`Unknown operator ${op}`);
    }
  }

  each(items: Value[], body: FormulaExpr, f: (i: number, item: Value, r: Value) => boolean) {
    for (let i = 0; i < items.length; i++) {
      this.scopes.push(new Map([["current", items[i]!], ["index", num(i)]]));
      let r: Value;
      try {
        r = this.eval(body);
      } finally {
        this.scopes.pop();
      }
      if (!f(i, items[i]!, r)) break;
    }
  }

  call(name: string, argExprs: FormulaExpr[]): Value {
    // Lazy-Formen zuerst.
    switch (name) {
      case "if":
        if (argExprs.length !== 3) throw new FormulaError("if() takes 3 arguments");
        return truthy(this.eval(argExprs[0]!)) ? this.eval(argExprs[1]!) : this.eval(argExprs[2]!);
      case "ifs": {
        let i = 0;
        while (i + 1 < argExprs.length) {
          if (truthy(this.eval(argExprs[i]!))) return this.eval(argExprs[i + 1]!);
          i += 2;
        }
        return i < argExprs.length ? this.eval(argExprs[i]!) : EMPTY;
      }
      case "and":
        for (const a of argExprs) if (!truthy(this.eval(a))) return bool(false);
        return bool(true);
      case "or":
        for (const a of argExprs) if (truthy(this.eval(a))) return bool(true);
        return bool(false);
      case "let": {
        const v = argExprs[0];
        if (argExprs.length !== 3 || v?.k !== "ident") throw new FormulaError("let(name, value, expression)");
        const value = this.eval(argExprs[1]!);
        this.scopes.push(new Map([[v.name, value]]));
        try {
          return this.eval(argExprs[2]!);
        } finally {
          this.scopes.pop();
        }
      }
      case "lets": {
        if (argExprs.length < 3 || argExprs.length % 2 !== 1) throw new FormulaError("lets(name, value, …, expression)");
        const scope = new Map<string, Value>();
        this.scopes.push(scope);
        try {
          for (let i = 0; i + 1 < argExprs.length; i += 2) {
            const v = argExprs[i]!;
            if (v.k !== "ident") throw new FormulaError("lets() expects variable names");
            scope.set(v.name, this.eval(argExprs[i + 1]!));
          }
          return this.eval(argExprs[argExprs.length - 1]!);
        } finally {
          this.scopes.pop();
        }
      }
      case "map": case "filter": case "find": case "findIndex": case "some": case "every": case "count": case "sortBy": {
        const first = argExprs[0];
        if (!first) throw new FormulaError(`${name}() needs a list`);
        const items = asList(this.eval(first));
        if (argExprs.length < 2) {
          if (name === "count") return num(items.length);
          throw new FormulaError(`${name}() needs an expression`);
        }
        const body = argExprs[1]!;
        switch (name) {
          case "map": { const out: Value[] = []; this.each(items, body, (_i, _x, r) => { out.push(r); return true; }); return list(out); }
          case "filter": { const out: Value[] = []; this.each(items, body, (_i, x, r) => { if (truthy(r)) out.push(x); return true; }); return list(out); }
          case "count": { let n = 0; this.each(items, body, (_i, _x, r) => { if (truthy(r)) n++; return true; }); return num(n); }
          case "find": { let found: Value = EMPTY; this.each(items, body, (_i, x, r) => { if (truthy(r)) { found = x; return false; } return true; }); return found; }
          case "findIndex": { let idx = -1; this.each(items, body, (i, _x, r) => { if (truthy(r)) { idx = i; return false; } return true; }); return num(idx); }
          case "some": { let any = false; this.each(items, body, (_i, _x, r) => { if (truthy(r)) { any = true; return false; } return true; }); return bool(any); }
          case "every": { let all = true; this.each(items, body, (_i, _x, r) => { if (!truthy(r)) { all = false; return false; } return true; }); return bool(all); }
          default: {
            const keyed: [Value, Value][] = [];
            this.each(items, body, (_i, x, r) => { keyed.push([r, x]); return true; });
            return list(stableSort(keyed, (a, b) => compareValues(a[0], b[0])).map((k) => k[1]));
          }
        }
      }
    }

    const args = argExprs.map((a) => this.eval(a));
    const arg = (i: number): Value => {
      if (i >= args.length) throw new FormulaError(`${name}() is missing an argument`);
      return args[i]!;
    };
    const n = (i: number) => this.num(arg(i), name);
    const int = (i: number) => formulaInt(n(i), name);
    const s = (i: number) => describe(arg(i));
    const d = (i: number) => this.date(arg(i), name);
    const numbers = () => args.flatMap(asList).filter((v) => !isEmptyValue(v)).map((v) => this.num(v, name));
    const local = (i: number) => toJSDate(d(i).start);

    switch (name) {
      case "prop":
        if (args.length === 2 && args[0]!.t === "page") return this.env.pageProp?.(args[0]!.v, s(1)) ?? EMPTY;
        return this.env.prop(s(0));
      case "not": return bool(!truthy(arg(0)));
      case "empty": return bool(args.length === 0 ? true : isEmptyValue(args[0]!));
      case "length": {
        const v = arg(0);
        if (v.t === "list") return num(v.v.length);
        return num(graphemes(describe(v)).length);
      }
      case "substring": {
        const chars = graphemes(s(0));
        const a = Math.max(0, Math.min(chars.length, int(1)));
        const b = args.length > 2 ? Math.max(a, Math.min(chars.length, int(2))) : chars.length;
        return str(chars.slice(a, b).join(""));
      }
      case "contains": {
        const v = arg(0);
        const needle = args.length > 1 ? args[1]! : EMPTY;
        if (v.t === "list") return bool(v.v.some((x) => this.equal(x, needle) || describe(x) === describe(needle)));
        return bool(describe(v).includes(s(1)));
      }
      case "includes": {
        const needle = arg(1);
        return bool(asList(arg(0)).some((x) => this.equal(x, needle)));
      }
      case "test": {
        const text = s(0);
        return bool(regex(s(1)).test(text));
      }
      case "match": {
        const text = s(0);
        return list([...text.matchAll(regex(s(1), true))].map((m) => str(m[0])));
      }
      case "replace": case "replaceAll": {
        const text = s(0);
        const re = regex(s(1), name === "replaceAll");
        const template = args.length > 2 ? describe(args[2]!).replaceAll("\\", "\\\\") : "";
        if (name === "replaceAll") return str(text.replace(re, (...m) => expandTemplate(template, matchArray(m))));
        const m = re.exec(text);
        if (!m) return str(text);
        return str(text.slice(0, m.index) + expandTemplate(template, m) + text.slice(m.index + m[0].length));
      }
      case "lower": return str(s(0).toLowerCase());
      case "upper": return str(s(0).toUpperCase());
      case "trim": return str(s(0).trim());
      case "repeat": {
        const text = s(0);
        const count = Math.max(0, int(1));
        const len = graphemes(text).length;
        if (len !== 0 && count > Math.floor(MAX_STRING / len)) throw FormulaError.invalidArgument(name, `result longer than ${MAX_STRING} characters`);
        return str(text.repeat(count));
      }
      case "padStart": case "padEnd": {
        const text = s(0);
        const len = int(1);
        if (len > MAX_STRING) throw FormulaError.invalidArgument(name, `result longer than ${MAX_STRING} characters`);
        const pad = args.length > 2 ? describe(args[2]!) : " ";
        const padChars = graphemes(pad);
        const needed = len - graphemes(text).length;
        if (padChars.length === 0 || needed <= 0) return str(text);
        const padding = graphemes(pad.repeat(Math.floor(needed / padChars.length) + 1)).slice(0, needed).join("");
        return str(name === "padStart" ? padding + text : text + padding);
      }
      case "link": case "style": case "unstyle": return str(s(0));
      case "format": case "toString": return str(describe(arg(0)));
      case "toNumber": {
        const v = arg(0);
        if (v.t === "date") return num(unixMillis(v.v.start));
        if (v.t === "bool") return num(v.v ? 1 : 0);
        if (v.t === "number") return v;
        const digits = describe(v).replace(/^[ \t]+|[ \t]+$/g, "");
        const x = parseSwiftDouble(digits);
        if (x !== undefined) return num(x);
        let prefix = "";
        for (const c of graphemes(digits)) {
          if (isNumberChar(c) || c === "." || c === "-") prefix += c;
          else break;
        }
        const p = parseSwiftDouble(prefix);
        return p === undefined ? EMPTY : num(p);
      }
      case "split": {
        const sep = args.length > 1 ? describe(args[1]!) : "";
        const text = s(0);
        if (sep === "") return list(graphemes(text).map(str));
        return list(text.split(sep).map(str));
      }
      case "join": {
        const sep = args.length > 1 ? describe(args[1]!) : "";
        return str(asList(arg(0)).map(describe).join(sep));
      }
      case "concat": return list(args.flatMap(asList));
      case "add": return this.binary("+", arg(0), arg(1));
      case "subtract": return num(n(0) - n(1));
      case "multiply": return num(n(0) * n(1));
      case "divide": {
        const dv = n(1);
        if (dv === 0) throw FormulaError.divisionByZero();
        return num(n(0) / dv);
      }
      case "pow": return num(Math.pow(n(0), n(1)));
      case "mod": {
        const dv = n(1);
        if (dv === 0) throw FormulaError.divisionByZero();
        return num(fmod(n(0), dv));
      }
      case "equal": return bool(this.equal(arg(0), arg(1)));
      case "unequal": return bool(!this.equal(arg(0), arg(1)));
      case "larger": return this.binary(">", arg(0), arg(1));
      case "largerEq": return this.binary(">=", arg(0), arg(1));
      case "smaller": return this.binary("<", arg(0), arg(1));
      case "smallerEq": return this.binary("<=", arg(0), arg(1));
      case "abs": return num(Math.abs(n(0)));
      case "ceil": return num(Math.ceil(n(0)));
      case "floor": return num(Math.floor(n(0)));
      case "exp": return num(Math.exp(n(0)));
      case "ln": return num(Math.log(n(0)));
      case "log10": return num(Math.log10(n(0)));
      case "log2": return num(Math.log2(n(0)));
      case "sqrt": return num(Math.sqrt(n(0)));
      case "cbrt": return num(Math.cbrt(n(0)));
      case "sign": { const x = n(0); return num(x > 0 ? 1 : x < 0 ? -1 : 0); }
      case "pi": return num(Math.PI);
      case "e": return num(Math.E);
      case "round": {
        const x = n(0);
        const places = args.length > 1 ? n(1) : 0;
        const f = Math.pow(10, places);
        return num(roundHalfAway(x * f) / f);
      }
      case "max": case "min": {
        const xs = numbers();
        if (xs.length === 0) return EMPTY;
        return num(name === "max" ? Math.max(...xs) : Math.min(...xs));
      }
      case "sum": return num(numbers().reduce((a, b) => a + b, 0));
      case "mean": { const xs = numbers(); return xs.length === 0 ? EMPTY : num(xs.reduce((a, b) => a + b, 0) / xs.length); }
      case "median": {
        const xs = numbers().sort((a, b) => a - b);
        if (xs.length === 0) return EMPTY;
        const h = Math.floor(xs.length / 2);
        return num(xs.length % 2 === 1 ? xs[h]! : (xs[h - 1]! + xs[h]!) / 2);
      }
      case "now": return date({ start: this.env.now, includeTime: true });
      case "today": return date({ start: startOfDay(this.env.now), includeTime: false });
      case "minute": return num(local(0).getMinutes());
      case "hour": return num(local(0).getHours());
      case "day": { const wd = local(0).getDay(); return num(wd === 0 ? 7 : wd); }
      case "date": return num(local(0).getDate());
      case "week": return num(isoWeek(d(0).start));
      case "month": return num(local(0).getMonth() + 1);
      case "year": return num(local(0).getFullYear());
      case "dateAdd": case "dateSubtract": {
        const dv = { ...d(0) };
        const amount = int(1) * (name === "dateSubtract" ? -1 : 1);
        const [unit, factor] = unitOf(s(2));
        const perUnit: Record<CalendarUnit, number> = { year: 31_556_952, month: 2_629_746, day: 86_400, hour: 3_600, minute: 60, second: 1, nanosecond: 1e-9 };
        if (Math.abs(amount * factor * perUnit[unit]) > 1e12) throw FormulaError.invalidArgument(name, "amount out of range");
        dv.start = addCalendar(dv.start, unit, amount * factor);
        if (dv.end !== undefined) dv.end = addCalendar(dv.end, unit, amount * factor);
        if (unit === "hour" || unit === "minute" || unit === "second") dv.includeTime = true;
        return date(dv);
      }
      case "dateBetween": {
        const a = d(0).start, b = d(1).start;
        const [unit, factor] = unitOf(s(2));
        if (unit === "second" || unit === "minute" || unit === "hour" || unit === "day") {
          const per = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit] * factor;
          return num(Math.trunc((a - b) / per) || 0);
        }
        if (unit === "year") return num(Math.trunc(Math.trunc(monthsBetween(b, a) / 12) / factor) || 0);
        if (unit === "month") return num(Math.trunc(monthsBetween(b, a) / factor) || 0);
        // Millisekunden: Nanosekunden-Komponente, durch 1e6 geteilt
        return num(Math.trunc(Math.round((a - b) * 1e9) / factor) || 0);
      }
      case "dateRange": {
        const a = d(0), b = d(1);
        return date({ start: a.start, end: b.start, includeTime: a.includeTime || b.includeTime });
      }
      case "dateStart": case "start": { const dv = d(0); return date({ start: dv.start, includeTime: dv.includeTime }); }
      case "dateEnd": case "end": { const dv = d(0); return date({ start: dv.end ?? dv.start, includeTime: dv.includeTime }); }
      case "timestamp": return num(unixMillis(d(0).start));
      case "fromTimestamp": return date({ start: fromJSDate(new Date(0)) + n(0) / 1000, includeTime: true });
      case "formatDate": return str(formatMoment(d(0).start, args.length > 1 ? describe(args[1]!) : "MMMM D, YYYY"));
      case "parseDate": {
        const dv = parseDate(s(0));
        if (!dv) throw new FormulaError(`parseDate() could not read “${s(0)}”`);
        return date(dv);
      }
      case "name": {
        const v = arg(0);
        const nm = (p: string) => this.env.personName?.(p) ?? p;
        if (v.t === "list") return list(v.v.map((x) => (x.t === "person" ? str(nm(x.v)) : x)));
        if (v.t === "person") return str(nm(v.v));
        if (v.t === "page") return str(this.env.pageTitle?.(v.v) ?? v.v);
        return str(describe(v));
      }
      case "email": {
        const v = arg(0);
        const em = (p: string) => this.env.personEmail?.(p) ?? "";
        if (v.t === "person") return str(em(v.v));
        if (v.t === "list") return list(v.v.map((x) => (x.t === "person" ? str(em(x.v)) : EMPTY)));
        return EMPTY;
      }
      case "id":
        if (args.length === 0) return str(this.env.currentPage ?? "");
        if (args[0]!.t === "page") return str(args[0]!.v);
        return str(describe(args[0]!));
      case "at": {
        const l = asList(arg(0));
        let i = int(1);
        if (i < 0) i += l.length;
        return i >= 0 && i < l.length ? l[i]! : EMPTY;
      }
      case "first": return asList(arg(0))[0] ?? EMPTY;
      case "last": { const l = asList(arg(0)); return l[l.length - 1] ?? EMPTY; }
      case "slice": {
        const l = asList(arg(0));
        let a = int(1); if (a < 0) a += l.length;
        let b = args.length > 2 ? int(2) : l.length; if (b < 0) b += l.length;
        a = Math.max(0, Math.min(a, l.length)); b = Math.max(a, Math.min(b, l.length));
        return list(l.slice(a, b));
      }
      case "splice": {
        const l = [...asList(arg(0))];
        const a = Math.max(0, Math.min(int(1), l.length));
        const count = args.length > 2 ? Math.max(0, Math.min(int(2), l.length - a)) : l.length - a;
        l.splice(a, count, ...args.slice(3));
        return list(l);
      }
      case "sort": return list(stableSort([...asList(arg(0))], compareValues));
      case "reverse": return list([...asList(arg(0))].reverse());
      case "unique": {
        const seen: Value[] = [];
        for (const v of asList(arg(0))) if (!seen.some((x) => this.equal(x, v))) seen.push(v);
        return list(seen);
      }
      case "flat": return list(asList(arg(0)).flatMap(asList));
      default:
        throw new FormulaError(`Unknown function “${name}”`);
    }
  }
}

function matchArray(m: unknown[]): RegExpExecArray {
  // String.replace-Callback: (match, g1…gn, offset, string[, groups]) → wie exec-Ergebnis
  const last = m[m.length - 1];
  const end = typeof last === "object" && last !== null ? m.length - 3 : m.length - 2;
  return m.slice(0, end) as unknown as RegExpExecArray;
}

function stableSort<T>(xs: T[], cmp: (a: T, b: T) => number): T[] {
  return xs.map((x, i) => [x, i] as const).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((x) => x[0]);
}

/** Geparste Formel, wiederverwendbar. */
export class Formula {
  readonly expr: FormulaExpr;
  constructor(readonly source: string) {
    this.expr = Parser.parse(source);
  }
  evaluate(env: FormulaEnvironment): Value {
    return new Evaluator(env).eval(this.expr);
  }
  static evaluate(source: string, env: FormulaEnvironment): Value {
    return new Formula(source).evaluate(env);
  }
}
