// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// Mac-Beta: macOS 13 mit Safari 16 (WebKit vor 17) kennt `:popover-open` nicht – document.querySelector wirft dort einen
// SyntaxError. Die Esc-Wege (Side Peek, schwebende Seitenleiste, Chat) dürfen daran nicht scheitern. Hier wird der alte
// Selektor-Parser nachgestellt: jede Abfrage mit `:popover-open` wirft wie in WebKit 16.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function oldWebKit(page: Page) {
  await page.addInitScript(() => {
    for (const proto of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
      for (const name of ["querySelector", "querySelectorAll", "matches", "closest"] as const) {
        const orig = (proto as unknown as Record<string, (s: string) => unknown>)[name];
        if (typeof orig !== "function") continue;
        Object.defineProperty(proto, name, {
          configurable: true, writable: true,
          value(this: unknown, sel: string) {
            if (typeof sel === "string" && sel.includes(":popover-open")) throw new DOMException(`'${sel}' is not a valid selector.`, "SyntaxError");
            return orig.call(this, sel);
          },
        });
      }
    }
  });
}

test("WebKit ohne :popover-open: Esc schließt den Side Peek ohne Fehler", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await oldWebKit(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "seedDatabase", count: 5 });
  await page.getByRole("treeitem", { name: "Big 5" }).click();
  await page.getByRole("gridcell", { name: /^Row 2/ }).hover();
  await page.getByRole("button", { name: "Open Row 2" }).click();
  const peek = page.getByTestId("row-peek");
  await expect(peek).toBeVisible();
  await page.getByLabel("Row title").click();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  expect(errors.filter((m) => m.includes("popover-open"))).toEqual([]);
});

test("WebKit ohne :popover-open: Esc schließt die schwebende Seitenleiste ohne Fehler", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await oldWebKit(page);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.mouse.move(360, 450);
  const sidebar = page.getByRole("navigation", { name: "Workspace" });
  await expect(sidebar).toBeHidden();
  await page.getByTestId("sidebar-show").click();
  await expect(sidebar).toBeVisible();
  await page.mouse.move(360, 450);
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  expect(errors.filter((m) => m.includes("popover-open"))).toEqual([]);
});
