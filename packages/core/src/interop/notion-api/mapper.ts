// BSD-217: übersetzt einen `NotionSnapshot` (rohe API-Objekte) in Based-Blöcke, -Datenbanken und -Ansichten (Port von
// Swift `NotionAPIMapper`). IDs sind Notions eigene: ein zweiter Import derselben Seite aktualisiert sie an Ort und
// Stelle. Reine Funktion über den Snapshot; Golden Fixtures: fixtures/import/notion-api.utc.json.
import type { JSONValue } from "../../json.js";
import { canonicalStringify, SWIFT_REFERENCE_DATE_UNIX_MS } from "../../json.js";
import type { Block, BlockProps, Database, DatabaseView, PropertySchema, PropertyValue, RichText } from "../../model/records.js";
import type { FilterCondition, FilterGroup, FilterItem, FilterValue } from "../../model/records.js";
import { Formula, FUNCTION_NAMES } from "../../query/formula.js";
import { plainNumber } from "../../query/value.js";
import { formatDateValue } from "../../store/conversion.js";
import { DASHBOARD_COLUMNS, evenWidths } from "../../store/database-ops.js";
import { FIRST_KEY, keyBetween } from "../../sortkeys.js";
import { ZERO_STAMP } from "../../hlc.js";
import type { ImportBuilder, AssetRef } from "../builder.js";
import { derivedID, notionIDInName, notionUUID, removingPercentEncoding } from "../importids.js";
import { normalize, toRichText, type Marks, type Run } from "../runs.js";
import { at, jarr, jobj, jstr, nid, notionFileKey, notionTitle, type NotionSnapshot } from "./crawler.js";

type DateValue = { start: number; end?: number; includeTime: boolean };
type ViewProperty = NonNullable<DatabaseView["properties"]>[number];
type ChartConfig = NonNullable<DatabaseView["chart"]>;
type Obj = { [k: string]: JSONValue };

const TITLE_ID = "title";
const AVAILABLE_VIEWS = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "map", "form", "dashboard"];
const VIEW_TYPES = ["board", "calendar", "chart", "dashboard", "feed", "form", "gallery", "list", "map", "table", "timeline"];
const TCOLORS = new Set(["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
  "grayBackground", "brownBackground", "orangeBackground", "yellowBackground", "greenBackground", "blueBackground", "purpleBackground", "pinkBackground", "redBackground"]);
const tcolor = (s: string | undefined, fallback: string) => (s !== undefined && TCOLORS.has(s) ? s : fallback);
const num = (v: JSONValue | undefined) => (typeof v === "number" ? v : undefined);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const pct = (s: string) => removingPercentEncoding(s) ?? s;
const isEmptyRT = (t: RichText) => (typeof t === "string" ? t === "" : t.length === 0);
const plainRT = (t: RichText) => (typeof t === "string" ? t : t.map((r) => r.t ?? "").join(""));
/** Swift `JSONValue.text`: sortierte Schlüssel, „/“ maskiert. */
const swiftJSONText = (v: JSONValue | undefined) => (v === undefined ? "null" : canonicalStringify(v).replaceAll("/", "\\/"));
const ISO_FULL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function notionColor(s: string | undefined): string | undefined {
  if (s === undefined || s === "default") return undefined;
  const c = s.endsWith("_background") ? s.slice(0, -"_background".length) + "Background" : s;
  return TCOLORS.has(c) ? c : undefined;
}

export function numberFormat(s: string | undefined): string | undefined {
  if (s === undefined || s === "number") return undefined;
  const map: Record<string, string> = { number_with_commas: "numberWithCommas", percent: "percent", euro: "euro", pound: "pound", yen: "yen", franc: "franc",
    rupee: "rupee", won: "won", yuan: "yuan", real: "real", ruble: "ruble", lira: "lira" };
  return map[s] ?? (s.endsWith("dollar") ? "dollar" : "numberWithCommas");
}

export function rollupFunction(s: string | undefined): string | undefined {
  const map: Record<string, string> = {
    show_original: "showOriginal", show_unique: "showOriginal", count: "countAll", count_all: "countAll", count_values: "countValues",
    unique: "countUnique", count_unique_values: "countUnique", empty: "countEmpty", count_empty: "countEmpty", not_empty: "countNotEmpty",
    count_not_empty: "countNotEmpty", percent_empty: "percentEmpty", percent_not_empty: "percentNotEmpty", sum: "sum", average: "average",
    median: "median", min: "min", max: "max", range: "range", earliest_date: "earliest", latest_date: "latest", date_range: "dateRange",
    checked: "checked", unchecked: "unchecked", percent_checked: "percentChecked", percent_unchecked: "percentUnchecked",
  };
  return map[s ?? "show_original"];
}

const PLACEHOLDER = /\{\{notion:block_property:([^:}]+)(?::[^}]*)?\}\}/g;
const replacePlaceholders = (s: string, f: (id: string) => string) => s.replace(PLACEHOLDER, (_m, id: string) => f(id));

/** `{{notion:block_property:ID:…}}` → `prop("Name")`; `undefined`, wenn Based die Formel nicht auswerten kann. */
export function convertNotionFormula(expr: string, names: ReadonlyMap<string, string>): string | undefined {
  if (expr === "") return undefined;
  let ok = true;
  const out = replacePlaceholders(expr, (id) => {
    const n = names.get(pct(id)) ?? names.get(id);
    if (n === undefined) { ok = false; return 'prop("?")'; }
    return 'prop("' + n.replaceAll('"', '\\"') + '")';
  });
  if (!ok) return undefined;
  try { new Formula(out); } catch { return undefined; }
  const known = new Set<string>(FUNCTION_NAMES);
  for (const m of out.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) if (!known.has(m[1]!)) return undefined;
  return out;
}

export function readableNotionFormula(expr: string, names: ReadonlyMap<string, string>): string {
  return replacePlaceholders(expr, (id) => `prop("${names.get(pct(id)) ?? names.get(id) ?? id}")`);
}

export const notionPropertyID = (ds: string, notionID: string) => derivedID(ds, "prop", pct(notionID));
const sameID = (a: string, b: string) => a === b || pct(a) === pct(b);

/** Swift-Datum (Sekunden seit 2001) aus ISO-Zeit. */
function isoSeconds(s: string): number | undefined {
  if (!ISO_FULL.test(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? (ms - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000 : undefined;
}
function daySeconds(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  return (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;
}

export function mapNotionSnapshot(snap: NotionSnapshot, builder: ImportBuilder): void {
  new Mapper(snap, builder).run();
}

class Mapper {
  private readonly reachable = new Set<string>();
  private readonly blockIDs = new Set<string>();
  private importedIDs = new Set<string>();
  private readonly mappedPages = new Set<string>();
  private readonly mappedContainers = new Set<string>();
  private readonly schemas = new Map<string, PropertySchema[]>();
  private readonly propIndex = new Map<string, Map<string, PropertySchema>>();
  private readonly owner = new Map<string, string>();
  private readonly liveFormula = new Set<string>();
  private readonly unsupported = new Map<string, number>();
  private approximations = 0;
  private widgetCache: Set<string> | undefined;

  constructor(private readonly snap: NotionSnapshot, private readonly builder: ImportBuilder) {}

  run() {
    this.precompute();
    const sources = [...this.snap.dataSources.keys()].sort();
    for (const ds of sources) this.buildSchema(ds);
    for (const root of this.snap.roots) {
      if ("page" in root) { if (!this.reachable.has(root.page)) this.mapPage(root.page, "w", true, undefined); }
      else if (!this.reachable.has(root.database)) this.mapContainer(root.database, "w", true, false, undefined);
    }
    for (const ds of sources) {
      if (this.owner.has(ds)) continue;
      const db = nid(at(this.snap.dataSources.get(ds), "parent", "database_id"));
      if (db && this.snap.databases.has(db) && !this.mappedContainers.has(db)) this.mapContainer(db, "w", true, false, undefined);
      if (!this.owner.has(ds)) this.mapOrphanSource(ds);
    }
    this.finish();
  }

  private precompute() {
    for (const kids of this.snap.children.values()) {
      for (const k of kids) {
        const id = nid(at(k, "id"));
        if (!id) continue;
        this.blockIDs.add(id);
        const t = jstr(at(k, "type"));
        if (t === "child_page" || t === "child_database") this.reachable.add(id);
      }
    }
    for (const rows of this.snap.rows.values()) for (const r of rows) this.reachable.add(r);
    this.importedIDs = new Set([...this.snap.pages.keys(), ...this.snap.databases.keys(), ...this.blockIDs]);
  }

  // MARK: Seiten und Blöcke

  private mapPage(id: string, parent: string, root: boolean, fallbackTitle: string | undefined) {
    if (this.mappedPages.has(id)) return;
    this.mappedPages.add(id);
    const p = this.snap.pages.get(id);
    if (p === undefined) {
      const now = this.builder.now();
      const b: Block = { id, type: "page", parent, sk: "", text: fallbackTitle ?? "Untitled", createdAt: now, updatedAt: now };
      if (this.builder.createdBy !== null) { b.createdBy = this.builder.createdBy; b.updatedBy = this.builder.createdBy; }
      this.builder.add(b, root);
      return;
    }
    const props: BlockProps = {};
    const icon = this.icon(at(p, "icon")); if (icon !== undefined) props.icon = icon;
    const cover = this.cover(at(p, "cover")); if (cover !== undefined) props.cover = cover;
    if (at(p, "is_locked") === true) props.format = { locked: true };
    let text = this.titleText(p);
    if (isEmptyRT(text) && fallbackTitle !== undefined) text = fallbackTitle;
    this.builder.add(this.block("page", p, parent, text, props), root);
    this.mapChildren(id, "b:" + id);
  }

  private mapChildren(owner: string, parent: string) {
    const kids = this.snap.children.get(owner);
    if (!kids) return;
    for (const k of kids) this.mapBlock(k, parent);
    this.builder.markComplete(parent);
  }

  private mapBlock(j: JSONValue, parent: string) {
    const type = jstr(at(j, "type")), id = nid(at(j, "id"));
    if (!type || !id) return;
    if (at(j, "in_trash") === true || at(j, "archived") === true) return;
    const body = at(j, type);
    const props: BlockProps = {};
    let text: RichText = "";
    let bt: string;
    let childrenAllowed = true;
    const c = notionColor(jstr(at(body, "color"))); if (c !== undefined) props.color = c;
    const rich = (k = "rich_text") => this.richText(at(body, k));
    const caption = () => { const cp = rich("caption"); if (!isEmptyRT(cp)) props.caption = cp; };
    switch (type) {
      case "paragraph": bt = "text"; text = rich(); break;
      case "heading_1": case "heading_2": case "heading_3": case "heading_4":
        bt = "heading" + type.slice(-1); text = rich();
        if (at(body, "is_toggleable") === true) props.toggleable = true;
        break;
      case "bulleted_list_item": bt = "bulletedList"; text = rich(); break;
      case "numbered_list_item": bt = "numberedList"; text = rich(); break;
      case "to_do": bt = "todo"; text = rich(); props.checked = at(body, "checked") === true; break;
      case "toggle": bt = "toggle"; text = rich(); break;
      case "quote": bt = "quote"; text = rich(); break;
      case "callout": { bt = "callout"; text = rich(); const i = this.icon(at(body, "icon")); if (i !== undefined) props.icon = i; break; }
      case "code": {
        bt = "code"; text = plainRT(rich());
        const lang = jstr(at(body, "language")); if (lang !== undefined) props.language = lang.toLowerCase();
        caption(); childrenAllowed = false; break;
      }
      case "equation": bt = "equation"; props.expression = jstr(at(body, "expression")) ?? ""; childrenAllowed = false; break;
      case "divider": bt = "divider"; childrenAllowed = false; break;
      case "breadcrumb": bt = "breadcrumb"; childrenAllowed = false; break;
      case "table_of_contents": bt = "tableOfContents"; childrenAllowed = false; break;
      case "image": case "video": case "audio": case "file": case "pdf": {
        bt = type;
        const m = this.media(body);
        if (m.asset) props.asset = m.asset; if (m.url !== undefined) props.url = m.url;
        caption(); childrenAllowed = false; break;
      }
      case "bookmark": case "link_preview": case "embed": {
        bt = type === "embed" ? "embed" : "bookmark";
        const u = jstr(at(body, "url")); if (u !== undefined) props.url = u;
        caption(); childrenAllowed = false; break;
      }
      case "child_page": this.mapPage(id, parent, false, jstr(at(body, "title"))); return;
      case "child_database": {
        const inline = at(this.snap.databases.get(id), "is_inline");
        this.mapContainer(id, parent, false, typeof inline === "boolean" ? inline : true, jstr(at(body, "title")));
        return;
      }
      case "link_to_page": {
        bt = "linkToPage";
        const kind = jstr(at(body, "type")) ?? "page_id";
        const t = nid(at(body, kind)) ?? nid(at(body, "page_id")) ?? nid(at(body, "database_id"));
        if (t !== undefined) props.linkTarget = t;
        childrenAllowed = false; break;
      }
      case "column_list": bt = "columnList"; break;
      case "column": { bt = "column"; const r = num(at(body, "width_ratio")); if (r !== undefined) props.ratio = r; break; }
      case "table": {
        bt = "table";
        const w = num(at(body, "table_width"));
        props.tableColumns = w !== undefined ? Math.trunc(w) : 2;
        props.tableHeaderRow = at(body, "has_column_header") === true;
        props.tableHeaderColumn = at(body, "has_row_header") === true;
        break;
      }
      case "table_row": bt = "tableRow"; props.cells = jarr(at(body, "cells")).map((x) => this.richText(x)); childrenAllowed = false; break;
      case "synced_block": {
        bt = "syncedBlock";
        const src = nid(at(body, "synced_from", "block_id"));
        if (src && this.blockIDs.has(src)) { props.syncSource = src; childrenAllowed = false; }
        break;
      }
      case "template": bt = "toggle"; text = rich(); if (isEmptyRT(text)) text = "Template"; break;
      case "transcription": case "meeting_notes": bt = "toggle"; text = rich("title"); if (isEmptyRT(text)) text = "Meeting notes"; break;
      default:
        this.unsupported.set(type, (this.unsupported.get(type) ?? 0) + 1);
        bt = "callout";
        props.icon = "⚠️"; props.color = "grayBackground";
        text = `This Notion block (${type.replaceAll("_", " ")}) isn't available through the Notion API.`;
        childrenAllowed = at(j, "has_children") === true;
    }
    this.builder.add(this.block(bt, j, parent, text, props));
    if (childrenAllowed) this.mapChildren(id, "b:" + id);
    else if (bt === "syncedBlock" || bt === "code" || ["image", "video", "audio", "file", "pdf"].includes(bt)) this.builder.markComplete("b:" + id);
  }

  private block(type: string, j: JSONValue, parent: string, text: RichText = "", props: BlockProps = {}, values: Record<string, PropertyValue> = {}): Block {
    const id = nid(at(j, "id")) ?? globalThis.crypto.randomUUID().toLowerCase();
    const created = this.time(at(j, "created_time")) ?? this.builder.now();
    const b: Block = { id, type: type as Block["type"], parent, sk: "", createdAt: created, updatedAt: this.time(at(j, "last_edited_time")) ?? created };
    if (!isEmptyRT(text)) b.text = text;
    if (Object.keys(props).length > 0) b.props = props;
    if (Object.keys(values).length > 0) b.values = values;
    const by = this.user(at(j, "created_by")) ?? this.builder.createdBy ?? undefined;
    if (by !== undefined) b.createdBy = by;
    const ub = this.user(at(j, "last_edited_by")) ?? by;
    if (ub !== undefined) b.updatedBy = ub;
    return b;
  }

  // MARK: Datenbanken

  private mapContainer(dbID: string, parent: string, root: boolean, inline: boolean, fallbackTitle: string | undefined) {
    if (this.mappedContainers.has(dbID)) return;
    this.mappedContainers.add(dbID);
    const db = this.snap.databases.get(dbID);
    if (db === undefined) {
      const now = this.builder.now();
      const b: Block = { id: dbID, type: "page", parent, sk: "", text: fallbackTitle ?? "Database", props: { icon: "🗃️" }, createdAt: now, updatedAt: now };
      if (this.builder.createdBy !== null) { b.createdBy = this.builder.createdBy; b.updatedBy = this.builder.createdBy; }
      this.builder.add(b, root);
      this.builder.warnings.push(`Database “${fallbackTitle ?? dbID}” couldn't be read — share it with the integration (••• → Connections) and import again.`);
      return;
    }
    const title = this.richText(at(db, "title"));
    let sources = jarr(at(db, "data_sources")).flatMap((x) => { const id = nid(at(x, "id")); return id && this.snap.dataSources.has(id) ? [id] : []; });
    if (sources.length === 0) {
      const any = (this.snap.views.get(dbID) ?? []).map((v) => nid(at(v, "data_source_id"))).find((x) => x !== undefined && this.snap.dataSources.has(x));
      if (any) sources = [any];
    }
    const isInline = inline && !root;
    const containers: { id: string; ds: string | undefined }[] = sources.length === 0 ? [{ id: dbID, ds: undefined }] : [];
    sources.forEach((ds, i) => containers.push({ id: i === 0 ? dbID : derivedID(dbID, "source", ds), ds }));
    containers.forEach((c, i) => {
      const p: BlockProps = {};
      if (i === 0) {
        const icon = this.icon(at(db, "icon")); if (icon !== undefined) p.icon = icon;
        const cover = this.cover(at(db, "cover")); if (cover !== undefined) p.cover = cover;
        if (at(db, "is_locked") === true) p.format = { locked: true };
      }
      let text: RichText = "";
      if (c.ds !== undefined) {
        p.databaseID = c.ds;
        if (!this.owner.has(c.ds)) {
          const own = nid(at(this.snap.dataSources.get(c.ds), "parent", "database_id"));
          if (own === dbID || own === undefined || !this.snap.databases.has(own) || i > 0) this.owner.set(c.ds, c.id);
        }
        p.viewIDs = this.mapViews(c.id, dbID, c.ds, i === 0);
      }
      if (!isInline || i > 0) {
        text = i === 0 ? title : c.ds !== undefined ? this.richText(at(this.snap.dataSources.get(c.ds), "title")) : title;
        if (isEmptyRT(text)) text = fallbackTitle ?? "Untitled";
      }
      const b = this.block(isInline ? "databaseInline" : "databasePage", db, parent, text, p);
      b.id = c.id;
      this.builder.add(b, root);
      if (c.ds === undefined) this.builder.warnings.push(`The data source of “${plainRT(title)}” couldn't be read.`);
    });
  }

  private mapOrphanSource(ds: string) {
    const src = this.snap.dataSources.get(ds);
    if (src === undefined) return;
    const id = nid(at(src, "parent", "database_id")) ?? derivedID(ds, "container");
    if (this.mappedContainers.has(id)) { if (!this.owner.has(ds)) this.owner.set(ds, id); return; }
    this.mappedContainers.add(id);
    this.owner.set(ds, id);
    const p: BlockProps = { databaseID: ds };
    const icon = this.icon(at(src, "icon")); if (icon !== undefined) p.icon = icon;
    p.viewIDs = this.mapViews(id, id, ds, true);
    let text = this.richText(at(src, "title")); if (isEmptyRT(text)) text = "Untitled";
    const b = this.block("databasePage", src, "w", text, p);
    b.id = id;
    this.builder.add(b, true);
  }

  private finish() {
    for (const ds of [...this.snap.dataSources.keys()].sort()) {
      const src = this.snap.dataSources.get(ds)!;
      const container = this.owner.get(ds);
      if (container === undefined) continue;
      const dbID = nid(at(src, "parent", "database_id"));
      const dbObj = dbID !== undefined ? this.snap.databases.get(dbID) : undefined;
      const primary = nid(at(jarr(at(dbObj, "data_sources"))[0], "id")) === ds;
      let title = primary ? this.richText(at(dbObj, "title")) : this.richText(at(src, "title"));
      if (isEmptyRT(title)) title = this.richText(at(src, "title"));
      const now = this.builder.now();
      // Wie Swift (Werttyp): Optionen, die erst beim Lesen der Zeilen dazukommen, landen nicht im Schema.
      const db: Database = { id: ds, blockID: container, title, properties: [...(this.schemas.get(ds) ?? [])], createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
      const summary = this.richText(at(dbObj, "description") ?? at(src, "description"));
      if (!isEmptyRT(summary)) db.summary = summary;
      if (at(dbObj, "is_locked") === true) db.locked = true;
      const ct = this.time(at(src, "created_time")); if (ct !== undefined) db.createdAt = ct;
      const ut = this.time(at(src, "last_edited_time")); if (ut !== undefined) db.updatedAt = ut;
      let maxUnique = 0;
      for (const rid of this.snap.rows.get(ds) ?? []) {
        const page = this.snap.pages.get(rid);
        if (page === undefined || this.mappedPages.has(rid)) continue;
        this.mappedPages.add(rid);
        const values: Record<string, PropertyValue> = {};
        for (const [name, v] of Object.entries(jobj(at(page, "properties")) ?? {})) {
          const s = this.prop(ds, jstr(at(v, "id")), name);
          if (!s || s.type === "title") continue;
          const pv = this.value(v, s, ds, rid);
          if (pv !== undefined) {
            values[s.id] = pv;
            if ("uniqueID" in pv) maxUnique = Math.max(maxUnique, (pv as { uniqueID: { _0: number } }).uniqueID._0);
          }
        }
        const props: BlockProps = {};
        const icon = this.icon(at(page, "icon")); if (icon !== undefined) props.icon = icon;
        const cover = this.cover(at(page, "cover")); if (cover !== undefined) props.cover = cover;
        if (at(page, "is_locked") === true) props.format = { locked: true };
        this.builder.add(this.block("page", page, "d:" + ds, this.titleText(page), props, values));
        this.mapChildren(rid, "b:" + rid);
      }
      if (maxUnique > 0) db.nextUniqueID = maxUnique + 1;
      this.builder.addDatabase(db);
      if (this.snap.rows.has(ds)) this.builder.markComplete("d:" + ds);
    }
    const skipped = [...this.unsupported.values()].reduce((a, b) => a + b, 0);
    if (skipped > 0) {
      const kinds = [...this.unsupported.keys()].sort().join(", ");
      this.builder.warnings.push(`${skipped} block(s) aren't available through the Notion API (${kinds}) and were replaced by a note.`);
    }
    if (this.approximations > 0) this.builder.notes.push(`${this.approximations} view filter(s) were approximated.`);
    this.builder.warnings.push(...this.snap.warnings);
  }

  // MARK: Schema

  private buildSchema(ds: string) {
    const src = this.snap.dataSources.get(ds);
    if (src === undefined) return;
    const props = jobj(at(src, "properties")) ?? {};
    const viewOrder = ((): string[] => {
      for (const key of [...this.snap.views.keys()].sort()) {
        for (const v of this.snap.views.get(key)!) {
          if (nid(at(v, "data_source_id")) !== ds) continue;
          const ids = jarr(at(v, "configuration", "properties")).flatMap((p) => { const x = jstr(at(p, "property_id")); return x !== undefined ? [x] : []; });
          if (ids.length > 0) return ids;
        }
      }
      return [];
    })();
    const rank = (name: string, p: JSONValue): [number, string] => {
      if (at(p, "type") === "title") return [-1, name];
      const pid = jstr(at(p, "id")) ?? "";
      const i = viewOrder.findIndex((x) => sameID(x, pid) || x === name);
      return i >= 0 ? [i, name] : [Number.MAX_SAFE_INTEGER, name.toLowerCase()];
    };
    const cmp = (a: [number, string], b: [number, string]) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    const ordered = Object.entries(props).sort((a, b) => cmp(rank(a[0], a[1]), rank(b[0], b[1])));
    const schema: PropertySchema[] = [];
    const index = new Map<string, PropertySchema>();
    const addDescription = (s: PropertySchema, d: string) => { s.description = s.description !== undefined ? `${s.description} ${d}` : d; };
    for (const [name, p] of ordered) {
      const ntype = jstr(at(p, "type")) ?? "rich_text";
      const pnid = jstr(at(p, "id")) ?? name;
      const s: PropertySchema = { id: ntype === "title" ? TITLE_ID : notionPropertyID(ds, pnid), name, type: "text" };
      const cfg = at(p, ntype);
      const d = jstr(at(p, "description")); if (d) s.description = d;
      switch (ntype) {
        case "title": s.type = "title"; break;
        case "rich_text": s.type = "text"; break;
        case "number": { s.type = "number"; const f = numberFormat(jstr(at(cfg, "format"))); if (f !== undefined) s.numberFormat = f; break; }
        case "select": case "multi_select": case "status":
          s.type = ntype === "select" ? "select" : ntype === "status" ? "status" : "multiSelect";
          s.options = jarr(at(cfg, "options")).map((o) => ({
            id: jstr(at(o, "id")) ?? derivedID(ds, pnid, jstr(at(o, "name")) ?? ""), name: jstr(at(o, "name")) ?? "", color: tcolor(jstr(at(o, "color")), "default"),
          }));
          if (ntype === "status") {
            s.statusGroups = jarr(at(cfg, "groups")).map((g) => ({
              id: jstr(at(g, "id")) ?? globalThis.crypto.randomUUID().toLowerCase(), name: jstr(at(g, "name")) ?? "", color: tcolor(jstr(at(g, "color")), "gray"),
              optionIDs: jarr(at(g, "option_ids")).flatMap((x) => (typeof x === "string" ? [x] : [])),
            }));
          }
          break;
        case "date": s.type = "date"; break;
        case "people": s.type = "person"; break;
        case "files": s.type = "files"; break;
        case "checkbox": s.type = "checkbox"; break;
        case "url": s.type = "url"; break;
        case "email": s.type = "email"; break;
        case "phone_number": s.type = "phone"; break;
        case "created_time": s.type = "createdTime"; break;
        case "created_by": s.type = "createdBy"; break;
        case "last_edited_time": s.type = "lastEditedTime"; break;
        case "last_edited_by": s.type = "lastEditedBy"; break;
        case "unique_id": { s.type = "uniqueID"; const pre = jstr(at(cfg, "prefix")); if (pre) s.idPrefix = pre; break; }
        case "button": s.type = "button"; break;
        case "verification": s.type = "verification"; break;
        case "place": case "location": s.type = "place"; break;
        case "relation": {
          const target = nid(at(cfg, "data_source_id"));
          if (target && this.snap.dataSources.has(target)) {
            s.type = "relation";
            const synced = jstr(at(cfg, "dual_property", "synced_property_id"));
            s.relation = synced !== undefined ? { databaseID: target, syncedPropertyID: notionPropertyID(target, synced) } : { databaseID: target };
          } else {
            s.type = "text";
            addDescription(s, "Relation in Notion (the related database wasn't imported).");
          }
          break;
        }
        case "formula": case "rollup": s.type = "text"; break;
        default: s.type = "text"; addDescription(s, `Notion property type “${ntype}”.`);
      }
      schema.push(s);
      index.set(pnid, s); index.set(pct(pnid), s); index.set("name:" + name, s);
    }
    this.schemas.set(ds, schema);
    this.propIndex.set(ds, index);
    // Formeln und Rollups
    const names = new Map<string, string>();
    for (const [key, p] of Object.entries(props)) {
      const k = removingPercentEncoding(jstr(at(p, "id")) ?? key) ?? key;
      if (!names.has(k)) names.set(k, key);
    }
    for (const [name, p] of ordered) {
      const ntype = jstr(at(p, "type"));
      const pnid = jstr(at(p, "id"));
      if ((ntype !== "formula" && ntype !== "rollup") || pnid === undefined) continue;
      const old = index.get(pnid);
      if (!old) continue;
      const s: PropertySchema = { ...old };
      if (ntype === "formula") {
        const expr = jstr(at(p, "formula", "expression")) ?? "";
        const f = convertNotionFormula(expr, names);
        if (f !== undefined) { s.type = "formula"; s.formula = f; this.liveFormula.add(ds + "|" + s.id); }
        else {
          s.type = this.staticType(ds, pnid, "formula");
          addDescription(s, `Formula in Notion: ${readableNotionFormula(expr, names)} — imported as values.`);
        }
      } else {
        const cfg = at(p, "rollup");
        const relID = jstr(at(cfg, "relation_property_id"));
        const relName = jstr(at(cfg, "relation_property_name"));
        const rel = (relID !== undefined ? index.get(relID) ?? index.get(pct(relID)) : undefined) ?? (relName !== undefined ? index.get("name:" + relName) : undefined);
        let target: PropertySchema | undefined;
        const tds = rel?.type === "relation" ? rel.relation?.databaseID : undefined;
        const tsrc = tds !== undefined ? this.snap.dataSources.get(tds) : undefined;
        if (tds !== undefined && tsrc !== undefined) {
          const tid = jstr(at(cfg, "rollup_property_id")), tname = jstr(at(cfg, "rollup_property_name"));
          for (const [tn, tp] of Object.entries(jobj(at(tsrc, "properties")) ?? {})) {
            if ((tid !== undefined && sameID(jstr(at(tp, "id")) ?? "", tid)) || tn === tname) {
              const ttype = jstr(at(tp, "type")) ?? "";
              target = { id: ttype === "title" ? TITLE_ID : notionPropertyID(tds, jstr(at(tp, "id")) ?? tn), name: tn, type: "text" };
            }
          }
        }
        const fn = rollupFunction(jstr(at(cfg, "function")));
        if (rel && target && fn !== undefined) {
          s.type = "rollup";
          s.rollup = { relationPropertyID: rel.id, targetPropertyID: target.id, function: fn };
        } else {
          s.type = this.staticType(ds, pnid, "rollup");
          addDescription(s, `Rollup in Notion (${jstr(at(cfg, "function")) ?? ""}) — imported as values.`);
        }
      }
      const i = schema.findIndex((x) => x.id === s.id);
      if (i >= 0) schema[i] = s;
      index.set(pnid, s); index.set(pct(pnid), s); index.set("name:" + name, s);
    }
    this.schemas.set(ds, schema);
    this.propIndex.set(ds, index);
  }

  private staticType(ds: string, pnid: string, kind: string): string {
    for (const rid of this.snap.rows.get(ds) ?? []) {
      const page = this.snap.pages.get(rid);
      if (page === undefined) continue;
      for (const v of Object.values(jobj(at(page, "properties")) ?? {})) {
        if (!sameID(jstr(at(v, "id")) ?? "", pnid)) continue;
        const r = at(v, kind);
        switch (jstr(at(r, "type"))) {
          case "number": if (num(at(r, "number")) !== undefined) return "number"; break;
          case "boolean": return "checkbox";
          case "date": { const d = at(r, "date"); if (d !== undefined && d !== null) return "date"; break; }
        }
      }
    }
    return "text";
  }

  private prop(ds: string, pnid: string | undefined, name: string): PropertySchema | undefined {
    const idx = this.propIndex.get(ds);
    if (!idx) return undefined;
    if (pnid !== undefined) { const s = idx.get(pnid) ?? idx.get(pct(pnid)); if (s) return s; }
    return idx.get("name:" + name);
  }

  private propRef(ds: string, ref: string | undefined): PropertySchema | undefined {
    if (ref === undefined) return undefined;
    if (ref === "title") return this.schemas.get(ds)?.find((s) => s.type === "title");
    const idx = this.propIndex.get(ds);
    return idx?.get(ref) ?? idx?.get(pct(ref)) ?? idx?.get("name:" + ref);
  }

  // MARK: Werte

  private value(v: JSONValue, s: PropertySchema, ds: string, page: string): PropertyValue | undefined {
    const ntype = jstr(at(v, "type")) ?? "";
    const body = at(v, ntype);
    const pid = jstr(at(v, "id")) ?? "";
    const items = (): JSONValue[] => {
      const m = this.snap.propertyItems.get(page);
      const full = m?.get(pid) ?? m?.get(pct(pid));
      if (full) return full.map((x) => at(x, ntype) ?? x);
      return jarr(body);
    };
    const c = <K extends string>(k: K, v: unknown) => ({ [k]: { _0: v } }) as unknown as PropertyValue;
    switch (ntype) {
      case "rich_text": { const rt = this.richText(body); return isEmptyRT(rt) ? undefined : c("text", rt); }
      case "number": return typeof body === "number" ? c("number", body) : undefined;
      case "select": return body === undefined || body === null ? undefined : c("select", this.optionID(body, ds, s.id));
      case "status": return body === undefined || body === null ? undefined : c("status", this.optionID(body, ds, s.id));
      case "multi_select": { const ids = jarr(body).map((o) => this.optionID(o, ds, s.id)); return ids.length === 0 ? undefined : c("multiSelect", ids); }
      case "date": { const d = this.dateValue(body); return d ? c("date", d) : undefined; }
      case "people": { const names = items().flatMap((x) => { const n = this.user(x); return n !== undefined ? [n] : []; }); return names.length === 0 ? undefined : c("person", names); }
      case "files": {
        const files = jarr(body).map((f) => {
          const m = this.media(f);
          const lastPath = m.url !== undefined ? (() => { try { return decodeURIComponent(new URL(m.url).pathname.split("/").pop() ?? ""); } catch { return undefined; } })() : undefined;
          const fv: { name: string; asset?: AssetRef; url?: string } = { name: jstr(at(f, "name")) ?? lastPath ?? "File" };
          if (m.asset) fv.asset = m.asset;
          if (m.url !== undefined) fv.url = m.url;
          return fv;
        });
        return files.length === 0 ? undefined : c("files", files);
      }
      case "checkbox": return c("checkbox", body === true);
      case "url": return typeof body === "string" && body !== "" ? c("url", body) : undefined;
      case "email": return typeof body === "string" && body !== "" ? c("email", body) : undefined;
      case "phone_number": return typeof body === "string" && body !== "" ? c("phone", body) : undefined;
      case "unique_id": { const n = num(at(body, "number")); return n !== undefined ? c("uniqueID", Math.trunc(n)) : undefined; }
      case "relation": {
        const ids = items().flatMap((x) => { const id = nid(at(x, "id")); return id ? [id] : []; });
        if (ids.length === 0) return undefined;
        return s.type === "relation" ? c("relation", ids) : c("text", this.pageLinks(ids));
      }
      case "formula": return this.liveFormula.has(ds + "|" + s.id) ? undefined : this.computed(body, s);
      case "rollup": return s.type === "rollup" ? undefined : this.computed(body, s);
      case "place": case "location": {
        if (body === undefined || body === null) return undefined;
        const pv = { name: jstr(at(body, "name")), address: jstr(at(body, "address")), lat: num(at(body, "lat")), lon: num(at(body, "lon")), google_place_id: jstr(at(body, "google_place_id")) };
        if (pv.name === undefined && pv.address === undefined && pv.lat === undefined && pv.lon === undefined) return undefined;
        const raw = pv.lat === undefined && pv.lon === undefined && pv.address === undefined && pv.google_place_id === undefined ? pv.name ?? "" : canonicalStringify(pv).replaceAll("/", "\\/");
        return c("place", raw);
      }
      default: return undefined;
    }
  }

  private computed(r: JSONValue | undefined, s: PropertySchema): PropertyValue | undefined {
    if (r === undefined) return undefined;
    const c = <K extends string>(k: K, v: unknown) => ({ [k]: { _0: v } }) as unknown as PropertyValue;
    switch (jstr(at(r, "type")) ?? "") {
      case "string": { const t = jstr(at(r, "string")); return t ? c("text", t) : undefined; }
      case "number": {
        const n = num(at(r, "number"));
        if (n === undefined) return undefined;
        return s.type === "number" ? c("number", n) : c("text", plainNumber(n));
      }
      case "boolean": { const b = at(r, "boolean") === true; return s.type === "checkbox" ? c("checkbox", b) : c("text", b ? "true" : "false"); }
      case "date": {
        const d = this.dateValue(at(r, "date"));
        if (!d) return undefined;
        return s.type === "date" ? c("date", d) : c("text", formatDateValue(d));
      }
      case "array": {
        const parts = jarr(at(r, "array")).flatMap((x) => { const t = this.displayText(x); return t ? [t] : []; });
        return parts.length === 0 ? undefined : c("text", parts.join(", "));
      }
      default: return undefined;
    }
  }

  private displayText(v: JSONValue): string | undefined {
    const t = jstr(at(v, "type")) ?? "";
    const body = at(v, t);
    switch (t) {
      case "title": case "rich_text": return plainRT(this.richText(body));
      case "number": return typeof body === "number" ? plainNumber(body) : undefined;
      case "select": case "status": return jstr(at(body, "name"));
      case "multi_select": return jarr(body).flatMap((x) => { const n = jstr(at(x, "name")); return n !== undefined ? [n] : []; }).join(", ");
      case "date": { const d = this.dateValue(body); return d ? formatDateValue(d) : undefined; }
      case "people": return jarr(body).flatMap((x) => { const n = this.user(x); return n !== undefined ? [n] : []; }).join(", ");
      case "checkbox": return body === true ? "✓" : "✗";
      case "url": case "email": case "phone_number": return jstr(body);
      case "relation": return jarr(body).flatMap((x) => { const id = nid(at(x, "id")); return id ? [this.pageTitle(id)] : []; }).join(", ");
      case "formula": {
        const pv = this.computed(body, { id: "", name: "", type: "text" });
        return pv && "text" in pv ? plainRT((pv as { text: { _0: RichText } }).text._0) : undefined;
      }
      case "unique_id": { const n = num(at(body, "number")); return n !== undefined ? (jstr(at(body, "prefix")) !== undefined ? jstr(at(body, "prefix")) + "-" : "") + String(Math.trunc(n)) : undefined; }
      default:
        if (typeof body === "string") return body;
        if (typeof body === "number") return body === Math.round(body) ? String(Math.trunc(body)) : String(body);
        if (typeof body === "boolean") return body ? "true" : "false";
        return undefined;
    }
  }

  private optionID(o: JSONValue, ds: string, prop: string): string {
    const name = jstr(at(o, "name")) ?? "";
    const schema = this.schemas.get(ds);
    const i = schema?.findIndex((x) => x.id === prop) ?? -1;
    if (!schema || i < 0) return jstr(at(o, "id")) ?? name;
    const opts = schema[i]!.options ?? [];
    const id = jstr(at(o, "id"));
    if (id !== undefined && opts.some((x) => x.id === id)) return id;
    const hit = opts.find((x) => x.name === name);
    if (hit) return hit.id;
    const created = { id: id ?? derivedID(ds, prop, name), name, color: tcolor(jstr(at(o, "color")), "default") };
    schema[i] = { ...schema[i]!, options: [...opts, created] };
    return created.id;
  }

  private pageTitle(id: string): string {
    const p = this.snap.pages.get(id);
    const t = p !== undefined ? notionTitle(p) : "";
    return t === "" ? "Untitled" : t;
  }

  private pageLinks(ids: string[]): RichText {
    const runs: Run[] = [];
    ids.forEach((id, i) => {
      if (i > 0) runs.push({ t: ", ", m: {} });
      if (this.importedIDs.has(id)) runs.push({ t: this.pageTitle(id), m: {}, mention: { page: { _0: id } } });
      else runs.push({ t: this.pageTitle(id), m: { link: "https://www.notion.so/" + id.replaceAll("-", "") } });
    });
    return toRichText(normalize(runs));
  }

  // MARK: Ansichten

  private mapViews(container: string, dbID: string, ds: string, primary: boolean): string[] {
    const widgets = this.widgetViewIDs();
    const vs = (this.snap.views.get(dbID) ?? []).filter((v) => {
      const vds = nid(at(v, "data_source_id"));
      return vds === ds || (vds === undefined && primary);
    }).filter((v) => { const id = nid(at(v, "id")); return id !== undefined && !widgets.has(id); });
    const ids: string[] = [];
    let key: string | undefined;
    for (const v of vs) {
      const vid = nid(at(v, "id"));
      if (!vid) continue;
      key = keyBetween(key, undefined);
      if (at(v, "type") === "dashboard") {
        const dash = this.mapDashboard(v, vid, container, ds, key);
        if (dash) { this.builder.addView(dash); ids.push(dash.id); }
        continue;
      }
      const view = this.mapView(v, vid, container, ds, key);
      if (view) { this.builder.addView(view); ids.push(view.id); }
    }
    if (ids.length === 0) {
      const vid = derivedID(container, "view");
      const now = this.builder.now();
      const v: DatabaseView = { id: vid, databaseID: ds, blockID: container, name: "Table", type: "table", sortKey: FIRST_KEY,
        properties: (this.schemas.get(ds) ?? []).map((s) => ({ id: s.id, visible: true })), createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
      this.builder.addView(v);
      return [vid];
    }
    return ids;
  }

  private widgetViewIDs(): Set<string> {
    if (this.widgetCache) return this.widgetCache;
    const out = new Set<string>();
    for (const list of this.snap.views.values()) {
      for (const v of list) {
        const id = nid(at(v, "id"));
        if (nid(at(v, "dashboard_view_id")) !== undefined && id) out.add(id);
        for (const row of jarr(at(v, "configuration", "rows"))) for (const w of jarr(at(row, "widgets"))) { const x = nid(at(w, "view_id")); if (x) out.add(x); }
      }
    }
    this.widgetCache = out;
    return out;
  }

  private notionView(id: string): JSONValue | undefined {
    for (const list of this.snap.views.values()) { const v = list.find((x) => nid(at(x, "id")) === id); if (v !== undefined) return v; }
    return undefined;
  }

  private mapDashboard(v: JSONValue, id: string, container: string, ds: string, sortKey: string): DatabaseView | undefined {
    let name = jstr(at(v, "name")) ?? "";
    if (name === "") name = "Dashboard";
    const now = this.builder.now();
    const dash: DatabaseView = { id, databaseID: ds, blockID: container, name, type: "dashboard", sortKey, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    const ct = this.time(at(v, "created_time")); if (ct !== undefined) dash.createdAt = ct;
    dash.updatedAt = this.time(at(v, "last_edited_time")) ?? dash.createdAt;
    const rows: NonNullable<DatabaseView["dashboard"]>["rows"] = [];
    jarr(at(v, "configuration", "rows")).forEach((row, ri) => {
      const widgets: { id: string; viewID: string; width: number }[] = [];
      jarr(at(row, "widgets")).forEach((w, wi) => {
        const wid = nid(at(w, "view_id"));
        if (!wid) return;
        const wjson = this.notionView(wid);
        if (wjson === undefined) { this.builder.notes.push(`Dashboard “${name}”: a widget view wasn't returned by the API and was skipped.`); return; }
        const wds = nid(at(wjson, "data_source_id")) ?? ds;
        if (!this.schemas.has(wds)) {
          this.builder.notes.push(`Dashboard “${name}”: widget “${jstr(at(wjson, "name")) ?? wid}” shows a database that isn't shared with the integration — skipped.`);
          return;
        }
        const wv = this.mapView(wjson, wid, container, wds, FIRST_KEY);
        if (!wv) return;
        wv.widgetOf = id;
        this.builder.addView(wv);
        const width = num(at(w, "width")) !== undefined ? Math.trunc(num(at(w, "width"))!) : 0;
        widgets.push({ id: jstr(at(w, "id")) ?? derivedID(id, `w${ri}-${wi}`), viewID: wv.id, width: width > 0 ? Math.min(width, DASHBOARD_COLUMNS) : 0 });
      });
      if (widgets.length === 0) return;
      if (widgets.some((x) => x.width === 0) || widgets.reduce((a, x) => a + x.width, 0) > DASHBOARD_COLUMNS) {
        const even = evenWidths(widgets.length);
        widgets.forEach((x, i) => { x.width = even[i]!; });
      }
      const r: { id: string; widgets: typeof widgets; height?: number } = { id: jstr(at(row, "id")) ?? derivedID(id, `row${ri}`), widgets };
      const h = num(at(row, "height")); if (h !== undefined) r.height = h;
      rows.push(r);
    });
    dash.dashboard = { rows };
    return dash;
  }

  private mapView(v: JSONValue, id: string, container: string, ds: string, sortKey: string): DatabaseView | undefined {
    const ntype = jstr(at(v, "type")) ?? "table";
    const cfg = at(v, "configuration");
    let type = VIEW_TYPES.includes(ntype) ? ntype : "table";
    if (!AVAILABLE_VIEWS.includes(type) || type === "dashboard") {
      this.builder.notes.push(`“${jstr(at(v, "name")) ?? ntype}” is a ${ntype} view in Notion — imported as a table.`);
      type = "table";
    }
    let name = jstr(at(v, "name")) ?? "";
    if (name === "") name = cap(type);
    const now = this.builder.now();
    const view: DatabaseView = { id, databaseID: ds, blockID: container, name, type, sortKey, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    const ct = this.time(at(v, "created_time")); if (ct !== undefined) view.createdAt = ct;
    view.updatedAt = this.time(at(v, "last_edited_time")) ?? view.createdAt;
    // Eigenschaften
    const vp: ViewProperty[] = [];
    for (const p of jarr(at(cfg, "properties"))) {
      const s = this.propRef(ds, jstr(at(p, "property_id")));
      if (!s || vp.some((x) => x.id === s.id)) continue;
      const vis = at(p, "visible");
      const e: ViewProperty = { id: s.id, visible: typeof vis === "boolean" ? vis : true };
      const w = num(at(p, "width")); if (w !== undefined) e.width = w;
      vp.push(e);
    }
    if (vp.length > 0) {
      if (type !== "table") for (const s of this.schemas.get(ds) ?? []) if (!vp.some((x) => x.id === s.id) && s.type !== "title") vp.push({ id: s.id, visible: false });
      view.properties = vp;
    }
    // Gruppierung
    const g = at(cfg, "group_by");
    if (g !== undefined && g !== null) {
      const s = this.propRef(ds, jstr(at(g, "property_id")));
      if (s) {
        const rule: NonNullable<DatabaseView["groupBy"]> = { propertyID: s.id };
        if (at(g, "hide_empty_groups") === true) rule.hideEmptyGroups = true;
        const gb = jstr(at(g, "group_by"));
        if (gb === "relative" || gb === "day" || gb === "week" || gb === "month" || gb === "year") rule.dateGrouping = gb;
        if (["board", "table", "list", "gallery"].includes(type)) view.groupBy = rule;
      }
    }
    // Daten
    const dp = this.propRef(ds, jstr(at(cfg, "date_property_id"))); if (dp) view.datePropertyID = dp.id;
    const ep = this.propRef(ds, jstr(at(cfg, "end_date_property_id"))); if (ep) view.endDatePropertyID = ep.id;
    if ((type === "calendar" || type === "timeline") && view.datePropertyID === undefined) {
      const d = this.schemas.get(ds)?.find((x) => x.type === "date"); if (d) view.datePropertyID = d.id;
    }
    // Karten
    const cover = at(cfg, "cover");
    if (cover !== undefined && cover !== null) {
      switch (jstr(at(cover, "type"))) {
        case "page_cover": view.cardCover = { pageCover: {} }; break;
        case "page_content": view.cardCover = { pageContent: {} }; break;
        case "property": { const s = this.propRef(ds, jstr(at(cover, "property_id"))); view.cardCover = s ? { property: { _0: s.id } } : { none: {} }; break; }
      }
    } else if ((type === "gallery" || type === "board") && cover === null) view.cardCover = { none: {} };
    const size = jstr(at(cfg, "cover_size"));
    if (size === "small" || size === "medium" || size === "large") view.cardSize = size;
    const wrap = at(cfg, "wrap_cells"); if (typeof wrap === "boolean") view.wrapCells = wrap;
    if (type === "chart") view.chart = this.chart(cfg, ds);
    if (type === "map") {
      const m = this.propRef(ds, jstr(at(cfg, "map_by")))?.id ?? this.schemas.get(ds)?.find((x) => x.type === "place")?.id;
      if (m !== undefined) view.mapPropertyID = m;
      const h = jstr(at(cfg, "height")); if (h !== undefined) view.mapHeight = h;
    }
    // Filter und Sortierung
    const f = at(v, "filter");
    if (f !== undefined && f !== null) {
      const grp = this.filterGroup(f, ds, view);
      if (grp && grp.items.length > 0) view.filter = grp;
    }
    const sorts: { propertyID: string; ascending: boolean }[] = [];
    for (const s of jarr(at(v, "sorts"))) {
      const asc = (jstr(at(s, "direction")) ?? "ascending") === "ascending";
      const ts = jstr(at(s, "timestamp"));
      const tp = ts !== undefined ? this.timestampProperty(ts, ds, view) : undefined;
      if (tp !== undefined) sorts.push({ propertyID: tp, ascending: asc });
      else { const p = this.propRef(ds, jstr(at(s, "property"))); if (p) sorts.push({ propertyID: p.id, ascending: asc }); }
    }
    if (sorts.length > 0) view.sorts = sorts;
    return view;
  }

  private chart(cfg: JSONValue | undefined, ds: string): ChartConfig {
    const c: ChartConfig = { kind: "bar", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false };
    switch (jstr(at(cfg, "chart_type"))) {
      case "bar": c.kind = "horizontalBar"; break;
      case "line": c.kind = at(cfg, "hide_line_fill_area") === false ? "area" : "line"; break;
      case "donut": c.kind = "donut"; break;
      case "number": c.kind = "number"; break;
      default: c.kind = "bar";
    }
    const theme = jstr(at(cfg, "color_theme")); if (theme !== undefined) c.colorTheme = theme;
    const h = jstr(at(cfg, "height")); if (h !== undefined) c.height = h;
    const capt = jstr(at(cfg, "caption")); if (capt) c.caption = capt;
    const x = at(cfg, "x_axis");
    if (x !== undefined && x !== null) {
      const xp = this.propRef(ds, jstr(at(x, "property_id")))?.id; if (xp !== undefined) c.xPropertyID = xp;
      const gb = jstr(at(x, "group_by"));
      if (gb === "day" || gb === "week" || gb === "year") c.dateBucket = gb;
    } else {
      const xp = this.propRef(ds, jstr(at(cfg, "x_axis_property_id"))); if (xp) c.xPropertyID = xp.id;
    }
    const agg = at(cfg, "y_axis") ?? at(cfg, "value");
    if (agg !== undefined && agg !== null) {
      const yp = this.propRef(ds, jstr(at(agg, "property_id")))?.id;
      if (yp !== undefined) c.yPropertyID = yp;
      const a = jstr(at(agg, "aggregator")) ?? "count";
      c.aggregate = ["average", "count", "max", "median", "min", "sum"].includes(a) ? a : "count";
      if (yp === undefined) c.aggregate = "count";
    }
    const l = at(cfg, "show_data_labels"); if (typeof l === "boolean") c.showValues = l;
    if (at(cfg, "legend_position") === "off") c.showLegend = false;
    const s = jstr(at(cfg, "sort")); if (s !== undefined) c.sortByValue = s.startsWith("y_");
    return c;
  }

  private timestampProperty(ts: string, ds: string, view: DatabaseView): string | undefined {
    const type = ts === "created_time" ? "createdTime" : "lastEditedTime";
    const hit = this.schemas.get(ds)?.find((x) => x.type === type);
    if (hit) return hit.id;
    const s: PropertySchema = { id: derivedID(ds, "prop", ts), name: type === "createdTime" ? "Created time" : "Last edited time", type };
    this.schemas.set(ds, [...(this.schemas.get(ds) ?? []), s]);
    view.properties = [...(view.properties ?? []), { id: s.id, visible: false }];
    return s.id;
  }

  private filterGroup(f: JSONValue, ds: string, view: DatabaseView): FilterGroup | undefined {
    const and = at(f, "and"), or = at(f, "or");
    const items = Array.isArray(and) ? and : Array.isArray(or) ? or : undefined;
    if (items) {
      const comb = and !== undefined ? "and" : "or";
      const out: FilterItem[] = [];
      for (const i of items) {
        if (at(i, "and") !== undefined || at(i, "or") !== undefined) {
          const g = this.filterGroup(i, ds, view);
          if (g && g.items.length > 0) out.push({ group: { _0: g } });
        } else {
          const c = this.condition(i, ds, view);
          if (c) out.push({ condition: { _0: c } });
        }
      }
      return { combinator: comb, items: out };
    }
    const c = this.condition(f, ds, view);
    return c ? { combinator: "and", items: [{ condition: { _0: c } }] } : undefined;
  }

  private condition(f: JSONValue, ds: string, view: DatabaseView): FilterCondition | undefined {
    let pid: string;
    let schema: PropertySchema | undefined;
    const ts = jstr(at(f, "timestamp"));
    if (ts !== undefined) {
      const p = this.timestampProperty(ts, ds, view);
      if (p === undefined) return undefined;
      pid = p; schema = this.schemas.get(ds)?.find((x) => x.id === p);
    } else {
      const s = this.propRef(ds, jstr(at(f, "property")));
      if (!s) { this.approximations++; return undefined; }
      pid = s.id; schema = s;
    }
    const typeKey = Object.keys(jobj(f) ?? {}).find((k) => !["property", "timestamp", "type"].includes(k));
    if (typeKey === undefined) return undefined;
    let body = at(f, typeKey);
    if (typeKey === "formula" || typeKey === "rollup") {
      const inner = Object.entries(jobj(body) ?? {})[0];
      if (inner) {
        if (["any", "every", "none"].includes(inner[0])) this.approximations++;
        body = inner[1];
        const deeper = Object.entries(jobj(body) ?? {})[0];
        if (deeper && jobj(deeper[1]) !== undefined && ["rich_text", "select", "multi_select", "number", "date", "checkbox", "status", "people"].includes(deeper[0])) body = deeper[1];
      }
    }
    const first = Object.entries(jobj(body) ?? {})[0];
    if (!first) return undefined;
    const [opKey, raw] = first;
    let op: string;
    let value: FilterValue | undefined;
    const rel = (r: string): FilterValue => ({ relative: { _0: r } }) as FilterValue;
    switch (opKey) {
      case "equals": op = "equals"; break;
      case "does_not_equal": op = "notEquals"; break;
      case "contains": op = "contains"; break;
      case "does_not_contain": op = "notContains"; break;
      case "starts_with": op = "startsWith"; break;
      case "ends_with": op = "endsWith"; break;
      case "is_empty": op = "isEmpty"; break;
      case "is_not_empty": op = "isNotEmpty"; break;
      case "greater_than": op = "greater"; break;
      case "less_than": op = "less"; break;
      case "greater_than_or_equal_to": op = "greaterOrEqual"; break;
      case "less_than_or_equal_to": op = "lessOrEqual"; break;
      case "before": op = "before"; break;
      case "after": op = "after"; break;
      case "on_or_before": op = "onOrBefore"; break;
      case "on_or_after": op = "onOrAfter"; break;
      case "past_week": op = "within"; value = rel("pastWeek"); break;
      case "past_month": op = "within"; value = rel("pastMonth"); break;
      case "past_year": op = "within"; value = rel("pastYear"); break;
      case "next_week": op = "within"; value = rel("nextWeek"); break;
      case "next_month": op = "within"; value = rel("nextMonth"); break;
      case "next_year": op = "within"; value = rel("nextYear"); break;
      case "this_week": op = "within"; value = rel("pastWeek"); this.approximations++; break;
      case "this_month": op = "within"; value = rel("pastMonth"); this.approximations++; break;
      default: this.approximations++; return undefined;
    }
    if (op !== "isEmpty" && op !== "isNotEmpty" && value === undefined) {
      value = this.filterValue(raw, schema);
      if (value === undefined) return undefined;
    }
    const c: FilterCondition = { id: derivedID(view.id, "filter", pid, opKey, swiftJSONText(raw)), propertyID: pid, op };
    if (value !== undefined) c.value = value;
    return c;
  }

  private filterValue(raw: JSONValue, schema: PropertySchema | undefined): FilterValue | undefined {
    const fv = (k: string, v: unknown) => ({ [k]: { _0: v } }) as FilterValue;
    if (typeof raw === "boolean") return fv("bool", raw);
    if (typeof raw === "number") return fv("number", raw);
    if (typeof raw !== "string") return undefined;
    const s = raw;
    if (!schema) return fv("text", s);
    const nowSec = (Date.now() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000;
    switch (schema.type) {
      case "select": case "status": case "multiSelect":
        return fv("options", [schema.options?.find((o) => o.name === s || o.id === s)?.id ?? s]);
      case "person": case "createdBy": case "lastEditedBy":
        if (s === "me") return undefined;
        return fv("options", [this.snap.users.get(notionUUID(s) ?? s) ?? s]);
      case "relation": return fv("options", [notionUUID(s) ?? s]);
      case "date": case "createdTime": case "lastEditedTime":
        switch (s) {
          case "today": return fv("relative", "today");
          case "tomorrow": return fv("relative", "tomorrow");
          case "yesterday": return fv("relative", "yesterday");
          case "one_week_ago": this.approximations++; return fv("date", nowSec - 7 * 86400);
          case "one_week_from_now": this.approximations++; return fv("date", nowSec + 7 * 86400);
          case "one_month_ago": { this.approximations++; const d = new Date(); d.setMonth(d.getMonth() - 1); return fv("date", (d.getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000); }
          case "one_month_from_now": { this.approximations++; const d = new Date(); d.setMonth(d.getMonth() + 1); return fv("date", (d.getTime() - SWIFT_REFERENCE_DATE_UNIX_MS) / 1000); }
          default: { const p = this.parseDate(s); return p ? fv("date", p.date) : undefined; }
        }
      case "number": case "uniqueID": { const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) && s.trim() === s ? Number(s) : NaN; return Number.isFinite(n) ? fv("number", n) : fv("text", s); }
      case "checkbox": return fv("bool", s === "true");
      default: return fv("text", s);
    }
  }

  // MARK: Text

  richText(arr: JSONValue | undefined): RichText {
    const runs: Run[] = [];
    for (const r of jarr(arr)) {
      const a = at(r, "annotations");
      const m: Marks = {};
      if (at(a, "bold") === true) m.b = true;
      if (at(a, "italic") === true) m.i = true;
      if (at(a, "strikethrough") === true) m.s = true;
      if (at(a, "underline") === true) m.u = true;
      if (at(a, "code") === true) m.c = true;
      const color = notionColor(jstr(at(a, "color"))); if (color !== undefined) m.color = color as Marks["color"];
      const plain = jstr(at(r, "plain_text")) ?? "";
      switch (jstr(at(r, "type"))) {
        case "equation": { const ex = jstr(at(r, "equation", "expression")) ?? plain; runs.push({ t: ex, m, eq: ex }); break; }
        case "mention": {
          const men = at(r, "mention");
          const kind = jstr(at(men, "type")) ?? "";
          switch (kind) {
            case "page": case "database": {
              const id = nid(at(men, kind, "id"));
              if (id && this.importedIDs.has(id)) runs.push({ t: plain === "" ? this.pageTitle(id) : plain, m, mention: { page: { _0: id } } });
              else {
                const href = jstr(at(r, "href")) ?? (id ? "https://www.notion.so/" + id.replaceAll("-", "") : undefined);
                if (href !== undefined) m.link = href;
                runs.push({ t: plain === "" ? "Untitled" : plain, m });
              }
              break;
            }
            case "user": {
              const name = this.user(at(men, "user")) ?? plain.replaceAll("@", "");
              runs.push({ t: plain === "" ? "@" + name : plain, m, mention: { user: { _0: name } } });
              break;
            }
            case "date": {
              const d = this.dateValue(at(men, "date"));
              runs.push(d ? { t: plain, m, mention: { date: { _0: d } } } : { t: plain, m });
              break;
            }
            case "link_preview": case "link_mention": {
              const url = jstr(at(men, kind, "url")) ?? jstr(at(men, kind, "href")) ?? jstr(at(r, "href")) ?? plain;
              runs.push({ t: plain === "" ? url : plain, m, mention: { link: { _0: url } } });
              break;
            }
            default: {
              const h = jstr(at(r, "href")); if (h !== undefined) m.link = this.link(h);
              runs.push({ t: plain, m });
            }
          }
          break;
        }
        default: {
          const content = jstr(at(r, "text", "content")) ?? plain;
          const h = jstr(at(r, "text", "link", "url")) ?? jstr(at(r, "href"));
          if (h !== undefined) m.link = this.link(h);
          runs.push({ t: content, m });
        }
      }
    }
    return toRichText(normalize(runs));
  }

  private link(href: string): string {
    const isNotion = href.startsWith("/") || href.includes("notion.so/") || href.includes("notion.site/");
    const id = isNotion ? notionIDInName(href) : undefined;
    if (id && this.importedIDs.has(id)) return "based://page/" + id;
    if (href.startsWith("/")) return "https://www.notion.so" + href;
    return href;
  }

  // MARK: Symbole, Dateien, Personen, Daten

  private icon(j: JSONValue | undefined): BlockProps["icon"] | undefined {
    if (j === undefined || j === null) return undefined;
    switch (jstr(at(j, "type"))) {
      case "emoji": return jstr(at(j, "emoji"));
      case "external": { const u = jstr(at(j, "external", "url")); return u !== undefined ? { url: u } : undefined; }
      case "file": case "file_upload": { const m = this.media(j); return m.asset ? { asset: m.asset } : m.url !== undefined ? { url: m.url } : undefined; }
      case "custom_emoji": {
        const url = jstr(at(j, "custom_emoji", "url"));
        if (url === undefined) return undefined;
        const local = this.snap.files.get(notionFileKey(url));
        if (local) {
          const ext = local.name.includes(".") ? local.name.slice(local.name.lastIndexOf(".") + 1) : "";
          return { asset: this.builder.asset(notionFileKey(url), local.data, (jstr(at(j, "custom_emoji", "name")) ?? "emoji") + "." + ext) };
        }
        return { url };
      }
      case "icon": return { url: `https://www.notion.so/icons/${jstr(at(j, "icon", "name")) ?? "document"}_${jstr(at(j, "icon", "color")) ?? "gray"}.svg` };
      default: return undefined;
    }
  }

  private cover(j: JSONValue | undefined): BlockProps["cover"] | undefined {
    if (j === undefined || j === null) return undefined;
    const m = this.media(j);
    return m.asset ? { asset: { _0: m.asset } } : m.url !== undefined ? { url: { _0: m.url } } : undefined;
  }

  private media(j: JSONValue | undefined): { asset?: AssetRef; url?: string } {
    if (j === undefined) return {};
    const t = jstr(at(j, "type")) ?? "";
    const url = jstr(at(j, t, "url")) ?? jstr(at(j, "external", "url")) ?? jstr(at(j, "file", "url"));
    if (url === undefined) return {};
    const local = t !== "external" ? this.snap.files.get(notionFileKey(url)) : undefined;
    if (local) return { asset: this.builder.asset(notionFileKey(url), local.data, jstr(at(j, "name")) ?? local.name) };
    return { url };
  }

  private user(j: JSONValue | undefined): string | undefined {
    if (j === undefined || j === null) return undefined;
    const n = jstr(at(j, "name"));
    if (n) return n;
    const id = nid(at(j, "id"));
    if (id && this.snap.users.has(id)) return this.snap.users.get(id);
    return jstr(at(j, "person", "email"));
  }

  private time(j: JSONValue | undefined): number | undefined {
    const s = jstr(j);
    return s === undefined ? undefined : isoSeconds(s);
  }

  private parseDate(s: string): { date: number; time: boolean } | undefined {
    if ([...s].length <= 10) { const d = daySeconds(s); return d !== undefined ? { date: d, time: false } : undefined; }
    const t = isoSeconds(s);
    if (t !== undefined) return { date: t, time: true };
    const d = daySeconds(s.slice(0, 10));
    return d !== undefined ? { date: d, time: false } : undefined;
  }

  private dateValue(j: JSONValue | undefined): DateValue | undefined {
    const start = jstr(at(j, "start"));
    if (start === undefined) return undefined;
    const s = this.parseDate(start);
    if (!s) return undefined;
    const endRaw = jstr(at(j, "end"));
    const e = endRaw !== undefined ? this.parseDate(endRaw) : undefined;
    const d: DateValue = { start: s.date, includeTime: s.time };
    if (e) d.end = e.date;
    return d;
  }

  private titleText(page: JSONValue): RichText {
    for (const v of Object.values(jobj(at(page, "properties")) ?? {})) if (at(v, "type") === "title") return this.richText(at(v, "title"));
    return this.richText(at(page, "title"));
  }
}

export type { Obj as NotionObject };
