// BSD-418: Marker laufender Hänger – der Watchdog-Worker schreibt (localStorage gibt es im Worker nicht), der Hauptthread
// liest beim nächsten Start. Ein Marker je Sitzung (Tab). Zuerst OPFS mit synchronem Zugriff (eine Datei je Sitzung,
// beim Start des Workers geöffnet): WebKit leitet IndexedDB aus Workern über den Hauptthread – während eines Hängers
// käme dort nichts an. IndexedDB nur als Ersatz, wo es keinen synchronen OPFS-Zugriff gibt. Fehler werden geschluckt:
// ohne Speicher gibt es nur keinen Hinweis nach einem Hänger.
import { parseHangMarker, type HangMarker } from "@based/core/hangs";

const DB = "based-diagnostics";
const STORE = "hang-markers";
let db: Promise<IDBDatabase | undefined> | undefined;

function open(): Promise<IDBDatabase | undefined> {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "session" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return db;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  const d = await open();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const t = d.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const putMarker = (m: HangMarker) => tx("readwrite", (s) => s.put(m));
export const deleteMarker = (session: string) => tx("readwrite", (s) => s.delete(session));

// MARK: OPFS

const DIR = "based-diagnostics";
const EMPTY_KEEP_MS = 2 * 24 * 3600_000;
const fileName = (session: string) => `hang-${session.replace(/[^\w-]/g, "")}.json`;

interface SyncHandle { truncate(n: number): void; write(b: Uint8Array, o?: { at: number }): number; flush(): void; close(): void }

/** Im Worker: Marker-Datei der Sitzung mit synchronem Zugriff öffnen (undefined: nicht möglich → IndexedDB). */
export async function openMarkerFile(session: string): Promise<{ write(m: HangMarker): void; clear(): void } | undefined> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const file = await dir.getFileHandle(fileName(session), { create: true }) as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };
    if (!file.createSyncAccessHandle) return undefined;
    const h = await file.createSyncAccessHandle();
    const enc = new TextEncoder();
    return {
      write: (m) => { try { h.truncate(0); h.write(enc.encode(JSON.stringify(m)), { at: 0 }); h.flush(); } catch { /* voll */ } },
      clear: () => { try { h.truncate(0); h.flush(); } catch { /* weg */ } },
    };
  } catch {
    return undefined;
  }
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  } catch {
    return undefined;
  }
}

/** Im Hauptthread: Marker aus OPFS; leere Dateien fremder, beendeter Sitzungen werden aufgeräumt. */
async function readOPFS(mine: string): Promise<HangMarker[]> {
  const dir = await opfsDir();
  if (!dir) return [];
  const out: HangMarker[] = [];
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "file" || !name.startsWith("hang-") || name === fileName(mine)) continue;
    try {
      const f = await (handle as FileSystemFileHandle).getFile();
      const text = await f.text();
      const m = text ? parseHangMarker(JSON.parse(text)) : undefined;
      if (m) out.push(m);
      // leer: Sitzung ohne Hänger. Erst nach zwei Tagen weg – die Datei eines offenen Tabs bleibt so beschreibbar.
      else if (Date.now() - f.lastModified > EMPTY_KEEP_MS) await dir.removeEntry(name).catch(() => undefined);
    } catch { /* gesperrt (anderer Tab) oder kaputt */ }
  }
  return out;
}

/** Alle Marker anderer Sitzungen (OPFS und IndexedDB). */
export async function readMarkers(mine: string): Promise<HangMarker[]> {
  const idb = ((await tx("readonly", (s) => s.getAll() as IDBRequest<unknown[]>)) ?? []).map(parseHangMarker).filter((m): m is HangMarker => !!m);
  return [...(await readOPFS(mine)), ...idb.filter((m) => m.session !== mine)];
}

/** Übernommenen Marker entfernen (beide Speicher). */
export async function removeMarker(session: string) {
  await deleteMarker(session);
  const dir = await opfsDir();
  await dir?.removeEntry(fileName(session)).catch(() => undefined);
}
