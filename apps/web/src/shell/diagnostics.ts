// BSD-227: Diagnose der Web-Shell – dünne Hülle um packages/core/diagnostics: Log (ohne Nutzerinhalte), Fehler und
// unbehandelte Promises, Hänger (Zeitgeber-Verzug, nur bei sichtbarer Seite), Sitzungs-Marke im localStorage für den
// Hinweis nach einem unsauberen Ende, Bericht zum Kopieren.
import {
  beginSession, buildReport, DiagnosticsLog, endSession, heartbeat, previousSessionNotice, startStallDetector,
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
let phase = "page load";
const marked = new Set<string>();
const sinceLoad = () => Math.round(globalThis.performance?.now?.() ?? 0);

/** Marke im Diagnose-Log (jede nur einmal): `boot: <name> +<ms seit Seitenstart>`. Keine Nutzerinhalte übergeben. */
export function bootMark(name: string, detail?: string) {
  if (marked.has(name)) return;
  marked.add(name);
  phase = name;
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

  let stop: (() => void) | undefined;
  const watch = () => {
    stop?.();
    stop = undefined;
    if (win.document.visibilityState !== "visible") return;
    stop = startStallDetector({
      onStall: (ms) => {
        stalls += 1;
        const doc = win.document;
        diagnosticsLog.add("warning", `main thread blocked for ${Math.round(ms)} ms (after “${phase}”, window ${doc.hasFocus() ? "focused" : "not focused"})`);
      },
    });
  };
  watch();
  win.document.addEventListener("visibilitychange", watch);

  const beat = () => heartbeat(store, Date.now(), { stalls, log: diagnosticsLog.all.slice(-50) });
  win.setInterval(beat, 10_000);
  win.addEventListener("pagehide", () => endSession(store, Date.now(), diagnosticsLog.all.slice(-50)));
  // WKWebView (Desktop-Hülle) meldet pagehide beim Beenden der App nicht zuverlässig; beforeunload zusätzlich.
  win.addEventListener("beforeunload", () => endSession(store, Date.now(), diagnosticsLog.all.slice(-50)));
  // Wird die Seite aus dem Back/Forward-Cache zurückgeholt, läuft die Sitzung weiter.
  win.addEventListener("pageshow", (e: PageTransitionEvent) => { if (e.persisted) beginSession(store, Date.now()); });
}

/** Bericht zum Kopieren (Fakten aus der Shell, vorige Sitzung, Log). */
export function diagnosticsReport(facts: ReportFacts): string {
  return buildReport({ ...facts, freezes: stalls }, previous, diagnosticsLog.all, Date.now());
}
