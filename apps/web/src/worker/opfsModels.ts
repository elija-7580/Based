/// <reference lib="webworker" />
// BSD-231 Teil 2b: Ablage für lokale Modelle (`localModels.LocalModelStore`) im OPFS, Ordner `models/<id>/<version>/…`.
// Dünne Hülle: Pfade sind schon geprüft (validateSpec), Größe und Prüfsumme prüft der LocalModelManager bei jedem
// Lesen – ein halb geschriebener File (Abbruch, volle Platte) gilt dort als „nicht installiert“ und wird neu geladen.
// Schreiben über `createSyncAccessHandle` (Safari kennt im Worker nur das), sonst `createWritable`.
import type { localModels } from "@based/brain";

type SyncHandle = { write(data: Uint8Array, opts?: { at: number }): number; truncate(size: number): void; flush(): void; close(): void };
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };

/** Ordner- und Dateiname eines Speicherpfads; `undefined` bei leeren oder „..“-Teilen. */
export function splitModelPath(path: string): { dirs: string[]; name: string } | undefined {
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  const name = parts.pop()!;
  return { dirs: parts, name };
}

export function opfsModelStore(root: FileSystemDirectoryHandle): localModels.LocalModelStore {
  const dirOf = async (dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | undefined> => {
    let d = root;
    try {
      for (const name of dirs) d = await d.getDirectoryHandle(name, { create });
      return d;
    } catch {
      return undefined;
    }
  };
  return {
    async get(path) {
      const p = splitModelPath(path);
      const dir = p && (await dirOf(p.dirs, false));
      if (!p || !dir) return undefined;
      try {
        const h = await dir.getFileHandle(p.name);
        return new Uint8Array(await (await h.getFile()).arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(path, bytes) {
      const p = splitModelPath(path);
      if (!p) throw new Error(`invalid model path ${path}`);
      const dir = await dirOf(p.dirs, true);
      if (!dir) throw new Error(`can't create folder for ${path}`);
      const h = (await dir.getFileHandle(p.name, { create: true })) as FileHandle;
      if (h.createSyncAccessHandle) {
        const access = await h.createSyncAccessHandle();
        try {
          access.truncate(0);
          access.write(bytes, { at: 0 });
          access.flush();
        } finally {
          access.close();
        }
      } else {
        const w = await h.createWritable();
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
      }
    },
    async delete(path) {
      const p = splitModelPath(path);
      const dir = p && (await dirOf(p.dirs, false));
      if (!p || !dir) return;
      await dir.removeEntry(p.name).catch(() => undefined);
    },
  };
}

/** Modell-Ablage des Browsers (OPFS-Ordner `models`). */
export async function openOpfsModels(dirName = "models"): Promise<localModels.LocalModelStore> {
  const root = await navigator.storage.getDirectory();
  return opfsModelStore(await root.getDirectoryHandle(dirName, { create: true }));
}
