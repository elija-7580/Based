import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-306: Auf der Datenbankseite stehen Titel, Text des ersten Ansichts-Tabs und Text der ersten Spalte auf einer
// linken Kante (vorher 272 / 304 / 360 px); Kästchen und Griff hängen links in den Rand. Inline-Datenbanken richten
// sich genauso am Seitentext aus. Fotos (hell/dunkel) mit BASED_SCREENSHOTS=1 in Chromium.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-dbedge-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 800 } });
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

/** Linke Textkante: Kasten plus Innenabstand links. */
const textEdge = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));

async function shots(page: Page, name: string) {
  if (process.env.BASED_SCREENSHOTS !== "1") return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.locator(".dbui-table").first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `../../docs/design/screens/web-db-edges-${name}-${theme}.png` });
  }
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
}

test("Ganzseitige Datenbank: Titel, Tab und erste Spalte auf einer Kante", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createDatabase", title: "Edges" });
  await page.getByRole("treeitem", { name: "Edges" }).click();
  await expect(page.locator(".dbui-table .dbui-cell.title").first()).toBeVisible();
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    const title = await textEdge(page, "h1.page-title");
    const tab = await textEdge(page, ".dbui-tab");
    const cell = await textEdge(page, ".dbui-table .dbui-cell.title");
    expect(Math.abs(tab - title), `Tab ${tab} / Titel ${title} bei ${width}`).toBeLessThanOrEqual(1);
    expect(Math.abs(cell - title), `Zelle ${cell} / Titel ${title} bei ${width}`).toBeLessThanOrEqual(1);
    // Kästchen und Griff hängen links heraus, bleiben aber im Bild
    expect(await page.locator(".dbui-table").first().evaluate((t) => t.getBoundingClientRect().left)).toBeGreaterThan(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  if (browserName === "chromium") await shots(page, "full");
});

test("Inline-Datenbank: Tab und erste Spalte am Seitentext", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Inline edges" });
  await page.getByRole("treeitem", { name: "Inline edges" }).click();
  const editor = page.locator(".bx-editor > .bx-doc .bn-editor").first();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.locator(".bn-block-content").first().click();
  await page.keyboard.type("Text above");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: /Database – Inline/ }).click();
  await expect(page.locator(".dbui-root.inline .dbui-table .dbui-cell.title").first()).toBeVisible();
  const text = await editor.getByText("Text above").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().left;
  });
  const tab = await textEdge(page, ".dbui-root.inline .dbui-tab");
  const cell = await textEdge(page, ".dbui-root.inline .dbui-table .dbui-cell.title");
  expect(Math.abs(tab - text), `Tab ${tab} / Text ${text}`).toBeLessThanOrEqual(1);
  expect(Math.abs(cell - text), `Zelle ${cell} / Text ${text}`).toBeLessThanOrEqual(1);
  if (browserName === "chromium") await shots(page, "inline");
});
