// BSD-153: Start der Web-Shell. Der Store läuft in einem Dedicated Worker (SQLite-WASM auf OPFS); die UI spricht mit
// ihm über StoreClient. Mehrere Browser-Tabs: nur ein Tab startet den Worker, die anderen reden über ihn
// (worker/leader.ts). Gerätekennung im localStorage, Sync-Server verschlüsselt in IndexedDB (shell/secrets.ts).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyAppearance, loadAppearance } from "./appearance.js";
import { startDesktop } from "./desktop.js";
import { History } from "./shell/router.js";
import { deviceNode, recentPages, syncConfig } from "./shell/storage.js";
import { StoreClient } from "./worker/client.js";
import { browserLinkOptions, StoreLink } from "./worker/leader.js";
import type { Endpoint, Event, RequestMessage } from "./worker/protocol.js";
// Astryx (meta/astryx): fertig gebaute Styles in eigenen Layern (reset → astryx-base → astryx-theme).
// Vor styles.css, damit die Based-Tokens und -Styles (ohne Layer) immer Vorrang haben.
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { astryxTheme } from "./astryxTheme.js";
import "./styles.css";
import { ShellDatabaseView } from "./databaseSlot.js";
import { connectAssets } from "./assetBridge.js";
import { ShellPageEditor } from "./editorSlot.js";
import { registerSlots } from "./slots.js";

registerSlots({ PageEditor: ShellPageEditor, DatabaseView: ShellDatabaseView });

// Vor dem ersten Rendern setzen, damit Dunkel nicht hell aufblitzt.
applyAppearance(loadAppearance());
// BSD-164: in der Tauri-Hülle Titelleiste und Updates (im Browser ohne Wirkung).
void startDesktop().catch(() => undefined);

const link = new StoreLink({
  ...browserLinkOptions(),
  startStore() {
    const worker = new Worker(new URL("./worker/store.worker.ts", import.meta.url), { type: "module", name: "based-store" });
    return { endpoint: worker as unknown as Endpoint<Event, RequestMessage>, terminate: () => worker.terminate() };
  },
  async initParams() {
    // bei jeder Übernahme frisch: ein anderer Tab kann Server oder Gerätekennung inzwischen gesetzt haben
    const device = deviceNode.get();
    const sync = await syncConfig.load();
    return { opfs: "based.sqlite", ...(device ? { device } : {}), ...(sync ? { sync } : {}) };
  },
});
const client = new StoreClient(link);
link.onReconnect = () => void client.resync();
client.onDevice = deviceNode.set;
connectAssets(client);
addEventListener("pagehide", (e: PageTransitionEvent) => {
  // nicht beim Wechsel in den Back-Forward-Cache: dann kommt der Tab ggf. zurück
  if (!e.persisted) link.leave();
});
const history = new History();

// Startwerte holt der Store-Tab selbst (initParams); `init` verbindet nur.
void client
  .init({})
  .then((r) => {
    if (r.created && r.homePageID) recentPages.touch(r.homePageID);
  })
  .catch(() => undefined);

// Für E2E-Tests und Messungen (Playwright): Zugriff auf Client, Verlauf und Tab-Verbindung.
(globalThis as { __based?: unknown }).__based = { client, history, link };

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt");
// Sync-Server erst aus IndexedDB lesen (wenige ms), damit die Einstellungen ihn beim ersten Zeichnen kennen.
void syncConfig.load().finally(() => {
  createRoot(root).render(<StrictMode>
      <Theme theme={astryxTheme}>
        <App client={client} history={history} />
      </Theme>
    </StrictMode>);
});
