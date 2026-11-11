// BSD-30 (ADR 0014): Datenbank-Properties als eigene Records. Hier nur das Rechnen – aufteilen, zusammensetzen,
// Unterschiede bestimmen, zusammenführen, prüfen. Kein Store, keine Uhr, kein Zufall: dieselbe Eingabe ergibt auf
// jedem Gerät dasselbe Ergebnis. Der Store, der Sync und die Dateimigration bauen darauf auf (nächste Schritte).
//
// Warum: Solange alle Properties im Datenbank-Record liegen, gewinnt beim Sync die letzte Änderung am ganzen Schema.
// Zwei Geräte, die gleichzeitig verschiedene Spalten ändern, verlieren eine der Änderungen. Mit einem Record pro
// Property (Last-Writer-Wins je Record) bleiben beide.
import { compareStamps, type Stamp } from "../hlc.js";
import { plainText } from "../richtext.js";
import { keysBetween } from "../sortkeys.js";
import type { Block, Database, DatabaseView, PropertyRecord, PropertySchema, WireRecord } from "./records.js";

export type { PropertyRecord };

/** Datenbank-Record im neuen Format: ohne Properties; `legacyProperties` ist die eingefrorene Liste von vor der Umstellung (Rückweg). */
export type DatabaseCore = Database & { legacyProperties?: PropertySchema[] };

/** `<databaseID>/<propertyID>` – kein Doppelpunkt, der trennt in Record-Schlüsseln Art und ID. */
export const propertyRecordID = (databaseID: string, propertyID: string) => `${databaseID}/${propertyID}`;

const byOrder = (a: PropertyRecord, b: PropertyRecord) => (a.sk !== b.sk ? (a.sk < b.sk ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Tiefer Vergleich von JSON-Werten, unabhängig von der Reihenfolge der Schlüssel. */
export function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    return a.length === y.length && a.every((v, i) => sameJSON(v, y[i]));
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined), ky = Object.keys(y).filter((k) => y[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => k in y && sameJSON(x[k], y[k]));
}

export type SplitResult =
  | { ok: true; core: DatabaseCore; properties: PropertyRecord[] }
  /** Nicht aufteilbar, ohne etwas zu verlieren (die Datenbank bleibt im alten Format und wird gemeldet). */
  | { ok: false; reason: string };

/**
 * Migration eines Datenbank-Records: deterministisch. IDs aus Datenbank- und Property-ID, Stempel = Stempel des
 * Datenbank-Records, Reihenfolge aus der Position. Zwei Geräte, die unabhängig aufteilen, erzeugen dieselben Records;
 * eine spätere echte Änderung (neuerer Stempel) wird nie überschrieben.
 */
export function splitDatabase(db: Database): SplitResult {
  const seen = new Set<string>();
  for (const p of db.properties) {
    if (seen.has(p.id)) return { ok: false, reason: `property id “${p.id}” appears twice` };
    seen.add(p.id);
  }
  const keys = keysBetween(db.properties.length);
  const properties = db.properties.map((schema, i): PropertyRecord => ({
    id: propertyRecordID(db.id, schema.id), databaseID: db.id, sk: keys[i]!, schema: structuredClone(schema), stamp: { ...db.stamp },
  }));
  const core: DatabaseCore = { ...structuredClone(db), properties: [], legacyProperties: structuredClone(db.properties) };
  return { ok: true, core, properties };
}

/** Schon aufgeteilt? (Dann darf die Migration den Record nicht noch einmal anfassen.) */
export const isSplit = (db: Database): boolean => Array.isArray((db as DatabaseCore).legacyProperties) && db.properties.length === 0;

/**
 * Datenbank mit Properties, wie der Rest der App sie liest: Kern + Property-Records, sortiert nach (sk, id).
 * `legacyProperties` gehört nicht zur Sicht. Fremde Records (andere Datenbank) werden ignoriert.
 */
export function joinDatabase(core: DatabaseCore, records: Iterable<PropertyRecord>): Database {
  const mine = [...records].filter((r) => r.databaseID === core.id).sort(byOrder);
  const { legacyProperties: _legacy, ...rest } = structuredClone(core);
  return { ...rest, properties: mine.map((r) => structuredClone(r.schema)) } as Database;
}

/** Rückweg: die eingefrorene Liste wieder einsetzen (Schema-Änderungen seit der Umstellung gehen dabei verloren, Zeilenwerte nicht). */
export function restoreLegacy(core: DatabaseCore): Database {
  const { legacyProperties, ...rest } = structuredClone(core);
  return { ...rest, properties: legacyProperties ?? rest.properties } as Database;
}

export interface PropertyDiff {
  /** Neue und geänderte Records, mit `stamp` gestempelt. Unveränderte fehlen – ihr Stempel bleibt. */
  upserts: PropertyRecord[];
  /** IDs entfernter Property-Records (werden zu Tombstones). */
  removed: string[];
}

/** Indizes einer längsten streng aufsteigenden Teilfolge (für möglichst wenige neue Sortierschlüssel). */
function longestIncreasing(keys: (string | undefined)[]): Set<number> {
  const len: number[] = [], prev: number[] = [];
  let best = -1;
  for (let i = 0; i < keys.length; i++) {
    len[i] = keys[i] === undefined ? 0 : 1;
    prev[i] = -1;
    if (keys[i] === undefined) continue;
    for (let j = 0; j < i; j++) {
      if (keys[j] !== undefined && keys[j]! < keys[i]! && len[j]! + 1 > len[i]!) {
        len[i] = len[j]! + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || len[i]! > len[best]!) best = i;
  }
  const out = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]!) out.add(i);
  return out;
}

/**
 * Was sich an den Property-Records ändert, wenn die Datenbank jetzt `next` als Properties hat. Nur wirklich
 * geänderte Properties bekommen einen neuen Stempel – das ist der ganze Gewinn: eine Änderung an Spalte A lässt
 * Spalte B (und ihren Stempel) in Ruhe. Umsortieren schreibt nur die bewegten Properties neu.
 */
export function diffProperties(databaseID: string, current: Iterable<PropertyRecord>, next: readonly PropertySchema[], stamp: Stamp): PropertyDiff {
  const old = new Map<string, PropertyRecord>();
  for (const r of current) if (r.databaseID === databaseID) old.set(r.id, r);
  const ids = next.map((p) => propertyRecordID(databaseID, p.id));
  if (new Set(ids).size !== ids.length) throw new Error("BSD-30: a database cannot hold two properties with the same id");
  const keep = longestIncreasing(ids.map((id) => old.get(id)?.sk));
  // Sortierschlüssel: behaltene bleiben, alle anderen kommen zwischen ihre behaltenen Nachbarn.
  const sks: string[] = new Array<string>(next.length);
  let i = 0, lower: string | undefined;
  while (i < next.length) {
    if (keep.has(i)) {
      lower = sks[i] = old.get(ids[i]!)!.sk;
      i += 1;
      continue;
    }
    let j = i;
    while (j < next.length && !keep.has(j)) j += 1;
    const upper = j < next.length ? old.get(ids[j]!)!.sk : undefined;
    const fresh = keysBetween(j - i, lower, upper);
    for (let k = i; k < j; k++) sks[k] = fresh[k - i]!;
    i = j;
  }
  const upserts: PropertyRecord[] = [];
  next.forEach((schema, n) => {
    const id = ids[n]!, was = old.get(id);
    if (was && was.sk === sks[n] && sameJSON(was.schema, schema)) return;
    upserts.push({ id, databaseID, sk: sks[n]!, schema: structuredClone(schema), stamp: { ...stamp } });
  });
  const present = new Set(ids);
  return { upserts, removed: [...old.keys()].filter((id) => !present.has(id)).sort() };
}

/** Last-Writer-Wins je Property-Record: gewinnt der eingehende? (Gleicher Stempel = derselbe Stand, bleibt.) */
export const incomingWins = (local: PropertyRecord | undefined, incoming: PropertyRecord): boolean =>
  local === undefined || compareStamps(incoming.stamp, local.stamp) > 0;

/**
 * Zwei Stände derselben Datenbank zusammenführen (je Record der neuere Stempel; Löschungen mit Stempel schlagen
 * ältere Records). Symmetrisch: merge(a, b) und merge(b, a) ergeben dasselbe.
 */
export function mergePropertyRecords(a: Iterable<PropertyRecord>, b: Iterable<PropertyRecord>, tombstones: ReadonlyMap<string, Stamp> = new Map()): PropertyRecord[] {
  const out = new Map<string, PropertyRecord>();
  for (const r of [...a, ...b]) if (incomingWins(out.get(r.id), r)) out.set(r.id, r);
  for (const [id, t] of tombstones) {
    const r = out.get(id);
    if (r && compareStamps(t, r.stamp) >= 0) out.delete(id);
  }
  return [...out.values()].sort(byOrder);
}

// MARK: Prüfer

export interface SchemaIssue {
  kind:
    | "duplicateProperty" | "missingTitle" | "severalTitles"
    | "orphanValue" | "viewReference" | "relationTarget" | "rollupReference" | "viewWithoutDatabase";
  databaseID: string;
  /** Betroffener Record (Zeile, Ansicht) oder die Property. */
  subject: string;
  detail: string;
}

function filterPropertyIDs(group: unknown, out: string[]) {
  const items = (group as { items?: unknown[] } | undefined)?.items;
  if (!Array.isArray(items)) return;
  for (const it of items) {
    const c = (it as { condition?: { _0?: { propertyID?: unknown } } }).condition?._0;
    if (c && typeof c.propertyID === "string") out.push(c.propertyID);
    const g = (it as { group?: { _0?: unknown } }).group?._0;
    if (g) filterPropertyIDs(g, out);
  }
}

/** Alle Property-IDs, auf die eine Ansicht verweist (mit der Stelle, für die Meldung). */
export function viewPropertyReferences(v: DatabaseView): { where: string; propertyID: string }[] {
  const out: { where: string; propertyID: string }[] = [];
  const add = (where: string, id: unknown) => { if (typeof id === "string" && id !== "") out.push({ where, propertyID: id }); };
  const inFilter: string[] = [];
  filterPropertyIDs(v.filter, inFilter);
  for (const id of inFilter) add("filter", id);
  for (const s of v.sorts ?? []) add("sort", s.propertyID);
  add("group", v.groupBy?.propertyID);
  for (const p of v.properties ?? []) add("column", p.id);
  for (const id of Object.keys(v.calculations ?? {})) add("calculation", id);
  add("date", v.datePropertyID);
  add("end date", v.endDatePropertyID);
  add("map", v.mapPropertyID);
  add("chart x", v.chart?.xPropertyID);
  add("chart y", v.chart?.yPropertyID);
  add("card cover", (v.cardCover as { property?: { _0?: unknown } } | undefined)?.property?._0);
  return out;
}

/**
 * Prüft, ob Schema und Verweise zusammenpassen. Liest nur. Gedacht für den Vergleich vor und nach der Umstellung:
 * Ein gewachsener Workspace hat oft schon Altlasten (Werte gelöschter Spalten, Ansichten mit verwaisten Spalten) –
 * die Umstellung darf keine neue Meldung erzeugen und keine verschwinden lassen.
 */
export function checkSchemas(databases: Iterable<Database>, views: Iterable<DatabaseView>, blocks: Iterable<Block>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const dbs = new Map<string, Database>();
  for (const d of databases) dbs.set(d.id, d);
  const propsOf = new Map<string, Map<string, PropertySchema>>();
  for (const db of dbs.values()) {
    const map = new Map<string, PropertySchema>();
    for (const p of db.properties) {
      if (map.has(p.id)) issues.push({ kind: "duplicateProperty", databaseID: db.id, subject: p.id, detail: `property id “${p.id}” appears twice` });
      else map.set(p.id, p);
    }
    propsOf.set(db.id, map);
    const titles = db.properties.filter((p) => p.type === "title").length;
    if (titles === 0) issues.push({ kind: "missingTitle", databaseID: db.id, subject: db.id, detail: "no title property" });
    if (titles > 1) issues.push({ kind: "severalTitles", databaseID: db.id, subject: db.id, detail: `${titles} title properties` });
  }
  for (const db of dbs.values()) {
    for (const p of db.properties) {
      if (p.type === "relation" && p.relation) {
        const target = propsOf.get(p.relation.databaseID);
        if (!target) issues.push({ kind: "relationTarget", databaseID: db.id, subject: p.id, detail: `relation “${p.name}” points to a missing database` });
        else if (p.relation.syncedPropertyID !== undefined && !target.has(p.relation.syncedPropertyID)) {
          issues.push({ kind: "relationTarget", databaseID: db.id, subject: p.id, detail: `relation “${p.name}” names a missing synced property` });
        }
      }
      if (p.type === "rollup" && p.rollup) {
        const rel = propsOf.get(db.id)!.get(p.rollup.relationPropertyID);
        if (!rel || rel.type !== "relation") issues.push({ kind: "rollupReference", databaseID: db.id, subject: p.id, detail: `rollup “${p.name}” has no relation property` });
        else {
          const target = rel.relation ? propsOf.get(rel.relation.databaseID) : undefined;
          if (target && !target.has(p.rollup.targetPropertyID)) issues.push({ kind: "rollupReference", databaseID: db.id, subject: p.id, detail: `rollup “${p.name}” names a missing target property` });
        }
      }
    }
  }
  for (const v of views) {
    const props = propsOf.get(v.databaseID);
    if (!props) {
      issues.push({ kind: "viewWithoutDatabase", databaseID: v.databaseID, subject: v.id, detail: `view “${v.name}” has no database` });
      continue;
    }
    for (const ref of viewPropertyReferences(v)) {
      if (!props.has(ref.propertyID)) issues.push({ kind: "viewReference", databaseID: v.databaseID, subject: v.id, detail: `view “${v.name}”: ${ref.where} refers to missing property ${ref.propertyID}` });
    }
  }
  for (const b of blocks) {
    if (!b.parent.startsWith("d:") || !b.values) continue;
    const dbID = b.parent.slice(2), props = propsOf.get(dbID);
    if (!props) continue;
    for (const id of Object.keys(b.values)) {
      if (!props.has(id)) issues.push({ kind: "orphanValue", databaseID: dbID, subject: b.id, detail: `row has a value for missing property ${id}` });
    }
  }
  return issues;
}

export const issueKey = (i: SchemaIssue) => `${i.kind}|${i.databaseID}|${i.subject}|${i.detail}`;

export interface MigrationReport {
  databases: number;
  properties: number;
  rows: number;
  views: number;
  /** Datenbanken, die nicht aufgeteilt werden können (bleiben im alten Format). */
  refused: { databaseID: string; title: string; reason: string }[];
  /** Datenbanken, bei denen Aufteilen + Zusammensetzen nicht wieder dasselbe ergibt. Muss leer sein. */
  roundTripFailures: string[];
  /** Meldungen des Prüfers vor der Umstellung, je Art gezählt (Altlasten). */
  issuesBefore: Record<string, number>;
  /** Meldungen, die es nur vorher oder nur nachher gibt. Muss leer sein. */
  issuesChanged: string[];
  /** Schon aufgeteilte Datenbanken (ein zweiter Lauf fasst sie nicht an). */
  alreadySplit: number;
  ok: boolean;
}

/**
 * Probelauf der Umstellung auf einer Menge von Records (z. B. ein Based-Archiv): teilt jede Datenbank auf, setzt sie
 * wieder zusammen und vergleicht – Inhalt, Reihenfolge und die Meldungen des Prüfers. Ändert nichts.
 */
export function dryRunMigration(records: readonly WireRecord[]): MigrationReport {
  const databases: Database[] = [], views: DatabaseView[] = [], blocks: Block[] = [];
  for (const r of records) {
    if (r.kind === "database") databases.push(r.data);
    else if (r.kind === "view") views.push(r.data);
    else if (r.kind === "block") blocks.push(r.data);
  }
  const report: MigrationReport = {
    databases: databases.length, properties: 0, views: views.length, rows: blocks.filter((b) => b.parent.startsWith("d:")).length,
    refused: [], roundTripFailures: [], issuesBefore: {}, issuesChanged: [], alreadySplit: 0, ok: false,
  };
  const after: Database[] = [];
  for (const db of databases) {
    if (isSplit(db)) {
      report.alreadySplit += 1;
      after.push(db);
      continue;
    }
    report.properties += db.properties.length;
    const s = splitDatabase(db);
    if (!s.ok) {
      report.refused.push({ databaseID: db.id, title: plainText(db.title), reason: s.reason });
      after.push(db);
      continue;
    }
    const joined = joinDatabase(s.core, s.properties);
    // dieselbe Datenbank noch einmal aufgeteilt: dieselben Records (Determinismus)
    const again = splitDatabase(db);
    if (!sameJSON(joined, db) || !again.ok || !sameJSON(again.properties, s.properties) || !sameJSON(restoreLegacy(s.core), db)) report.roundTripFailures.push(db.id);
    after.push(joined);
  }
  const before = checkSchemas(databases, views, blocks);
  for (const i of before) report.issuesBefore[i.kind] = (report.issuesBefore[i.kind] ?? 0) + 1;
  const a = new Set(before.map(issueKey)), b = new Set(checkSchemas(after, views, blocks).map(issueKey));
  report.issuesChanged = [...[...a].filter((k) => !b.has(k)).map((k) => "gone: " + k), ...[...b].filter((k) => !a.has(k)).map((k) => "new: " + k)];
  report.ok = report.roundTripFailures.length === 0 && report.issuesChanged.length === 0 && report.refused.length === 0;
  return report;
}

/** Bericht als Text (für `based check`). */
export function formatMigrationReport(r: MigrationReport): string {
  const lines = [
    `Databases: ${r.databases} (${r.alreadySplit} already split)`,
    `Properties to become records: ${r.properties}`,
    `Rows: ${r.rows} (not touched by the migration)`,
    `Views: ${r.views}`,
    `Split and join gives the same database: ${r.roundTripFailures.length === 0 ? "yes, all" : `NO, ${r.roundTripFailures.length} differ`}`,
    ...r.roundTripFailures.slice(0, 20).map((id) => `  differs: ${id}`),
    `Cannot be split: ${r.refused.length}`,
    ...r.refused.slice(0, 20).map((x) => `  ${x.title || x.databaseID}: ${x.reason}`),
    `Existing schema issues (unchanged by the migration): ${Object.keys(r.issuesBefore).length === 0 ? "none" : Object.entries(r.issuesBefore).sort().map(([k, n]) => `${k} ${n}`).join(", ")}`,
    `Issues that appear or disappear: ${r.issuesChanged.length}`,
    ...r.issuesChanged.slice(0, 20).map((x) => `  ${x}`),
    r.ok ? "Result: OK – this workspace can be migrated." : "Result: NOT OK – do not migrate; see above.",
  ];
  return lines.join("\n");
}
