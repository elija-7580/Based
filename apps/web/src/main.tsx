// BSD-153: Start der Web-Shell. Der Store läuft in einem Dedicated Worker (SQLite-WASM auf OPFS); die UI spricht mit
// ihm über StoreClient. Gerätekennung und Sync-Server liegen im localStorage des Hauptthreads.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyAppearance, loadAppearance } from "./appearance.js";
import { startDesktop } from "./desktop.js";
import { History } from "./shell/router.js";
import { deviceNode, recentPages, syncConfig } from "./shell/storage.js";
import { StoreClient } from "./worker/client.js";
import type { Endpoint, Event, RequestMessage } from "./worker/protocol.js";
import "./styles.css";
import { ShellDatabaseView } from "./databaseSlot.js";
import { ShellPageEditor } from "./editorSlot.js";
import { registerSlots } from "./slots.js";

registerSlots({ PageEditor: ShellPageEditor, DatabaseView: ShellDatabaseView });

// Vor dem ersten Rendern setzen, damit Dunkel nicht hell aufblitzt.
applyAppearance(loadAppearance());
// BSD-164: in der Tauri-Hülle Titelleiste und Updates (im Browser ohne Wirkung).
void startDesktop().catch(() => undefined);

const worker = new Worker(new URL("./worker/store.worker.ts", import.meta.url), { type: "module", name: "based-store" });
const client = new StoreClient(worker as unknown as Endpoint<Event, RequestMessage>);
client.onDevice = deviceNode.set;
const history = new History();

const device = deviceNode.get();
const sync = syncConfig.get();
void client
  .init({ opfs: "based.sqlite", ...(device ? { device } : {}), ...(sync ? { sync } : {}) })
  .then((r) => {
    if (r.created && r.homePageID) recentPages.touch(r.homePageID);
  })
  .catch(() => undefined);

// Für E2E-Tests und Messungen (Playwright): Zugriff auf Client und Verlauf.
(globalThis as { __based?: unknown }).__based = { client, history };

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt");
createRoot(root).render(<StrictMode><App client={client} history={history} /></StrictMode>);
