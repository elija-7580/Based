import { expect, test } from "@playwright/test";
import { expectFaster } from "./perf.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-495 (aus ADR 0017, Messung 17.11.): Start mit 100 000 Records (50 000 Seiten mit je einem Absatz) im Browser,
// dauerhaftes Profil (WebKit hat OPFS nur dort). Dreimal neu laden, gezählt wird der beste Lauf bis `data-ready` und
// bis die Seitenleiste steht. Die Unit-Seite (openWorkspace, Heap, erster Sync) misst packages/sync/test/scale-perf.test.ts.
// Ausgangswerte 17.11. (Linux-Container): siehe Kommentar an den Schwellen. Lokal hart, in der CI Warnung (perf.ts).

test("Start mit 100 000 Records: bereit und Seitenleiste in wenigen Sekunden", { tag: "@perf" }, async ({ playwright, browserName, baseURL }, info) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), "based-scale-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await page.evaluate((n) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown> } } }).__based.client.command({ op: "seed", count: n }), 50_000);
    await expect(page.getByRole("treeitem", { name: "Page 00001" })).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => (globalThis as unknown as { __based: { client: { settled(): Promise<void> } } }).__based.client.settled());

    const runs: { ready: number; sidebar: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "", { timeout: 60_000 });
      const ready = Date.now() - t0;
      await expect(page.getByRole("treeitem", { name: "Page 00001" })).toBeVisible({ timeout: 60_000 });
      runs.push({ ready, sidebar: Date.now() - t0 });
    }
    const best = runs.reduce((a, b) => (b.sidebar < a.sidebar ? b : a));
    info.annotations.push({ type: "scale-start-ms", description: runs.map((r) => `ready ${r.ready} · sidebar ${r.sidebar}`).join("; ") });
    console.log(`[${info.project.name}] Start mit 100 000 Records: ${runs.map((r) => `${r.ready}/${r.sidebar}`).join(", ")} ms (bereit/Seitenleiste)`);
    // Ausgangswerte 17.11. (bester von 3): Chromium 2,0 s, WebKit 2,3 s. Schwellen mit Luft für langsamere Macs und Last.
    expectFaster(info, "Start 100 000 Records bis Seitenleiste", best.sidebar, browserName === "chromium" ? 5000 : 7000);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
