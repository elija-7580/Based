import { expect, test, type Page } from "@playwright/test";

// BSD-270: Kürzel erscheinen erst beim langen Halten von ⌘ (Strg) – an den Stellen, die sie auslösen (Seitenleiste,
// Tabs). Kurze Kombinationen lassen nichts aufblitzen; Loslassen blendet aus. Screenshots (Mac-Beschriftung) hell/dunkel.

async function ready(page: Page, mac = false) {
  if (mac) await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}
const shown = (page: Page) => page.evaluate(() => document.documentElement.hasAttribute("data-show-keys"));

test("⌘/Strg halten zeigt Plaketten, Loslassen blendet aus; ⌘/Strg+Taste lässt nichts aufblitzen", async ({ page }) => {
  await ready(page);
  // wie die App (shell/keyHints.ts): Playwright-WebKit meldet sich als Mac (User-Agent) → ⌘
  const apple = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent));
  const mod = apple ? "Meta" : "Control";
  const searchKey = page.getByRole("navigation", { name: "Workspace" }).locator(".nav-item .key").first();
  await expect(searchKey).toBeHidden();
  await page.keyboard.down(mod);
  await expect.poll(() => shown(page), { timeout: 3000 }).toBe(true);
  await expect(searchKey).toBeVisible();
  await expect(searchKey).toHaveText(apple ? "⌘K" : "Ctrl+K");
  await expect(page.locator(".sidebar-footer .key-badge")).toHaveText([apple ? "⌘," : "Ctrl+,"]);
  await page.keyboard.up(mod);
  await expect.poll(() => shown(page)).toBe(false);
  await expect(searchKey).toBeHidden();

  // schnelle Kombination: Quick Find öffnet, keine Plaketten
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
  await page.waitForTimeout(700);
  expect(await shown(page)).toBe(false);
});

for (const theme of ["light", "dark"] as const) {
  test(`Screenshot Kürzel-Plaketten (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await ready(page, true);
    await page.keyboard.press("ControlOrMeta+t"); // zweiter Tab, damit die Tab-Plaketten zu sehen sind
    await page.keyboard.down("Meta");
    await expect.poll(() => shown(page), { timeout: 3000 }).toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `../../docs/design/screens/web-key-hints-${theme}.png` });
    await page.keyboard.up("Meta");
  });
}
