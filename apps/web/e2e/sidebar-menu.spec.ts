import { expect, test, type Page } from "@playwright/test";

// BSD-288: Kontextmenü einer Seite in der Seitenleiste wie in der Swift-App – Open in new tab, Copy link, Export als
// Markdown/HTML; bei Mehrfachauswahl Open in new tabs und Copy links.

type Based = { client: { command: (c: Record<string, unknown>) => Promise<unknown> }; history: { tabs: readonly unknown[] } };
const based = (page: Page) => ({
  command: (c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: Based }).__based.client.command(cmd), c),
  tabs: () => page.evaluate(() => (globalThis as unknown as { __based: Based }).__based.history.tabs.length),
});

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // Zwischenablage abfangen (WebKit erlaubt Tests das Lesen nicht)
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { w.__copied.push(t); } } });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("Seitenmenü: neuer Tab, Link kopieren, Export als Markdown", async ({ page }) => {
  await ready(page);
  const id = (await based(page).command({ op: "createPage", title: "Menu target" })) as string;
  const tree = page.getByRole("tree", { name: "Pages" });
  const row = tree.getByRole("treeitem", { name: "Menu target" });
  await expect(row).toBeVisible();
  const menu = page.getByRole("menu", { name: "Page actions" });

  const tabs = await based(page).tabs();
  await row.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Open in new tab" }).click();
  await expect.poll(() => based(page).tabs()).toBe(tabs + 1);

  await row.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy link" }).click();
  await expect.poll(() => copied(page)).toHaveLength(1);
  expect((await copied(page))[0]).toContain("#page-" + id);

  await row.click({ button: "right" });
  const dl = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Export as Markdown" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.md$/);
});

test("Mehrfachauswahl: Open in new tabs und Copy links", async ({ page }) => {
  await ready(page);
  await based(page).command({ op: "createPage", title: "Multi A" });
  await based(page).command({ op: "createPage", title: "Multi B" });
  const tree = page.getByRole("tree", { name: "Pages" });
  await tree.getByRole("treeitem", { name: "Multi A" }).click();
  await tree.getByRole("treeitem", { name: "Multi B" }).click({ modifiers: ["Shift"] });
  await expect(tree.locator("[data-picked]")).toHaveCount(2);
  const tabs = await based(page).tabs();
  await tree.getByRole("treeitem", { name: "Multi B" }).click({ button: "right" });
  const bulk = page.getByRole("menu", { name: "Actions for 2 pages" });
  await bulk.getByRole("menuitem", { name: "Open in new tabs" }).click();
  await expect.poll(() => based(page).tabs()).toBe(tabs + 2);
  await tree.getByRole("treeitem", { name: "Multi B" }).click({ button: "right" });
  await page.getByRole("menu", { name: "Actions for 2 pages" }).getByRole("menuitem", { name: "Copy links" }).click();
  await expect.poll(async () => ((await copied(page))[0] ?? "").split("\n").length).toBe(2);
});

// Das längere Menü passt auch ins kleinste Fenster (900 × 600); Fotos hell/dunkel mit BASED_SCREENSHOTS=1.
test("Seitenmenü bleibt im kleinsten Fenster ganz sichtbar", async ({ page, browserName }) => {
  await ready(page);
  for (let i = 1; i <= 8; i++) await based(page).command({ op: "createPage", title: `Row ${i}` });
  for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    const row = page.getByRole("tree", { name: "Pages" }).getByRole("treeitem", { name: "Row 8" });
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Page actions" });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(h + 1);
    if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-sidebar-menu-${theme}${suffix}.png` });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    }
    await page.keyboard.press("Escape");
  }
});
