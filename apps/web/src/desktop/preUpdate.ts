// BSD-456: Sicherung vor jedem App-Update (auch ohne lokalen Server). Logik in @based/core (`writePreUpdateBackup`);
// hier nur der Dateizugriff der Hülle: ~/Library/Application Support/<bundle-id>/pre-update (BaseDirectory.AppData –
// je App getrennt, Based Beta und Based Next kommen sich nicht in die Quere). Rechte: capabilities/default.json
// ($APPDATA/pre-update). Geschrieben wird atomar (.tmp, dann umbenennen).
import { PRE_UPDATE_DIR, type BackupTarget, type PreUpdateResult, writePreUpdateBackup } from "@based/core";

/** Archiv des ganzen Workspaces (main.tsx setzt es: Store-Tab → „Export → Based archive“). */
let archiveSource: (() => Promise<Uint8Array>) | undefined;
export function setPreUpdateArchive(source: (() => Promise<Uint8Array>) | undefined): void {
  archiveSource = source;
}

/** Dateizugriff im pre-update-Ordner der App (Tauri fs). */
export async function tauriPreUpdateTarget(): Promise<BackupTarget> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { BaseDirectory } = await import("@tauri-apps/api/path");
  const baseDir = BaseDirectory.AppData;
  const at = (p: string) => (p ? `${PRE_UPDATE_DIR}/${p}` : PRE_UPDATE_DIR);
  return {
    async list() {
      if (!(await fs.exists(PRE_UPDATE_DIR, { baseDir }))) return [];
      return (await fs.readDir(PRE_UPDATE_DIR, { baseDir })).filter((e) => e.isFile).map((e) => e.name);
    },
    exists: (p) => fs.exists(at(p), { baseDir }),
    async write(p, data) {
      await fs.mkdir(PRE_UPDATE_DIR, { baseDir, recursive: true });
      const tmp = `${at(p)}.tmp`;
      await fs.writeFile(tmp, data, { baseDir });
      await fs.rename(tmp, at(p), { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
    },
    read: (p) => fs.readFile(at(p), { baseDir }),
    remove: (p) => fs.remove(at(p), { baseDir }),
  };
}

/** Vor dem Installieren: Sicherung schreiben. Ohne Archivquelle (z. B. Gast-Tab) gilt das als Fehler. */
export async function backupBeforeUpdate(from: string, to: string, target?: BackupTarget): Promise<PreUpdateResult> {
  const source = archiveSource;
  if (!source) return { ok: false, message: "The workspace isn't open in this window" };
  try {
    return await writePreUpdateBackup(target ?? (await tauriPreUpdateTarget()), { archive: source, from, to });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
