// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// Elijá 25.11.2026: „Zurück“ aus den Einstellungen öffnete scheinbar zufällige Seiten (jede angeklickte
// Einstellungs-Seite war ein eigener Schritt), und die Seitenliste links wuchs mit jeder besuchten Unterseite (der
// aufgeklappte Weg dorthin wurde gemerkt). Jetzt: Einstellungen sind ein Halt im Verlauf, mit „Back“ und Escape;
// die Seitenleiste klappt den Weg nur für die offene Seite auf. Screenshots nur mit BASED_SCREENSHOTS=1 in Chromium.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";
type Cmd = { op: "createPage"; title: string; parent?: string };
const create = (page: Page, c: Cmd) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command(cmd), c);

async function start(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings pages" });

test("Einstellungen: Zurück, „Back“ und Escape führen zur Seite davor – egal, wie viele Einstellungs-Seiten offen waren", async ({ page, browserName }) => {
  await start(page);
  const id = await create(page, { op: "createPage", title: "Where I was" });
  await page.goto(`/#page-${id}`);
  await expect(page.getByLabel("Page title")).toHaveValue("Where I was");

  const visit = async () => {
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "appearance");
    for (const [name, pageID] of [["Sync & server", "sync"], ["Import", "import"], ["About", "about"]] as const) {
      await settingsNav(page).getByText(name, { exact: true }).click();
      await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", pageID);
    }
    await expect(page).toHaveURL(/#prefs-about/);
  };

  await visit();
  if (SHOTS && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(settingsNav(page).getByRole("button", { name: "Back" })).toBeVisible();
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `../../docs/design/screens/web-settings-back-${theme}-${w}x${h}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }
  await settingsNav(page).getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Where I was");

  await visit();
  await page.locator("body").click({ position: { x: 800, y: 700 } }); // Fokus aus der Liste
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Page title")).toHaveValue("Where I was");

  // der Zurück-Knopf der Seite: einmal vor (Einstellungen), einmal zurück – nicht durch drei Einstellungs-Seiten
  await visit();
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.getByLabel("Page title")).toHaveValue("Where I was");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "about");
});

test("Einstellungen: Escape im Suchfeld leert erst die Suche und verlässt dann die Einstellungen", async ({ page }) => {
  await start(page);
  const id = await create(page, { op: "createPage", title: "Before search" });
  await page.goto(`/#page-${id}`);
  await expect(page.getByLabel("Page title")).toHaveValue("Before search");
  await page.keyboard.press("ControlOrMeta+Comma");
  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("theme");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Page title")).toHaveValue("Before search");
});

test("Seitenleiste: der Weg zur offenen Seite klappt nur für sie auf; von Hand Aufgeklapptes bleibt", async ({ page, browserName }) => {
  await start(page);
  const parent = await create(page, { op: "createPage", title: "Projects" });
  const child = await create(page, { op: "createPage", title: "Kitchen plan", parent });
  await create(page, { op: "createPage", title: "Garden plan", parent });
  const other = await create(page, { op: "createPage", title: "Reading list" });
  const row = (name: string) => page.getByRole("treeitem", { name, exact: true });

  await expect(row("Projects")).toBeVisible();
  await expect(row("Kitchen plan")).toHaveCount(0);

  // Unterseite öffnen (Link, Suche, Zurück …): ihr Weg ist aufgeklappt
  await page.goto(`/#page-${child}`);
  await expect(page.getByLabel("Page title")).toHaveValue("Kitchen plan");
  await expect(row("Kitchen plan")).toBeVisible();
  await expect(row("Garden plan")).toBeVisible();

  // weiter zu einer anderen Seite: wieder zu, auch nach Neuladen
  await row("Reading list").click();
  await expect(page.getByLabel("Page title")).toHaveValue("Reading list");
  await expect(row("Kitchen plan")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("Reading list");
  await expect(row("Projects")).toBeVisible();
  await expect(row("Kitchen plan")).toHaveCount(0);

  // für die offene Seite zugeklappt bleibt zu
  await page.goto(`/#page-${child}`);
  await expect(row("Kitchen plan")).toBeVisible();
  await row("Projects").hover();
  await row("Projects").getByRole("button", { name: "Collapse" }).click();
  await expect(row("Kitchen plan")).toHaveCount(0);

  // von Hand aufgeklappt bleibt offen, auch wenn man weitergeht und neu lädt
  await row("Projects").hover();
  await row("Projects").getByRole("button", { name: "Expand" }).click();
  await expect(row("Kitchen plan")).toBeVisible();
  await page.goto(`/#page-${other}`);
  await expect(page.getByLabel("Page title")).toHaveValue("Reading list");
  await expect(row("Kitchen plan")).toBeVisible();
  await page.reload();
  await expect(row("Kitchen plan")).toBeVisible();

  if (SHOTS && browserName === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-sidebar-open-path-light.png" });
});
