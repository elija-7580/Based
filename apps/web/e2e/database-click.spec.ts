import { expect, test, type Page } from "@playwright/test";

// BSD-372: Klick und Auswahl treffen die Zeile unter der Maus – als Vollseite mit vielen Zeilen nach dem Scrollen und
// inline in einer Seite (in Spalten), auch nach Escape (vorher sprang die Auswahl dann auf die erste Zeile).

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);
const activeRow = (page: Page) => page.evaluate(() => document.querySelector(".dbui-cell.active")?.closest("[data-row-id]")?.querySelector(".dbui-cell.title")?.textContent?.replace(/Open$/, "") ?? null);
const rowUnder = (page: Page, x: number, y: number) => page.evaluate(([xx, yy]) => document.elementFromPoint(xx!, yy!)?.closest("[data-row-id]")?.querySelector(".dbui-cell.title")?.textContent?.replace(/Open$/, "") ?? null, [x, y]);

async function fresh(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

/** Klickt in die Titelzelle unter (x, y), schließt den Zelleneditor und die Auswahl mit Escape, prüft die Zeile. */
async function clickAt(page: Page, x: number, y0: number) {
  // auf die Mitte der Zeile, nicht auf eine Linie zwischen zwei Zeilen (Bruchteile eines Pixels runden je Browser anders)
  const y = await page.evaluate(([xx, yy]) => { const r = document.elementFromPoint(xx!, yy!)?.closest("[data-row-id]")?.getBoundingClientRect(); return r ? r.y + r.height / 2 : yy!; }, [x, y0]);
  const under = await rowUnder(page, x, y);
  expect(under, `Zeile unter (${x}, ${y})`).not.toBeNull();
  await page.mouse.click(x, y);
  await expect.poll(() => activeRow(page)).toBe(under);
  await page.keyboard.press("Escape"); // Zelleneditor zu
  await page.keyboard.press("Escape"); // Auswahl weg – der nächste Klick fokussiert die Tabelle neu
}

test("Vollseite mit 300 Zeilen: nach dem Scrollen trifft der Klick die Zeile unter der Maus", async ({ page }) => {
  await fresh(page);
  await command(page, { op: "seedDatabase", count: 300 });
  await page.getByRole("treeitem", { name: "Big 300" }).click();
  const scroll = page.getByTestId("table-scroll");
  await expect(scroll.getByText("Row 1", { exact: true })).toBeVisible();
  const box = (await scroll.boundingBox())!;
  const x = box.x + 120;
  await page.mouse.move(x, box.y + box.height / 2);
  for (const steps of [3, 10]) {
    for (let i = 0; i < steps; i++) await page.mouse.wheel(0, 400);
    // WebKit rollt weich nach: erst klicken, wenn die Position steht (sonst misst der Test vor dem Ende des Rollens)
    let last = -1;
    await expect.poll(async () => { const now = await scroll.evaluate((el) => el.scrollTop); const still = now === last; last = now; return still; }, { intervals: [150] }).toBe(true);
    for (const f of [0.3, 0.55, 0.85]) await clickAt(page, x, box.y + box.height * f);
  }
  // ⇧-Klick auf die Kästchen wählt genau den Bereich zwischen den Zeilen unter der Maus
  const row = (name: string) => scroll.locator("[data-row-id]").filter({ has: page.getByText(name, { exact: true }) });
  const visible = await scroll.locator("[data-row-id]").evaluateAll((els) => els.map((e) => ({ y: e.getBoundingClientRect().y, name: e.querySelector(".dbui-cell.title")?.textContent?.replace(/Open$/, "") ?? "" }))
    .filter((r) => r.y > 200 && r.y < 650).sort((p, q) => p.y - q.y).map((r) => r.name));
  const [first, last] = [row(visible[1]!), row(visible[4]!)];
  const [a, b] = [await first.getAttribute("data-row-id"), await last.getAttribute("data-row-id")];
  await first.hover();
  await first.locator(".dbui-row-check").click();
  await last.hover();
  await last.locator(".dbui-row-check").click({ modifiers: ["Shift"] });
  const selected = await scroll.locator("[data-row-id][aria-selected=true]").evaluateAll((els) => els.sort((p, q) => p.getBoundingClientRect().y - q.getBoundingClientRect().y).map((e) => e.getAttribute("data-row-id")));
  expect(selected[0]).toBe(a);
  expect(selected.at(-1)).toBe(b);
  expect(selected).toHaveLength(4);
});

test("Inline in einer Seite: Klick nach Escape bleibt auf der Zeile unter der Maus, auch nach dem Scrollen der Seite", async ({ page }) => {
  await fresh(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("Notes before the table.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: /Database – Inline/ }).click();
  const db = page.locator(".shell-database.inline");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  // 20 benannte Zeilen direkt in die Seiten-Replik (wie database-inline.spec.ts)
  await page.evaluate(async () => {
    interface Tx { put(r: unknown): void }
    interface Store { blocks: Map<string, { id: string; type: string; props?: { databaseID?: string } }>; transact(n: string, f: (tx: Tx) => void): void }
    const b = (globalThis as unknown as { __based: { client: { openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const { store } = await b.client.openPage(location.hash.replace(/^#page-/, ""));
    const dbID = [...store.blocks.values()].find((x) => x.type === "databaseInline")!.props!.databaseID!;
    const now = (Date.now() - 978_307_200_000) / 1000;
    store.transact("Seed", (tx) => {
      for (let i = 0; i < 20; i++) tx.put({ kind: "block", data: { id: crypto.randomUUID().toUpperCase(), type: "page", parent: "d:" + dbID, sk: "t" + String(i).padStart(3, "0"), text: `Item ${i + 1}`, createdAt: now, updatedAt: now } });
    });
  });
  await expect(db.getByText("Item 12", { exact: true })).toBeVisible();
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(400);
  for (const name of ["Item 4", "Item 9", "Item 7", "Item 12"]) {
    const box = (await db.getByText(name, { exact: true }).first().boundingBox())!;
    await clickAt(page, box.x + 5, box.y + box.height / 2);
  }
});
