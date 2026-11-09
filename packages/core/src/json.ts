// JSON-Werte und kanonische Serialisierung (BSD-148).
// Kanonisch = so, wie Swift mit `outputFormatting = [.sortedKeys, .withoutEscapingSlashes]` schreibt:
// Schlüssel sortiert, keine Leerzeichen, `/` unmaskiert. Damit lassen sich Records byte-genau mit der
// Swift-Version vergleichen (Golden Fixtures unter fixtures/).
import { z } from "zod";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export const jsonValue: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

/** Schlüsselvergleich wie Swifts `.sortedKeys` für die Schlüssel, die im Datenmodell vorkommen (ASCII). */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Serialisiert wie Swift mit sortierten Schlüsseln; `undefined`-Felder entfallen wie bei JSON.stringify. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Nicht als JSON darstellbar: ${value}`);
    const s = JSON.stringify(value);
    if (s === undefined) throw new Error(`Nicht als JSON darstellbar: ${String(value)}`);
    return s;
  }
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalStringify(v))).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalStringify(v)).join(",") + "}";
}

/** Swift `Date` (Standard-Codable) = Sekunden seit 2001-01-01T00:00:00Z. */
export const SWIFT_REFERENCE_DATE_UNIX_MS = 978_307_200_000;
export const dateFromSwift = (seconds: number): Date => new Date(SWIFT_REFERENCE_DATE_UNIX_MS + seconds * 1000);
export const dateToSwift = (date: Date): number => (date.getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;
