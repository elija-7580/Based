// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-631 (read-only waitlist numbers) and BSD-632 (problem reports → backlog) of the waitlist service.
// The Notion API is a local fake: these tests never call api.notion.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describeEvent, parseReport, reportBlocks, reportProperties, reportTitle, systemLabel } from "../server/report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server", "waitlist.mjs");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image data")]);

async function withServer(fn, extraEnv = {}, dir = mkdtempSync(join(tmpdir(), "based-api-"))) {
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    env: { ...process.env, PORT: "0", WAITLIST_DB: join(dir, "w.sqlite"), WAITLIST_ORIGINS: "https://basednotes.app", BETA_DIR: join(dir, "beta"),
      WAITLIST_STATS_TOKEN: "", NOTION_TOKEN: "", NOTION_BACKLOG_DATA_SOURCE: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /waitlist service on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const get = (path, init = {}) => fetch(`${base}${path}`, init);
  try {
    await fn({ post, get, dir, base, stderr: () => stderr });
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  return dir;
}

const cli = (dir, ...args) => execFileSync(process.execPath, ["--no-warnings", SERVER, ...args],
  { env: { ...process.env, WAITLIST_DB: join(dir, "w.sqlite"), NOTION_TOKEN: "", NOTION_BACKLOG_DATA_SOURCE: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function bundle(id = "20261121-031500-ab3f", extra = {}) {
  return {
    format: "based-bug-report", version: 1, id, createdAt: "2026-11-21T02:15:00.000Z", note: "Clicked the sidebar, the page jumped", realText: false,
    screenshot: "screenshot.png",
    app: { version: "0.2.12", commit: "abc1234", shell: "tauri", platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    env: { width: 1280, height: 820, dpr: 2, zoom: 1, theme: "dark", route: "/p/x" },
    state: { menus: [] },
    layout: { items: [], issues: [{ kind: "covers", over: "menu", under: "sidebar", area: 120 }] },
    recording: { events: [{ t: 1, kind: "key", key: "B", mods: { meta: true, shift: true } }, { t: 2, kind: "pointer", phase: "down", x: 1, y: 2, button: 0, detail: 1, target: "sidebar-row" }] },
    log: [{ at: 1, level: "warn", message: "slow render" }],
    ...extra
  };
}

/** A fake Notion API: records every request; `failPages` page creations answer 503 first. */
async function fakeNotion({ failPages = 0, refuseUploads = false } = {}) {
  const calls = [];
  let uploads = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const call = { method: req.method, path: req.url, headers: req.headers, raw };
      try { call.body = JSON.parse(raw.toString("utf8")); } catch { /* multipart */ }
      calls.push(call);
      const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/v1/file_uploads") {
        if (refuseUploads) return json(400, { object: "error", message: "file too large" });
        return json(200, { object: "file_upload", id: `upload-${++uploads}`, status: "pending" });
      }
      if (/^\/v1\/file_uploads\/[^/]+\/send$/.test(req.url)) return json(200, { object: "file_upload", status: "uploaded" });
      if (req.url === "/v1/pages") {
        if (failPages > 0) { failPages--; return json(503, { object: "error", message: "service unavailable" }); }
        return json(200, { object: "page", id: "page-1", url: "https://www.notion.so/page-1" });
      }
      json(404, { object: "error" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const until = async (cond, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

// ---- BSD-631 --------------------------------------------------------------------------------

test("stats (BSD-631): off without a token, 401 with a wrong one, numbers and yes/no only with the right one", async () => {
  await withServer(async ({ get }) => {
    assert.equal((await get("/api/waitlist/stats")).status, 404);
    assert.equal((await get("/api/waitlist/check?email=a@b.co")).status, 404);
  });
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
  await withServer(async ({ post, get }) => {
    assert.equal((await post("/api/waitlist", { email: "Ada@Example.org", name: "Ada" })).status, 200);
    assert.equal((await get("/api/waitlist/stats")).status, 401, "no header");
    assert.equal((await get("/api/waitlist/stats", { headers: { authorization: "Bearer wrong" } })).status, 401, "wrong token");
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const res = await get("/api/waitlist/stats", auth);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /@|Ada/, "no addresses or names in stats");
    const s = JSON.parse(text);
    assert.equal(s.count, 1);
    assert.match(s.last_created_at, /^2\d{3}-\d\d-\d\dT/);
    assert.equal(s.invites_active, 0);
    assert.deepEqual(s.reports, { total: 0, in_backlog: 0, waiting: 0, notion: false });
    assert.deepEqual(await (await get("/api/waitlist/check?email=ADA@example.org", auth)).json(), { listed: true, created_at: s.last_created_at });
    assert.deepEqual(await (await get("/api/waitlist/check?email=bob@example.org", auth)).json(), { listed: false, created_at: null });
    assert.equal((await get("/api/waitlist/check?email=nope", auth)).status, 422);
    // the same rate limit as the forms (8 per 10 minutes), counted before the token check
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get("/api/waitlist/stats", auth)).status);
    assert.deepEqual(codes.slice(0, 2), [200, 200]);
    assert.equal(codes.at(-1), 429);
  }, { WAITLIST_STATS_TOKEN: TOKEN });
});

test("deploy (BSD-631/632): token and Notion variables reach the service, documented for Elija", () => {
  const repo = join(ROOT, "..", "..");
  for (const f of ["docker-compose.yml", "edge/docker-compose.yml"]) {
    const yml = readFileSync(join(repo, "deploy", "website", f), "utf8");
    assert.match(yml, /WAITLIST_STATS_TOKEN: \$\{WAITLIST_STATS_TOKEN:-\}/, f);
    assert.match(yml, /NOTION_TOKEN: \$\{NOTION_TOKEN:-\}/, f);
    assert.match(yml, /NOTION_BACKLOG_DATA_SOURCE: \$\{NOTION_BACKLOG_DATA_SOURCE:-\}/, f);
  }
  const readme = readFileSync(join(repo, "deploy", "website", "README.md"), "utf8");
  assert.match(readme, /openssl rand -hex 24/);
  assert.match(readme, /api\/waitlist\/stats/);
  assert.match(readme, /Develop or manage integrations/);
  assert.match(readme, /756f15b3-f24d-4b7c-aecf-88ed8fac1119/);
  const env = readFileSync(join(repo, "deploy", "website", ".env.example"), "utf8");
  assert.match(env, /# WAITLIST_STATS_TOKEN=/);
  assert.match(env, /# NOTION_TOKEN=/);
});

// ---- BSD-632 --------------------------------------------------------------------------------

test("report (BSD-632): bundle rules, PNG check, title, properties and page content", () => {
  assert.ok(parseReport({ bundle: bundle() }));
  assert.equal(parseReport({ bundle: bundle() }).png, undefined);
  assert.ok(parseReport({ bundle: bundle(), screenshot: PNG.toString("base64") }).png.equals(PNG));
  assert.ok(parseReport({ bundle: bundle(), screenshot: `data:image/png;base64,${PNG.toString("base64")}` }).png.equals(PNG));
  assert.equal(parseReport({ bundle: bundle(), screenshot: Buffer.from("GIF89a").toString("base64") }), undefined, "not a PNG");
  assert.equal(parseReport({ bundle: bundle(), screenshot: "%%%" }), undefined);
  assert.equal(parseReport({ bundle: { ...bundle(), format: "other" } }), undefined);
  assert.equal(parseReport({ bundle: bundle("../../etc/passwd") }), undefined, "id is a file name");
  assert.equal(parseReport({ bundle: { ...bundle(), recording: {} } }), undefined);
  assert.equal(parseReport(null), undefined);

  assert.equal(systemLabel(bundle().app), "macOS");
  assert.equal(reportTitle(bundle()), "Mac-Beta · Bericht 21.11.2026 – 0.2.12, macOS");
  assert.equal(reportTitle(bundle("20261121-031500-ab3f", { app: { shell: "web" } })), "Mac-Beta · Bericht 21.11.2026 – dev, unknown");
  assert.equal(describeEvent({ kind: "key", key: "B", mods: { meta: true, shift: true } }), "key ⌘⇧B");
  const p = reportProperties(bundle());
  assert.equal(p.Status.status.name, "Inbox");
  assert.equal(p.Quelle.select.name, "Log/Bericht");
  assert.equal(p.Typ.select.name, "Bug");
  const blocks = reportBlocks(bundle({}), { screenshotUpload: "u1", bundleUpload: "u2" });
  const text = JSON.stringify(blocks);
  assert.match(text, /Clicked the sidebar/);
  assert.match(text, /menu verdeckt sidebar/);
  assert.match(text, /pointer down on sidebar-row/);
  assert.ok(blocks.some((b) => b.type === "image" && b.image.file_upload.id === "u1"));
  assert.ok(blocks.some((b) => b.type === "file" && b.file.file_upload.id === "u2"));
  assert.ok(blocks.length < 100, "one request");
  const long = reportBlocks(bundle(undefined, { note: "x".repeat(5000) }));
  assert.ok(long[0].paragraph.rich_text[0].text.content.length <= 2000, "Notion text limit");
});

test("report (BSD-632): stored without Notion variables, duplicate, 400, 413, CORS, rate limit", async () => {
  const dir = await withServer(async ({ post, get, base }) => {
    const pre = await fetch(`${base}/api/report`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers"), /content-type/);

    const ok = await post("/api/report", { bundle: bundle(), screenshot: PNG.toString("base64") }, { origin: "tauri://localhost" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await ok.json(), { ok: true, id: "20261121-031500-ab3f" });
    assert.deepEqual(await (await post("/api/report", { bundle: bundle() })).json(), { ok: true, id: "20261121-031500-ab3f", duplicate: true });
    assert.equal((await post("/api/report", "{not json")).status, 400);
    assert.equal((await post("/api/report", { bundle: { format: "based-bug-report" } })).status, 400);
    assert.equal((await post("/api/report", { bundle: bundle("20261121-031501-0001"), screenshot: "R0lGODlh" })).status, 400);
    const big = await post("/api/report", { bundle: bundle("20261121-031502-0002"), screenshot: Buffer.alloc(9 * 1024 * 1024, 1).toString("base64") });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: "too large" });
    assert.equal((await post("/api/report", { bundle: bundle("20261121-031503-0003") })).status, 200);
    assert.equal((await post("/api/report", { bundle: bundle("20261121-031504-0004") })).status, 200, "8th in 10 minutes");
    assert.equal((await post("/api/report", { bundle: bundle("20261121-031505-0005") })).status, 429);
    assert.equal((await get("/api/report")).status, 404);
  });
  const stored = JSON.parse(readFileSync(join(dir, "reports", "20261121-031500-ab3f.json"), "utf8"));
  assert.equal(stored.note, "Clicked the sidebar, the page jumped");
  assert.ok(readFileSync(join(dir, "reports", "20261121-031500-ab3f.png")).equals(PNG));
  assert.equal(existsSync(join(dir, "reports", "20261121-031502-0002.json")), false, "too large: nothing stored");
  const rows = cli(dir, "reports").trim().split("\n");
  assert.equal(rows.length, 4, rows.join("\n")); // header + 3 reports
  assert.match(rows[1], /^"20261121-031500-ab3f",".+","0.2.12","macOS","1","","0"/);
});

test("report (BSD-632): goes to the backlog through the Notion API (fake), retried after a failure, once only", async () => {
  const notion = await fakeNotion({ failPages: 1 });
  try {
    await withServer(async ({ post }) => {
      const res = await post("/api/report", { bundle: bundle(), screenshot: PNG.toString("base64") });
      assert.equal(res.status, 200);
      const sent = await until(() => notion.calls.filter((c) => c.path === "/v1/pages").length >= 2);
      assert.ok(sent, `retried: ${notion.calls.map((c) => c.path).join(", ")}`);
      await new Promise((r) => setTimeout(r, 600)); // more retry ticks: no second page
      // the app's queue resends after a lost answer: no second entry
      assert.equal((await (await post("/api/report", { bundle: bundle() })).json()).duplicate, true);
      await new Promise((r) => setTimeout(r, 300));
    }, { NOTION_TOKEN: "secret_test", NOTION_BACKLOG_DATA_SOURCE: "756f15b3-f24d-4b7c-aecf-88ed8fac1119", NOTION_API: notion.url, REPORT_RETRY_MS: "100", REPORT_BACKOFF_MS: "100" });
  } finally { await notion.close(); }

  const pages = notion.calls.filter((c) => c.path === "/v1/pages");
  assert.equal(pages.length, 2, "one failure, one success, nothing after");
  for (const c of notion.calls) {
    assert.equal(c.method, "POST");
    assert.equal(c.headers.authorization, "Bearer secret_test");
    assert.equal(c.headers["notion-version"], "2025-09-03");
  }
  const page = pages.at(-1).body;
  assert.deepEqual(page.parent, { type: "data_source_id", data_source_id: "756f15b3-f24d-4b7c-aecf-88ed8fac1119" });
  assert.equal(page.properties.Name.title[0].text.content, "Mac-Beta · Bericht 21.11.2026 – 0.2.12, macOS");
  assert.equal(page.properties.Status.status.name, "Inbox");
  assert.equal(page.properties.Quelle.select.name, "Log/Bericht");
  assert.equal(page.properties.Typ.select.name, "Bug");
  const image = page.children.find((b) => b.type === "image");
  const file = page.children.find((b) => b.type === "file");
  assert.ok(image && file, "screenshot and bundle attached");
  const creates = notion.calls.filter((c) => c.path === "/v1/file_uploads").map((c) => c.body);
  assert.ok(creates.some((b) => b.filename === "20261121-031500-ab3f.png" && b.content_type === "image/png"));
  assert.ok(creates.some((b) => b.filename === "20261121-031500-ab3f.json" && b.content_type === "application/json"));
  const sends = notion.calls.filter((c) => /\/send$/.test(c.path));
  assert.ok(sends.every((c) => /multipart\/form-data/.test(c.headers["content-type"])));
  assert.ok(sends.some((c) => c.raw.includes(PNG)), "PNG bytes uploaded");
  assert.match(sends.map((c) => c.raw.toString("latin1")).join(""), /Clicked the sidebar/, "bundle uploaded");
});

test("report (BSD-632): a refused upload doesn't block the entry; stats show it; purge deletes after 90 days", async () => {
  const notion = await fakeNotion({ refuseUploads: true });
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
  let dir;
  try {
    dir = await withServer(async ({ post, get }) => {
      assert.equal((await post("/api/report", { bundle: bundle(), screenshot: PNG.toString("base64") })).status, 200);
      assert.ok(await until(() => notion.calls.some((c) => c.path === "/v1/pages")));
      await new Promise((r) => setTimeout(r, 200));
      const s = await (await get("/api/waitlist/stats", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      assert.deepEqual(s.reports, { total: 1, in_backlog: 1, waiting: 0, notion: true });
    }, { WAITLIST_STATS_TOKEN: TOKEN, NOTION_TOKEN: "secret_test", NOTION_BACKLOG_DATA_SOURCE: "ds", NOTION_API: notion.url, REPORT_RETRY_MS: "100" });
  } finally { await notion.close(); }
  const page = notion.calls.find((c) => c.path === "/v1/pages").body;
  assert.equal(page.children.some((b) => b.type === "image" || b.type === "file"), false);
  assert.match(JSON.stringify(page.children), /nicht angehängt/);

  // 90 days: rows and files go with `purge` (and once a day in the running service)
  const db = new DatabaseSync(join(dir, "w.sqlite"));
  db.prepare("UPDATE reports SET received_at = ?").run(new Date(Date.now() - 91 * 86400000).toISOString());
  db.close();
  assert.match(cli(dir, "purge"), /reports 1/);
  assert.equal(existsSync(join(dir, "reports", "20261121-031500-ab3f.json")), false);
  assert.equal(existsSync(join(dir, "reports", "20261121-031500-ab3f.png")), false);
  assert.equal(cli(dir, "reports").trim().split("\n").length, 1);
});

test("report (BSD-632): with WAITLIST_RELOAD=1 a change to report.mjs restarts the service too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "based-api-reload-"));
  writeFileSync(join(dir, "waitlist.mjs"), readFileSync(SERVER));
  writeFileSync(join(dir, "report.mjs"), readFileSync(join(ROOT, "server", "report.mjs")));
  const child = spawn(process.execPath, ["--no-warnings", join(dir, "waitlist.mjs")], {
    env: { ...process.env, PORT: "0", WAITLIST_DB: join(dir, "w.sqlite"), WAITLIST_RELOAD: "1", WAITLIST_RELOAD_MS: "100", NOTION_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    assert.ok(await until(() => /waitlist service on/.test(out)), "started");
    writeFileSync(join(dir, "report.mjs"), readFileSync(join(dir, "report.mjs"), "utf8") + "\n// new version\n");
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("privacy (BSD-632): problem reports, Notion as processor, 90 days, built into public/", () => {
  for (const f of [join(ROOT, "src", "legal", "privacy.html"), join(ROOT, "public", "privacy", "index.html")]) {
    const s = readFileSync(f, "utf8");
    assert.match(s, /<h2>Problem reports from the app<\/h2>/, f);
    assert.match(s, /deleted there after 90 days/, f);
    assert.match(s, /Notion Labs, Inc\./, f);
    assert.match(s, /We do not send waitlist addresses to Notion\./, f);
  }
  assert.match(readFileSync(join(ROOT, "..", "..", "docs", "beta", "README.md"), "utf8"), /\*\*Send to Based\*\*/);
});
