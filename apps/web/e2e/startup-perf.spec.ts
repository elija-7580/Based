import { expect, test, type Page } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";
import { bestOf, expectFaster } from "./perf.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-368: Start mit 5.000 Seiten – Bericht vom 13.11.: Hauptthread beim Start bis 12,7 s blockiert, Store erst nach
// 14 s bereit. Gemessen wird der Neustart bis zur Seitenleiste und die längste Aufgabe im Hauptthread (Long Tasks,
// nur Chromium). Die Store-Arbeit (Laden, Gliederung, Suche) liegt im Worker; blockiert der Hauptthread hier, ist
// etwas Mengenabhängiges in die Oberfläche gerutscht.

test("Start mit 5.000 Seiten: Seitenleiste schnell da, kein langer Hänger im Hauptthread", { tag: "@perf" }, async ({ playwright, browserName, baseURL }, info) => {
  test.setTimeout(120_000);
  // Dauerhaftes Profil: WebKit hat OPFS nur dort (sonst startet der Store nach dem Neuladen leer, „Not saved“).
  const dir = mkdtempSync(join(tmpdir(), "based-start-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await page.evaluate((n) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown> } } }).__based.client.command({ op: "seed", count: n }), 5000);
    await expect(page.getByRole("treeitem", { name: "Page 0001" })).toBeVisible();
    await page.evaluate(() => (globalThis as unknown as { __based: { client: { settled(): Promise<void> } } }).__based.client.settled());
    await page.addInitScript(() => {
      const w = globalThis as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__longTasks.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
      } catch { /* WebKit kennt keine Long Tasks */ }
    });
    const t0 = Date.now();
    await page.reload();
    await expect(page.getByRole("treeitem", { name: "Page 0001" })).toBeVisible({ timeout: 60_000 });
    const ready = Date.now() - t0;
    await page.waitForTimeout(1000);
    const longest = Math.max(0, ...(await page.evaluate(() => (globalThis as unknown as { __longTasks: number[] }).__longTasks)));
    info.annotations.push({ type: "startup-ms", description: `ready ${ready} · longest task ${longest}` });
    console.log(`[${info.project.name}] Start mit 5.000 Seiten: Seitenleiste nach ${ready} ms, längste Aufgabe ${longest} ms`);
    // BSD-450: Zeiten lokal hart, in der CI Warnung
    expectFaster(info, "Start bis Seitenleiste", ready, 6000);
    if (browserName === "chromium") expectFaster(info, "längste Aufgabe", longest, 1000);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// BSD-280 Teil 2: Seitenwechsel und Tastendruck-Verzögerung an einem festen Workspace (zwei Seiten mit je 300 Blöcken).
// Gemessen im Browser selbst (performance.now), nicht über Playwright-Roundtrips. Grenzen aus drei Läufen auf dem
// Linux-Container mit Luft für die CI (dort nur Warnung, siehe AGENTS.md „Zeitmessungen“).

interface Seeded { a: string; b: string }

async function seedTwoBigPages(page: Page): Promise<Seeded> {
  return page.evaluate(async () => {
    interface Tx { put(r: unknown): void }
    interface Store { transact(n: string, f: (tx: Tx) => void): void }
    const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown>; openPage(id: string): Promise<{ store: Store; close(): void }> } } }).__based;
    const now = (Date.now() - 978_307_200_000) / 1000;
    const ids: string[] = [];
    for (const title of ["Big page A", "Big page B"]) {
      const id = (await b.client.command({ op: "createPage", title })) as string;
      const r = await b.client.openPage(id);
      r.store.transact("Seed", (tx) => {
        for (let i = 0; i < 300; i++) {
          const type = i % 10 === 0 ? "heading2" : i % 3 === 0 ? "bulletedList" : "text";
          tx.put({ kind: "block", data: { id: crypto.randomUUID(), type, parent: "b:" + id, sk: "a" + String(i).padStart(5, "0"), text: `${title} line ${i} with some ordinary words to fill the row`, createdAt: now, updatedAt: now } });
        }
      });
      ids.push(id);
    }
    await (b.client as unknown as { settled(): Promise<void> }).settled();
    return { a: ids[0]!, b: ids[1]! };
  });
}

test("Seitenwechsel und Tippen auf großen Seiten bleiben flüssig", { tag: "@perf" }, async ({ page, browserName }, info) => {
  test.setTimeout(240_000); // BSD-450: bis zu 3 Durchgänge
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await seedTwoBigPages(page);
  const switchLimit = browserName === "chromium" ? 1200 : 4000;
  const keyLimit = browserName === "chromium" ? 70 : 550;
  // Tippen: Zeit von keydown bis zum nächsten gemalten Frame (Messung einmal anhängen, je Durchgang leeren).
  await page.evaluate(() => {
    const w = globalThis as unknown as { __keyLat: number[] };
    w.__keyLat = [];
    document.addEventListener("keydown", (e) => {
      const start = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => w.__keyLat.push(performance.now() - start), 0));
    }, { capture: true });
  });
  const editor = blockEditor(page);
  // Ein Durchgang: 4 Seitenwechsel, dann 44 Tasten am Ende von Big page B.
  const measure = async () => {
    const switches: number[] = [];
    for (let i = 0; i < 4; i++) {
      const title = i % 2 === 0 ? "Big page A" : "Big page B";
      const t0 = await page.evaluate(() => performance.now());
      await page.getByRole("treeitem", { name: title }).click();
      await expect(page.getByLabel("Page title")).toHaveValue(title);
      await expect(page.getByTestId("page-content").getByText(`${title} line 299`, { exact: false })).toBeAttached({ timeout: 20_000 });
      switches.push(Math.round((await page.evaluate(() => performance.now())) - t0));
    }
    await editor.getByText("Big page B line 299", { exact: false }).click();
    await page.keyboard.press("End");
    await page.evaluate(() => { (globalThis as unknown as { __keyLat: number[] }).__keyLat = []; });
    await page.keyboard.type(" the quick brown fox jumps over the lazy dog", { delay: 30 });
    await page.waitForTimeout(300);
    const lat = (await page.evaluate(() => (globalThis as unknown as { __keyLat: number[] }).__keyLat)).sort((x, y) => x - y);
    const p = (q: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]!);
    const sw = [...switches].sort((x, y) => x - y);
    return { sw, keys: lat.length, p50: p(0.5), p95: p(0.95), max: p(1), worstSwitch: sw[sw.length - 1]! };
  };
  // BSD-450: unter Last (~20 auf 4 Kernen) kostet ein Nachbar nur manchmal Zeit – bester von höchstens 3 Durchgängen
  const r = await bestOf(3, measure, (x) => x.worstSwitch >= switchLimit || x.p95 >= keyLimit, (a, b) => Math.max(a.worstSwitch / switchLimit, a.p95 / keyLimit) < Math.max(b.worstSwitch / switchLimit, b.p95 / keyLimit));
  info.annotations.push({ type: "page-switch-ms", description: r.sw.join(", ") }, { type: "key-latency-ms", description: `p50 ${r.p50} · p95 ${r.p95} · max ${r.max}` });
  console.log(`[${info.project.name}] Seitenwechsel (300 Blöcke): ${r.sw.join(", ")} ms · Tastendruck p50 ${r.p50} p95 ${r.p95} max ${r.max} ms (${r.keys} Tasten)`);
  expect(r.keys).toBeGreaterThan(30);
  // Grenzen aus drei Läufen am 13.11. (Linux-Container, alter BlockNote-Editor): Chromium Wechsel 250–590 ms,
  // Taste p95 21–32 ms; WebKit Wechsel 580–1900 ms, Taste p95 215–270 ms. Doppelte Luft – Wächter gegen Rückfälle.
  // BSD-450: lokal hart, in der CI Warnung.
  expectFaster(info, "Seitenwechsel (langsamster)", r.worstSwitch, switchLimit);
  expectFaster(info, "Tastendruck p95", r.p95, keyLimit);
});

// BSD-400: Eine Taste schreibt nur ihr eigenes Textfeld. Vorher hingen die Felder an den props der Hülle (neu bei
// jeder Taste) – alle 300 Felder bauten ihr DOM neu auf. Zählt Felder, deren Inhalt sich beim Tippen ändert.
test("Tippen zeichnet nur das eigene Textfeld neu", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await seedTwoBigPages(page);
  await page.getByRole("treeitem", { name: "Big page A" }).click();
  await expect(page.getByTestId("page-content").getByText("Big page A line 299", { exact: false })).toBeAttached({ timeout: 20_000 });
  const editor = blockEditor(page);
  await editor.getByText("Big page A line 150", { exact: false }).click();
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const w = globalThis as unknown as { __touched: Set<string>; __mo: MutationObserver };
    w.__touched = new Set();
    w.__mo = new MutationObserver((list) => {
      for (const m of list) {
        const f = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest<HTMLElement>("[data-editable-id]");
        if (f) w.__touched.add(f.dataset.editableId!);
      }
    });
    w.__mo.observe(document.querySelector("[data-testid=block-editor]")!, { subtree: true, childList: true, characterData: true });
  });
  await page.keyboard.type("abc", { delay: 50 });
  await page.waitForTimeout(300);
  const touched = await page.evaluate(() => { const w = globalThis as unknown as { __touched: Set<string>; __mo: MutationObserver }; w.__mo.disconnect(); return w.__touched.size; });
  expect(touched).toBe(1);
  await expect(editor.getByText("Big page A line 150 with some ordinary words to fill the rowabc")).toBeVisible();
});
