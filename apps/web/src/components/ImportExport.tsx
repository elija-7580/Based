// Import- und Export-Dialoge. Import: Dateien, Ordner oder ZIP (Notion-HTML-Export, Markdown/CSV, Based-Archiv) im
// Import-Worker vorbereiten – mit Fortschritt und Abbrechen –, dann im Store-Worker schreiben und berichten.
// Export: Seite als Markdown, HTML (eigenständige Datei oder ZIP mit Unterseiten/assets) oder PDF (Druckansicht);
// Workspace als ZIP (Markdown oder HTML mit assets/) oder Based-Archiv, als Download.
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { exportStylesheet } from "../shell/exportCss.js";
import { printHTML } from "../shell/print.js";
import type { StoreClient } from "../worker/client.js";
import { CopyReport, NotionImport } from "./NotionImport.js";
import { ImportCancelledError, prepareInWorker, readFiles, type PreparingImport } from "../worker/importClient.js";
import type { ExportFile, ImportSummary, PageExportFormat, WorkspaceExportFormat } from "../worker/interop.js";

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
  if (s.assets) parts.push(count(s.assets, "attached file"));
  if (s.archiveRecords) parts.push(count(s.archiveRecords, "record") + " from an archive");
  return parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new to import.";
}

type Phase =
  | { k: "pick" }
  | { k: "reading" }
  | { k: "preparing"; fraction: number }
  | { k: "writing" }
  | { k: "done"; summary: ImportSummary; report?: string }
  /** BSD-217: direkt aus Notion über die API. */
  | { k: "notion" }
  | { k: "error"; message: string };

/** Import-Dialog. `onOpenPage` (optional) bietet an, die erste importierte Seite zu öffnen. */
export function ImportDialog({ client, onClose, onOpenPage, initial = "pick" }: { client: StoreClient; onClose: () => void; onOpenPage?: (id: string) => void; initial?: "pick" | "notion" }) {
  const [phase, setPhase] = useState<Phase>({ k: initial });
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
      const job = prepareInWorker(read, (fraction) => alive.current && setPhase({ k: "preparing", fraction }), undefined, (a) => client.importAsset(a), () => client.discardImport());
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

  const [notionBusy, setNotionBusy] = useState(false);
  const busy = phase.k === "reading" || phase.k === "preparing" || phase.k === "writing" || (phase.k === "notion" && notionBusy);
  const fraction = phase.k === "preparing" ? phase.fraction : phase.k === "writing" ? 1 : 0;
  return (
    <Dialog title={phase.k === "notion" ? "Import from Notion" : "Import"} onClose={onClose} busy={busy}>
      <input ref={files} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose files to import"
        accept=".zip,.html,.htm,.md,.markdown,.csv,.txt,.json,.jsonl,.enex,.opml,.docx" onChange={(e) => void start(e.target.files)} />
      <input ref={folder} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a folder to import"
        {...{ webkitdirectory: "" }} onChange={(e) => void start(e.target.files)} />
      {phase.k === "pick" || phase.k === "error" ? (
        <>
          <p className="t-desc">
            A Notion export (HTML or Markdown &amp; CSV — the .zip or its unpacked folder), an Obsidian vault or Logseq graph (folder or .zip), Evernote notebooks (.enex), outlines (.opml), Word documents (.docx), JSON or JSON Lines (a list of objects becomes a database), Markdown or CSV files, or a Based archive (.based.zip, .jsonl).
            Importing the same Notion export again updates those pages and keeps what you changed in Based.
          </p>
          {phase.k === "error" ? <p role="alert" className="dialog-error">Import failed: {phase.message}</p> : null}
          <button type="button" className="import-source" onClick={() => setPhase({ k: "notion" })}>
            <span className="grow">
              <strong>Connect Notion directly</strong>
              <span className="t-desc">Keeps database views, layouts and page structure. Uses a Notion integration token.</span>
            </span>
            <span aria-hidden="true" className="import-source-arrow">→</span>
          </button>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn" onClick={() => folder.current?.click()}>Choose folder…</button>
            <button type="button" className="btn primary" onClick={() => files.current?.click()}>Choose files…</button>
          </div>
        </>
      ) : null}
      {phase.k === "notion" ? (
        <NotionImport client={client} onBack={() => setPhase({ k: "pick" })} onBusy={setNotionBusy} onClose={onClose}
          onDone={(summary, report) => setPhase({ k: "done", summary, report })} />
      ) : null}
      {busy && phase.k !== "notion" ? (
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
      {phase.k === "done" ? <ImportReport summary={phase.summary} report={phase.report} onClose={onClose} onMore={() => setPhase({ k: "pick" })} onOpenPage={onOpenPage} /> : null}
    </Dialog>
  );
}

function ImportReport({ summary, report, onClose, onMore, onOpenPage }: { summary: ImportSummary; report?: string | undefined; onClose: () => void; onMore: () => void; onOpenPage?: ((id: string) => void) | undefined }) {
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
        {report ? <CopyReport report={report} /> : null}
        <button type="button" className="btn ghost" onClick={onMore}>Import more…</button>
        {first && onOpenPage ? <button type="button" className="btn" onClick={() => { onClose(); onOpenPage(first); }}>Open</button> : null}
        <button type="button" className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

type PageFormat = PageExportFormat | "pdf";
const PAGE_FORMATS: { value: PageFormat; label: string; hint: string }[] = [
  { value: "markdown", label: "Markdown", hint: "A .md file (databases as .csv)" },
  { value: "html", label: "HTML", hint: "A standalone web page you can open anywhere" },
  { value: "pdf", label: "PDF", hint: "Opens the print dialog — choose “Save as PDF” there" },
  { value: "docx", label: "Word", hint: "A .docx document for Word, Pages or Google Docs (images included)" },
  { value: "opml", label: "OPML", hint: "An outline for Workflowy, Dynalist, OmniOutliner, Logseq …" },
  { value: "json", label: "JSON", hint: "Structured data for scripts and other apps (blocks, properties, rows)" },
];
const WORKSPACE_FORMATS: { value: WorkspaceExportFormat; label: string; hint: string }[] = [
  { value: "markdown", label: "Markdown", hint: "ZIP with .md and .csv files, sub-pages in folders, assets/" },
  { value: "html", label: "HTML", hint: "ZIP with web pages, sub-pages in folders, images and files in assets/" },
  { value: "archive", label: "Based archive", hint: "Everything, lossless — import it into Based again" },
];

/** Export-Dialog: mit `pageID` die Seite, sonst der ganze Workspace. */
export function ExportDialog({ client, pageID, onClose }: { client: StoreClient; pageID?: string; onClose: () => void }) {
  const formats = pageID ? PAGE_FORMATS : WORKSPACE_FORMATS;
  const [format, setFormat] = useState<WorkspaceExportFormat | PageFormat>("markdown");
  const [subpages, setSubpages] = useState(false);
  const [images, setImages] = useState<"embed" | "folder">("embed");
  const [frontmatter, setFrontmatter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
  const labelID = useId();
  const run = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      if (pageID && format === "pdf") {
        const doc = await client.printPage(pageID, exportStylesheet());
        await printHTML(doc.html, doc.title);
        setResult({ ok: true, text: `Sent “${doc.title}” to the print dialog.${doc.missing ? ` ${doc.missing} image${doc.missing === 1 ? " is" : "s are"} missing on this device.` : ""}` });
        return;
      }
      // HTML: Stylesheet aus den Tokens; eine Seite bettet Bilder ein (oder legt sie in assets/), der Workspace legt sie in assets/.
      const html = format === "html" ? { css: exportStylesheet(), ...(pageID ? { subpages, images } : {}) } : format === "markdown" && frontmatter ? { frontmatter: true } : undefined;
      const file = pageID ? await client.exportPage(pageID, format as PageExportFormat, html) : await client.exportWorkspace(format as WorkspaceExportFormat, html);
      download(file);
      setResult({ ok: true, text: file.summary });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const zip = subpages || images === "folder";
  return (
    <Dialog title={pageID ? "Export page" : "Export workspace"} onClose={onClose} busy={busy}>
      <div id={labelID} className="t-meta">Format</div>
      <div role="radiogroup" aria-labelledby={labelID} className="dialog-options">
        {formats.map((f) => (
          <button key={f.value} type="button" role="radio" aria-checked={format === f.value} className="option" aria-selected={format === f.value} onClick={() => { setFormat(f.value); setResult(undefined); }}>
            <span className="grow">
              <strong>{f.label}</strong>
              <span className="t-desc" style={{ display: "block" }}>{f.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {pageID && format === "html" ? (
        <div className="export-options" data-testid="html-export-options">
          <CheckboxInput label="Include sub-pages" description="Each sub-page becomes its own file, in a folder next to this page." value={subpages} onChange={setSubpages} />
          <SegmentedControl label="Images" value={images} onChange={(v) => setImages(v === "folder" ? "folder" : "embed")}>
            <SegmentedControlItem value="embed" label="Embedded in the page" />
            <SegmentedControlItem value="folder" label="In an assets folder" />
          </SegmentedControl>
          <p className="t-desc">{zip ? "You get a ZIP with the page" + (subpages ? ", its sub-pages" : "") + (images === "folder" ? " and an assets folder." : ".") : "You get one .html file. Attached files that can't be embedded (PDF, video) come along in a ZIP."}</p>
        </div>
      ) : null}
      {format === "markdown" ? (
        <div className="export-options" data-testid="markdown-export-options">
          <CheckboxInput label="Properties as YAML front matter" description="Title, dates and properties at the top of each file — for Obsidian and other Markdown tools." value={frontmatter} onChange={setFrontmatter} />
        </div>
      ) : null}
      {result ? <p role={result.ok ? "status" : "alert"} className={result.ok ? "t-desc" : "dialog-error"} data-testid="export-result">{result.text}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="btn ghost" onClick={onClose}>{result?.ok ? "Done" : "Cancel"}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? (format === "pdf" ? "Preparing…" : "Exporting…") : format === "pdf" ? "Print…" : "Export"}</button>
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
