import { expect, test } from "@playwright/test";
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
    expect(ready).toBeLessThan(6000);
    if (browserName === "chromium") expect(longest).toBeLessThan(1000);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
