// BSD-227: Diagnose der Web-Shell – dünne Hülle um packages/core/diagnostics: Log (ohne Nutzerinhalte), Fehler und
// unbehandelte Promises, Sitzungs-Marke im localStorage für den Hinweis nach einem unsauberen Ende, Bericht zum Kopieren.
// Hänger misst seit BSD-418 shell/hangs.ts (250 ms, Ursache, Breadcrumbs, Watchdog-Worker) – hier nur der Zähler der
// Freezes (≥ 2 s) für Sitzungs-Marke und Absturzbericht.
import {
  beginSession, buildReport, DiagnosticsLog, endSession, heartbeat, previousSessionNotice,
  type DiagnosticsStorage, type ReportFacts, type SessionRecord,
} from "@based/core";

const memoryStorage = (): DiagnosticsStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

function storage(): DiagnosticsStorage {
  try {
    return globalThis.localStorage ?? memoryStorage();
  } catch {
    return memoryStorage();
  }
}

export const diagnosticsLog = new DiagnosticsLog();

// Start-Marken: Wo beim Start die Zeit bleibt. Ein Hänger nennt die letzte Marke, damit ein Bericht vom Mac zeigt,
// in welchem Abschnitt der Hauptthread stand (Feedback 11. 11.: „main thread blocked for 26485 ms“ ohne Ort).
let phase = "boot phase page load";

/**
 * BSD-368: Was gerade läuft (nach dem Start: die Ansicht, z. B. `route page`). Steht in Hänger-Meldungen und im
 * Herzschlag, damit ein Bericht nach einem Hänger oder Absturz zeigt, wo. Nur feste Namen, keine Nutzerinhalte.
 */
export function noteActivity(name: string) {
  if (name === phase) return;
  phase = name;
  for (const l of activityListeners) l(name);
}
const activityListeners = new Set<(name: string) => void>();
/** BSD-418: Was gerade läuft (für Hänger und den Watchdog-Worker). */
export const currentActivity = () => phase;
export function onActivity(fn: (name: string) => void): () => void {
  activityListeners.add(fn);
  return () => void activityListeners.delete(fn);
}

/** JS-Speicher in MB, wo der Browser ihn nennt (Chromium, Tauri unter Windows); WebKit: undefined. */
export function heapMB(perf: Performance | undefined = globalThis.performance): number | undefined {
  const used = (perf as (Performance & { memory?: { usedJSHeapSize?: number } }) | undefined)?.memory?.usedJSHeapSize;
  return typeof used === "number" && used > 0 ? Math.round(used / 1048576) : undefined;
}
const marked = new Set<string>();
const sinceLoad = () => Math.round(globalThis.performance?.now?.() ?? 0);

/** Marke im Diagnose-Log (jede nur einmal): `boot: <name> +<ms seit Seitenstart>`. Keine Nutzerinhalte übergeben. */
export function bootMark(name: string, detail?: string) {
  if (marked.has(name)) return;
  marked.add(name);
  phase = `boot phase ${name}`;
  diagnosticsLog.add("info", `boot: ${name} +${sinceLoad()} ms${detail ? ` (${detail})` : ""}`);
}

/** Sitzung als sauber beendet markieren (Fenster/App schließt). Schlägt die Sitzung danach weiter, gilt das nicht mehr. */
export function markSessionEnd() {
  endSession(storage(), Date.now(), diagnosticsLog.all.slice(-50));
}
let previous: SessionRecord | undefined;
let stalls = 0;
let installed = false;

/** Die vorige Sitzung (nach `installDiagnostics`). */
export const previousSession = () => previous;
/** Hinweis, wenn die vorige Sitzung nicht sauber endete. */
export const previousSessionText = () => previousSessionNotice(previous);
export const stallCount = () => stalls;
/** BSD-418: ein Hänger ab 2 s (Freeze) – zählt in Sitzungs-Marke und Absturzbericht. */
export function noteFreeze() { stalls += 1; }
const reportSections: (() => string[])[] = [];
/** BSD-418: weiterer Abschnitt im kopierbaren Bericht (z. B. Hänger). */
export function addReportSection(fn: () => string[]) { reportSections.push(fn); }

/** Einmal beim Start (main.tsx). */
export function installDiagnostics(win: Window & typeof globalThis = globalThis as Window & typeof globalThis) {
  if (installed) return;
  installed = true;
  const store = storage();
  previous = beginSession(store, Date.now());
  diagnosticsLog.add("info", `start · ${navigator.userAgent.replace(/\s+/g, " ").slice(0, 160)}`);
  const notice = previousSessionNotice(previous);
  if (notice) diagnosticsLog.add("warning", notice);

  win.addEventListener("error", (e: ErrorEvent) => diagnosticsLog.add("error", `${e.message || "error"} (${(e.filename ?? "").split("/").pop() ?? ""}:${e.lineno ?? 0})`));
  win.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r = e.reason as unknown;
    diagnosticsLog.add("error", `unhandled rejection: ${r instanceof Error ? `${r.name}: ${r.message}` : String(r)}`);
  });

  const beat = () => {
    const heap = heapMB();
    heartbeat(store, Date.now(), { stalls, log: diagnosticsLog.all.slice(-50), activity: phase, ...(heap !== undefined ? { heapMB: heap } : {}) });
  };
  win.setInterval(beat, 10_000);
  // BSD-418: neue Ansicht sofort in die Sitzungs-Marke – endet die Sitzung hart (auch mitten in einem Hänger, den
  // WebKit aus dem Worker nicht festhalten kann), nennt der nächste Start die richtige letzte Aktivität.
  let lastBeat = 0;
  onActivity(() => {
    const now = Date.now();
    if (now - lastBeat < 1000) return;
    lastBeat = now;
    beat();
  });
  win.addEventListener("pagehide", () => endSession(store, Date.now(), diagnosticsLog.all.slice(-50)));
  // WKWebView (Desktop-Hülle) meldet pagehide beim Beenden der App nicht zuverlässig; beforeunload zusätzlich.
  win.addEventListener("beforeunload", () => endSession(store, Date.now(), diagnosticsLog.all.slice(-50)));
  // Wird die Seite aus dem Back/Forward-Cache zurückgeholt, läuft die Sitzung weiter.
  win.addEventListener("pageshow", (e: PageTransitionEvent) => { if (e.persisted) beginSession(store, Date.now()); });
}

/** Bericht zum Kopieren (Fakten aus der Shell, vorige Sitzung, Log). */
export function diagnosticsReport(facts: ReportFacts): string {
  return buildReport({ ...facts, freezes: stalls }, previous, diagnosticsLog.all, Date.now(), reportSections.flatMap((f) => f()));
}
