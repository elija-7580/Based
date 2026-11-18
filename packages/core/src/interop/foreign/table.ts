// Hilfen für Exporte anderer Apps: Sie werden in einen Dateibaum übersetzt, den die vorhandenen Importer lesen –
// eine Liste von Notizen mit Angaben (Tags, Datum …) als CSV-Datenbank mit einer Markdown-Seite je Zeile.
import { ImportFiles, type LazyFile } from "../files.js";
import { encodeCSV } from "../markdown.js";

/** Trenner im CSV-Kopf für eine Typangabe („Tags\u0000multiSelect“) – nur intern, kommt in echten Dateien nicht vor. */
export const HINT = "\u0000";
/** Interne Spalte: Pfad der Markdown-Seite der Zeile (relativ zur CSV). */
export const FILE_COLUMN = HINT + "file";

export type ColumnType = "text" | "multiSelect" | "select" | "date" | "checkbox" | "url" | "number";
export interface TableRow {
  title: string;
  cells: (string | undefined)[];
  /** Markdown-Inhalt der Seite. */
  body: string;
  /** Dateien neben der Seite (Name → Bytes), im Inhalt als `![](name)` bzw. `[x](name)` verwendet. */
  files?: Map<string, Uint8Array | LazyFile> | undefined;
}
export interface TableExport {
  name: string;
  titleColumn?: string;
  columns: { name: string; type: ColumnType }[];
  rows: TableRow[];
}

const enc = new TextEncoder();

/** Tabelle in den Baum schreiben: „<name>.csv“ und je Zeile „<name>/<n>/page.md“ (Dateien daneben). */
export function addTable(files: ImportFiles, t: TableExport, dir = "") {
  const at = (p: string) => (dir === "" ? p : dir + "/" + p);
  const header = [t.titleColumn ?? "Name", ...t.columns.map((c) => c.name + HINT + c.type), FILE_COLUMN];
  const rows = t.rows.map((r, i) => {
    const rel = `${t.name}/${i + 1}/page.md`;
    files.add(at(rel), enc.encode(r.body));
    if (r.files) for (const [n, d] of r.files) {
      if (d instanceof Uint8Array) files.add(at(`${t.name}/${i + 1}/${n}`), d);
      else files.addLazy(at(`${t.name}/${i + 1}/${n}`), d);
    }
    return [r.title, ...t.columns.map((_, ci) => r.cells[ci] ?? ""), rel];
  });
  files.add(at(t.name + ".csv"), enc.encode(encodeCSV([header, ...rows], { guardFormulas: false })));
}

/** ISO-Zeit für eine Datumszelle (UTC, sekundengenau); `undefined` bei ungültiger Zeit. */
export function isoCell(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Reinen Text so schreiben, dass der Markdown-Leser ihn nicht als Formatierung liest. */
export function escapeText(text: string): string {
  return text.replaceAll("\r\n", "\n").split("\n").map((line) => {
    const s = line.replace(/([\\*_`[\]<$~])/g, "\\$1");
    // Zeilenanfänge, die Blöcke wären (Überschrift, Zitat, Tabelle, Trenner, Code-Zaun)
    return s.replace(/^(\s*)(#{1,6} |>|\||-{3,}\s*$|={3,}\s*$)/, "$1\\$2");
  }).join("\n");
}

/** Dateiname ohne Zeichen, die in Pfaden stören. */
export function safeName(name: string, fallback = "Untitled"): string {
  const s = [...name].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").replace(/[/\\:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
  return s === "" ? fallback : s;
}

/** Eindeutige Namen vergeben („Titel“, „Titel (2)“ …; ohne Rücksicht auf Groß/klein). */
export function uniqueNamer(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name) => {
    const k = name.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 1) return name;
    const next = `${name} (${n})`;
    seen.set(next.toLowerCase(), 1);
    return next;
  };
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export const isObj = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export function parseJSON(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  try { return JSON.parse(text.replace(/^\uFEFF/, "")) as Json; } catch { return undefined; }
}
