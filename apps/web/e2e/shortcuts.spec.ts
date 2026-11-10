import { expect, test, type Page } from "@playwright/test";

// BSD-204: Kürzel ⌘N (Palette „New…“), ⌥⌘N, ⌘P, ⇧⌘L, ⌘1–9 – im Test kommen sie an (im Browser-Tab fängt der Browser
// einige ab, in der App nicht).

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("⌘N öffnet „New…“: tippen filtert, Enter legt eine Datenbank an; ⌥⌘N neue Seite", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(4);
  await page.keyboard.type("datab");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.locator(".shell-database.full")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("⌘P sucht, ⇧⌘L schaltet hell/dunkel, ⌘1/⌘9 wählen Tabs", async ({ page }) => {
  await ready(page);
  await page.locator(".panel").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
  await page.keyboard.press("Escape");

  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(before);

  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.press("ControlOrMeta+t");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+9");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
});

test("Kopfzeile: „Edited …“ und •••-Menü mit allen Seitenaktionen", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Alt+n");
  const editor = page.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("Hello");
  // WebKit-Testprofile haben kein OPFS („Not saved“); dort zeigt nur das Menü die Zeit.
  await expect(page.getByTestId("page-edited")).toHaveText(/Edited just now|Not saved/);

  await page.getByRole("button", { name: "Page menu" }).click();
  const menu = page.getByRole("menu", { name: "Page menu" });
  for (const name of ["Copy link", "Duplicate", "Move to…", "Add to Favorites", "Export…", "Version history", "Move to Trash"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }
  await expect(menu.getByTestId("page-menu-edited")).toHaveText("Edited just now");
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(2);
});
