import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// BSD-30 (ADR 0014): Workspace in den Einstellungen auf „Spalten einzeln“ umstellen. Datenbank, Spalten, Zeilen und
// Ansicht bleiben, wie sie waren; danach lassen sich Spalten weiter anlegen, umbenennen und löschen, auch nach Neuladen.

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}
const status = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __based: { client: { getState(): { status: { propertyRecords?: boolean } } } } }).__based.client.getState().status.propertyRecords === true);
const headers = async (page: Page) =>
  (await page.locator(".shell-database.full").getByRole("columnheader").allTextContents()).map((t) => t.trim()).filter(Boolean);

test("Umstellen in Sync & server: Datenbank bleibt gleich, Spalten weiter bearbeitbar, übersteht Neuladen", async ({ playwright, browserName, baseURL }) => {
  // eigener Profilordner: nur so speichert WebKit unter Playwright dauerhaft (wie phase2.spec.ts)
  const dir = mkdtempSync(join(tmpdir(), "based-props-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    await run(ctx.pages()[0] ?? (await ctx.newPage()));
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function run(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const db = page.locator(".shell-database.full");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-date").click();
  await page.keyboard.press("Escape");
  const dbURL = page.url();
  const before = await headers(page);
  expect(before.length).toBeGreaterThanOrEqual(2);
  const rows = await db.getByRole("row").count();
  expect(await status(page)).toBe(false);

  // Einstellungen → Sync & server → Convert…
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByRole("button", { name: "Convert…" }).click();
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Convert and reload" }).click()]);
  await ready(page);
  await expect.poll(() => status(page)).toBe(true);

  // dieselbe Datenbank: Spalten in derselben Reihenfolge, dieselben Zeilen
  await page.goto(dbURL);
  await ready(page);
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  expect(await headers(page)).toEqual(before);
  expect(await db.getByRole("row").count()).toBe(rows);

  // weitere Spalte anlegen; nach Neuladen noch da, Zustand bleibt „umgestellt“
  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-number").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await headers(page)).length).toBe(before.length + 1);
  const after = await headers(page);
  await page.reload();
  await ready(page);
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  expect(await headers(page)).toEqual(after);
  expect(await status(page)).toBe(true);

  // in den Einstellungen steht der neue Zustand, der Knopf ist weg
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await expect(page.getByTestId("property-records-status")).toHaveText("Synced one by one");
  await expect(page.getByRole("button", { name: "Convert…" })).toHaveCount(0);
}
