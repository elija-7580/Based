// BSD-319: Ablauf „Problem melden“ ohne React – einfrieren, Bildschirmfoto, Dialog auf, speichern. Auslöser: ⌘⇧B,
// ⌘K → „Report a problem“, Menü Hilfe (Mac-App), Settings → Diagnostics.
import type { BugBundle } from "@based/core";
import { captureScreenshot, freezeReport, makeBundle, type FrozenReport } from "./bugReport.js";
import { diagnosticsLog } from "./diagnostics.js";
import { reportsChanged, reportStore, type SavedReport } from "./reportStore.js";

export interface ReportDraft {
  frozen: FrozenReport;
  screenshot?: Blob;
}

type State = { phase: "idle" } | { phase: "capturing" } | { phase: "open"; draft: ReportDraft } | { phase: "saved"; draft: ReportDraft; saved: SavedReport; bundle: BugBundle };

let state: State = { phase: "idle" };
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  // Sofortige Rückmeldung für jeden Auslöser (⇧⌘B, ⌘K, Menü, Settings): Wurzel kennt die Phase, CSS zeigt den Warte-Cursor.
  if (typeof document !== "undefined") document.documentElement.dataset.report = s.phase;
  for (const l of listeners) l();
};

export const reportUI = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); },
  get: (): State => state,
};

/** Länger wartet der Dialog nicht auf das Bildschirmfoto (danach ohne Foto, damit der Dialog nicht darin landet). */
const SHOT_TIMEOUT_MS = 5000;

/** Zustand jetzt einfrieren, Foto machen, dann den Dialog zeigen. */
export async function startReport() {
  if (state.phase !== "idle") return;
  const frozen = freezeReport();
  set({ phase: "capturing" });
  let timedOut = false;
  const shot = await Promise.race([
    captureScreenshot(),
    new Promise<undefined>((r) => setTimeout(() => { timedOut = true; r(undefined); }, SHOT_TIMEOUT_MS)),
  ]);
  if (timedOut) diagnosticsLog.add("warning", "report screenshot took too long — saved without it");
  set({ phase: "open", draft: { frozen, ...(shot ? { screenshot: shot } : {}) } });
}

export async function saveReport(note: string, opts: { realText: boolean; screenshot: boolean }): Promise<SavedReport> {
  if (state.phase !== "open") throw new Error("No report open");
  const draft = state.draft;
  const withShot = opts.screenshot && !!draft.screenshot;
  const bundle = makeBundle(draft.frozen, note, { realText: opts.realText, screenshot: withShot });
  const saved = await (await reportStore()).save(bundle, withShot ? draft.screenshot : undefined);
  diagnosticsLog.add("info", `problem report saved (${bundle.recording.events.length} events, ${bundle.layout.issues.length} layout issues)`);
  reportsChanged();
  set({ phase: "saved", draft, saved, bundle });
  return saved;
}

export function closeReport() {
  set({ phase: "idle" });
}
