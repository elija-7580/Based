import { expect, test, type Page } from "@playwright/test";

// AI-Schalter (shell/ai.ts, entschieden 12.11.2026): Standard aus. Ohne AI keine Chat-, Agenten- und Coding-Flächen,
// Home ist eine Seite; Skills, Memories und MCP bleiben. Die übrigen Specs laufen mit BASED_AI_DEFAULT=on
// (playwright.config.ts); hier wird „aus“ ausdrücklich gesetzt, solange der Test es nicht selbst umschaltet.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("based.ai") === null) localStorage.setItem("based.ai", "false");
  });
});

async function ready(page: Page, hash = "") {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Workspace" });
const topNames = async (page: Page) => (await nav(page).locator(":scope > .nav-item").allInnerTexts()).map((t) => t.split("\n")[0]!.trim());

test("ohne AI: kein Chat, keine Agenten, Home ist eine Seite", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  // Home legt einmal eine Seite „Home“ an und zeigt sie
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  await expect(page.getByTestId("topbar-ai")).toHaveCount(0);
  expect(await topNames(page)).toEqual(["Search", "Home"]);

  // Neuladen: dieselbe Seite, keine zweite
  const url = page.url();
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  expect(page.url()).toBe(url);

  // ⌘K kennt Chat, Tasks, Coding und Dashboard nicht
  for (const q of ["chat", "tasks", "coding", "dashboard"]) {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByLabel("Search pages").fill(q);
    await expect(page.getByTestId("qf-command")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  // Alte AI-Links führen nach Home
  await page.goto("/#chat");
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
});

test("Einstellungen: Schalter unter Agents & AI; ohne AI nur Skills und Memories, keine Connections", async ({ page }) => {
  await ready(page, "#prefs-agents");
  const settingsNav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(settingsNav.getByRole("button", { name: "Connections", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("settings-section-ai-switch")).toBeVisible();
  await expect(page.getByTestId("settings-section-brain-skills")).toBeVisible();
  await expect(page.getByTestId("settings-section-brain-memories")).toBeVisible();
  await expect(page.getByTestId("settings-section-ai-providers")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-main-agent")).toHaveCount(0);
  await expect(page.getByTestId("settings-missing")).toHaveCount(0);

  // Einschalten: Modelle, Connections und Chat erscheinen; bleibt nach Neuladen
  await page.getByTestId("settings-section-ai-switch").getByRole("switch").click();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();
  await expect(settingsNav.getByRole("button", { name: "Connections", exact: true })).toBeVisible();
  expect(await topNames(page)).toEqual(["Search", "Home", "Chat"]);
  await page.reload();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();

  // Wieder aus
  await page.getByTestId("settings-section-ai-switch").getByRole("switch").click();
  await expect(page.getByTestId("settings-section-ai-providers")).toHaveCount(0);
  expect(await topNames(page)).toEqual(["Search", "Home"]);
});

// Checkliste (docs/quality/checklist.md): Home als Seite und Einstellungen → Agents & AI ohne AI, drei Größen, hell/dunkel
for (const theme of ["light", "dark"] as const) {
  test(`Screenshots ohne AI (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/#home");
      await expect(page.getByLabel("Page title")).toHaveValue("Home");
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-ai-off-home-${w}x${h}-${theme}.png` });
      await page.goto("/#prefs-agents");
      await expect(page.getByTestId("settings-section-ai-switch")).toBeVisible();
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-ai-off-settings-${w}x${h}-${theme}.png` });
    }
  });
}
