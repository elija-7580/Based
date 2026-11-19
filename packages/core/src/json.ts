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

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isScalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/**
 * BSD-604: `canonicalStringify(a) === canonicalStringify(b)`, ohne die Texte zu bauen. Der Store vergleicht so jeden
 * geänderten Record beim Commit; bei 100 000 Zeilen (Spalte „ID“ anlegen) kostete das Serialisieren ~600 ms am Stück.
 * Gleiche Regeln: Schlüsselreihenfolge egal, `undefined`-Felder entfallen, `undefined` im Array zählt als `null`,
 * `-0` gleich `0`. Was kein JSON-Wert, kein Array und kein einfaches Objekt ist (Date, Map, NaN, `undefined` ganz
 * oben …), geht weiter über `canonicalStringify` – das Ergebnis bleibt gleich (wo der Text-Vergleich wirft, darf
 * dieser schon vorher `false` sagen).
 */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  if (isScalar(a) && isScalar(b)) return a === b;
  const ao = typeof a === "object" && a !== null, bo = typeof b === "object" && b !== null;
  if (!ao || !bo) {
    // genau einer ein einfacher Wert, der andere Array/Objekt: verschieden (beide Seiten bleiben darstellbar)
    if ((isScalar(a) && bo && (Array.isArray(b) || isPlain(b))) || (isScalar(b) && ao && (Array.isArray(a) || isPlain(a)))) return false;
    return canonicalStringify(a) === canonicalStringify(b);
  }
  const aa = Array.isArray(a), ba = Array.isArray(b);
  if (aa && ba) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!canonicalEqual(a[i] === undefined ? null : a[i], b[i] === undefined ? null : b[i])) return false;
    return true;
  }
  if (!aa && !ba && isPlain(a) && isPlain(b)) {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    let n = 0;
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (v === undefined) continue;
      n += 1;
      const w = y[k];
      if (w === undefined || !Object.prototype.hasOwnProperty.call(y, k) || !canonicalEqual(v, w)) return false;
    }
    for (const k of Object.keys(y)) if (y[k] !== undefined) n -= 1;
    return n === 0;
  }
  if ((aa && isPlain(b)) || (ba && isPlain(a))) return false;
  return canonicalStringify(a) === canonicalStringify(b);
}

/** Swift `Date` (Standard-Codable) = Sekunden seit 2001-01-01T00:00:00Z. */
export const SWIFT_REFERENCE_DATE_UNIX_MS = 978_307_200_000;
export const dateFromSwift = (seconds: number): Date => new Date(SWIFT_REFERENCE_DATE_UNIX_MS + seconds * 1000);
export const dateToSwift = (date: Date): number => (date.getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;

/**
 * Tiefe Kopie eines Records (BSD-435). Records sind reines JSON; Arrays und einfache Objekte werden hier direkt kopiert –
 * rund dreimal schneller als `structuredClone`, das beim Einspielen von 100 000 Zeilen die halbe Zeit kostete. Alles
 * andere (Date, Map, Uint8Array …) geht weiter über `structuredClone`, damit das Ergebnis gleich bleibt.
 */
export function cloneRecord<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneRecord(value[i]);
    return out as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out: Record<string, unknown> = {};
  for (const k in value) out[k] = cloneRecord((value as Record<string, unknown>)[k]);
  return out as T;
}
