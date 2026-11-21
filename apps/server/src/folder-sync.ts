// BSD-334 (ADR 0015): Ordner-Sync (iCloud Drive) im based-server. Der lokale Server der Desktop-App (Sidecar,
// `--local`) hat Dateizugriff; er mischt die Segmente der anderen Macs in seinen Store und schreibt die Änderungen
// seiner Clients (per Sync v2, Herkunft „remote“) in den Ordner. Die App selbst braucht dafür keinen Dateizugriff:
// sie bekommt alles wie gewohnt über Sync v2. Anhänge reisen unter assets/<hash> mit (geprüft per SHA-256).
//
//   based-server --local --folder-sync "~/Library/Mobile Documents/com~apple~CloudDocs/Based" [--folder-device mac-a]
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderAssets, FolderSync, sha256Hex, type AssetBlobStore, type FolderSyncState, type FolderTarget, type SqlitePersistence } from "@based/sync";
import type { RecordKeyString, WireRecord, WorkspaceStore } from "@based/core";
import type { AssetStore } from "./assets.js";
import type { Logger } from "./log.js";

const STATE_KEY = "folder-sync.state";

/** Ordner auf der Platte als FolderTarget: Pfade relativ zum Sync-Ordner, atomar schreiben (tmp + rename). */
export function nodeFolderTarget(root: string): FolderTarget {
  const abs = (p: string) => {
    if (p.split("/").some((s) => s === ".." || s === "")) throw new Error("bad folder path");
    return join(root, ...p.split("/"));
  };
  return {
    // Dateien und Ordner (devices/<gerät>/ sind Ordner); halbe eigene Schreibvorgänge (*.tmp) nicht
    list: async (dir) => (await readdir(abs(dir), { withFileTypes: true })).filter((e) => !e.name.endsWith(".tmp")).map((e) => e.name),
    write: async (p, data) => {
      const file = abs(p);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    },
    read: async (p) => new Uint8Array(await readFile(abs(p))),
    remove: async (p) => rm(abs(p), { force: true }),
  };
}

/** Der Asset-Speicher des Servers als AssetBlobStore (nur fertige Dateien; Löschen macht die Server-GC). */
export function serverBlobs(assets: AssetStore): AssetBlobStore {
  return {
    has: async (h) => assets.status(h).complete,
    get: async (h) => {
      const at = assets.locate(h);
      return at ? new Uint8Array(await readFile(at.path)) : undefined;
    },
    put: async (h, bytes) => {
      if ((await sha256Hex(bytes)) !== h) throw new Error("hash mismatch");
      await assets.write(h, 0, bytes.length, Buffer.from(bytes));
    },
    delete: async () => undefined,
    list: async () => assets.list(),
  };
}

export interface FolderSyncServiceOptions {
  dir: string;
  device: string;
  store: WorkspaceStore;
  persistence: SqlitePersistence;
  assets: AssetStore;
  log: Logger;
  /** Takt der Runden in ms (Standard 5 s). */
  intervalMs?: number;
  /** Anhänge, die Records brauchen (für das Nachholen aus dem Ordner). */
  referencedAssets?: () => ReadonlySet<string>;
  /**
   * Anhänge, die ein einzelner Record nennt. Damit prüft eine Runde nur die seit der letzten Runde geänderten Records
   * (und was noch fehlt) statt jedes Mal den ganzen Workspace – bei 600 000 Records ~230 ms je Runde, alle 5 s. Der
   * ganze Workspace wird nur in der ersten Runde und danach alle `fullScanEvery` Runden durchgesehen.
   */
  assetsOf?: (record: WireRecord) => Iterable<string>;
  /** Jede wievielte Runde alle Records und den Anhang-Ordner ansieht (Standard 120 = alle 10 min bei 5 s). */
  fullScanEvery?: number;
}

/** Ab so vielen geänderten Records ist ein Durchgang über alles nicht teurer (z. B. nach einem großen Import). */
const CHANGED_LIMIT = 50_000;
/** Anhänge in den Ordner schreiben: sonst nur, wenn eigene Records hinausgingen, spätestens jede 12. Runde (~1 min). */
const ASSET_PUSH_EVERY = 12;

export class FolderSyncService {
  readonly sync: FolderSync;
  readonly assets: FolderAssets;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  lastError: string | undefined;
  lastRound: number | undefined;
  /** Gezählte Runden (für den gelegentlichen Durchgang über alles). */
  private rounds = 0;
  /** Seit der letzten Runde geänderte Records (nur mit `assetsOf`); `undefined` = zu viele, alles ansehen. */
  private changed: Set<RecordKeyString> | undefined = new Set();
  /** Genannte Anhänge, die weder hier noch im Ordner lagen – jede Runde wieder versucht. */
  private missing = new Set<string>();
  private readonly unobserve: (() => void) | undefined;
  /** Zuletzt gesicherter Zustand (als JSON): unverändert wird nicht jede Runde neu geschrieben. */
  private savedState: string | undefined;

  constructor(private readonly o: FolderSyncServiceOptions) {
    let state: FolderSyncState | undefined;
    try {
      const raw = o.persistence.meta(STATE_KEY);
      if (raw) state = JSON.parse(raw) as FolderSyncState;
      this.savedState = raw ?? undefined;
    } catch { state = undefined; }
    const target = nodeFolderTarget(o.dir);
    // BSD-431: was in den Ordner muss, kommt aus dem Change-Log (übersteht Absturz/Neustart); Zustand sofort sichern.
    this.sync = new FolderSync({
      store: o.store, target, device: o.device, enabled: true, exportRemote: true, log: (m) => o.log.info(m), ...(state ? { state } : {}),
      changeLog: o.persistence, saveState: (s) => this.saveState(s),
    });
    this.assets = new FolderAssets(target, serverBlobs(o.assets), (m) => o.log.info(m));
    if (o.assetsOf) {
      this.unobserve = o.store.observe((c) => {
        const set = this.changed;
        if (!set) return;
        for (const k of c.keys) set.add(k);
        if (set.size > CHANGED_LIMIT) this.changed = undefined;
      });
    }
  }

  private saveState(s: FolderSyncState) {
    const json = JSON.stringify(s);
    if (json === this.savedState) return;
    this.o.persistence.setMeta(STATE_KEY, json);
    this.savedState = json;
  }

  /** Anhänge, die diese Runde prüfen muss: alle genannten (erste Runde, gelegentlich, nach vielen Änderungen) oder
   *  nur die der geänderten Records und die noch fehlenden. */
  private wantedAssets(full: boolean): ReadonlySet<string> {
    const { assetsOf, referencedAssets } = this.o;
    const changed = this.changed;
    this.changed = new Set();
    if (!assetsOf || full || !changed) return referencedAssets?.() ?? new Set<string>();
    const out = new Set(this.missing);
    for (const k of changed) {
      const r = this.o.store.record(k);
      if (r) for (const h of assetsOf(r)) out.add(h);
    }
    return out;
  }

  start() {
    void this.round();
    this.timer = setInterval(() => void this.round(), this.o.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  /** Eine Runde: Records schreiben/lesen, Anhänge hin und fehlende her. Nacheinander: ein Aufruf während einer
   *  laufenden Runde bekommt die nächste (höchstens eine wartet), damit eben gemachte Änderungen mitgehen. */
  round(): Promise<void> {
    if (this.queued) return this.queued;
    const prev = this.running ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.queued === next) this.queued = undefined;
      await this.once();
    });
    if (this.running) this.queued = next;
    this.running = next;
    void next.finally(() => { if (this.running === next) this.running = undefined; });
    return next;
  }

  private queued: Promise<void> | undefined;

  private async once(): Promise<void> {
    const round = this.rounds++;
    const full = round % (this.o.fullScanEvery ?? 120) === 0;
    try {
      const r = await this.sync.round();
      this.saveState(this.sync.state());
      // Den Anhang-Ordner nur ansehen, wenn neue eigene Records Dateien nennen können (die Datei kam vorher per
      // Upload), sonst etwa jede Minute – nicht bei jeder Runde zwei Ordner auflisten.
      if (full || r.pushed > 0 || round % ASSET_PUSH_EVERY === 0) await this.assets.push();
      const blobs = serverBlobs(this.o.assets);
      const wanted = this.wantedAssets(full);
      // Beim Durchgang über alles zählt nur, was noch genannt wird (nicht mehr Genanntes fällt aus der Liste).
      if (full) this.missing.clear();
      for (const h of wanted) {
        if (await blobs.has(h)) { this.missing.delete(h); continue; }
        if (await this.assets.get(h)) this.missing.delete(h);
        else this.missing.add(h);
      }
      if (r.pushed || r.received) this.o.log.info("folder sync round", { pushed: r.pushed, received: r.received, waiting: r.waiting });
      // Ein anderes Gerät schreibt schon ein neueres Format: nichts geht verloren (die Segmente warten), aber der
      // Nutzer muss es erfahren – die Einstellungen zeigen `lastError` als „Problem: …“.
      this.lastError = r.newer.length
        ? `${r.newer.length === 1 ? "Another device" : `${r.newer.length} other devices`} in this folder ${r.newer.length === 1 ? "uses" : "use"} a newer version of Based. Update Based on this Mac to keep syncing; nothing is lost until then.`
        : undefined;
      this.lastRound = Date.now();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.o.log.warning("folder sync failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    await this.round(); // letzte Änderungen noch hinaus
    this.unobserve?.();
    this.sync.stop();
  }
}
