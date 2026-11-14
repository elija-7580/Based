import { expect, test, type Page } from "@playwright/test";
import { editorFields, expectEditable } from "./editor-helpers.js";

// BSD-238: App per Tastatur – F6 zwischen Bereichen, Tabellen-Zellen (Fokus, Tab, Leertaste), Menüs (Pfeile, Fokus zurück).

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("F6 / ⇧F6: Seitenleiste → Kopfzeile → Seite", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expectEditable(page);
  await editorFields(page).last().click();
  await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("nav.sidebar"))).toBe(true);
  await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".topbar"))).toBe(true);
  await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-testid=block-editor]"))).toBe(true);
  await page.keyboard.press("Shift+F6");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".topbar"))).toBe(true);
});

test("Tabelle: Fokus wählt die erste Zelle, Tab wandert, Leertaste öffnet die Zeile; Menüs mit Pfeilen", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const grid = page.locator(".shell-database.full [role=grid]");
  await expect(grid).toBeVisible();
  await grid.focus();
  const active = grid.locator("[role=gridcell][aria-selected=true]");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("data-cell", /:0$/);
  await page.keyboard.press("Tab");
  await expect(active).toHaveAttribute("data-cell", /:1$/);
  await page.keyboard.press("Shift+Tab");
  await expect(active).toHaveAttribute("data-cell", /:0$/);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("row-peek")).toBeVisible();
  await page.mouse.move(5, 5); // kein Tooltip unter dem Zeiger (nimmt sonst das erste Esc)
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-peek")).toBeHidden();

  // Menü: erster Eintrag hat den Fokus, ↓ wandert, Esc gibt den Fokus an den Knopf zurück.
  const trigger = page.locator(".shell-database.full").getByRole("button", { name: "New page templates" });
  await trigger.click();
  const items = page.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
