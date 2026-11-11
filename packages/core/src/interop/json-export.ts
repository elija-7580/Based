// BSD-260 Teil 5: Seite als JSON – für Skripte und andere Programme. Verlustarm und stabil beschrieben:
// { format: "based.page", version: 1, id, title, icon?, created, updated, properties?, blocks[], rows? }
// - Zeiten als ISO 8601 (UTC); Properties einer Datenbankzeile nach Namen, Werte als JSON (Zahl, Wahrheitswert,
//   Text, Liste, Datum {start, end?, includeTime}).
// - Blöcke: type, text (Markdown-Inline), plain, die Rohdaten `richText` und `props` (wie gespeichert), children;
//   Unterseiten erscheinen als Block `page` mit id und Titel (nicht ausgeklappt).
// - Datenbankseiten: `rows` mit Titel und Properties.
import type { Block, Database } from "../model/records.js";
import { cellText, QueryEngine, rowsOf, titleOf } from "../query/engine.js";
import { isEmptyValue, type Value } from "../query/value.js";
import type { WorkspaceStore } from "../store/store.js";
import { encodeInlineMarkdown } from "./markdown.js";
import { markdownFileName } from "./markdown-export.js";
import { plain, runsOf } from "./runs.js";

type JSONish = null | boolean | number | string | JSONish[] | { [k: string]: JSONish };

const iso = (swiftSeconds: number, withTime = true) => {
  const d = new Date(swiftSeconds * 1000 + 978_307_200_000).toISOString();
  return withTime ? d : d.slice(0, 10);
};

function valueJSON(store: WorkspaceStore, v: Value): JSONish {
  switch (v.t) {
    case "number": return v.v;
    case "bool": return v.v;
    case "date": return { start: iso(v.v.start, v.v.includeTime), ...(v.v.end !== undefined ? { end: iso(v.v.end, v.v.includeTime) } : {}), includeTime: v.v.includeTime };
    case "list": return v.v.map((x) => valueJSON(store, x));
    default: return cellText(store, v);
  }
}

function propertiesOf(store: WorkspaceStore, q: QueryEngine, row: Block, db: Database): Record<string, JSONish> {
  const out: Record<string, JSONish> = {};
  for (const p of db.properties) {
    if (p.type === "title") continue;
    const v = q.value(row, p, db);
    if (!isEmptyValue(v)) out[p.name] = valueJSON(store, v);
  }
  return out;
}

export function exportPageJSON(store: WorkspaceStore, pageID: string): { name: string; json: string; value: Record<string, JSONish> } {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const q = new QueryEngine(store);
  const pageLink = (id: string) => ({ title: titleOf(store, id), url: `based://page/${id}` });
  const children = (parent: string): JSONish[] => store.children(parent)
    .map((id) => store.blocks.get(id))
    .filter((b): b is Block => b !== undefined && b.trashedAt === undefined)
    .map((b) => {
      if (b.type === "page" || b.type === "databasePage") return { id: b.id, type: b.type, title: titleOf(store, b.id) };
      const o: Record<string, JSONish> = { id: b.id, type: b.type };
      if (b.text !== undefined) {
        o.text = encodeInlineMarkdown(b.text, pageLink);
        o.plain = plain(runsOf(b.text));
        o.richText = JSON.parse(JSON.stringify(b.text)) as JSONish;
      }
      if (b.props && Object.keys(b.props).length > 0) o.props = JSON.parse(JSON.stringify(b.props)) as JSONish;
      const kids = children("b:" + b.id);
      if (kids.length > 0) o.children = kids;
      return o;
    });
  const title = titleOf(store, pageID);
  const value: Record<string, JSONish> = { format: "based.page", version: 1, id: page.id, title };
  if (typeof page.props?.icon === "string") value.icon = page.props.icon;
  value.created = iso(page.createdAt);
  value.updated = iso(page.updatedAt);
  const parentDB = page.parent.startsWith("d:") ? store.databases.get(page.parent.slice(2)) : undefined;
  if (parentDB) value.properties = propertiesOf(store, q, page, parentDB);
  value.blocks = children("b:" + page.id);
  const dbID = page.props?.databaseID;
  const db = (page.type === "databasePage" || page.type === "databaseInline") && dbID !== undefined ? store.databases.get(dbID) : undefined;
  if (db) value.rows = rowsOf(store, db.id).map((r) => ({ id: r.id, title: titleOf(store, r.id), properties: propertiesOf(store, q, r, db) }));
  return { name: markdownFileName(title) + ".json", json: JSON.stringify(value, null, 2) + "\n", value };
}
