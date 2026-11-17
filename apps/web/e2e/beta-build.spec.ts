import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overflows, overlaps } from "./layout-checks.js";

// BSD-305 Teil 5 (Beta-Umfang): Durchgang im echten Beta-Build. Läuft nur, wenn der Build mit BASED_CHANNEL=beta
// entsteht – Playwright baut den Server mit der Umgebung des Aufrufs:
//   BASED_CHANNEL=beta BASED_E2E_PORT=4179 CI=1 pnpm --filter @based/web exec playwright test e2e/beta-build.spec.ts
// (eigener Port, damit kein Dev-Server wiederverwendet wird). Sonst übersprungen (run-ts, CI). Prüft, was Tester auf
// beta sehen: erster Start (Willkommen mit Vorlagen, ohne AI), Home = Willkommensseite (BSD-461), Seitenkopf ohne Share
// (BSD-460), Einstellungen ohne „Not yet“- und AI-Seiten, My settings ohne Agenten-Begriffe (BSD-459), Slash-Menü
// ohne Meeting und Ask AI; jeweils ohne Überlauf und sich überdeckenden Text, Fotos 1280 × 820 hell/dunkel.

const BETA = process.env.BASED_CHANNEL === "beta";
const SHOTS = "../../docs/design/screens/";

test.skip(!BETA, "nur mit BASED_CHANNEL=beta (Beta-Build)");

async function fresh(playwright: Parameters<Parameters<typeof test>[2]>[0]["playwright"], browserName: "chromium" | "webkit" | "firefox", baseURL: string, theme: "light" | "dark") {
  const dir = mkdtempSync(join(tmpdir(), "based-beta-"));
  const ctx: BrowserContext = await playwright[browserName].launchPersistentContext(dir, { baseURL, viewport: { width: 1280, height: 820 } });
  await ctx.addInitScript((t) => {
    (globalThis as { __basedWelcome?: boolean }).__basedWelcome = true;
    localStorage.setItem("based.appearance", JSON.stringify({ theme: t }));
  }, theme);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { page, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function clean(page: Page, where: string) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  expect(await overflows(page), where).toEqual([]);
  expect(await overlaps(page), where).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`Beta-Build: erster Start, Seite, Einstellungen, Slash-Menü (${theme})`, async ({ playwright, browserName, baseURL }) => {
    test.setTimeout(120_000);
    const shoot = async (page: Page, name: string) => { if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}beta-${name}-${theme}.png` }); };
    const { page, close } = await fresh(playwright, browserName, baseURL!, theme);
    try {
      await page.goto("/");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const welcome = page.getByTestId("welcome");
      await expect(welcome).toBeVisible();
      await expect(welcome.getByRole("group", { name: "Or start from a template" }).getByRole("button")).toHaveText(["Tasks", "Notes", "Journal", "Wiki"]);
      await expect(welcome.getByText("AI stays off")).toHaveCount(0);
      await clean(page, "Willkommen");
      await shoot(page, "welcome");

      // Start empty → Home ist die Willkommensseite, keine Seite „Home“, kein Share, kein AI-Knopf
      await welcome.getByRole("button", { name: /Start empty/ }).click();
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
      await expect(page.getByTestId("topbar-ai")).toHaveCount(0);
      await clean(page, "Willkommensseite");
      await shoot(page, "home-page");
      // die Anleitung „Your data“ verspricht keinen AI-Schalter, den es auf beta nicht gibt
      await page.getByTestId("page-content").getByText("Your data", { exact: true }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Your data");
      await expect(page.getByTestId("block-editor")).not.toContainText(/\bAI\b|agent/i);
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");

      // Slash-Menü: weder Meeting notes noch Ask AI
      await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
      await page.keyboard.type("/");
      const menu = page.getByTestId("slash-menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByText("Meeting notes")).toHaveCount(0);
      await expect(menu.getByText("Ask AI")).toHaveCount(0);
      await shoot(page, "slash-menu");
      await page.keyboard.press("Escape");

      // Einstellungen: keine „Not yet“-Seiten, keine AI-Seiten; My settings ohne Agenten-Begriffe
      await page.goto("/#prefs-my-settings");
      const nav = page.getByRole("navigation", { name: "Settings pages" });
      await expect(nav).toBeVisible();
      await expect(nav.getByText("Not yet")).toHaveCount(0);
      for (const hidden of ["My connections", "People", "Teamspaces", "Security", "Agents & AI", "Connections", "My notifications"]) await expect(nav.getByRole("button", { name: hidden, exact: true })).toHaveCount(0);
      const settings = page.getByTestId("settings-page");
      await expect(settings).not.toContainText(/agent|marker|calm mode/i);
      await expect(page.getByTestId("settings-section-start-page")).toContainText("Welcome to Based");
      await clean(page, "My settings");
      await shoot(page, "settings");

      // Library ohne Graph und Meetings; ⌘N ohne Meeting und AI-Chat, mit den Vorlagen
      await page.goto("/#library");
      await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText("Graph", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Meetings", { exact: true })).toHaveCount(0);
      await clean(page, "Library");
      await shoot(page, "library");
      await page.keyboard.press("ControlOrMeta+n");
      const palette = page.getByTestId("new-palette");
      await expect(palette.getByRole("option")).toHaveText([/New page/, /New database/, /Import/, /Tasks template/, /Notes template/, /Journal template/, /Wiki template/]);
      await page.keyboard.type("tasks");
      await page.keyboard.press("Enter");
      await expect(page.locator(".shell-database.full")).toBeVisible();
      await clean(page, "Vorlage Tasks");
      await shoot(page, "template-tasks");
    } finally {
      await close();
    }
  });
}
