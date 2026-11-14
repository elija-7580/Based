import { expect, test, type Page } from "@playwright/test";

// Elijas Meldung 14. 11.: Inline-Datenbanken nebeneinander in Spalten – Linien, Zeilenfläche und Bildlaufleiste der
// rechten Tabelle liefen über den Spaltenabstand in die linke Spalte, lange Titel wurden abgeschnitten; „Open as full
// page“ zeigte „Untitled“ statt des Datenbanktitels. Fotos (hell/dunkel, 1280 × 820) mit BASED_SCREENSHOTS=1 in Chromium.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

const editor = (page: Page) => page.getByTestId("block-editor");
const dbBlocks = (page: Page) => editor(page).locator('.bx2-block[data-type="databaseInline"]');

async function twoDatabasesInColumns(page: Page, width = 1280, height = 820) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "Columns" });
  });
  await page.goto(`/#page-${id}`);
  for (const n of [1, 2]) {
    await editor(page).getByTestId("block-editor-tail").click();
    await page.keyboard.type("/database");
    await page.keyboard.press("Enter");
    await expect(dbBlocks(page)).toHaveCount(n);
  }
  const titles = page.getByRole("textbox", { name: "Database title" });
  await titles.nth(0).fill("Weekly Review & Planning for the whole semester");
  await titles.nth(1).fill("Daily Pages");
  // zweite Datenbank rechts neben die erste ziehen
  const second = dbBlocks(page).nth(1);
  await second.hover({ position: { x: 100, y: 10 } });
  const h = (await second.locator(":scope > .bx2-gutter [data-handle]").boundingBox())!;
  const first = (await dbBlocks(page).nth(0).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 20, h.y + 10, { steps: 4 });
  await page.mouse.move(first.x + first.width - 8, first.y + first.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(editor(page).locator(".bx2-columns .bx2-column")).toHaveCount(2);
}

test("Inline-Datenbanken in Spalten: nichts ragt in die Nachbarspalte, lange Titel brechen um", async ({ page, browserName }) => {
  await twoDatabasesInColumns(page);
  const cols = editor(page).locator(".bx2-column");
  const left = (await cols.nth(0).boundingBox())!;
  const right = cols.nth(1);
  // Bildlaufleiste/Kästchen-Spalte der rechten Tabelle beginnen im Spaltenabstand, nicht in der linken Spalte
  const scroll = (await right.getByTestId("table-scroll").boundingBox())!;
  expect(scroll.x).toBeGreaterThanOrEqual(left.x + left.width);
  // Linie und Fläche einer Zeile beginnen an der ersten Spalte (nicht in der Kästchen-Spalte)
  const row = right.locator(".dbui-vrow[data-row-id]").first();
  await row.hover();
  const firstCell = (await row.locator(".dbui-cell").first().boundingBox())!;
  const line = await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left + parseFloat(getComputedStyle(el, "::after").left);
  });
  expect(Math.abs(line - firstCell.x)).toBeLessThanOrEqual(1);
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  expect(await row.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
  // Name bleibt bündig mit dem Titel
  const title = (await right.getByRole("textbox", { name: "Database title" }).boundingBox())!;
  const name = (await right.locator(".dbui-cell.title").first().boundingBox())!;
  expect(Math.abs(name.x + 8 - title.x)).toBeLessThanOrEqual(4);
  // Langer Titel in der schmalen Spalte bricht um statt abgeschnitten zu werden
  const long = cols.nth(0).getByRole("textbox", { name: "Database title" });
  const [sw, cw, lines] = await long.evaluate((el) => [el.scrollWidth, el.clientWidth, el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)]);
  expect(sw).toBeLessThanOrEqual(cw);
  expect(lines).toBeGreaterThan(1.5);
  // Enter fügt keinen Zeilenumbruch ein
  await long.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(long).not.toBeFocused();
  await expect(long).toHaveValue("Weekly Review & Planning for the whole semester");
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.keyboard.press("ControlOrMeta+Shift+l");
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await row.hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-columns-1280x820-${theme}.png` });
    }
  }
});

test("Inline-Datenbank als ganze Seite: Knopf und Blockmenü, Titel der Datenbank überall", async ({ page }) => {
  await twoDatabasesInColumns(page);
  const right = editor(page).locator(".bx2-column").nth(1);
  await right.locator(".dbui-root.inline").hover();
  await right.getByRole("button", { name: "Open as full page" }).click();
  await expect(page.locator(".shell-database.full")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Daily Pages");
  await expect(page.locator(".crumb-current")).toHaveText("Daily Pages");
  // Seitenleiste zeigt die Datenbanktitel (nicht „Untitled“)
  await expect(page.locator(".tree-row", { hasText: "Daily Pages" })).toHaveCount(1);
  await expect(page.locator(".tree-row", { hasText: "Weekly Review" })).toHaveCount(1);
  // zurück und über das Blockmenü (⋮⋮)
  await page.goBack();
  const block = dbBlocks(page).nth(1);
  await block.hover({ position: { x: 100, y: 10 } });
  await block.locator(":scope > .bx2-gutter [data-handle]").click();
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Open as full page" }).click();
  await expect(page.locator(".shell-database.full")).toBeVisible();
  await expect(page.locator(".crumb-current")).toHaveText("Daily Pages");
});
