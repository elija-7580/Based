// Import- und Export-Dialoge. Import: Dateien, Ordner oder ZIP (Notion-HTML-Export, Markdown/CSV, Based-Archiv) im
// Import-Worker vorbereiten – mit Fortschritt und Abbrechen –, dann im Store-Worker schreiben und berichten.
// Export: Seite als Markdown/HTML, Workspace als ZIP (Markdown oder HTML mit assets/) oder Based-Archiv, als Download.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { StoreClient } from "../worker/client.js";
import { ImportCancelledError, prepareInWorker, readFiles, type PreparingImport } from "../worker/importClient.js";
import type { ExportFile, ExportFormat, ImportSummary, WorkspaceExportFormat } from "../worker/interop.js";

/** Datei im Browser herunterladen. */
export function download(file: ExportFile) {
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Dialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className="dialog">
        <h2 id={id} className="t-heading">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function summaryLine(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.pages) parts.push(count(s.pages, "page"));
  if (s.databases) parts.push(count(s.databases, "database"));
  if (s.rows) parts.push(count(s.rows, "row"));
  if (s.archiveRecords) parts.push(count(s.archiveRecords, "record") + " from an archive");
  return parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new to import.";
}

type Phase =
  | { k: "pick" }
  | { k: "reading" }
  | { k: "preparing"; fraction: number }
  | { k: "writing" }
  | { k: "done"; summary: ImportSummary }
  | { k: "error"; message: string };

/** Import-Dialog. `onOpenPage` (optional) bietet an, die erste importierte Seite zu öffnen. */
export function ImportDialog({ client, onClose, onOpenPage }: { client: StoreClient; onClose: () => void; onOpenPage?: (id: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "pick" });
  const running = useRef<PreparingImport | undefined>(undefined);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    running.current?.cancel();
  }, []);

  const start = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setPhase({ k: "reading" });
    try {
      const read = await readFiles(Array.from(list));
      if (!alive.current) return;
      setPhase({ k: "preparing", fraction: 0 });
      const job = prepareInWorker(read, (fraction) => alive.current && setPhase({ k: "preparing", fraction }));
      running.current = job;
      const payload = await job.result;
      running.current = undefined;
      if (!alive.current) return;
      setPhase({ k: "writing" });
      const summary = await client.commitImport(payload);
      if (alive.current) setPhase({ k: "done", summary });
    } catch (e) {
      running.current = undefined;
      if (!alive.current) return;
      if (e instanceof ImportCancelledError) setPhase({ k: "pick" });
      else setPhase({ k: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (files.current) files.current.value = "";
      if (folder.current) folder.current.value = "";
    }
  };

  const busy = phase.k === "reading" || phase.k === "preparing" || phase.k === "writing";
  const fraction = phase.k === "preparing" ? phase.fraction : phase.k === "writing" ? 1 : 0;
  return (
    <Dialog title="Import" onClose={onClose} busy={busy}>
      <input ref={files} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose files to import"
        accept=".zip,.html,.htm,.md,.markdown,.csv,.txt,.jsonl" onChange={(e) => void start(e.target.files)} />
      <input ref={folder} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a folder to import"
        {...{ webkitdirectory: "" }} onChange={(e) => void start(e.target.files)} />
      {phase.k === "pick" || phase.k === "error" ? (
        <>
          <p className="t-desc">
            A Notion export (HTML or Markdown &amp; CSV — the .zip or its unpacked folder), Markdown or CSV files, or a Based archive (.based.zip, .jsonl).
            Importing the same Notion export again updates those pages and keeps what you changed in Based.
          </p>
          {phase.k === "error" ? <p role="alert" className="dialog-error">Import failed: {phase.message}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn" onClick={() => folder.current?.click()}>Choose folder…</button>
            <button type="button" className="btn primary" onClick={() => files.current?.click()}>Choose files…</button>
          </div>
        </>
      ) : null}
      {busy ? (
        <>
          <p className="t-desc" aria-live="polite">{phase.k === "reading" ? "Reading files…" : phase.k === "writing" ? "Adding to your workspace…" : "Preparing import…"}</p>
          <div className="progress" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" disabled={phase.k !== "preparing"} onClick={() => running.current?.cancel()}>Cancel</button>
          </div>
        </>
      ) : null}
      {phase.k === "done" ? <ImportReport summary={phase.summary} onClose={onClose} onMore={() => setPhase({ k: "pick" })} onOpenPage={onOpenPage} /> : null}
    </Dialog>
  );
}

function ImportReport({ summary, onClose, onMore, onOpenPage }: { summary: ImportSummary; onClose: () => void; onMore: () => void; onOpenPage?: ((id: string) => void) | undefined }) {
  const shown = summary.warnings.slice(0, 50);
  const first = summary.rootIDs[0];
  return (
    <>
      <p role="status" data-testid="import-summary">{summaryLine(summary)}</p>
      {shown.length ? (
        <div className="dialog-report">
          <div className="t-meta">Skipped and notes</div>
          <ul className="t-desc">
            {shown.map((w, i) => <li key={i}>{w}</li>)}
            {summary.warnings.length > shown.length ? <li>and {summary.warnings.length - shown.length} more</li> : null}
          </ul>
        </div>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn ghost" onClick={onMore}>Import more…</button>
        {first && onOpenPage ? <button type="button" className="btn" onClick={() => { onClose(); onOpenPage(first); }}>Open</button> : null}
        <button type="button" className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

const PAGE_FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: "markdown", label: "Markdown", hint: "A .md file (databases as .csv)" },
  { value: "html", label: "HTML", hint: "A standalone web page" },
];
const WORKSPACE_FORMATS: { value: WorkspaceExportFormat; label: string; hint: string }[] = [
  { value: "markdown", label: "Markdown", hint: "ZIP with .md and .csv files, sub-pages in folders, assets/" },
  { value: "html", label: "HTML", hint: "ZIP with web pages, sub-pages in folders, assets/" },
  { value: "archive", label: "Based archive", hint: "Everything, lossless — import it into Based again" },
];

/** Export-Dialog: mit `pageID` die Seite, sonst der ganze Workspace. */
export function ExportDialog({ client, pageID, onClose }: { client: StoreClient; pageID?: string; onClose: () => void }) {
  const formats = pageID ? PAGE_FORMATS : WORKSPACE_FORMATS;
  const [format, setFormat] = useState<WorkspaceExportFormat>("markdown");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
  const labelID = useId();
  const run = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const file = pageID ? await client.exportPage(pageID, format as ExportFormat) : await client.exportWorkspace(format);
      download(file);
      setResult({ ok: true, text: file.summary });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={pageID ? "Export page" : "Export workspace"} onClose={onClose} busy={busy}>
      <div id={labelID} className="t-meta">Format</div>
      <div role="radiogroup" aria-labelledby={labelID} className="dialog-options">
        {formats.map((f) => (
          <button key={f.value} type="button" role="radio" aria-checked={format === f.value} className="option" aria-selected={format === f.value} onClick={() => setFormat(f.value)}>
            <span className="grow">
              <strong>{f.label}</strong>
              <span className="t-desc" style={{ display: "block" }}>{f.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {result ? <p role={result.ok ? "status" : "alert"} className={result.ok ? "t-desc" : "dialog-error"}>{result.text}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="btn ghost" onClick={onClose}>{result?.ok ? "Done" : "Cancel"}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? "Exporting…" : "Export"}</button>
      </div>
    </Dialog>
  );
}

/** Abschnitt in den Einstellungen. */
export function ImportExportSettings({ client, onOpenPage }: { client: StoreClient; onOpenPage?: (id: string) => void }) {
  const [open, setOpen] = useState<"import" | "export" | undefined>();
  return (
    <>
      <div style={{ marginTop: "var(--space-5)" }}>
        <h2 className="t-heading">Import &amp; export</h2>
        <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>Bring in a Notion export or Markdown files, or take everything with you.</p>
      </div>
      <div className="setting inline">
        <div className="setting-label">Import</div>
        <div className="choices"><button type="button" className="btn" onClick={() => setOpen("import")}>Import…</button></div>
      </div>
      <div className="setting inline">
        <div className="setting-label">Export</div>
        <div className="choices"><button type="button" className="btn" onClick={() => setOpen("export")}>Export workspace…</button></div>
      </div>
      {open === "import" ? <ImportDialog client={client} onClose={() => setOpen(undefined)} {...(onOpenPage ? { onOpenPage } : {})} /> : null}
      {open === "export" ? <ExportDialog client={client} onClose={() => setOpen(undefined)} /> : null}
    </>
  );
}
