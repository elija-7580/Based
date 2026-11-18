#!/usr/bin/env node
// Waitlist service for basednotes.app. No dependencies: node:http + node:sqlite (Node ≥ 22.13).
//
//   node server/waitlist.mjs                 serve on $PORT (default 8790)
//   node server/waitlist.mjs export          print the waitlist as CSV
//   node server/waitlist.mjs ideas           print submitted roadmap ideas as CSV
//   node server/waitlist.mjs delete <email>  remove one address (right to erasure)
//   node server/waitlist.mjs purge           delete sign-ups older than 24 months and invites expired 30+ days ago
//
// BSD-553: the Mac beta is invite-only. Each tester gets a personal link basednotes.app/download?i=<token>
// (30 days, at most 5 downloads); GET /api/download?i=<token> checks it and serves $BETA_DIR/Based-Notes-Beta.dmg.
//   node server/waitlist.mjs invite <email> [--new]   print the personal link (reuses an active one unless --new)
//   node server/waitlist.mjs invite --wave <file|->   one invite per address in the file or stdin (one per line), CSV out
//   node server/waitlist.mjs invites                  list invites with downloads and status as CSV
//   node server/waitlist.mjs revoke <email|token>     withdraw the active link(s)
//
// Caddy forwards /api/* here. Data lives in $WAITLIST_DB (default ./data/waitlist.sqlite).
// IP addresses are only held in memory for rate limiting (max. one hour), never stored.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const DB_PATH = process.env.WAITLIST_DB || "./data/waitlist.sqlite";
// PORT=0: a free port from the system (tests); empty or missing: 8790
const PORT = process.env.PORT ? Number(process.env.PORT) : 8790;
const ORIGINS = (process.env.WAITLIST_ORIGINS || "https://basednotes.app,https://www.basednotes.app").split(",");
const ROLES = new Set(["", "knowledge", "business", "study", "dev"]);
const AREAS = new Set(["Workspace", "Databases", "Agents", "Sync", "Mobile and apps"]);
const RETENTION_DAYS = 730;
const BETA_DIR = process.env.BETA_DIR || "./beta";
const BETA_FILE = "Based-Notes-Beta.dmg";
const SITE = (process.env.INVITE_BASE || "https://basednotes.app").replace(/\/$/, "");
const INVITE_DAYS = 30;
const INVITE_MAX = 5;
const INVITE_KEEP_DAYS = 30; // purge removes invites this long after they expired

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
// BSD-476: wait for a lock instead of failing at once – the CLI (export, ideas, delete, prune) runs next to the live
// service, and both touch the file on open (journal mode) and close (WAL checkpoint).
db.exec(`
  PRAGMA busy_timeout = 5000;
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
  CREATE TABLE IF NOT EXISTS invites (
    token         TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    downloads     INTEGER NOT NULL DEFAULT 0,
    max_downloads INTEGER NOT NULL DEFAULT ${INVITE_MAX},
    revoked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
`);

// The text shown next to the form when someone signs up; stored with each entry as proof of consent.
const CONSENT = "basednotes.app 2026-11: We only use your email to tell you when the beta opens. Unsubscribe any time.";

const csv = (rows, cols) => [cols.join(",")].concat(rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))).join("\n");

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const now = () => new Date().toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString();
const link = (token) => `${SITE}/download?i=${token}`;
const status = (r, t = now()) => r.revoked_at ? "revoked" : r.expires_at <= t ? "expired" : r.downloads >= r.max_downloads ? "used up" : "active";
const activeInvite = db.prepare("SELECT * FROM invites WHERE email = ? AND revoked_at IS NULL AND expires_at > ? AND downloads < max_downloads ORDER BY created_at DESC LIMIT 1");
const insertInvite = db.prepare("INSERT INTO invites (token, email, created_at, expires_at, downloads, max_downloads) VALUES (?, ?, ?, ?, 0, ?)");
const revokeEmail = db.prepare("UPDATE invites SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL");
const revokeToken = db.prepare("UPDATE invites SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL");

// One personal link per address: an active one is reused (safe to run twice), --new withdraws it and makes a fresh one.
function invite(rawEmail, fresh = false) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`not an email address: ${rawEmail}`);
  const t = now();
  if (!fresh) { const r = activeInvite.get(email, t); if (r) return { email, token: r.token, reused: true }; }
  else revokeEmail.run(t, email);
  const token = randomBytes(32).toString("base64url");
  insertInvite.run(token, email, t, daysFromNow(INVITE_DAYS), INVITE_MAX);
  return { email, token, reused: false };
}

const cmd = process.argv[2];
if (cmd === "invite") {
  const args = process.argv.slice(3);
  try {
    if (args[0] === "--wave") {
      if (!args[1]) throw new Error("usage: invite --wave <file with one address per line>");
      const lines = readFileSync(args[1] === "-" ? 0 : args[1], "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
      const rows = lines.map((l) => invite((/[^\s<>(),;]+@[^\s<>(),;]+/.exec(l) || [l])[0], args.includes("--new")))
        .map((r) => ({ email: r.email, link: link(r.token), note: r.reused ? "existing" : "new" }));
      console.log(csv(rows, ["email", "link", "note"]));
    } else {
      const email = args.find((a) => !a.startsWith("--"));
      if (!email) throw new Error("usage: invite <email> [--new] | invite --wave <file>");
      const r = invite(email, args.includes("--new"));
      console.log(link(r.token));
      console.error(`${r.reused ? "existing" : "new"} invite for ${r.email}: valid ${INVITE_DAYS} days, max. ${INVITE_MAX} downloads`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
if (cmd === "invites") {
  const t = now();
  const rows = db.prepare("SELECT * FROM invites ORDER BY created_at").all().map((r) => ({ ...r, link: link(r.token), status: status(r, t) }));
  console.log(csv(rows, ["email", "status", "downloads", "max_downloads", "created_at", "expires_at", "revoked_at", "link"]));
  let dmg = "missing"; try { dmg = `${(statSync(join(BETA_DIR, BETA_FILE)).size / 1048576).toFixed(1)} MB`; } catch { /* not uploaded yet */ }
  console.error(`beta build ${join(BETA_DIR, BETA_FILE)}: ${dmg}`);
  process.exit(0);
}
if (cmd === "revoke") {
  const key = String(process.argv[3] || "").trim();
  if (!key) { console.error("usage: revoke <email|token>"); process.exit(1); }
  const r = key.includes("@") ? revokeEmail.run(now(), key.toLowerCase()) : revokeToken.run(now(), key);
  console.log(r.changes ? `revoked ${r.changes}` : "not found");
  process.exit(r.changes ? 0 : 1);
}
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
  const i = db.prepare("DELETE FROM invites WHERE expires_at < ?").run(daysFromNow(-INVITE_KEEP_DAYS));
  console.log(`purged ${r.changes}, invites ${i.changes}`);
  process.exit(0);
}

// ---- HTTP -----------------------------------------------------------------------------
const hits = new Map(); // ip → timestamps (memory only)
const dlHits = new Map(); // same for /api/download, own budget
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 8;
const MAX_DL_HITS = 20;

function limited(ip, map = hits, max = MAX_HITS) {
  const t = Date.now();
  const list = (map.get(ip) || []).filter((x) => t - x < WINDOW_MS);
  list.push(t);
  map.set(ip, list);
  return list.length > max;
}
setInterval(() => {
  const t = Date.now();
  for (const map of [hits, dlHits]) for (const [ip, list] of map) if (!list.some((x) => t - x < 60 * 60 * 1000)) map.delete(ip);
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

const upsert = db.prepare(`
  INSERT INTO waitlist (email, name, role, created_at, updated_at, consent) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, updated_at = excluded.updated_at
`);
const addIdea = db.prepare("INSERT INTO ideas (text, area, created_at) VALUES (?, ?, ?)");

// ---- BSD-553: invite-only beta download ------------------------------------------------
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const findInvite = db.prepare("SELECT * FROM invites WHERE token = ?");
// Counted in one statement, so two parallel requests can't both take the last download.
const countDownload = db.prepare("UPDATE invites SET downloads = downloads + 1 WHERE token = ? AND revoked_at IS NULL AND expires_at > ? AND downloads < max_downloads");

// Browsers open this link directly, so refusals are a short page, not JSON.
function refuse(res, status, text) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Based Notes Beta</title>` +
    `<p style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em">${text} ` +
    `Questions: <a href="mailto:hello@basednotes.app">hello@basednotes.app</a> · <a href="/download">basednotes.app/download</a></p>`);
}

function download(req, res, url, ip) {
  if (limited(ip, dlHits, MAX_DL_HITS)) return refuse(res, 429, "Too many tries. Please wait a few minutes.");
  const token = url.searchParams.get("i") || "";
  const row = TOKEN.test(token) ? findInvite.get(token) : undefined;
  if (!row) return refuse(res, 403, "This download link is not valid. The beta is invite-only.");
  const st = status(row);
  if (st === "revoked") return refuse(res, 403, "This invitation was withdrawn.");
  if (st === "expired") return refuse(res, 403, "This download link has expired. Write to us for a new one.");

  const file = join(BETA_DIR, BETA_FILE);
  let size;
  try { size = statSync(file).size; } catch { return refuse(res, 503, "The beta build is not available right now. Please try again in a few minutes."); }

  // A resumed download (Range from a later byte) continues one that was already counted and is not counted again.
  const range = /^bytes=(\d+)-$/.exec(String(req.headers.range || ""));
  const start = range ? Number(range[1]) : 0;
  const resume = start > 0 && start < size && row.downloads > 0;
  if (!resume && st === "used up") return refuse(res, 403, `This link has been used ${row.max_downloads} times. Write to us if you need it again.`);
  if (!resume && req.method === "GET" && countDownload.run(token, now()).changes !== 1) {
    return refuse(res, 403, "This download link can't be used any more.");
  }

  const headers = {
    "content-type": "application/x-apple-diskimage",
    "content-disposition": `attachment; filename="${BETA_FILE}"`,
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    "x-robots-tag": "noindex"
  };
  if (resume) {
    res.writeHead(206, { ...headers, "content-length": size - start, "content-range": `bytes ${start}-${size - 1}/${size}` });
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
  }
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file, { start: resume ? start : 0 });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/download") {
    return download(req, res, url, String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim());
  }
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

server.listen(PORT, () => console.log(`waitlist service on :${server.address().port}, db ${DB_PATH}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
