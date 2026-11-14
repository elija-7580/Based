import { expect, test, type Page } from "@playwright/test";

// Editor-Menüs mit eigenen Based-Icons (Slash, @, Turn into): keine Emojis oder Textzeichen als Icon, Icon-Kachel als
// Fläche ohne Haarlinie, Menü im Aussehen des Seitenmenüs (BSD-407 Teil 6.1). Bilder nach docs/design/screens/.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function newPage(page: Page, size = { width: 1280, height: 820 }) {
  await page.setViewportSize(size);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "Menus" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

type Theme = "light" | "dark";

/** Dunkel über die echte Einstellung (Settings → Appearance), wie beim Nutzer – nicht nur per Attribut. */
async function useTheme(page: Page, theme: Theme) {
  await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.emulateMedia({ colorScheme: theme });
}

async function shot(page: Page, name: string, size: string, theme: Theme) {
  if (test.info().project.name !== "chromium") return;
  await page.waitForTimeout(250); // Einblenden des Menüs abwarten
  await page.screenshot({ path: `../../docs/design/screens/web-editor-${name}-${size}-${theme}.png` });
}

const SIZES = [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }];

for (const theme of ["light", "dark"] as const) for (const size of SIZES) {
  const tag = `${size.width}x${size.height}`;
  test(`Slash-Menü: Based-Icons als SVG, Kachel ohne Haarlinie (${tag}, ${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await newPage(page, size);
    await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    const tiles = menu.locator(".bx2-menu-icon");
    const n = await tiles.count();
    expect(n).toBeGreaterThan(20);
    // jede Kachel trägt genau ein SVG und keinen Text (kein Emoji, kein „H1“, kein „•“)
    const bad = await tiles.evaluateAll((els) => els.filter((e) => e.querySelectorAll("svg[data-icon]").length !== 1 || (e.textContent ?? "").trim() !== "").length);
    expect(bad).toBe(0);
    const look = await menu.evaluate((el) => {
      const m = getComputedStyle(el);
      const tile = getComputedStyle(el.querySelector(".bx2-menu-icon")!);
      const row = getComputedStyle(el.querySelector(".bx2-menu-item")!);
      return { radius: parseFloat(m.borderTopLeftRadius), rowRadius: parseFloat(row.borderTopLeftRadius), tileBorder: tile.borderTopWidth, userSelect: m.userSelect };
    });
    expect(look.rowRadius).toBeLessThan(look.radius);
    expect(look.tileBorder).toBe("0px");
    expect(look.userSelect).toBe("none");
    // Menü bleibt im Fenster
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    await shot(page, "slash-menu", tag, theme);
    await page.keyboard.type("vid");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await shot(page, "slash-menu-filtered", tag, theme);
  });
}

for (const theme of ["light", "dark"] as const) test(`Blockmenü: Aktionen mit Icons, „Turn into“ mit den Slash-Icons, Farbfelder zeigen ihre Farbe (${theme})`, async ({ page }) => {
  await useTheme(page, theme);
  await newPage(page);
  await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
  await page.keyboard.type("Menu block");
  await page.keyboard.press("Escape");
  await page.getByTestId("block-editor").locator(".bx2-block").first().locator(".bx2-grip").click();
  const menu = page.getByTestId("block-menu");
  await expect(menu).toBeVisible();
  for (const name of ["Delete", "Duplicate", "Turn into", "Color"]) {
    await expect(menu.getByRole("menuitem", { name }).locator("svg").first()).toBeVisible();
  }
  await shot(page, "block-menu", "1280x820", theme);
  await menu.getByRole("menuitem", { name: "Turn into" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Heading 1" }).locator("svg[data-icon=heading1]")).toBeVisible();
  await shot(page, "block-menu-turn", "1280x820", theme);
  await page.keyboard.press("Escape");
  await page.getByTestId("block-editor").locator(".bx2-block").first().locator(".bx2-grip").click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Color" }).click();
  // Farbfelder zeigen ihre Farbe (die Kachel überdeckt sie nicht)
  const bg = await menu.getByRole("menuitemradio", { name: "Red background" }).locator(".bx2-swatch").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  await shot(page, "block-menu-color", "1280x820", theme);
});

test("Slash-Menü schließt bei Klick daneben, der Text bleibt", async ({ page }) => {
  await newPage(page);
  await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
  await page.keyboard.type("Hello /he");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  // Klick auf eine freie Fläche der Seite (unter den Blöcken)
  await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("block-editor").locator("[data-editable-id]").first()).toHaveText("Hello /he");
});

test("Griff geklickt: Entf und ⌫ löschen den Block", async ({ page }) => {
  await newPage(page);
  const ed = page.getByTestId("block-editor");
  await ed.getByTestId("block-editor-tail").click();
  await page.keyboard.type("Keep me");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Delete me");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Backspace me");
  await expect(ed.locator("[data-editable-id]")).toHaveCount(3);
  await ed.locator(".bx2-block").nth(1).hover();
  await ed.locator(".bx2-block").nth(1).locator(".bx2-grip").click();
  await expect(page.getByTestId("block-menu")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("block-menu")).toHaveCount(0);
  await expect(ed.locator("[data-editable-id]")).toHaveText(["Keep me", "Backspace me"]);
  await ed.locator(".bx2-block").nth(1).hover();
  await ed.locator(".bx2-block").nth(1).locator(".bx2-grip").click();
  await expect(page.getByTestId("block-menu")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(ed.locator("[data-editable-id]")).toHaveText(["Keep me"]);
});
