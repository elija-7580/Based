// BSD-274: automatische lokale Backups des Server-Stores (der lokale Server der Desktop-App schreibt sie nach
// ~/Documents/Based Backups). BSD-449: oder in einen selbst gewählten Ordner (z. B. externes Laufwerk) – den legt der
// Server nie selbst an (`create: false`): ist er weg (Laufwerk ab), schlägt die Sicherung mit klarer Meldung fehl,
// statt still auf die interne Platte zu schreiben (unter /Volumes entstünde sonst ein gleichnamiger Ordner). Logik in @based/core (`writeSnapshot`, `pruneBackups`, `planRestore`); hier nur das
// Dateisystem (atomar: .tmp + rename), der Takt (stündlich, wenn sich etwas geändert hat, und beim Beenden) und
// die Dateien aus dem Asset-Speicher.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyRestore, listSnapshots, planRestore, pruneBackups, readSnapshot, snapshotAssetIDs, writeSnapshot, type BackupTarget, type SnapshotAssetCache, type SnapshotInfo, type WorkspaceStore } from "@based/core";
import type { AssetStore } from "./assets.js";
import type { Logger } from "./log.js";

/** BSD-449: Meldung, wenn der gewählte Backup-Ordner fehlt (Laufwerk nicht angeschlossen, Ordner umbenannt). */
export const unreachableMessage = (dir: string) => `The backup folder isn't available: ${dir}. Connect the drive or choose another folder.`;

export function nodeBackupTarget(root: string, opts: { create?: boolean } = {}): BackupTarget {
  const create = opts.create ?? true;
  /** Wurzel vorhanden? Standardordner wird angelegt, ein gewählter nie. */
  const ensureRoot = async () => {
    const s = await stat(root).catch(() => undefined);
    if (s?.isDirectory()) return;
    if (s || !create) throw new Error(unreachableMessage(root));
    await mkdir(root, { recursive: true });
  };
  const abs = (p: string) => {
    if (p.split("/").some((s) => s === ".." || s === "")) throw new Error("bad backup path");
    return join(root, ...p.split("/"));
  };
  return {
    list: async (dir) => { await ensureRoot(); return (await readdir(abs(dir), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })).filter((e) => e.isFile() && !e.name.endsWith(".tmp")).map((e) => e.name); },
    exists: async (p) => stat(abs(p)).then(() => true, () => false),
    write: async (p, data) => {
      await ensureRoot();
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

export class Backups {
  readonly target: BackupTarget;
  private digest: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SnapshotInfo | undefined> | undefined;
  /** BSD-491: Datei-IDs je Stand – das Aufräumen liest jeden Stand nur einmal je Serverlauf. */
  private readonly assetCache: SnapshotAssetCache = new Map();
  last: { at: number; name: string } | undefined;
  lastError: string | undefined;

  constructor(readonly dir: string, private readonly store: WorkspaceStore, private readonly assets: AssetStore, private readonly log: Logger, readonly create = true) {
    this.target = nodeBackupTarget(dir, { create });
  }

  /** BSD-449: Ist der Ordner da (bzw. darf er angelegt werden)? */
  async reachable(): Promise<boolean> {
    const s = await stat(this.dir).catch(() => undefined);
    return s ? s.isDirectory() : this.create;
  }

  /** Stündlich sichern (nur bei Änderungen) und aufräumen. */
  start(intervalMs = 3_600_000) {
    void this.snapshot().catch(() => undefined);
    this.timer = setInterval(() => void this.snapshot().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Jetzt sichern; `force` auch ohne Änderung (z. B. vor dem Wiederherstellen). */
  snapshot(force = false): Promise<SnapshotInfo | undefined> {
    // nacheinander: ein laufender Stand kann älter sein als die Anfrage („Jetzt sichern“ direkt nach einer Änderung)
    const prev = this.running ?? Promise.resolve(undefined);
    const next: Promise<SnapshotInfo | undefined> = prev.catch(() => undefined).then(() => this.write(force));
    this.running = next;
    void next.finally(() => { if (this.running === next) this.running = undefined; }).catch(() => undefined);
    return next;
  }

  private async write(force: boolean): Promise<SnapshotInfo | undefined> {
    {
      try {
        const records = this.store.exportRecords();
        const assets = snapshotAssetIDs(records).map((id) => ({ id, read: async () => { const f = this.assets.locate(id); return f ? new Uint8Array(await readFile(f.path)) : undefined; } }));
        const info = await writeSnapshot(this.target, { records, workspaceName: this.store.workspace.name, assets, ...(this.digest !== undefined ? { previousDigest: this.digest } : {}), force, cache: this.assetCache });
        if (info) {
          this.digest = info.digest;
          this.last = { at: info.at, name: info.name };
          await pruneBackups(this.target, undefined, this.assetCache);
          this.log.info("backup written", { records: info.records, assets: info.assetsWritten, missing: info.missing.length });
        }
        this.lastError = undefined;
        return info;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log.warning("backup failed", { error: e instanceof Error ? e.name : "unknown" });
        throw e;
      }
    }
  }

  list() { return listSnapshots(this.target); }

  async preview(name: string) {
    return planRestore(this.store, (await readSnapshot(this.target, name)).records).pages;
  }

  /** Wiederherstellen (ersetzen). Vorher wird der aktuelle Stand gesichert – so ist es selbst rückgängig zu machen. */
  async restore(name: string): Promise<{ before: string | undefined; pages: { added: number; changed: number; removed: number } }> {
    const read = await readSnapshot(this.target, name);
    const before = await this.snapshot(true);
    const plan = planRestore(this.store, read.records);
    // fehlende Dateien aus dem Backup zurück in den Asset-Speicher
    for (const id of snapshotAssetIDs(read.records)) {
      if (!/^[0-9a-f]{64}$/.test(id) || this.assets.locate(id)) continue;
      const data = await this.target.read(`assets/${id}`).catch(() => undefined);
      if (data) await this.assets.write(id, 0, data.length, Buffer.from(data)).catch(() => undefined);
    }
    applyRestore(this.store, plan);
    this.digest = undefined;
    this.log.info("backup restored", { added: plan.pages.added, removed: plan.pages.removed });
    return { before: before?.name, pages: plan.pages };
  }
}
