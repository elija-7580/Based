import { expect, test, type Page } from "@playwright/test";

// BSD-261: Rollbalken im Based-Design – in Chromium und WebKit über ::-webkit-scrollbar (schmal, rund, ohne Spur und
// Eckkasten). Die Standard-Eigenschaften scrollbar-width/-color dürfen dort nicht greifen, sonst zeichnet der Browser
// den Systembalken mit heller Spur. Entscheidung Elija 12.11. (Variante B): eigene Balken auch am Mac; WebKit zeichnet
// sie als feste Spalte, deshalb schmal – Spalte 8 px (--space-2), Daumen 4 px.
//
// Playwright startet Chromium sonst mit --hide-scrollbars; ohne diesen Schalter sind die Balken echt, messbar und auf
// den Bildschirmfotos zu sehen (WebKit zeichnet sie ohnehin). Bildschirmfotos nur mit BASED_SCREENSHOTS=1.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Breite der Balkenspalte an einem frisch eingehängten Rollbereich (optional mit Inline-Stil wie bei Astryx). */
const gutter = (page: Page, style = "") =>
  page.evaluate((extra) => {
    const el = document.createElement("div");
    el.setAttribute("style", `overflow: scroll; width: 200px; height: 120px; ${extra}`);
    el.innerHTML = `<div style="width: 600px; height: 600px"></div>`;
    document.body.append(el);
    const r = { v: el.offsetWidth - el.clientWidth, h: el.offsetHeight - el.clientHeight, color: getComputedStyle(el).scrollbarColor };
    el.remove();
    return r;
  }, style);

async function openLongPageWithInlineDatabase(page: Page) {
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await editor.click();
  for (let i = 0; i < 40; i++) await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: /Database – Inline/ }).click();
  await expect(page.locator(".shell-database.inline")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
});

test("Rollbalken: Standard-Eigenschaften nur ohne ::-webkit-scrollbar", async ({ page }) => {
  const width = await page.evaluate(() => getComputedStyle(document.querySelector(".panel")!).scrollbarWidth);
  expect(width).toBe("auto");
});

test("Rollbalken: schmale feste Spalte (8 px) in Chromium und WebKit, ohne Eckkasten", async ({ page }) => {
  const g = await gutter(page);
  expect(g.v).toBe(8);
  expect(g.h).toBe(8);
});

test("Rollbalken: scrollbar-color von Astryx (ScrollableArea) schaltet den Based-Balken nicht ab", async ({ page }) => {
  const g = await gutter(page, "scrollbar-color: red transparent;");
  expect(g.color).toBe("auto");
  expect(g.v).toBe(8);
});

test("Rollbalken: Seite mit Inline-Tabelle rollt, Balken sichtbar; Bildschirmfotos hell/dunkel in drei Größen", async ({ page, browserName }) => {
  await openLongPageWithInlineDatabase(page);
  const scroller = await page.evaluate(() => {
    const el = document.querySelector(".shell-database.inline")!;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return { bar: p.offsetWidth - p.clientWidth };
    }
    return null;
  });
  expect(scroller).not.toBeNull();
  expect(scroller!.bar).toBe(8);
  if (process.env.BASED_SCREENSHOTS !== "1") return;
  const prefix = browserName === "webkit" ? "web-scrollbars-webkit" : "web-scrollbars";
  const sizes = [
    { width: 1280, height: 820, suffix: "" },
    { width: 900, height: 600, suffix: "-900" },
    { width: 1728, height: 1000, suffix: "-1728" },
  ];
  for (const theme of ["light", "dark"] as const) {
    // Über den Umschalter der App (⇧⌘L), damit auch das Astryx-Theme mitgeht.
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    for (const s of sizes) {
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.locator(".shell-database.inline").scrollIntoViewIfNeeded();
      await page.locator(".shell-database.inline").hover();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/${prefix}-${theme}${s.suffix}.png` });
    }
  }
});
