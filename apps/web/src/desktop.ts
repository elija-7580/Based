// BSD-164: apps/web in der Tauri-Hülle „Based Next“ (apps/desktop). Nur hier steht Tauri-spezifischer Code; im Browser
// tut nichts davon etwas (die Plugins werden erst bei Bedarf nachgeladen).
// - Titelleiste im Overlay-Stil: Platz für die Ampel-Knöpfe über der Seitenleiste und Zugflächen fürs Fenster.
// - Updates: beim Start still prüfen, über „Check for Updates…“ im App-Menü auch mit Antwort, wenn alles aktuell ist.
// Speicher: unverändert SQLite-WASM auf OPFS im Worker (siehe docs/desktop.md, „Speicher“).

import { checkReleasesFallback, DOWNLOAD_PAGE, isMissingUpdateManifest } from "./shell/updateFallback.js";
import { autoUpdatePref } from "./shell/storage.js";
import { closeTabAction } from "./shell/closeTab.js";

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

/** Fragt die next-Releases nach einer neueren Version; bei Ja: laden, installieren, neu starten. */
export async function checkForUpdates(opts: { interactive: boolean }) {
  if (checking) return;
  checking = true;
  const dialog = await import("@tauri-apps/plugin-dialog");
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (opts.interactive) await dialog.message("You’re on the newest version of Based Next.", { title: "No update available" });
      return;
    }
    const yes = await dialog.ask(`Based Next ${update.version} is available (you have ${update.currentVersion}). Install it and restart now?`, {
      title: "Update available",
      kind: "info",
      okLabel: "Install and Restart",
      cancelLabel: "Later",
    });
    if (!yes) return;
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    // Ohne Netz oder ohne signiertes Release still bleiben; nur auf ausdrückliche Nachfrage melden.
    if (!opts.interactive) return;
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingUpdateManifest(message)) {
      // Noch kein signiertes Update-Paket (Secret fehlt): wenigstens sagen, ob eine neuere DMG bereitliegt.
      const { getVersion } = await import("@tauri-apps/api/app");
      const current = await getVersion();
      const found = await checkReleasesFallback(current);
      const text = found.kind === "newer"
        ? `Based Next ${found.version} is available (you have ${current}). Automatic install isn’t set up yet — download the new DMG from ${DOWNLOAD_PAGE}`
        : found.kind === "current"
          ? `You’re on the newest version of Based Next (${current}).`
          : `Automatic updates aren’t set up yet. The newest DMG is always at ${DOWNLOAD_PAGE}`;
      await dialog.message(text, { title: found.kind === "newer" ? "Update available" : "Updates", kind: "info" });
      return;
    }
    await dialog.message(`Could not check for updates: ${message}`, { title: "Update failed", kind: "error" });
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
  // Start nicht bremsen: erst prüfen, wenn das Fenster steht (nur im Hauptfenster).
  if (main && autoUpdatePref.get()) setTimeout(() => void checkForUpdates({ interactive: false }), 5000);
}

/** BSD-138: „Install Command Line Tool…“ – zeigt, wo das geht (Opt-in in den Einstellungen). */
async function showCliInstall() {
  const dialog = await import("@tauri-apps/plugin-dialog");
  await dialog.message("Open Settings → Sync & server → “Local server & command line” and choose Install… there. It needs Node.js 22 or newer on this Mac; Based doesn't download anything.", { title: "Install Command Line Tool", kind: "info" });
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
    url, title: title || "Based Next", width: 1000, height: 760, minWidth: 600, minHeight: 400,
    titleBarStyle: "overlay", hiddenTitle: true, trafficLightPosition: new LogicalPosition(18, 22), dragDropEnabled: false,
  });
}
