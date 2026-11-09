// BSD-8: Schreib-Operationen für Kalender und Timeline. Behebt den Befund aus dem Audit (Swift `reschedule`
// verschob nur den Beginn): Verschieben bewegt Beginn *und* Ende (auch eine eigene Ende-Property), die Dauer
// bleibt. Jede Operation ist genau eine Store-Transaktion (ein Undo-Schritt). Uhrzeiten bleiben als Wandzeit
// erhalten (10:00 bleibt 10:00, auch über eine Sommerzeit-Umstellung).
import type { Block, PropertyValue } from "../model/records.js";
import { dayOf, dayStart } from "../query/calendar.js";
import { databaseOfRow } from "../query/engine.js";
import { addCalendar, type DateValue } from "../query/value.js";
import { addRow, pv, valueCase, type AddRowOptions } from "./database-ops.js";
import type { WorkspaceStore } from "./store.js";

/** Welche Properties einer Zeile den Zeitraum tragen. */
export interface SpanProperties {
  /** Datums-Property (Beginn; ohne eigene Ende-Property auch das Ende ihres Zeitraums). */
  dateID: string;
  /** Eigene Ende-Property (optional). */
  endID?: string | undefined;
}

/** Gespeicherter Datumswert einer Zeile (nur echte Datums-Properties). */
export function storedDate(row: Block | undefined, propertyID: string): DateValue | undefined {
  const c = valueCase(row?.values?.[propertyID]);
  if (c?.[0] !== "date" || !c[1] || typeof c[1] !== "object") return undefined;
  const d = c[1] as DateValue;
  return typeof d.start === "number" ? d : undefined;
}

/** Können Beginn (und Ende) dieser Ansicht geschrieben werden? Nur echte Datums-Properties – keine Formeln, keine Zeitstempel. */
export function canWriteSpan(store: WorkspaceStore, databaseID: string, props: SpanProperties): boolean {
  const db = store.databases.get(databaseID);
  if (!db || db.locked) return false;
  const type = (id: string) => db.properties.find((p) => p.id === id)?.type;
  return type(props.dateID) === "date" && (props.endID === undefined || props.endID === props.dateID || type(props.endID) === "date");
}

function putValue(b: Block, propertyID: string, value: PropertyValue | null) {
  const values = { ...(b.values ?? {}) };
  if (value === null) delete values[propertyID];
  else values[propertyID] = value;
  if (Object.keys(values).length === 0) delete b.values;
  else b.values = values;
}

const dateValue = (d: DateValue): PropertyValue => {
  const out: DateValue = { start: d.start, includeTime: d.includeTime };
  if (d.end !== undefined) out.end = d.end;
  if (d.remind !== undefined) out.remind = d.remind;
  return pv("date", out);
};

const separateEnd = (p: SpanProperties) => p.endID !== undefined && p.endID !== p.dateID;

/** Wandzeit-erhaltend um `delta` Tage verschieben. */
const shift = (at: number, delta: number) => (delta === 0 ? at : addCalendar(at, "day", delta));

/**
 * Zeile um `deltaDays` verschieben: Beginn und Ende (bzw. die Ende-Property) wandern mit, die Dauer bleibt.
 * Gibt `false` zurück, wenn es nichts zu verschieben gibt.
 */
export function moveRowSpan(store: WorkspaceStore, rowID: string, props: SpanProperties, deltaDays: number): boolean {
  const row = store.blocks.get(rowID);
  const d = storedDate(row, props.dateID);
  if (!row || !d || deltaDays === 0 || !Number.isFinite(deltaDays)) return false;
  const e = separateEnd(props) ? storedDate(row, props.endID!) : undefined;
  store.transact("Move date", (tx) => tx.update(rowID, (b) => {
    putValue(b, props.dateID, dateValue({ ...d, start: shift(d.start, deltaDays), ...(d.end !== undefined ? { end: shift(d.end, deltaDays) } : {}) }));
    if (e) putValue(b, props.endID!, dateValue({ ...e, start: shift(e.start, deltaDays), ...(e.end !== undefined ? { end: shift(e.end, deltaDays) } : {}) }));
  }));
  return true;
}

/** Uhrzeit von `at` auf den Tag `day` übertragen (Wandzeit); ohne `at` lokale Mitternacht. */
const onDay = (at: number | undefined, day: number) => (at === undefined ? dayStart(day) : shift(at, day - dayOf(at)));

/**
 * Zeitraum einer Zeile auf die Tage [startDay, endDay] setzen (inklusive; vertauschte Grenzen werden sortiert).
 * Uhrzeiten bleiben erhalten; ein eintägiger Zeitraum ohne Uhrzeit verliert sein Ende. Für Zeilen ohne Datum
 * (aus der Seitenleiste auf die Timeline gezogen) entsteht ein ganztägiger Zeitraum.
 */
export function setRowSpan(store: WorkspaceStore, rowID: string, props: SpanProperties, startDay: number, endDay: number = startDay): boolean {
  const row = store.blocks.get(rowID);
  if (!row || !Number.isFinite(startDay) || !Number.isFinite(endDay)) return false;
  if (endDay < startDay) [startDay, endDay] = [endDay, startDay];
  const d = storedDate(row, props.dateID);
  const includeTime = d?.includeTime ?? false;
  const start = onDay(d?.start, startDay);
  if (separateEnd(props)) {
    const e = storedDate(row, props.endID!);
    const endAt = onDay(e ? e.end ?? e.start : d?.end, endDay);
    const next: DateValue = { ...(d ?? {}), start, includeTime };
    delete next.end;
    const nextEnd: DateValue = { ...(e ?? {}), start: Math.max(endAt, start), includeTime: e?.includeTime ?? includeTime };
    delete nextEnd.end;
    store.transact("Change dates", (tx) => tx.update(rowID, (b) => {
      putValue(b, props.dateID, dateValue(next));
      putValue(b, props.endID!, dateValue(nextEnd));
    }));
    return true;
  }
  const next: DateValue = { ...(d ?? {}), start, includeTime };
  delete next.end;
  if (endDay > startDay || (includeTime && d?.end !== undefined)) {
    const endAt = onDay(d?.end ?? d?.start, endDay);
    next.end = Math.max(endAt, start);
  }
  const value = dateValue(next);
  if (JSON.stringify(row.values?.[props.dateID] ?? null) === JSON.stringify(value)) return false;
  store.transact("Change dates", (tx) => tx.update(rowID, (b) => putValue(b, props.dateID, value)));
  return true;
}

/** Aktueller Zeitraum (Tage) aus den gespeicherten Werten. */
export function storedSpanDays(row: Block | undefined, props: SpanProperties): { start: number; end: number } | undefined {
  const d = storedDate(row, props.dateID);
  if (!d) return undefined;
  let endAt = d.end ?? d.start;
  if (separateEnd(props)) {
    const e = storedDate(row, props.endID!);
    if (e) endAt = e.end ?? e.start;
  }
  const start = dayOf(d.start);
  return { start, end: Math.max(start, dayOf(endAt)) };
}

/** Beginn oder Ende auf `day` ziehen; das andere Ende bleibt, nie kürzer als ein Tag. */
export function resizeRowSpan(store: WorkspaceStore, rowID: string, props: SpanProperties, edge: "start" | "end", day: number): boolean {
  const cur = storedSpanDays(store.blocks.get(rowID), props);
  if (!cur) return false;
  return edge === "start" ? setRowSpan(store, rowID, props, Math.min(day, cur.end), cur.end) : setRowSpan(store, rowID, props, cur.start, Math.max(day, cur.start));
}

/**
 * Neue Zeile an einem Tag (Klick auf einen leeren Kalendertag): ganztägiges Datum, dazu `values` (Gruppe,
 * Filterwerte der Ansicht). Ein Undo-Schritt; gibt die ID zurück.
 */
export function addRowOnDay(store: WorkspaceStore, databaseID: string, props: SpanProperties, day: number, opts: AddRowOptions & { endDay?: number } = {}): string | undefined {
  const db = store.databases.get(databaseID);
  if (!db || db.properties.find((p) => p.id === props.dateID)?.type !== "date") return undefined;
  const values: Record<string, PropertyValue> = { ...(opts.values ?? {}) };
  const endDay = opts.endDay ?? day;
  const start = dayStart(Math.min(day, endDay)), last = Math.max(day, endDay);
  if (separateEnd(props)) {
    values[props.dateID] = pv("date", { start, includeTime: false });
    values[props.endID!] = pv("date", { start: dayStart(last), includeTime: false });
  } else values[props.dateID] = pv("date", last > Math.min(day, endDay) ? { start, end: dayStart(last), includeTime: false } : { start, includeTime: false });
  const { endDay: _drop, ...rest } = opts;
  return addRow(store, databaseID, { ...rest, values });
}

/** Datenbank-ID einer Zeile (bequem für die Ansicht). */
export const databaseIDOfRow = (store: WorkspaceStore, rowID: string): string | undefined => databaseOfRow(store, rowID)?.id;
