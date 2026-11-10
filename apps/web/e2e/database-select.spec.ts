import { expect, test, type Page } from "@playwright/test";

// BSD-213: Zeilen-Mehrfachauswahl in der Tabelle (Kästchen, ⇧-Klick, alle) mit Sammelaktionen.

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Zeilen wählen, Bereich mit ⇧, alle; Duplizieren, Löschen, in Tabs öffnen", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const db = page.locator(".shell-database.full");
  const count = db.getByLabel("Pages in view");
  await expect(count).toHaveText("3");
  const checks = db.locator(".dbui-vrow .dbui-row-check");
  await checks.nth(0).click({ force: true });
  await checks.nth(2).click({ force: true, modifiers: ["Shift"] });
  const bar = db.getByTestId("selection-bar");
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("button", { name: "Duplicate" }).click();
  await expect(count).toHaveText("6");
  await expect(bar).toBeHidden();

  await db.getByLabel("Select all").click({ force: true });
  await expect(bar).toContainText("6 selected");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  await checks.nth(0).click({ force: true });
  await checks.nth(1).click({ force: true });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Delete" }).click();
  await expect(count).toHaveText("4");

  await checks.nth(0).click({ force: true });
  await checks.nth(1).click({ force: true });
  await bar.getByRole("button", { name: "Open in new tabs" }).click();
  await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(3);
});
