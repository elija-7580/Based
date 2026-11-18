// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test } from "@playwright/test";

// Review 18.11.2026: Seite öffnen/schließen darf keine Editoren festhalten. Vorher hielt jeder Zwischenstand der
// Aufzeichnung für „Problem melden“ (shell/bugReport.ts) den geschlossenen Editor samt DOM: 20× zwischen zwei
// 300-Block-Seiten wechseln = +96 600 DOM-Knoten und +14 MB Heap nach GC (nachher: ±0 Knoten). Gezählt werden die
// DOM-Knoten des Prozesses nach erzwungener GC über CDP – eine Anzahl, keine Zeit, darum hart (nur Chromium).

test("20× Seite wechseln hält keine geschlossenen Editoren im Speicher", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "DOM-Knoten und GC nur über CDP");
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate(async () => {
    interface Tx { put(r: unknown): void }
    interface Store { transact(n: string, f: (tx: Tx) => void): void }
    const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown>; settled(): Promise<void>; openPage(id: string): Promise<{ store: Store; close(): void }> } } }).__based;
    const now = (Date.now() - 978_307_200_000) / 1000;
    for (const title of ["Leak A", "Leak B"]) {
      const id = (await b.client.command({ op: "createPage", title })) as string;
      const r = await b.client.openPage(id);
      r.store.transact("Seed", (tx) => {
        for (let i = 0; i < 300; i++) tx.put({ kind: "block", data: { id: crypto.randomUUID(), type: "text", parent: "b:" + id, sk: "a" + String(i).padStart(5, "0"), text: `${title} line ${i}`, createdAt: now, updatedAt: now } });
      });
      r.close();
    }
    await b.client.settled();
  });
  const open = async (title: string) => {
    await page.getByRole("treeitem", { name: title }).click();
    await expect(page.getByLabel("Page title")).toHaveValue(title);
    await expect(page.locator(".bx2-block")).toHaveCount(300);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const nodes = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "Nodes")!.value;
  };
  for (let i = 0; i < 2; i++) { await open("Leak A"); await open("Leak B"); }
  const before = await nodes();
  for (let i = 0; i < 10; i++) { await open("Leak A"); await open("Leak B"); }
  const after = await nodes();
  // Eine offene 300-Block-Seite hat ~4 800 Knoten; ein einziger festgehaltener Editor fiele hier schon auf.
  expect(after - before, `DOM-Knoten nach GC: ${before} → ${after}`).toBeLessThan(3000);
});
