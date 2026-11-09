// BSD-152: die kleinste SQLite-Schnittstelle, die der lokale Speicher braucht. Synchron, weil der Store
// synchron schreibt (wie in Swift). Im Browser läuft das deshalb in einem Worker (SQLite-WASM + OPFS),
// in Node/Tests über node:sqlite, später in Tauri/Capacitor über natives SQLite.

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDatabase {
  /** Eine oder mehrere Anweisungen ohne Parameter. */
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  all(sql: string, params?: SqlValue[]): SqlRow[];
  /**
   * Konsistente Kopie vor einer Migration (`<datei>.bak-v<version>`), ältere Sicherungen entfernen.
   * Gibt den Namen der Sicherung zurück; `undefined` = nichts zu sichern (z. B. In-Memory).
   */
  backup?(version: number): string | undefined;
  close(): void;
}

export const first = (db: SqlDatabase, sql: string, params?: SqlValue[]): SqlRow | undefined => db.all(sql, params)[0];

export function asInt(v: SqlValue | undefined): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseInt(v, 10) || 0;
  return 0;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** BLOB- oder TEXT-Spalte als Text (Swift schreibt JSON und Meta-Werte als BLOB). */
export function asText(v: SqlValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return decoder.decode(v);
  return String(v);
}

export const utf8 = (s: string): Uint8Array => encoder.encode(s);
