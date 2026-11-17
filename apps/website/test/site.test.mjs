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
  // Logo intro: every page types the mark once (line, stem, bowl, caret); the canvas's pop animations are off.
  const workspace = readFileSync(join(out, "workspace", "index.html"), "utf8");
  const legal = readFileSync(join(out, "imprint", "index.html"), "utf8");
  for (const [name, html] of [["home", home], ["workspace", workspace], ["imprint", legal]]) {
    assert.match(html, /<html lang="[a-z-]+" class="lg-intro"/, `${name} plays the logo intro`);
    for (const cls of ["lg-base", "lg-stem", "lg-bowl", "lg-caret"]) assert.ok(html.includes(`class="${cls}"`), `${name}: ${cls} in the header mark`);
  }
  const sheet = readFileSync(join(out, "assets", readdirSync(join(out, "assets")).find((f) => /^site\..*\.css$/.test(f))), "utf8");
  for (const k of ["bsdLgLine", "bsdLgStem", "bsdLgBowl", "bsdLgCaret", "bsdLgDip", "bsdLgTapStem", "bsdLgTapBowl"]) assert.match(sheet, new RegExp("@keyframes " + k + "\\{"), k);
  assert.match(sheet, /\.lg-caret\{opacity:0\}/, "caret hidden when the intro does not run");
  // the old pop (bsdStem, bsdBowl, bsdBowl2) may stay in the canvas sheet, but a later rule switches it off
  const off = sheet.lastIndexOf(".bsd .logo-svg .lg-stem,.bsd .logo-svg .lg-bowl,.bsd .logo-link:hover .lg-stem,.bsd .logo-link:hover .lg-bowl{animation:none}");
  assert.ok(off > sheet.lastIndexOf("animation:bsdStem") && off > sheet.lastIndexOf("animation:bsdBowl2"), "old pop animation is switched off after the canvas rules");
  const siteJs = readFileSync(join(out, "assets", readdirSync(join(out, "assets")).find((f) => /^site\..*\.js$/.test(f))), "utf8");
  assert.match(siteJs, /classList\.remove\("lg-intro"\)/, "the mark rests when the intro is over");
  const imprint = readFileSync(join(out, "imprint", "index.html"), "utf8");
  assert.match(imprint, /Offenlegung gemäß § 25 Mediengesetz/);
  assert.match(imprint, /hello@basednotes\.app/);
});

test("home: every template value is provided by its script (the quadrant went blank once)", () => {
  for (const f of ["Main.dc.html", "Mobile.dc.html"]) {
    const s = readFileSync(join(ROOT, "src", "pages", f), "utf8");
    const body = /<\/helmet>([\s\S]*?)<\/x-dc>/.exec(s)[1];
    const code = /data-dc-script[^>]*>([\s\S]*?)<\/script>/.exec(s)[1];
    const rv = code.slice(code.indexOf("renderVals"));
    const loops = new Set([...body.matchAll(/as="(\w+)"/g)].map((m) => m[1]));
    const roots = new Set([...body.matchAll(/\{\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1])
      .filter((r) => !loops.has(r) && r !== "true" && r !== "false"));
    for (const r of roots) assert.match(rv, new RegExp("\\b" + r + "\\s*[:,\\n]"), `${f}: {{${r}}} has no value`);
  }
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
  assert.match(faq, /<html lang="en"[ >]/);
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
  assert.match(readFileSync(join(out, "imprint", "index.html"), "utf8"), /<html lang="en"[ >]/);
  assert.match(readFileSync(join(out, "imprint", "index.html"), "utf8"), /§ 25 Mediengesetz/);
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

test("framing (17.11.2026): own brand first, the notes app before agents", () => {
  const out = mkdtempSync(join(tmpdir(), "based-site-framing-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { env: { ...process.env, WEBSITE_OUT: out, NO_PRERENDER: "1" }, stdio: "pipe" });
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.match(home, /aria-label="\{\{heroLabel\}\}"/);
  // Elija 17.11., 22:17: own brand first ("Your data. Based."), Notion only as the way in, "we build together" for the open section
  assert.match(home, /heroLabel: 'Your data\. Based\.'/, "desktop headline");
  assert.match(home, /Your data\.<br><span class="hl">Based\.<\/span>/, "phone headline");
  assert.ok(!/heroLabel: '[^']*Notion/.test(home), "no competitor name in the headline");
  assert.equal((home.match(/The notes app we build together\./g) || []).length, 2, "open section on desktop and phone");
  assert.ok(!home.includes("Notion, but yours"), "old headline is gone");
  assert.ok(!home.includes("Databases, docs and agents"), "old agent-first headline is gone");
  assert.ok(!home.includes("Based on nobody's cloud"), "closing line fits iCloud sync in the beta");
  // order: workspace, moving in, your data, Notion pains, open, agents later
  const order = ["Based workspace preview", "pillars-title", "yours-title", "pain-title", "open-title", "later-title", "cta-title"].map((k) => home.indexOf(k));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), "section order " + order.join(","));
  // Elija 17.11., 22:33: the agent preview stays on the site, marked as after the beta, below the notes app
  const later = home.indexOf("later-title");
  for (const t of ["Planned after the beta: one box for everything", "Start in your terminal. Finish on your phone.", "Planned after the beta: your day and your agents"]) {
    assert.ok(home.indexOf(t) > later, `"${t}" sits in the after-the-beta section`);
  }
  // header menus without Agents, footer keeps it
  for (const p of ["index.html", "workspace/index.html", "imprint/index.html"]) {
    const s = readFileSync(join(out, p), "utf8");
    const header = /<header[\s\S]*?<\/header>/.exec(s)[0];
    assert.ok(!header.includes('href="/agents"'), `${p}: Agents in the header`);
    assert.match(/<footer[\s\S]*?<\/footer>/.exec(s)[0], /href="\/agents"/, `${p}: Agents in the footer`);
  }
  // no dashes as punctuation in the home copy (writing rules)
  assert.ok(!/[–—]/.test(home), "no en or em dashes on the home page");
});

test("donations in focus (17.11.2026): sponsor link in header and footer, card on the home page, FAQ answer", () => {
  const out = mkdtempSync(join(tmpdir(), "based-site-sponsor-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { env: { ...process.env, WEBSITE_OUT: out, NO_PRERENDER: "1" }, stdio: "pipe" });
  const SP = "https://github.com/sponsors/elija-7580";
  for (const p of ["index.html", "workspace/index.html", "faq/index.html"]) {
    const s = readFileSync(join(out, p), "utf8");
    assert.ok(/<header[\s\S]*?<\/header>/.exec(s)[0].includes(SP), `${p}: sponsor link in the header`);
    assert.ok(/<footer[\s\S]*?<\/footer>/.exec(s)[0].includes(SP), `${p}: sponsor link in the footer`);
  }
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.equal((home.match(/Keep it <span class="hl">independent\.<\/span>/g) || []).length, 2, "sponsor card on desktop and phone");
  assert.match(home, /You get nothing extra for it/, "worded as a donation");
  const faq = readFileSync(join(out, "faq", "index.html"), "utf8");
  assert.match(faq, /<h2>How is Based funded\?<\/h2>/);
});

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "based-wl-"));
  // Port 0: the system picks a free port (a random one collided under load, „server exited 1“)
  const child = spawn(process.execPath, ["--no-warnings", join(ROOT, "server", "waitlist.mjs")], {
    env: { ...process.env, PORT: "0", WAITLIST_DB: join(dir, "w.sqlite"), WAITLIST_ORIGINS: "https://basednotes.app" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /waitlist service on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`)));
  });
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  try {
    await fn(post, dir);
  } finally {
    // BSD-476: wait until the service has closed the database before the next process opens it
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
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
