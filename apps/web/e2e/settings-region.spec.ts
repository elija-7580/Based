import { expect, test, type Page } from "@playwright/test";

// BSD-205: Einstellungen – Wochenbeginn (Language & region) wirkt im Kalender; Workspace-Name änderbar.

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Wochenbeginn: Sonntag bzw. Montag als erste Kalenderspalte, bleibt nach dem Neuladen", async ({ page, browserName }) => {
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const db = page.locator(".shell-database.full");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await db.getByRole("button", { name: "Add property" }).click();
  await page.getByTestId("type-date").click();
  await page.keyboard.press("Escape");
  await db.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("radio", { name: /Calendar/ }).click();
  await page.keyboard.press("Escape");
  const first = db.locator(".dbui-cal-weekdays > span").first();
  await expect(first).toBeVisible();
  const dbURL = page.url();

  for (const [label, short] of [["Sunday", "Sun"], ["Monday", "Mon"]] as const) {
    await page.goto("/#prefs-language");
    await page.getByLabel("Start week on").first().click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.goto(dbURL);
    await expect(first).toHaveText(new RegExp("^" + short));
  }
  // Neuladen nur in Chromium: WebKit-Testprofile haben kein OPFS (die Datenbank wäre weg, die Einstellung nicht).
  if (browserName !== "chromium") return;
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.locator(".shell-database.full .dbui-cal-weekdays > span").first()).toHaveText(/^Mon/);
});

test("Workspace-Name in Einstellungen → General", async ({ page }) => {
  await ready(page);
  await page.goto("/#prefs-workspace");
  const field = page.getByTestId("workspace-name").getByRole("textbox");
  await field.fill("Acme Notes");
  await field.press("Enter");
  // Weg und zurück (WebKit-Testprofile haben kein OPFS, ein Neuladen verlöre dort alles).
  await page.goto("/#home");
  await page.goto("/#prefs-workspace");
  await expect(page.getByTestId("workspace-name").getByRole("textbox")).toHaveValue("Acme Notes");
});
