// BSD-248: Golden Fixtures für Datenbank-Schreiboperationen (Swift DatabaseOpsFixtures). Ausgangs-Workspace aus
// meta.records, Schritte nacheinander, dann alle geänderten Records normalisiert wie im Swift-Export.
import {
  changePropertyType, deleteForever, deleteOption, deleteProperty, duplicateProperty, encodeRecord, MemoryPersistence, parseRecord,
  renameProperty, repairUniqueIDs, restorePages, setRelation, setRelationTarget, setValue, trashPages, WorkspaceStore,
  type PropertyValue, type WireRecord,
} from "../../src/index.js";
import type { Port } from "./ports.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step = { op: string; args: Record<string, Json> };

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function strings(v: Json, out: Set<string>) {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); strings(x, out); }
}

function normalize(v: Json, known: Set<string>, top = false): Json {
  const isNew = (s: string) => !known.has(s) && UUID.test(s);
  if (typeof v === "string") return isNew(v) ? "new" : v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, known));
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      if (top && (k === "createdAt" || k === "updatedAt" || k === "stamp")) continue;
      if (top && k === "trashedAt") { out[k] = "now"; continue; }
      out[isNew(k) ? "new" : k] = normalize(x, known);
    }
    return out;
  }
  return v;
}

function run(s: WorkspaceStore, { op, args: a }: Step) {
  const str = (k: string) => a[k] as string;
  const list = (k: string) => (a[k] as string[]) ?? [];
  switch (op) {
    case "renameProperty": return renameProperty(s, str("db"), str("prop"), str("name"));
    case "deleteProperty": return deleteProperty(s, str("db"), str("prop"));
    case "setRelationTarget": return setRelationTarget(s, str("db"), str("prop"), (a.target as string | null) ?? undefined);
    case "changePropertyType": return changePropertyType(s, str("db"), str("prop"), str("type"));
    case "duplicateProperty": return void duplicateProperty(s, str("db"), str("prop"));
    case "deleteOption": return deleteOption(s, str("db"), str("prop"), str("option"));
    case "setRelation": return setRelation(s, str("row"), str("prop"), list("targets"));
    case "setValue": return setValue(s, str("row"), str("prop"), (a.value as PropertyValue | null) ?? null);
    case "repairUniqueIDs": return repairUniqueIDs(s, list("dbs"));
    case "trash": return void trashPages(s, list("ids"));
    case "restore": return restorePages(s, list("ids"));
    case "deleteForever": return deleteForever(s, list("ids"));
    default: throw new Error(`unknown op ${op}`);
  }
}

const snapshot = (s: WorkspaceStore) => new Map(s.allRecords().map((r) => [`${r.kind}:${r.data.id}`, encodeRecord(r)] as const));

export const dbopsPort: Port = (raw, meta) => {
  const records = (meta.records as unknown[]).map(parseRecord) as WireRecord[];
  const known = new Set<string>();
  strings(meta.records as Json, known);
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "fx" });
  const before = snapshot(store);
  for (const step of raw as Step[]) run(store, step);
  const after = snapshot(store);
  const out: [string, Json][] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const line = after.get(key);
    let rec: Json = null;
    if (line !== undefined) {
      const o = JSON.parse(line) as { kind: string; data: Json };
      rec = { ...o, data: normalize(o.data, known, true) };
    }
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    out.push([!known.has(id) && UUID.test(id) ? `${kind}:new` : key, rec]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
};
