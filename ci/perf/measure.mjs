// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Review 2026-11-18: wiederholbare Messung des Web-Clients (Chromium, Playwright + CDP). Gibt JSON aus.
// Aufruf (nach `BASED_CHANNEL=beta pnpm --filter @based/web exec vite build`):
//   node ci/perf/measure.mjs [--out datei.json] [--pages 20000] [--rows 100000] [--only base|large|database]
// Misst: Bundle (roh/gzip, Erststart-Chunk getrennt), Kaltstart, geladene Chunks, Heap nach GC, DOM-Knoten, Listener,
// Leerlauf (Timer/rAF-Aufrufe, Worker-Nachrichten und CPU-Zeit in 10 s), Leck-Schleifen (50× Seite, 50× ⌘K), Editor-Tippen (Long Tasks),
// Start mit großem Workspace, Datenbank mit 100 000 Zeilen (--rows, BSD-605). Zahlen aus dem Linux-Container; Mac-Werte siehe docs/quality/performance-budget.md.
/* global __perf, document */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const web = new URL("../../apps/web/", import.meta.url).pathname;
const { chromium } = createRequire(web + "package.json")("@playwright/test");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg("port", 4191)), PAGES = Number(arg("pages", 20000));
// --only database: nur der Schritt „Datenbank“ (BSD-605); sonst alles
const ONLY = arg("only");
const want = (name) => !ONLY || ONLY === name;
const out = { date: new Date().toISOString(), bundle: {}, errors: [] };
const kb = (n) => Math.round(n / 102.4) / 10;

// ---- Bundle
const assets = web + "dist/assets/";
const html = readFileSync(web + "dist/index.html", "utf8");
const entryJs = /assets\/(index-[^"]+\.js)/.exec(html)[1];
const preload = [...html.matchAll(/assets\/([^"]+\.js)/g)].map((m) => m[1]);
let total = 0, totalGz = 0;
const sizes = {};
for (const f of readdirSync(assets)) {
  const b = readFileSync(assets + f);
  total += b.length;
  if (/\.(js|css)$/.test(f)) { const g = gzipSync(b).length; totalGz += g; sizes[f] = [b.length, g]; }
}
out.bundle = {
  entryJsRawKb: kb(sizes[entryJs][0]), entryJsGzipKb: kb(sizes[entryJs][1]),
  htmlJs: preload.length, distTotalKb: kb(total), jsCssGzipKb: kb(totalGz), files: readdirSync(assets).length,
  largest: Object.entries(sizes).sort((a, b) => b[1][1] - a[1][1]).slice(0, 8).map(([f, [, g]]) => `${f} ${kb(g)} kB gz`),
};

// ---- Server
const srv = spawn("pnpm", ["exec", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: web, stdio: "ignore", detached: true });
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { try { await fetch(base); break; } catch { await new Promise((ok) => setTimeout(ok, 250)); } }

const INIT = () => {
  const w = globalThis;
  w.__perf = { timeouts: 0, intervals: 0, rafs: 0, workerMsgs: 0, liveIntervals: new Map(), longTasks: [] };
  // Review 22.11.: Nachrichten aus Workern wecken den Hauptthread wie ein Zeitgeber (z. B. Watchdog-Ping) – mitzählen
  const W = w.Worker;
  if (W) w.Worker = class extends W { constructor(...a) { super(...a); this.addEventListener("message", () => { w.__perf.workerMsgs++; }); } };
  const si = w.setInterval, ci = w.clearInterval, st = w.setTimeout, raf = w.requestAnimationFrame;
  w.setInterval = function (f, ms, ...a) {
    const src = new Error().stack.split("\n").slice(2, 5).join(" | ");
    const id = si.call(w, (...x) => { w.__perf.intervals++; return typeof f === "function" ? f(...x) : undefined; }, ms, ...a);
    w.__perf.liveIntervals.set(id, `${ms} ms @ ${src}`);
    return id;
  };
  w.clearInterval = function (id) { w.__perf.liveIntervals.delete(id); return ci.call(w, id); };
  w.setTimeout = function (f, ms, ...a) { return st.call(w, (...x) => { w.__perf.timeouts++; return typeof f === "function" ? f(...x) : undefined; }, ms, ...a); };
  if (raf) w.requestAnimationFrame = function (f) { return raf.call(w, (t) => { w.__perf.rafs++; return f(t); }); };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.longTasks.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch { /* */ }
};

async function session(fn) {
  const dir = mkdtempSync(join(tmpdir(), "based-perf-"));
  const ctx = await chromium.launchPersistentContext(dir, { baseURL: base, viewport: { width: 1280, height: 820 }, args: ["--js-flags=--expose-gc"], ...(process.env.BASED_PERF_CHROME ? { executablePath: process.env.BASED_PERF_CHROME } : {}) });
  await ctx.addInitScript(INIT);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
  const reqs = [];
  page.on("request", (r) => { const u = r.url(); if (u.includes("/assets/")) reqs.push(u.split("/assets/")[1]); });
  const metrics = async () => {
    await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
    const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
    return { heapMb: Math.round(m.JSHeapUsedSize / 104857.6) / 10, nodes: m.Nodes, listeners: m.JSEventListeners, taskS: m.TaskDuration, scriptS: m.ScriptDuration };
  };
  const ready = async () => { await page.waitForSelector('[data-testid="based-root"][data-ready]', { timeout: 120000 }); };
  try { return await fn({ page, cdp, metrics, ready, reqs, errs }); } finally { out.errors.push(...errs); await ctx.close(); rmSync(dir, { recursive: true, force: true }); }
}
const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { failed: String(e.message).split("\n")[0].slice(0, 300) }; } console.error(name, JSON.stringify(out[name])); };

// ---- 1 · Kaltstart, leerer Workspace, Leerlauf, Leck-Schleifen, Editor
if (want("base")) await session(async ({ page, cdp, metrics, ready, reqs }) => {
  await step("start", async () => {
    const t0 = Date.now();
    await page.goto("/");
    await ready();
    const readyMs = Date.now() - t0;
    await page.getByRole("navigation", { name: "Workspace" }).waitFor();
    const sidebarMs = Date.now() - t0;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; const p = performance.getEntriesByName("first-contentful-paint")[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), fcp: p ? Math.round(p.startTime) : null }; });
    await page.waitForTimeout(1500);
    const js = [...new Set(reqs.filter((r) => r.endsWith(".js")))];
    const gz = js.reduce((s, f) => s + (sizes[f]?.[1] ?? 0), 0);
    return { readyMs, sidebarMs, ...nav, firstJsFiles: js.length, firstJsGzipKb: kb(gz), chunks: js.filter((f) => f !== entryJs), ...(await metrics()) };
  });
  // Tour schließen, falls offen
  await step("idle", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(3000);
    const a = await metrics();
    const c0 = await page.evaluate(() => ({ t: __perf.timeouts, i: __perf.intervals, r: __perf.rafs, w: __perf.workerMsgs }));
    await page.waitForTimeout(10000);
    const c1 = await page.evaluate(() => ({ t: __perf.timeouts, i: __perf.intervals, r: __perf.rafs, w: __perf.workerMsgs, live: [...__perf.liveIntervals.values()] }));
    const b = await cdp.send("Performance.getMetrics").then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])));
    const anim = await page.evaluate(() => document.getAnimations().filter((x) => x.playState === "running").length);
    return { secs: 10, timeoutCalls: c1.t - c0.t, intervalCalls: c1.i - c0.i, rafCalls: c1.r - c0.r, workerMsgs: c1.w - c0.w, cpuPct: Math.round(((b.TaskDuration - a.taskS) / 10) * 1000) / 10, runningAnimations: anim, liveIntervals: c1.live };
  });
  // Seiten anlegen
  await page.evaluate(async () => {
    const b = globalThis.__based; const now = (Date.now() - 978307200000) / 1000; const r = [];
    for (const title of ["Perf A", "Perf B"]) {
      const id = await b.client.command({ op: "createPage", title });
      const p = await b.client.openPage(id);
      p.store.transact("Seed", (tx) => { for (let i = 0; i < 300; i++) tx.put({ kind: "block", data: { id: crypto.randomUUID(), type: i % 10 === 0 ? "heading2" : i % 3 === 0 ? "bulletedList" : "text", parent: "b:" + id, sk: "a" + String(i).padStart(5, "0"), text: `${title} line ${i} with some ordinary words to fill the row`, createdAt: now, updatedAt: now } }); });
      p.close(); r.push(id);
    }
    await b.client.settled(); return r;
  });
  const open = async (t) => { await page.getByRole("treeitem", { name: t }).click(); await page.getByTestId("block-editor").first().waitFor(); await page.waitForFunction((x) => document.querySelector('[aria-label="Page title"]')?.value === x, t); };
  await step("leakPages", async () => {
    for (let i = 0; i < 3; i++) { await open("Perf A"); await open("Perf B"); }
    const a = await metrics();
    for (let i = 0; i < 25; i++) { await open("Perf A"); await open("Perf B"); }
    const b = await metrics();
    return { cycles: 50, heapBeforeMb: a.heapMb, heapAfterMb: b.heapMb, deltaMb: Math.round((b.heapMb - a.heapMb) * 10) / 10, nodes: [a.nodes, b.nodes], listeners: [a.listeners, b.listeners] };
  });
  await step("leakQuickFind", async () => {
    const cyc = async () => { await page.keyboard.press("ControlOrMeta+k"); await page.getByRole("combobox", { name: "Search pages" }).waitFor(); await page.keyboard.type("perf"); await page.keyboard.press("Escape"); await page.getByRole("combobox", { name: "Search pages" }).waitFor({ state: "detached" }); };
    for (let i = 0; i < 3; i++) await cyc();
    const a = await metrics();
    for (let i = 0; i < 50; i++) await cyc();
    const b = await metrics();
    return { cycles: 50, heapBeforeMb: a.heapMb, heapAfterMb: b.heapMb, deltaMb: Math.round((b.heapMb - a.heapMb) * 10) / 10, nodes: [a.nodes, b.nodes], listeners: [a.listeners, b.listeners] };
  });
  await step("editorTyping", async () => {
    await open("Perf A");
    await page.getByTestId("block-editor").first().getByTestId("block-editor-tail").click({ position: { x: 40, y: 12 } });
    await page.evaluate(() => { __perf.longTasks.length = 0; });
    const a = await cdp.send("Performance.getMetrics").then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])));
    const text = "The quick brown fox jumps over the lazy dog and keeps typing on a long page. ";
    const t0 = Date.now();
    await page.keyboard.type(text + text, { delay: 10 });
    const ms = Date.now() - t0;
    const b = await cdp.send("Performance.getMetrics").then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])));
    const lt = await page.evaluate(() => __perf.longTasks.slice());
    return { chars: text.length * 2, wallMs: ms, cpuMsPerChar: Math.round(((b.TaskDuration - a.TaskDuration) * 1000 / (text.length * 2)) * 10) / 10, longTasks: lt.length, longestTaskMs: Math.max(0, ...lt) };
  });
  await step("idleAfter", async () => {
    await page.waitForTimeout(4000);
    const a = await cdp.send("Performance.getMetrics").then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])));
    const c0 = await page.evaluate(() => ({ t: __perf.timeouts, i: __perf.intervals, r: __perf.rafs, w: __perf.workerMsgs }));
    await page.waitForTimeout(10000);
    const c1 = await page.evaluate(() => ({ t: __perf.timeouts, i: __perf.intervals, r: __perf.rafs, w: __perf.workerMsgs, live: [...__perf.liveIntervals.values()] }));
    const b = await cdp.send("Performance.getMetrics").then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])));
    return { secs: 10, timeoutCalls: c1.t - c0.t, intervalCalls: c1.i - c0.i, rafCalls: c1.r - c0.r, workerMsgs: c1.w - c0.w, cpuPct: Math.round(((b.TaskDuration - a.TaskDuration) / 10) * 1000) / 10, liveIntervals: c1.live, ...(await metrics()) };
  });
  out.loadedChunksAfterWalk = [...new Set(reqs.filter((r) => r.endsWith(".js")))].length;
});

// ---- 2 · großer Workspace
if (want("large")) await session(async ({ page, metrics, ready }) => {
  await step("large", async () => {
    await page.goto("/"); await ready();
    const empty = await metrics();
    const writeMs = await page.evaluate(async (n) => { const b = globalThis.__based; const t0 = performance.now(); await b.client.command({ op: "seed", count: n }); await b.client.settled(); return Math.round(performance.now() - t0); }, PAGES);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now(); await page.reload(); await ready();
      await page.getByRole("treeitem").first().waitFor({ timeout: 120000 });
      runs.push(Date.now() - t0);
    }
    await page.waitForTimeout(2000);
    const lt = await page.evaluate(() => __perf.longTasks.slice());
    const m = await metrics();
    return { pages: PAGES, seedWriteMs: writeMs, sidebarMs: Math.min(...runs), runs, longestTaskMs: Math.max(0, ...lt), heapEmptyMb: empty.heapMb, heapMb: m.heapMb, heapPerKPagesMb: Math.round(((m.heapMb - empty.heapMb) / (PAGES / 1000)) * 100) / 100, nodes: m.nodes, listeners: m.listeners };
  });
});

// ---- 3 · Datenbank mit 100 000 Zeilen (BSD-605): Heap des Hauptthreads nach GC, längste Aufgabe beim Öffnen, Neuladen
// bis zur ersten Zeile. Ziel aus BSD-605: Heap < 30 MB, keine Aufgabe > 200 ms, Neuladen < 2 s. BSD-666: danach eine kleine
// Datenbank mit Relation auf die große öffnen (`related*`): Heap darf nicht mit der Ziel-Datenbank wachsen.
const ROWS = Number(arg("rows", 100000));
if (want("database")) await session(async ({ page, metrics, ready }) => {
  await step("database", async () => {
    await page.goto("/"); await ready();
    await page.keyboard.press("Escape");
    const empty = await metrics();
    const id = await page.evaluate(async (n) => { const b = globalThis.__based; const r = await b.client.command({ op: "seedDatabase", count: n }); await b.client.settled(); return r; }, ROWS);
    const firstRow = async () => {
      await page.waitForFunction((n) => document.querySelector('.shell-database.full [aria-label="Pages in view"]')?.textContent === n, ROWS.toLocaleString("en-US"), { timeout: 120000 });
      await page.waitForSelector(".shell-database.full .dbui-vrow[data-row-id]", { timeout: 120000 });
    };
    await page.evaluate(() => { __perf.longTasks.length = 0; });
    const t0 = Date.now();
    await page.goto("/#page-" + id);
    await firstRow();
    const openMs = Date.now() - t0;
    await page.waitForTimeout(1500);
    const openTasks = await page.evaluate(() => __perf.longTasks.slice());
    const open = await metrics();
    const t1 = Date.now();
    await page.reload(); await ready(); await firstRow();
    const reloadMs = Date.now() - t1;
    await page.waitForTimeout(1500);
    const reloadTasks = await page.evaluate(() => __perf.longTasks.slice());
    const reloaded = await metrics();
    // BSD-666: kleine Datenbank (3 Zeilen) mit Relation auf die große, eine Zeile verknüpft. Vorher brachte das Öffnen
    // alle ROWS Zielzeilen in die Replik; jetzt nur die verknüpfte. Zuerst neu laden, damit die große Replik weg ist.
    const tasks = await page.evaluate(async (target) => { const b = globalThis.__based; const r = await b.client.command({ op: "seedRelated", target, count: 3 }); await b.client.settled(); return r; }, id);
    await page.goto("/"); await page.reload(); await ready();
    const before = await metrics();
    await page.evaluate(() => { __perf.longTasks.length = 0; });
    const t2 = Date.now();
    await page.goto("/#page-" + tasks);
    await page.waitForSelector(".shell-database.full .dbui-relation", { timeout: 120000 });
    const relatedOpenMs = Date.now() - t2;
    await page.waitForTimeout(1500);
    const relatedTasks = await page.evaluate(() => __perf.longTasks.slice());
    const related = await metrics();
    return {
      rows: ROWS, heapEmptyMb: empty.heapMb, heapOpenMb: open.heapMb, heapAfterReloadMb: reloaded.heapMb, nodes: open.nodes, openMs, openLongestTaskMs: Math.max(0, ...openTasks), openLongTasks: openTasks.length, reloadMs, reloadLongestTaskMs: Math.max(0, ...reloadTasks),
      relatedHeapBeforeMb: before.heapMb, relatedHeapOpenMb: related.heapMb, relatedOpenMs, relatedLongestTaskMs: Math.max(0, ...relatedTasks),
    };
  });
});

try { process.kill(-srv.pid); } catch { /* */ }
out.errors = [...new Set(out.errors)];
const json = JSON.stringify(out, null, 1);
if (arg("out")) writeFileSync(arg("out"), json);
console.log(json);
process.exit(0);
