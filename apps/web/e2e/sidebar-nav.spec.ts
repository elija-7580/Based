import { expect, test, type Page } from "@playwright/test";

// BSD-281: Seitenleiste neu geordnet – oben Search, Home, Chat; unten Library · Trash · Settings als Icon-Zeile neben
// dem Sync-Status; Tasks über „All tasks“ auf der Startseite, Graph als Reiter der Library, alles über ⌘K; Rechtsklick
// pinnt oben an oder blendet aus (pro Gerät, bleibt nach Neuladen).

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Workspace" });
const topNames = (page: Page) => nav(page).locator(":scope > .nav-item").allInnerTexts();

test("oben nur Search, Home, Chat; Fuß als Icon-Zeile; Tasks, Graph, Settings bleiben erreichbar", async ({ page }) => {
  await ready(page);
  expect((await topNames(page)).map((t) => t.split("\n")[0]!.trim())).toEqual(["Search", "Home", "Chat"]);
  const tools = nav(page).getByRole("group", { name: "Workspace tools" });
  await expect(tools.getByTestId("sync-status")).toBeVisible();
  await expect(tools.getByRole("button")).toHaveCount(3);
  await expect(nav(page).getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "Coding" })).toHaveCount(0);

  // Tasks über die Startseite
  await page.getByTestId("home-all-tasks").click();
  await expect(page).toHaveURL(/#tasks/);

  // Graph als Reiter der Library, und zurück
  await tools.getByRole("button", { name: "Library" }).click();
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  await expect(page.getByTestId("graph")).toBeVisible();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Pages" }).click();
  await expect(page.getByTestId("library")).toBeVisible();

  // ⌘K: Befehle
  for (const [q, label, url] of [["tasks", "All tasks", /#tasks/], ["graph", "Graph", /#graph/], ["sett", "Settings", /#appearance|#settings|#prefs/], ["trash", "Trash", /#trash/]] as const) {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByLabel("Search pages").fill(q);
    await expect(page.getByTestId("qf-command").first()).toContainText(label);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(url);
  }
});

test("Rechtsklick: oben anpinnen, ausblenden, wieder zeigen – bleibt nach Neuladen", async ({ page }) => {
  await ready(page);
  const tools = nav(page).getByRole("group", { name: "Workspace tools" });
  await tools.getByRole("button", { name: "Library" }).click({ button: "right" });
  const menu = page.getByTestId("nav-menu");
  await menu.getByRole("menuitem", { name: "Pin to top" }).click();
  await expect(tools.getByRole("button", { name: "Library" })).toHaveCount(0);
  expect((await topNames(page)).map((t) => t.split("\n")[0]!.trim())).toEqual(["Search", "Home", "Chat", "Library"]);

  // Tasks über „Show in sidebar“ zeigen, Chat ausblenden
  await nav(page).getByRole("button", { name: /^Chat/ }).click({ button: "right" });
  await menu.getByRole("menuitemcheckbox", { name: "Tasks" }).click();
  await nav(page).getByRole("button", { name: /^Chat/ }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  expect((await topNames(page)).map((t) => t.split("\n")[0]!.trim())).toEqual(["Search", "Home", "Library", "Tasks"]);

  // Library zurück in den Fuß
  await nav(page).locator(":scope > .nav-item", { hasText: "Library" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Move back to the bottom" }).click();
  await expect(tools.getByRole("button", { name: "Library" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`Screenshot Seitenleiste (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await ready(page);
    await page.mouse.move(700, 450);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `../../docs/design/screens/web-sidebar-nav-${theme}.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });
  });
}
