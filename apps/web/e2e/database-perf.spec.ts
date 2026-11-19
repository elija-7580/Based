import { expect, test } from "@playwright/test";
import { expectFaster } from "./perf.js";

// BSD-215 / BSD-435: Tabelle mit 100 000 Zeilen öffnen (die Website verspricht „a hundred thousand rows stay instant“), ans Ende scrollen, eine Zelle ändern. Grenzwerte großzügig (geteilte
// Maschine, zwei Browser); die gemessenen Zeiten stehen als Anmerkung im Testbericht.

const N = 100_000;

test(`${N.toLocaleString("de")} Zeilen: öffnen, scrollen, Zelle ändern`, { tag: "@perf" }, async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate((count) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "seedDatabase", count }), N);

  const t0 = Date.now();
  await page.goto("/#page-" + id);
  const db = page.locator(".shell-database.full");
  await expect(db.getByLabel("Pages in view")).toHaveText(N.toLocaleString("en-US"), { timeout: 60_000 });
  await expect(db.locator(".dbui-vrow[data-row-id]").first()).toBeVisible();
  const open = Date.now() - t0;

  const t1 = Date.now();
  await db.getByTestId("table-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(db.getByText(`Row ${N}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  const scroll = Date.now() - t1;

  const t2 = Date.now();
  const cell = db.locator(".dbui-vrow", { hasText: `Row ${N}` }).locator(".dbui-cell.title");
  await cell.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Last row");
  await page.keyboard.press("Enter");
  await expect(db.getByText("Last row", { exact: true })).toBeVisible({ timeout: 30_000 });
  const edit = Date.now() - t2;

  info.annotations.push({ type: "BSD-215", description: `open ${open} ms, scroll ${scroll} ms, edit ${edit} ms` });
  console.info(`BSD-215 ${info.project.name}: ${N} Zeilen öffnen ${open} ms, ans Ende scrollen ${scroll} ms, Zelle ändern ${edit} ms`);
  expect(open).toBeLessThan(60_000);
  expect(scroll).toBeLessThan(10_000);
  expect(edit).toBeLessThan(10_000);
});

// BSD-604: „Add property → ID“ nummeriert alle Zeilen in einer Transaktion im Hauptthread. Vorher 2,1–2,2 s in einer
// Aufgabe (Chromium) und ein Undo von ~20 s (quadratischer Filter); nachher ~1,0 s. Gemessen wird die längste Aufgabe
// (Long Tasks), nicht die Wanduhr. Ziel aus dem Eintrag: < 200 ms – das braucht Teil 2 (Nummern nicht mehr in einer
// Aufgabe); die Grenzen hier halten das Erreichte.
test(`${N.toLocaleString("de")} Zeilen: Spalte „ID“ anlegen und zurücknehmen`, { tag: "@perf" }, async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Long Tasks nur in Chromium");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate((count) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "seedDatabase", count }), N);
  await page.goto("/#page-" + id);
  const db = page.locator(".shell-database.full");
  await expect(db.getByLabel("Pages in view")).toHaveText(N.toLocaleString("en-US"), { timeout: 60_000 });
  await expect(db.locator(".dbui-vrow[data-row-id]").first()).toBeVisible();
  await page.evaluate(() => {
    const w = globalThis as unknown as { __longest: number };
    w.__longest = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__longest = Math.max(w.__longest, e.duration); }).observe({ type: "longtask" });
  });
  const longest = async () => {
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    return page.evaluate(() => { const w = globalThis as unknown as { __longest: number }; const v = w.__longest; w.__longest = 0; return v; });
  };
  await longest();

  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-uniqueID").click();
  const header = db.getByRole("columnheader", { name: /^ID/ });
  await expect(header.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  const first = db.locator(".dbui-vrow[data-row-id]").first();
  await expect(first).toContainText("1");
  const add = await longest();

  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(header).toHaveCount(0, { timeout: 60_000 });
  const undo = await longest();

  info.annotations.push({ type: "BSD-604", description: `ID-Spalte: längste Aufgabe ${Math.round(add)} ms, Undo ${Math.round(undo)} ms` });
  console.info(`BSD-604 ${N} Zeilen: Spalte ID längste Aufgabe ${Math.round(add)} ms, Undo ${Math.round(undo)} ms`);
  expectFaster(info, "Spalte ID anlegen (längste Aufgabe)", add, 1600);
  expectFaster(info, "Spalte ID zurücknehmen (längste Aufgabe)", undo, 4000);
});
