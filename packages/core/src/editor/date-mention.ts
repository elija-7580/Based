// Datums-Erwähnungen im @-Menü: „today“, „tomorrow“, Wochentage und getippte Daten → Kalendertag (lokale Zeit).
// Rein und mit festem `now` testbar. Das Ergebnis ist ein DateValue wie in den Swift-Records
// (`mention: {date: {_0: {start, includeTime, remind?}}}`).
import { dateToSwift } from "../json.js";

export interface DateSuggestion {
  /** Anzeige im Menü („Today“, „Tomorrow“, „Fri, Dec 24, 2026“). */
  label: string;
  /** Mitternacht des Tages, lokale Zeit. */
  date: Date;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function valid(y: number, m: number, d: number): Date | undefined {
  if (!(y >= 1900 && y <= 2200) || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : undefined;
}

const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** Nächstes Vorkommen von Tag/Monat ab heute (ohne Jahresangabe). */
function upcoming(m: number, d: number, today: Date): Date | undefined {
  const a = valid(today.getFullYear(), m, d);
  if (a && a.getTime() >= today.getTime()) return a;
  return valid(today.getFullYear() + 1, m, d) ?? a;
}

const monthIndex = (s: string) => {
  const k = s.toLowerCase().replace(/\.$/, "");
  if (k.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(k));
};

/** Ein getipptes Datum: ISO (2026-12-24), 24.12.2026, 12/24/2026, „Dec 24“, „24 Dec 2026“, „December 24, 2026“. */
export function parseTypedDate(query: string, now: Date): Date | undefined {
  const q = query.trim().toLowerCase();
  const today = startOfDay(now);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(q);
  if (m) return m[3] ? valid(fullYear(Number(m[3])), Number(m[2]), Number(m[1])) : upcoming(Number(m[2]), Number(m[1]), today);
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(q);
  if (m) return m[3] ? valid(fullYear(Number(m[3])), Number(m[1]), Number(m[2])) : upcoming(Number(m[1]), Number(m[2]), today);
  m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(q);
  if (m && monthIndex(m[1]!) >= 0) {
    const mo = monthIndex(m[1]!) + 1;
    return m[3] ? valid(Number(m[3]), mo, Number(m[2])) : upcoming(mo, Number(m[2]), today);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\.? ([a-z]{3,9})\.?(?:,? (\d{4}))?$/.exec(q);
  if (m && monthIndex(m[2]!) >= 0) {
    const mo = monthIndex(m[2]!) + 1;
    return m[3] ? valid(Number(m[3]), mo, Number(m[1])) : upcoming(mo, Number(m[1]), today);
  }
  return undefined;
}

const longLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });

/**
 * Vorschläge für die Eingabe hinter `@`. Leere Eingabe: Today und Tomorrow. Sonst alles, was passt: Schlüsselwörter
 * (Präfix), Wochentage („fri“, „next friday“) und getippte Daten.
 */
export function dateSuggestions(query: string, now: Date): DateSuggestion[] {
  const q = query.trim().toLowerCase();
  const today = startOfDay(now);
  const out: DateSuggestion[] = [];
  const keywords: [string, number][] = [["today", 0], ["tomorrow", 1], ["yesterday", -1]];
  for (const [word, offset] of keywords) {
    if (q === "" ? offset >= 0 : word.startsWith(q)) out.push({ label: word[0]!.toUpperCase() + word.slice(1), date: addDays(today, offset) });
  }
  if (q === "") return out;
  if ("next week".startsWith(q) && q.length >= 4) out.push({ label: "Next week", date: addDays(today, 7) });
  const wd = /^(next )?([a-z]{3,9})$/.exec(q);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!));
    if (idx >= 0) {
      let delta = (idx - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      const date = addDays(today, delta);
      const name = WEEKDAYS[idx]!;
      out.push({ label: `${name[0]!.toUpperCase()}${name.slice(1)} · ${longLabel(date)}`, date });
    }
  }
  const typed = parseTypedDate(q, now);
  if (typed) out.push({ label: longLabel(typed), date: typed });
  return out;
}

/** DateValue (Wire) für einen Kalendertag, optional mit Erinnerungs-Flagge. */
export function dateMentionValue(date: Date, remind = false): { start: number; includeTime: boolean; remind?: boolean } {
  const v: { start: number; includeTime: boolean; remind?: boolean } = { start: dateToSwift(startOfDay(date)), includeTime: false };
  if (remind) v.remind = true;
  return v;
}

// MARK: Datumswähler (BSD-210): Start, optional Ende (Bereich) und Uhrzeit, wie Notions Datums-Popover.

export interface DateMentionValue { start: number; end?: number; includeTime?: boolean; remind?: boolean }
/** Felder des Wählers in lokaler Zeit: Tag „YYYY-MM-DD“, Uhrzeit „HH:MM“. */
export interface DateParts { startDay: string; startTime: string; endDay?: string | undefined; endTime?: string | undefined; includeTime: boolean }

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const SWIFT_EPOCH = 978307200;
const fromSwift = (s: number) => new Date((s + SWIFT_EPOCH) * 1000);

export function dateParts(v: DateMentionValue): DateParts {
  const s = fromSwift(v.start);
  const e = v.end !== undefined ? fromSwift(v.end) : undefined;
  return { startDay: dayOf(s), startTime: timeOf(s), endDay: e ? dayOf(e) : undefined, endTime: e ? timeOf(e) : undefined, includeTime: v.includeTime === true };
}

function localDate(day: string, time: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const t = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Neuer Wert aus den Feldern des Wählers. Ohne Uhrzeit zählt Mitternacht; ein Ende vor dem Start wird mit ihm
 * getauscht (wie Notion). Ungültige Eingaben lassen den alten Wert stehen. `remind` bleibt erhalten.
 */
export function withDateParts(v: DateMentionValue, p: DateParts): DateMentionValue {
  const start = localDate(p.startDay, p.includeTime ? p.startTime : undefined);
  if (!start) return v;
  let end = p.endDay ? localDate(p.endDay, p.includeTime ? (p.endTime ?? p.startTime) : undefined) : undefined;
  let s = start;
  if (end && end.getTime() < s.getTime()) [s, end] = [end, s];
  const out: DateMentionValue = { start: dateToSwift(s), includeTime: p.includeTime };
  if (end) out.end = dateToSwift(end);
  if (v.remind) out.remind = true;
  return out;
}
