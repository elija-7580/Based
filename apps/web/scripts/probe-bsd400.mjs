// BSD-400 Sonde: WebKit, zwei 300-Block-Seiten, N Seitenwechsel, dann 44 Tasten. Misst je Taste
// keydown -> erste DOM-Mutation (mut), -> rAF (raf), -> rAF+setTimeout (lat, wie @perf).
// Aufruf: node probe.mjs <port> [switches=4] [browser=webkit]
import { createRequire } from "node:module";
const require = createRequire("/home/user/wt-b2/apps/web/package.json");
const pw = require("@playwright/test");
const port = process.argv[2] ?? "4181";
const LAST = Number(process.env.N ?? 300) - 1;
const switches = Number(process.argv[3] ?? 4);
const bname = process.argv[4] ?? "webkit";
const browser = await pw[bname].launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.goto(`http://localhost:${port}/`);
await page.getByTestId("based-root").waitFor();
await page.waitForSelector("[data-testid=based-root][data-ready]");
await page.evaluate((n) => { globalThis.__N = n; }, Number(process.env.N ?? 300));
await page.evaluate(async () => {
  const b = globalThis.__based;
  const now = (Date.now() - 978_307_200_000) / 1000;
  for (const title of ["Big page A", "Big page B"]) {
    const id = await b.client.command({ op: "createPage", title });
    const r = await b.client.openPage(id);
    const N = globalThis.__N; r.store.transact("Seed", (tx) => {
      for (let i = 0; i < N; i++) {
        const type = i % 10 === 0 ? "heading2" : i % 3 === 0 ? "bulletedList" : "text";
        tx.put({ kind: "block", data: { id: crypto.randomUUID(), type, parent: "b:" + id, sk: "a" + String(i).padStart(5, "0"), text: `${title} line ${i} with some ordinary words to fill the row`, createdAt: now, updatedAt: now } });
      }
    });
  }
  await b.client.settled();
});
await page.evaluate(() => {
  const w = globalThis;
  w.__k = [];
  document.addEventListener("keydown", (e) => {
    const start = e.timeStamp;
    const rec = { mut: -1, raf: -1, lat: -1 };
    w.__k.push(rec);
    rec.muts = []; const mo = new MutationObserver((l) => { const t = Math.round(performance.now() - start); if (rec.mut < 0) rec.mut = t; rec.muts.push(t + ":" + l.length + ":" + [...new Set(l.map((m) => (m.target.nodeType === 3 ? m.target.parentElement : m.target)?.className?.toString().slice(0, 18)))].join("|")); }); setTimeout(() => mo.disconnect(), 25);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    const s0 = getSelection(); rec.sel0 = s0.rangeCount ? (s0.anchorNode.nodeType === 3 ? "T" : s0.anchorNode.nodeName) + s0.anchorOffset : "none";
    queueMicrotask(() => setTimeout(() => { const s1 = getSelection(); rec.sel1 = s1.rangeCount ? (s1.anchorNode.isConnected ? "" : "DETACHED:") + (s1.anchorNode.nodeType === 3 ? "T" : s1.anchorNode.nodeName) + s1.anchorOffset : "none"; }, 0));
    requestAnimationFrame(() => { rec.raf = performance.now() - start; setTimeout(() => { rec.lat = performance.now() - start; }, 0); });
  }, { capture: true });
});
if (process.env.FRAMES) await page.evaluate(() => { globalThis.__FRAMES = true; });
if (process.env.SYNCBUSY) await page.evaluate((b) => document.addEventListener("beforeinput", () => { const t = performance.now(); while (performance.now() - t < b); }), Number(process.env.SYNCBUSY));
if (process.env.SYNCREWRITE) await page.evaluate(() => document.addEventListener("beforeinput", () => { const all = [...document.querySelectorAll("[data-editable-id]")].filter((e) => e !== document.activeElement); for (const e of all) { const c = [...e.childNodes].map((n) => n.cloneNode(true)); e.replaceChildren(...c); } }, true));
if (process.env.MICRO) await page.evaluate((m) => document.addEventListener("beforeinput", () => queueMicrotask(() => {
  const all = [...document.querySelectorAll("[data-editable-id]")].filter((e) => e !== document.activeElement);
  for (const e of (m === "one" ? all.slice(0, 1) : all)) { if (m === "attr") e.toggleAttribute("data-zz"); else { const c = [...e.childNodes].map((n) => n.cloneNode(true)); e.replaceChildren(...c); } }
})), process.env.MICRO);
if (process.env.TOUCH) await page.evaluate((mode) => { document.addEventListener("beforeinput", () => setTimeout(() => {
  if (mode === "layout") void document.body.offsetHeight;
  if (mode === "style") { const ed = document.querySelector("[data-testid=block-editor]"); ed.classList.toggle("zz"); void document.body.offsetHeight; }
  if (mode === "rewrite" || mode === "rewrite1") { const all = [...document.querySelectorAll("[data-editable-id]")].filter((e) => e !== document.activeElement); for (const e of (mode === "rewrite1" ? all.slice(0, 1) : all)) { const c = [...e.childNodes].map((n) => n.cloneNode(true)); e.replaceChildren(...c); } }
  if (mode === "sel") { const s = getSelection(); const r = s.getRangeAt(0); s.removeAllRanges(); s.addRange(r); }
}, 0)); }, process.env.TOUCH);
if (process.env.E) await page.evaluate((e) => { globalThis.__E = e; }, process.env.E);
if (process.env.PATCH) await page.evaluate((m) => {
  const d = document.createElement("div"); d.textContent = "x"; d.style.cssText = m === "hidden" ? "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01" : "font-size:10px"; document.body.prepend(d);
  const first = () => document.querySelector("[data-editable-id]");
  if (m === "sbe") { Selection.prototype.removeAllRanges = function () {}; Selection.prototype.addRange = function (r) { this.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset); }; return; }
  if (m === "collapse") { Selection.prototype.removeAllRanges = function () {}; Selection.prototype.addRange = function (r) { this.collapse(r.startContainer, r.startOffset); if (!r.collapsed) this.extend(r.endContainer, r.endOffset); }; return; }
  const orig = Selection.prototype.removeAllRanges;
  Selection.prototype.removeAllRanges = function () {
    if (m === "field") { const f = first(); if (f && f !== document.activeElement) f.replaceChildren(...[...f.childNodes].map((n) => n.cloneNode(true))); }
    else d.firstChild.data = d.firstChild.data === "x" ? "y" : "x";
    return orig.call(this);
  };
}, process.env.PATCH);
const BUSY = Number(process.env.BUSY ?? 0);
if (BUSY) await page.evaluate((b) => document.addEventListener("keydown", () => setTimeout(() => { const t = performance.now(); while (performance.now() - t < b); }, 0)), BUSY);
if (process.env.NOSPELL) await page.evaluate(() => { document.body.spellcheck = false; for (const e of document.querySelectorAll("[contenteditable]")) e.spellcheck = false; new MutationObserver(() => { for (const e of document.querySelectorAll("[contenteditable]:not([spellcheck=false])")) e.spellcheck = false; }).observe(document.body, { subtree: true, childList: true }); });
const tree = (t) => page.getByRole("treeitem", { name: t });
const content = page.getByTestId("page-content");
for (let i = 0; i < switches; i++) {
  const title = i % 2 === 0 ? "Big page A" : "Big page B";
  await tree(title).click();
  await content.getByText(`${title} line ${LAST}`, { exact: false }).waitFor({ state: "attached", timeout: 20000 });
}
if (switches === 0 || switches % 2 === 1) { await tree("Big page B").click(); await content.getByText("Big page B line " + LAST, { exact: false }).waitFor({ state: "attached" }); }
await page.waitForTimeout(500);
const diag = await page.evaluate(() => ({
  editors: document.querySelectorAll("[data-testid=block-editor]").length,
  editables: document.querySelectorAll("[data-editable-id]").length,
  nodes: document.getElementsByTagName("*").length,
}));
const idleFrames = async (label) => { const d = await page.evaluate(() => new Promise((res) => { const fr = []; const f = () => { fr.push(performance.now()); if (fr.length < 40) requestAnimationFrame(f); else res(fr.slice(1).map((x,i)=>x-fr[i]).sort((a,b)=>a-b)); }; requestAnimationFrame(f); })); console.log(label, "p50", d[19].toFixed(1), "max", d[d.length-1].toFixed(1)); };
await idleFrames("idle-before-click");
if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS });
await page.locator("[data-testid=block-editor]").getByText("Big page B line " + LAST, { exact: false }).click();
await page.keyboard.press("End");
await page.waitForTimeout(300);
await idleFrames("idle-focused");
await page.evaluate(() => { globalThis.__k = []; const fr = globalThis.__fr = []; const f = () => { fr.push(performance.now()); if (fr.length < 400) requestAnimationFrame(f); }; if (globalThis.__FRAMES) requestAnimationFrame(f); });
if (process.env.INPAGE) {
  await page.evaluate((d) => new Promise((res) => { const txt = " the quick brown fox jumps over the lazy dog"; let i = 0; const step = () => { if (i >= txt.length) return res(); document.dispatchEvent(new KeyboardEvent("keydown", { key: txt[i] })); document.execCommand("insertText", false, txt[i]); i++; setTimeout(step, d); }; step(); }), Number(process.env.DELAY ?? 30));
} else await page.keyboard.type(" the quick brown fox jumps over the lazy dog", { delay: Number(process.env.DELAY ?? 30) });
await page.waitForTimeout(400);
const sc = await page.evaluate(() => [...document.querySelectorAll("[data-editable-id]")].slice(-1).map(e => e.spellcheck + "/" + getComputedStyle(e).getPropertyValue("-webkit-user-modify")).join());
console.log("spell", sc);
if (process.env.FRAMES) { const fr = await page.evaluate(() => globalThis.__fr); const d = fr.slice(1).map((x,i)=>x-fr[i]).sort((a,b)=>a-b); console.log("frames", fr.length, "interval p50", d[d.length>>1]?.toFixed(1), "p90", d[Math.floor(d.length*.9)]?.toFixed(1), "max", d[d.length-1]?.toFixed(1)); }
const k = await page.evaluate(() => globalThis.__k);
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const col = (f) => k.map((r) => r[f]).filter((x) => x >= 0);
for (const r of k.slice(5,9)) console.log(Math.round(r.raf), r.muts.join("  "));
const txtOk = await page.evaluate((L) => document.querySelector("[data-testid=block-editor]").textContent.includes("line " + L + " with some ordinary words to fill the row the quick brown fox jumps over the lazy dog"), LAST);
console.log("textOk", txtOk);
console.log(JSON.stringify({ port, switches, n: k.length, mut50: q(col("mut"), .5), raf50: q(col("raf"), .5), lat50: q(col("lat"), .5), lat95: q(col("lat"), .95), ...diag }));
await browser.close();
