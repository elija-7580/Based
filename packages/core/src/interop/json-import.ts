// BSD-260 Teil 7: JSON und JSON Lines importieren.
// - Based-Seiten-JSON (`format: "based.page"`, aus dem JSON-Export, Teil 5): Seite mit Titel, Icon und Blöcken
//   (Typ, Rich Text bzw. Markdown-Inline, geprüfte Eigenschaften, Kinder). Neue IDs; Unterseiten und Datenbanken
//   aus dem Export kommen als leere Unterseite bzw. Titelzeile (der Export klappt sie nicht aus).
// - Tabellen-JSON: eine Liste von Objekten (oder `{ "irgendwas": [ … ] }`) bzw. JSONL mit einem Objekt je Zeile →
//   CSV-Text, den der CSV-Import als Datenbank anlegt (Spalten = Schlüssel in Reihenfolge des Auftretens;
//   Listen von Skalaren mit Komma – wird Mehrfachauswahl –, andere verschachtelte Werte als JSON-Text).
// - Alles andere (beliebiges JSON, ungültig): wie bisher übersprungen mit Hinweis (Swift-Verhalten, Golden Fixture).
import type { BlockProps, WireRecord } from "../model/records.js";
import { ENUMS } from "../model/schema.js";
import * as S from "../model/schema.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { emptyReport, makeBlock, makeRecordID, type ImportReport } from "./builder.js";
import { decodeInlineMarkdown, encodeCSV } from "./markdown.js";
import { toRichText } from "./runs.js";

const BLOCK_TYPES = new Set<string>(ENUMS.BlockType);
/** Verweise auf Records des exportierenden Workspaces – hier ohne Ziel. */
const DROP_PROPS = new Set(["databaseID", "viewIDs", "syncedFrom", "syncedFromID", "sourceBlockID", "templateID"]);
const MAX_DEPTH = 64;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

export type JSONImportPlan =
  | { kind: "page"; run: (opts: JSONImportOptions) => { records: WireRecord[]; rootKeys: string[]; report: ImportReport } }
  | { kind: "csv"; name: string; csv: string; rows: number }
  | { kind: "none" };

export interface JSONImportOptions {
  now?: (() => number) | undefined;
  userID?: string | null | undefined;
  afterKey?: string | undefined;
}

/** JSON (eine Datei) oder JSON Lines (ein Wert je Zeile) lesen. `undefined` = kein gültiges JSON. */
export function parseJSONFile(text: string, jsonl: boolean): Json | undefined {
  const t = text.replace(/^\uFEFF/, "");
  if (!jsonl) {
    try { return JSON.parse(t) as Json; } catch { /* vielleicht doch JSONL */ }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return undefined;
  const out: Json[] = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l) as Json); } catch { return undefined; }
  }
  return out;
}

/** Tabelle aus einer Liste von Objekten (mindestens ein Objekt, alle Einträge Objekte). */
function tableOf(v: Json): Record<string, Json>[] | undefined {
  if (Array.isArray(v)) return v.length > 0 && v.every(isObj) ? (v as Record<string, Json>[]) : undefined;
  if (isObj(v)) {
    const lists = Object.values(v).filter((x) => Array.isArray(x));
    if (Object.keys(v).length === 1 && lists.length === 1) return tableOf(lists[0]!);
  }
  return undefined;
}

const scalar = (v: Json): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** Zelle: Skalare als Text, Listen von Skalaren mit Komma (der CSV-Import macht daraus Mehrfachauswahl), sonst JSON. */
const cell = (v: Json | undefined): string => (v === undefined || v === null ? "" : scalar(v) ? String(v)
  : Array.isArray(v) && v.every(scalar) ? v.map(String).join(", ") : JSON.stringify(v));

/** Was aus der Datei wird (Seite oder CSV für den Datenbank-Import). */
export function planJSONImport(text: string, fallbackTitle: string, jsonl: boolean): JSONImportPlan {
  const v = parseJSONFile(text, jsonl);
  if (v === undefined) return { kind: "none" };
  if (isObj(v) && v.format === "based.page") return { kind: "page", run: (o) => basedPage(v, fallbackTitle, o) };
  const rows = tableOf(v);
  if (rows) {
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    // Die erste Spalte wird der Titel: ein Feld wie „title“/„name“ nach vorn.
    const t = cols.findIndex((c) => /^(title|name|titel)$/i.test(c));
    if (t > 0) cols.unshift(...cols.splice(t, 1));
    const csv = encodeCSV([cols, ...rows.map((r) => cols.map((c) => cell(r[c])))], { guardFormulas: false });
    return { kind: "csv", name: fallbackTitle + ".csv", csv, rows: rows.length };
  }
  return { kind: "none" };
}

function cleanProps(p: Json | undefined): BlockProps {
  if (!isObj(p)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (DROP_PROPS.has(k)) continue;
    const one = S.blockProps.safeParse({ [k]: v });
    if (one.success) out[k] = v;
  }
  return out as BlockProps;
}

function basedPage(v: Record<string, Json>, fallbackTitle: string, o: JSONImportOptions) {
  const now = o.now ?? (() => (Date.now() - 978_307_200_000) / 1000);
  const userID = o.userID === undefined ? "me" : o.userID;
  const report = emptyReport();
  const records: WireRecord[] = [];
  const pageID = makeRecordID();
  const key = keyBetween(o.afterKey, undefined);
  const title = typeof v.title === "string" && v.title.trim() !== "" ? v.title : fallbackTitle;
  const props: BlockProps = typeof v.icon === "string" && v.icon !== "" ? { icon: v.icon } : {};
  records.push({ kind: "block", data: makeBlock({ id: pageID, type: "page", parent: "w", sk: key, text: title, props, createdBy: userID }, now()) });
  report.pages = 1;
  report.rootIDs.push(pageID);
  let skipped = 0, subpages = 0, databases = 0;
  const put = (list: Json | undefined, parent: string, depth: number) => {
    if (!Array.isArray(list)) return;
    const items = list.filter(isObj);
    const keys = keysBetween(items.length, undefined, undefined);
    items.forEach((b, i) => {
      const id = makeRecordID();
      let type = typeof b.type === "string" ? b.type : "text";
      if (type === "databasePage" || type === "databaseInline" || type === "linkedDatabase") {
        // Datenbanken kommen im Seiten-JSON nur als Verweis: Titel als Zeile
        databases += 1;
        const t = typeof b.title === "string" ? b.title : "Untitled database";
        records.push({ kind: "block", data: makeBlock({ id, type: "text", parent, sk: keys[i]!, text: t, createdBy: userID }, now()) });
        return;
      }
      if (type === "page") {
        subpages += 1;
        const t = typeof b.title === "string" ? b.title : "Untitled";
        records.push({ kind: "block", data: makeBlock({ id, type: "page", parent, sk: keys[i]!, text: t, createdBy: userID }, now()) });
        return;
      }
      if (!BLOCK_TYPES.has(type)) { skipped += 1; type = "text"; }
      const rich = S.richText.safeParse(b.richText);
      const text = rich.success ? rich.data
        : typeof b.text === "string" ? toRichText(decodeInlineMarkdown(b.text))
          : typeof b.plain === "string" ? b.plain : undefined;
      records.push({ kind: "block", data: makeBlock({ id, type, parent, sk: keys[i]!, ...(text !== undefined ? { text } : {}), props: cleanProps(b.props), createdBy: userID }, now()) });
      if (depth < MAX_DEPTH) put(b.children, "b:" + id, depth + 1);
    });
  };
  put(v.blocks, "b:" + pageID, 0);
  if (subpages > 0) report.warnings.push(`${title}: ${subpages} sub-page${subpages === 1 ? "" : "s"} imported by title only (the JSON export doesn't include their content)`);
  if (databases > 0) report.warnings.push(`${title}: ${databases} database${databases === 1 ? "" : "s"} imported by title only`);
  if (Array.isArray(v.rows) && v.rows.length > 0) report.warnings.push(`${title}: database rows aren't imported from page JSON — export the database as CSV instead`);
  if (skipped > 0) report.warnings.push(`${title}: ${skipped} block${skipped === 1 ? "" : "s"} of an unknown type imported as text`);
  return { records, rootKeys: [key], report };
}
