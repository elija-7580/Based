// BSD-8: Datumslogik für Kalender- und Timeline-Ansichten (Swift CalendarTimeline.swift `dateProperty`/`span`,
// erweitert um Tagesraster, Wochen-/Monatsraster, Spuren für Mehrtages-Balken, Bereichsabfragen und
// Zeitachsen-Ticks). Rein, ohne React.
//
// Tage werden als „Tagesindex“ gerechnet: ganze Tage seit 1970-01-01 im *lokalen* Kalender (wie Calendar.current
// in Swift). Damit sind Monatsgrenzen, Sommerzeit-Tage (23/25 h) und Zeitzonen-Wechsel kein Sonderfall:
// `dayOf` liest Jahr/Monat/Tag in der lokalen Zone, `dayStart` liefert lokale Mitternacht.
import type { Block, Database, DatabaseView, PropertySchema } from "../model/records.js";
import type { QueryEngine } from "./engine.js";
import { addCalendar, fromJSDate, toJSDate, type DateValue } from "./value.js";

const DAY_MS = 86_400_000;

// MARK: Tagesindex

/** Tagesindex (lokaler Kalender) eines Swift-Datums. */
export function dayOf(swiftSeconds: number): number {
  const d = toJSDate(swiftSeconds);
  return dayFromYMD(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Tagesindex aus Jahr, Monat (0–11) und Tag; Überläufe werden normalisiert (Monat 12 = Januar des Folgejahrs). */
export function dayFromYMD(year: number, month: number, day: number): number {
  const u = new Date(0);
  u.setUTCFullYear(year, month, day);
  return Math.floor(u.getTime() / DAY_MS);
}

/** Jahr, Monat (0–11), Tag eines Tagesindex. */
export function ymdOf(day: number): { year: number; month: number; day: number } {
  const u = new Date(day * DAY_MS);
  return { year: u.getUTCFullYear(), month: u.getUTCMonth(), day: u.getUTCDate() };
}

/** Lokale Mitternacht eines Tages als Swift-Datum (bei Sommerzeit um Mitternacht die erste gültige Uhrzeit). */
export function dayStart(day: number): number {
  const { year, month, day: d } = ymdOf(day);
  const j = new Date(2000, 0, 1);
  j.setFullYear(year, month, d);
  j.setHours(0, 0, 0, 0);
  return fromJSDate(j);
}

/** Lokales JS-Datum (Mitternacht) eines Tages – für Intl-Formatierung. */
export const dateOfDay = (day: number): Date => toJSDate(dayStart(day));

/** Heute als Tagesindex. */
export const today = (now: Date = new Date()): number => dayFromYMD(now.getFullYear(), now.getMonth(), now.getDate());

/** Wochentag 0 = Sonntag … 6 = Samstag (1970-01-01 war ein Donnerstag). */
export const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;

/** Erster Tag der Woche, die `day` enthält (`weekStart` 0 = Sonntag, 1 = Montag …). */
export const startOfWeek = (day: number, weekStart: number): number => day - ((weekdayOf(day) - weekStart + 7) % 7);

/** Erster Tag des Monats von `day`. */
export function startOfMonth(day: number): number {
  const { year, month } = ymdOf(day);
  return dayFromYMD(year, month, 1);
}

/** Monat ± n, Tag auf das Monatsende begrenzt (31. Jan + 1 Monat = 28./29. Feb), wie Calendar.date(byAdding:). */
export function addMonths(day: number, n: number): number {
  const { year, month, day: d } = ymdOf(day);
  const last = ymdOf(dayFromYMD(year, month + n + 1, 0)).day;
  return dayFromYMD(year, month + n, Math.min(d, last));
}

export const daysInMonth = (year: number, month: number): number => ymdOf(dayFromYMD(year, month + 1, 0)).day;

/** Erster Tag des Quartals von `day`. */
export function startOfQuarter(day: number): number {
  const { year, month } = ymdOf(day);
  return dayFromYMD(year, month - (month % 3), 1);
}

export function startOfYear(day: number): number {
  return dayFromYMD(ymdOf(day).year, 0, 1);
}

/** Monatsraster: erster sichtbarer Tag (Wochenbeginn) und Anzahl Wochen (4–6), wie Swift `gridDays`. */
export function monthGrid(year: number, month: number, weekStart: number): { first: number; weeks: number; monthStart: number; monthEnd: number } {
  const monthStart = dayFromYMD(year, month, 1);
  const monthEnd = dayFromYMD(year, month + 1, 0);
  const first = startOfWeek(monthStart, weekStart);
  return { first, weeks: Math.ceil((monthEnd - first + 1) / 7), monthStart, monthEnd };
}

/** Wochenbeginn 0–6 (0 = Sonntag) für ein Locale (Intl `weekInfo`); 1 (Montag), wenn der Browser es nicht kennt. */
export function weekStartForLocale(tag?: string): number {
  try {
    const loc = new Intl.Locale(tag ?? (typeof navigator !== "undefined" ? navigator.language : "en-US")) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
  } catch { /* ungültiges Locale */ }
  return 1;
}

// MARK: Zeiträume

/** Property, nach der eine Kalender-/Timeline-Ansicht auslegt (Swift `DBContext.dateProperty`). */
export function calendarDateProperty(db: Database, view: DatabaseView): PropertySchema | undefined {
  const byID = view.datePropertyID ? db.properties.find((p) => p.id === view.datePropertyID) : undefined;
  return byID
    ?? db.properties.find((p) => p.type === "date")
    ?? db.properties.find((p) => p.type === "createdTime" || p.type === "lastEditedTime");
}

/** Eigene Ende-Property der Ansicht (sonst gilt das Ende des Zeitraums der Datums-Property). */
export function calendarEndProperty(db: Database, view: DatabaseView): PropertySchema | undefined {
  const id = view.endDatePropertyID;
  return id ? db.properties.find((p) => p.id === id) : undefined;
}

/** Datum-Properties, die eine Ansicht auslegen können (auch berechnete). */
export const CALENDAR_PROPERTY_TYPES: readonly string[] = ["date", "createdTime", "lastEditedTime", "formula", "rollup"];

/** Zeitraum einer Zeile auf Kalender/Timeline. */
export interface RowSpan {
  row: Block;
  /** Erster und letzter Tag (Tagesindex, inklusive). */
  start: number;
  end: number;
  /** Swift-Daten von Beginn und Ende. */
  startAt: number;
  endAt: number;
  includeTime: boolean;
}

function dateValueOf(engine: QueryEngine, db: Database, row: Block, p: PropertySchema): DateValue | undefined {
  const v = engine.value(row, p, db);
  if (v.t === "date") return v.v;
  if (v.t === "list") for (const x of v.v) if (x.t === "date") return x.v;
  return undefined;
}

/**
 * Zeitraum einer Zeile (Swift `span`): Beginn aus der Datums-Property, Ende aus der Ende-Property (falls gesetzt),
 * sonst aus dem Ende des Zeitraums. Ende vor Beginn zählt als eintägig. Ein Ende mit Uhrzeit genau um Mitternacht
 * gehört zum Vortag („bis 24 Uhr“).
 */
export function rowSpan(engine: QueryEngine, db: Database, row: Block, dateProp: PropertySchema, endProp?: PropertySchema): RowSpan | undefined {
  const d = dateValueOf(engine, db, row, dateProp);
  if (!d || !Number.isFinite(d.start)) return undefined;
  let endAt = d.end ?? d.start;
  let includeTime = d.includeTime;
  if (endProp && endProp.id !== dateProp.id) {
    const e = dateValueOf(engine, db, row, endProp);
    if (e) { endAt = e.end ?? e.start; includeTime ||= e.includeTime; }
  }
  if (!(endAt >= d.start)) endAt = d.start;
  const start = dayOf(d.start);
  let end = dayOf(endAt);
  if (includeTime && endAt > d.start && end > start && endAt === dayStart(end)) end -= 1;
  return { row, start, end, startAt: d.start, endAt, includeTime };
}

/** Zeiträume aller Zeilen in Ergebnis-Reihenfolge, dazu die Zeilen ohne Datum. */
export function rowSpans(engine: QueryEngine, db: Database, rows: readonly Block[], dateProp: PropertySchema, endProp?: PropertySchema): { dated: RowSpan[]; undated: Block[] } {
  const dated: RowSpan[] = [], undated: Block[] = [];
  for (const r of rows) {
    const s = rowSpan(engine, db, r, dateProp, endProp);
    if (s) dated.push(s);
    else undated.push(r);
  }
  return { dated, undated };
}

/** Zeitraum um `delta` Tage verschoben (Dauer bleibt). */
export const shiftSpan = (s: RowSpan, delta: number): RowSpan =>
  delta === 0 ? s : { ...s, start: s.start + delta, end: s.end + delta, startAt: addCalendar(s.startAt, "day", delta), endAt: addCalendar(s.endAt, "day", delta) };

/** Zeitraum mit neuem Beginn oder Ende (für das Ziehen an den Balkenenden); nie kürzer als ein Tag. */
export function resizeSpan(s: RowSpan, edge: "start" | "end", day: number): RowSpan {
  if (edge === "start") {
    const start = Math.min(day, s.end);
    return { ...s, start, startAt: addCalendar(s.startAt, "day", start - s.start) };
  }
  const end = Math.max(day, s.start);
  return { ...s, end, endAt: addCalendar(s.endAt, "day", end - s.end) };
}

/** Länge, ab der ein Zeitraum in der Bereichsabfrage linear statt per Binärsuche geprüft wird. */
const LONG_SPAN = 62;

/**
 * Bereichsabfrage über Zeiträume: „welche Zeilen überlappen Tage [von, bis]?“ ohne alle Zeilen zu prüfen.
 * Kurze Zeiträume liegen nach Beginn sortiert (Binärsuche ab `von − LONG_SPAN`), lange in einer kleinen Extra-Liste.
 * Ergebnis in Ergebnis-Reihenfolge der Ansicht (also mit deren Sortierung).
 */
export class SpanIndex {
  private readonly short: { s: RowSpan; i: number }[];
  private readonly long: { s: RowSpan; i: number }[];
  readonly min: number | undefined;
  readonly max: number | undefined;

  constructor(readonly spans: readonly RowSpan[]) {
    const short: { s: RowSpan; i: number }[] = [], long: { s: RowSpan; i: number }[] = [];
    let min: number | undefined, max: number | undefined;
    spans.forEach((s, i) => {
      (s.end - s.start >= LONG_SPAN ? long : short).push({ s, i });
      if (min === undefined || s.start < min) min = s.start;
      if (max === undefined || s.end > max) max = s.end;
    });
    short.sort((a, b) => a.s.start - b.s.start || a.i - b.i);
    this.short = short;
    this.long = long;
    this.min = min;
    this.max = max;
  }

  get size(): number { return this.spans.length; }

  /** Zeiträume, die [from, to] (Tage, inklusive) berühren. */
  query(from: number, to: number): RowSpan[] {
    const hits: { s: RowSpan; i: number }[] = [];
    let lo = 0, hi = this.short.length;
    const min = from - LONG_SPAN;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.short[mid]!.s.start < min) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < this.short.length; k++) {
      const x = this.short[k]!;
      if (x.s.start > to) break;
      if (x.s.end >= from) hits.push(x);
    }
    for (const x of this.long) if (x.s.start <= to && x.s.end >= from) hits.push(x);
    return hits.sort((a, b) => a.i - b.i).map((x) => x.s);
  }
}

// MARK: Spuren (Mehrtages-Balken)

export interface LanePlacement {
  span: RowSpan;
  /** Spur (0 = oben). */
  lane: number;
  /** Erste/letzte Spalte im Bereich (0-basiert, inklusive). */
  from: number;
  to: number;
  /** Beginnt vor bzw. endet nach dem Bereich (Balken ohne runde Ecke). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface LaneLayout {
  placements: LanePlacement[];
  lanes: number;
  /** Zeiträume je Spalte (alle, auch nicht gezeigte). */
  perDay: number[];
  /** Je Spalte: Zeiträume ab Spur `maxLanes` (für „+N mehr“). */
  hiddenPerDay: number[];
}

/**
 * Verteilt Zeiträume auf Spuren für einen Bereich von `days` Tagen ab `first` (Woche im Kalender): mehrtägige
 * zuerst (länger vor kürzer), dann nach Beginn, dann Ergebnis-Reihenfolge; jede Zeile in die oberste freie Spur.
 * `maxLanes` zählt pro Tag, wie viele darüber hinaus ausgeblendet sind.
 */
export function layoutLanes(spans: readonly RowSpan[], first: number, days: number, maxLanes = Infinity): LaneLayout {
  const last = first + days - 1;
  const items = spans
    .map((s, i) => ({ s, i, from: Math.max(s.start, first) - first, to: Math.min(s.end, last) - first }))
    .filter((x) => x.to >= 0 && x.from <= days - 1);
  items.sort((a, b) => {
    const la = a.to - a.from, lb = b.to - b.from;
    const multiA = la > 0 ? 1 : 0, multiB = lb > 0 ? 1 : 0;
    return multiB - multiA || a.from - b.from || lb - la || a.i - b.i;
  });
  // Belegung je Spur: Bitmaske (bis 30 Tage, der Normalfall Woche) bzw. Tagesliste – Lücken vor einem
  // späteren Balken werden so ebenfalls gefüllt.
  const small = days <= 30;
  const masks: number[] = [];
  const used: Uint8Array[] = [];
  const free = (l: number, from: number, to: number) => {
    if (small) return (masks[l]! & (((1 << (to - from + 1)) - 1) << from)) === 0;
    for (let d = from; d <= to; d++) if (used[l]![d]) return false;
    return true;
  };
  const take = (l: number, from: number, to: number) => {
    if (small) masks[l] = masks[l]! | (((1 << (to - from + 1)) - 1) << from);
    else used[l]!.fill(1, from, to + 1);
  };
  let laneCount = 0;
  const placements: LanePlacement[] = [];
  const perDay = new Array<number>(days).fill(0), hiddenPerDay = new Array<number>(days).fill(0);
  for (const x of items) {
    let lane = 0;
    while (lane < laneCount && !free(lane, x.from, x.to)) lane++;
    if (lane === laneCount) { laneCount++; masks.push(0); if (!small) used.push(new Uint8Array(days)); }
    take(lane, x.from, x.to);
    placements.push({ span: x.s, lane, from: x.from, to: x.to, continuesBefore: x.s.start < first, continuesAfter: x.s.end > last });
    for (let d = x.from; d <= x.to; d++) {
      perDay[d]!++;
      if (lane >= maxLanes) hiddenPerDay[d]!++;
    }
  }
  return { placements, lanes: laneCount, perDay, hiddenPerDay };
}

// MARK: Zeitachse

export type TimelineScale = "day" | "week" | "month" | "quarter";
export const TIMELINE_SCALES: readonly TimelineScale[] = ["day", "week", "month", "quarter"];

export interface TimelineTick { day: number; label: string }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = locale + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }); fmtCache.set(k, f); }
  return f;
}
/** Tagesindex formatieren (unabhängig von der Zeitzone: der Index ist schon ein Kalendertag). */
export const formatDay = (day: number, opts: Intl.DateTimeFormatOptions, locale = "en-US"): string => fmt(locale, opts).format(new Date(day * DAY_MS));

/** Beginn der Einheit, in der eine Skala blättert bzw. ihre feinen Ticks setzt. */
export function unitStart(scale: TimelineScale, day: number, weekStart: number): number {
  switch (scale) {
    case "day": return day;
    case "week": return startOfWeek(day, weekStart);
    case "month": return startOfMonth(day);
    case "quarter": return startOfQuarter(day);
  }
}

/** Nächste Einheit nach `day` (das ein Einheitsbeginn ist). */
export function nextUnit(scale: TimelineScale, day: number): number {
  switch (scale) {
    case "day": return day + 1;
    case "week": return day + 7;
    case "month": return addMonths(day, 1);
    case "quarter": return addMonths(day, 3);
  }
}

/**
 * Ticks einer Zeitachse im Bereich [from, to]: grobe (Monat bzw. Jahr, mit Beschriftung) und feine (Tag, Woche,
 * Monat, Quartal). Nur der sichtbare Bereich wird angefragt – die Achse bleibt bei jeder Länge klein.
 */
export function timelineTicks(scale: TimelineScale, from: number, to: number, weekStart: number, locale = "en-US"): { major: TimelineTick[]; minor: TimelineTick[] } {
  const major: TimelineTick[] = [], minor: TimelineTick[] = [];
  const yearly = scale === "month" || scale === "quarter";
  for (let d = yearly ? startOfYear(from) : startOfMonth(from); d <= to; d = yearly ? dayFromYMD(ymdOf(d).year + 1, 0, 1) : addMonths(d, 1)) {
    major.push({ day: d, label: yearly ? String(ymdOf(d).year) : formatDay(d, { month: "long", year: "numeric" }, locale) });
  }
  for (let d = unitStart(scale, from, weekStart); d <= to; d = nextUnit(scale, d)) {
    const { month, day } = ymdOf(d);
    const label = scale === "day" ? String(day)
      : scale === "week" ? String(day)
      : scale === "month" ? formatDay(d, { month: "short" }, locale)
      : `Q${Math.floor(month / 3) + 1}`;
    minor.push({ day: d, label });
  }
  return { major, minor };
}

/**
 * Sichtbarer Gesamtbereich einer Timeline: alle Zeiträume und heute, mit Rand je Skala, auf Einheiten
 * ausgerichtet; höchstens ±50 Jahre um heute (Ausreißer wie Jahr 1 sprengen sonst die Breite).
 */
export function timelineRange(index: { min: number | undefined; max: number | undefined }, todayDay: number, scale: TimelineScale, weekStart: number): { from: number; to: number } {
  const pad = { day: 45, week: 120, month: 365, quarter: 730 }[scale];
  const limit = 365 * 50;
  const lo = Math.max(todayDay - limit, Math.min(index.min ?? todayDay, todayDay) - pad);
  const hi = Math.min(todayDay + limit, Math.max(index.max ?? todayDay, todayDay) + pad);
  const from = unitStart(scale, lo, weekStart);
  let to = unitStart(scale, hi, weekStart);
  to = nextUnit(scale, to) - 1;
  return { from, to };
}

/** Zeitraum als Text („Nov 9 – Nov 12, 2026“, mit Uhrzeit wenn gesetzt). */
export function spanLabel(s: RowSpan, locale = "en-US"): string {
  const time = (at: number) => toJSDate(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameYear = ymdOf(s.start).year === ymdOf(s.end).year;
  const a = formatDay(s.start, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }, locale) + (s.includeTime ? " " + time(s.startAt) : "");
  if (s.start === s.end && !(s.includeTime && s.endAt > s.startAt)) return a + (sameYear ? ", " + ymdOf(s.start).year : "");
  const b = (s.start === s.end ? "" : formatDay(s.end, { month: "short", day: "numeric", year: "numeric" }, locale)) + (s.includeTime ? " " + time(s.endAt) : "");
  return `${a} – ${b.trim()}` + (s.start === s.end ? ", " + ymdOf(s.start).year : "");
}
