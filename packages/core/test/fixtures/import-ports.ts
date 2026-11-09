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

