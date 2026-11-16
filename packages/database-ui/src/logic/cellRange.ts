// Zellbereich in der Tabelle (wie Notion): ⇧-Pfeile oder Ziehen mit der Maus wählen ein Rechteck aus Zellen;
// ⌘C kopiert es als TSV, ⌘V fügt TSV ein, Entf leert es. Hier nur die reine Logik (ohne DOM).
import { cellText, parseCSVValue, pv, values, type Database, type PropertySchema, type PropertyValue, type QueryEngine, type WorkspaceStore, type Block } from "@based/core";
import { parseTextInput } from "./values.js";

export interface CellPos { rowID: string; col: number }
export interface CellRange { anchor: CellPos; head: CellPos }

/** Rechteck eines Bereichs als Zeilen-Positionen (in `order`) und Spalten, jeweils inklusive. */
export function rangeRect(r: CellRange, order: readonly string[]): { r0: number; r1: number; c0: number; c1: number } | undefined {
  const a = order.indexOf(r.anchor.rowID), b = order.indexOf(r.head.rowID);
  if (a < 0 || b < 0) return undefined;
  return { r0: Math.min(a, b), r1: Math.max(a, b), c0: Math.min(r.anchor.col, r.head.col), c1: Math.max(r.anchor.col, r.head.col) };
}

/** Ein Bereich aus nur einer Zelle zählt nicht als Bereich. */
export const isMulti = (r: CellRange | null | undefined): r is CellRange =>
  !!r && (r.anchor.rowID !== r.head.rowID || r.anchor.col !== r.head.col);

/** Zelle als Text (wie der CSV-Export: Ja/Nein, lange Daten, sonst angezeigter Text). */
export function cellString(store: WorkspaceStore, engine: QueryEngine, db: Database, row: Block, p: PropertySchema): string {
  const v = engine.value(row, p, db);
  if (v.t === "bool") return v.v ? "Yes" : "No";
  if (v.t === "date") return values.longDate(v.v);
  return cellText(store, v);
}

/** TSV schreiben (Felder mit Tab, Zeilenumbruch oder Anführungszeichen in Anführungszeichen, wie Tabellenprogramme). */
export function encodeTSV(table: readonly (readonly string[])[]): string {
  const field = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  return table.map((r) => r.map(field).join("\t")).join("\n");
}

/** TSV lesen (Excel, Numbers, Google Sheets, Notion). Ein abschließender Zeilenumbruch erzeugt keine leere Zeile. */
export function decodeTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false, i = 0;
  const s = text.replace(/\r\n?/g, "\n");
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' && cur === "") { quoted = true; i++; continue; }
    if (ch === "\t") { row.push(cur); cur = ""; i++; continue; }
    if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const TEXT_TYPES = new Set(["title", "text", "number", "url", "email", "phone"]);
const PASTE_TYPES = new Set([...TEXT_TYPES, "checkbox", "select", "status", "multiSelect", "date"]);

/** Darf in die Spalte eingefügt bzw. darin geleert werden? (Formeln, Rollups, Relationen … nicht.) */
export const pasteable = (p: PropertySchema) => PASTE_TYPES.has(p.type);

/**
 * Eingefügter Text → Wert. `null` = leeren, `undefined` = Zelle unverändert lassen (unbekannte Option,
 * unlesbare Zahl/Datum, nicht beschreibbarer Typ).
 */
export function pasteValue(p: PropertySchema, raw: string): PropertyValue | null | undefined {
  if (!pasteable(p)) return undefined;
  if (TEXT_TYPES.has(p.type)) return parseTextInput(p.type, raw);
  const s = raw.trim();
  if (p.type === "checkbox") return pv("checkbox", /^(yes|true|1|✓|☑|x|checked)$/i.test(s));
  if (s === "") return null;
  return parseCSVValue(s, p);
}

/**
 * Einfügen planen: Kopiertes Raster ab der linken oberen Zelle; ein einzelner Wert füllt einen gewählten Bereich ganz
 * (wie Notion). Liefert die Zellen-Änderungen; über das Ende der Zeilen/Spalten hinaus wird abgeschnitten.
 */
export function planPaste(
  grid: readonly (readonly string[])[], target: { r0: number; r1: number; c0: number; c1: number },
  order: readonly string[], props: readonly PropertySchema[],
): { rowID: string; propertyID: string; value: PropertyValue | null }[] {
  if (!grid.length) return [];
  const single = grid.length === 1 && grid[0]!.length === 1;
  const h = single ? target.r1 - target.r0 + 1 : grid.length;
  const w = single ? target.c1 - target.c0 + 1 : Math.max(...grid.map((r) => r.length));
  const out: { rowID: string; propertyID: string; value: PropertyValue | null }[] = [];
  for (let i = 0; i < h; i++) {
    const rowID = order[target.r0 + i];
    if (rowID === undefined) break;
    for (let j = 0; j < w; j++) {
      const p = props[target.c0 + j];
      if (!p) break;
      const raw = single ? grid[0]![0]! : grid[i]?.[j];
      if (raw === undefined) continue;
      const value = pasteValue(p, raw);
      if (value !== undefined) out.push({ rowID, propertyID: p.id, value });
    }
  }
  return out;
}
