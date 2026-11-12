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

test("oben nur Search, Home, Chat; Fuß als Icon-Zeile; Tasks, Graph, Settings bleiben erreichbar", { tag: "@smoke" }, async ({ page }) => {
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

test("Rechtsklick: oben anpinnen, ausblenden, wieder zeigen – bleibt nach Neuladen", { tag: "@smoke" }, async ({ page }) => {
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

// Feedback 11. 11.: Search, Home, Chat … ließen sich nicht umsortieren. Ziehen sortiert um und verschiebt zwischen
// oben und der Icon-Zeile im Fuß; bleibt nach dem Neuladen; „Reset sidebar“ stellt den Anfang wieder her.
test("Einträge ziehen: oben umsortieren, in den Fuß und zurück; bleibt nach Neuladen; Reset", async ({ page }) => {
  await ready(page);
  const tools = nav(page).getByRole("group", { name: "Workspace tools" });
  const top = async () => (await topNames(page)).map((t) => t.split("\n")[0]!.trim());
  const footer = () => tools.getByRole("button").evaluateAll((bs) => bs.map((b) => (b.getAttribute("aria-label") ?? "").split(",")[0]));
  const item = (name: string) => nav(page).locator(":scope > .nav-item", { hasText: name });
  const drag = async (from: import("@playwright/test").Locator, to: import("@playwright/test").Locator, at: (b: { width: number; height: number }) => { x: number; y: number }) => {
    const f = (await from.boundingBox())!, t = (await to.boundingBox())!;
    const p = at(t);
    await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
    await page.mouse.down();
    await page.mouse.move(f.x + f.width / 2 + 4, f.y + f.height / 2 + 4, { steps: 4 });
    await page.mouse.move(t.x + p.x, t.y + p.y, { steps: 8 });
    await page.mouse.move(t.x + p.x + 1, t.y + p.y, { steps: 2 });
    await page.mouse.up();
  };
  expect(await top()).toEqual(["Search", "Home", "Chat"]);
  // Chat vor Search
  await drag(item("Chat"), item("Search"), (b) => ({ x: b.width / 2, y: 4 }));
  await expect.poll(top).toEqual(["Chat", "Search", "Home"]);
  // Library aus dem Fuß nach oben hinter Home
  await drag(tools.getByRole("button", { name: "Library" }), item("Home"), (b) => ({ x: b.width / 2, y: b.height - 4 }));
  await expect.poll(top).toEqual(["Chat", "Search", "Home", "Library"]);
  await expect.poll(footer).toEqual(["Trash", "Settings"]);
  // Search in den Fuß vor Trash
  await drag(item("Search"), tools.getByRole("button", { name: /^Trash/ }), (b) => ({ x: 4, y: b.height / 2 }));
  await expect.poll(top).toEqual(["Chat", "Home", "Library"]);
  await expect.poll(footer).toEqual(["Search", "Trash", "Settings"]);
  // Klick auf einen gezogenen Eintrag funktioniert weiter
  await tools.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel("Search pages")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect.poll(top).toEqual(["Chat", "Home", "Library"]);
  await expect.poll(footer).toEqual(["Search", "Trash", "Settings"]);
  // Zurücksetzen
  await item("Home").click({ button: "right" });
  await page.getByTestId("nav-menu").getByRole("menuitem", { name: "Reset sidebar" }).click();
  await expect.poll(top).toEqual(["Search", "Home", "Chat"]);
  await expect.poll(footer).toEqual(["Library", "Trash", "Settings"]);
});
