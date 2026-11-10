/// <reference lib="webworker" />
// BSD-153: Dedicated Worker mit dem Store. SQLite-WASM auf OPFS (opfs-sahpool); geht das nicht (kein OPFS, privates
// Fenster, Datei schon in einem anderen Tab offen), läuft der Workspace im Speicher und der Status sagt es.
import { openWorkspace, SqliteHistoryStorage } from "@based/sync";
import { openWasmDatabase } from "@based/sync/wasm";
import { IDBAssetStore } from "./assets.js";
import { StoreHost } from "./host.js";
import { openOpfsAssets } from "./opfsAssets.js";
import type { Event, RequestMessage } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

const host = new StoreHost({
  post: (e: Event) => self.postMessage(e),
  online: () => self.navigator.onLine,
  importedAssets: new IDBAssetStore(),
  async open({ device, opfs }) {
    if (opfs) {
      try {
        // Übernahme von einem geschlossenen Tab (tabs.ts): dessen Worker gibt die Datei erst kurz nach dem Lock frei.
        const db = await openWasmDatabase({ opfs, waitMs: 5000 });
        return { ...openWorkspace(db, { device }), persistent: true, ...(await openHistory()), ...(await openAssets()) };
      } catch (e) {
        const note = `Not saved on this device: ${e instanceof Error ? e.message : String(e)}`;
        const db = await openWasmDatabase();
        return { ...openWorkspace(db, { device }), persistent: false, note };
      }
    }
    const db = await openWasmDatabase();
    return { ...openWorkspace(db, { device }), persistent: false, note: "In memory only" };
  },
});

/** Versionsverlauf in history.sqlite neben dem Workspace (wie die Swift-App); geht das nicht, im Speicher. */
async function openHistory() {
  try {
    return { history: new SqliteHistoryStorage(await openWasmDatabase({ opfs: "history.sqlite" })) };
  } catch {
    return {};
  }
}

/** Dateien im OPFS-Ordner `assets/` (BSD-78); geht das nicht, im Speicher (bis zum Neuladen). */
async function openAssets() {
  try {
    return { assets: await openOpfsAssets() };
  } catch {
    return {};
  }
}

// Nachrichten der Reihe nach: `init` ist asynchron, alles danach wartet darauf.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (e: MessageEvent<RequestMessage>) => {
  const msg = e.data;
  queue = queue.then(() => host.handle(msg));
});
self.addEventListener("online", () => void host.handle({ id: -1, type: "syncNow" }));
