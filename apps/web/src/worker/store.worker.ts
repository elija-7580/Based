/// <reference lib="webworker" />
// BSD-153: Dedicated Worker mit dem Store. SQLite-WASM auf OPFS (opfs-sahpool); geht das nicht (kein OPFS, privates
// Fenster, Datei schon in einem anderen Tab offen), läuft der Workspace im Speicher und der Status sagt es.
import { openBlockedMessage, openWorkspace, SqliteHistoryStorage, SqliteYDocStorage } from "@based/sync";
import { openWasmDatabase } from "@based/sync/wasm";
import { IDBAssetStore } from "./assets.js";
import { StoreHost } from "./host.js";
import { openOpfsAssets } from "./opfsAssets.js";
import { openOpfsModels } from "./opfsModels.js";
import type { Event, RequestMessage } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

const host = new StoreHost({
  post: (e: Event) => self.postMessage(e),
  online: () => self.navigator.onLine,
  importedAssets: new IDBAssetStore(),
  // BSD-231: lokale Modelle im OPFS-Ordner `models` (geladen wird nur mit Einwilligung)
  openModels: () => openOpfsModels(),
  async open({ device, opfs, propertyRecords, lazy }) {
    // BSD-30: nur einschalten, nie ausschalten – eine umgestellte Datei bleibt es (openWorkspace)
    const mode = propertyRecords ? { propertyRecords: true } : {};
    if (opfs) {
      try {
        // Übernahme von einem geschlossenen Tab (tabs.ts): dessen Worker gibt die Datei erst kurz nach dem Lock frei.
        const db = await openWasmDatabase({ opfs, waitMs: 5000 });
        const storageWarnings: string[] = [];
        const opened = { ...openWorkspace(db, { device, ...mode, lazy: lazy === true }), persistent: true, ...(await openHistory(storageWarnings)), ...(await openAssets(storageWarnings)), ...(await openYDocs(storageWarnings)) };
        return storageWarnings.length ? { ...opened, storageWarnings } : opened;
      } catch (e) {
        // Eine Datei aus einer neueren Version (oder eine, deren Umstellung scheiterte) wird nicht durch einen leeren
        // Workspace im Speicher ersetzt – das sähe aus wie Datenverlust und legte eine Willkommensseite an. Die Datei
        // bleibt unberührt; die App sagt, was zu tun ist („Based couldn't open your workspace“).
        const blocked = openBlockedMessage(e);
        if (blocked) throw new Error(blocked);
        const note = `Not saved on this device: ${e instanceof Error ? e.message : String(e)}`;
        const db = await openWasmDatabase();
        return { ...openWorkspace(db, { device, ...mode }), persistent: false, note };
      }
    }
    const db = await openWasmDatabase();
    return { ...openWorkspace(db, { device, ...mode }), persistent: false, note: "In memory only" };
  },
});

// BSD-330: Geht eine Nebendatei nicht dauerhaft auf, läuft sie im Speicher – aber nie still: `warnings` bekommt einen
// Satz, den Status, Einstellungen und ein Hinweis zeigen (vorher fielen history.sqlite/ydocs.sqlite unbemerkt zurück).
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
/** Test-Haken (main.tsx, ?based-fail-store=…): diese Datei absichtlich nicht öffnen. */
const forced = (name: string) => self.name === `based-store fail-${name}`;

/** Versionsverlauf in history.sqlite neben dem Workspace (wie die Swift-App); geht das nicht, im Speicher. */
async function openHistory(warnings: string[]) {
  try {
    if (forced("history")) throw new Error("forced by test");
    return { history: new SqliteHistoryStorage(await openWasmDatabase({ opfs: "history.sqlite" })) };
  } catch (e) {
    warnings.push(`Version history is kept in memory only (history.sqlite: ${reason(e)}).`);
    return {};
  }
}

/** BSD-220: Y-Zustände in ydocs.sqlite neben dem Workspace (nie gesynct); geht das nicht, im Speicher. */
async function openYDocs(warnings: string[]) {
  try {
    if (forced("ydocs")) throw new Error("forced by test");
    return { ydocs: new SqliteYDocStorage(await openWasmDatabase({ opfs: "ydocs.sqlite" })) };
  } catch (e) {
    warnings.push(`Live editing state is kept in memory only (ydocs.sqlite: ${reason(e)}).`);
    return {};
  }
}

/** Dateien im OPFS-Ordner `assets/` (BSD-78); geht das nicht, im Speicher (bis zum Neuladen). */
async function openAssets(warnings: string[]) {
  try {
    return { assets: await openOpfsAssets() };
  } catch (e) {
    warnings.push(`Files you add are kept in memory only (assets: ${reason(e)}).`);
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
