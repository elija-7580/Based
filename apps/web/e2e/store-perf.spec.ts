import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectFaster } from "./perf.js";

// ADR 0017, Stufe A: Zeitmessung am Speicher mit 100 000 Records (50 000 Seiten mit je einem Block) auf echtem OPFS
// (dauerhaftes Profil, auch in WebKit). Gemessen wird, was mit der Größe des Workspaces wächst:
//   - Schreiben in einem Zug (wie erster Sync oder Import): 100 000 Records in einer Transaktion,
//   - Neustart bis die Seitenleiste da ist (alles laden, prüfen, Index, Gliederung).
// Ausgangswerte 17.11.2026 (Linux-Container): siehe docs/adr/0017-storage-and-sync-efficiency.md. Schwellen mit Luft;
// lokal hart, in der CI Warnung (perf.ts).
const PAGES = 50_000;

test("Speicher mit 100 000 Records: Schreiben in einem Zug und Neustart bleiben im Rahmen", { tag: "@perf" }, async ({ playwright, browserName, baseURL }, info) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), "based-store-perf-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on("dialog", (d) => void d.accept());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    const write = await page.evaluate(async (n) => {
      const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown>; settled(): Promise<void> } } }).__based;
      const t0 = performance.now();
      await b.client.command({ op: "seed", count: n });
      await b.client.settled();
      return performance.now() - t0;
    }, PAGES);
    await expect(page.getByRole("treeitem", { name: "Page 00001" })).toBeVisible({ timeout: 60_000 });
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.reload();
      await expect(page.getByRole("treeitem", { name: "Page 00001" })).toBeVisible({ timeout: 120_000 });
      starts.push(Date.now() - t0);
    }
    const start = Math.min(...starts);
    // Nichts verloren: die letzte Seite ist nach dem Neustart da und lässt sich öffnen.
    const count = await page.evaluate(() => (globalThis as unknown as { __based: { client: { getState(): { titles: Map<string, string> } } } }).__based.client.getState().titles.size);
    expect(count).toBeGreaterThanOrEqual(PAGES);
    info.annotations.push({ type: "store-perf", description: `write ${Math.round(write)} · start ${starts.join("/")}` });
    console.log(`[${info.project.name}] Speicher 100 000 Records: Schreiben ${Math.round(write)} ms · Neustart ${starts.join(" / ")} ms`);
    expectFaster(info, "100 000 Records schreiben", write, 12_000);
    expectFaster(info, "Neustart mit 100 000 Records", start, 6_000);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
