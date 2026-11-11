// BSD-153: Start der Web-Shell. Der Store läuft in einem Dedicated Worker (SQLite-WASM auf OPFS); die UI spricht mit
// ihm über StoreClient. Mehrere Browser-Tabs: nur ein Tab startet den Worker, die anderen reden über ihn
// (worker/leader.ts). Gerätekennung im localStorage, Sync-Server verschlüsselt in IndexedDB (shell/secrets.ts).
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { appearanceStore, applyAppearance, effectiveTheme, onSystemThemeChange } from "./appearance.js";
import { isPageWindow, startDesktop } from "./desktop.js";
import { browserTabsStorage, History } from "./shell/router.js";
import { deviceNode, guestDeviceNode, recentPages, secretVault, startPage, syncConfig } from "./shell/storage.js";
import { fetchGuestMe, guestIDFromSearch, guestStartPage, loadGuest, parseShareFragment, rememberGuest, type GuestConfig, type GuestMe } from "./shell/guest.js";
import { memoryKV, SecretStore } from "./shell/secrets.js";
import { GuestRevoked } from "./shell/GuestRevoked.js";
import { StoreClient } from "./worker/client.js";
import { browserLinkOptions, StoreLink } from "./worker/leader.js";
import type { Endpoint, Event, RequestMessage } from "./worker/protocol.js";
// Astryx (meta/astryx): fertig gebaute Styles in eigenen Layern (reset → astryx-base → astryx-theme).
// Vor styles.css, damit die Based-Tokens und -Styles (ohne Layer) immer Vorrang haben.
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { astryxThemes } from "./astryxTheme.js";
import "./styles.css";
import { ShellDatabaseView } from "./databaseSlot.js";
import { connectAssets } from "./assetBridge.js";
import { connectEditor, ShellPageEditor } from "./editorSlot.js";
import { registerSlots } from "./slots.js";
import { registerSettingsSection } from "./screens/settings/registry.js";
import { bootMark, diagnosticsLog, installDiagnostics } from "./shell/diagnostics.js";

registerSlots({ PageEditor: ShellPageEditor, DatabaseView: ShellDatabaseView });
// BSD-227: Diagnose (Log, Fehler, Hänger, Sitzungs-Marke) so früh wie möglich.
installDiagnostics();
// Zeit bis hierher = Laden und Auswerten aller Skripte (die Importe oben laufen vor dieser Zeile).
bootMark("scripts loaded");

// Vor dem ersten Rendern setzen, damit Dunkel nicht hell aufblitzt.
applyAppearance(appearanceStore.get());

// BSD-235 Teil 2: Gast-Modus. `#/share/<Share-URL>` → Konfiguration verschlüsselt ablegen, auf `?guest=<id>` umleiten;
// `?guest=<id>` → eigener Store (Speicher), Sync mit dem Link-Geheimnis, Start auf der geteilten Seite.
interface GuestBoot { id: string; config: GuestConfig; me: GuestMe | undefined; start: string | undefined }

const share = parseShareFragment(location.hash);
if (share) {
  void rememberGuest(secretVault(), share).then(
    (id) => location.replace(`${location.pathname}?guest=${id}`),
    () => location.replace(location.pathname),
  );
} else {
  const id = guestIDFromSearch(location.search);
  if (!id) start(undefined);
  else {
    void loadGuest(secretVault(), id).then(async (config) => {
      if (!config) {
        // unbekannt (anderes Profil, gelöscht): normal starten
        history.replaceState(null, "", location.pathname);
        return start(undefined);
      }
      const me = await fetchGuestMe(config);
      if (me === "revoked") {
        // BSD-235 Teil 3: widerrufen/entfernt → Hinweis statt leerem Gast-Arbeitsbereich
        diagnosticsLog.add("warning", "guest link no longer works");
        return showGuestRevoked();
      }
      // Sync-Einstellungen des Gastes nur im Speicher – nie die des Besitzers überschreiben.
      syncConfig._use(new SecretStore(memoryKV()), { noMigrate: true });
      syncConfig.set({ url: config.server, token: config.secret });
      document.title = "Shared · Based";
      start({ id, config, me, start: guestStartPage(config, me) });
    });
  }
}

function showGuestRevoked() {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root fehlt");
  document.title = "Link no longer works · Based";
  const appearance = appearanceStore.get();
  createRoot(root).render(
    <StrictMode>
      <Theme theme={astryxThemes[appearance.density]} mode={effectiveTheme(appearance)}>
        <GuestRevoked onOpenBased={() => location.replace(location.pathname)} />
      </Theme>
    </StrictMode>,
  );
}

function start(guest: GuestBoot | undefined) {
  const devices = guest ? guestDeviceNode(guest.id) : deviceNode;
  const link = new StoreLink({
    ...browserLinkOptions(guest ? `based-guest-${guest.id}` : undefined),
    ...(guest ? { lockName: `based-guest-${guest.id}` } : {}),
    startStore() {
      const worker = new Worker(new URL("./worker/store.worker.ts", import.meta.url), { type: "module", name: "based-store" });
      return { endpoint: worker as unknown as Endpoint<Event, RequestMessage>, terminate: () => worker.terminate() };
    },
    async initParams() {
      // bei jeder Übernahme frisch: ein anderer Tab kann Server oder Gerätekennung inzwischen gesetzt haben
      const device = devices.get();
      const sync = await syncConfig.load();
      // BSD-235: ein Gast läuft nur im Speicher (der OPFS-Pool gehört dem Store-Tab des Besitzers) und synct mit dem Link.
      if (guest) return { ...(device ? { device } : {}), ...(sync ? { sync } : {}) };
      return { opfs: "based.sqlite", ...(device ? { device } : {}), ...(sync ? { sync } : {}) };
    },
  });
  const client = new StoreClient(link);
  // BSD-227: Wechsel des Sync-/Speicherzustands ins Diagnose-Log (Zustand und Fehlertext, geschwärzt).
  {
    let last = "";
    client.subscribe(() => {
      const whole = client.getState();
      bootMark("store answered");
      if (whole.ready && whole.outline) bootMark("store ready", `${Object.keys(whole.outline?.nodes ?? {}).length} pages`);
      const st = whole.status;
      const line = `${st.state}${st.detail ? ` · ${st.detail}` : ""}`;
      if (line === last) return;
      last = line;
      diagnosticsLog.add(st.state === "error" || st.state === "readonly" ? "error" : st.state === "offline" || st.state === "memory" ? "warning" : "info", `status: ${line}`);
    });
  }
  connectEditor(client);
  link.onReconnect = () => void client.resync();
  client.onDevice = devices.set;
  connectAssets(client);
  addEventListener("pagehide", (e: PageTransitionEvent) => {
    // nicht beim Wechsel in den Back-Forward-Cache: dann kommt der Tab ggf. zurück
    if (!e.persisted) link.leave();
  });
  // Startseite: selbst gewählte Seite (Einstellungen → My settings → Start page) oder Home.
  // BSD-202: ein eigenes Seitenfenster hat nur seinen eigenen Verlauf (die Tabs des Hauptfensters bleiben unberührt).
  const history = new History(window, browserTabsStorage({ shared: !isPageWindow() && !guest }), () => {
    const id = guest ? guest.start : startPage.get();
    return id ? { name: "page", id } : { name: "home" };
  });
  // BSD-164: in der Tauri-Hülle Titelleiste, Updates und ⌘W aus dem Menü (im Browser ohne Wirkung).
  void startDesktop(() => history.close()).catch(() => undefined);

  // Startwerte holt der Store-Tab selbst (initParams); `init` verbindet nur.
  void client
    .init({})
    .then((r) => {
      if (r.created && r.homePageID) recentPages.touch(r.homePageID);
    })
    .catch(() => undefined);

  // Für E2E-Tests und Messungen (Playwright): Zugriff auf Client, Verlauf und Tab-Verbindung.
  (globalThis as { __based?: unknown }).__based = { client, history, link, registerSettingsSection, guest: guest ? { id: guest.id, server: guest.config.server, me: guest.me } : undefined };

  /**
   * Astryx folgt dem Appearance-Umschalter: Hell/Dunkel über `mode` (Astryx setzt damit selbst `data-theme` am
   * Wurzelelement – derselbe Wert wie applyAppearance), Dichte über das Theme. Stil Bold wirkt über die
   * Schrift-Variablen aus tokens.css; Marker und Calm berühren Astryx nicht (der Marker ist kein Theme-Wert).
   */
  function Root() {
    const appearance = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get);
    const [, bump] = useState(0);
    useEffect(() => bootMark("first render"), []);
    useEffect(() => (appearance.theme === "system" ? onSystemThemeChange(() => bump((n) => n + 1)) : undefined), [appearance.theme]);
    return (
      <Theme theme={astryxThemes[appearance.density]} mode={effectiveTheme(appearance)}>
        <App client={client} history={history} />
      </Theme>
    );
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("#root fehlt");
  // Sync-Server erst aus IndexedDB lesen (wenige ms), damit die Einstellungen ihn beim ersten Zeichnen kennen.
  bootMark("shell started");
  void syncConfig.load().finally(() => {
    bootMark("settings read");
    createRoot(root).render(<StrictMode><Root /></StrictMode>);
  });
}
