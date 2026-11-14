import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Entscheidungen 14. 11. (Datenbank-Ansichten im Notion-Aufbau): inline ohne einzelnen „Table“-Tab, Werkzeuge gedimmt,
// Daten nicht in Monospace, Fußzeile ohne Linie; „Section“ = Toggle-Überschrift mit Fläche, die eine Datenbank aufnimmt.
// Fotos (hell/dunkel, 1280 × 820) mit BASED_SCREENSHOTS=1 in Chromium.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-dblook-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

test("Section mit Inline-Datenbank: Fläche, kein Einzel-Tab, Daten in UI-Schrift", async ({ page, browserName }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "EcoCoat" });
  });
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await expect(editor).toBeVisible();
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.type("/section");
  await expect(page.getByTestId("slash-menu").getByRole("option").first()).toContainText("Section");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Projects");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  const db = page.locator(".dbui-root.inline").first();
  await expect(db.locator(".dbui-table .dbui-cell.title").first()).toBeVisible();
  // Abschnitt als Fläche, Datenbank liegt darin
  const section = page.locator(".bx2-block.bx2-section").first();
  await expect(section).toBeVisible();
  await expect(section.locator(".dbui-root.inline")).toHaveCount(1);
  expect(await section.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  // eine Ansicht → kein Tab; Kopf- und Fußzeile ohne eigene Fläche
  await expect(db.locator(".dbui-tab")).toHaveCount(0);
  expect(await db.locator(".dbui-thead").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await db.locator(".dbui-tfoot").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.locator(".dbui-root.inline .dbui-table").first()).toBeVisible();
      await page.locator(".bx2-section").first().hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-section-1280x820-${theme}.png` });
    }
  }
});

test("Daten in UI-Schrift, IDs in Monospace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const mono = await page.evaluate(() => {
    const probe = (cls: string) => { const s = document.createElement("span"); s.className = cls; document.querySelector(".app, #root, body")!.appendChild(s); const f = getComputedStyle(s).fontFamily; s.remove(); return f; };
    return { data: probe("dbui-data"), id: probe("dbui-data dbui-id") };
  });
  expect(mono.data).not.toMatch(/mono|Menlo|Consolas/i);
  expect(mono.id).toMatch(/mono|Menlo|Consolas/i);
});

test("Ansichts-Tab: Klick auf den aktiven Tab öffnet das Menü – umbenennen, duplizieren, löschen", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate((cmd) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<unknown> } } }).__based.client.command(cmd), { op: "createDatabase", title: "Views" });
  await page.getByRole("treeitem", { name: "Views" }).click();
  const tabs = page.getByRole("tablist", { name: "Views" }).getByRole("tab");
  await expect(tabs).toHaveCount(1);
  await tabs.first().click();
  const menu = page.getByRole("menu", { name: /^View / });
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("view-menu-delete")).toBeDisabled();
  await menu.getByLabel("View name").fill("Alle");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Alle" })).toBeVisible();
  // Rechtsklick → Duplizieren: neue Ansicht wird gewählt
  await page.getByRole("tab", { name: "Alle" }).click({ button: "right" });
  await page.getByTestId("view-menu-duplicate").click();
  await expect(tabs).toHaveCount(2);
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(tabs).toHaveCount(2);
      await tabs.nth(1).click({ button: "right" });
      await expect(menu).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `../../docs/design/screens/web-db-view-menu-1280x820-${theme}.png` });
      await page.keyboard.press("Escape");
    }
  }
  await tabs.nth(1).click({ button: "right" });
  await page.getByTestId("view-menu-delete").click();
  await expect(tabs).toHaveCount(1);
  // „Edit view“ öffnet die Ansichts-Einstellungen
  await tabs.first().click();
  await page.getByTestId("view-menu-edit").click();
  await expect(page.getByRole("dialog", { name: "View settings" })).toBeVisible();
});
