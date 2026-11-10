// BSD-155: Datenbank-Operationen des TS-Kerns, portiert aus BasedCore Store/DatabaseOps.swift,
// Store/RelationIntegrity.swift (BSD-31) und Model/Chart.swift (DashboardConfig). Jede Operation ist genau
// eine Store-Transaktion (ein Undo-Schritt); Reparaturen (Spiegel, Rollups, Ansichten) laufen in derselben.
import { ZERO_STAMP } from "../hlc.js";
import type { Block, Database, DatabaseView, FilterGroup, FilterItem, PropertySchema, PropertyValue, RichText } from "../model/records.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { databaseOfRow, richPlain, TITLE_PROPERTY_ID, titleProperty } from "../query/engine.js";
import { newID, plainString, propertyConversion } from "./conversion.js";
import { afterRemoteMerge, keyOf, type Tx, type WorkspaceStore } from "./store.js";
import type { WireRecord } from "../model/records.js";

export type ViewType = DatabaseView["type"];
export type GroupRule = NonNullable<DatabaseView["groupBy"]>;
export type SortRule = NonNullable<DatabaseView["sorts"]>[number];
export type ChartConfig = NonNullable<DatabaseView["chart"]>;
export type DashboardConfig = NonNullable<DatabaseView["dashboard"]>;
type ViewProperty = NonNullable<DatabaseView["properties"]>[number];
type SelectOption = NonNullable<PropertySchema["options"]>[number];

const TEXT_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
/** Dashboard: 12 Spalten, höchstens 4 Widgets je Zeile (Swift `DashboardConfig`). */
export const DASHBOARD_COLUMNS = 12;
export const DASHBOARD_MAX_WIDGETS_PER_ROW = 4;
export const WIDGET_TYPES: readonly string[] = ["chart", "table", "board", "list", "gallery", "calendar", "timeline", "map"];

const DEFAULT_VIEW_NAMES: Record<string, string> = {
  table: "Table", board: "Board", list: "List", gallery: "Gallery", calendar: "Calendar", timeline: "Timeline", dashboard: "Dashboard",
};
export const defaultViewName = (type: string) => DEFAULT_VIEW_NAMES[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

// MARK: Werte

type Case = [string, unknown];
function caseOf(v: unknown): Case | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  const inner = (v as Record<string, unknown>)[keys[0]!];
  return [keys[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined];
}
/** Gespeicherter Wert im Swift-Enum-Format: `pv("number", 5)` → `{ "number": { "_0": 5 } }`. */
export const pv = (kind: string, value: unknown): PropertyValue => ({ [kind]: { _0: value } }) as PropertyValue;
/** `[fall, wert]` eines gespeicherten Werts (oder `undefined`). */
export const valueCase = (v: PropertyValue | undefined): Case | undefined => caseOf(v);
const relationIDs = (v: PropertyValue | undefined): string[] => {
  const c = caseOf(v);
  return c?.[0] === "relation" && Array.isArray(c[1]) ? (c[1] as string[]) : [];
};

function setRowValue(b: Block, propertyID: string, value: PropertyValue | null | undefined) {
  const values = { ...(b.values ?? {}) };
  if (value == null) delete values[propertyID];
  else values[propertyID] = value;
  if (Object.keys(values).length === 0) delete b.values;
  else b.values = values;
}

// MARK: Lesen

export const propertyOf = (db: Database, id: string): PropertySchema | undefined =>
  db.properties.find((p) => p.id === id) ?? (id === TITLE_PROPERTY_ID ? titleProperty(db) : undefined);
export const propertyNamed = (db: Database, name: string) => {
  const l = name.toLocaleLowerCase();
  return db.properties.find((p) => p.name.toLocaleLowerCase() === l);
};

/** Ansichten (Tabs) eines Datenbank-Blocks nach (sortKey, id); Dashboard-Widgets zählen nicht. */
export function viewsForBlock(store: WorkspaceStore, blockID: string): DatabaseView[] {
  const out: DatabaseView[] = [];
  for (const v of store.views.values()) if (v.blockID === blockID && v.widgetOf === undefined) out.push(v);
  return out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Sichtbare Properties einer Ansicht in Anzeigereihenfolge (Swift `visiblePropertyIDs`). */
export function visiblePropertyIDs(view: DatabaseView, db: Database): string[] {
  const configured = view.properties ?? [];
  const ids = configured.filter((p) => p.visible).map((p) => p.id).filter((id) => propertyOf(db, id) !== undefined);
  const known = new Set(configured.map((p) => p.id));
  for (const p of db.properties) if (!known.has(p.id) && (view.type === "table" || p.type === "title") && !ids.includes(p.id)) ids.push(p.id);
  const title = titleProperty(db).id;
  if (!ids.includes(title)) ids.unshift(title);
  return ids;
}

/** Alle Zeilen (auch Papierkorb und Vorlagen) – für schemaweite Änderungen (BSD-122). */
const allRows = (store: WorkspaceStore, databaseID: string): Block[] =>
  store.children("d:" + databaseID).flatMap((id) => store.blocks.get(id) ?? []);

export function uniquePropertyName(name: string, db: Database): string {
  let candidate = name;
  for (let n = 2; propertyNamed(db, candidate); n++) candidate = `${name} ${n}`;
  return candidate;
}

// MARK: Tx-Helfer

function updDB(tx: Tx, store: WorkspaceStore, id: string, f: (d: Database) => void) {
  const d = store.databases.get(id);
  if (!d) return;
  const c = structuredClone(d);
  f(c);
  tx.put({ kind: "database", data: c });
}
function updView(tx: Tx, store: WorkspaceStore, id: string, f: (v: DatabaseView) => void) {
  const v = store.views.get(id);
  if (!v) return;
  const c = structuredClone(v);
  f(c);
  tx.put({ kind: "view", data: c });
}
function updProp(tx: Tx, store: WorkspaceStore, databaseID: string, propertyID: string, f: (p: PropertySchema) => void) {
  updDB(tx, store, databaseID, (d) => {
    const p = d.properties.find((x) => x.id === propertyID);
    if (p) f(p);
  });
}

function newView(store: WorkspaceStore, databaseID: string, blockID: string, name: string, type: string, sortKey: string): DatabaseView {
  const t = store.now();
  return { id: newID(), databaseID, blockID, name, type, sortKey, createdAt: t, updatedAt: t, stamp: { ...ZERO_STAMP } };
}
function newBlock(store: WorkspaceStore, init: Pick<Block, "type" | "parent" | "sk"> & Partial<Block>): Block {
  const t = store.now();
  const b: Block = { id: newID(), createdAt: t, updatedAt: t, ...init };
  if (store.userID != null && b.createdBy === undefined) b.createdBy = store.userID;
  return b;
}
const newProperty = (name: string, type: string): PropertySchema => ({ id: newID(), name, type });

function statusDefaults(p: PropertySchema) {
  const a = { id: newID(), name: "Not started", color: "default" }, b = { id: newID(), name: "In progress", color: "blue" }, c = { id: newID(), name: "Done", color: "green" };
  p.options = [a, b, c];
  p.statusGroups = [
    { id: newID(), name: "To-do", color: "gray", optionIDs: [a.id] },
    { id: newID(), name: "In progress", color: "blue", optionIDs: [b.id] },
    { id: newID(), name: "Complete", color: "green", optionIDs: [c.id] },
  ];
}
/** Neue Property mit sinnvollen Vorgaben je Typ (Status mit Gruppen, Formel leer). */
function makeProperty(name: string, type: string): PropertySchema {
  const p = newProperty(name, type);
  if (type === "status") statusDefaults(p);
  if (type === "select" || type === "multiSelect") p.options = [];
  if (type === "formula") p.formula = "";
  return p;
}

/** Position eines neuen Kinds: Ende (Standard), vor oder nach einem Geschwister. */
export type InsertPosition = { before: string } | { after: string } | "end" | "start";
function sortKeyIn(store: WorkspaceStore, parent: string, pos: InsertPosition = "end"): string {
  const kids = store.children(parent);
  const sk = (id: string | undefined) => (id ? store.blocks.get(id)?.sk : undefined);
  if (pos === "end") return keyBetween(sk(kids[kids.length - 1]), undefined);
  if (pos === "start") return keyBetween(undefined, sk(kids[0]));
  const anchor = "before" in pos ? pos.before : pos.after;
  const i = kids.indexOf(anchor);
  if (i < 0) return keyBetween(sk(kids[kids.length - 1]), undefined);
  return "before" in pos ? keyBetween(sk(kids[i - 1]), sk(anchor)) : keyBetween(sk(anchor), sk(kids[i + 1]));
}

// MARK: Datenbank anlegen

export interface CreatedDatabase {
  blockID: string;
  databaseID: string;
  viewID: string;
}

/** Datenbank inline (im Seiteninhalt) oder als ganze Seite, mit einer ersten Ansicht und Beispielzeilen. */
export function createDatabase(store: WorkspaceStore, opts: { parent: string; title?: RichText; inline?: boolean; viewType?: string; sampleRows?: number; position?: InsertPosition; blockID?: string; undoable?: boolean }): CreatedDatabase {
  const viewType = opts.viewType ?? "table";
  return store.transact("New database", (tx) => {
    const t = store.now();
    const blockID = opts.blockID ?? newID();
    const props: PropertySchema[] = [{ id: TITLE_PROPERTY_ID, name: "Name", type: "title" }];
    let groupBy: string | undefined, dateProp: string | undefined;
    if (viewType === "board") {
      const s = makeProperty("Status", "status");
      props.push(s);
      groupBy = s.id;
    } else if (viewType === "calendar" || viewType === "timeline") {
      const d = newProperty("Date", "date");
      props.push(d, makeProperty("Tags", "multiSelect"));
      dateProp = d.id;
    } else props.push(makeProperty("Tags", "multiSelect"));
    const db: Database = { id: newID(), blockID, title: opts.title ?? "", properties: props, createdAt: t, updatedAt: t, stamp: { ...ZERO_STAMP } };
    tx.put({ kind: "database", data: db });
    const view = newView(store, db.id, blockID, defaultViewName(viewType), viewType, keyBetween(undefined, undefined));
    if (groupBy) view.groupBy = { propertyID: groupBy };
    if (dateProp) view.datePropertyID = dateProp;
    if (viewType === "gallery") view.cardCover = { pageContent: {} };
    tx.put({ kind: "view", data: view });
    const block = newBlock(store, { type: opts.inline ? "databaseInline" : "databasePage", parent: opts.parent, sk: sortKeyIn(store, opts.parent, opts.position) });
    block.id = blockID;
    block.props = { databaseID: db.id, viewIDs: [view.id] };
    tx.put({ kind: "block", data: block });
    const n = opts.sampleRows ?? 3;
    if (n > 0 && viewType !== "calendar" && viewType !== "timeline") {
      for (const k of keysBetween(n, undefined, undefined)) tx.put({ kind: "block", data: newBlock(store, { type: "page", parent: "d:" + db.id, sk: k }) });
    }
    return { blockID, databaseID: db.id, viewID: view.id };
  }, { undoable: opts.undoable ?? true });
}

/** „Linked view of database“: ein Block, der eine bestehende Datenbank mit eigenen Ansichten zeigt. */
export function createLinkedView(store: WorkspaceStore, databaseID: string, parent: string, type = "table"): string | undefined {
  if (!store.databases.has(databaseID)) return undefined;
  return store.transact("Linked view", (tx) => {
    const blockID = newID();
    const view = newView(store, databaseID, blockID, defaultViewName(type), type, keyBetween(undefined, undefined));
    tx.put({ kind: "view", data: view });
    const b = newBlock(store, { type: "databaseInline", parent, sk: sortKeyIn(store, parent) });
    b.id = blockID;
    b.props = { databaseID, viewIDs: [view.id] };
    tx.put({ kind: "block", data: b });
    return blockID;
  });
}

export function setDatabaseTitle(store: WorkspaceStore, databaseID: string, title: RichText) {
  if (!store.databases.has(databaseID)) return;
  store.transact("Rename database", (tx) => updDB(tx, store, databaseID, (d) => { d.title = title; }), { coalesce: "dbtitle:" + databaseID });
}

export function setDatabaseLocked(store: WorkspaceStore, databaseID: string, locked: boolean) {
  if (!store.databases.has(databaseID)) return;
  store.transact("Lock database", (tx) => updDB(tx, store, databaseID, (d) => { if (locked) d.locked = true; else delete d.locked; }));
}

// MARK: Zeilen

/** Nach dem Anlegen/Kopieren einer Zeile mit Relationswerten: Gegenseiten zeigen zurück (two-way). */
export function linkMirrors(store: WorkspaceStore, rowID: string, tx: Tx) {
  const row = tx.block(rowID);
  const db = row && databaseOfRow(store, rowID);
  if (!row || !db) return;
  for (const p of db.properties) {
    const mirror = p.relation?.syncedPropertyID;
    if (p.type !== "relation" || !mirror) continue;
    for (const t of relationIDs(row.values?.[p.id])) {
      if (!tx.block(t)) continue;
      tx.update(t, (b) => {
        const ids = relationIDs(b.values?.[mirror]);
        if (!ids.includes(rowID)) setRowValue(b, mirror, pv("relation", [...ids, rowID]));
      });
    }
  }
}

// MARK: BSD-123 – doppelte ID-Nummern nach Sync (Port von Swift `UniqueIDRepair.swift`)
//
// Die nächste Nummer liegt im Datenbank-Record und wird lokal hochgezählt. Zwei Geräte, die zwischen zwei Syncs
// Zeilen anlegen, vergeben dieselbe Nummer; LWW auf dem Datenbank-Record behält die Doppelung. Nach jedem
// Remote-Merge: die älteste Zeile (createdAt, dann ID) behält ihre Nummer, jede weitere bekommt die nächste freie,
// `nextUniqueID` steigt über das Maximum. Alle Geräte kommen zum selben Ergebnis; Zeilen im Papierkorb zählen mit.

const uniqueNumber = (v: PropertyValue | undefined): number | undefined => {
  const n = (v as { uniqueID?: { _0?: unknown } } | undefined)?.uniqueID?._0;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

/** Datenbanken mit ID-Property, die `records` berühren (ihre Zeilen oder der Datenbank-Record selbst). */
export function databasesNeedingIDCheck(store: WorkspaceStore, records: readonly WireRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    const id = r.kind === "block" ? (r.data.parent.startsWith("d:") ? r.data.parent.slice(2) : undefined) : r.kind === "database" ? r.data.id : undefined;
    if (id && store.databases.get(id)?.properties.some((p) => p.type === "uniqueID")) out.add(id);
  }
  return out;
}

/** Neue Nummern für Zeilen, deren ID die einer älteren doppelt, und das nötige `nextUniqueID` (rein, liest nur). */
export function uniqueIDRepair(store: WorkspaceStore, databaseID: string): { property: string; renumber: Map<string, number>; next: number | undefined } | undefined {
  const db = store.databases.get(databaseID);
  const uid = db?.properties.find((p) => p.type === "uniqueID");
  if (!db || !uid) return undefined;
  const numbered = allRows(store, databaseID)
    .map((r) => [r, uniqueNumber(r.values?.[uid.id])] as const)
    .filter((x): x is readonly [Block, number] => x[1] !== undefined)
    .sort((a, b) => (a[0].createdAt !== b[0].createdAt ? a[0].createdAt - b[0].createdAt : a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0));
  let max = numbered.reduce((m, [, n]) => Math.max(m, n), 0);
  const seen = new Set<number>();
  const renumber = new Map<string, number>();
  for (const [row, n] of numbered) {
    if (!seen.has(n)) {
      seen.add(n);
      continue;
    }
    max += 1;
    renumber.set(row.id, max);
    seen.add(max);
  }
  const next = (db.nextUniqueID ?? 1) <= max ? max + 1 : undefined;
  if (renumber.size === 0 && next === undefined) return undefined;
  return { property: uid.id, renumber, next };
}

/** Doppelte IDs in `databaseIDs` als eine lokale, nicht rückgängig machbare Änderung reparieren (synct wie jede). */
export function repairUniqueIDs(store: WorkspaceStore, databaseIDs: Iterable<string>) {
  const fixes = [...databaseIDs].sort().map((id) => [id, uniqueIDRepair(store, id)] as const).filter((x) => x[1] !== undefined);
  if (fixes.length === 0 || store.isReadOnly) return;
  store.transact("Repair IDs", (tx) => {
    for (const [dbID, fix] of fixes) {
      for (const [row, n] of fix!.renumber) tx.update(row, (b) => setRowValue(b, fix!.property, pv("uniqueID", n)));
      if (fix!.next !== undefined) updDB(tx, store, dbID, (d) => { d.nextUniqueID = fix!.next; });
    }
  }, { undoable: false });
}

afterRemoteMerge.push((store, records) => {
  const ids = databasesNeedingIDCheck(store, records);
  if (ids.size > 0) repairUniqueIDs(store, ids);
});

// MARK: BSD-122 – Werte einer Zeile, die aus dem Papierkorb zurückkommt

const VALUE_KIND: Record<string, string> = {
  title: "text", text: "text", number: "number", date: "date", person: "person", files: "files", checkbox: "checkbox", url: "url",
  email: "email", phone: "phone", relation: "relation", uniqueID: "uniqueID", place: "place", select: "select", status: "status", multiSelect: "multiSelect",
};

/**
 * `values` ohne das, was nicht mehr zum Schema passt: ein Wert, dessen Art nicht zum Property-Typ passt, und
 * Option-IDs, die die Property nicht mehr hat. Unbekannte Properties/Werte und berechnete Typen bleiben (Swift
 * `valuesMatchingSchema`).
 */
export function valuesMatchingSchema(values: Record<string, PropertyValue>, db: Database): Record<string, PropertyValue> {
  const out = { ...values };
  for (const [pid, v] of Object.entries(values)) {
    const p = db.properties.find((x) => x.id === pid);
    const kind = v && typeof v === "object" ? Object.keys(v)[0] : undefined;
    if (!p || !kind || !(kind in VALUE_KIND_SET)) continue; // unbekannte Property oder unbekannte Wert-Art
    const want = VALUE_KIND[p.type];
    if (want === undefined) continue; // berechnete oder unbekannte Typen
    if (kind !== want) {
      delete out[pid];
      continue;
    }
    const options = new Set((p.options ?? []).map((o) => o.id));
    const raw = (v as Record<string, { _0?: unknown }>)[kind]?._0;
    if (kind === "select" || kind === "status") {
      if (typeof raw !== "string" || !options.has(raw)) delete out[pid];
    } else if (kind === "multiSelect" && Array.isArray(raw)) {
      const rest = raw.filter((x): x is string => typeof x === "string" && options.has(x));
      if (rest.length !== raw.length) {
        if (rest.length === 0) delete out[pid];
        else out[pid] = pv("multiSelect", rest);
      }
    }
  }
  return out;
}
const VALUE_KIND_SET: Record<string, true> = Object.fromEntries(Object.values(VALUE_KIND).map((k) => [k, true]));

function assignUniqueID(store: WorkspaceStore, tx: Tx, databaseID: string, rowID: string) {
  const db = store.databases.get(databaseID);
  const uid = db?.properties.find((p) => p.type === "uniqueID");
  if (!db || !uid) return;
  const next = db.nextUniqueID ?? 1;
  tx.update(rowID, (b) => setRowValue(b, uid.id, pv("uniqueID", next)));
  updDB(tx, store, databaseID, (d) => { d.nextUniqueID = next + 1; });
}

/** Kopie eines Blocks mit allen Nachfahren (neue IDs); gibt die neue ID zurück. */
function copySubtree(store: WorkspaceStore, tx: Tx, src: Block, parent: string, sk: string): string {
  const copy = structuredClone(src);
  copy.id = newID();
  copy.parent = parent;
  copy.sk = sk;
  copy.createdAt = store.now();
  if (store.userID != null) copy.createdBy = store.userID;
  else delete copy.createdBy;
  delete copy.trashedAt;
  tx.put({ kind: "block", data: copy });
  for (const kid of store.children("b:" + src.id)) {
    const k = store.blocks.get(kid);
    if (k) copySubtree(store, tx, k, "b:" + copy.id, k.sk);
  }
  return copy.id;
}

export interface AddRowOptions {
  title?: RichText;
  values?: Record<string, PropertyValue>;
  position?: InsertPosition;
  /** Vorlage (sonst die Standardvorlage der Datenbank, falls gesetzt). */
  template?: string;
}

/** Neue Zeile; vergibt die nächste ID-Nummer und verlinkt two-way-Relationen. Ein Undo-Schritt. */
export function addRow(store: WorkspaceStore, databaseID: string, opts: AddRowOptions = {}): string | undefined {
  const db = store.databases.get(databaseID);
  if (!db) return undefined;
  const parent = "d:" + databaseID;
  const tplID = opts.template ?? db.defaultTemplateID;
  const tpl = tplID ? store.blocks.get(tplID) : undefined;
  return store.transact("New row", (tx) => {
    const sk = sortKeyIn(store, parent, opts.position);
    let id: string;
    if (tpl) {
      id = copySubtree(store, tx, tpl, parent, sk);
      tx.update(id, (b) => {
        if (b.props) {
          delete b.props.isTemplate;
          if (Object.keys(b.props).length === 0) delete b.props;
        }
        if (opts.title !== undefined && richPlain(opts.title) !== "") b.text = opts.title;
        for (const [k, v] of Object.entries(opts.values ?? {})) setRowValue(b, k, v);
      });
    } else {
      const b = newBlock(store, { type: "page", parent, sk });
      if (opts.title !== undefined && richPlain(opts.title) !== "") b.text = opts.title;
      if (opts.values && Object.keys(opts.values).length) b.values = structuredClone(opts.values);
      tx.put({ kind: "block", data: b });
      id = b.id;
    }
    assignUniqueID(store, tx, databaseID, id);
    linkMirrors(store, id, tx);
    return id;
  });
}

/** Vorlage (Zeile mit `isTemplate`); erscheint nie in Ansichten. */
export function addTemplate(store: WorkspaceStore, databaseID: string, title: RichText = "New template"): string | undefined {
  if (!store.databases.has(databaseID)) return undefined;
  return store.transact("New template", (tx) => {
    const b = newBlock(store, { type: "page", parent: "d:" + databaseID, sk: sortKeyIn(store, "d:" + databaseID), text: title, props: { isTemplate: true } });
    tx.put({ kind: "block", data: b });
    updDB(tx, store, databaseID, (d) => { d.templateIDs = [...(d.templateIDs ?? []), b.id]; });
    return b.id;
  });
}

const COALESCED_KINDS = new Set(["text", "number", "url", "email", "phone", "place"]);

/** Wert einer Zelle setzen (`null` = leeren). Titel gehen über `setText`; Tippen wird zusammengefasst. */
export function setValue(store: WorkspaceStore, rowID: string, propertyID: string, value: PropertyValue | null) {
  const b = store.blocks.get(rowID);
  if (!b) return;
  const db = databaseOfRow(store, rowID);
  if (propertyID === TITLE_PROPERTY_ID || db?.properties.find((p) => p.id === propertyID)?.type === "title") {
    const c = caseOf(value);
    store.setText(rowID, c?.[0] === "text" ? (c[1] as RichText) : "");
    return;
  }
  const old = b.values?.[propertyID];
  if (JSON.stringify(old ?? null) === JSON.stringify(value ?? null)) return;
  const kind = caseOf(value)?.[0];
  const coalesce = kind && COALESCED_KINDS.has(kind) ? `value:${rowID}:${propertyID}` : undefined;
  store.transact("Edit property", (tx) => tx.update(rowID, (x) => setRowValue(x, propertyID, value)), coalesce ? { coalesce } : {});
}

/** Titel einer Zeile (wie `setText`, ein Undo-Schritt beim Tippen). */
export function setRowTitle(store: WorkspaceStore, rowID: string, title: string) {
  store.setText(rowID, title);
}

/** Zeilen in den Papierkorb. */
export function deleteRows(store: WorkspaceStore, ids: string[]) {
  store.deleteBlocks(ids);
}

/** Kopie einer Zeile direkt darunter (neue ID-Nummer, two-way-Relationen verlinkt). */
export function duplicateRow(store: WorkspaceStore, rowID: string): string | undefined {
  const row = store.blocks.get(rowID);
  if (!row || !row.parent.startsWith("d:")) return undefined;
  const databaseID = row.parent.slice(2);
  return store.transact("Duplicate", (tx) => {
    const id = copySubtree(store, tx, row, row.parent, sortKeyIn(store, row.parent, { after: rowID }));
    assignUniqueID(store, tx, databaseID, id);
    linkMirrors(store, id, tx);
    return id;
  });
}

/** Zeile umsortieren (Board-Karte, Tabellenzeile ohne Sortierung). */
export function moveRow(store: WorkspaceStore, rowID: string, position: InsertPosition) {
  const row = store.blocks.get(rowID);
  if (!row) return;
  store.transact("Move row", (tx) => applyMove(store, tx, row, position));
}
function applyMove(store: WorkspaceStore, tx: Tx, row: Block, position: InsertPosition) {
  if (typeof position === "object" && ("before" in position ? position.before : position.after) === row.id) return;
  const sk = sortKeyIn(store, row.parent, position);
  tx.update(row.id, (b) => { b.sk = sk; });
}

/**
 * Gespeicherter Wert, mit dem eine Zeile in Gruppe `groupID` landet (Board: Karte in andere Spalte ziehen).
 * `undefined`: Gruppe passt nicht zu dieser Property (z. B. Datumsgruppen, berechnete Properties).
 */
export function valueForGroup(row: Block, p: PropertySchema, fromGroup: string | undefined, toGroup: string): PropertyValue | null | undefined {
  switch (p.type) {
    case "select": case "status": return toGroup === "" ? null : pv(p.type, toGroup);
    case "multiSelect": {
      const ids = (() => { const c = caseOf(row.values?.[p.id]); return c?.[0] === "multiSelect" ? (c[1] as string[]) : []; })();
      const rest = ids.filter((x) => x !== fromGroup && x !== toGroup);
      const next = toGroup === "" ? rest : [...rest, toGroup];
      return next.length ? pv("multiSelect", next) : null;
    }
    case "checkbox": return pv("checkbox", toGroup === "true");
    case "person": {
      const ids = (() => { const c = caseOf(row.values?.[p.id]); return c?.[0] === "person" ? (c[1] as string[]) : []; })();
      const rest = ids.filter((x) => x !== fromGroup && x !== toGroup);
      const next = toGroup === "" ? rest : [...rest, toGroup];
      return next.length ? pv("person", next) : null;
    }
    case "text": case "url": case "email": case "phone": case "place": return toGroup === "" ? null : pv(p.type, toGroup);
    case "number": {
      if (toGroup === "") return null;
      const n = Number(toGroup.replaceAll(",", ""));
      return Number.isFinite(n) ? pv("number", n) : undefined;
    }
    default: return undefined;
  }
}

/** Karte in eine andere Gruppe (und an eine Stelle) ziehen: Wert und Position in einem Undo-Schritt. */
export function moveRowToGroup(store: WorkspaceStore, rowID: string, propertyID: string, fromGroup: string | undefined, toGroup: string, position?: InsertPosition): boolean {
  const row = store.blocks.get(rowID);
  const db = databaseOfRow(store, rowID);
  const p = db && propertyOf(db, propertyID);
  if (!row || !db || !p) return false;
  const value = fromGroup === toGroup ? undefined : valueForGroup(row, p, fromGroup, toGroup);
  if (fromGroup !== toGroup && value === undefined) return false;
  store.transact("Move card", (tx) => {
    if (value !== undefined) {
      if (p.type === "title") tx.update(rowID, (b) => { if (value === null) delete b.text; else b.text = caseOf(value)?.[1] as string; });
      else tx.update(rowID, (b) => setRowValue(b, propertyID, value));
    }
    if (position) applyMove(store, tx, store.blocks.get(rowID)!, position);
  });
  return true;
}

// MARK: Properties

/** Neue Property; in `showIn` sichtbar direkt nach `after` (oder am Ende). Gibt die ID zurück. */
export function addProperty(store: WorkspaceStore, databaseID: string, name: string, type: string, opts: { after?: string; showIn?: string } = {}): string | undefined {
  const db = store.databases.get(databaseID);
  if (!db) return undefined;
  const prop = makeProperty(uniquePropertyName(name, db), type);
  const rowsToNumber = type === "uniqueID" ? allRows(store, databaseID).sort((a, b) => a.createdAt - b.createdAt) : [];
  return store.transact("Add property", (tx) => {
    updDB(tx, store, databaseID, (d) => {
      const i = opts.after ? d.properties.findIndex((p) => p.id === opts.after) : -1;
      if (i >= 0) d.properties.splice(i + 1, 0, prop);
      else d.properties.push(prop);
      if (type === "uniqueID") d.nextUniqueID = rowsToNumber.length + 1;
    });
    rowsToNumber.forEach((r, i) => tx.update(r.id, (b) => setRowValue(b, prop.id, pv("uniqueID", i + 1))));
    const v = opts.showIn ? store.views.get(opts.showIn) : undefined;
    if (v) {
      updView(tx, store, v.id, (view) => {
        const list: ViewProperty[] = view.properties ?? visiblePropertyIDs(v, db).map((id) => ({ id, visible: true }));
        const rest = list.filter((x) => x.id !== prop.id);
        const i = opts.after ? rest.findIndex((x) => x.id === opts.after) : -1;
        if (i >= 0) rest.splice(i + 1, 0, { id: prop.id, visible: true });
        else rest.push({ id: prop.id, visible: true });
        view.properties = rest;
      });
    }
    return prop.id;
  });
}

/** Schema einer Property ändern (Optionen, Zahlformat, Formel, Rollup, Datumsformat, Präfix …). */
export function updateProperty(store: WorkspaceStore, databaseID: string, propertyID: string, f: (p: PropertySchema) => void, name = "Edit property") {
  if (!store.databases.get(databaseID)?.properties.some((p) => p.id === propertyID)) return;
  store.transact(name, (tx) => updProp(tx, store, databaseID, propertyID, f));
}

const unescapeFormula = (s: string) => s.replace(/\\(.)/g, "$1");
const escapeFormula = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** `prop("alt")` → `prop("neu")` (nicht `x.prop("alt")`, das liest eine verknüpfte Seite). Swift `renamingFormulaReferences`. */
export function renamingFormulaReferences(src: string, from: string, to: string): string {
  return src.replace(/(?<![.\w])prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g, (m, raw: string) => (unescapeFormula(raw) === from ? `prop("${escapeFormula(to)}")` : m));
}

/** Property-Namen, die eine Formel mit `prop("…")` liest (Näherung für Zyklus-Warnungen). */
export function formulaPropertyReferences(src: string): string[] {
  return [...src.matchAll(/prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) => unescapeFormula(m[1]!));
}

/**
 * `current.prop("alt")` in Lambdas über eine Relation (`prop("Rel").map(current.prop("alt"))`) – vereinfachte
 * Portierung von Swift `renamingRelatedReferences`: nur direkt in `map/filter/…`-Argumenten von `prop("Rel")`.
 */
export function renamingRelatedReferences(src: string, relations: Set<string>, from: string, to: string): string {
  if (relations.size === 0) return src;
  const re = /(?<![.\w])prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)((?:\s*\.\s*(?:map|filter|find|findIndex|some|every|count|sortBy)\s*\((?:[^()"]|"(?:[^"\\]|\\.)*"|\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))*\))+)/g;
  return src.replace(re, (m, raw: string, chain: string) => {
    if (!relations.has(unescapeFormula(raw))) return m;
    const next = chain.replace(/(?<![.\w])current\s*\.\s*prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g, (cm, name: string) =>
      unescapeFormula(name) === from ? `current.prop("${escapeFormula(to)}")` : cm);
    return m.slice(0, m.length - chain.length) + next;
  });
}

function rewriteFormulaReferences(store: WorkspaceStore, tx: Tx, databaseID: string, from: string, to: string) {
  if (from === to) return;
  const db = store.databases.get(databaseID);
  if (!db) return;
  if (db.properties.some((p) => p.formula && renamingFormulaReferences(p.formula, from, to) !== p.formula)) {
    updDB(tx, store, databaseID, (d) => {
      for (const p of d.properties) if (p.formula) p.formula = renamingFormulaReferences(p.formula, from, to);
    });
  }
  for (const other of [...store.databases.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rels = new Set(other.properties.filter((p) => p.type === "relation" && p.relation?.databaseID === databaseID).map((p) => p.name));
    if (rels.size === 0) continue;
    if (!other.properties.some((p) => p.formula && renamingRelatedReferences(p.formula, rels, from, to) !== p.formula)) continue;
    updDB(tx, store, other.id, (d) => {
      for (const p of d.properties) if (p.formula) p.formula = renamingRelatedReferences(p.formula, rels, from, to);
    });
  }
}

/** Umbenennen und `prop("alt")` in den Formeln mitziehen (ein Undo-Schritt, BSD-31). */
export function renameProperty(store: WorkspaceStore, databaseID: string, propertyID: string, name: string) {
  const old = store.databases.get(databaseID)?.properties.find((p) => p.id === propertyID)?.name;
  const trimmed = name.trim();
  if (old === undefined || old === trimmed || !trimmed) return;
  store.transact("Rename property", (tx) => {
    updProp(tx, store, databaseID, propertyID, (p) => { p.name = trimmed; });
    rewriteFormulaReferences(store, tx, databaseID, old, trimmed);
  });
}

// MARK: Ansichten aufräumen (Swift forgetProperty/forgetOption, FilterGroup.removing…)

export function filterRemovingProperty(g: FilterGroup, propertyID: string): FilterGroup {
  const items: FilterItem[] = [];
  for (const item of g.items) {
    const c = caseOf(item);
    if (c?.[0] === "condition") {
      if ((c[1] as { propertyID: string }).propertyID !== propertyID) items.push(item);
    } else if (c?.[0] === "group") {
      const sub = filterRemovingProperty(c[1] as FilterGroup, propertyID);
      if (sub.items.length) items.push({ group: { ...(item as { group: object }).group, _0: sub } } as FilterItem);
    } else items.push(item);
  }
  return { ...g, items };
}

export function filterRemovingOption(g: FilterGroup, optionID: string, propertyID: string): FilterGroup {
  return {
    ...g,
    items: g.items.map((item) => {
      const c = caseOf(item);
      if (c?.[0] === "group") return { group: { ...(item as { group: object }).group, _0: filterRemovingOption(c[1] as FilterGroup, optionID, propertyID) } } as FilterItem;
      if (c?.[0] !== "condition") return item;
      const cond = c[1] as { propertyID: string; value?: unknown };
      const opts = caseOf(cond.value);
      if (cond.propertyID !== propertyID || opts?.[0] !== "options" || !(opts[1] as string[]).includes(optionID)) return item;
      const rest = (opts[1] as string[]).filter((x) => x !== optionID);
      const next = { ...cond } as Record<string, unknown>;
      if (rest.length) next.value = { options: { _0: rest } };
      else delete next.value;
      return { condition: { ...(item as { condition: object }).condition, _0: next } } as FilterItem;
    }),
  };
}

/** Alle Einstellungen einer Ansicht, die auf eine gelöschte Property zeigen, entfernen. */
export function forgetProperty(view: DatabaseView, propertyID: string) {
  if (view.properties) view.properties = view.properties.filter((p) => p.id !== propertyID);
  if (view.sorts) view.sorts = view.sorts.filter((s) => s.propertyID !== propertyID);
  if (view.groupBy?.propertyID === propertyID) delete view.groupBy;
  if (view.datePropertyID === propertyID) delete view.datePropertyID;
  if (view.endDatePropertyID === propertyID) delete view.endDatePropertyID;
  if (view.mapPropertyID === propertyID) delete view.mapPropertyID;
  if (view.calculations) delete view.calculations[propertyID];
  if (view.filter) view.filter = filterRemovingProperty(view.filter, propertyID);
  if (view.chart?.xPropertyID === propertyID) delete view.chart.xPropertyID;
  if (view.chart?.yPropertyID === propertyID) delete view.chart.yPropertyID;
  const cover = caseOf(view.cardCover);
  if (cover?.[0] === "property" && cover[1] === propertyID) delete view.cardCover;
}

export function forgetOption(view: DatabaseView, optionID: string, propertyID: string) {
  if (view.filter) view.filter = filterRemovingOption(view.filter, optionID, propertyID);
  if (view.groupBy?.propertyID === propertyID) {
    if (view.groupBy.hiddenGroups) view.groupBy.hiddenGroups = view.groupBy.hiddenGroups.filter((x) => x !== optionID);
    if (view.groupBy.groupOrder) view.groupBy.groupOrder = view.groupBy.groupOrder.filter((x) => x !== optionID);
  }
}

// MARK: Relationen-Integrität (BSD-31)

function detachMirror(store: WorkspaceStore, tx: Tx, databaseID: string, propertyID: string) {
  const rel = store.databases.get(databaseID)?.properties.find((p) => p.id === propertyID)?.relation;
  const mirror = rel?.syncedPropertyID;
  if (!rel || !mirror) return;
  updProp(tx, store, databaseID, propertyID, (p) => { if (p.relation) delete p.relation.syncedPropertyID; });
  const target = store.databases.get(rel.databaseID);
  if (target?.properties.find((p) => p.id === mirror)?.relation?.syncedPropertyID !== propertyID) return;
  updProp(tx, store, target.id, mirror, (p) => { if (p.relation) delete p.relation.syncedPropertyID; });
}

function disableRollups(store: WorkspaceStore, tx: Tx, databaseID: string, relationPropertyID: string) {
  const db = store.databases.get(databaseID);
  if (!db?.properties.some((p) => p.rollup?.relationPropertyID === relationPropertyID)) return;
  updDB(tx, store, databaseID, (d) => {
    for (const p of d.properties) if (p.rollup?.relationPropertyID === relationPropertyID) delete p.rollup;
  });
}

function dropRelationLinks(store: WorkspaceStore, tx: Tx, databaseID: string, propertyID: string) {
  const rel = store.databases.get(databaseID)?.properties.find((p) => p.id === propertyID)?.relation;
  const mirror = rel?.syncedPropertyID;
  if (rel && mirror) {
    detachMirror(store, tx, databaseID, propertyID);
    if (store.databases.get(rel.databaseID)?.properties.some((p) => p.id === mirror) && !(rel.databaseID === databaseID && mirror === propertyID)) {
      purgeProperty(store, tx, rel.databaseID, mirror);
    }
  }
  disableRollups(store, tx, databaseID, propertyID);
}

/** Property mit allem, was auf sie zeigt, entfernen (Werte, Ansichten, Rollups hier und anderswo, Spiegel). */
function purgeProperty(store: WorkspaceStore, tx: Tx, databaseID: string, propertyID: string) {
  if (!store.databases.get(databaseID)?.properties.some((p) => p.id === propertyID)) return;
  detachMirror(store, tx, databaseID, propertyID);
  updDB(tx, store, databaseID, (d) => { d.properties = d.properties.filter((p) => p.id !== propertyID); });
  for (const v of [...store.views.values()]) if (v.databaseID === databaseID) updView(tx, store, v.id, (view) => forgetProperty(view, propertyID));
  disableRollups(store, tx, databaseID, propertyID);
  for (const other of [...store.databases.values()]) {
    const here = new Set(other.properties.filter((p) => p.relation?.databaseID === databaseID).map((p) => p.id));
    if (here.size === 0) continue;
    const broken = other.properties.filter((p) => p.rollup && here.has(p.rollup.relationPropertyID) && p.rollup.targetPropertyID === propertyID).map((p) => p.id);
    if (broken.length === 0) continue;
    updDB(tx, store, other.id, (d) => { for (const p of d.properties) if (broken.includes(p.id)) delete p.rollup; });
  }
  for (const r of allRows(store, databaseID)) if (r.values?.[propertyID] !== undefined) tx.update(r.id, (b) => setRowValue(b, propertyID, null));
}

/** Property löschen (nicht den Titel); Partner einer two-way-Relation wird one-way und behält seine Werte. */
export function deleteProperty(store: WorkspaceStore, databaseID: string, propertyID: string) {
  const p = store.databases.get(databaseID)?.properties.find((x) => x.id === propertyID);
  if (!p || p.type === "title") return;
  store.transact("Delete property", (tx) => purgeProperty(store, tx, databaseID, propertyID));
}

/** Kopie einer Property mit ihren Werten (eine kopierte Relation ist one-way). */
export function duplicateProperty(store: WorkspaceStore, databaseID: string, propertyID: string): string | undefined {
  const db = store.databases.get(databaseID);
  const p = db?.properties.find((x) => x.id === propertyID);
  if (!db || !p || p.type === "title") return undefined;
  const copy = structuredClone(p);
  copy.id = newID();
  copy.name = uniquePropertyName(p.name, db);
  if (copy.relation) delete copy.relation.syncedPropertyID;
  return store.transact("Duplicate property", (tx) => {
    updDB(tx, store, databaseID, (d) => {
      const i = d.properties.findIndex((x) => x.id === propertyID);
      d.properties.splice(i < 0 ? d.properties.length : i + 1, 0, copy);
    });
    for (const r of allRows(store, databaseID)) {
      const v = r.values?.[propertyID];
      if (v !== undefined) tx.update(r.id, (b) => setRowValue(b, copy.id, structuredClone(v)));
    }
    return copy.id;
  });
}

/** Typ wechseln und Werte wie Notion umwandeln; die UI fragt vorher mit `conversionLoss`. Ein Undo-Schritt. */
export function changePropertyType(store: WorkspaceStore, databaseID: string, propertyID: string, type: string) {
  const plan = propertyConversion(store, databaseID, propertyID, type);
  if (!plan) return;
  const wasRelation = store.databases.get(databaseID)?.properties.find((p) => p.id === propertyID)?.type === "relation";
  store.transact("Change property type", (tx) => {
    if (wasRelation) dropRelationLinks(store, tx, databaseID, propertyID);
    const schema = plan.schema;
    if (wasRelation && type !== "relation") delete schema.relation;
    if (type === "rollup" && schema.rollup === undefined) delete schema.rollup;
    updDB(tx, store, databaseID, (d) => {
      const i = d.properties.findIndex((p) => p.id === propertyID);
      if (i >= 0) d.properties[i] = schema;
      if (type === "uniqueID" && d.nextUniqueID === undefined) d.nextUniqueID = 1;
    });
    for (const [id, v] of plan.values) tx.update(id, (b) => setRowValue(b, propertyID, v));
  });
}

/** Zeilen mit nicht-leerem Wert (Frage vor dem Löschen einer Property). */
export function filledCellCount(store: WorkspaceStore, databaseID: string, propertyID: string): number {
  const p = store.databases.get(databaseID)?.properties.find((x) => x.id === propertyID);
  let n = 0;
  for (const id of store.children("d:" + databaseID)) {
    const r = store.blocks.get(id);
    const v = r?.values?.[propertyID];
    if (!r || r.trashedAt !== undefined || v === undefined) continue;
    if (caseOf(v)?.[0] === "checkbox" || plainString(v, p) !== "") n += 1;
  }
  return n;
}

/** Relation auf eine andere Datenbank richten: alte Links und Gegenseite entfallen (wie Notion). */
export function setRelationTarget(store: WorkspaceStore, databaseID: string, propertyID: string, target: string | undefined) {
  const p = store.databases.get(databaseID)?.properties.find((x) => x.id === propertyID);
  if (!p || p.type !== "relation" || p.relation?.databaseID === target) return;
  store.transact("Relation", (tx) => {
    dropRelationLinks(store, tx, databaseID, propertyID);
    for (const r of allRows(store, databaseID)) if (r.values?.[propertyID] !== undefined) tx.update(r.id, (b) => setRowValue(b, propertyID, null));
    updProp(tx, store, databaseID, propertyID, (q) => {
      if (target === undefined) delete q.relation;
      else q.relation = { databaseID: target, ...(p.relation?.limitOne ? { limitOne: true } : {}) };
    });
  });
}

/** „Limit to 1 page“ an/aus (bestehende Mehrfach-Links bleiben, siehe `relationLimitViolations`). */
export function setRelationLimitOne(store: WorkspaceStore, databaseID: string, propertyID: string, on: boolean) {
  updateProperty(store, databaseID, propertyID, (p) => {
    if (!p.relation) return;
    if (on) p.relation.limitOne = true;
    else delete p.relation.limitOne;
  }, "Limit relation");
}

/** Two-way: legt die gespiegelte Property auf der Zieldatenbank an und füllt sie. */
export function makeRelationTwoWay(store: WorkspaceStore, databaseID: string, propertyID: string, name?: string): string | undefined {
  const db = store.databases.get(databaseID);
  const p = db?.properties.find((x) => x.id === propertyID);
  const rel = p?.relation;
  const target = rel ? store.databases.get(rel.databaseID) : undefined;
  if (!db || !rel || rel.syncedPropertyID !== undefined || !target) return undefined;
  const dbTitle = richPlain(db.title) || "Untitled";
  const mirror: PropertySchema = { id: newID(), name: name ?? uniquePropertyName(`Related to ${dbTitle}`, target), type: "relation", relation: { databaseID, syncedPropertyID: propertyID } };
  const source = allRows(store, databaseID);
  return store.transact("Two-way relation", (tx) => {
    updDB(tx, store, target.id, (d) => { d.properties.push(mirror); });
    updProp(tx, store, databaseID, propertyID, (q) => { if (q.relation) q.relation.syncedPropertyID = mirror.id; });
    const back = new Map<string, string[]>();
    for (const r of source) for (const t of relationIDs(r.values?.[propertyID])) back.set(t, [...(back.get(t) ?? []), r.id]);
    for (const [t, ids] of back) if (tx.block(t)) tx.update(t, (b) => setRowValue(b, mirror.id, pv("relation", ids)));
    return mirror.id;
  });
}

/** Rollup konfigurieren (Relation, Ziel-Property, Funktion). */
export function setRollup(store: WorkspaceStore, databaseID: string, propertyID: string, cfg: { relationPropertyID: string; targetPropertyID: string; function: string }) {
  updateProperty(store, databaseID, propertyID, (p) => { p.rollup = { ...cfg }; }, "Edit rollup");
}

/** Würde das Rollup von sich selbst abhängen (z. B. über eine two-way-Relation)? Swift `wouldCreateRollupCycle`. */
export function wouldCreateRollupCycle(store: WorkspaceStore, databaseID: string, propertyID: string, relationPropertyID: string, targetPropertyID: string): boolean {
  const db = store.databases.get(databaseID);
  const targetDB = db?.properties.find((p) => p.id === relationPropertyID)?.relation?.databaseID;
  if (!db || !targetDB) return false;
  const visited = new Set<string>();
  const todo: [string, string][] = [[targetDB, targetPropertyID]];
  while (todo.length) {
    const [dbID, pid] = todo.pop()!;
    if (dbID === databaseID && pid === propertyID) return true;
    const key = dbID + "\u0001" + pid;
    const d = store.databases.get(dbID);
    const p = d?.properties.find((x) => x.id === pid);
    if (visited.has(key) || !d || !p) continue;
    visited.add(key);
    if (p.type === "rollup" && p.rollup) {
      const next = d.properties.find((x) => x.id === p.rollup!.relationPropertyID)?.relation?.databaseID;
      if (next) todo.push([next, p.rollup.targetPropertyID]);
    } else if (p.type === "formula") {
      for (const name of formulaPropertyReferences(p.formula ?? "")) {
        const q = propertyNamed(d, name);
        if (q) todo.push([dbID, q.id]);
      }
    }
  }
  return false;
}

// MARK: Optionen

/** Neue Option (Farbe zyklisch); gibt es den Namen schon, dessen ID. */
export function addOption(store: WorkspaceStore, databaseID: string, propertyID: string, name: string, color?: string, statusGroup?: string): string | undefined {
  const p = store.databases.get(databaseID)?.properties.find((x) => x.id === propertyID);
  const trimmed = name.trim();
  if (!p || !trimmed) return undefined;
  const existing = p.options?.find((o) => o.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (existing) return existing.id;
  const palette = TEXT_COLORS.filter((c) => c !== "default");
  const option: SelectOption = { id: newID(), name: trimmed, color: color ?? palette[(p.options?.length ?? 0) % palette.length]! };
  updateProperty(store, databaseID, propertyID, (s) => {
    s.options = [...(s.options ?? []), option];
    if (s.type === "status" && s.statusGroups?.length) {
      const gi = Math.max(0, s.statusGroups.findIndex((g) => g.id === statusGroup));
      s.statusGroups[gi]!.optionIDs.push(option.id);
    }
  }, "Add option");
  return option.id;
}

export function updateOption(store: WorkspaceStore, databaseID: string, propertyID: string, optionID: string, f: (o: SelectOption) => void) {
  updateProperty(store, databaseID, propertyID, (s) => {
    const o = s.options?.find((x) => x.id === optionID);
    if (o) f(o);
  }, "Edit option");
}

/** Option löschen: Werte, Filter und Gruppen-Einstellungen, die sie nutzen, werden bereinigt. */
export function deleteOption(store: WorkspaceStore, databaseID: string, propertyID: string, optionID: string) {
  if (!store.databases.has(databaseID)) return;
  store.transact("Delete option", (tx) => {
    for (const v of [...store.views.values()]) {
      if (v.databaseID !== databaseID) continue;
      const nv = structuredClone(v);
      forgetOption(nv, optionID, propertyID);
      if (JSON.stringify(nv) !== JSON.stringify(v)) tx.put({ kind: "view", data: nv });
    }
    updProp(tx, store, databaseID, propertyID, (p) => {
      if (p.options) p.options = p.options.filter((o) => o.id !== optionID);
      for (const g of p.statusGroups ?? []) g.optionIDs = g.optionIDs.filter((x) => x !== optionID);
    });
    for (const r of allRows(store, databaseID)) {
      const c = caseOf(r.values?.[propertyID]);
      if ((c?.[0] === "select" || c?.[0] === "status") && c[1] === optionID) tx.update(r.id, (b) => setRowValue(b, propertyID, null));
      else if (c?.[0] === "multiSelect" && (c[1] as string[]).includes(optionID)) {
        const rest = (c[1] as string[]).filter((x) => x !== optionID);
        tx.update(r.id, (b) => setRowValue(b, propertyID, rest.length ? pv("multiSelect", rest) : null));
      }
    }
  });
}

// MARK: Ansichten

function viewDefaults(v: DatabaseView, db: Database) {
  const statusOrSelect = db.properties.find((p) => p.type === "status") ?? db.properties.find((p) => p.type === "select");
  switch (v.type) {
    case "board": if (statusOrSelect) v.groupBy = { propertyID: statusOrSelect.id }; break;
    case "calendar": case "timeline": { const d = db.properties.find((p) => p.type === "date"); if (d) v.datePropertyID = d.id; break; }
    case "gallery": v.cardCover = { pageContent: {} }; break;
    case "map": { const p = db.properties.find((x) => x.type === "place"); if (p) v.mapPropertyID = p.id; break; }
    case "chart": {
      const x = statusOrSelect ?? db.properties.find((p) => ["multiSelect", "checkbox", "date"].includes(p.type));
      v.chart = { kind: x ? "bar" : "number", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false, ...(x ? { xPropertyID: x.id } : {}) };
      if (!x && v.widgetOf) v.name = "Total";
      break;
    }
  }
}

/** Neue Ansicht (Tab) eines Datenbank-Blocks; legt fehlende Status-/Datums-/Ort-Properties an wie Notion. */
export function addView(store: WorkspaceStore, blockID: string, type: string, name?: string): string | undefined {
  const b = store.blocks.get(blockID);
  const dbID = b?.props?.databaseID;
  const db = dbID ? store.databases.get(dbID) : undefined;
  if (!b || !db) return undefined;
  if (type === "dashboard") return addDashboard(store, blockID, db, name);
  const existing = viewsForBlock(store, blockID);
  const v = newView(store, db.id, blockID, name ?? defaultViewName(type), type, keyBetween(existing[existing.length - 1]?.sortKey, undefined));
  viewDefaults(v, db);
  return store.transact("Add view", (tx) => {
    if (type === "map" && !v.mapPropertyID) {
      const p = newProperty(uniquePropertyName("Place", db), "place");
      updDB(tx, store, db.id, (d) => { d.properties.push(p); });
      v.mapPropertyID = p.id;
    }
    if ((type === "calendar" || type === "timeline") && !v.datePropertyID) {
      const p = newProperty(uniquePropertyName("Date", db), "date");
      updDB(tx, store, db.id, (d) => { d.properties.push(p); });
      v.datePropertyID = p.id;
    }
    if (type === "board" && !v.groupBy) {
      const p = makeProperty(uniquePropertyName("Status", db), "status");
      updDB(tx, store, db.id, (d) => { d.properties.push(p); });
      v.groupBy = { propertyID: p.id };
    }
    tx.put({ kind: "view", data: v });
    tx.update(blockID, (x) => { x.props = { ...(x.props ?? {}), viewIDs: [...(x.props?.viewIDs ?? []), v.id] }; });
    return v.id;
  });
}

/** Widget-Ansicht eines Dashboards (kein Tab) mit Vorgaben je Typ. */
export function makeWidgetView(store: WorkspaceStore, dashboard: DatabaseView, type: string, db: Database, name?: string): DatabaseView {
  const v = newView(store, db.id, dashboard.blockID, name ?? defaultViewName(type), type, "a0");
  v.widgetOf = dashboard.id;
  viewDefaults(v, db);
  return v;
}

function addDashboard(store: WorkspaceStore, blockID: string, db: Database, name?: string): string {
  const existing = viewsForBlock(store, blockID);
  const dash = newView(store, db.id, blockID, name ?? "Dashboard", "dashboard", keyBetween(existing[existing.length - 1]?.sortKey, undefined));
  const total = makeWidgetView(store, dash, "chart", db, "Total");
  total.chart = { kind: "number", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false };
  const groupName = db.properties.find((p) => p.type === "status" || p.type === "select")?.name ?? "group";
  const chart = makeWidgetView(store, dash, "chart", db, "By " + groupName);
  const table = makeWidgetView(store, dash, "table", db, richPlain(db.title) || "Table");
  let config: DashboardConfig = { rows: [] };
  config = dashboardInsert(config, total.id, undefined, true);
  const withChart = chart.chart?.kind !== "number";
  if (withChart) config = dashboardInsert(config, chart.id, 0, false);
  config = dashboardInsert(config, table.id, undefined, true);
  dash.dashboard = config;
  const widgets = withChart ? [total, chart, table] : [total, table];
  return store.transact("Add dashboard", (tx) => {
    for (const w of widgets) tx.put({ kind: "view", data: w });
    tx.put({ kind: "view", data: dash });
    tx.update(blockID, (x) => { x.props = { ...(x.props ?? {}), viewIDs: [...(x.props?.viewIDs ?? []), dash.id] }; });
    return dash.id;
  });
}

/** Ansicht ändern (ein Undo-Schritt). */
export function updateView(store: WorkspaceStore, viewID: string, f: (v: DatabaseView) => void, name = "Edit view", coalesce?: string) {
  if (!store.views.has(viewID)) return;
  store.transact(name, (tx) => updView(tx, store, viewID, f), coalesce ? { coalesce } : {});
}

export function renameView(store: WorkspaceStore, viewID: string, name: string) {
  const t = name.trim();
  if (!t) return;
  updateView(store, viewID, (v) => { v.name = t; }, "Rename view");
}

/** Layout wechseln (Table → Board …); ergänzt fehlende Vorgaben des neuen Typs. */
export function setViewType(store: WorkspaceStore, viewID: string, type: string) {
  const v = store.views.get(viewID);
  const db = v && store.databases.get(v.databaseID);
  if (!v || !db || v.type === type || type === "dashboard" || v.type === "dashboard") return;
  updateView(store, viewID, (x) => {
    x.type = type;
    const probe = structuredClone(x);
    viewDefaults(probe, db);
    if (type === "board" && !x.groupBy && probe.groupBy) x.groupBy = probe.groupBy;
    if ((type === "calendar" || type === "timeline") && !x.datePropertyID && probe.datePropertyID) x.datePropertyID = probe.datePropertyID;
    if (type === "gallery" && !x.cardCover && probe.cardCover) x.cardCover = probe.cardCover;
    if (type === "chart" && !x.chart && probe.chart) x.chart = probe.chart;
    if (type === "map" && !x.mapPropertyID && probe.mapPropertyID) x.mapPropertyID = probe.mapPropertyID;
  }, "Change layout");
}

/** Ansicht löschen (die letzte eines Blocks bleibt); ein Dashboard nimmt seine Widgets mit. */
export function deleteView(store: WorkspaceStore, viewID: string) {
  const v = store.views.get(viewID);
  if (!v) return;
  if (v.widgetOf) return removeDashboardWidget(store, v.widgetOf, viewID);
  if (viewsForBlock(store, v.blockID).length <= 1) return;
  const widgets = dashboardWidgetIDs(v.dashboard);
  store.transact("Delete view", (tx) => {
    tx.remove(keyOf("view", viewID));
    for (const w of widgets) if (store.views.has(w)) tx.remove(keyOf("view", w));
    tx.update(v.blockID, (b) => { if (b.props?.viewIDs) b.props.viewIDs = b.props.viewIDs.filter((x) => x !== viewID); });
  });
}

/** Kopie direkt hinter dem Original („Name (1)“). */
export function duplicateView(store: WorkspaceStore, viewID: string): string | undefined {
  const v = store.views.get(viewID);
  if (!v) return undefined;
  const list = viewsForBlock(store, v.blockID);
  const i = list.findIndex((x) => x.id === viewID);
  const copy = structuredClone(v);
  copy.id = newID();
  copy.name = v.name + " (1)";
  copy.sortKey = keyBetween(v.sortKey, list[i + 1]?.sortKey);
  copy.stamp = { ...ZERO_STAMP };
  const widgets: DatabaseView[] = [];
  if (copy.dashboard) {
    // Widgets gehören genau einem Dashboard: die Kopie bekommt eigene.
    const map = new Map<string, string>();
    for (const w of dashboardWidgetIDs(copy.dashboard)) {
      const src = store.views.get(w);
      if (!src) continue;
      const nw = structuredClone(src);
      nw.id = newID();
      nw.widgetOf = copy.id;
      map.set(w, nw.id);
      widgets.push(nw);
    }
    for (const row of copy.dashboard.rows) for (const w of row.widgets) w.viewID = map.get(w.viewID) ?? w.viewID;
  }
  return store.transact("Duplicate view", (tx) => {
    for (const w of widgets) tx.put({ kind: "view", data: w });
    tx.put({ kind: "view", data: copy });
    tx.update(v.blockID, (b) => { b.props = { ...(b.props ?? {}), viewIDs: [...(b.props?.viewIDs ?? []), copy.id] }; });
    return copy.id;
  });
}

/** Tab umsortieren: vor `before` (oder ans Ende). */
export function moveView(store: WorkspaceStore, viewID: string, before?: string) {
  const v = store.views.get(viewID);
  if (!v) return;
  const list = viewsForBlock(store, v.blockID).filter((x) => x.id !== viewID);
  let i = before ? list.findIndex((x) => x.id === before) : list.length;
  if (i < 0) i = list.length;
  const sk = keyBetween(list[i - 1]?.sortKey, list[i]?.sortKey);
  updateView(store, viewID, (x) => { x.sortKey = sk; }, "Move view");
}

function fullPropertyList(v: DatabaseView, db: Database): ViewProperty[] {
  const visible = new Set(visiblePropertyIDs(v, db));
  const list: ViewProperty[] = v.properties ? structuredClone(v.properties) : db.properties.map((p) => ({ id: p.id, visible: visible.has(p.id) }));
  for (const p of db.properties) if (!list.some((x) => x.id === p.id)) list.push({ id: p.id, visible: visible.has(p.id) });
  return list;
}

/** Property in einer Ansicht zeigen/verstecken (der Titel bleibt immer sichtbar). */
export function setPropertyVisible(store: WorkspaceStore, viewID: string, propertyID: string, visible: boolean) {
  const v = store.views.get(viewID);
  const db = v && store.databases.get(v.databaseID);
  if (!v || !db) return;
  updateView(store, viewID, (view) => {
    const list = fullPropertyList(v, db);
    const item = list.find((x) => x.id === propertyID);
    if (item) item.visible = visible;
    view.properties = list;
  }, visible ? "Show property" : "Hide property");
}

/** Alle Properties einer Ansicht zeigen oder (bis auf den Titel) verstecken. */
export function setAllPropertiesVisible(store: WorkspaceStore, viewID: string, visible: boolean) {
  const v = store.views.get(viewID);
  const db = v && store.databases.get(v.databaseID);
  if (!v || !db) return;
  const title = titleProperty(db).id;
  updateView(store, viewID, (view) => {
    view.properties = fullPropertyList(v, db).map((x) => ({ ...x, visible: x.id === title ? true : visible }));
  }, visible ? "Show all" : "Hide all");
}

/** Property in der Reihenfolge der Ansicht an `index` verschieben. */
export function movePropertyInView(store: WorkspaceStore, viewID: string, propertyID: string, index: number) {
  const v = store.views.get(viewID);
  const db = v && store.databases.get(v.databaseID);
  if (!v || !db) return;
  updateView(store, viewID, (view) => {
    const list = fullPropertyList(v, db);
    const from = list.findIndex((x) => x.id === propertyID);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, item!);
    view.properties = list;
  }, "Move property");
}

/** Spaltenbreite (beim Ziehen zu einem Undo-Schritt zusammengefasst). */
export function setColumnWidth(store: WorkspaceStore, viewID: string, propertyID: string, width: number) {
  const v = store.views.get(viewID);
  const db = v && store.databases.get(v.databaseID);
  if (!v || !db) return;
  updateView(store, viewID, (view) => {
    const list = view.properties ? structuredClone(view.properties) : fullPropertyList(v, db);
    const item = list.find((x) => x.id === propertyID);
    if (item) item.width = width;
    else list.push({ id: propertyID, visible: true, width });
    view.properties = list;
  }, "Resize column", `width:${viewID}:${propertyID}`);
}

export function setSorts(store: WorkspaceStore, viewID: string, sorts: SortRule[]) {
  updateView(store, viewID, (v) => { if (sorts.length) v.sorts = sorts; else delete v.sorts; }, "Sort");
}

export function setFilter(store: WorkspaceStore, viewID: string, filter: FilterGroup | undefined) {
  updateView(store, viewID, (v) => { if (filter && filter.items.length) v.filter = filter; else delete v.filter; }, "Filter");
}

export function setGroupBy(store: WorkspaceStore, viewID: string, rule: GroupRule | undefined) {
  updateView(store, viewID, (v) => { if (rule) v.groupBy = rule; else delete v.groupBy; }, "Group");
}

/** Gruppe ein-/ausblenden. */
export function setGroupHidden(store: WorkspaceStore, viewID: string, groupID: string, hidden: boolean) {
  updateView(store, viewID, (v) => {
    if (!v.groupBy) return;
    const rest = (v.groupBy.hiddenGroups ?? []).filter((x) => x !== groupID);
    if (hidden) rest.push(groupID);
    if (rest.length) v.groupBy.hiddenGroups = rest;
    else delete v.groupBy.hiddenGroups;
  }, hidden ? "Hide group" : "Show group");
}

export function setCalculation(store: WorkspaceStore, viewID: string, propertyID: string, fn: string) {
  updateView(store, viewID, (v) => {
    const calc = { ...(v.calculations ?? {}) };
    if (fn === "none") delete calc[propertyID];
    else calc[propertyID] = fn;
    if (Object.keys(calc).length) v.calculations = calc;
    else delete v.calculations;
  }, "Calculate");
}

export function updateChart(store: WorkspaceStore, viewID: string, f: (c: ChartConfig) => void) {
  updateView(store, viewID, (v) => {
    const c: ChartConfig = v.chart ? v.chart : { kind: "bar", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false };
    f(c);
    v.chart = c;
  }, "Edit chart");
}

// MARK: Dashboard (Swift DashboardConfig, rein)

export function dashboardWidgetIDs(c: DashboardConfig | undefined): string[] {
  return c ? c.rows.flatMap((r) => r.widgets.map((w) => w.viewID)) : [];
}

/** 12 Spalten gleichmäßig verteilen (Rest an die ersten Widgets). */
export function evenWidths(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(DASHBOARD_COLUMNS / n), extra = DASHBOARD_COLUMNS % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
const widget = (viewID: string, width = DASHBOARD_COLUMNS) => ({ id: newID(), viewID, width });
const spread = (row: DashboardConfig["rows"][number]) => { const w = evenWidths(row.widgets.length); row.widgets.forEach((x, i) => { x.width = w[i]!; }); };

/** Widget in neue Zeile (`rowIndex` fehlt/voll) oder neben die Widgets von Zeile `rowIndex`. */
export function dashboardInsert(config: DashboardConfig, viewID: string, rowIndex: number | undefined, newRow: boolean): DashboardConfig {
  const c = structuredClone(config);
  const r = rowIndex !== undefined ? c.rows[rowIndex] : undefined;
  if (!newRow && r && r.widgets.length < DASHBOARD_MAX_WIDGETS_PER_ROW) {
    r.widgets.push(widget(viewID));
    spread(r);
  } else {
    const row = { id: newID(), widgets: [widget(viewID)] };
    const at = rowIndex === undefined ? undefined : newRow ? rowIndex : rowIndex + 1;
    if (at !== undefined && at >= 0 && at <= c.rows.length) c.rows.splice(at, 0, row);
    else c.rows.push(row);
  }
  return c;
}

export function dashboardRemove(config: DashboardConfig, viewID: string): DashboardConfig {
  const c = structuredClone(config);
  for (let r = c.rows.length - 1; r >= 0; r--) {
    const row = c.rows[r]!;
    const i = row.widgets.findIndex((w) => w.viewID === viewID);
    if (i < 0) continue;
    row.widgets.splice(i, 1);
    if (row.widgets.length === 0) c.rows.splice(r, 1);
    else spread(row);
  }
  return c;
}

/** Breite 1…12; der Nachbar rechts (sonst links) gleicht aus, die Zeile bleibt bei 12 Spalten. */
export function dashboardSetWidth(config: DashboardConfig, viewID: string, width: number): DashboardConfig {
  const c = structuredClone(config);
  for (const row of c.rows) {
    const i = row.widgets.findIndex((w) => w.viewID === viewID);
    if (i < 0) continue;
    const n = row.widgets.length;
    if (n === 1) { row.widgets[i]!.width = DASHBOARD_COLUMNS; break; }
    const j = i + 1 < n ? i + 1 : i - 1;
    const pair = row.widgets[i]!.width + row.widgets[j]!.width;
    const w = Math.min(Math.max(1, width), pair - 1);
    row.widgets[i]!.width = w;
    row.widgets[j]!.width = pair - w;
    break;
  }
  return c;
}

/** Widget in Zeile `toRow` an `index` (oder als neue Zeile bei `toRow`) verschieben. */
export function dashboardMove(config: DashboardConfig, viewID: string, toRow: number, index?: number, newRow = false): DashboardConfig {
  let c = structuredClone(config);
  const from = c.rows.findIndex((r) => r.widgets.some((w) => w.viewID === viewID));
  if (from < 0) return c;
  const sourceID = c.rows[from]!.id;
  const destID = c.rows[toRow]?.id;
  if (!newRow && destID === sourceID && index !== undefined) {
    const ws = c.rows[from]!.widgets;
    const cur = ws.findIndex((w) => w.viewID === viewID);
    const [w] = ws.splice(cur, 1);
    ws.splice(Math.min(Math.max(0, index > cur ? index - 1 : index), ws.length), 0, w!);
    return c;
  }
  if (!newRow && destID !== undefined && c.rows.find((r) => r.id === destID)!.widgets.length >= DASHBOARD_MAX_WIDGETS_PER_ROW) return c;
  c = dashboardRemove(c, viewID);
  if (newRow || destID === undefined) {
    c.rows.splice(Math.min(Math.max(0, toRow), c.rows.length), 0, { id: newID(), widgets: [widget(viewID)] });
  } else {
    const dest = c.rows.find((r) => r.id === destID);
    if (dest) {
      dest.widgets.splice(Math.min(Math.max(0, index ?? dest.widgets.length), dest.widgets.length), 0, widget(viewID));
      spread(dest);
    }
  }
  return c;
}

/** Widget hinzufügen (Standard: Datenbank des Dashboards); neue Zeile oder neben `rowIndex`. */
export function addDashboardWidget(store: WorkspaceStore, dashboardID: string, type: string, opts: { databaseID?: string; rowIndex?: number; newRow?: boolean } = {}): string | undefined {
  const dash = store.views.get(dashboardID);
  const db = dash && store.databases.get(opts.databaseID ?? dash.databaseID);
  if (!dash || dash.type !== "dashboard" || !WIDGET_TYPES.includes(type) || !db) return undefined;
  const w = makeWidgetView(store, dash, type, db);
  return store.transact("Add widget", (tx) => {
    tx.put({ kind: "view", data: w });
    updView(tx, store, dashboardID, (v) => { v.dashboard = dashboardInsert(v.dashboard ?? { rows: [] }, w.id, opts.rowIndex, opts.newRow ?? true); });
    return w.id;
  });
}

export function removeDashboardWidget(store: WorkspaceStore, dashboardID: string, viewID: string) {
  if (!store.views.has(dashboardID)) return;
  store.transact("Remove widget", (tx) => {
    updView(tx, store, dashboardID, (v) => { if (v.dashboard) v.dashboard = dashboardRemove(v.dashboard, viewID); });
    if (store.views.has(viewID)) tx.remove(keyOf("view", viewID));
  });
}

export function setDashboardWidgetWidth(store: WorkspaceStore, dashboardID: string, viewID: string, width: number) {
  updateView(store, dashboardID, (v) => { if (v.dashboard) v.dashboard = dashboardSetWidth(v.dashboard, viewID, width); }, "Resize widget");
}

export function moveDashboardWidget(store: WorkspaceStore, dashboardID: string, viewID: string, toRow: number, index?: number, newRow = false) {
  updateView(store, dashboardID, (v) => { if (v.dashboard) v.dashboard = dashboardMove(v.dashboard, viewID, toRow, index, newRow); }, "Move widget");
}

export function setDashboardRowHeight(store: WorkspaceStore, dashboardID: string, rowID: string, height: number | undefined) {
  updateView(store, dashboardID, (v) => {
    const r = v.dashboard?.rows.find((x) => x.id === rowID);
    if (!r) return;
    if (height === undefined) delete r.height;
    else r.height = height;
  }, "Resize row");
}
