import { expect, test, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-275 (Mac-Beta): erster Start ohne Konto. Frischer Speicher → Willkommensbildschirm statt Home → „Start empty“
// (Anleitungsseiten unter „Welcome to Based“) bzw. „Import from Notion“ (Import-Dialog). AI bleibt aus, „Turn on
// agents“ führt nur zu Einstellungen → Agents. Andere Specs sehen den Bildschirm nicht (navigator.webdriver); hier
// schaltet `__basedWelcome` ihn ein. Eigenes Profil je Test: WebKit hat OPFS nur in einem dauerhaften Kontext.

const SHOTS = "../../docs/design/screens/";

async function fresh(playwright: Record<"chromium" | "webkit" | "firefox", BrowserType>, browserName: "chromium" | "webkit" | "firefox", baseURL: string, force = true) {
  const dir = mkdtempSync(join(tmpdir(), "based-welcome-"));
  const ctx: BrowserContext = await playwright[browserName].launchPersistentContext(dir, { baseURL, viewport: { width: 1280, height: 820 } });
  if (force) await ctx.addInitScript(() => { (globalThis as { __basedWelcome?: boolean }).__basedWelcome = true; });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { page, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const welcome = (page: Page) => page.getByTestId("welcome");

test("Frischer Speicher → Willkommen → Turn on agents → Start empty → Anleitungsseiten, danach Home", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to Based" })).toBeVisible();
    await expect(page.getByTestId("home")).toHaveCount(0);
    // der erste Weg hat den Fokus (Enter wählt ihn ohne Maus)
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toBeFocused();
    // kein Composer, keine Agenten-Bedienung auf dem ersten Bildschirm
    await expect(page.getByLabel("Tell Based", { exact: true })).toHaveCount(0);

    // Neuladen vor der Wahl: der Bildschirm bleibt
    await page.reload();
    await ready(page);
    await expect(welcome(page)).toBeVisible();

    // AI erst auf Wunsch: führt zu Einstellungen → Agents, Willkommen bleibt offen
    await welcome(page).getByRole("button", { name: "Turn on agents" }).click();
    await expect(page).toHaveURL(/#prefs-agents$/);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(welcome(page)).toBeVisible();

    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    for (const t of ["Basics", "Databases", "Keyboard", "Your data"]) await expect(page.getByTestId("page-content").getByText(t, { exact: true })).toBeVisible();

    // danach die gewohnte Startseite, auch nach dem Neuladen
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await page.reload();
    await ready(page);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

test("Willkommen → Import from Notion öffnet den Import-Dialog mit „Connect Notion directly“", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toBeFocused();
    await page.keyboard.press("Enter"); // ohne Maus
    const dialog = page.getByRole("dialog", { name: "Import" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Connect Notion directly/ })).toBeVisible();
    await dialog.getByRole("button", { name: /Connect Notion directly/ }).click();
    await expect(page.getByRole("dialog", { name: "Import from Notion" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Wahl getroffen: Home statt Willkommen, Anleitungsseiten liegen trotzdem bereit
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});

test("Automatisierter Browser ohne Haken: gewohnte Startseite (bestehende Specs)", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!, false);
  try {
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

test("Checkliste: 900 × 600 ohne waagrechten Rollbalken, beide Wege und „Turn on agents“ ohne Scrollen sichtbar, nichts gekürzt", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/");
    await ready(page);
    await expect(welcome(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of [/Import from Notion/, /Start empty/, /Turn on agents/]) await expect(welcome(page).getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    // Beschriftungen der Wege laufen nicht heraus
    const clipped = await welcome(page).locator(".welcome-choice strong, .welcome-ai strong").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(clipped).toBe(0);
  } finally {
    await close();
  }
});

// Bildschirmfotos (nur mit BASED_SCREENSHOTS=1, Chromium): Willkommen in 1280 × 820, 900 × 600 und 1728 × 1000, hell
// und dunkel; dazu die Willkommensseite mit den Anleitungsseiten in 1280 × 820.
test("Willkommen: Bildschirmfotos", async ({ playwright, browserName, baseURL }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur auf Wunsch");
  test.setTimeout(120_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "system", style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })));
    await page.goto("/");
    await ready(page);
    await expect(welcome(page)).toBeVisible();
    const sizes = [{ w: 1280, h: 820, s: "" }, { w: 900, h: 600, s: "-900" }, { w: 1728, h: 1000, s: "-1728" }];
    const shoot = async (name: string, all = true) => {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const z of all ? sizes : sizes.slice(0, 1)) {
          await page.setViewportSize({ width: z.w, height: z.h });
          await page.waitForTimeout(250);
          // kein waagrechter Rollbalken, nichts läuft heraus
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: `${SHOTS}web-welcome-${name}-${theme}${z.s}.png` });
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 820 });
    };
    await page.mouse.move(0, 0);
    await shoot("start");
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
    await page.getByRole("treeitem", { name: "Welcome to Based" }).getByRole("button", { name: /Expand|Open/ }).first().click().catch(() => undefined);
    await shoot("guides", false);
    await page.getByTestId("page-content").getByText("Keyboard", { exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Keyboard");
    await shoot("guide-keyboard", false);
  } finally {
    await close();
  }
});
