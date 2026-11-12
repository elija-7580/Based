import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-209: Web-Bookmark – „Fetch preview“ holt Titel und Beschreibung nur auf Klick (Desktop: Tauri-HTTP; hier über
// den Test-Haken `__based.linkPreviewHTML`). Ohne Haken (Browser-Tab) gibt es den Knopf nicht. Vorschau bleibt nach dem
// Neuladen. Bildschirmfotos (BASED_SCREENSHOTS=1, Chromium): docs/design/screens/web-editor-bookmark-*.png.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-bookmark-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);
const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();

const HTML = `<html><head><title>Fallback</title><meta property="og:title" content="Based — the calm workspace">
<meta property="og:description" content="Pages, databases and agents that stay on your Mac. Sync when you want it, offline when you need it.">
<meta property="og:image" content="/cover.png"></head><body></body></html>`;

async function ready(page: Page, hook: boolean) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  if (hook) {
    await page.evaluate((html) => {
      const g = globalThis as unknown as { __based: { linkPreviewHTML?: (u: string) => Promise<string>; previewCalls?: string[] } };
      g.__based.previewCalls = [];
      g.__based.linkPreviewHTML = async (u) => { g.__based.previewCalls!.push(u); return html; };
    }, HTML);
  }
}

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

async function bookmark(page: Page, url: string) {
  await editor(page).locator(".bn-block-content").first().click();
  await page.keyboard.type("/Web bookmark");
  await expect(page.getByRole("option", { name: /Web bookmark/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const field = editor(page).getByPlaceholder("Paste a link (bookmark)…");
  await expect(field).toBeVisible();
  await field.fill(url);
  await field.press("Enter");
  await expect(editor(page).locator(".bx-embed-card")).toContainText(url);
}

const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as { __based: { previewCalls?: string[] } }).__based.previewCalls ?? []);

test.describe.configure({ timeout: 120_000 });

test("Bookmark: „Fetch preview“ holt Titel und Beschreibung nur auf Klick; bleibt nach dem Neuladen", async ({ page }) => {
  await ready(page, true);
  await command(page, { op: "createPage", title: "Links" });
  await openPage(page, "Links");
  await bookmark(page, "https://example.com/based");
  // Nichts geholt, bevor geklickt wird
  expect(await calls(page)).toEqual([]);
  const fetchBtn = editor(page).getByRole("button", { name: "Fetch preview" });
  await expect(fetchBtn).toBeVisible();
  await fetchBtn.click();
  const card = editor(page).locator(".bx-embed-card");
  await expect(card.locator(".bx-embed-title")).toHaveText("Based — the calm workspace");
  await expect(card.locator(".bx-embed-summary")).toContainText("Pages, databases and agents");
  await expect(card.locator(".bx-embed-url")).toHaveText("https://example.com/based");
  expect(await calls(page)).toEqual(["https://example.com/based"]);
  await expect(editor(page).getByRole("button", { name: "Refresh preview" })).toBeVisible();
  // Feinschliff: die Karte bleibt mit Knopf so breit wie die Spalte (wie ohne Knopf)
  const widths = await card.evaluate((el) => ({ card: el.getBoundingClientRect().width, block: el.closest(".bn-block-content")!.getBoundingClientRect().width }));
  expect(Math.abs(widths.card - widths.block)).toBeLessThan(4);
  // Keine fremden Bilder geladen (das Vorschaubild bleibt nur im Record)
  await expect(card.locator("img")).toHaveCount(0);

  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Links");
  await expect(editor(page).locator(".bx-embed-card .bx-embed-title")).toHaveText("Based — the calm workspace");
});

test("Bookmark im Browser-Tab: kein Knopf „Fetch preview“ (fremde Seiten nur aus der Desktop-App)", async ({ page }) => {
  await ready(page, false);
  await command(page, { op: "createPage", title: "Plain" });
  await openPage(page, "Plain");
  await bookmark(page, "https://example.org/");
  await expect(editor(page).getByRole("button", { name: /preview/i })).toHaveCount(0);
});

test("Bildschirmfotos: Bookmark mit Vorschau", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
  await ready(page, true);
  const id = (await command(page, { op: "createPage", title: "Reading list" })) as string;
  await command(page, { op: "createPage", title: "Other" });
  await openPage(page, "Reading list");
  await bookmark(page, "https://example.com/based");
  await editor(page).getByRole("button", { name: "Fetch preview" }).click();
  await expect(editor(page).locator(".bx-embed-title")).toHaveText("Based — the calm workspace");
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
      await page.goto("/#page-" + id);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      // wie in der Desktop-App: Holer vorhanden → Knopf „Refresh preview“ (Editor neu öffnen, damit er ihn sieht)
      await page.evaluate(() => { (globalThis as unknown as { __based: { linkPreviewHTML?: unknown } }).__based.linkPreviewHTML = async () => ""; });
      await openPage(page, "Other");
      await openPage(page, "Reading list");
      await expect(editor(page).locator(".bx-embed-title")).toHaveText("Based — the calm workspace");
      await expect(editor(page).getByRole("button", { name: "Refresh preview" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-bookmark-${w}x${h}-${theme}.png` });
    }
  }
});
