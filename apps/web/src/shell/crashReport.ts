// BSD-276: Absturz-/Hängerbericht in der Web-Shell – Einwilligung pro Gerät (Settings → Diagnostics → Crash reports),
// Hinweis beim nächsten Start (CrashReportPrompt), Datei sichern bzw. kopieren. Entscheidungen im Kern
// (packages/core/src/crashReport.ts). Senden aus der App fehlt noch (kein Ziel-Endpunkt, kein Datenschutztext).
import { buildCrashReport, CRASH_CONSENT_KEY, CRASH_HANDLED_KEY, crashReportText, shouldOfferCrashReport, type CrashReport } from "@based/core";
import { isTauri } from "../desktop.js";
import { BUILD } from "./bugReport.js";
import { diagnosticsLog, previousSession } from "./diagnostics.js";
import { REPORTS_DIR } from "./reportStore.js";

const ls = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
const get = (k: string) => { try { return ls()?.getItem(k) ?? null; } catch { return null; } };
const put = (k: string, v: string | undefined) => {
  try {
    if (v === undefined) ls()?.removeItem(k);
    else ls()?.setItem(k, v);
  } catch { /* gesperrt */ }
};

const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };

/** Einwilligung (Standard aus): nach Absturz/Hänger beim nächsten Start einen Bericht anbieten. */
export const crashConsentPref = {
  get: (): boolean => get(CRASH_CONSENT_KEY) === "on",
  set: (on: boolean) => {
    put(CRASH_CONSENT_KEY, on ? "on" : undefined);
    diagnosticsLog.add("info", `crash report offers ${on ? "on" : "off"}`);
    emit();
  },
  subscribe,
};

const handled = (): number | undefined => {
  const v = Number(get(CRASH_HANDLED_KEY));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/** Bericht über die vorige Sitzung (nur nach Absturz oder Hänger). */
export function previousCrashReport(): CrashReport | undefined {
  const platform = (globalThis.navigator as Navigator & { userAgentData?: { platform?: string } } | undefined);
  return buildCrashReport({
    prev: previousSession(),
    app: {
      shell: isTauri() ? "desktop" : "web", ...(BUILD.version ? { version: BUILD.version } : {}), ...(BUILD.commit ? { commit: BUILD.commit } : {}),
      platform: platform?.userAgentData?.platform ?? platform?.platform ?? "unknown",
    },
    now: Date.now(),
  });
}

// Hinweis-Zustand: offen, sobald die Einwilligung da ist und die vorige Sitzung abstürzte; „open“ auch von Hand (Settings).
let open = false;
let decided = false;
let snap = { open: false };

export const crashPrompt = {
  subscribe,
  get: () => {
    if (!decided) {
      decided = true;
      open = shouldOfferCrashReport(previousSession(), crashConsentPref.get(), handled());
      if (open) diagnosticsLog.add("info", "crash report offered at start");
    }
    if (snap.open !== open) snap = { open };
    return snap;
  },
  /** Von Hand öffnen (Settings → Diagnostics → „Prepare report…“). */
  show: () => { decided = true; open = true; emit(); },
  /** Beantwortet (gesichert, kopiert oder „Not now“): für diese Sitzung nicht mehr fragen. */
  close: () => {
    const prev = previousSession();
    if (prev) put(CRASH_HANDLED_KEY, String(prev.startedAt));
    decided = true;
    open = false;
    emit();
  },
};

/**
 * Bericht als Datei sichern. Mac-App: `~/.config/based/reports/<id>.json` (neben den Bündeln aus „Problem melden“, gleiche
 * Freigabe) und im Finder zeigen; Browser: herunterladen. Gibt den Ort für Menschen zurück.
 */
export async function saveCrashReport(r: CrashReport): Promise<string> {
  if (isTauri()) {
    try {
      const fs = await import("@tauri-apps/plugin-fs");
      const { BaseDirectory, homeDir, join } = await import("@tauri-apps/api/path");
      const rel = `${REPORTS_DIR}/${r.id}.json`;
      await fs.mkdir(REPORTS_DIR, { baseDir: BaseDirectory.Home, recursive: true });
      await fs.writeTextFile(rel, crashReportText(r), { baseDir: BaseDirectory.Home });
      const where = await join(await homeDir(), rel);
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(where).catch(() => undefined);
      diagnosticsLog.add("info", "crash report saved to the reports folder");
      return where;
    } catch (e) {
      diagnosticsLog.add("warning", `crash report not saved to the reports folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  downloadCrashReport(r);
  return "Downloads";
}

function downloadCrashReport(r: CrashReport) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([crashReportText(r)], { type: "application/json" }));
  a.download = `based-${r.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  diagnosticsLog.add("info", "crash report saved as file");
}

/** In die Zwischenablage; false, wenn das nicht geht. */
export async function copyCrashReport(r: CrashReport): Promise<boolean> {
  const clip = globalThis.navigator?.clipboard;
  if (!clip) return false;
  try {
    await clip.writeText(crashReportText(r));
    diagnosticsLog.add("info", "crash report copied");
    return true;
  } catch {
    return false;
  }
}
