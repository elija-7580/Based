// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
const shots = process.env.BASED_SCREENSHOTS === "1";

// Relationen zwischen zwei Datenbanken auf verschiedenen Seiten. Die Datenbank-Ansicht arbeitet auf der Replik der
// offenen Seite; die Ziel-Datenbank lag dort nicht, deshalb blieb die Zelle leer und „Related database“ bot nur die
// eigene Datenbank an. Geprüft: Ziel wählen, Zeile verknüpfen, Anzeige in Tabelle und Zeilenseite, nach dem Neuladen,
// Rollup über die Relation. Fotos (hell/dunkel, 1280 × 820) mit BASED_SCREENSHOTS=1 in Chromium.

async function twoDatabases(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  return page.evaluate(async () => {
    const c = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client;
    const projects = await c.command({ op: "createDatabase", title: "Projects" });
    const tasks = await c.command({ op: "createDatabase", title: "Tasks" });
    return { projects, tasks };
  });
}

async function nameRow(page: Page, index: number, name: string) {
  const db = page.locator(".shell-database.full");
  const cell = db.getByRole("row").nth(index + 1).getByRole("gridcell").nth(1);
  await cell.dblclick();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(db.getByRole("row").nth(index + 1)).toContainText(name);
}

test("Relation zu einer anderen Datenbank: Ziel wählen, verknüpfen, sichtbar auch nach dem Neuladen", async ({ page }, testInfo) => {
  const ids = await twoDatabases(page);
  const db = page.locator(".shell-database.full");

  await page.goto(`/#page-${ids.projects}`);
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await nameRow(page, 0, "Moving house");
  await nameRow(page, 1, "Website relaunch");

  await page.goto(`/#page-${ids.tasks}`);
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await nameRow(page, 0, "Book the van");

  // Neue Relation: die Einstellungen kommen gleich nach dem Anlegen, mit allen Datenbanken des Workspaces
  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-relation").click();
  const target = page.getByLabel("Related database");
  await expect(target).toBeVisible();
  await expect(target.locator("option", { hasText: "Projects" })).toHaveCount(1);
  await target.selectOption({ label: "Projects" });
  await expect(target).toHaveValue(/.+/);
  // das Menü bleibt im Fenster
  const box = (await page.locator(".dbui-property-menu").boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  if (shots && testInfo.project.name === "chromium") {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.screenshot({ path: `${screens}/web-database-relation-setup-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: `${screens}/web-database-relation-setup-dark.png` });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.keyboard.press("Escape");
  await expect(db.getByRole("columnheader", { name: "Relation" })).toBeVisible();

  // Zeile verknüpfen
  const cell = db.getByRole("row").filter({ hasText: "Book the van" }).getByRole("gridcell").last();
  await cell.click();
  const pages = page.getByRole("listbox", { name: "Pages" });
  await expect(pages.getByRole("option")).toHaveText(["Moving house", "Website relaunch", "Untitled"]);
  await pages.getByRole("option", { name: "Moving house" }).click();
  await page.keyboard.press("Escape");
  await expect(cell.locator(".dbui-relation")).toHaveText("Moving house");

  // Rollup über die Relation: Einstellungen kommen ebenfalls gleich, das Ergebnis liest die Zielzeile
  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-rollup").click();
  await expect(page.getByLabel("Rollup relation")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.keyboard.press("Escape");
  await expect(db.getByRole("row").filter({ hasText: "Book the van" }).getByRole("gridcell").last()).toContainText("Moving house");
  const relCell = db.getByRole("row").filter({ hasText: "Book the van" }).getByRole("gridcell").nth(-2);
  await expect(relCell.locator(".dbui-relation")).toHaveText("Moving house");
  if (shots && testInfo.project.name === "chromium") await page.screenshot({ path: `${screens}/web-database-relation-light.png` });

  // nach dem Neuladen steht sie noch da
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const after = db.getByRole("row").filter({ hasText: "Book the van" }).getByRole("gridcell").nth(-2);
  await expect(after.locator(".dbui-relation")).toHaveText("Moving house");

  // Gegenrichtung („Show on Projects“): die Projekte zeigen ihre Aufgaben
  await db.getByRole("columnheader", { name: "Relation" }).getByRole("button").first().click();
  await page.getByTestId("property-edit").click();
  await page.getByRole("button", { name: "Show on Projects" }).click();
  await expect(page.getByText(/Shown on Projects as/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/#page-${ids.projects}`);
  await expect(db.getByRole("row").filter({ hasText: "Moving house" }).locator(".dbui-relation")).toHaveText("Book the van");
  await page.goto(`/#page-${ids.tasks}`);

  // Klick auf die Verknüpfung öffnet die Zielzeile
  await db.getByRole("row").filter({ hasText: "Book the van" }).locator(".dbui-relation").click();
  await expect(page.getByLabel("Page title").last()).toHaveValue("Moving house");
});
