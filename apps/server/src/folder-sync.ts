// BSD-334 (ADR 0015): Ordner-Sync (iCloud Drive) im based-server. Der lokale Server der Desktop-App (Sidecar,
// `--local`) hat Dateizugriff; er mischt die Segmente der anderen Macs in seinen Store und schreibt die Änderungen
// seiner Clients (per Sync v2, Herkunft „remote“) in den Ordner. Die App selbst braucht dafür keinen Dateizugriff:
// sie bekommt alles wie gewohnt über Sync v2. Anhänge reisen unter assets/<hash> mit (geprüft per SHA-256).
//
//   based-server --local --folder-sync "~/Library/Mobile Documents/com~apple~CloudDocs/Based" [--folder-device mac-a]
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderAssets, FolderSync, sha256Hex, type AssetBlobStore, type FolderSyncState, type FolderTarget, type SqlitePersistence } from "@based/sync";
import type { WorkspaceStore } from "@based/core";
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
}

export class FolderSyncService {
  readonly sync: FolderSync;
  readonly assets: FolderAssets;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  lastError: string | undefined;
  lastRound: number | undefined;

  constructor(private readonly o: FolderSyncServiceOptions) {
    let state: FolderSyncState | undefined;
    try {
      const raw = o.persistence.meta(STATE_KEY);
      if (raw) state = JSON.parse(raw) as FolderSyncState;
    } catch { state = undefined; }
    const target = nodeFolderTarget(o.dir);
    this.sync = new FolderSync({ store: o.store, target, device: o.device, enabled: true, exportRemote: true, log: (m) => o.log.info(m), ...(state ? { state } : {}) });
    this.assets = new FolderAssets(target, serverBlobs(o.assets), (m) => o.log.info(m));
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
    try {
      const r = await this.sync.round();
      this.o.persistence.setMeta(STATE_KEY, JSON.stringify(this.sync.state()));
      await this.assets.push();
      const blobs = serverBlobs(this.o.assets);
      for (const h of this.o.referencedAssets?.() ?? new Set<string>()) if (!(await blobs.has(h))) await this.assets.get(h);
      if (r.pushed || r.received) this.o.log.info("folder sync round", { pushed: r.pushed, received: r.received, waiting: r.waiting });
      this.lastError = undefined;
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
    this.sync.stop();
  }
}
