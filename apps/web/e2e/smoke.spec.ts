import { expect, test } from "@playwright/test";

// BSD-178: Shell lädt, Navigation, und die Darstellungs-Umschalter setzen die Wurzel-Attribute (persistiert).
// BSD-153: auf echten Daten – Erststart mit Willkommensseite statt Demo-Seite.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
});

test("Shell mit Seitenleiste und Home", async ({ page }) => {
  await expect(page.getByTestId("based-root")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Elija");
  await expect(page.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toBeVisible();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  await expect(page.getByTestId("page-content")).toContainText("This is your workspace");
  await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveAttribute("aria-selected", "true");
});

test("Composer-Picker öffnen ein Menü und übernehmen die Wahl", async ({ page }) => {
  await page.getByRole("button", { name: /Compute: Auto/ }).click();
  await page.getByRole("option", { name: /Deep/ }).click();
  await expect(page.getByRole("button", { name: /Compute: Deep/ })).toBeVisible();
});

test("Theme-, Stil- und Calm-Umschalter ändern die Wurzel-Attribute", async ({ page }) => {
  const html = page.locator("html");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Bold" }).click();
  await expect(html).toHaveAttribute("data-style", "bold");
  await page.getByRole("radio", { name: "Mint" }).click();
  await expect(html).toHaveAttribute("data-marker", "mint");
  await page.getByRole("radio", { name: "Compact" }).click();
  await expect(html).toHaveAttribute("data-density", "compact");
  await page.getByRole("switch", { name: "Calm mode" }).click();
  await expect(html).toHaveAttribute("data-calm", "");

  // bleibt nach dem Neuladen
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-calm", "");

  await page.getByRole("radio", { name: "Default" }).click();
  await expect(html).not.toHaveAttribute("data-style", /.*/);
  await page.getByRole("switch", { name: "Calm mode" }).click();
  await expect(html).not.toHaveAttribute("data-calm", /.*/);
});

test("Show agent details blendet Planer und Laufzeit auf Home ein", async ({ page }) => {
  await expect(page.getByText(/^planner /)).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Show agent details" }).click();
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByText(/^planner auto · /)).toBeVisible();
});
