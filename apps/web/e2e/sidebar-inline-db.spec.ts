import { expect, test } from "@playwright/test";

// BSD-377: Eine Seite, die Inline-Datenbanken enthält, zeigt sie in der Seitenleiste darunter (wie Notion) –
// vorher stand dort „No pages inside“. Screenshots (3 Größen, hell/dunkel) nur mit BASED_SCREENSHOTS=1 in Chromium.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

test("Seitenleiste: Inline-Datenbank steht unter ihrer Seite und öffnet sich als ganze Seite", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Second Brain");
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await editor.click();
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: /Database – Inline/ }).click();
  await expect(page.locator(".shell-database.inline")).toBeVisible();

  const parent = page.getByRole("treeitem", { name: "Second Brain" });
  await expect(parent).toBeVisible();
  const expand = parent.getByRole("button", { name: "Expand" });
  if (await expand.count()) await expand.click();
  const child = page.locator('[role="treeitem"][aria-level="2"]');
  await expect(child).toHaveCount(1);
  await expect(page.getByText("No pages inside")).toHaveCount(0);

  if (SHOTS && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(child).toHaveCount(1);
      for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `../../docs/design/screens/web-sidebar-inline-db-${theme}${suffix}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }

  await child.click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Second Brain");
  await expect(page.locator(".shell-database")).toBeVisible();
});
