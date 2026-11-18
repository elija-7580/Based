// BSD-570: Ein Datum ohne Uhrzeit ist ein Kalendertag, kein Zeitpunkt. Gespeichert war bisher nur `start` = Mitternacht
// in der Zeitzone des schreibenden Geräts – auf einem Gerät oder Server weiter westlich ist das der Vortag
// („18. November“ aus Wien = 2026-11-17T23:00Z). Deshalb trägt jedes Datum ohne Uhrzeit zusätzlich den Tag selbst:
//   `day: "2026-11-18"` (und `endDay` für das Ende eines Bereichs).
// Rein additiv (`dateValue` ist offen): ältere Stände lesen weiter `start`. `day` ist die Wahrheit, `start` bleibt für
// sie und als Sortierwert erhalten. Geschrieben wird `day` an zwei Stellen, durch die jedes Datum kommt: beim Lesen von
// Text (`parseDate`, alle Importe) und bei jeder eigenen Änderung im Store. Leser nehmen `resolveDate`.
import type { DateValue } from "../query/value.js";
import type { Block, PropertyValue, RichText } from "./records.js";

const REF = 978_307_200_000; // 2001-01-01T00:00:00Z in Unix-ms (Swift-Referenzdatum)
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
type Dated = DateValue & { day?: string; endDay?: string };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Kalendertag des Zeitpunkts in der Zeitzone dieses Geräts („2026-11-18“). */
export function localDay(swiftSeconds: number): string {
  const d = new Date(REF + swiftSeconds * 1000);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Mitternacht dieses Kalendertags in der Zeitzone dieses Geräts (Swift-Sekunden); `undefined` bei ungültigem Tag. */
export function calendarDayStart(day: string | undefined): number | undefined {
  const m = day === undefined ? null : DAY.exec(day);
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const date = new Date(y, mo, d);
  date.setFullYear(y);
  if (date.getMonth() !== mo || date.getDate() !== d) return undefined;
  return (date.getTime() - REF) / 1000;
}

const consistent = (v: Dated) =>
  v.day !== undefined && calendarDayStart(v.day) === v.start && (v.end === undefined ? v.endDay === undefined : v.endDay !== undefined && calendarDayStart(v.endDay) === v.end);

/** Tag(e) aus den Zeitpunkten in der Zeitzone dieses Geräts setzen (für Werte, die hier entstehen). */
export function stampDay(v: DateValue): DateValue {
  const out: Dated = { ...v };
  if (v.includeTime) { delete out.day; delete out.endDay; return out; }
  out.day = localDay(v.start);
  if (v.end === undefined) delete out.endDay;
  else out.endDay = localDay(v.end);
  return out;
}

/**
 * Datum vor dem Speichern einer eigenen Änderung. `prev` ist derselbe Wert vor der Änderung (wenn es ihn gab).
 * - mit Uhrzeit: ein Zeitpunkt, kein Tag.
 * - unverändert gegenüber `prev`: der Tag von `prev` bleibt (auch wenn dieses Gerät in einer anderen Zeitzone ist).
 * - Tag passt zu den Zeitpunkten (frisch gelesen oder gewählt): bleibt.
 * - geändert: Tag aus den neuen Zeitpunkten, in der Zeitzone dieses Geräts – hier wurde er gewählt.
 * - neu ohne Vorgänger (Kopie, Einfügen): ein vorhandener Tag gilt, sonst wird er hier bestimmt.
 */
export function normalizeDate(v: DateValue, prev: DateValue | undefined): DateValue {
  const cur = v as Dated, old = prev as Dated | undefined;
  if (cur.includeTime) return cur.day === undefined && cur.endDay === undefined ? v : stampDay(v);
  if (old && !old.includeTime && old.start === cur.start && old.end === cur.end && old.day !== undefined) {
    if (cur.day === old.day && cur.endDay === old.endDay) return v;
    const out: Dated = { ...cur, day: old.day };
    if (old.endDay === undefined) delete out.endDay;
    else out.endDay = old.endDay;
    return out;
  }
  if (consistent(cur)) return v;
  if (!old && cur.day !== undefined && calendarDayStart(cur.day) !== undefined && (cur.end === undefined || calendarDayStart(cur.endDay) !== undefined)) return v;
  return stampDay(v);
}

const dateOf = (v: PropertyValue | undefined): DateValue | undefined => (v as { date?: { _0?: DateValue } } | undefined)?.date?._0;

/** Alle Daten eines Blocks (Zeilenwerte und Datums-Erwähnungen im Text) vor dem Speichern; gibt `block` selbst zurück, wenn nichts zu tun ist. */
export function withCalendarDays(block: Block, prev: Block | undefined): Block {
  let out = block;
  const values = block.values;
  if (values) {
    let next: Record<string, PropertyValue> | undefined;
    for (const [k, pv] of Object.entries(values)) {
      const d = dateOf(pv);
      if (!d || typeof d.start !== "number") continue;
      const n = normalizeDate(d, dateOf(prev?.values?.[k]));
      if (n !== d) (next ??= { ...values })[k] = { date: { _0: n } } as PropertyValue;
    }
    if (next) out = { ...out, values: next };
  }
  const text = block.text;
  if (Array.isArray(text)) {
    const before = Array.isArray(prev?.text) ? prev.text : undefined;
    let next: RichText | undefined;
    text.forEach((run, i) => {
      const d = (run.mention as { date?: { _0?: DateValue } } | undefined)?.date?._0;
      if (!d || typeof d.start !== "number") return;
      const old = (before?.[i]?.mention as { date?: { _0?: DateValue } } | undefined)?.date?._0;
      const n = normalizeDate(d, old);
      if (n !== d) {
        const copy = (next ??= [...text]) as typeof text;
        copy[i] = { ...run, mention: { date: { _0: n } } } as (typeof text)[number];
      }
    });
    if (next) out = { ...out, text: next };
  }
  return out;
}

/**
 * Datum zum Lesen: Bei einem Datum ohne Uhrzeit mit gespeichertem Tag ist `start`/`end` Mitternacht dieses Tags in der
 * Zeitzone des lesenden Geräts – so steht überall derselbe Tag. Ohne `day` (ältere Daten) bleibt der Wert, wie er ist.
 */
export function resolveDate(v: DateValue): DateValue {
  const cur = v as Dated;
  if (cur.includeTime || cur.day === undefined) return v;
  const start = calendarDayStart(cur.day);
  if (start === undefined) return v;
  const end = cur.end === undefined ? undefined : calendarDayStart(cur.endDay) ?? cur.end;
  if (start === cur.start && end === cur.end) return v;
  const out: Dated = { ...cur, start };
  if (end !== undefined) out.end = end;
  return out;
}

/** Wert ohne `day`/`endDay` (tief) – für Fingerabdrücke, die sich durch das Zusatzfeld nicht ändern dürfen. */
export function stripCalendarDays<T>(v: T): T {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const y = stripCalendarDays(x) as unknown; if (y !== x) changed = true; return y; });
    return changed ? (out as unknown as T) : v;
  }
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const dated = typeof o.includeTime === "boolean" && typeof o.start === "number";
  let out: Record<string, unknown> | undefined;
  for (const [k, x] of Object.entries(o)) {
    if (dated && (k === "day" || k === "endDay")) { (out ??= { ...o }); delete out[k]; continue; }
    const y = stripCalendarDays(x);
    if (y !== x) (out ??= { ...o })[k] = y;
  }
  return (out ?? o) as T;
}
