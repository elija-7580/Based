/// <reference lib="webworker" />
// BSD-78: Blob-Speicher für Dateien im OPFS (Ordner `assets/`, Dateiname = SHA-256). Läuft im Store-Worker.
// Schreiben über `createSyncAccessHandle` (Safari kennt im Worker nur das), sonst `createWritable`.
import { isAssetHash, type AssetBlobStore } from "@based/sync";

type SyncHandle = { write(data: Uint8Array, opts?: { at: number }): number; truncate(size: number): void; flush(): void; close(): void };
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };

export async function openOpfsAssets(dirName = "assets"): Promise<AssetBlobStore> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  const handle = async (hash: string, create = false): Promise<FileHandle | undefined> => {
    if (!isAssetHash(hash)) return undefined;
    try {
      return (await dir.getFileHandle(hash, { create })) as FileHandle;
    } catch {
      return undefined;
    }
  };
  return {
    async has(hash) {
      return (await handle(hash)) !== undefined;
    },
    async get(hash) {
      const h = await handle(hash);
      if (!h) return undefined;
      return new Uint8Array(await (await h.getFile()).arrayBuffer());
    },
    async put(hash, bytes) {
      // Erst unter einem Zwischennamen schreiben wäre sicherer gegen Abbruch; OPFS kennt kein Umbenennen überall.
      // Deshalb prüft `AssetSync` beim Lesen nichts nach – ein halb geschriebener Blob fällt beim Upload auf (422).
      const h = await handle(hash, true);
      if (!h) throw new Error("invalid asset id");
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
    async delete(hash) {
      if (!isAssetHash(hash)) return;
      await dir.removeEntry(hash).catch(() => undefined);
    },
    async list() {
      const out: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (isAssetHash(name)) out.push(name);
      return out;
    },
  };
}
