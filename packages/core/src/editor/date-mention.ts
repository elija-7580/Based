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
