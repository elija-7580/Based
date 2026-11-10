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
export async function startDesktop() {
  if (!isTauri()) return;
  applyDesktopShell();
  const { listen } = await import("@tauri-apps/api/event");
  await listen("desktop://check-updates", () => void checkForUpdates({ interactive: true }));
  // Start nicht bremsen: erst prüfen, wenn das Fenster steht.
  setTimeout(() => void checkForUpdates({ interactive: false }), 5000);
}
