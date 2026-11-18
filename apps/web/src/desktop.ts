// BSD-164: apps/web in der Tauri-Hülle „Based Next“ (apps/desktop). Nur hier steht Tauri-spezifischer Code; im Browser
// tut nichts davon etwas (die Plugins werden erst bei Bedarf nachgeladen).
// - Titelleiste im Overlay-Stil: Platz für die Ampel-Knöpfe über der Seitenleiste und Zugflächen fürs Fenster.
// - Rückfragen und Hinweise sind Based-Dialoge (shell/prompts.ts), keine Systemdialoge.
// - Updates: beim Start still prüfen, über „Check for Updates…“ im App-Menü auch mit Antwort, wenn alles aktuell ist.
// Speicher: unverändert SQLite-WASM auf OPFS im Worker (siehe docs/desktop.md, „Speicher“).

import { checkReleasesFallback, fallbackText, isMissingUpdateManifest, releaseLine } from "./shell/updateFallback.js";
import { CHANNEL, productName } from "./shell/beta.js";
import { autoUpdatePref } from "./shell/storage.js";
import { closeTabAction } from "./shell/closeTab.js";
import { askUser, showMessage } from "./shell/prompts.js";
import type { ClipboardAccess, SpellingAccess } from "@based/ui/native";

/** BSD-319: Menü Hilfe → „Report a Problem…“ kommt als dieses Fenster-Ereignis an (App.tsx startet den Bericht). */
export const REPORT_PROBLEM_EVENT = "based:report-problem";

/** Läuft die Seite in der Tauri-Hülle? (Tauri 2 setzt `__TAURI_INTERNALS__` vor dem ersten Skript.) */
export function isTauri(g: object = globalThis): boolean {
  return "__TAURI_INTERNALS__" in g;
}

/** Setzt die Wurzel-Attribute für die Hülle und legt die Zugflächen der Titelleiste an. */
export function applyDesktopShell(root: HTMLElement = document.documentElement) {
  root.dataset.shell = "desktop";
  for (const part of ["sidebar", "top"]) {
    const strip = document.createElement("div");
    strip.className = `titlebar-drag titlebar-drag-${part}`;
    strip.setAttribute("data-tauri-drag-region", "");
    strip.setAttribute("aria-hidden", "true");
    document.body.appendChild(strip);
  }
}

let checking = false;

/** Name und Version dieser App, wie sie im Bundle stehen („Based Next“ 0.1.155, „Based Notes Beta“ 0.2.5). */
export interface AppIdentity { name: string; version: string }
let identity: Promise<AppIdentity> | undefined;
export function appIdentity(): Promise<AppIdentity> {
  identity ??= (async () => {
    const { getName, getVersion } = await import("@tauri-apps/api/app");
    const [name, version] = await Promise.all([getName(), getVersion()]);
    return { name, version };
  })();
  identity.catch(() => { identity = undefined; });
  return identity;
}

/** Antwort auf „Check for updates…“, wenn nichts Neueres da ist – immer mit der Version, die läuft. */
export function upToDateText(app: AppIdentity): string {
  return `You’re on the newest version: ${app.name} ${app.version}.`;
}

/** Längste Zeile der Notizen im Update-Dialog; längere enden mit „…“. */
export const UPDATE_NOTE_CHARS = 110;
/** Höchstens so viele Zeilen Notizen im Update-Dialog. */
export const UPDATE_NOTE_LINES = 8;

/**
 * BSD-168: Text des Update-Dialogs mit den Notizen aus latest.json. Elija 17.11.: kurz halten – höchstens 8 Zeilen,
 * jede höchstens 110 Zeichen (die Notizen kommen vom Server; der Dialog muss auch mit langen bedienbar bleiben).
 */
export function updatePrompt(version: string, current: string, notes?: string, name = "Based Next"): string {
  const lines = (notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => (l.length > UPDATE_NOTE_CHARS ? `${l.slice(0, UPDATE_NOTE_CHARS - 1).trimEnd()}…` : l));
  const shown = lines.slice(0, UPDATE_NOTE_LINES);
  const more = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more` : "";
  const body = shown.length ? `\n\nWhat’s new:\n${shown.join("\n")}${more}` : "";
  return `${name} ${version} is available (you have ${current}).${body}\n\nInstall it and restart now?`;
}

/** Fragt die next-Releases nach einer neueren Version; bei Ja: laden, installieren, neu starten. */
export async function checkForUpdates(opts: { interactive: boolean }) {
  if (checking) return;
  checking = true;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (opts.interactive) await showMessage(upToDateText(await appIdentity()), { title: "No update available" });
      return;
    }
    const yes = await askUser(updatePrompt(update.version, update.currentVersion, update.body, (await appIdentity()).name), {
      title: "Update available",
      okLabel: "Install and Restart",
      cancelLabel: "Later",
    });
    if (!yes) return;
    // BSD-456: vor dem Installieren den ganzen Workspace sichern (auch ohne lokalen Server); scheitert das, kein Update.
    const { backupBeforeUpdate } = await import("./desktop/preUpdate.js");
    const { preUpdateFailureText } = await import("@based/core");
    const { diagnosticsLog } = await import("./shell/diagnostics.js");
    const saved = await backupBeforeUpdate(update.currentVersion, update.version);
    if (!saved.ok) {
      diagnosticsLog.add("error", `pre-update backup failed: ${saved.message}`);
      await showMessage(preUpdateFailureText(saved.message), { title: "Update not installed" });
      return;
    }
    diagnosticsLog.add("info", `pre-update backup: ${saved.name} (${saved.records} records, ${saved.bytes} bytes)`);
    await update.downloadAndInstall();
    // Neustart nach dem Update ist ein gewolltes Ende – sonst meldete der nächste Start „didn't close normally“.
    const { markSessionEnd } = await import("./shell/diagnostics.js");
    markSessionEnd();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    // Ohne Netz oder ohne signiertes Release still bleiben; nur auf ausdrückliche Nachfrage melden.
    if (!opts.interactive) return;
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingUpdateManifest(message)) {
      // Noch kein signiertes Update-Paket (Secret fehlt): wenigstens sagen, ob eine neuere DMG bereitliegt.
      const app = await appIdentity();
      const line = releaseLine(CHANNEL);
      const found = await checkReleasesFallback(app.version, fetch, line.tagPrefix);
      const text = found.kind === "current" ? upToDateText(app) : fallbackText(app, found, line);
      await showMessage(text, { title: found.kind === "newer" ? "Update available" : "Updates" });
      return;
    }
    const app = await appIdentity().catch(() => undefined);
    await showMessage(`Could not check for updates${app ? ` (you have ${app.name} ${app.version})` : ""}: ${message}`, { title: "Update failed" });
  } finally {
    checking = false;
  }
}

/** Einstieg aus main.tsx: im Browser ohne Wirkung. */
export async function startDesktop(tabs?: { close: () => void; count: () => number }) {
  if (!isTauri()) return;
  applyDesktopShell();
  // BSD-202: Ereignisse nur für dieses Fenster (lib.rs schickt sie an das Fenster vorn), nicht an alle.
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = getCurrentWebviewWindow();
  const main = win.label === "main";
  if (main) await win.listen("desktop://check-updates", () => void checkForUpdates({ interactive: true }));
  // BSD-138: lokaler Server (falls eingeschaltet) und „Install Command Line Tool…“ – nur im Hauptfenster.
  if (main) {
    const { localServer } = await import("./desktop/localServer.js");
    void localServer().autostart();
    await win.listen("desktop://install-cli", () => void showCliInstall());
  }
  // ⌘W liegt im Menü (lib.rs, an das Fenster vorn). BSD-310: beim letzten Tab Seitenfenster schließen bzw.
  // Hauptfenster ausblenden, solange andere Fenster offen sind; nur im letzten Fenster zur Startseite.
  if (tabs) {
    await win.listen("desktop://close-tab", async () => {
      let visible = 0;
      if (tabs.count() <= 1) {
        const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
        for (const w of await getAllWebviewWindows().catch(() => [])) {
          if (w.label !== win.label && (await w.isVisible().catch(() => false))) visible += 1;
        }
      }
      const action = closeTabAction({ tabs: tabs.count(), pageWindow: !main, otherVisibleWindows: visible });
      // Mac-Abnahme: in Settings → Diagnostics sichtbar, welches Fenster ⌘W bekam und was es tat.
      const { diagnosticsLog } = await import("./shell/diagnostics.js");
      diagnosticsLog.add("info", `⌘W in window ${win.label}: ${action} (tabs ${tabs.count()}, other windows ${visible})`);
      if (action === "close-window") await win.close().catch(() => tabs.close());
      else if (action === "hide-window") await win.hide().catch(() => tabs.close());
      else tabs.close();
    });
  }
  // Diagnose: Beim Schließen des Fensters bzw. Beenden der App meldet WKWebView kein pagehide – ohne das hier sah
  // jedes normale Beenden wie ein Absturz aus („didn't close normally“).
  const { markSessionEnd } = await import("./shell/diagnostics.js");
  if (main) for (const ev of ["tauri://close-requested", "tauri://destroyed"]) await win.listen(ev, () => markSessionEnd());
  // BSD-319: Hilfe → „Report a Problem…“ (⇧⌘B) – im Fenster vorn.
  await win.listen("desktop://report-problem", () => void window.dispatchEvent(new CustomEvent(REPORT_PROBLEM_EVENT)));
  // Mac-Menü: Befehle aus dem Tastatur-Register (File, Edit, View, Go, Help) – im Fenster vorn.
  await win.listen<string>("desktop://command", (e) => void window.dispatchEvent(new CustomEvent("based:command", { detail: e.payload })));
  // Start nicht bremsen: erst prüfen, wenn das Fenster steht (nur im Hauptfenster).
  if (main && autoUpdatePref.get()) setTimeout(() => void checkForUpdates({ interactive: false }), 5000);
}

/** BSD-138: „Install Command Line Tool…“ – zeigt, wo das geht (Opt-in in den Einstellungen). */
async function showCliInstall() {
  await showMessage("Open Settings → Sync & server → “Local server & command line” and choose Install… there. It needs Node.js 22 or newer on this Mac; Based doesn't download anything.", { title: "Install Command Line Tool" });
}

/** Feedback 18. 11. (Meeting erkannt): Hauptfenster zeigen und nach vorn holen – auch wenn es ausgeblendet war. */
export async function bringToFront(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = getCurrentWebviewWindow();
    await win.unminimize().catch(() => undefined);
    await win.show();
    await win.setFocus();
  } catch {
    // nicht erlaubt oder kein Fenster: die Aufnahme startet trotzdem
  }
}

/** BSD-202: Fenster-Adresse für eine Seite: eigenes Fenster ohne gespeicherte Tabs (`?window=page`). */
export function pageWindowURL(href: string, hash: string): string {
  const url = new URL(href);
  url.searchParams.set("window", "page");
  url.hash = hash;
  return url.toString();
}

/** Läuft diese Seite als eigenes Seitenfenster (keine Tabs aus dem Speicher laden oder speichern)? */
export function isPageWindow(search: string = globalThis.location?.search ?? ""): boolean {
  return new URLSearchParams(search).get("window") === "page";
}

/**
 * BSD-202: Seite in eigenem Fenster öffnen. In der Hülle ein neues Tauri-Fenster (gleiche Titelleiste wie das
 * Hauptfenster), im Browser ein neuer Browser-Tab/-Fenster.
 */
export async function openPageWindow(hash: string, title: string): Promise<void> {
  const url = pageWindowURL(globalThis.location.href, hash);
  if (!isTauri()) {
    globalThis.open(url, "_blank", "noopener");
    return;
  }
  const [{ WebviewWindow }, { LogicalPosition }] = await Promise.all([import("@tauri-apps/api/webviewWindow"), import("@tauri-apps/api/dpi")]);
  const label = "page-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  new WebviewWindow(label, {
    url, title: title || productName(), width: 1000, height: 760, minWidth: 600, minHeight: 400,
    titleBarStyle: "overlay", hiddenTitle: true, trafficLightPosition: new LogicalPosition(18, 22), dragDropEnabled: false,
  });
}

/**
 * BSD-467: mailto-Adresse im Mail-Programm öffnen. Mac-App: über das Opener-Plugin (die Webview folgt mailto-Links
 * nicht; Recht nur für `mailto:*`), Browser: wie ein Klick auf einen Link.
 */
export async function openMailto(href: string): Promise<void> {
  if (!href.startsWith("mailto:")) throw new Error("Not a mail address");
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  const a = document.createElement("a");
  a.href = href;
  a.click();
}

/**
 * Eine erlaubte Web-Adresse (shell/support.ts) im Browser öffnen. Mac-App: über das Opener-Plugin, weil die Webview
 * `target="_blank"` nicht nach außen gibt; Browser: neuer Tab.
 */
export async function openExternal(href: string): Promise<void> {
  const { isAllowedExternal } = await import("./shell/support.js");
  if (!isAllowedExternal(href)) throw new Error("Address not allowed");
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** BSD-358: HTML der Zwischenablage aus der Hülle (nur macOS); ohne: undefined. */
async function readClipboardHTML(): Promise<string | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("clipboard_html")) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Text und (nicht leeres) HTML für pasteInto; leerer Text bleibt "", damit HTML allein auch einfügt. */
export function clipboardData(text: string | null | undefined, html: string | null | undefined): { text: string; html?: string } {
  return html && html.trim() !== "" ? { text: text ?? "", html } : { text: text ?? "" };
}

/**
 * Zwischenablage für das Based-Kontextmenü („Paste“, „Copy link“). In der Hülle über das Tauri-Plugin: WKWebView
 * zeigt bei navigator.clipboard.readText() sonst die System-Blase „Einsetzen“. Im Browser: `undefined` (Standardweg).
 */
export function desktopClipboard(): ClipboardAccess | undefined {
  if (!isTauri()) return undefined;
  const plugin = () => import("@tauri-apps/plugin-clipboard-manager");
  return {
    // BSD-358: dazu HTML (Fett, Links, Listen) über den Befehl clipboard_html (NSPasteboard public.html), wie bei ⌘V
    read: async () => clipboardData(await (await plugin()).readText().catch(() => ""), await readClipboardHTML()),
    write: async (text) => (await plugin()).writeText(text),
  };
}

/**
 * BSD-357: Rechtschreibvorschläge im Based-Kontextmenü. In der Mac-Hülle fragen die Befehle spell_check, spell_learn
 * und spell_ignore NSSpellChecker (WKWebView gibt die Vorschläge nicht an JavaScript). Im Browser keine Vorschläge –
 * außer ein Test legt `globalThis.__basedSpelling` (Wort → Vorschläge) an.
 */
export function desktopSpelling(): SpellingAccess | undefined {
  if (isTauri()) {
    const invoke = async <T>(cmd: string, args: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
    return {
      check: async (word) => { const g = await invoke<string[] | null>("spell_check", { word }); return g ? { guesses: g } : undefined; },
      learn: async (word) => { await invoke("spell_learn", { word }); },
      ignore: async (word) => { await invoke("spell_ignore", { word }); },
    };
  }
  const fake = (globalThis as { __basedSpelling?: Record<string, string[]> }).__basedSpelling;
  if (!fake) return undefined;
  return {
    check: async (word) => (fake[word] ? { guesses: fake[word] } : undefined),
    learn: async (word) => { delete fake[word]; },
    ignore: async (word) => { delete fake[word]; },
  };
}
