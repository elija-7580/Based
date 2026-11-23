// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
const shots = process.env.BASED_SCREENSHOTS === "1";

// Handy (390 × 844, Touch): die Oberfläche läuft später in einer iPhone-Hülle. Geprüft wird, was mit dem Finger
// anders ist als mit der Maus: die schwebende Seitenleiste schließt nach der Wahl, die Einstellungen zeigen erst die
// Liste und dann die Seite, ein Tipp auf den Titel einer Zeile öffnet die Zeile, nichts ragt seitlich hinaus.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const noOverflow = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

test("Handy: Seitenleiste schwebt nur auf Wunsch und schließt nach der Wahl", async ({ page }) => {
  await fresh(page);
  const id = await page.evaluate(() =>
    (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createDatabase", title: "Tasks" }));
  await page.goto(`/#page-${id}`);
  const sidebar = page.getByRole("navigation", { name: "Workspace" });
  await expect(sidebar).toBeHidden();
  await page.getByTestId("sidebar-show").tap();
  await expect(sidebar).toBeVisible();
  // Auch ein Tipp auf die schon offene Seite schließt die Leiste – sonst verdeckt sie am Handy den Inhalt.
  await sidebar.getByRole("treeitem", { name: "Tasks", exact: true }).tap();
  await expect(sidebar).toBeHidden();
  await noOverflow(page);
});

test("Handy: Einstellungen zeigen erst die Liste, dann die Seite mit Weg zurück", async ({ page }, testInfo) => {
  await fresh(page);
  await page.goto("/#appearance");
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(nav).toBeVisible();
  await expect(page.getByTestId("settings-page")).toBeHidden();
  expect((await nav.boundingBox())!.width).toBeGreaterThan(300);
  if (shots && testInfo.project.name === "chromium") await page.screenshot({ path: `${screens}/web-phone-settings-list-light.png` });

  await nav.getByText("Sync & server").tap();
  const settingsPage = page.getByTestId("settings-page");
  await expect(settingsPage).toHaveAttribute("data-page", "sync");
  await expect(nav).toBeHidden();
  expect((await settingsPage.boundingBox())!.width).toBeGreaterThan(280);
  await noOverflow(page);
  if (shots && testInfo.project.name === "chromium") await page.screenshot({ path: `${screens}/web-phone-settings-page-light.png` });

  await page.locator(".settings-back").getByRole("button", { name: "Settings" }).tap();
  await expect(nav).toBeVisible();
  await expect(settingsPage).toBeHidden();
});

test("Handy: Tipp auf den Titel einer Zeile öffnet die Zeile", async ({ page }, testInfo) => {
  await fresh(page);
  test.skip(!(await page.evaluate(() => matchMedia("(hover: none)").matches)), "Browser meldet hier einen Zeiger mit Hover");
  const id = await page.evaluate(() =>
    (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createDatabase", title: "Tasks" }));
  await page.goto(`/#page-${id}`);
  const db = page.locator(".shell-database.full");
  await db.getByRole("row").nth(1).getByRole("gridcell").nth(1).tap();
  await expect(page.getByTestId("row-peek")).toBeVisible();
  await noOverflow(page);
  if (shots && testInfo.project.name === "chromium") await page.screenshot({ path: `${screens}/web-phone-row-light.png` });
});

test("Handy: ein Kopplungs-Link vom Mac füllt Adresse und Token", async ({ page }) => {
  await fresh(page);
  await page.goto("/#prefs-sync");
  const url = page.getByLabel("Server URL");
  await url.fill("based://pair?url=https%3A%2F%2Fmac.example.ts.net%3A8443&token=bdo_abc123");
  await expect(url).toHaveValue("https://mac.example.ts.net:8443");
  await expect(page.getByLabel("Token")).toHaveValue("bdo_abc123");
});
