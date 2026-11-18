import { expect, test, type Page } from "@playwright/test";

// Elija 18.11.: Einstellungen in drei Gruppen, Schrift getrennt vom Stil, Suchfeld über der Seitenliste
// (bewusst nicht in ⌘K). Bildschirmfotos mit BASED_SCREENSHOTS=1 (Chromium) nach docs/design/screens/.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

async function open(page: Page, hash = "prefs-appearance") {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/#" + hash);
  await page.reload();
  await expect(page.getByTestId("settings-page")).toBeVisible();
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Settings pages" });
const search = (page: Page) => page.getByRole("searchbox", { name: "Search settings" });
const results = (page: Page) => page.getByTestId("settings-results").getByRole("button");

test("Font schaltet die Schrift der App, Style nur Größe und Gewicht – und beides wieder zurück", async ({ page }) => {
  await open(page);
  const html = page.locator("html");
  const h1 = () => page.locator("[data-testid=settings-page] h1").evaluate((el) => getComputedStyle(el).fontFamily);
  const system = await h1();
  expect(system).not.toContain("Schibsted");

  await page.getByRole("radio", { name: "Bold" }).click();
  await expect(html).toHaveAttribute("data-style", "bold");
  await expect(html).not.toHaveAttribute("data-typeface", /.*/);
  expect(await h1()).toBe(system);

  await page.getByRole("radio", { name: "Based", exact: true }).click();
  await expect(html).toHaveAttribute("data-typeface", "based");
  await expect.poll(h1).toContain("Schibsted Grotesk");
  await expect.poll(() => page.evaluate(() => document.fonts.check('600 20px "Schibsted Grotesk"'))).toBe(true);
  await page.reload();
  await expect(html).toHaveAttribute("data-typeface", "based");

  await page.getByRole("radiogroup", { name: "Font" }).getByRole("radio", { name: "System" }).click();
  await expect(html).not.toHaveAttribute("data-typeface", /.*/);
  // überall wieder die Systemschrift: kein Element behält die andere
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => /Schibsted|Literata/.test(getComputedStyle(el).fontFamily)).length)).toBe(0);
});

test("alter Stand „Bold“ ohne Schrift-Wahl behält seine Schrift; alter Link #prefs-my-settings öffnet Appearance", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", style: "bold" })));
  await page.goto("/#prefs-my-settings");
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "appearance");
  await expect(page.locator("html")).toHaveAttribute("data-typeface", "based");
  await expect(page.getByRole("radio", { name: "Based", exact: true })).toBeChecked();
});

test("Suche: findet einzelne Einstellungen, verzeiht Tippfehler, Tastatur öffnet den Treffer und rollt zum Abschnitt", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await open(page);
  await search(page).fill("spell");
  await expect(results(page).first()).toContainText("Spell-check");
  await expect(results(page).first()).toContainText("Pages · New pages");
  // die Seitenliste weicht den Treffern, der Inhalt rechts bleibt stehen
  await expect(nav(page).getByRole("button", { name: "Sync & server" })).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "appearance");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "editor");
  await expect(search(page)).toHaveValue("");
  await expect(nav(page).getByRole("button", { name: "Sync & server" })).toBeVisible();
  await expect(page.getByTestId("settings-section-writing")).toBeFocused();

  // Tippfehler und mehrere Wörter
  await search(page).fill("apearance");
  await expect(results(page).first()).toContainText("Appearance");
  await search(page).fill("dark");
  await expect(results(page).first()).toContainText("Dark mode");
  await search(page).fill("backup folder");
  await expect(results(page).first()).toContainText("Sync & server");

  // ↓ wandert, Enter öffnet den gewählten Treffer; Abschnitt weiter unten wird in den Blick gerollt
  await search(page).fill("report");
  const second = results(page).nth(1);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("settings-results").getByRole("listitem").nth(1)).toHaveAttribute("aria-current", "true");
  const label = (await second.textContent()) ?? "";
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "diagnostics");
  expect(label).toContain("Diagnostics");
  const focused = page.locator(".settings-section:focus");
  await expect(focused).toBeInViewport();

  // nichts gefunden; Escape leert und bleibt in den Einstellungen
  await search(page).fill("qqqq");
  await expect(page.getByTestId("settings-no-results")).toHaveText("No settings match “qqqq”.");
  await page.keyboard.press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "Appearance", exact: true })).toBeVisible();
});

// Dass AI-Abschnitte ohne AI und Beta-ausgeblendete Seiten nicht gefunden werden, prüfen shell/settings.test.ts und
// beta-build.spec.ts.
test("⌘K findet keine Einstellungen", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+KeyK");
  const quick = page.getByRole("combobox", { name: "Search pages" });
  await expect(quick).toBeVisible();
  await quick.fill("Spell-check");
  await page.waitForTimeout(400);
  await expect(page.getByRole("dialog").getByText("Pages · New pages")).toHaveCount(0);
});

test("eine Seite mit nur einem gleichnamigen Abschnitt nennt ihren Namen einmal", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("settings-page").getByRole("heading", { name: "Appearance" })).toHaveCount(1);
  await page.goto("/#prefs-editor");
  await expect(page.getByTestId("settings-page").getByRole("heading", { level: 2 })).toHaveText(["Home", "New pages"]);
});

for (const theme of ["light", "dark"] as const) {
  test(`Bildschirmfotos: Suche in den Einstellungen (${theme})`, async ({ page, browserName }) => {
    test.skip(!SHOTS || browserName !== "chromium", "nur mit BASED_SCREENSHOTS=1 auf Chromium");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/#prefs-appearance");
      await expect(page.getByTestId("settings-page")).toBeVisible();
      await search(page).fill("font");
      await expect(results(page).first()).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-settings-search-${w}x${h}-${theme}.png` });
    }
  });
}
