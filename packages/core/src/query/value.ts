// Berechnete Werte (Formeln, Filter, Sortierung), portiert aus BasedCore Query/Value.swift und den
// Datums-/Zahlen-Helfern (NumberFormatting, DateDisplay, DateParsing in Store/DatabaseOps.swift).
// Datum wie in Swift: Sekunden seit 2001-01-01; Kalenderrechnung in der lokalen Zeitzone (wie Calendar.current).
import { SWIFT_REFERENCE_DATE_UNIX_MS } from "../json.js";

export interface DateValue {
  start: number;
  end?: number;
  includeTime: boolean;
  remind?: boolean;
}

export type Value =
  | { t: "empty" }
  | { t: "string"; v: string; rich?: FormulaRun[] }
  | { t: "number"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "date"; v: DateValue }
  | { t: "list"; v: Value[] }
  | { t: "page"; v: string }
  | { t: "person"; v: string };

/**
 * BSD-9: Formatierung eines Formel-Texts (style/link). `v` bleibt der reine Text, sodass alles, was mit
 * Text rechnet, unverändert bleibt; die Zelle rendert `rich`, wenn vorhanden. Gleiche Marken wie Rich Text.
 */
export interface FormulaRun {
  t: string;
  m?: { b?: boolean; i?: boolean; u?: boolean; s?: boolean; c?: boolean; color?: string; link?: string };
}

export const EMPTY: Value = { t: "empty" };
export const str = (v: string): Value => ({ t: "string", v });
export const num = (v: number): Value => ({ t: "number", v });
export const bool = (v: boolean): Value => ({ t: "bool", v });
export const list = (v: Value[]): Value => ({ t: "list", v });
export const date = (v: DateValue): Value => ({ t: "date", v });

// MARK: Zeit

export const toJSDate = (swiftSeconds: number) => new Date(SWIFT_REFERENCE_DATE_UNIX_MS + swiftSeconds * 1000);
export const fromJSDate = (d: Date) => (d.getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;
export const unixMillis = (swiftSeconds: number) => SWIFT_REFERENCE_DATE_UNIX_MS + swiftSeconds * 1000;

// MARK: Eigenschaften

export function isEmptyValue(v: Value): boolean {
  switch (v.t) {
    case "empty": return true;
    case "string": return v.v.length === 0;
    case "list": return v.v.length === 0 || v.v.every(isEmptyValue);
    default: return false;
  }
}

export function typeName(v: Value): string {
  return { empty: "empty", string: "text", number: "number", bool: "boolean", date: "date", list: "list", page: "page", person: "person" }[v.t];
}

export function truthy(v: Value): boolean {
  switch (v.t) {
    case "empty": return false;
    case "bool": return v.v;
    case "number": return v.v !== 0;
    case "string": return v.v.length > 0;
    case "list": return v.v.length > 0;
    default: return true;
  }
}

export function asList(v: Value): Value[] {
  if (v.t === "list") return v.v;
  if (v.t === "empty") return [];
  return [v];
}

/** Swift `Value.number`. */
export function asNumber(v: Value): number | undefined {
  switch (v.t) {
    case "number": return v.v;
    case "bool": return v.v ? 1 : 0;
    case "string": return parseSwiftDouble(v.v.trim());
    case "date": return unixMillis(v.v.start);
    default: return undefined;
  }
}

/** Swift `Double(String)`: nur vollständige Zahlen (auch inf/nan), sonst `undefined`. */
export function parseSwiftDouble(s: string): number | undefined {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  const l = s.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(l)) return l.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(l)) return NaN;
  return undefined;
}

/** Swift `NumberFormatting.plain`: ganze Zahlen ohne Nachkommastellen, sonst bis zu 10 Stellen. */
export function plainNumber(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (n === Math.round(n) && Math.abs(n) < 1e15) return String(Math.trunc(n) || 0);
  let s = n.toFixed(10);
  while (s.endsWith("0")) s = s.slice(0, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

/** Text-Form wie Notions `format()`. */
export function describe(v: Value): string {
  switch (v.t) {
    case "empty": return "";
    case "string": return v.v;
    case "number": return plainNumber(v.v);
    case "bool": return v.v ? "true" : "false";
    case "date": return longDate(v.v);
    case "list": return v.v.map(describe).join(", ");
    case "page": return v.v;
    case "person": return v.v;
  }
}

const collatorAccent = new Intl.Collator("en", { numeric: true, sensitivity: "accent" });
const collatorFull = new Intl.Collator("en", { numeric: true, sensitivity: "variant", caseFirst: "lower" });

/** Swift `localizedStandardCompare`: ohne Groß/klein, Zahlen numerisch, bei Gleichstand trotzdem eindeutig. */
export function localizedStandardCompare(a: string, b: string): number {
  const c = collatorAccent.compare(a, b);
  if (c !== 0) return c < 0 ? -1 : 1;
  const d = collatorFull.compare(a, b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** Ordnung für Sortierung und Vergleiche; gemischte Arten über die Textform. */
export function compareValues(a: Value, b: Value): number {
  if (a.t === "number" && b.t === "number") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.t === "bool" && b.t === "bool") return a.v === b.v ? 0 : !a.v ? -1 : 1;
  if (a.t === "date" && b.t === "date") return a.v.start < b.v.start ? -1 : a.v.start > b.v.start ? 1 : 0;
  if (a.t === "list" && b.t === "list") {
    for (let i = 0; i < Math.min(a.v.length, b.v.length); i++) {
      const c = compareValues(a.v[i]!, b.v[i]!);
      if (c !== 0) return c;
    }
    return a.v.length === b.v.length ? 0 : a.v.length < b.v.length ? -1 : 1;
  }
  return localizedStandardCompare(describe(a), describe(b));
}

/** Strukturelle Gleichheit (Swift `==` auf Value). */
export function sameValue(a: Value, b: Value): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "empty": return true;
    case "list": {
      const bl = (b as typeof a).v;
      return a.v.length === bl.length && a.v.every((x, i) => sameValue(x, bl[i]!));
    }
    case "date": {
      const y = (b as typeof a).v;
      return a.v.start === y.start && a.v.end === y.end && a.v.includeTime === y.includeTime && a.v.remind === y.remind;
    }
    case "number": return Object.is(a.v, (b as typeof a).v) || a.v === (b as typeof a).v;
    default: return a.v === (b as typeof a).v;
  }
}

// MARK: Kalender (lokale Zeitzone)

export function startOfDay(swiftSeconds: number): number {
  const d = toJSDate(swiftSeconds);
  return fromJSDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
}

export function isSameDay(a: number, b: number): boolean {
  const x = toJSDate(a), y = toJSDate(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** Calendar.date(byAdding:value:to:) für Jahr/Monat/Tag (Wandzeit bleibt) und Stunde/Minute/Sekunde/ms (absolut). */
export function addCalendar(swiftSeconds: number, unit: CalendarUnit, value: number): number {
  const d = toJSDate(swiftSeconds);
  switch (unit) {
    case "year":
    case "month": {
      const months = unit === "year" ? value * 12 : value;
      const total = d.getFullYear() * 12 + d.getMonth() + months;
      const y = Math.floor(total / 12), m = total - y * 12;
      const day = Math.min(d.getDate(), daysInMonth(y, m));
      const r = new Date(d);
      r.setFullYear(y, m, day);
      return fromJSDate(r);
    }
    case "day": {
      const r = new Date(d);
      r.setDate(r.getDate() + value);
      return fromJSDate(r);
    }
    case "hour": return swiftSeconds + value * 3600;
    case "minute": return swiftSeconds + value * 60;
    case "second": return swiftSeconds + value;
    case "nanosecond": return swiftSeconds + value / 1e9;
  }
}

export type CalendarUnit = "year" | "month" | "day" | "hour" | "minute" | "second" | "nanosecond";

/** Ganze Monate zwischen zwei Zeitpunkten, Richtung Null gerundet (Calendar.dateComponents([.month])). */
export function monthsBetween(from: number, to: number): number {
  const a = toJSDate(from), b = toJSDate(to);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  const rest = (d: Date) => [d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  const cmp = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1; return 0; };
  if (months > 0 && cmp(rest(b), rest(a)) < 0) months -= 1;
  else if (months < 0 && cmp(rest(b), rest(a)) > 0) months += 1;
  return months;
}

/** ISO-Kalenderwoche. */
export function isoWeek(swiftSeconds: number): number {
  const d = toJSDate(swiftSeconds);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

// MARK: Formatieren (ICU-Muster, en_US_POSIX)

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Woche im Jahr nach en_US (Woche beginnt Sonntag, minimalDays 1): die Woche mit dem 1. Januar ist Woche 1. */
function usWeekOfYear(d: Date): number {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const weekEnd = new Date(day);
  weekEnd.setDate(day.getDate() + (6 - day.getDay()));
  if (weekEnd.getFullYear() > day.getFullYear()) return 1;
  const jan1 = new Date(day.getFullYear(), 0, 1);
  const dayOfYear = Math.round((day.getTime() - jan1.getTime()) / 86_400_000);
  return Math.floor((dayOfYear + jan1.getDay()) / 7) + 1;
}

function offset(d: Date, colon: boolean): string {
  const m = -d.getTimezoneOffset();
  const sign = m >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(m) / 60)).padStart(2, "0"), mm = String(Math.abs(m) % 60).padStart(2, "0");
  return sign + h + (colon ? ":" : "") + mm;
}

/** Formatiert mit einem ICU-Muster (Teilmenge, die Based erzeugt), Locale en_US_POSIX, lokale Zeitzone. */
export function formatICU(swiftSeconds: number, pattern: string): string {
  const d = toJSDate(swiftSeconds);
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      const end = pattern.indexOf("'", i + 1);
      let j = i + 1, lit = "";
      while (j < pattern.length) {
        if (pattern[j] === "'" && pattern[j + 1] === "'") { lit += "'"; j += 2; continue; }
        if (pattern[j] === "'") break;
        lit += pattern[j]; j++;
      }
      out += lit;
      i = end < 0 ? pattern.length : j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) { out += c; i++; continue; }
    let n = 1;
    while (pattern[i + n] === c) n++;
    i += n;
    const h24 = d.getHours();
    switch (c) {
      case "y": out += n === 2 ? String(d.getFullYear() % 100).padStart(2, "0") : String(d.getFullYear()).padStart(n, "0"); break;
      case "M": out += n >= 4 ? MONTHS[d.getMonth()] : n === 3 ? MONTHS[d.getMonth()]!.slice(0, 3) : String(d.getMonth() + 1).padStart(n, "0"); break;
      case "d": out += String(d.getDate()).padStart(n, "0"); break;
      case "E": out += n >= 6 ? WEEKDAYS[d.getDay()]!.slice(0, 2) : n === 4 ? WEEKDAYS[d.getDay()] : WEEKDAYS[d.getDay()]!.slice(0, 3); break;
      case "e": out += String(d.getDay() + 1).padStart(n, "0"); break;
      case "H": out += String(h24).padStart(n, "0"); break;
      case "h": out += String(h24 % 12 === 0 ? 12 : h24 % 12).padStart(n, "0"); break;
      case "m": out += String(d.getMinutes()).padStart(n, "0"); break;
      case "s": out += String(d.getSeconds()).padStart(n, "0"); break;
      case "a": out += h24 < 12 ? "AM" : "PM"; break;
      case "w": out += String(usWeekOfYear(d)).padStart(n, "0"); break;
      case "Q": out += String(Math.floor(d.getMonth() / 3) + 1); break;
      case "x": out += offset(d, n >= 3); break;
      default: out += c.repeat(n);
    }
  }
  return out;
}

/** Notions Standardanzeige „May 4, 2025 3:15 PM“ (Swift `DateDisplay.long`). */
export function longDate(dv: DateValue): string {
  let s = formatICU(dv.start, dv.includeTime ? "MMMM d, yyyy h:mm a" : "MMMM d, yyyy");
  if (dv.end !== undefined) {
    const sameDay = isSameDay(dv.start, dv.end);
    s += " → " + formatICU(dv.end, dv.includeTime && sameDay ? "h:mm a" : dv.includeTime ? "MMMM d, yyyy h:mm a" : "MMMM d, yyyy");
  }
  return s;
}

/** Moment-Format („MMMM D, YYYY h:mm A“) → ICU-Muster (Swift `DateDisplay.pattern`). */
export function patternFromMoment(fmt: string): string {
  const tokens: [string, string][] = [
    ["YYYY", "yyyy"], ["YY", "yy"], ["MMMM", "MMMM"], ["MMM", "MMM"], ["MM", "MM"], ["M", "M"],
    ["Do", "d"], ["DD", "dd"], ["D", "d"], ["dddd", "EEEE"], ["ddd", "EEE"], ["dd", "EEEEEE"], ["d", "e"],
    ["HH", "HH"], ["H", "H"], ["hh", "hh"], ["h", "h"], ["mm", "mm"], ["m", "m"], ["ss", "ss"], ["s", "s"],
    ["A", "a"], ["a", "a"], ["ww", "ww"], ["w", "w"], ["WW", "ww"], ["W", "w"], ["Q", "Q"], ["ZZ", "xx"], ["Z", "xxx"],
  ];
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "[") {
      const close = fmt.indexOf("]", i);
      if (close >= 0) {
        out += "'" + fmt.slice(i + 1, close).replaceAll("'", "''") + "'";
        i = close + 1;
        continue;
      }
    }
    const hit = tokens.find(([t]) => fmt.startsWith(t, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
      continue;
    }
    const c = fmt[i]!;
    if (/\p{L}/u.test(c)) out += `'${c}'`;
    else if (c === "'") out += "''";
    else out += c;
    i++;
  }
  return out;
}

/** Swift `DateDisplay.format(_:moment:)`. */
export function formatMoment(swiftSeconds: number, moment: string): string {
  let s = formatICU(swiftSeconds, patternFromMoment(moment));
  if (moment.includes("Do")) {
    const day = toJSDate(swiftSeconds).getDate();
    const suffix = [11, 12, 13].includes(day % 100) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
    const i = s.indexOf(String(day));
    if (i >= 0) s = s.slice(0, i) + day + suffix + s.slice(i + String(day).length);
  }
  return s;
}

// MARK: Datum lesen (Swift `DateParsing.parse`)

const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m.toLowerCase(), i] as const));
const MONTH_SHORT = new Map(MONTHS.map((m, i) => [m.slice(0, 3).toLowerCase(), i] as const));

function localDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number | undefined {
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return undefined;
  const r = new Date(y, mo, d, h, mi, s, ms);
  r.setFullYear(y);
  return fromJSDate(r);
}

function utcOffsetDate(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number | undefined {
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return undefined;
  let off = 0;
  if (tz !== "Z") {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (!m) return undefined;
    off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }
  return (Date.UTC(y, mo, d, h, mi, s, ms) - off * 60_000 - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;
}

const hour12 = (h: number, ap: string) => (h > 12 || h < 1 ? undefined : (h % 12) + (ap.toUpperCase() === "PM" ? 12 : 0));

type Parser = (s: string) => { start: number; time: boolean } | undefined;
const P = (re: RegExp, f: (m: RegExpExecArray) => number | undefined, time: boolean): Parser => (s) => {
  const m = re.exec(s);
  if (!m) return undefined;
  const start = f(m);
  return start === undefined ? undefined : { start, time };
};
const N = Number;
const PARSERS: Parser[] = [
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/, (m) => localDate(N(m[1]), N(m[2]) - 1, N(m[3])), false),
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/, (m) => localDate(N(m[1]), N(m[2]) - 1, N(m[3]), N(m[4]), N(m[5])), true),
  P(/^([A-Za-z]+) (\d{1,2}), (\d{1,4}) (\d{1,2}):(\d{2}) (AM|PM|am|pm)$/, (m) => {
    const mo = MONTH_INDEX.get(m[1]!.toLowerCase()), h = hour12(N(m[4]), m[6]!);
    return mo === undefined || h === undefined ? undefined : localDate(N(m[3]), mo, N(m[2]), h, N(m[5]));
  }, true),
  P(/^([A-Za-z]+) (\d{1,2}), (\d{1,4})$/, (m) => { const mo = MONTH_INDEX.get(m[1]!.toLowerCase()); return mo === undefined ? undefined : localDate(N(m[3]), mo, N(m[2])); }, false),
  P(/^([A-Za-z]{3}) (\d{1,2}), (\d{1,4})$/, (m) => { const mo = MONTH_SHORT.get(m[1]!.toLowerCase()); return mo === undefined ? undefined : localDate(N(m[3]), mo, N(m[2])); }, false),
  P(/^(\d{1,2}) ([A-Za-z]+) (\d{1,4})$/, (m) => { const mo = MONTH_INDEX.get(m[2]!.toLowerCase()); return mo === undefined ? undefined : localDate(N(m[3]), mo, N(m[1])); }, false),
  P(/^(\d{1,2})\.(\d{1,2})\.(\d{1,4})$/, (m) => localDate(N(m[3]), N(m[2]) - 1, N(m[1])), false),
  P(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/, (m) => localDate(N(m[3]), N(m[1]) - 1, N(m[2])), false),
  P(/^(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/, (m) => localDate(N(m[1]), N(m[2]) - 1, N(m[3])), false),
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2}):(\d{2})$/, (m) => localDate(N(m[1]), N(m[2]) - 1, N(m[3]), N(m[4]), N(m[5]), N(m[6])), true),
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})$/, (m) => utcOffsetDate(N(m[1]), N(m[2]) - 1, N(m[3]), N(m[4]), N(m[5]), N(m[6]), 0, m[7]!), true),
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})(Z|[+-]\d{2}:?\d{2})$/, (m) => utcOffsetDate(N(m[1]), N(m[2]) - 1, N(m[3]), N(m[4]), N(m[5]), N(m[6]), N(m[7]), m[8]!), true),
  P(/^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})$/, (m) => localDate(N(m[1]), N(m[2]) - 1, N(m[3]), N(m[4]), N(m[5])), true),
];

/** ISO-Daten, Notion-Exportdaten („May 4, 2024 3:15 PM“) und Bereiche („A → B“). */
export function parseDate(raw: string): DateValue | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  for (const sep of [" → ", " -> "]) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep);
    if (parts.length === 2) {
      const a = parseDate(parts[0]!);
      if (a) {
        const b = parseDate(parts[1]!);
        const out: DateValue = { start: a.start, includeTime: a.includeTime };
        if (b) out.end = b.start;
        return out;
      }
    }
  }
  for (const p of PARSERS) {
    const r = p(s);
    if (r) return { start: r.start, includeTime: r.time };
  }
  return undefined;
}
