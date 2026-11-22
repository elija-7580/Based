// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// Elija 22.11.2026 (Vergleich App ↔ Website, Runde 2): die Seitenleiste nennt oben den Workspace und zeigt je Seite in
// Ruhe nur das Icon; der Pfeil zum Aufklappen liegt an derselben Stelle und erscheint beim Überfahren.
// Fotos mit BASED_SCREENSHOTS=1 (Chromium): docs/design/screens/web-sidebar-look-<theme>-<breite>.png.

type Client = { command: (c: Record<string, unknown>) => Promise<string> };
const opacity = (page: Page, row: string, sel: string) =>
  page.getByRole("treeitem", { name: row }).locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));

for (const theme of ["light", "dark"] as const) {
  test(`Seitenleiste: Name des Workspace oben, Pfeil erst beim Überfahren (${theme})`, async ({ page, browserName }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await page.evaluate(async () => {
      const c = (globalThis as unknown as { __based: { client: Client } }).__based.client;
      const parent = await c.command({ op: "createPage", title: "Projects" });
      await c.command({ op: "createPage", title: "Roadmap", parent });
      await c.command({ op: "createPage", title: "Reading list" });
    });
    const nav = page.getByRole("navigation", { name: "Workspace" });
    const name = nav.getByTestId("workspace-name");
    await expect(name).toBeVisible();
    await expect(name).not.toHaveText("");
    expect(await name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);

    for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }]) {
      await page.setViewportSize(size);
      await page.mouse.move(size.width - 40, size.height - 40);
      // In Ruhe: Icon sichtbar, Pfeil nicht
      await expect.poll(() => opacity(page, "Reading list", ".twisty")).toBe(0);
      await expect.poll(() => opacity(page, "Reading list", ".tree-icon")).toBe(1);
      if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
        await page.screenshot({ path: `../../docs/design/screens/web-sidebar-look-${theme}-${size.width}.png` });
      }
    }

    // Überfahren: Pfeil an der Stelle des Icons, nichts verschiebt sich
    const row = page.getByRole("treeitem", { name: "Projects" });
    const titleBefore = (await row.locator(".tree-title").boundingBox())!;
    await row.hover();
    await expect.poll(() => opacity(page, "Projects", ".twisty")).toBe(1);
    await expect.poll(() => opacity(page, "Projects", ".tree-icon")).toBe(0);
    const twisty = (await row.locator(".twisty").boundingBox())!;
    const icon = (await row.locator(".tree-icon").boundingBox())!;
    expect(Math.abs(twisty.x - icon.x)).toBeLessThanOrEqual(1);
    expect((await row.locator(".tree-title").boundingBox())!.x).toBe(titleBefore.x);

    // Der Pfeil klappt auf wie bisher
    await row.getByRole("button", { name: "Expand" }).click();
    await expect(page.getByRole("treeitem", { name: "Roadmap" })).toBeVisible();
  });
}
