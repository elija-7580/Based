// BSD-148: Records lesen und schreiben, ohne etwas zu verlieren (ADR 0002).
import { z } from "zod";
import { canonicalStringify } from "../json.js";
import * as S from "./schema.js";

export type Stamp = z.infer<typeof S.stamp>;
export type RichText = z.infer<typeof S.richText>;
export type TextRun = z.infer<typeof S.textRun>;
export type PropertyValue = z.infer<typeof S.propertyValue>;
export type BlockProps = z.infer<typeof S.blockProps>;
export type Block = z.infer<typeof S.block>;
export type PropertySchema = z.infer<typeof S.propertySchema>;
export type PropertyRecord = z.infer<typeof S.propertyRecord>;
export type Database = z.infer<typeof S.database>;
export type DatabaseView = z.infer<typeof S.databaseView>;
export type Workspace = z.infer<typeof S.workspace>;
export type RecordKind = z.infer<typeof S.recordKind>;
export type WireRecord = z.infer<typeof S.record>;
export type RecordKey = z.infer<typeof S.recordKey>;
export type Tombstone = z.infer<typeof S.tombstone>;
export type { FilterCondition, FilterGroup, FilterItem, FilterValue } from "./schema.js";

const byKind = { block: S.block, database: S.database, view: S.databaseView, workspace: S.workspace, property: S.propertyRecord } as const;

/** Prüft einen Record `{kind, data}`. Wirft bei ungültigen Daten (wie Swift beim strikten Dekodieren). */
export function parseRecord(value: unknown): WireRecord {
  return S.record.parse(value);
}

/** Wie `parseRecord`, aber ohne Ausnahme: für empfangene Listen (ein kaputter Record wird übersprungen). */
export function safeParseRecord(value: unknown): { ok: true; record: WireRecord } | { ok: false; error: z.ZodError } {
  const r = S.record.safeParse(value);
  return r.success ? { ok: true, record: r.data } : { ok: false, error: r.error };
}

/**
 * Wie `safeParseRecord` für `{kind, data}`, wenn die Art schon feststeht (Laden aus der Datei): prüft `data` direkt
 * gegen das Schema der Art, ohne den Umweg über die Vereinigung aller Arten (gemessen 18.11.: 100 000 Blöcke rund ein
 * Drittel schneller). Dieselbe Prüfung; scheitert sie, kommt die Meldung aus `safeParseRecord` (unverändert).
 */
export function safeParseRecordOfKind(kind: RecordKind, data: unknown): { ok: true; record: WireRecord } | { ok: false; error: z.ZodError } {
  const r = byKind[kind].safeParse(data);
  if (r.success) return { ok: true, record: { kind, data: r.data } as WireRecord };
  const whole = safeParseRecord({ kind, data });
  return whole.ok ? whole : { ok: false, error: whole.error };
}

/** Nur die Nutzdaten eines Records einer bestimmten Art. */
export function parseRecordData<K extends RecordKind>(kind: K, data: unknown): z.infer<(typeof byKind)[K]> {
  return byKind[kind].parse(data) as z.infer<(typeof byKind)[K]>;
}

/** Kanonische Bytes eines Records, identisch zu dem, was Swift mit `.sortedKeys` schreibt. */
export function encodeRecord(record: WireRecord): string {
  return canonicalStringify(record);
}

/** Schlüssel eines Records. */
export function recordKeyOf(record: WireRecord): RecordKey {
  return { kind: record.kind, id: record.data.id };
}

export { compareStamps } from "../hlc.js";
