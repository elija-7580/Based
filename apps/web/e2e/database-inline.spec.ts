import { expect, test, type Page } from "@playwright/test";

// BSD-255: Inline-Datenbanken ruhig wie in Notion – kein eigener senkrechter Scroller in der Tabelle, „Load more“,
// Werkzeuge erst beim Überfahren, „Open as full page“. Screenshots (hell/dunkel) nur mit BASED_SCREENSHOTS=1 in Chromium.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

async function ready(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

/** Seite mit Text, Inline-Datenbank (40 Zeilen) und Text danach. */
async function setup(page: Page) {
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
  return { db };
}

/** Zeilen direkt in die Seiten-Replik schreiben (wie es die Tabelle tut), schneller als 25 Klicks. */
async function addRows(page: Page, n: number) {
  await page.evaluate(async (count) => {
    interface Tx { put(r: unknown): void }
    interface Store { blocks: Map<string, { id: string; type: string; props?: { databaseID?: string } }>; children(p: string): string[]; transact(n: string, f: (tx: Tx) => void): void }
    const b = (globalThis as unknown as { __based: { client: { openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const pageID = location.hash.replace(/^#page-/, "");
    const { store } = await b.client.openPage(pageID);
    const inline = [...store.blocks.values()].find((x) => x.type === "databaseInline")!;
    const dbID = inline.props!.databaseID!;
    const now = (Date.now() - 978_307_200_000) / 1000;
    store.transact("Seed", (tx) => {
      for (let i = 0; i < count; i++) tx.put({ kind: "block", data: { id: crypto.randomUUID(), type: "page", parent: "d:" + dbID, sk: "z" + String(i).padStart(4, "0"), text: "Row " + (i + 1), createdAt: now, updatedAt: now } });
    });
  }, n);
}

test("Inline-Tabelle: keine eigene Bildlaufleiste, Load more, Werkzeuge beim Überfahren, Open as full page", async ({ page, browserName }) => {
  await ready(page);
  const { db } = await setup(page);
  const rows = db.locator(".dbui-vrow[data-row-id]");
  await addRows(page, 25);
  // 3 Beispielzeilen + 25 neue = 28: 25 sichtbar, Load more für 3
  await expect(rows).toHaveCount(25);
  const more = db.getByRole("button", { name: /Load more/ });
  await expect(more).toContainText("3 of 3");
  // Kein senkrechter Scroller in der Tabelle: Inhalt so hoch wie sichtbar
  const scroll = db.getByTestId("table-scroll");
  const [sh, ch, oy] = await scroll.evaluate((el) => [el.scrollHeight, el.clientHeight, getComputedStyle(el).overflowY]);
  expect(oy).toBe("hidden");
  expect(sh - ch).toBeLessThan(4);
  await more.click();
  await expect(rows).toHaveCount(28);
  await expect(more).toHaveCount(0);
  // Werkzeuge erst beim Überfahren
  await page.locator(".page-title").hover();
  await expect(db.locator(".dbui-actions")).toHaveCSS("opacity", "0");
  await db.hover();
  await expect(db.locator(".dbui-actions")).toHaveCSS("opacity", "1");
  if (SHOTS && browserName === "chromium") {
    await page.locator(".page-title").scrollIntoViewIfNeeded();
    await db.hover();
    for (const theme of ["light", "dark"] as const) {
      // Über den Umschalter der App (⇧⌘L), damit auch das Astryx-Theme mitgeht.
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.keyboard.press("ControlOrMeta+Shift+l");
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-inline-table-${theme}.png` });
    }
    await page.keyboard.press("ControlOrMeta+Shift+l");
  }
  // Als ganze Seite öffnen
  await db.getByRole("button", { name: "Open as full page" }).click();
  await expect(page.locator(".shell-database.full")).toBeVisible();
  await expect(page.locator(".shell-database.full .dbui-vrow[data-row-id]").first()).toBeVisible();
  await expect(page.locator(".shell-database.full").getByRole("button", { name: /Load more/ })).toHaveCount(0);
});

// BSD-255 Teil 2: Liste, Galerie und Board inline wachsen mit der Seite (keine feste Höhe, kein eigener senkrechter
// Scroller), „Load more“ für die Liste/Galerie und je Board-Spalte.
for (const type of ["list", "gallery", "board"] as const) {
  test(`Inline-${type}: wächst mit der Seite, Load more`, async ({ page, browserName }) => {
    await ready(page);
    const { db } = await setup(page);
    await addRows(page, 30);
    await db.hover();
    await db.getByRole("button", { name: "Add view" }).click();
    // per Tastatur: in WebKit liegt das Menü unter dem Seitenende und ist nicht klickbar, ohne zu scrollen
    await page.getByTestId(`add-view-${type}`).focus();
    await page.keyboard.press("Enter");
    const body = db.locator(`.dbui-body[data-view-type="${type}"]`);
    await expect(body).toBeVisible();
    const items = type === "list" ? db.locator(".dbui-list-row") : db.locator(".dbui-card[data-row-id]");
    // 3 Beispielzeilen + 30 = 33: 25 sichtbar
    await expect(items).toHaveCount(25);
    // kein eigener senkrechter Scroller: der Inhalt passt in die Fläche
    const [sh, ch] = await body.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(sh - ch).toBeLessThan(4);
    const more = db.getByRole("button", { name: /Load more/ }).first();
    await expect(more).toContainText("8 of 8");
    if (SHOTS && browserName === "chromium") {
      // Schreibmarke zurück in den Text, damit der Datenbank-Block nicht als ausgewählt (blau) erscheint
      await page.getByText("Notes before the table.").click();
      await page.mouse.move(10, 450);
      for (const theme of ["light", "dark"] as const) {
        if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.keyboard.press("ControlOrMeta+Shift+l");
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `../../docs/design/screens/web-db-inline-${type}-${theme}.png` });
      }
      await page.keyboard.press("ControlOrMeta+Shift+l");
    }
    await more.click();
    await expect(items).toHaveCount(33);
  });
}
