// Build and waitlist checks for basednotes.app (node --test, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("build: every page exists, nothing points back to the design canvas or to Google", () => {
  const out = mkdtempSync(join(tmpdir(), "based-site-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { env: { ...process.env, WEBSITE_OUT: out, NO_PRERENDER: "1" }, stdio: "pipe" });
  for (const p of ["index.html", "workspace/index.html", "agents/index.html", "leaving-notion/index.html", "roadmap/index.html",
    "manifesto/index.html", "imprint/index.html", "privacy/index.html", "sitemap.xml", "robots.txt", "404.html"]) {
    assert.ok(statSync(join(out, p)).size > 0, p);
  }
  for (const f of walk(out).filter((x) => /\.(html|css|js)$/.test(x))) {
    const s = readFileSync(f, "utf8");
    assert.ok(!s.includes("/_blob/"), `${f}: canvas asset left`);
    assert.ok(!s.includes(".dc.html"), `${f}: canvas link left`);
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(s), `${f}: Google Fonts left`);
    assert.ok(!s.includes("[LINK]"), `${f}: placeholder left`);
  }
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.match(home, /window\.basedSite\.waitlist\(this, e\)/, "home sends the waitlist");
  assert.match(home, /dc-tpl-mobile/, "home carries the phone version");
  assert.match(home, /href="\/privacy"/);
  const imprint = readFileSync(join(out, "imprint", "index.html"), "utf8");
  assert.match(imprint, /Offenlegung gemäß § 25 Mediengesetz/);
  assert.match(imprint, /hello@basednotes\.app/);
});

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "based-wl-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--no-warnings", join(ROOT, "server", "waitlist.mjs")], {
    env: { ...process.env, PORT: String(port), WAITLIST_DB: join(dir, "w.sqlite"), WAITLIST_ORIGINS: "https://basednotes.app" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("waitlist service") && resolve());
    child.on("exit", (c) => reject(new Error("server exited " + c)));
  });
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  try {
    await fn(post, dir);
  } finally {
    child.kill();
  }
  return dir;
}

test("waitlist: stores valid sign-ups once, rejects bad input, ignores bots", async () => {
  const dir = await withServer(async (post) => {
    assert.equal((await post("/api/waitlist", { email: "Ada@Example.org", name: "Ada", role: "study" })).status, 200);
    assert.equal((await post("/api/waitlist", { email: "ada@example.org", name: "Ada L.", role: "dev" })).status, 200);
    assert.equal((await post("/api/waitlist", { email: "not-an-email" })).status, 422);
    assert.equal((await post("/api/waitlist", { email: "bot@example.org", website: "http://spam" })).status, 200);
    assert.equal((await post("/api/waitlist", { email: "x@example.org" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/ideas", { text: "Typst export", area: "Workspace" })).status, 200);
    assert.equal((await post("/api/ideas", { text: "   " })).status, 422);
  });
  const csv = execFileSync(process.execPath, ["--no-warnings", join(ROOT, "server", "waitlist.mjs"), "export"],
    { env: { ...process.env, WAITLIST_DB: join(dir, "w.sqlite") }, encoding: "utf8" });
  const rows = csv.trim().split("\n").slice(1);
  assert.equal(rows.length, 1, csv);
  assert.match(rows[0], /"ada@example.org","Ada L.","dev"/);
});

test("waitlist: rate limit per address", async () => {
  await withServer(async (post) => {
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await post("/api/waitlist", { email: `r${i}@example.org` })).status);
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(200));
    assert.equal(codes[9], 429);
  });
});
