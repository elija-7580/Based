// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// Elija 22.11.2026 (Vergleich App ↔ Website, Runde 2): eine leere Seite sagt, wie man anfängt, und der Kopf einer
// geöffneten Zeile nennt nur leise, wo man ist. Fotos mit BASED_SCREENSHOTS=1 (Chromium):
// docs/design/screens/web-empty-page-<theme>-<größe>.png und web-row-peek-empty-<theme>-<größe>.png.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";
const HINT = "Write something, or press / for commands";
const SIZES = [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }];

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

const hint = (page: Page, scope = "") =>
  page.locator(`${scope} [data-testid="block-editor-tail"]`).first().evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return { text: s.content, size: parseFloat(s.fontSize) };
  });

async function start(page: Page, theme: string) {
  await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

for (const theme of ["light", "dark"]) {
  test(`Leere Seite zeigt den Hinweis, Klick legt die erste Zeile an (${theme})`, async ({ page, browserName }) => {
    await start(page, theme);
    const id = (await command(page, { op: "createPage", title: "Empty" })) as string;
    await page.goto(`/#page-${id}`);
    const editor = page.getByTestId("block-editor");
    await expect(editor).toHaveAttribute("data-empty", "");
    for (const size of SIZES) {
      await page.setViewportSize(size);
      const h = await hint(page);
      expect(h.text).toContain(HINT);
      expect(h.size).toBeGreaterThanOrEqual(14);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-empty-page-${theme}-${size.width}.png` });
    }
    // Klick auf den Hinweis: erste Zeile, Fokus darin, Hinweis weg
    await editor.getByTestId("block-editor-tail").click();
    await expect(editor.locator("[data-editable-id]").first()).toBeFocused();
    await expect(editor).not.toHaveAttribute("data-empty", "");
    expect((await hint(page)).text).toBe("none");
    await page.keyboard.type("Hello");
    await expect(editor.locator("[data-editable-id]").first()).toHaveText("Hello");
  });

  test(`Geöffnete Zeile: Kopf leise, leerer Inhalt mit Hinweis (${theme})`, async ({ page, browserName }) => {
    await start(page, theme);
    await command(page, { op: "seedDatabase", count: 5 });
    await page.getByRole("treeitem", { name: "Big 5" }).click();
    await page.getByRole("gridcell", { name: /^Row 2/ }).hover();
    await page.getByRole("button", { name: "Open Row 2" }).click();
    const peek = page.locator("dialog:has(.row-peek-body)");
    await expect(page.getByTestId("row-peek")).toBeVisible();
    for (const size of SIZES) {
      await page.setViewportSize(size);
      // Der Kopf (Name der Datenbank) ist kleiner und leiser als der Titel der Zeile.
      const head = await peek.locator("h2").first().evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
      const title = await peek.locator(".row-peek-title").evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
      expect(head.size).toBeGreaterThanOrEqual(14);
      expect(head.size).toBeLessThan(title.size);
      expect(head.color).not.toBe(title.color);
      expect((await hint(page, "dialog:has(.row-peek-body)")).text).toContain(HINT);
      if (SHOTS && browserName === "chromium") {
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-row-peek-empty-${theme}-${size.width}.png` });
      }
    }
  });
}
