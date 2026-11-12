// BSD-274: automatische lokale Backups. Plattformneutral: das Dateisystem liefert die Hülle (`BackupTarget`, auf dem
// Server bzw. in der Desktop-App Node-fs). Aufbau des Backup-Ordners:
//   snapshots/<JJJJ-MM-TTTHH-MM-SSZ>.based.jsonl   ein Stand = Workspace-Archiv (Format wie `.based.jsonl`, Kopf v2
//                                                  mit Anzahl der Dateien), vollständig für sich lesbar
//   assets/<id>                                    jede Datei einmal (inhaltsadressiert: gleiche ID = gleicher Inhalt),
//                                                  wird nur geschrieben, wenn sie noch fehlt → inkrementell
// Geschrieben wird atomar (Hülle: erst .tmp, dann umbenennen); gelesen wird nur beim Wiederherstellen – ein Ordner
// in iCloud Drive funktioniert deshalb auch, während er gerade abgeglichen wird.
// Aufbewahrung: die letzten 10 Stände (auch mehrere in einer Stunde, z. B. „Jetzt sichern“ und der Stand vor einem
// Wiederherstellen), dazu die neuesten 24 je Stunde, 30 je Tag, 12 je Monat (jeweils der letzte Stand des Zeitraums).
import { canonicalStringify } from "../json.js";
import type { WireRecord } from "../model/records.js";
import { ARCHIVE_VERSION, encodeArchive, readArchive, type ArchiveReadResult } from "../interop/archive.js";
import { recordKey, type RecordKeyString, type WorkspaceStore } from "../store/store.js";

/** Dateizugriff der Hülle; Pfade relativ zum Backup-Ordner, mit „/“. */
export interface BackupTarget {
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Atomar schreiben (ganz oder gar nicht). */
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

export interface BackupAsset { id: string; read: () => Uint8Array | undefined | Promise<Uint8Array | undefined> }

export interface SnapshotInfo {
  name: string;
  /** Zeitpunkt (ms). */
  at: number;
  records: number;
  /** Neu geschriebene bzw. schon vorhandene Dateien. */
  assetsWritten: number;
  assetsKept: number;
  /** Fehlende Dateien (nicht lesbar). */
  missing: string[];
  /** Fingerabdruck des Inhalts (ohne Zeitstempel); gleich = nichts geändert. */
  digest: string;
}

export const SNAPSHOT_DIR = "snapshots";
export const ASSET_DIR = "assets";
const SUFFIX = ".based.jsonl";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Dateiname eines Stands (sortiert zeitlich, ohne „:“ – geht auf jedem Dateisystem). */
export function snapshotName(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-") + SUFFIX;
}

/** Zeitpunkt aus dem Dateinamen (oder `undefined`, wenn der Name nicht passt). */
export function snapshotTime(name: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.based\.jsonl$/.exec(name);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** Asset-IDs, die als Dateiname taugen (keine Pfade). */
const safeID = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** FNV-1a über den Text (schnell, nur zum Erkennen „unverändert“). */
function digestOf(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + text.length.toString(16);
}

/**
 * Einen Stand schreiben. `previousDigest`: Fingerabdruck des letzten Stands – ist der Inhalt gleich, wird nichts
 * geschrieben (`undefined`), außer `force`.
 */
export async function writeSnapshot(target: BackupTarget, input: { records: WireRecord[]; workspaceName: string; assets: readonly BackupAsset[]; now?: Date; previousDigest?: string; force?: boolean }): Promise<SnapshotInfo | undefined> {
  const now = input.now ?? new Date();
  const body = encodeArchive(input.records, input.workspaceName, ARCHIVE_VERSION, input.assets.length, new Date(0));
  const digest = digestOf(body + "\n" + input.assets.map((a) => a.id).sort().join(","));
  if (!input.force && input.previousDigest === digest) return undefined;
  let written = 0, kept = 0;
  const missing: string[] = [];
  for (const a of input.assets) {
    if (!safeID(a.id)) { missing.push(a.id); continue; }
    const path = `${ASSET_DIR}/${a.id}`;
    if (await target.exists(path)) { kept++; continue; }
    const data = await a.read();
    if (!data) { missing.push(a.id); continue; }
    await target.write(path, data);
    written++;
  }
  const name = snapshotName(now);
  const text = encodeArchive(input.records, input.workspaceName, ARCHIVE_VERSION, input.assets.length, now);
  await target.write(`${SNAPSHOT_DIR}/${name}`, enc.encode(text));
  return { name, at: now.getTime(), records: input.records.length, assetsWritten: written, assetsKept: kept, missing, digest };
}

/** Stände, neueste zuerst. */
export async function listSnapshots(target: BackupTarget): Promise<{ name: string; at: number }[]> {
  const names = await target.list(SNAPSHOT_DIR).catch(() => []);
  return names.flatMap((name) => { const at = snapshotTime(name); return at === undefined ? [] : [{ name, at }]; }).sort((a, b) => b.at - a.at);
}

/** Welche Stände nach der Regel letzte 10 / 24 stündlich / 30 täglich / 12 monatlich wegfallen (reine Funktion). */
export function snapshotsToPrune(snaps: readonly { name: string; at: number }[], keep: { recent?: number; hourly: number; daily: number; monthly: number } = { recent: 10, hourly: 24, daily: 30, monthly: 12 }): string[] {
  const sorted = [...snaps].sort((a, b) => b.at - a.at);
  const keepNames = new Set<string>(sorted.slice(0, keep.recent ?? 0).map((s) => s.name));
  const bucket = (at: number, unit: "hour" | "day" | "month") => {
    const d = new Date(at);
    return unit === "month" ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : unit === "day" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 13);
  };
  for (const [unit, n] of [["hour", keep.hourly], ["day", keep.daily], ["month", keep.monthly]] as const) {
    const seen = new Set<string>();
    for (const s of sorted) {
      const b = bucket(s.at, unit);
      if (seen.has(b)) continue;
      seen.add(b);
      if (seen.size > n) break;
      keepNames.add(s.name); // neuester Stand je Zeitraum
    }
  }
  return sorted.filter((s) => !keepNames.has(s.name)).map((s) => s.name);
}

/** Alte Stände löschen und Dateien, auf die kein Stand mehr zeigt. */
export async function pruneBackups(target: BackupTarget, keep?: Parameters<typeof snapshotsToPrune>[1]): Promise<{ snapshots: number; assets: number }> {
  const snaps = await listSnapshots(target);
  const drop = snapshotsToPrune(snaps, keep);
  for (const name of drop) await target.remove(`${SNAPSHOT_DIR}/${name}`);
  if (drop.length === 0) return { snapshots: 0, assets: 0 };
  // Dateien nur löschen, wenn kein verbleibender Stand sie nennt (dafür werden die Stände gelesen).
  const used = new Set<string>();
  for (const s of snaps) {
    if (drop.includes(s.name)) continue;
    const read = await readSnapshot(target, s.name).catch(() => undefined);
    if (!read) return { snapshots: drop.length, assets: 0 }; // im Zweifel nichts löschen
    for (const id of snapshotAssetIDs(read.records)) used.add(id);
  }
  let assets = 0;
  for (const name of await target.list(ASSET_DIR).catch(() => [])) {
    if (!used.has(name)) { await target.remove(`${ASSET_DIR}/${name}`); assets++; }
  }
  return { snapshots: drop.length, assets };
}

/** Asset-IDs in Records: `asset: {id}` (Archiv-Form) und 64-stellige Inhalts-Hashes (Server-Assets, BSD-78). */
export function snapshotAssetIDs(records: readonly WireRecord[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") { if (/^[0-9a-f]{64}$/.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x)); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (key === "asset" && typeof o.id === "string" && safeID(o.id)) out.add(o.id);
    for (const [k, x] of Object.entries(o)) walk(x, k);
  };
  for (const r of records) walk(r.data);
  return [...out];
}

export async function readSnapshot(target: BackupTarget, name: string): Promise<ArchiveReadResult> {
  if (snapshotTime(name) === undefined) throw new Error(`not a snapshot: ${name}`);
  return readArchive(dec.decode(await target.read(`${SNAPSHOT_DIR}/${name}`)));
}

/** Was „Wiederherstellen (ersetzen)“ ändern würde – für die Vorschau und zum Anwenden. */
export interface RestorePlan {
  upserts: WireRecord[];
  removals: RecordKeyString[];
  /** Seiten (inkl. Datenbank-Seiten), die zurückkommen, sich ändern bzw. verschwinden. */
  pages: { added: number; changed: number; removed: number };
}

const isPage = (r: WireRecord | undefined) => r?.kind === "block" && (r.data.type === "page" || r.data.type === "databasePage");

/** Plan: der Workspace soll genau dem Stand entsprechen (Workspace-Record bleibt der eigene). */
export function planRestore(store: WorkspaceStore, snapshot: readonly WireRecord[]): RestorePlan {
  const current = new Map<RecordKeyString, WireRecord>();
  for (const r of store.exportRecords()) if (r.kind !== "workspace") current.set(recordKey(r), r);
  const wanted = new Map<RecordKeyString, WireRecord>();
  for (const r of snapshot) if (r.kind !== "workspace") wanted.set(recordKey(r), r);
  const upserts: WireRecord[] = [];
  const pages = { added: 0, changed: 0, removed: 0 };
  const strip = (r: WireRecord) => { const { stamp: _s, updatedAt: _u, updatedBy: _b, ...rest } = r.data as Record<string, unknown>; return canonicalStringify(rest); };
  for (const [k, r] of wanted) {
    const have = current.get(k);
    if (have && strip(have) === strip(r)) continue;
    upserts.push(r);
    if (isPage(r)) { if (have) pages.changed++; else pages.added++; }
  }
  const removals: RecordKeyString[] = [];
  for (const [k, r] of current) if (!wanted.has(k)) { removals.push(k); if (isPage(r)) pages.removed++; }
  return { upserts, removals, pages };
}

/** Plan anwenden: eine lokale Transaktion (gestempelt, geht in den Sync; nicht per ⌘Z – dafür der Stand davor). */
export function applyRestore(store: WorkspaceStore, plan: RestorePlan): void {
  if (plan.upserts.length === 0 && plan.removals.length === 0) return;
  store.transact("Restore from backup", (tx) => {
    // erst entfernen (Kinder vor Eltern ist egal: Records ohne Eltern werden nicht angezeigt), dann schreiben
    for (const k of plan.removals) tx.remove(k);
    for (const r of plan.upserts) {
      const copy = structuredClone(r);
      delete (copy.data as { stamp?: unknown }).stamp;
      tx.put(copy);
    }
  }, { undoable: false });
}
