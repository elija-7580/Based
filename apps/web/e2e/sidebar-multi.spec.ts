import { expect, test, type Page } from "@playwright/test";

// BSD-203: Seitenleiste – Mehrfachauswahl (⇧-Klick) mit Sammelaktionen, Hover-Peek der eingeklappten Seitenleiste.

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newPage(page: Page, title: string) {
  const before = await page.getByRole("treeitem", { name: "Untitled", exact: true }).count();
  await page.keyboard.press("ControlOrMeta+Alt+n");
  // Erst wenn die neue Seite offen ist (leerer Titel, neuer Eintrag in der Seitenleiste), den Titel tippen.
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(before + 1);
  const t = page.getByLabel("Page title");
  await expect(t).toHaveValue("");
  await t.fill(title);
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
}

test("⇧-Klick wählt mehrere Seiten; Sammelaktionen Favorit und Papierkorb", async ({ page }) => {
  await ready(page);
  await newPage(page, "Alpha");
  await newPage(page, "Beta");
  await newPage(page, "Gamma");
  const tree = page.getByRole("tree", { name: "Pages" });
  await tree.getByRole("treeitem", { name: "Alpha" }).click();
  await tree.getByRole("treeitem", { name: "Gamma" }).click({ modifiers: ["Shift"] });
  await expect(tree.locator("[data-picked]")).toHaveCount(3);

  await tree.getByRole("treeitem", { name: "Beta" }).click({ button: "right" });
  const bulk = page.getByRole("menu", { name: "Actions for 3 pages" });
  await expect(bulk).toBeVisible();
  await bulk.getByRole("menuitem", { name: "Add to Favorites" }).click();
  await expect(page.locator(".tree-row[data-row]").filter({ hasText: "Gamma" })).toHaveCount(2); // Favorit + Private

  await tree.getByRole("treeitem", { name: "Beta" }).first().click({ button: "right" });
  await page.getByRole("menu", { name: "Actions for 3 pages" }).getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(tree.getByRole("treeitem", { name: "Alpha" })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "Gamma" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Trash/ })).toContainText("3");
});

test("Esc und normaler Klick heben die Auswahl auf", async ({ page }) => {
  await ready(page);
  await newPage(page, "One");
  await newPage(page, "Two");
  const tree = page.getByRole("tree", { name: "Pages" });
  await tree.getByRole("treeitem", { name: "One" }).click({ modifiers: ["Shift"] });
  await expect(tree.locator("[data-picked]")).toHaveCount(2); // offene Seite „Two“ + „One“
  await page.keyboard.press("Escape");
  await expect(tree.locator("[data-picked]")).toHaveCount(0);
  await tree.getByRole("treeitem", { name: "One" }).click({ modifiers: ["Shift"] });
  await tree.getByRole("treeitem", { name: "Two" }).click();
  await expect(tree.locator("[data-picked]")).toHaveCount(0);
});

test("Eingeklappt: Zeiger an den linken Rand zeigt die Seitenleiste schwebend", async ({ page }) => {
  await ready(page);
  await page.locator(".panel").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+Backslash");
  const sidebar = page.locator("nav.sidebar");
  await expect(sidebar).toBeHidden();
  await page.mouse.move(400, 400);
  await page.mouse.move(2, 400, { steps: 4 });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveClass(/peek/);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.mouse.move(900, 400, { steps: 4 });
  await expect(sidebar).toBeHidden();
  await expect(page.getByTestId("sidebar-show")).toBeVisible();
});
