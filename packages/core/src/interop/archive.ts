// Verlustfreies Workspace-Archiv (Swift Interop/WorkspaceArchive.swift, BSD-26/BSD-67): JSON Lines, ein Record je Zeile
// in der Form des Sync-Protokolls (`{"kind": "block", "data": {…}}`) plus Kopfzeile.
//   v1 `.based.jsonl`: nur die Zeilen (Kopf `"version": 1`).
//   v2 `.based.zip`: `workspace.jsonl` (Kopf `"version": 2`, `"assets": n`) und jede referenzierte Datei als
//   `assets/<asset-id>/<name>` (gespeichert, nicht komprimiert).
// Import mit Herkunft „import“: Stempel bleiben, kein Undo, wird aber wie eine lokale Änderung an den Sync gemeldet.
import type { ByteSource } from "./files.js";
import { canonicalStringify } from "../json.js";
import { compareStamps, ZERO_STAMP, type Stamp } from "../hlc.js";
import type { Block, BlockProps, Database, Workspace, WireRecord } from "../model/records.js";
import { safeParseRecord } from "../model/records.js";
import { recordKey, type RecordKeyString, type WorkspaceStore } from "../store/store.js";
import { DEFAULT_ZIP_LIMITS, isZip, readZipEntries, writeZip, ZipError, zipEntryData, type ZipLimits, type ZipWriteEntry } from "./zip.js";

type AssetRef = NonNullable<BlockProps["asset"]>;

export const ARCHIVE_FORMAT = "based-archive";
/** Neueste Version, die gelesen (und in `.based.zip` geschrieben) wird. */
export const ARCHIVE_VERSION = 2;
/** Version der reinen JSON-Lines-Datei. */
export const ARCHIVE_PLAIN_VERSION = 1;
export const PACKAGE_RECORDS = "workspace.jsonl";
export const PACKAGE_EXTENSION = "based.zip";

export interface ArchiveHeader {
  format: string;
  version: number;
  /** ISO 8601 („2024-01-01T00:00:00Z“). */
  exportedAt: string;
  records: number;
  workspaceName?: string;
  assets?: number;
}

export class ArchiveError extends Error {
  constructor(readonly kind: "notAnArchive" | "newerVersion", readonly version?: number) {
    super(kind === "notAnArchive" ? "This file isn't a Based archive." : `This archive was written by a newer Based (format ${version}). Update the app to import it.`);
    this.name = "ArchiveError";
  }
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const rank = (k: string) => (k === "workspace" ? 0 : k === "database" ? 1 : k === "view" ? 2 : 3);
const enc = new TextEncoder();

/** Archivtext aus Records (Kopf, dann Workspace, Datenbanken, Ansichten, Blöcke; je nach ID). */
export function encodeArchive(records: WireRecord[], workspaceName: string, version: number, assets: number | undefined, exportedAt = new Date()): string {
  const sorted = [...records].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0));
  const header: ArchiveHeader = { format: ARCHIVE_FORMAT, version, exportedAt: iso(exportedAt), records: sorted.length };
  if (workspaceName !== "") header.workspaceName = workspaceName;
  if (assets !== undefined) header.assets = assets;
  let out = canonicalStringify(header) + "\n";
  for (const r of sorted) out += `{"kind":"${r.kind}","data":${canonicalStringify(r.data)}}\n`;
  return out;
}

/** v1-Archiv des ganzen Stores (`.based.jsonl`). */
export function writeArchive(store: WorkspaceStore, exportedAt?: Date): string {
  return encodeArchive(store.exportRecords(), store.workspace.name, ARCHIVE_PLAIN_VERSION, undefined, exportedAt);
}

/** Jede Datei, auf die die Records zeigen (`"asset": {"id", "name"}`, auch in `{"_0": …}`), eindeutig nach ID. */
export function archiveAssetRefs(records: WireRecord[]): AssetRef[] {
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  const ref = (v: unknown): AssetRef | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const d = v as Record<string, unknown>;
    if (typeof d.id === "string" && typeof d.name === "string" && d.id !== "" && d.name !== "") {
      const r: AssetRef = { id: d.id, name: d.name };
      if (typeof d.size === "number" && Number.isInteger(d.size)) r.size = d.size;
      if (typeof d.mime === "string") r.mime = d.mime;
      return r;
    }
    return "_0" in d ? ref(d._0) : undefined;
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      const r = k === "asset" ? ref(x) : undefined;
      if (r) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } } else walk(x);
    }
  };
  for (const r of records) walk(r.data);
  return out;
}

export const archiveEntryPath = (ref: AssetRef) => `assets/${ref.id}/${ref.name}`;

/** Das Asset eines Eintragspfads oder `undefined` – auch für Namen, die den Ordner verlassen wollen. */
export function assetRefForEntry(path: string): AssetRef | undefined {
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== "assets") return undefined;
  const id = parts[1]!, name = parts[2]!;
  const idOK = id !== "" && [...id].every((c) => /[\p{L}\p{M}\p{N}]/u.test(c) || c === "-" || c === "_");
  if (!idOK || name === "" || name === "." || name === ".." || name.includes("\\")) return undefined;
  return { id, name };
}

/** `.based.zip` (v2): Records und alle Dateien, die `readAsset` liefert; fehlende werden gemeldet. */
export function writeArchivePackage(store: WorkspaceStore, readAsset: (ref: AssetRef) => Uint8Array | undefined, exportedAt?: Date):
  { zip: Uint8Array; records: number; assets: number; bytes: number; missing: AssetRef[] } {
  // BSD-30: Archive bleiben in der Austauschform (Datenbank mit Property-Liste), egal wie der Store speichert.
  const records = store.exportRecords();
  const refs = archiveAssetRefs(records);
  const text = encodeArchive(records, store.workspace.name, ARCHIVE_VERSION, refs.length, exportedAt);
  const entries: ZipWriteEntry[] = [{ path: PACKAGE_RECORDS, data: enc.encode(text), compress: false }];
  const missing: AssetRef[] = [];
  let bytes = 0;
  for (const ref of refs) {
    const data = readAsset(ref);
    if (!data) { missing.push(ref); continue; }
    entries.push({ path: archiveEntryPath(ref), data, compress: false });
    bytes += data.length;
  }
  return { zip: writeZip(entries, exportedAt), records: records.length, assets: refs.length - missing.length, bytes, missing };
}

/** Ein Archiv (v1 Text oder v2 ZIP) erkennen. */
export function isArchive(input: Uint8Array | ByteSource): boolean {
  // BSD-254: auch für eine Quelle – gelesen werden nur der Anfang bzw. das ZIP-Verzeichnis
  const head = input instanceof Uint8Array ? input.subarray(0, 400) : input.read(0, Math.min(400, input.size));
  if (isZip(head)) {
    try { return readZipEntries(input).some((e) => e.path === PACKAGE_RECORDS); } catch { return false; }
  }
  return new TextDecoder().decode(head).includes(`"${ARCHIVE_FORMAT}"`);
}

export interface ArchiveReadResult {
  header: ArchiveHeader | undefined;
  records: WireRecord[];
  /** Zeilen, die sich nicht lesen ließen. */
  skipped: number;
}

function parseHeader(v: unknown): ArchiveHeader | undefined {
  if (!v || typeof v !== "object") return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h.format !== "string" || typeof h.version !== "number" || !Number.isInteger(h.version) || typeof h.records !== "number" ||
      typeof h.exportedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:?\d{2})$/.test(h.exportedAt)) return undefined;
  return h as unknown as ArchiveHeader;
}

/** Archivtext lesen; unlesbare Zeilen werden gezählt, nicht abgebrochen (Swift `WorkspaceArchive.read`). */
export function readArchive(text: string): ArchiveReadResult {
  let header: ArchiveHeader | undefined;
  const records: WireRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { skipped += 1; continue; }
    if (header === undefined) {
      const h = parseHeader(v);
      if (h && h.format === ARCHIVE_FORMAT) {
        if (h.version > ARCHIVE_VERSION) throw new ArchiveError("newerVersion", h.version);
        header = h;
        continue;
      }
    }
    const r = safeParseRecord(v);
    if (r.ok) records.push(r.record); else skipped += 1;
  }
  if (header === undefined) throw new ArchiveError("notAnArchive");
  return { header, records, skipped };
}

export interface LoadedArchive {
  read: ArchiveReadResult;
  /** Dateien aus `assets/` (Pfad → Bytes) zum Ablegen im Asset-Speicher. */
  assets: { ref: AssetRef; data: Uint8Array }[];
  /** Einträge, die nicht übernommen wurden („Pfad — Grund“). */
  assetFailures: string[];
}

/** v1-Text oder v2-ZIP lesen, ohne den Store anzufassen (Worker-tauglich). */
export function loadArchive(bytes: Uint8Array, limits?: Partial<ZipLimits>): LoadedArchive {
  if (!isZip(bytes)) return { read: readArchive(new TextDecoder().decode(bytes)), assets: [], assetFailures: [] };
  const entries = readZipEntries(bytes);
  const recordsEntry = entries.find((e) => e.path === PACKAGE_RECORDS);
  if (!recordsEntry) throw new ArchiveError("notAnArchive");
  const max = { ...DEFAULT_ZIP_LIMITS, ...limits };
  if (entries.length > max.maxEntries || entries.some((e) => e.uncompressedSize > max.maxEntryBytes) ||
      entries.reduce((n, e) => n + e.uncompressedSize, 0) > max.maxTotalBytes) throw new ZipError("limit", "archive too large");
  const loaded: LoadedArchive = { read: readArchive(new TextDecoder().decode(zipEntryData(bytes, recordsEntry))), assets: [], assetFailures: [] };
  for (const e of entries) {
    if (e.path.endsWith("/") || e.path === PACKAGE_RECORDS) continue;
    const ref = assetRefForEntry(e.path);
    if (!ref) { loaded.assetFailures.push(`${e.path} — not an asset path`); continue; }
    try { loaded.assets.push({ ref, data: zipEntryData(bytes, e) }); } catch (err) {
      loaded.assetFailures.push(`${e.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded;
}

export interface ArchiveImportResult {
  /** Geschriebene Records. */
  imported: number;
  /** Records, die der Workspace schon neuer hatte (bleiben). */
  keptNewer: number;
  /** Unlesbare Zeilen. */
  skipped: number;
  /**
   * BSD-423: Records, die hier seit dem Export in den Papierkorb gelegt oder endgültig gelöscht wurden und aus dem
   * Archiv zurückkamen (in `imported` enthalten). Fehlt, wenn 0 (Swift-Fixtures kennen das Feld nicht).
   */
  restored?: number;
}

/** `local` um die Einstellungen des Archivs ergänzt, ohne etwas zu überschreiben (ID bleibt). */
export function mergeWorkspace(local: Workspace, incoming: Workspace): Workspace {
  const w = structuredClone(local);
  if (w.name.trim() === "") w.name = incoming.name;
  if (w.icon === undefined && incoming.icon !== undefined) w.icon = incoming.icon;
  if (w.homePageID === undefined && incoming.homePageID !== undefined) w.homePageID = incoming.homePageID;
  for (const f of incoming.favorites) if (!w.favorites.includes(f)) w.favorites.push(f);
  if (incoming.teamspaces && incoming.teamspaces.length > 0) {
    const spaces = w.teamspaces ?? [];
    for (const t of incoming.teamspaces) if (!spaces.some((s) => s.id === t.id)) spaces.push(t);
    w.teamspaces = spaces;
  }
  return w;
}

const stampOf = (r: WireRecord): Stamp => (r.data.stamp as Stamp | undefined) ?? ZERO_STAMP;
const trashed = (r: WireRecord | undefined) => r?.kind === "block" && r.data.trashedAt !== undefined;
const untrashed = (r: WireRecord): WireRecord => {
  const data = { ...r.data };
  delete data.trashedAt;
  return { ...r, data } as WireRecord;
};

export interface ApplyImportedOptions {
  /**
   * BSD-423: Ein Archiv ist der Rückweg. Was hier nach dem Export in den Papierkorb kam (lokal neuer, aber im
   * Papierkorb) oder endgültig gelöscht wurde (Tombstone neuer als die Archivversion), kommt mit neuem Stempel zurück –
   * sonst zeigte der Import nach „alles löschen, Papierkorb leeren“ nichts an. Lokal neuer bearbeitete Records bleiben.
   */
  restoreDeleted?: boolean;
}

export interface ApplyImportedResult {
  /** Lokal neuer (bleiben). */
  stale: RecordKeyString[];
  /** Hier gelöscht, nachdem die Archivversion entstand (bleiben gelöscht; mit `restoreDeleted` nur Inhalt noch vorhandener Seiten, BSD-478). */
  tombstoned: RecordKeyString[];
  /** Aus Papierkorb bzw. Löschung zurückgeholt (mit `restoreDeleted`). */
  restored: RecordKeyString[];
  /** Geschrieben (ohne Gleiche). */
  written: number;
}

/**
 * Records mit Herkunft „import“ einspielen (Last-Writer-Wins wie Sync, nichts wird gelöscht; Stempel bleiben, kein
 * Undo, an den Sync gemeldet). Swift `WorkspaceStore.applyImported`; gibt die Schlüssel zurück, die lokal neuer waren.
 */
export function applyImported(store: WorkspaceStore, records: WireRecord[]): RecordKeyString[] {
  return applyImportedRecords(store, records).stale;
}

/**
 * BSD-478: Zurückgeholt wird in Papierkorb-Einheiten (Seite, Datenbank-Seite, eigene Inline-Datenbank, Zeile – wie
 * `isTrashable`). Ein Inhaltsblock, eine Ansicht oder eine Spalte (Property-Record), die hier gelöscht wurde, während
 * ihre Seite bzw. Datenbank weiter da ist, war eine Bearbeitung und bleibt gelöscht – sonst kämen beim erneuten Import
 * eines Archivs gelöschte Sätze mitten in bearbeiteten Seiten zurück. Gibt die Schlüssel zurück, die zurückkommen.
 */
function revivable(store: WorkspaceStore, records: readonly WireRecord[], candidates: readonly { key: RecordKeyString; r: WireRecord }[]): Set<RecordKeyString> {
  const archived = new Map<string, Block>();
  const archivedDBs = new Map<string, Database>();
  for (const r of records) {
    if (r.kind === "block") archived.set(r.data.id, r.data);
    else if (r.kind === "database") archivedDBs.set(r.data.id, r.data);
  }
  const reviving = new Set(candidates.map((c) => c.key));
  const blockOf = (id: string) => store.blocks.get(id) ?? archived.get(id);
  const dbBlock = (databaseID: string) => (store.databases.get(databaseID) ?? archivedDBs.get(databaseID))?.blockID;
  const unit = (b: Block) => b.type === "page" || b.type === "databasePage" || b.parent.startsWith("d:") ||
    (b.type === "databaseInline" && b.props?.databaseID !== undefined && dbBlock(b.props.databaseID) === b.id);
  /** Ist die Papierkorb-Einheit, zu der Block `id` gehört, hier lebendig (da, nicht im Papierkorb, kommt nicht erst zurück)? */
  const unitAlive = (id: string | undefined): boolean => {
    const seen = new Set<string>();
    let cur = id;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const b = blockOf(cur);
      if (!b) return false;
      if (unit(b)) {
        const here = store.blocks.get(cur);
        return here !== undefined && here.trashedAt === undefined && !reviving.has(recordKey({ kind: "block", data: here }));
      }
      cur = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
    }
    return false;
  };
  const out = new Set<RecordKeyString>();
  for (const { key, r } of candidates) {
    let keep = true;
    if (r.kind === "block") keep = unit(r.data) || !unitAlive(r.data.parent.startsWith("b:") ? r.data.parent.slice(2) : undefined);
    else if (r.kind === "view") keep = !unitAlive(r.data.blockID);
    else if (r.kind === "property") { const b = dbBlock(r.data.databaseID); keep = b === undefined || !unitAlive(b); }
    if (keep) out.add(key);
  }
  return out;
}

/** Wie `applyImported`, mit Bericht und optional Wiederherstellen gelöschter Records (BSD-423). */
export function applyImportedRecords(store: WorkspaceStore, records: WireRecord[], opts: ApplyImportedOptions = {}): ApplyImportedResult {
  const puts: WireRecord[] = [];
  const candidates: { key: RecordKeyString; r: WireRecord; trashedHere: boolean }[] = [];
  const stale: RecordKeyString[] = [];
  const tombstoned: RecordKeyString[] = [];
  for (const r of records) {
    if (r.kind === "workspace" && r.data.id !== store.workspace.id) continue;
    const key = recordKey(r);
    store.clock.observe(stampOf(r));
    const local = store.record(key);
    if (local) {
      if (canonicalStringify(local) === canonicalStringify(r)) continue;
      if (compareStamps(stampOf(local), stampOf(r)) > 0) {
        // Lokal neuer, aber im Papierkorb: die lokale Fassung ohne Papierkorb-Markierung zurückholen – nicht die ältere
        // Archivfassung, sonst gingen Änderungen nach dem Export verloren (Prüfung Pass 37).
        if (opts.restoreDeleted && trashed(local) && !trashed(r)) candidates.push({ key, r: untrashed(local), trashedHere: true });
        else stale.push(key);
        continue;
      }
    } else {
      const ts = store.persistence?.tombstone(key);
      if (ts && compareStamps(ts, stampOf(r)) >= 0) {
        // hier gelöscht, nachdem diese Version entstand
        if (opts.restoreDeleted) candidates.push({ key, r, trashedHere: false }); else tombstoned.push(key);
        continue;
      }
    }
    puts.push(r);
  }
  // BSD-478: nur ganze Papierkorb-Einheiten zurückholen; der Rest bleibt wie ohne `restoreDeleted`.
  const revive: WireRecord[] = [];
  if (candidates.length > 0) {
    const ok = revivable(store, records, candidates);
    for (const c of candidates) {
      if (ok.has(c.key)) revive.push(c.r);
      else if (c.trashedHere) stale.push(c.key);
      else tombstoned.push(c.key);
    }
  }
  // Öffentlicher Weg: `keepStamps` speichert mit Herkunft „import“ (kein Neustempeln, kein Undo, wird gesynct).
  const rejected = store.writeFailure?.rejected ?? 0;
  store.transact("Import", (t) => { for (const r of puts) t.put(r); }, { keepStamps: true });
  // Zurückgeholtes neu stempeln (sonst gewänne beim Sync wieder die Löschung); Bearbeitungszeiten bleiben.
  if (revive.length > 0) {
    store.transact("Restore from archive", (t) => {
      t.preserveTimestamps = true;
      for (const r of revive) t.put(r);
    }, { undoable: false });
  }
  if (store.writeFailure && store.writeFailure.rejected !== rejected) throw new Error(store.writeFailure.message || "write failed");
  return { stale, tombstoned, restored: revive.map(recordKey), written: puts.length + revive.length };
}

/** Ein gelesenes Archiv in `store` übernehmen (Swift `importRecords`). Leerer Workspace: Einstellungen des Archivs
 * ersetzen die neuen; sonst werden sie ergänzt (nie ein zweiter Workspace-Record, BSD-23). */
export function importArchiveRecords(store: WorkspaceStore, read: ArchiveReadResult): ArchiveImportResult {
  let records = read.records;
  let restored = 0;
  const ws = records.find((r) => r.kind === "workspace");
  if (ws && ws.kind === "workspace") {
    records = records.filter((r) => r.kind !== "workspace");
    if (store.blocks.size === 0) {
      const w = structuredClone(ws.data);
      w.id = store.workspace.id;
      store.transact("Restore workspace", (tx) => tx.put({ kind: "workspace", data: w }), { undoable: false });
      restored = 1;
    } else {
      const merged = mergeWorkspace(store.workspace, ws.data);
      if (canonicalStringify(merged) !== canonicalStringify(store.workspace)) {
        store.transact("Import workspace settings", (tx) => tx.put({ kind: "workspace", data: merged }), { undoable: false });
        restored = 1;
      }
    }
  }
  const r = applyImportedRecords(store, records, { restoreDeleted: true });
  const out: ArchiveImportResult = { imported: records.length - r.stale.length - r.tombstoned.length + restored, keptNewer: r.stale.length, skipped: read.skipped };
  if (r.restored.length > 0) out.restored = r.restored.length;
  return out;
}

/** Archivtext importieren (Swift `importArchive`). */
export function importArchive(store: WorkspaceStore, text: string): ArchiveImportResult {
  return importArchiveRecords(store, readArchive(text));
}

