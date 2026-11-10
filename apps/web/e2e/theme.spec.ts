import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Astryx-Theme „Based Default“: Astryx-Komponenten zeigen in Hell und Dunkel die Based-Token-Werte, der
// Appearance-Umschalter schaltet sie mit, und beim Laden geht nichts an fremde Hosts – auch nicht mit Stil Bold.

interface ColorToken { name: string; value: { light: string; dark: string } }
const tokens = JSON.parse(readFileSync(new URL("../../../packages/design-tokens/tokens.json", import.meta.url), "utf8")) as { color: { tokens: ColorToken[] } };
const token = (name: string, theme: "light" | "dark"): string => {
  const hex = tokens.color.tokens.find((t) => t.name === name)!.value[theme];
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const css = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

for (const theme of ["light", "dark"] as const) {
  test(`Astryx-Komponenten tragen die Based-Farben (${theme})`, async ({ page, browserName }) => {
    const shots = !!process.env.BASED_SCREENSHOTS && browserName === "chromium";
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("/#prefs-kit");
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-astryx-theme", "based");

    // Button = Tinte, nie der Marker
    const primary = '.astryx-button[data-variant="primary"]';
    expect(await css(page, primary, "background-color")).toBe(token("button", theme));
    expect(await css(page, primary, "color")).toBe(token("button-ink", theme));
    expect(await css(page, primary, "background-color")).not.toBe(token("marker", theme));
    expect(await css(page, '.astryx-button[data-variant="destructive"]', "color")).toBe(token("danger", theme));
    // Flächen und Text
    expect(await css(page, ".astryx-card", "background-color")).toBe(token("surface-raised", theme));
    expect(await css(page, "[data-testid=astryx-kit] h1", "color")).toBe(token("ink", theme));
    expect(await css(page, "[data-testid=kit-picked]", "color")).toBe(token("muted", theme));
    // Radien: Buttons sind Pillen, Gruppen haben Radius 18, Eingaben 10
    expect(await css(page, primary, "border-top-left-radius")).toBe("999px");
    expect(await css(page, ".astryx-card", "border-top-left-radius")).toBe("18px");
    expect(await css(page, ".astryx-text-input", "border-top-left-radius")).toBe("10px");
    // Systemschrift aus den Based-Tokens, keine Webschrift
    const font = await css(page, primary, "font-family");
    expect(font).toContain("system-ui");
    expect(font).not.toMatch(/Figtree|Schibsted/);

    // Menü (Popover-Fläche) und Dialog
    await page.getByRole("button", { name: "Page menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    // die Fläche hinter dem Eintrag (erste nicht durchsichtige) ist surface-card
    const menuSurface = await page.getByRole("menuitem", { name: "Rename" }).evaluate((el) => {
      for (let e: Element | null = el.parentElement; e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      }
      return "";
    });
    expect(menuSurface).toBe(token("surface-card", theme));
    await page.getByRole("menuitem", { name: /Duplicate/ }).click();
    await expect(page.getByTestId("kit-picked")).toHaveText("Last menu choice: Duplicate");
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename page" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(token("bg", theme));
    if (shots) {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await page.getByRole("button", { name: "Page menu" }).click();
      await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-astryx-kit-${theme}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open dialog" }).click();
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-astryx-kit-dialog-${theme}.png` });
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });
}

test("Appearance-Umschalter schaltet Astryx mit: Theme, Dichte, Stil", async ({ page }) => {
  await page.goto("/#appearance");
  await ready(page);
  const html = page.locator("html");
  const card = ".astryx-card";
  expect(await css(page, card, "background-color")).toBe(token("surface-raised", "light"));

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => css(page, card, "background-color")).toBe(token("surface-raised", "dark"));
  await expect.poll(() => css(page, "[data-testid=settings-page] h1", "color")).toBe(token("ink", "dark"));

  // Dichte: eigenes Theme mit kleineren Steuerhöhen
  expect(await css(page, card, "--size-element-md")).toBe("32px");
  await page.getByRole("radio", { name: "Compact" }).click();
  await expect(html).toHaveAttribute("data-astryx-theme", "based-compact");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => css(page, card, "--size-element-md")).toBe("28px");

  // Stil Bold: Astryx-Überschriften nehmen die Bold-Schrift aus tokens.css
  await page.getByRole("radio", { name: "Bold" }).click();
  await expect.poll(() => css(page, "[data-testid=settings-page] h1", "font-family")).toContain("Schibsted Grotesk");

  // bleibt nach dem Neuladen, ohne helles Aufblitzen im Zustand
  await page.reload();
  await ready(page);
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-astryx-theme", "based-compact");
  expect(await css(page, card, "background-color")).toBe(token("surface-raised", "dark"));
});

// Regression (Hauptlauf, 10. 11.): Mit dem alten <Theme mode="system"> erbten Seitentitel und Wortmarke die
// Astryx-Textfarbe nach dem Systemschema – bei hellem System fast schwarz auf dunklem Grund.
for (const [theme, os] of [["dark", "light"], ["light", "dark"]] as const) {
  test(`Seitentitel und Wortmarke in Tinte: Theme ${theme} bei System ${os}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: os });
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("/");
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await css(page, ".wordmark", "color")).toBe(token("ink", theme));
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    const title = page.getByLabel("Page title");
    await expect(title).toHaveValue("Welcome to Based");
    expect(await title.evaluate((el) => getComputedStyle(el).color)).toBe(token("ink", theme));
    expect(await page.locator("div[data-astryx-theme]").first().evaluate((el) => getComputedStyle(el).color)).toBe(token("ink", theme));
  });
}

test("Theme „System“ folgt dem Betriebssystem", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#appearance");
  await ready(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByRole("radio", { name: "System" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => css(page, ".astryx-card", "background-color")).toBe(token("surface-raised", "dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect.poll(() => css(page, ".astryx-card", "background-color")).toBe(token("surface-raised", "light"));
});

for (const style of ["default", "bold"] as const) {
  test(`beim Laden gehen keine Requests an fremde Hosts (Stil ${style})`, async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const outside: string[] = [];
    const fonts: string[] = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/\.woff2?(\?|$)/.test(url)) fonts.push(url);
      if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) return route.continue();
      outside.push(url);
      return route.abort("internetdisconnected");
    });
    await page.addInitScript((s) => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", style: s })), style);
    await page.goto("/");
    await ready(page);
    // Home, Einstellungen (Astryx), Design-Kit und eine Seite öffnen – alles ohne fremde Hosts
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.goto("/#prefs-kit");
    await expect(page.getByTestId("astryx-kit")).toBeVisible();
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    if (style === "bold") {
      await expect(page.locator("html")).toHaveAttribute("data-style", "bold");
      // die Bold-Schrift ist wirklich da – vom eigenen Server
      await expect.poll(() => page.evaluate(() => document.fonts.check('700 20px "Schibsted Grotesk"'))).toBe(true);
      await expect.poll(() => fonts.length).toBeGreaterThan(0);
    } else {
      await page.waitForLoadState("networkidle");
      expect(fonts.filter((u) => /schibsted|literata/i.test(u))).toEqual([]);
    }
    expect(outside).toEqual([]);
    expect(await page.evaluate(() => [...document.querySelectorAll("link[href], script[src]")].map((e) => (e as HTMLLinkElement).href || (e as HTMLScriptElement).src).filter((u) => !u.startsWith(location.origin)))).toEqual([]);
  });
}
