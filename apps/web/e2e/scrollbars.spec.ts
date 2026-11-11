import { expect, test } from "@playwright/test";

// BSD-261: Rollbalken im Based-Design – in Chromium und WebKit über ::-webkit-scrollbar (schmal, rund, ohne Spur und
// Eckkasten). Die Standard-Eigenschaften scrollbar-width/-color dürfen dort nicht greifen, sonst zeichnet der Browser
// den Systembalken mit heller Spur. Screenshots (hell/dunkel) nur mit BASED_SCREENSHOTS=1 in Chromium.

test("Rollbalken: Standard-Eigenschaften nur ohne ::-webkit-scrollbar; Bildschirmfotos hell/dunkel", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1100, height: 520 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const width = await page.evaluate(() => getComputedStyle(document.querySelector(".panel")!).scrollbarWidth);
  expect(width).toBe("auto");
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    await page.getByRole("button", { name: "Home" }).click();
    await page.getByRole("button", { name: "New page" }).first().click();
    const editor = page.locator(".bn-editor[contenteditable='true']").first();
    await editor.click();
    for (let i = 0; i < 30; i++) await page.keyboard.press("Enter");
    await page.keyboard.type("/database");
    await page.getByRole("option", { name: /Database – Inline/ }).click();
    await page.locator(".shell-database.inline").hover();
    for (const theme of ["light", "dark"] as const) {
      // Über den Umschalter der App (⇧⌘L), damit auch das Astryx-Theme mitgeht.
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.keyboard.press("ControlOrMeta+Shift+l");
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-scrollbars-${theme}.png` });
    }
  }
});
