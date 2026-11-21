// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-632: problem reports from the app ("Send to Based"). POST /api/report takes a bug bundle (the format of
// packages/core/src/bugReport.ts, checked by the same rules as parseBugBundle) plus an optional PNG screenshot,
// stores both under $REPORTS_DIR (default <db folder>/reports) and creates an entry in the Based backlog through the
// Notion API – in the background, with retries, only when NOTION_TOKEN and NOTION_BACKLOG_DATA_SOURCE are set.
// Without them the reports are only stored (nothing is lost) and go to Notion once the variables are set.
// Reports are deleted from the server after 90 days. No dependencies (this folder is mounted into node:22-alpine).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPORT_MAX_BYTES = 8 * 1024 * 1024;
export const REPORT_KEEP_DAYS = 90;
export const REPORT_MAX_ATTEMPTS = 12;
const ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NOTION_VERSION = "2025-09-03";
const TEXT_MAX = 1900; // Notion allows 2000 characters per text object

/** The body of POST /api/report: `{ bundle, screenshot? }` → the bundle and the PNG bytes, or undefined (400). */
export function parseReport(body) {
  if (!body || typeof body !== "object") return undefined;
  const b = body.bundle;
  // the rules of parseBugBundle (packages/core/src/bugReport.ts), plus an id that is safe as a file name
  if (!b || typeof b !== "object" || b.format !== "based-bug-report" || typeof b.id !== "string" || !ID.test(b.id)) return undefined;
  if (!b.recording || !Array.isArray(b.recording.events)) return undefined;
  let png;
  if (body.screenshot !== undefined && body.screenshot !== null && body.screenshot !== "") {
    if (typeof body.screenshot !== "string") return undefined;
    const raw = body.screenshot.replace(/^data:image\/png;base64,/, "").replace(/\s+/g, "");
    if (!BASE64.test(raw)) return undefined;
    png = Buffer.from(raw, "base64");
    if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return undefined;
  }
  return { bundle: b, png };
}

/** Rough system from platform/user agent – the same rule as systemLabel in packages/core/src/bugReport.ts. */
export function systemLabel(app = {}) {
  const s = `${app.platform ?? ""} ${app.userAgent ?? ""}`;
  if (/iPhone|iPad|iOS/i.test(s)) return "iOS";
  if (/Mac/i.test(s)) return "macOS";
  if (/Win/i.test(s)) return "Windows";
  if (/Linux|X11/i.test(s)) return "Linux";
  return "unknown";
}

const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const cut = (s, max = TEXT_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "21.11.2026 14:05" in Vienna time (the backlog is read there). */
function viennaTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return str(iso);
  return new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d).replace(",", "");
}

export function reportTitle(bundle) {
  const app = bundle.app || {};
  const date = viennaTime(bundle.createdAt).split(" ")[0];
  return `Mac-Beta · Bericht ${date} – ${str(app.version) || "dev"}, ${systemLabel(app)}`;
}

const mods = (m = {}) => `${m.meta ? "⌘" : ""}${m.ctrl ? "⌃" : ""}${m.alt ? "⌥" : ""}${m.shift ? "⇧" : ""}`;

/** One line per recorded event, without content (typed text in the bundle is already scrambled unless realText). */
export function describeEvent(e) {
  if (!e || typeof e !== "object") return "?";
  switch (e.kind) {
    case "key": return `key ${mods(e.mods)}${str(e.key)}${e.repeat ? " (repeat)" : ""}`;
    case "pointer": return `pointer ${str(e.phase)} on ${str(e.target)}`;
    case "input": return `input ${str(e.inputType)}`;
    case "composition": return `composition ${str(e.phase)}`;
    case "paste": return `paste (${Number(e.files) || 0} files)`;
    case "select": return `select (${str(e.cause)})`;
    case "tr": return `transaction${e.docChanged ? " (doc changed)" : ""}${Array.isArray(e.meta) && e.meta.length ? ` [${e.meta.join(", ")}]` : ""}`;
    case "change": return `change ${str(e.name) || "-"} (${str(e.origin)})`;
    case "yjs": return `yjs ${Number(e.bytes) || 0} bytes (${str(e.origin)})`;
    case "focus": return `focus ${str(e.target)}`;
    case "checkpoint": return "checkpoint";
    default: return str(e.kind) || "?";
  }
}

// ---- Notion blocks -------------------------------------------------------------------------
const rt = (text) => [{ type: "text", text: { content: cut(text) } }];
const para = (text) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(text) } });
const heading = (text) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(text) } });
const bullet = (text) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(text) } });

/** The page content: note, summary, layout findings, last steps, log tail, screenshot and bundle file. */
export function reportBlocks(bundle, { screenshotUpload, bundleUpload, uploadNote } = {}) {
  const app = bundle.app || {};
  const env = bundle.env || {};
  const events = bundle.recording?.events || [];
  const issues = Array.isArray(bundle.layout?.issues) ? bundle.layout.issues : [];
  const log = Array.isArray(bundle.log) ? bundle.log : [];
  const blocks = [];
  blocks.push(para(`Notiz des Testers: ${str(bundle.note).trim() || "(keine)"}`));
  blocks.push(heading("Zusammenfassung"));
  const build = `${str(app.version) || "dev"}${app.commit ? ` (${str(app.commit)})` : ""}`;
  for (const line of [
    `Bericht: ${bundle.id}`,
    `Erstellt: ${viennaTime(bundle.createdAt)} (Wien)`,
    `App: ${build}, Hülle ${str(app.shell) || "?"}, System ${systemLabel(app)}`,
    `Fenster: ${Number(env.width) || 0} × ${Number(env.height) || 0}, dpr ${Number(env.dpr) || 1}, Zoom ${Number(env.zoom) || 1}, Thema ${str(env.theme) || "?"}${env.route ? `, Route ${str(env.route)}` : ""}`,
    `Ereignisse: ${events.length}, Layout-Funde: ${issues.length}, Log-Einträge: ${log.length}${bundle.hangs?.hangs ? `, Hänger: ${bundle.hangs.hangs.length}` : ""}`,
    `Text: ${bundle.realText ? "echt (Tester hat zugestimmt)" : "verwürfelt"}, Bildschirmfoto: ${screenshotUpload ? "ja" : "nein"}`,
  ]) blocks.push(bullet(line));
  if (issues.length) {
    blocks.push(heading("Layout-Funde"));
    for (const i of issues.slice(0, 15)) blocks.push(bullet(`${str(i.over)} verdeckt ${str(i.under)} (${Number(i.area) || 0} px²)`));
  }
  if (events.length) {
    blocks.push(heading("Letzte Schritte"));
    for (const e of events.slice(-20)) blocks.push(bullet(describeEvent(e)));
  }
  if (log.length) {
    blocks.push(heading("Log (Ende)"));
    for (const l of log.slice(-10)) blocks.push(bullet(`${str(l.level)}: ${str(l.message)}`));
  }
  if (screenshotUpload) blocks.push({ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: screenshotUpload } } });
  if (bundleUpload) blocks.push({ object: "block", type: "file", file: { type: "file_upload", file_upload: { id: bundleUpload }, caption: rt(`${bundle.id}.json – als report.json in apps/web/e2e/replay/bundles/ abspielen`) } });
  if (uploadNote) blocks.push(para(uploadNote));
  blocks.push(para(`Auf dem Server: /data/reports/${bundle.id}.json (wird nach ${REPORT_KEEP_DAYS} Tagen gelöscht).`));
  return blocks; // < 100 blocks: one request
}

export function reportProperties(bundle) {
  return {
    Name: { title: rt(reportTitle(bundle)) },
    Status: { status: { name: "Inbox" } },
    Quelle: { select: { name: "Log/Bericht" } },
    Typ: { select: { name: "Bug" } },
    Bereich: { multi_select: [{ name: "Diagnose" }] },
  };
}

class NotionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Creates the backlog entry. `fetchImpl` and `api` are injectable (tests run against a fake, never the real API). */
export async function sendToNotion({ bundle, bundleJson, png, token, dataSource, api = "https://api.notion.com", fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION };
  const call = async (path, body) => {
    const res = await fetchImpl(`${api}${path}`, body instanceof FormData
      ? { method: "POST", headers, body }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new NotionError(res.status, `${path} ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return {}; }
  };
  // Files: create an upload, send the bytes (single part, < 20 MB). A refused file (4xx, e.g. too large for the
  // workspace plan) leaves the page without it instead of blocking the report; 5xx/network errors retry the whole report.
  const upload = async (filename, contentType, bytes) => {
    try {
      const u = await call("/v1/file_uploads", { mode: "single_part", filename, content_type: contentType });
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType }), filename);
      await call(`/v1/file_uploads/${u.id}/send`, form);
      return { id: u.id };
    } catch (e) {
      if (e instanceof NotionError && e.status >= 400 && e.status < 500 && e.status !== 429) return { error: e.message };
      throw e;
    }
  };
  const notes = [];
  let screenshotUpload;
  if (png) {
    const r = await upload(`${bundle.id}.png`, "image/png", png);
    screenshotUpload = r.id;
    if (r.error) notes.push(`Bildschirmfoto nicht angehängt (${r.error}).`);
  }
  const b = await upload(`${bundle.id}.json`, "application/json", Buffer.from(bundleJson));
  if (b.error) notes.push(`Bündel nicht angehängt (${b.error}).`);
  const page = await call("/v1/pages", {
    parent: { type: "data_source_id", data_source_id: dataSource },
    properties: reportProperties(bundle),
    children: reportBlocks(bundle, { screenshotUpload, bundleUpload: b.id, uploadNote: notes.join(" ") || undefined }),
  });
  return { page: str(page.url || page.id) };
}

/** Storage, queue and background sending. `env`: NOTION_TOKEN, NOTION_BACKLOG_DATA_SOURCE, NOTION_API, REPORT_RETRY_MS. */
export function createReports({ db, dir, env = process.env, log = console, fetchImpl = fetch }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id          TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      version     TEXT NOT NULL DEFAULT '',
      system      TEXT NOT NULL DEFAULT '',
      screenshot  INTEGER NOT NULL DEFAULT 0,
      notion_page TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT,
      last_error  TEXT
    );
  `);
  const token = str(env.NOTION_TOKEN).trim();
  const dataSource = str(env.NOTION_BACKLOG_DATA_SOURCE).trim();
  const api = (str(env.NOTION_API).trim() || "https://api.notion.com").replace(/\/$/, "");
  const configured = Boolean(token && dataSource);
  const retryMs = Number(env.REPORT_RETRY_MS) || 60_000;

  const find = db.prepare("SELECT id FROM reports WHERE id = ?");
  const insert = db.prepare("INSERT INTO reports (id, received_at, version, system, screenshot) VALUES (?, ?, ?, ?, ?)");
  const due = db.prepare("SELECT * FROM reports WHERE notion_page IS NULL AND attempts < ? AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY received_at LIMIT 5");
  const done = db.prepare("UPDATE reports SET notion_page = ?, last_error = NULL WHERE id = ?");
  const failed = db.prepare("UPDATE reports SET attempts = attempts + 1, next_try_at = ?, last_error = ? WHERE id = ?");

  const files = (id) => ({ json: join(dir, `${id}.json`), png: join(dir, `${id}.png`) });

  /** Stores one report. Same id again: nothing new (the app's queue may resend after a lost answer). */
  function receive({ bundle, png }) {
    if (find.get(bundle.id)) return { id: bundle.id, duplicate: true };
    mkdirSync(dir, { recursive: true });
    const f = files(bundle.id);
    writeFileSync(f.json, JSON.stringify(bundle));
    if (png) writeFileSync(f.png, png);
    insert.run(bundle.id, new Date().toISOString(), str(bundle.app?.version), systemLabel(bundle.app), png ? 1 : 0);
    return { id: bundle.id };
  }

  let busy;
  /** Sends what is due. One run at a time; failures wait 5 min, doubling up to 6 h, at most REPORT_MAX_ATTEMPTS. */
  async function pump() {
    if (!configured) return;
    if (busy) return busy;
    busy = (async () => {
      for (const row of due.all(REPORT_MAX_ATTEMPTS, new Date().toISOString())) {
        const f = files(row.id);
        try {
          const bundleJson = readFileSync(f.json, "utf8");
          let png;
          if (row.screenshot) { try { png = readFileSync(f.png); } catch { /* deleted: send without */ } }
          const r = await sendToNotion({ bundle: JSON.parse(bundleJson), bundleJson, png, token, dataSource, api, fetchImpl });
          done.run(r.page || "created", row.id);
          log.log(`report ${row.id} → backlog ${r.page}`);
        } catch (e) {
          const wait = Math.min(5 * 60_000 * 2 ** row.attempts, 6 * 3600_000);
          failed.run(new Date(Date.now() + (Number(env.REPORT_BACKOFF_MS) || wait)).toISOString(), cut(str(e?.message || e), 500), row.id);
          log.error(`report ${row.id}: Notion failed (${str(e?.message || e).slice(0, 200)}), retry later`);
        }
      }
    })().finally(() => { busy = undefined; });
    return busy;
  }

  /** Deletes reports older than REPORT_KEEP_DAYS (rows and files). */
  function purge(days = REPORT_KEEP_DAYS) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const old = db.prepare("SELECT id FROM reports WHERE received_at < ?").all(cutoff);
    for (const r of old) { const f = files(r.id); rmSync(f.json, { force: true }); rmSync(f.png, { force: true }); }
    db.prepare("DELETE FROM reports WHERE received_at < ?").run(cutoff);
    return old.length;
  }

  function stats() {
    const r = db.prepare("SELECT COUNT(*) AS total, SUM(notion_page IS NOT NULL) AS in_backlog FROM reports").get();
    const total = Number(r.total) || 0;
    const inBacklog = Number(r.in_backlog) || 0;
    return { total, in_backlog: inBacklog, waiting: total - inBacklog, notion: configured };
  }

  const list = () => db.prepare("SELECT * FROM reports ORDER BY received_at").all();
  const retry = () => db.prepare("UPDATE reports SET attempts = 0, next_try_at = NULL WHERE notion_page IS NULL").run().changes;

  /** Background timers for the running service (unref'd: they never keep the process alive). */
  function start() {
    purge();
    setInterval(() => { purge(); }, 24 * 3600_000).unref();
    if (!configured) return;
    setInterval(() => { void pump(); }, retryMs).unref();
    void pump();
  }

  return { receive, pump, purge, stats, list, retry, start, configured };
}
