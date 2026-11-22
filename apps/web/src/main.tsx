import { authorID } from "@based/core";
import { askUser } from "./shell/prompts.js";
// BSD-153: Start der Web-Shell. Der Store läuft in einem Dedicated Worker (SQLite-WASM auf OPFS); die UI spricht mit
// ihm über StoreClient. Mehrere Browser-Tabs: nur ein Tab startet den Worker, die anderen reden über ihn
// (worker/leader.ts). Gerätekennung im localStorage, Sync-Server verschlüsselt in IndexedDB (shell/secrets.ts).
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { appearanceStore, applyAppearance, effectiveTheme, onSystemThemeChange } from "./appearance.js";
import { desktopClipboard, desktopSpelling, isPageWindow, isTauri, startDesktop } from "./desktop.js";
import { browserTabsStorage, History } from "./shell/router.js";
import { deviceNode, guestDeviceNode, lazyStoreSetting, propertyRecordsSetting, recentPages, secretVault, startPage, syncConfig } from "./shell/storage.js";
import { fetchGuestMe, guestIDFromSearch, guestStartPage, loadGuest, parseShareFragment, rememberGuest, setGuestAccess, watchGuestRevocation, type GuestConfig, type GuestMe } from "./shell/guest.js";
import { memoryKV, SecretStore } from "./shell/secrets.js";
import { GuestRevoked } from "./shell/GuestRevoked.js";
import { firstRun } from "./shell/firstRun.js";
import { ANY_APP, isPromptWindow } from "./meeting/detect.js";
import { installBrowserKeep } from "./shell/storagePersist.js";
import { installSelectAll } from "./shell/selectAll.js";
import { installWheelLatch } from "./shell/wheelLatch.js";
import { StoreClient } from "./worker/client.js";

/** BSD-416: Journal unbestätigter Editor-Änderungen (localStorage; gesperrt → ohne). */
const journalStorage = () => { try { return globalThis.localStorage ?? undefined; } catch { return undefined; } };
import { browserLinkOptions, StoreLink } from "./worker/leader.js";
import type { Endpoint, Event, RequestMessage } from "./worker/protocol.js";
// Astryx (meta/astryx): fertig gebaute Styles in eigenen Layern (reset → astryx-base → astryx-theme).
// Vor styles.css, damit die Based-Tokens und -Styles (ohne Layer) immer Vorrang haben.
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { astryxThemes } from "./astryxTheme.js";
import "./styles.css";
import { waitForBasedFonts } from "./fonts.js";
// Nichts vom System: eigenes Kontextmenü, eigene Auswahllisten und Tooltips im ganzen Fenster (@based/ui/native).
import "@based/ui/native.css";
import { installNativeFree } from "@based/ui/native";
import { iconElement } from "./icons.js";
import { ShellDatabaseView } from "./databaseSlot.js";
import { connectAssets } from "./assetBridge.js";
import { connectEditor, ShellPageEditor } from "./editorSlot.js";
import { registerSlots } from "./slots.js";
import { registerSettingsSection } from "./screens/settings/registry.js";
import { bootMark, diagnosticsLog, installDiagnostics, noteActivity } from "./shell/diagnostics.js";
import { armHangWatch, installHangMonitor, noteStoreBusy, noteStoreRequest } from "./shell/hangs.js";
import { installUnloadGuard } from "./shell/unloadGuard.js";
import { exposeReplayHooks, installBugRecorder } from "./shell/bugReport.js";
import { installReportOutbox } from "./shell/reportSend.js";

registerSlots({ PageEditor: ShellPageEditor, DatabaseView: ShellDatabaseView });
// Vor dem ersten Rendern, damit kein Rechtsklick und kein Auswahlfeld je die Systemoberfläche zeigt. Nur beim
// Entwickeln öffnet ⌥⇧-Rechtsklick das Systemmenü (Web-Inspektor).
{
  const clipboard = desktopClipboard();
  const spelling = desktopSpelling();
  installNativeFree({ icon: iconElement, ...(clipboard ? { clipboard } : {}), ...(spelling ? { spelling } : {}), ...(import.meta.env.DEV ? { allowNative: (e: MouseEvent) => e.altKey && e.shiftKey } : {}) });
}
// BSD-374: Scroll-Gesten bleiben am Bereich, in dem sie begonnen haben (innere Felder fangen sie nicht ab).
installWheelLatch();
// Das Meeting-Fenster (Feedback 18. 11.) bekommt keine eigene Diagnose: es würde die Sitzungs-Marke des Hauptfensters
// überschreiben, und sein Schließen sähe wie ein Absturz aus.
if (!isPromptWindow()) {
  // BSD-227: Diagnose (Log, Fehler, Hänger, Sitzungs-Marke) so früh wie möglich.
  installDiagnostics();
  // BSD-418: Hänger ab 250 ms mit Ursache, Breadcrumbs und Watchdog-Worker (ersetzt den 2-s-Detektor).
  installHangMonitor();
  // BSD-319: Editor-Aufzeichnung für „Problem melden“ (Ringpuffer im Speicher, immer an) und Haken für die Wiedergabe.
  installBugRecorder();
  exposeReplayHooks();
  // BSD-632: Berichte, die beim „Send to Based“ nicht ankamen, nach dem Start bzw. wieder online erneut senden.
  installReportOutbox();
}
// Zeit bis hierher = Laden und Auswerten aller Skripte (die Importe oben laufen vor dieser Zeile).
bootMark("scripts loaded");

// Vor dem ersten Rendern setzen, damit Dunkel nicht hell aufblitzt.
applyAppearance(appearanceStore.get());
// Font „Based“: Dateien jetzt anstoßen (parallel zum Start); gezeichnet wird erst, wenn sie da sind – höchstens
// 800 ms –, damit der erste Text nicht in der Ersatzschrift erscheint und dann umspringt (fonts.ts).
const fontsBeforeFirstPaint = appearanceStore.get().font === "based" ? waitForBasedFonts(800) : Promise.resolve();

// BSD-235 Teil 2: Gast-Modus. `#/share/<Share-URL>` → Konfiguration verschlüsselt ablegen, auf `?guest=<id>` umleiten;
// `?guest=<id>` → eigener Store (Speicher), Sync mit dem Link-Geheimnis, Start auf der geteilten Seite.
interface GuestBoot { id: string; config: GuestConfig; me: GuestMe | undefined; start: string | undefined }

const share = parseShareFragment(location.hash);
if (isPromptWindow()) {
  // Feedback 18. 11.: kleines Fenster „Meeting detected“ – nur dieses, ohne Speicher-Worker und ohne Tabs.
  void showMeetingPrompt();
} else if (share) {
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

async function showMeetingPrompt() {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root fehlt");
  document.documentElement.classList.add("meeting-prompt-window");
  const { MeetingPrompt } = await import("./meeting/MeetingPrompt.js");
  const app = new URLSearchParams(location.search).get("app") ?? ANY_APP;
  const appearance = appearanceStore.get();
  createRoot(root).render(
    <StrictMode>
      <Theme theme={astryxThemes[appearance.density]} mode={effectiveTheme(appearance)}>
        <MeetingPrompt app={app} />
      </Theme>
    </StrictMode>,
  );
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

/** BSD-30: Spricht der Server Protokoll 3 (Properties als eigene Records)? Ohne Antwort: unbekannt. */
async function serverUsesPropertyRecords(url: string): Promise<boolean | undefined> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/health`);
    if (!r.ok) return undefined;
    return ((await r.json()) as { protocol?: unknown }).protocol === 3;
  } catch {
    return undefined;
  }
}

/**
 * BSD-569: Format für diesen Start. Eine neue, leere Datei beginnt im neuen Format (entscheidet der Worker, wenn hier
 * nichts steht). Antwortet der eingestellte Server noch im alten, bleibt auch ein neues Gerät dabei – sonst könnte es
 * nicht mit ihm syncen. Eine schon umgestellte Datei bleibt in jedem Fall umgestellt.
 */
async function propertyRecordsMode(syncURL: string | undefined, wanted: boolean): Promise<{ propertyRecords?: boolean }> {
  if (wanted) return { propertyRecords: true };
  if (propertyRecordsSetting.pinnedOld()) return { propertyRecords: false };
  if (syncURL === undefined) return {};
  const server = await serverUsesPropertyRecords(syncURL);
  return server === false ? { propertyRecords: false } : {};
}

function start(guest: GuestBoot | undefined) {
  if (guest) setGuestAccess(guest.me);
  const devices = guest ? guestDeviceNode(guest.id) : deviceNode;
  const link = new StoreLink({
    ...browserLinkOptions(guest ? `based-guest-${guest.id}` : undefined),
    ...(guest ? { lockName: `based-guest-${guest.id}` } : {}),
    startStore() {
      // BSD-330 (Test-Haken): ?based-fail-store=history|ydocs lässt diese Nebendatei absichtlich in den Speicher fallen.
      const fail = new URLSearchParams(location.search).get("based-fail-store");
      const worker = new Worker(new URL("./worker/store.worker.ts", import.meta.url), { type: "module", name: fail && /^(history|ydocs)$/.test(fail) ? `based-store fail-${fail}` : "based-store" });
      return { endpoint: worker as unknown as Endpoint<Event, RequestMessage>, terminate: () => worker.terminate() };
    },
    async initParams() {
      // bei jeder Übernahme frisch: ein anderer Tab kann Server oder Gerätekennung inzwischen gesetzt haben
      const device = devices.get();
      const sync = await syncConfig.load();
      // BSD-235: ein Gast läuft nur im Speicher (der OPFS-Pool gehört dem Store-Tab des Besitzers) und synct mit dem Link.
      // BSD-30: ein Gast richtet sich nach dem Server (sein Store lebt nur im Speicher und muss dessen Protokoll sprechen)
      // BSD-579: ein Gast schreibt nie als „me“ (das ist der Besitzer), sondern als Gast mit seinem Namen bzw. Link
      if (guest) return { userID: authorID({ kind: "guest", name: guest.me?.name || guest.id }), ...(device ? { device } : {}), ...(sync ? { sync } : {}), ...(sync ? { propertyRecords: (await serverUsesPropertyRecords(sync.url)) === true } : {}) };
      return { opfs: "based.sqlite", ...(device ? { device } : {}), ...(sync ? { sync } : {}), ...(await propertyRecordsMode(sync?.url, propertyRecordsSetting.get())), ...(lazyStoreSetting.get() ? { lazy: true } : {}) };
    },
  });
  const client = new StoreClient(link);
  client.onSlowRequest = noteStoreRequest;
  client.onBusy = noteStoreBusy;
  client.onWorkerMessage = armHangWatch;
  // BSD-235 Teil 3: Widerruf wirkt auch, während der Gast die Seite offen hat (Neuladen zeigt dann den Hinweis).
  const revocation = guest ? watchGuestRevocation(guest.config, () => { diagnosticsLog.add("warning", "guest link revoked while open"); location.reload(); }) : undefined;
  // BSD-227: Wechsel des Sync-/Speicherzustands ins Diagnose-Log (Zustand und Fehlertext, geschwärzt).
  {
    let last = "";
    client.subscribe(() => {
      const whole = client.getState();
      bootMark("store answered");
      if (whole.ready && whole.outline) bootMark("store ready", `${Object.keys(whole.outline?.nodes ?? {}).length} pages`);
      const st = whole.status;
      // BSD-330: Nebendateien nur im Speicher gehören ins Log (als Warnung), nicht nur in die Konsole
      const line = `${st.state}${st.detail ? ` · ${st.detail}` : ""}${st.storageWarnings?.length ? ` · ${st.storageWarnings.join(" ")}` : ""}`;
      if (line === last) return;
      // BSD-235 Teil 3: ein Sync-Fehler kann ein widerrufener Link sein – sofort nachsehen
      if (st.state === "error") revocation?.poke();
      last = line;
      diagnosticsLog.add(st.state === "error" || st.state === "readonly" ? "error" : st.state === "offline" || st.state === "memory" || st.storageWarnings?.length ? "warning" : "info", `status: ${line}`);
    });
  }
  // BSD-336: Neuladen/Schließen fragt nur nach, solange eine Änderung noch nicht beim Store-Tab gespeichert ist.
  installUnloadGuard(window, () => client.unsavedWrites);
  installSelectAll(window);
  connectEditor(client);
  link.onReconnect = () => void client.resync();
  client.onDevice = devices.set;
  connectAssets(client);
  addEventListener("pagehide", (e: PageTransitionEvent) => {
    // BSD-416: noch unbestätigte Editor-Änderungen sichern (der nächste Start holt sie nach, nur wo neuer)
    if (!guest) client.journalUnsaved(journalStorage());
    // nicht beim Wechsel in den Back-Forward-Cache: dann kommt der Tab ggf. zurück
    if (!e.persisted) link.leave();
  });
  // Startseite: selbst gewählte Seite (Einstellungen → My settings → Start page) oder Home.
  // BSD-202: ein eigenes Seitenfenster hat nur seinen eigenen Verlauf (die Tabs des Hauptfensters bleiben unberührt).
  const history = new History(window, browserTabsStorage({ shared: !isPageWindow() && !guest }), () => {
    const id = guest ? guest.start : startPage.get();
    return id ? { name: "page", id } : { name: "home" };
  });
  // BSD-368: Hänger und Herzschlag nennen nach dem Start die offene Ansicht (nur den Namen der Route, keine Inhalte).
  {
    let started = false;
    const note = () => started && noteActivity(`route ${history.route.name}`);
    history.subscribe(note);
    const off = client.subscribe(() => {
      const st = client.getState();
      if (!st.ready || !st.outline) return;
      started = true;
      note();
      off();
    });
  }
  // BSD-164: in der Tauri-Hülle Titelleiste, Updates und ⌘W aus dem Menü (im Browser ohne Wirkung).
  void startDesktop({ close: () => history.close(), count: () => history.tabs.length }).catch(() => undefined);
  // BSD-456: Sicherung vor App-Updates = Based-Archiv des ganzen Workspaces (nicht im Gast-Tab).
  if (isTauri() && !guest) void import("./desktop/preUpdate.js").then((m) => m.setPreUpdateArchive(async () => (await client.exportWorkspace("pre-update")).data));

  // Startwerte holt der Store-Tab selbst (initParams); `init` verbindet nur.
  void client
    .init({})
    .then((r) => {
      if (!guest) void client.replayJournal(journalStorage()).then((n) => { if (n > 0) diagnosticsLog.add("info", `restored ${n} unsaved change${n === 1 ? "" : "s"} from the last session`); }, () => undefined);
      if (r.created && r.homePageID) recentPages.touch(r.homePageID);
      // BSD-275: frischer Workspace → Willkommensbildschirm an Stelle von Home (nicht für Gäste, nicht in E2E-Browsern)
      if (!guest) firstRun.noteInit(r);
      // ADR 0017 A3: dauerhaften Speicher anfragen (nur im Browser, nur wenn wirklich im Browser gespeichert wird).
      if (!guest && !isTauri() && r.persistent) installBrowserKeep(window);
    })
    .catch(() => undefined);

  // Für E2E-Tests und Messungen (Playwright): Zugriff auf Client, Verlauf und Tab-Verbindung.
  (globalThis as { __based?: unknown }).__based = { client, history, link, registerSettingsSection, askUser, guest: guest ? { id: guest.id, server: guest.config.server, me: guest.me } : undefined };

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
  void Promise.all([syncConfig.load().catch(() => undefined), fontsBeforeFirstPaint]).finally(() => {
    bootMark("settings read");
    createRoot(root).render(<StrictMode><Root /></StrictMode>);
  });
}
