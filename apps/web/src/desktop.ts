// BSD-164: apps/web in der Tauri-Hülle „Based Next“ (apps/desktop). Nur hier steht Tauri-spezifischer Code; im Browser
// tut nichts davon etwas (die Plugins werden erst bei Bedarf nachgeladen).
// - Titelleiste im Overlay-Stil: Platz für die Ampel-Knöpfe über der Seitenleiste und Zugflächen fürs Fenster.
// - Updates: beim Start still prüfen, über „Check for Updates…“ im App-Menü auch mit Antwort, wenn alles aktuell ist.
// Speicher: unverändert SQLite-WASM auf OPFS im Worker (siehe docs/desktop.md, „Speicher“).

import { checkReleasesFallback, DOWNLOAD_PAGE, isMissingUpdateManifest } from "./shell/updateFallback.js";

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
export async function startDesktop(onCloseTab?: () => void) {
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
  // ⌘W liegt im Menü (lib.rs) und schließt den Tab, nicht das Fenster.
  if (onCloseTab) await win.listen("desktop://close-tab", () => onCloseTab());
  // Start nicht bremsen: erst prüfen, wenn das Fenster steht (nur im Hauptfenster).
  if (main) setTimeout(() => void checkForUpdates({ interactive: false }), 5000);
}

/** BSD-138: Befehl zum Installieren von `based` zeigen (und in die Zwischenablage legen). */
async function showCliInstall() {
  const [{ localServer }, dialog] = await Promise.all([import("./desktop/localServer.js"), import("@tauri-apps/plugin-dialog")]);
  const install = await localServer().cliInstall();
  if (!install) return;
  try {
    await navigator.clipboard.writeText(install.command);
  } catch {
    // ohne Zwischenablage: der Befehl steht im Dialog
  }
  const on = localServer().getState().enabled;
  await dialog.message(
    `Run this in Terminal (copied to the clipboard):\n\n${install.command}\n\nThen \`based --help\`. ` +
      (on ? "The local server is on, so `based` works while Based Next is open." : "Turn on Settings → Sync & server → Local server so `based` works without a server."),
    { title: "Install Command Line Tool", kind: "info" },
  );
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
