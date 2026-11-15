import { expect, test } from "@playwright/test";

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
