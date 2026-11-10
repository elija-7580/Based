import { expect, test, type Page } from "@playwright/test";

// BSD-212: Datenbanken anlegen – verknüpfte Ansicht einer bestehenden Datenbank per Slash, Vorlagen am „New“-Knopf.

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newDatabase(page: Page) {
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const db = page.locator(".shell-database.full");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  return db;
}

test("„/Linked view of database“ zeigt eine Datenbank einer anderen Seite und bleibt aktuell", async ({ page }) => {
  await ready(page);
  const full = await newDatabase(page);
  await expect(full.getByLabel("Pages in view")).toHaveText("3");
  const dbTab = page.url();

  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  const editor = page.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("/linked");
  await page.getByRole("option", { name: /Linked view of database/ }).click();
  const picker = page.getByTestId("database-link-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  const linked = page.locator(".shell-database.inline");
  await expect(linked.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await expect(linked.getByLabel("Pages in view")).toHaveText("3");

  // Neue Zeile in der verknüpften Ansicht landet in der Quelle
  await linked.locator(".dbui-actions").getByRole("button", { name: "New", exact: true }).click();
  await expect(linked.getByLabel("Pages in view")).toHaveText("4");
  await page.keyboard.press("Escape");
  await page.goto(dbTab);
  await expect(page.locator(".shell-database.full").getByLabel("Pages in view")).toHaveText("4");
});

test("Vorlagen: anlegen, als Standard setzen, „New“ nutzt sie, löschen", async ({ page }) => {
  await ready(page);
  const db = await newDatabase(page);
  await db.getByRole("button", { name: "New page templates" }).click();
  await page.getByRole("menuitem", { name: "New template" }).click();
  // Die Vorlage öffnet sich wie eine Zeile (Peek); sie zählt nicht als Zeile der Ansicht.
  await expect(page.getByRole("dialog").or(page.locator("[data-testid='row-peek']")).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(db.getByLabel("Pages in view")).toHaveText("3");

  await db.getByRole("button", { name: "New page templates" }).click();
  await expect(page.getByTestId("template-item")).toHaveText(/New template/);
  await page.getByRole("button", { name: "Template options for New template" }).click();
  await page.getByRole("menuitem", { name: "Set as default" }).click();
  await expect(page.getByTestId("template-item")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await db.locator(".dbui-actions").getByRole("button", { name: "New", exact: true }).click();
  await expect(db.getByLabel("Pages in view")).toHaveText("4");
  await expect(db.getByText("New template").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await db.getByRole("button", { name: "New page templates" }).click();
  await page.getByRole("button", { name: "Template options for New template" }).click();
  await page.getByRole("menuitem", { name: "Delete template" }).click();
  await expect(page.getByTestId("template-item")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Empty page/ })).toHaveAttribute("aria-checked", "true");
});
