#!/usr/bin/env node
// Waitlist service for basednotes.app. No dependencies: node:http + node:sqlite (Node ≥ 22.13).
//
//   node server/waitlist.mjs                 serve on $PORT (default 8790)
//   node server/waitlist.mjs export          print the waitlist as CSV
//   node server/waitlist.mjs ideas           print submitted roadmap ideas as CSV
//   node server/waitlist.mjs delete <email>  remove one address (right to erasure)
//   node server/waitlist.mjs purge           delete sign-ups older than 24 months
//
// Caddy forwards /api/* here. Data lives in $WAITLIST_DB (default ./data/waitlist.sqlite).
// IP addresses are only held in memory for rate limiting (max. one hour), never stored.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.WAITLIST_DB || "./data/waitlist.sqlite";
const PORT = Number(process.env.PORT || 8790);
const ORIGINS = (process.env.WAITLIST_ORIGINS || "https://basednotes.app,https://www.basednotes.app").split(",");
const ROLES = new Set(["", "knowledge", "business", "study", "dev"]);
const AREAS = new Set(["Workspace", "Databases", "Agents", "Sync", "Mobile and apps"]);
const RETENTION_DAYS = 730;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    consent    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ideas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    area       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// The text shown next to the form when someone signs up; stored with each entry as proof of consent.
const CONSENT = "basednotes.app 2026-11: We only use your email to tell you when the beta opens. Unsubscribe any time.";

const csv = (rows, cols) => [cols.join(",")].concat(rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))).join("\n");

const cmd = process.argv[2];
if (cmd === "export") {
  console.log(csv(db.prepare("SELECT * FROM waitlist ORDER BY created_at").all(), ["email", "name", "role", "created_at", "updated_at", "consent"]));
  process.exit(0);
}
if (cmd === "ideas") {
  console.log(csv(db.prepare("SELECT * FROM ideas ORDER BY created_at").all(), ["id", "area", "text", "created_at"]));
  process.exit(0);
}
if (cmd === "delete") {
  const r = db.prepare("DELETE FROM waitlist WHERE email = ?").run(String(process.argv[3] || "").trim().toLowerCase());
  console.log(r.changes ? "deleted" : "not found");
  process.exit(r.changes ? 0 : 1);
}
if (cmd === "purge") {
  const r = db.prepare(`DELETE FROM waitlist WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`).run();
  console.log(`purged ${r.changes}`);
  process.exit(0);
}

// ---- HTTP -----------------------------------------------------------------------------
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const hits = new Map(); // ip → timestamps (memory only)
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 8;

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_HITS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 60 * 60 * 1000)) hits.delete(ip);
}, 10 * 60 * 1000).unref();

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 4096) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Control characters become spaces (built from char codes to keep the regex lint-clean).
const CONTROL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
const clean = (v, max) => String(v ?? "").replace(CONTROL, " ").trim().slice(0, max);
const now = () => new Date().toISOString();

const upsert = db.prepare(`
  INSERT INTO waitlist (email, name, role, created_at, updated_at, consent) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, updated_at = excluded.updated_at
`);
const addIdea = db.prepare("INSERT INTO ideas (text, area, created_at) VALUES (?, ?, ?)");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || !["/api/waitlist", "/api/ideas"].includes(url.pathname)) return send(res, 404, { error: "not found" });

  const origin = req.headers.origin;
  if (origin && !ORIGINS.includes(origin)) return send(res, 403, { error: "origin" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "slow down" });

  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "bad request" }); }
  if (clean(body.website, 200)) return send(res, 200, { ok: true }); // honeypot filled: a bot

  if (url.pathname === "/api/waitlist") {
    const email = clean(body.email, 254).toLowerCase();
    if (!EMAIL.test(email)) return send(res, 422, { error: "email" });
    const role = ROLES.has(body.role) ? body.role : "";
    const t = now();
    upsert.run(email, clean(body.name, 60), role, t, t, CONSENT);
    return send(res, 200, { ok: true });
  }

  const text = clean(body.text, 280);
  if (!text) return send(res, 422, { error: "text" });
  addIdea.run(text, AREAS.has(body.area) ? body.area : "Workspace", now());
  return send(res, 200, { ok: true });
});

server.listen(PORT, () => console.log(`waitlist service on :${PORT}, db ${DB_PATH}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
