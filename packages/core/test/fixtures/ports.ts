// BSD-149/151: Welche Module im TS-Kern schon portiert sind. Ein Port bekommt die Eingabe eines Falls und die
// Datei-Metadaten (z. B. Records, `now`) und liefert die Ausgabe im Fixture-Format. Nicht eingetragene Module
// werden übersprungen und im Bericht als „nicht portiert“ geführt.
import { compareStamps, isValidKey, keyBetween, keysBetween, keyOf, MemoryPersistence, parseRecord, parseStamp, plainText, StampClock, stampToString, WorkspaceStore } from "../../src/index.js";
import type { RecordKeyString, Value, WireRecord } from "../../src/index.js";
import { conversionLoss, fold, SearchCorpus, Formula, FormulaError, propertyConversion, QueryEngine, rowsOf, schema } from "../../src/index.js";
import type { DatabaseView, SearchFilters, SearchSort } from "../../src/index.js";
import { ClipboardHTMLImporter, HTMLExporter, importedJSON, titleOf } from "../../src/index.js";
import type { Stamp } from "../../src/hlc.js";
import type { FixtureCase } from "./load.js";

export type Port = (input: FixtureCase["input"], meta: Record<string, unknown>) => unknown;

type HlcInput =
  | { op: "compare"; a: Stamp; b: Stamp }
  | { op: "description"; stamp: Stamp }
  | { op: "parse"; text: string }
  | { op: "clock"; node: string; last: Stamp; maxDrift: number; steps: ({ op: "now"; wall: number } | { op: "observe"; wall: number; remote: Stamp })[] };

type SortKeysInput =
  | { op: "between"; a: string | null; b: string | null }
  | { op: "isValid"; key: string }
  | { op: "keys"; count: number; a: string | null; b: string | null };

const hlc: Port = (raw) => {
  const input = raw as HlcInput;
  switch (input.op) {
    case "compare": return compareStamps(input.a, input.b);
    case "description": return stampToString(input.stamp);
    case "parse": return parseStamp(input.text) ?? null;
    case "clock": {
      if (input.maxDrift !== StampClock.maxDrift) throw new Error("maxDrift weicht ab");
      const clock = new StampClock(input.node, input.last);
      return input.steps.map((s) => {
        clock.wallClock = () => s.wall;
        if (s.op === "now") return { result: clock.now() };
        const result = clock.observe(s.remote);
        return { result, current: clock.current };
      });
    }
  }
};

const sortkeys: Port = (raw) => {
  const input = raw as SortKeysInput;
  switch (input.op) {
    case "between": return keyBetween(input.a, input.b);
    case "isValid": return isValidKey(input.key);
    case "keys": return keysBetween(input.count, input.a, input.b);
  }
};

type MergeStep = { records: unknown[]; deletions: { kind: "block"; id: string; stamp: Stamp | null }[] };

const merge: Port = (raw) => {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => 0 });
  store.clock.wallClock = () => 1;
  return (raw as MergeStep[]).map((step) => {
    const stamps = new Map<RecordKeyString, Stamp>();
    for (const d of step.deletions) if (d.stamp) stamps.set(keyOf(d.kind, d.id), d.stamp);
    const r = store.applyRemote(step.records.map(parseRecord), step.deletions.map((d) => keyOf(d.kind, d.id)), stamps);
    const blocks: Record<string, unknown> = {};
    for (const id of [...store.blocks.keys()].sort()) {
      const b = store.blocks.get(id)!;
      blocks["block:" + id] = { stamp: b.stamp, title: plainText(b.text) };
    }
    return { stale: [...r.stale].sort(), tombstoned: Object.fromEntries(r.tombstoned), blocks };
  });
};

type UndoStep =
  | { op: "setText"; id: string; text: string }
  | { op: "delete"; ids: string[] }
  | { op: "remote"; record: unknown }
  | { op: "remoteDelete"; id: string; stamp: Stamp }
  | { op: "undo" | "redo" };

const undoRemote: Port = (raw, meta) => {
  const records = (meta.records as unknown[]).map(parseRecord) as WireRecord[];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "local", now: () => 0 });
  let wall = 2000;
  store.clock.wallClock = () => wall;
  store.clearUndoHistory();
  return (raw as UndoStep[]).map((s) => {
    wall += 10;
    let result: unknown = null;
    switch (s.op) {
      case "setText": store.setText(s.id, s.text); break;
      case "delete": store.deleteBlocks(s.ids); break;
      case "remote": store.applyRemote([parseRecord(s.record)]); break;
      case "remoteDelete": store.applyRemote([], [keyOf("block", s.id)], new Map([[keyOf("block", s.id), s.stamp]])); break;
      default: result = s.op === "undo" ? store.undo() : store.redo();
    }
    const blocks: Record<string, unknown> = {};
    for (const id of ["l1", "l2", "l3"]) {
      const b = store.blocks.get(id);
      blocks[id] = b ? { text: plainText(b.text), trashed: b.trashedAt !== undefined, parent: b.parent } : null;
    }
    return { result, blocks, canUndo: store.canUndo, canRedo: store.canRedo };
  });
};

/** Wert im Fixture-Format: nicht endliche Zahlen als Text wie Swift `String(Double)`. */
export function valueJSON(v: Value): unknown {
  switch (v.t) {
    case "number": return Number.isFinite(v.v) ? v : { t: "number", v: Number.isNaN(v.v) ? "nan" : v.v > 0 ? "inf" : "-inf" };
    case "list": return { t: "list", v: v.v.map(valueJSON) };
    default: return v;
  }
}

const formulas: Port = (raw, meta) => {
  const env = meta.env as { props: Record<string, Value>; now: number; currentPage: string };
  try {
    const v = Formula.evaluate((raw as { source: string }).source, {
      prop: (name) => {
        const v = env.props[name];
        if (!v) throw new FormulaError(`Property “${name}” not found`);
        return v;
      },
      pageTitle: (id) => "Titel " + id,
      personName: (id) => "Name " + id,
      personEmail: (id) => id + "@example.com",
      currentPage: env.currentPage,
      now: env.now / 1000 - 978_307_200,
    });
    return valueJSON(v);
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    throw e;
  }
};

function queryStore(meta: Record<string, unknown>) {
  const records = (meta.records as unknown[]).map(parseRecord) as WireRecord[];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "fx" });
  return { store, engine: new QueryEngine(store, { now: (meta.now as number) / 1000 - 978_307_200 }) };
}

const queries: Port = (raw, meta) => {
  const { engine } = queryStore(meta);
  const input = raw as { view: unknown; search: string | null };
  const r = engine.run(schema.databaseView.parse(input.view) as DatabaseView, input.search);
  const out: Record<string, unknown> = { rows: r.rows.map((b) => b.id) };
  if (r.groups) out.groups = r.groups.map((g) => ({ id: g.id, title: g.title, color: g.color, rows: g.rows.map((b) => b.id) }));
  return out;
};

const CALCULATIONS = ["countAll", "countValues", "countUnique", "countEmpty", "countNotEmpty", "percentEmpty", "percentNotEmpty", "sum", "average",
  "median", "min", "max", "range", "earliest", "latest", "dateRange", "checked", "unchecked", "percentChecked", "percentUnchecked", "showOriginal"];

const values: Port = (raw, meta) => {
  const { store, engine } = queryStore(meta);
  const input = raw as { op: "values"; database: string; row: string } | { op: "aggregate"; database: string; property: string };
  const db = store.databases.get(input.database)!;
  if (input.op === "values") {
    const row = store.blocks.get(input.row)!;
    return Object.fromEntries(db.properties.map((p) => [p.id, valueJSON(engine.value(row, p, db))]));
  }
  const p = db.properties.find((x) => x.id === input.property)!;
  const rows = rowsOf(store, db.id);
  return Object.fromEntries(CALCULATIONS.map((fn) => [fn, valueJSON(QueryEngine.aggregate(rows.map((r) => engine.value(r, p, db)), fn, p))]));
};

const conversion: Port = (raw, meta) => {
  const { store } = queryStore(meta);
  const input = raw as { database: string; property: string; to: string };
  const old = store.databases.get(input.database)!.properties.find((p) => p.id === input.property)!;
  let n = 0;
  const plan = propertyConversion(store, input.database, input.property, input.to, () => `tmp-${n++}`)!;
  const rename = new Map<string, string>();
  for (const o of plan.schema.options ?? []) if (!(old.options ?? []).some((x) => x.id === o.id)) rename.set(o.id, "new:" + o.name);
  for (const g of plan.schema.statusGroups ?? []) if (!(old.statusGroups ?? []).some((x) => x.id === g.id)) rename.set(g.id, "group:" + g.name);
  const norm = (v: unknown): unknown =>
    typeof v === "string" ? rename.get(v) ?? v : Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
  return {
    schema: norm(plan.schema),
    values: Object.fromEntries([...plan.values].map(([k, v]) => [k, v === null ? null : norm(v)])),
    lossCells: conversionLoss(store, input.database, input.property, input.to),
  };
};

const search: Port = (raw, meta) => {
  const { store } = queryStore(meta);
  const input = raw as { query: string; filters: SearchFilters; sort: SearchSort; limit: number };
  const corpus = new SearchCorpus(store);
  const terms = fold(input.query.trim()).split(" ").filter(Boolean);
  return corpus.search(input.query, input.filters, input.sort, input.limit, (meta.now as number) / 1000 - 978_307_200).map((h) => {
    if (h.blockID === undefined) return { pageID: h.pageID, score: h.score, snippet: h.snippet ?? null };
    const candidates = corpus.contents.filter((e) => e.page === h.pageID && terms.every((t) => e.folded.includes(t))).map((e) => e.blockID).sort();
    if (!candidates.includes(h.blockID)) throw new Error(`Snippet-Block ${h.blockID} passt nicht`);
    return { pageID: h.pageID, score: h.score, snippetBlocks: candidates };
  });
};

const clipboard: Port = (raw, meta) => {
  const input = raw as { op: "parse"; html: string } | { op: "export"; page: string };
  if (input.op === "parse") {
    const known = new Set(meta.resolvePage as string[]);
    const importer = new ClipboardHTMLImporter(ClipboardHTMLImporter.pageResolver((id) => known.has(id)));
    return { isStructured: ClipboardHTMLImporter.isStructured(input.html), blocks: importer.parse(input.html).map(importedJSON) };
  }
  const { store } = queryStore(meta);
  const exporter = new HTMLExporter(store, { headingOffset: 0, pageLink: (id) => ({ title: titleOf(store, id), url: `based://page/${id}` }) });
  const html = exporter.blocks(exporter.contentBlocks(input.page));
  return { html, reparsed: new ClipboardHTMLImporter().parse(html).map(importedJSON) };
};

export const PORTS: Record<string, Port | undefined> = { hlc, sortkeys, merge, "undo-remote": undoRemote, formulas, queries, values, conversion, search, clipboard };
