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
  const runtime = readdirSync(join(out, "assets")).find((f) => f.startsWith("dc-lite."));
  assert.match(readFileSync(join(out, "assets", runtime), "utf8"), /mq\.addEventListener\("change"/,
    "home swaps desktop/phone version when the window crosses the breakpoint");
  assert.match(home, /href="\/privacy"/);
  const imprint = readFileSync(join(out, "imprint", "index.html"), "utf8");
  assert.match(imprint, /Offenlegung gemäß § 25 Mediengesetz/);
  assert.match(imprint, /hello@basednotes\.app/);
});

test("seo (BSD-457): short descriptions, structured data, FAQ indexed, download page hidden from search", () => {
  const out = mkdtempSync(join(tmpdir(), "based-site-seo-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { env: { ...process.env, WEBSITE_OUT: out, NO_PRERENDER: "1" }, stdio: "pipe" });
  const pages = ["index.html", "workspace/index.html", "agents/index.html", "leaving-notion/index.html", "roadmap/index.html",
    "manifesto/index.html", "faq/index.html", "download/index.html"];
  const titles = new Set();
  for (const p of pages) {
    const s = readFileSync(join(out, p), "utf8");
    const d = /<meta name="description" content="([^"]*)">/.exec(s);
    assert.ok(d, `${p}: description`);
    assert.ok(d[1].length >= 50 && d[1].length <= 155, `${p}: description has ${d[1].length} characters`);
    const t = /<title>([^<]*)<\/title>/.exec(s)[1];
    assert.ok(t.length <= 65, `${p}: title has ${t.length} characters`);
    titles.add(t);
    for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(m[1]);
  }
  assert.equal(titles.size, pages.length, "every page has its own title");

  const home = readFileSync(join(out, "index.html"), "utf8");
  const app = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)[1]);
  assert.equal(app["@type"], "SoftwareApplication");
  assert.equal(app.offers.price, "0");

  const faq = readFileSync(join(out, "faq", "index.html"), "utf8");
  assert.match(faq, /<html lang="en">/);
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(faq)[1]);
  assert.equal(ld["@type"], "FAQPage");
  assert.ok(ld.mainEntity.length >= 8);
  for (const q of ld.mainEntity) assert.ok(q.name.endsWith("?") && q.acceptedAnswer.text.length > 10, q.name);
  assert.doesNotMatch(faq, /noindex/);

  const download = readFileSync(join(out, "download", "index.html"), "utf8");
  assert.match(download, /<meta name="robots" content="noindex">/);
  assert.match(download, /releases\/download\/beta-latest\/Based-Beta\.dmg/);

  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.match(sitemap, /basednotes\.app\/faq</);
  assert.doesNotMatch(sitemap, /download/);
  assert.match(readFileSync(join(out, "imprint", "index.html"), "utf8"), /<html lang="de">/);
});

test("claims (BSD-434): no promise the Mac beta can't keep", () => {
  const out = mkdtempSync(join(tmpdir(), "based-site-claims-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { env: { ...process.env, WEBSITE_OUT: out, NO_PRERENDER: "1" }, stdio: "pipe" });
  const banned = [
    "Meeting notes transcribed on your Mac, offline", "Agents with your own keys, opt-in",
    "Sync between your Apple devices through iCloud", "The beta syncs your Apple devices", "Or run one locally",
    "or run models locally", "on your phone, in your inbox", "snapshots go to a drive you choose",
    "a drive or folder you choose", "sub-pages and comments", "Built in Vienna, EU servers", "<span>EU servers</span>",
    "Each one can be undone on its own", "undone one by one", "undone in one step", "three copies, restore in one click",
    "your encrypted cloud and snapshots in a folder", "Beta is Mac only with iCloud.", "never delete or share anything",
    "221 * ease", "178 * ease", "through the CLI or MCP"
  ];
  for (const p of ["index.html", "workspace/index.html", "agents/index.html", "leaving-notion/index.html", "roadmap/index.html", "manifesto/index.html"]) {
    const s = readFileSync(join(out, p), "utf8");
    for (const b of banned) assert.ok(!s.includes(b), `${p}: "${b}"`);
  }
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.match(home, /Sync between your Macs through iCloud Drive \(preview\)/);
  assert.match(home, /Math\.round\(236 \* ease\)/);
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
