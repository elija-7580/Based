import { expect, test } from "@playwright/test";
import { expectFaster } from "./perf.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-495 (aus ADR 0017, Messung 17.11.): Start mit 100 000 Records (50 000 Seiten mit je einem Absatz) im Browser,
// dauerhaftes Profil (WebKit hat OPFS nur dort). Dreimal neu laden, gezählt wird der beste Lauf bis `data-ready` und
// bis die Seitenleiste steht; dazu die Zeit fürs Schreiben in einem Zug (ADR 0017 A1). Die Unit-Seite (openWorkspace, Heap, erster Sync) misst packages/sync/test/scale-perf.test.ts.
// Ausgangswerte 17.11. (Linux-Container): siehe Kommentar an den Schwellen. Lokal hart, in der CI Warnung (perf.ts).

test("Start mit 100 000 Records: bereit und Seitenleiste in wenigen Sekunden", { tag: "@perf" }, async ({ playwright, browserName, baseURL }, info) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), "based-scale-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    // ADR 0017 A1: Schreiben in einem Zug (wie erster Sync oder Import) – bis alles auf der Platte liegt.
    const write = await page.evaluate(async (n) => {
      const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown>; settled(): Promise<void> } } }).__based;
      const t0 = performance.now();
      await b.client.command({ op: "seed", count: n });
      await b.client.settled();
      return performance.now() - t0;
    }, 50_000);
    await expect(page.getByRole("treeitem", { name: "Page 00001" })).toBeVisible({ timeout: 60_000 });

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
    // Nichts verloren: nach dem Neustart sind alle Seiten da.
    const count = await page.evaluate(() => (globalThis as unknown as { __based: { client: { getState(): { titles: Map<string, string> } } } }).__based.client.getState().titles.size);
    expect(count).toBeGreaterThanOrEqual(50_000);
    // Ausgangswerte 17.11.: vor A1 Chromium 6,2 s / WebKit 6,0 s, mit vorbereiteten Anweisungen 4,3 s / 4,0 s.
    console.log(`[${info.project.name}] 100 000 Records schreiben: ${Math.round(write)} ms`);
    expectFaster(info, "100 000 Records schreiben", write, 9000);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
