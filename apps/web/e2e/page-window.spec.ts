import { expect, test } from "@playwright/test";

// BSD-202: „Open in new window“ – im Browser ein neues Fenster mit nur dieser Seite (eigener Verlauf, die Tabs des
// Hauptfensters bleiben unberührt). In der Tauri-Hülle entsteht ein eigenes Tauri-Fenster (Mac-Test).

test("Seite in eigenem Fenster öffnen (Seitenmenü und Seitenleiste)", async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.keyboard.press("ControlOrMeta+t");
  await expect(page.getByRole("tab")).toHaveCount(2);

  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
  const [win] = await Promise.all([context.waitForEvent("page"), page.getByRole("menuitem", { name: "Open in new window" }).click()]);
  await win.waitForLoadState();
  expect(win.url()).toMatch(/[?&]window=page#page-/);
  await expect(win.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(win.getByLabel("Page title")).toHaveValue("Welcome to Based");
  await expect(win.getByRole("tab")).toHaveCount(0); // ein Tab: keine Tab-Leiste
  await win.close();

  // Hauptfenster unverändert
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByRole("tab")).toHaveCount(2);

  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByRole("button", { name: "Page menu" }).click();
  const [w2] = await Promise.all([context.waitForEvent("page"), page.getByRole("menuitem", { name: "Open in new window" }).click()]);
  expect(w2.url()).toContain("window=page");
  await w2.close();
});
