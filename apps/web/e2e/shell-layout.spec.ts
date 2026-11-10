import { expect, test, type Page } from "@playwright/test";

// Feedback 10. Nov.: die Oberfläche ließ sich verschieben (Dokument scrollte/federte, Kopfzeile wanderte weg),
// Seitenleiste nicht in der Breite änderbar, „/Database – Inline“ legte keine Datenbank an, Datenbankseiten schmal.

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Dokument scrollt nie, die Kopfzeile bleibt beim Scrollen der Seite stehen", async ({ page }) => {
  await ready(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 360 }); // Willkommensseite länger als das Panel
  const top = page.locator(".topbar");
  const before = (await top.boundingBox())!.y;

  await page.locator(".panel").hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.locator(".panel").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => [document.scrollingElement!.scrollTop, document.body.scrollTop])).toEqual([0, 0]);
  expect((await top.boundingBox())!.y).toBe(before);
  await expect(top).toBeInViewport();
  // Programmgesteuertes Scrollen (Fokus, scrollIntoView) verschiebt das Dokument ebenfalls nicht.
  await page.evaluate(() => window.scrollTo(0, 500));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
});

test("Seitenleiste: Breite ziehen (gemerkt), ⌘\\ blendet aus und ein", async ({ page }) => {
  await ready(page);
  const sidebar = page.locator("nav.sidebar");
  const w0 = (await sidebar.boundingBox())!.width;
  const handle = page.getByTestId("sidebar-resize");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(w0 + 80));

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(w0 + 80));

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(sidebar).toBeHidden();
  await expect(page.getByTestId("sidebar-show")).toBeVisible();
  await page.getByTestId("sidebar-show").click();
  await expect(sidebar).toBeVisible();
});

test("„/Database – Inline“ legt eine echte Datenbank an; Datenbankseiten nutzen die volle Breite", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  const editor = page.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: /Database – Inline/ }).click();
  await expect(page.locator(".bx-database-placeholder")).toHaveCount(0);
  await expect(page.locator(".shell-database.inline").getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  await expect(page.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  const panel = (await page.locator(".panel").boundingBox())!;
  const db = (await page.locator(".shell-database.full").boundingBox())!;
  expect(db.width).toBeGreaterThan(panel.width * 0.85);
});
