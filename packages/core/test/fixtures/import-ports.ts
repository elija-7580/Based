// BSD-156: Ports für die Golden Fixtures von Import und Export (fixtures/import, export, archive).
import { canonicalStringify, MemoryPersistence, parseRecord, WorkspaceStore } from "../../src/index.js";
import type { ImportReport, WireRecord } from "../../src/index.js";
import { commitImport, contentFingerprint, ImportBuilder, makeBlock } from "../../src/index.js";
import type { Port } from "./ports.js";

const swiftNow = () => (Date.now() - 978_307_200_000) / 1000;

export function reportJSON(r: ImportReport) {
  return { pages: r.pages, databases: r.databases, rows: r.rows, assets: r.assets, warnings: r.warnings, rootIDs: r.rootIDs,
    keptLocalChanges: r.keptLocalChanges, keptLocalAdditions: r.keptLocalAdditions };
}

/** Wie `ImportFixtures.dump`: Records außer Workspace, sortiert (database, view, block; id), ohne stamp, Zeiten ab `since` → "now". */
export function dump(store: WorkspaceStore, since: number): unknown[] {
  const limit = since - 1;
  const norm = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (k !== "stamp" && x !== undefined) out[k] = norm(x, k);
      return out;
    }
    if (typeof v === "number" && key && ["createdAt", "updatedAt", "trashedAt"].includes(key) && v >= limit) return "now";
    return v;
  };
  const rank: Record<string, number> = { database: 0, view: 1, block: 2 };
  const records = store.allRecords().filter((r) => r.kind !== "workspace")
    .sort((a, b) => (rank[a.kind]! - rank[b.kind]!) || (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0));
  // Über JSON, damit Zahlen und Schlüssel wie im Fixture verglichen werden.
  return records.map((r) => norm(JSON.parse(canonicalStringify(r))));
}

// MARK: reimport

type ReimportOp =
  | { op: "commit"; texts: Record<string, string>; subPage: boolean; nested: Record<string, Record<string, string>>; nestedPage: number | null }
  | { op: "setText"; n: number; text: string }
  | { op: "insert"; id: string; parent: number | null; text: string }
  | { op: "strip"; ns: number[] }
  | { op: "undo" };

const page = "11111111-0000-0000-0000-000000000001", sub = "11111111-0000-0000-0000-000000000002";
const nid = (n: number | string) => "22222222-0000-0000-0000-" + String(n).padStart(12, "0");
const T0 = 784_000_000;

export const reimport: Port = (raw) => {
  if (!Array.isArray(raw)) return (raw as { records: unknown[] }).records.map((r) => contentFingerprint((parseRecord(r) as Extract<WireRecord, { kind: "block" }>).data));
  const start = swiftNow();
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "fx" });
  return (raw as ReimportOp[]).map((op) => {
    let result: unknown = null;
    switch (op.op) {
      case "commit": {
        const b = new ImportBuilder();
        b.add(makeBlock({ id: page, type: "page", parent: "w", sk: "", text: "Notes", createdAt: T0 }, T0), true);
        for (const n of Object.keys(op.texts).map(Number).sort((x, y) => x - y)) {
          b.append("text", "b:" + page, { id: nid(n), text: op.texts[n]!, createdAt: T0 });
          for (const [m, t] of Object.entries(op.nested[n] ?? {}).sort((x, y) => Number(x[0]) - Number(y[0]))) {
            b.append("text", "b:" + nid(n), { id: nid(m), text: t, createdAt: T0 });
          }
          if (op.nestedPage === n) b.append("page", "b:" + nid(n), { id: sub, text: "Inside", createdAt: T0 });
          b.markComplete("b:" + nid(n));
        }
        if (op.subPage) b.append("page", "b:" + page, { id: sub, text: "Sub", createdAt: T0 });
        b.markComplete("b:" + page);
        result = reportJSON(commitImport(store, b));
        break;
      }
      case "setText": store.setText(nid(op.n), op.text); break;
      case "insert": {
        const parent = "b:" + (op.parent === null ? page : nid(op.parent));
        store.transact("Insert", (tx) => tx.put({ kind: "block", data: makeBlock({ id: op.id, type: "text", parent, sk: "zz", text: op.text }, store.now()) }));
        break;
      }
      case "strip":
        store.transact("strip", (tx) => { for (const n of op.ns) tx.update(nid(n), (x) => { delete (x as Record<string, unknown>).importFingerprint; }); }, { undoable: false });
        break;
      case "undo": store.undo(); break;
    }
    return { result, records: dump(store, start) };
  });
};


// MARK: import (Notion-HTML, Markdown/CSV, Hilfen)

import { cleanTitle, columnRatio, decodeCSV, decodeInlineMarkdown, derivedID, encodeCSV, encodeInlineMarkdown, ImportFiles, importNotionItems,
  inferCSVType, MarkdownImporter, MemoryAssetSink, notionIDInName, notionUUID, toRichText } from "../../src/index.js";
import type { ImportSource, RichText } from "../../src/index.js";

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
type FileIn = { path: string; text?: string; base64?: string };

function importFiles(files: FileIn[]): ImportFiles {
  const f = new ImportFiles();
  f.addDirectory("in");
  for (const x of files) f.add("in/" + x.path, x.text !== undefined ? new TextEncoder().encode(x.text) : new Uint8Array(Buffer.from(x.base64!, "base64")));
  return f;
}

const fixtureSink = () => new MemoryAssetSink((data, name) => derivedID("asset", name, b64(data)));

/** Wie `ImportFixtures.canonical`: zufällige IDs in Baum-Reihenfolge umbenennen. */
export function canonical(store: WorkspaceStore, json: unknown[]): unknown[] {
  const map = new Map<string, string>();
  const n = { b: 0, db: 0, v: 0, p: 0, o: 0, g: 0 };
  const visit = (parent: string) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b) continue;
      map.set(id, `b${++n.b}`);
      visit("b:" + id);
      const dbID = b.props?.databaseID;
      const db = dbID !== undefined ? store.databases.get(dbID) : undefined;
      if (db && dbID !== undefined && db.blockID === id && !map.has(dbID)) {
        map.set(dbID, `db${++n.db}`);
        for (const p of db.properties) {
          if (p.id === "title") continue;
          map.set(p.id, `p${++n.p}`);
          for (const o of p.options ?? []) map.set(o.id, `o${++n.o}`);
          for (const g of p.statusGroups ?? []) map.set(g.id, `g${++n.g}`);
        }
        const key = (v: { sortKey: string; name: string; blockID: string }) => [v.sortKey, v.name, v.blockID];
        const views = [...store.views.values()].filter((v) => v.databaseID === dbID).sort((x, y) => {
          const a = key(x), c = key(y);
          for (let i = 0; i < 3; i++) if (a[i] !== c[i]) return a[i]! < c[i]! ? -1 : 1;
          return 0;
        });
        for (const v of views) map.set(v.id, `v${++n.v}`);
        visit("d:" + dbID);
      }
    }
  };
  visit("w");
  const rename = (s: string) => {
    const m = map.get(s);
    if (m !== undefined) return m;
    for (const prefix of ["b:", "d:"]) if (s.startsWith(prefix)) { const x = map.get(s.slice(2)); if (x !== undefined) return prefix + x; }
    return s;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return rename(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [rename(k), walk(x)]));
    return v;
  };
  const key = (r: unknown) => { const o = r as { kind: string; data: { id: string } }; return [o.kind, o.data.id] as const; };
  return (walk(json) as unknown[]).sort((a, b) => {
    const x = key(a), y = key(b);
    return x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });
}

function runImport(store: WorkspaceStore, files: ImportFiles, items: string[], sink = fixtureSink()) {
  const sources: ImportSource[] = items.map((i) => ({ files, path: i === "" ? "in" : "in/" + i }));
  return importNotionItems(store, sources, { assets: sink });
}

function helper(x: Record<string, unknown>): unknown {
  switch (x.op) {
    case "notion": return notionUUID(x.raw as string) ?? null;
    case "notionID": return notionIDInName(x.raw as string) ?? null;
    case "derived": return derivedID(...(x.parts as string[]));
    case "columnRatio": return columnRatio(x.raw as string) ?? null;
    case "cleanTitle": return cleanTitle(x.raw as string);
    case "decode": return decodeCSV(x.text as string);
    case "encode": return encodeCSV(x.rows as string[][]);
    case "inferType": return inferCSVType(x.name as string, x.column as string[]);
    default: return helper2(x);
  }
}
export let helper2: (x: Record<string, unknown>) => unknown = (x) => { throw new Error("unbekannte Hilfe " + String(x.op)); };
export const setHelper2 = (f: typeof helper2) => { helper2 = f; };

const importedJSONDeep = (b: { type: string; text: unknown; props: object; children: unknown[]; linkTarget?: string }): unknown => {
  const o: Record<string, unknown> = { type: b.type, text: toRichText(b.text as never), children: (b.children as never[]).map(importedJSONDeep) };
  if (Object.keys(b.props).filter((k) => (b.props as Record<string, unknown>)[k] !== undefined).length > 0) o.props = JSON.parse(JSON.stringify(b.props));
  if (b.linkTarget !== undefined) o.linkTarget = b.linkTarget;
  return o;
};

export const importPort: Port = (raw) => {
  const input = raw as Record<string, unknown>;
  if (input.op === "helpers") return (input.items as Record<string, unknown>[]).map(helper);
  if (input.op === "parse") {
    const resolveLink = (t: string) => (t === "Page.md" || t === "Sub%20Page%20abc.md" ? "page-1" : undefined);
    const importer = new MarkdownImporter({ resolveLink, resolveAsset: (src) => (src.startsWith("images/") ? { asset: { id: "asset-1", name: src.split("/").pop()! } } : { url: src }) });
    const md = input.markdown as string;
    const split = MarkdownImporter.splitTitle(md);
    return { blocks: importer.parse(md).map((b) => importedJSONDeep(b as never)), splitTitle: { title: split.title ?? null, body: split.body } };
  }
  if (input.op === "inline") {
    const resolveLink = (t: string) => (t === "Page.md" || t === "Sub%20Page%20abc.md" ? "page-1" : undefined);
    const pageLink = (id: string) => (id === "page-1" ? { title: "Page", url: "Page.md" } : undefined);
    return (input.items as { source?: string; rich?: RichText }[]).map((x) => {
      if (x.rich !== undefined) return { reencoded: encodeInlineMarkdown(x.rich, pageLink) };
      const rt = toRichText(decodeInlineMarkdown(x.source!, resolveLink));
      return { decoded: JSON.parse(JSON.stringify(rt)), reencoded: encodeInlineMarkdown(rt, pageLink) };
    });
  }
  const files = importFiles(input.files as FileIn[]);
  const start = swiftNow();
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "fx" });
  if (Array.isArray(input.steps)) {
    const homeID = "11111111-1111-1111-1111-111111111111";
    const steps: unknown[] = [];
    const snap = (r?: ImportReport) => {
      const o: Record<string, unknown> = { blockCount: store.blocks.size, homeTitle: richPlain(store.blocks.get(homeID)?.text), local: store.blocks.has("local-1") ? richPlain(store.blocks.get("local-1")!.text) : "-" };
      if (r) o.report = reportJSON(r);
      steps.push(o);
    };
    snap(runImport(store, files, [""]));
    store.transact("edit", (tx) => tx.update(homeID, (b) => { b.text = "Renamed"; }));
    store.transact("add", (tx) => tx.put({ kind: "block", data: makeBlock({ id: "local-1", type: "text", parent: "b:" + homeID, sk: "zz", text: "stale" }, store.now()) }));
    snap();
    snap(runImport(store, files, [""]));
    store.transact("undo rename", (tx) => tx.update(homeID, (b) => { b.text = "Home"; }));
    snap(runImport(store, files, [""]));
    return { steps, records: dump(store, start) };
  }
  const sink = fixtureSink();
  const out: Record<string, unknown> = {};
  try {
    const r = reportJSON(runImport(store, files, input.items as string[], sink)) as Record<string, unknown>;
    if (input.canonical) r.rootIDs = (r.rootIDs as unknown[]).length;
    out.report = r;
  } catch (e) {
    out.error = String(e);
  }
  const d = dump(store, start);
  out.records = input.canonical ? canonical(store, d) : d;
  out.assets = [...sink.files.keys()].sort();
  return out;
};

const richPlain = (t: RichText | undefined) => (t === undefined ? "" : typeof t === "string" ? t : t.map((r) => r.t ?? "").join(""));

// MARK: export

import { defaultHTMLPageLink, encodeExportPath, exportHTMLPage, HTMLExporter, MarkdownExporter, markdownFileName, planWorkspaceExport, relativeExportPath, topLevelPages } from "../../src/index.js";

export const exportPort: Port = (raw, meta) => {
  const input = raw as Record<string, unknown>;
  if (input.op === "helpers") {
    return (input.items as Record<string, unknown>[]).map((x) => {
      switch (x.op) {
        case "fileName": return markdownFileName(x.raw as string);
        case "relative": return relativeExportPath(x.dir as string, x.path as string);
        case "encode": return encodeExportPath(x.raw as string);
        default: throw new Error("?");
      }
    });
  }
  const records = ((input.set === "corpus" ? meta.records : meta.exportRecords) as unknown[]).map(parseRecord) as WireRecord[];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "fx" });
  switch (input.op) {
    case "markdown": return new MarkdownExporter(store).export(input.page as string);
    case "csv": return new MarkdownExporter(store).csv(input.database as string, (input.view as string | null) ?? undefined);
    case "html": return exportHTMLPage(new HTMLExporter(store, { pageLink: defaultHTMLPageLink(store) }), input.page as string);
    case "plan": {
      const available = new Set(meta.assetFiles as string[]);
      const plan = planWorkspaceExport(store, topLevelPages(store), input.format as "markdown" | "html");
      return { directories: plan.directories, files: plan.files, assets: plan.assets.map((a) => ({ path: a.path, name: a.name, page: a.page, available: available.has(a.ref.id) })) };
    }
  }
  throw new Error("?");
};

// MARK: archive

import { archiveAssetRefs, archiveEntryPath, assetRefForEntry, encodeArchive, importArchive, readArchive, sanitizedZipPath, writeArchive } from "../../src/index.js";

export const archivePort: Port = (raw, meta) => {
  const input = raw as Record<string, unknown>;
  const corpus = (meta.records as unknown[]).map(parseRecord) as WireRecord[];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(corpus), node: "fx" });
  const lines = (text: string) => text.split("\n").map((l, i) => {
    try { const v = JSON.parse(l) as Record<string, unknown>; if (i === 0) v.exportedAt = "EXPORTED"; return v; } catch { return l; }
  });
  switch (input.op) {
    case "write": return lines(writeArchive(store));
    case "package": {
      const records = store.allRecords();
      const refs = archiveAssetRefs(records);
      return { records: lines(encodeArchive(records, store.workspace.name, 2, refs.length)), assets: refs.map(archiveEntryPath).sort() };
    }
    case "assetRefs": return archiveAssetRefs(corpus).sort((a, b) => (a.id < b.id ? -1 : 1));
    case "helpers": return (input.items as { op: string; path: string }[]).map((x) => (x.op === "assetRef" ? assetRefForEntry(x.path) ?? null : sanitizedZipPath(x.path) ?? null));
    case "read": {
      try {
        const r = readArchive(input.text as string);
        return { records: r.records.map((x) => x.kind + ":" + x.data.id), skipped: r.skipped, version: r.header?.version ?? null };
      } catch (e) { return { error: (e as Error).message }; }
    }
    case "import": {
      const dst = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "dst" });
      dst.clock.wallClock = () => 1_000;
      if (input.prefill) {
        dst.transact("prefill", (tx) => {
          tx.put({ kind: "workspace", data: { ...structuredClone(dst.workspace), name: "", favorites: ["mine"] } });
          tx.put({ kind: "block", data: makeBlock({ id: "mine", type: "page", parent: "w", sk: "a0", text: "Mine", createdAt: 784_000_000 }, 0) });
          tx.put({ kind: "block", data: makeBlock({ id: "p-url", type: "page", parent: "w", sk: "a1", text: "Local newer", createdAt: 784_000_000 }, 0) });
        });
        const b = structuredClone(dst.blocks.get("p-url")!);
        b.stamp = { millis: 9_999_999_999_999, counter: 0, node: "dst" };
        dst.applyRemote([{ kind: "block", data: b }]);
      }
      const undo = dst.canUndo;
      const origins: string[] = [];
      const off = dst.observe((c) => origins.push(c.origin === "import" ? "import" : c.origin === "local" ? "local" : "other"));
      const out: Record<string, unknown> = {};
      try { out.result = importArchive(dst, writeArchive(store)); } catch (e) { out.error = String(e); }
      off();
      const w = JSON.parse(canonicalStringify(dst.workspace)) as Record<string, unknown>;
      delete w.stamp; delete w.createdAt; delete w.updatedAt; delete w.id;
      out.workspace = w;
      out.origins = origins;
      out.canUndoChanged = dst.canUndo !== undo;
      out.stampsKept = corpus.every((r) => r.kind !== "block" || (r.data.id === "p-url" && input.prefill) ||
        canonicalStringify(dst.blocks.get(r.data.id)?.stamp) === canonicalStringify(r.data.stamp));
      out.blocks = dst.blocks.size;
      out.pUrlTitle = richPlain(dst.blocks.get("p-url")?.text);
      return out;
    }
  }
  throw new Error("?");
};
