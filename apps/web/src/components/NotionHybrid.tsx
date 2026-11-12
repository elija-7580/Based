// BSD-317: Oberfläche des Hybrid-Notion-Imports (Inhalt aus dem Export, Struktur aus der API). Nur Anzeige – der
// Ablauf liegt in packages/core (notion-hybrid), der Verwalter in worker/notionHybridClient.ts. Der Import läuft
// weiter, wenn der Dialog zu ist; die Seitenleiste zeigt dann den Stand.
import { hybridDeviationWarnings } from "@based/core";
import { useSyncExternalStore } from "react";
import { Icon } from "../icons.js";
import { hybridImport, type HybridStatus } from "../worker/notionHybridClient.js";
import { CopyReport } from "./NotionImport.js";

export const useHybridImport = (): HybridStatus => useSyncExternalStore(hybridImport.subscribe, hybridImport.getStatus, hybridImport.getStatus);

const n = (x: number) => x.toLocaleString("en-US");
const pages = (x: number) => `${n(x)} ${x === 1 ? "page" : "pages"}`;

function Bar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Laufender Import im Dialog: erst die Struktur, dann der Inhalt im Hintergrund. */
export function HybridRunning({ status, onClose }: { status: HybridStatus; onClose: () => void }) {
  const p = status.progress;
  const content = status.structureReady;
  const total = p?.phase === "content" ? p.total : 0;
  const done = p?.phase === "content" ? p.done : 0;
  return (
    <div className="hybrid-run" data-testid="hybrid-running" data-phase={content ? "content" : "structure"}>
      <ol className="hybrid-steps t-desc">
        <li data-state={content ? "done" : "now"}>
          <span className="hybrid-step-mark" aria-hidden="true">{content ? <Icon name="check" size={14} /> : "1"}</span>
          <span><strong>Structure</strong> — pages, databases, views and relations from Notion</span>
        </li>
        <li data-state={content ? "now" : "next"}>
          <span className="hybrid-step-mark" aria-hidden="true">2</span>
          <span><strong>Content</strong> — read from your export, most recently edited pages first</span>
        </li>
      </ol>
      <p className="t-desc" aria-live="polite" data-testid="hybrid-progress">
        {content
          ? total > 0 ? `${n(done)} of ${pages(total)} loaded. You can close this and keep working — pages unlock as their content arrives.` : "Your pages are here. Loading content…"
          : p?.message ?? "Connecting to Notion…"}
      </p>
      <Bar fraction={content ? (total > 0 ? done / total : 0) : p?.fraction ?? 0} label="Import progress" />
      <div className="dialog-actions">
        <button type="button" className="btn ghost" disabled={status.k === "stopping"} onClick={() => hybridImport.cancel()}>{status.k === "stopping" ? "Pausing…" : content ? "Pause" : "Cancel"}</button>
        {content ? <button type="button" className="btn primary" onClick={onClose}>Close</button> : null}
      </div>
    </div>
  );
}

/** Abschluss: was kam woher, und jede Abweichung zwischen Export, Notion und Based. */
export function HybridReport({ status, onClose }: { status: HybridStatus; onClose: () => void }) {
  const s = status.state;
  if (!s) return null;
  const warnings = [...hybridDeviationWarnings(s.deviations), ...s.warnings];
  const shown = warnings.slice(0, 50);
  const parts = [pages(s.totals.pages), `${n(s.totals.rows)} ${s.totals.rows === 1 ? "row" : "rows"}`, `${n(s.totals.databases)} ${s.totals.databases === 1 ? "database" : "databases"}`];
  return (
    <div className="hybrid-run" data-testid="hybrid-report">
      <p role="status" data-testid="hybrid-summary">
        {s.mode === "delta" ? "Updated from Notion: " : "Imported "}{parts.join(", ")}.
        {" "}{n(s.done.fromZip)} loaded from the export, {n(s.done.viaApi)} through Notion’s API.
        {status.remaining > 0 ? ` ${pages(status.remaining)} still waiting for content.` : ""}
      </p>
      {shown.length ? (
        <div className="dialog-report">
          <div className="t-meta">Differences and notes</div>
          <ul className="t-desc">
            {shown.map((w, i) => <li key={i}>{w}</li>)}
            {warnings.length > shown.length ? <li>and {warnings.length - shown.length} more</li> : null}
          </ul>
        </div>
      ) : null}
      <div className="dialog-actions">
        {status.diagnostic ? <CopyReport report={status.diagnostic} /> : null}
        <button type="button" className="btn primary" onClick={() => { hybridImport.dismiss(); onClose(); }}>Done</button>
      </div>
    </div>
  );
}

/** Stand in der Seitenleiste, solange ein Import läuft, wartet oder etwas zu melden hat. Klick öffnet den Dialog. */
export function HybridImportPill({ onOpen }: { onOpen: () => void }) {
  const status = useHybridImport();
  if (status.k === "idle") return null;
  const p = status.progress;
  const content = status.structureReady && p?.phase === "content" && p.total > 0;
  const label = status.k === "running" || status.k === "stopping"
    ? content ? `Importing · ${n(p.done)} / ${n(p.total)}` : "Importing from Notion…"
    : status.k === "paused" ? `Import paused · ${pages(status.remaining)} left`
    : status.k === "error" ? "Import stopped" : "Import finished";
  const fraction = content ? p.done / p.total : status.k === "done" ? 1 : 0;
  return (
    <button type="button" className="hybrid-pill t-meta" data-testid="hybrid-pill" data-state={status.k} onClick={onOpen} title="Notion import — open details">
      <span className="hybrid-pill-label">{label}</span>
      {status.k === "running" || status.k === "stopping" ? <span className="hybrid-pill-bar" aria-hidden="true"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span> : null}
    </button>
  );
}
