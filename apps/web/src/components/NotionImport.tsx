// BSD-217 Teil 2: „Import from Notion“ über die Notion-API – Seiten, Datenbanken mit ihren Ansichten (Filter,
// Sortierung, Gruppen, Layouts), Spalten und Struktur. Token nur auf diesem Gerät (verschlüsselt, shell/secrets.ts),
// Anfragen gehen direkt an Notion (Desktop-App), nicht über einen Based-Server.
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { NotionWorkspaceImport, parseNotionTargets } from "@based/core";
import { useEffect, useRef, useState } from "react";
import { describeNotionError, notionBaseURL, notionToken, notionTransport } from "../shell/notionTransport.js";
import type { StoreClient } from "../worker/client.js";
import { ImportCancelledError } from "../worker/importClient.js";
import type { ImportSummary } from "../worker/interop.js";
import { NotionImportError, runNotionImport, type NotionImportJob } from "../worker/notionApiClient.js";

type Phase =
  | { k: "form" }
  | { k: "running"; fraction: number; message: string }
  | { k: "writing" }
  | { k: "error"; message: string; report?: string | undefined };

interface Props {
  client: StoreClient;
  onBack: () => void;
  onDone: (summary: ImportSummary, report: string) => void;
  onBusy: (busy: boolean) => void;
}

export function NotionImport({ client, onBack, onDone, onBusy }: Props) {
  const [phase, setPhase] = useState<Phase>({ k: "form" });
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(true);
  const [links, setLinks] = useState("");
  const [subpages, setSubpages] = useState(true);
  const [files, setFiles] = useState(true);
  const [rowContent, setRowContent] = useState(true);
  const [check, setCheck] = useState<{ k: "idle" } | { k: "busy" } | { k: "ok"; who: string } | { k: "bad"; message: string }>({ k: "idle" });
  const job = useRef<NotionImportJob | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void notionToken.has().then((h) => alive.current && setSaved(h)).catch(() => undefined);
    return () => {
      alive.current = false;
      job.current?.cancel();
    };
  }, []);
  const busy = phase.k === "running" || phase.k === "writing";
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const base = notionBaseURL();
  const currentToken = async () => token.trim() || (saved ? (await notionToken.get()) ?? "" : "");
  const targets = parseNotionTargets(links);
  // Zeilen, aus denen sich kein Ziel lesen lässt (doppelte Links zählen nicht als Fehler).
  const unreadable = links.split("\n").filter((line) => line.trim() !== "" && parseNotionTargets(line).length === 0).length;

  const verify = async () => {
    setCheck({ k: "busy" });
    try {
      const t = await currentToken();
      if (!t) throw new Error("Paste the integration token first.");
      const transport = await notionTransport();
      const who = await NotionWorkspaceImport.verify(t, transport, base ? { baseURL: base } : undefined);
      if (alive.current) setCheck({ k: "ok", who });
    } catch (e) {
      if (alive.current) setCheck({ k: "bad", message: describeNotionError(e, { customBase: base !== undefined }) });
    }
  };

  const start = async () => {
    let report: string | undefined;
    try {
      const t = await currentToken();
      if (!t) {
        setPhase({ k: "error", message: "Paste the integration token first." });
        return;
      }
      if (token.trim()) {
        if (remember) await notionToken.set(token);
        else await notionToken.set(undefined);
      }
      setPhase({ k: "running", fraction: 0, message: "Connecting to Notion…" });
      const transport = await notionTransport();
      const running = runNotionImport({
        token: t, targets, transport, baseURL: base,
        options: { subpages, downloadFiles: files, rowContent },
        onProgress: (fraction, message) => alive.current && setPhase({ k: "running", fraction, message }),
        onAsset: (a) => client.importAsset(a),
      });
      job.current = running;
      const done = await running.result;
      job.current = undefined;
      report = done.report;
      if (!alive.current) return;
      setPhase({ k: "writing" });
      const summary = await client.commitImport(done.payload);
      if (alive.current) onDone(summary, done.report);
    } catch (e) {
      job.current = undefined;
      if (!alive.current) return;
      if (e instanceof ImportCancelledError) setPhase({ k: "form" });
      else setPhase({ k: "error", message: describeNotionError(e, { customBase: base !== undefined }), report: e instanceof NotionImportError ? e.report : report });
    }
  };

  if (busy) {
    const fraction = phase.k === "running" ? phase.fraction : 1;
    return (
      <>
        <p className="t-desc" aria-live="polite" data-testid="notion-progress">{phase.k === "running" ? phase.message : "Adding to your workspace…"}</p>
        <div className="progress" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={phase.k !== "running"} onClick={() => job.current?.cancel()}>Cancel</button>
        </div>
      </>
    );
  }

  return (
    <form className="notion-import" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <p className="t-desc">
        Brings pages over with their layout — columns, toggles, callouts — and databases with every view: filters, sorts, groups, boards, calendars, timelines, charts and dashboards.
        Importing again updates those pages and keeps what you changed in Based.
      </p>
      <details className="notion-help" open={!saved}>
        <summary className="t-meta">How to get a token</summary>
        <ol className="notion-steps t-desc">
          <li>In Notion, open <strong>Settings → Connections → Develop or manage integrations</strong> and create an internal integration with read access.</li>
          <li>Share the pages you want with it: <strong>••• → Connections</strong> on each top page.</li>
          <li>Paste the integration’s token here. It stays on this device, encrypted, and is only sent to Notion.</li>
        </ol>
      </details>
      <label className="field">
        <span className="t-meta">Integration token</span>
        <span className="field-row">
          <input type="password" className="input" autoComplete="off" spellCheck={false} aria-label="Integration token"
            placeholder={saved ? "Saved on this device — paste a new one to replace it" : "ntn_…"} value={token}
            onChange={(e) => { setToken(e.target.value); setCheck({ k: "idle" }); }} />
          <button type="button" className="btn" disabled={check.k === "busy" || (!token.trim() && !saved)} onClick={() => void verify()}>{check.k === "busy" ? "Checking…" : "Check"}</button>
        </span>
      </label>
      {check.k === "ok" ? <p className="t-desc notion-ok" role="status" data-testid="notion-verified">Connected as {check.who}</p> : null}
      {check.k === "bad" ? <p className="dialog-error" role="alert">{check.message}</p> : null}
      <div className="notion-options">
        <CheckboxInput label="Remember the token on this device" value={remember} onChange={setRemember} />
        {saved ? <button type="button" className="btn ghost" onClick={() => void notionToken.set(undefined).then(() => { setSaved(false); setCheck({ k: "idle" }); })}>Forget saved token</button> : null}
      </div>
      <label className="field">
        <span className="t-meta">Pages or databases (optional)</span>
        <textarea className="input notion-links" rows={3} aria-label="Notion links" spellCheck={false}
          placeholder="Paste Notion links, one per line. Leave empty to import everything shared with the integration."
          value={links} onChange={(e) => setLinks(e.target.value)} />
      </label>
      {unreadable > 0 ? <p className="dialog-error" role="alert">{unreadable === 1 ? "One line isn’t a Notion link or ID and will be skipped." : `${unreadable} lines aren’t Notion links or IDs and will be skipped.`}</p> : null}
      <div className="notion-options">
        <CheckboxInput label="Include sub-pages" value={subpages} onChange={setSubpages} />
        <CheckboxInput label="Copy images and files" value={files} onChange={setFiles} />
        <CheckboxInput label="Content inside database rows" value={rowContent} onChange={setRowContent} />
      </div>
      {phase.k === "error" ? (
        <div className="dialog-report" role="alert">
          <p className="dialog-error">Import failed: {phase.message}</p>
          {phase.report ? <CopyReport report={phase.report} /> : null}
        </div>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn ghost" onClick={onBack}>Back</button>
        <button type="submit" className="btn primary" disabled={!token.trim() && !saved}>{targets.length ? `Import ${targets.length === 1 ? "1 link" : `${targets.length} links`}` : "Import everything shared"}</button>
      </div>
    </form>
  );
}

/** Diagnosebericht (ohne Token und Inhalte) in die Zwischenablage. */
export function CopyReport({ report }: { report: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn ghost" data-testid="notion-copy-report" onClick={() => {
      void navigator.clipboard.writeText(report).then(() => setCopied(true), () => setCopied(false));
    }}>{copied ? "Report copied" : "Copy report"}</button>
  );
}
