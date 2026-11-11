import { expect, test, type Page } from "@playwright/test";

// Feedback vom 11.11.: (1) die Icon-Zeile im Fuß der Seitenleiste verschwand bei schmaler Leiste, (2) die Seitenleiste
// ließ sich nicht sichtbar ausblenden (nur ⌘\, das es auf deutschen Tastaturen nicht gibt), (3) Home konnte keine Seite
// sein, (4) der Graph baute sich neu auf, sobald eine Seite dazukam.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = <T,>(page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c) as Promise<T>;
const nav = (page: Page) => page.getByRole("navigation", { name: "Workspace" });

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("schmale Seitenleiste: Library, Trash, Settings bleiben ganz sichtbar, der Status kürzt", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.sidebarWidth", "200"));
  await ready(page);
  const side = (await nav(page).boundingBox())!;
  expect(Math.round(side.width)).toBe(200);
  const tools = nav(page).getByRole("group", { name: "Workspace tools" });
  for (const name of ["Library", "Trash", "Settings"]) {
    const b = (await tools.getByRole("button", { name }).boundingBox())!;
    expect(b.width).toBeGreaterThan(20);
    expect(b.x).toBeGreaterThanOrEqual(side.x);
    expect(b.x + b.width).toBeLessThanOrEqual(side.x + side.width);
  }
  // auch mit langem Status (z. B. „· 411 files uploading“) bleibt die Zeile in der Leiste
  await page.getByTestId("sync-status").locator(".synced-text").evaluate((el) => { el.textContent = "On this device · 411 files uploading"; });
  const settings = (await tools.getByRole("button", { name: "Settings" }).boundingBox())!;
  expect(settings.x + settings.width).toBeLessThanOrEqual(side.x + side.width);
  await tools.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#appearance|#settings|#prefs/);
});

test("Seitenleiste ausblenden: Knopf in der Kopfzeile, zurück über „Show sidebar“, Taste an der Stelle von \\", async ({ page }) => {
  await ready(page);
  await page.getByTestId("sidebar-hide").click();
  await expect(nav(page)).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(nav(page)).toBeHidden();
  await page.getByTestId("sidebar-show").click();
  await expect(nav(page)).toBeVisible();
  await expect(page.getByTestId("sidebar-hide")).toBeVisible();
  // deutsche Belegung: die Taste an der Stelle von \ liefert „#“
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", code: "Backslash", metaKey: true, bubbles: true })));
  await expect(nav(page)).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Digit7", metaKey: true, altKey: true, shiftKey: true, bubbles: true })));
  await expect(nav(page)).toBeVisible();
});

test("Home kann eine Seite sein: Set as Home, Home öffnet sie, Dashboard bleibt über ⌘K, zurückstellen", async ({ page }) => {
  await ready(page);
  const id = await command<string>(page, { op: "createPage", title: "My start" });
  const row = nav(page).getByRole("treeitem", { name: "My start" });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as Home" }).click();
  await nav(page).getByRole("button", { name: "Chat" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL(new RegExp(`#page-${id}`));
  await expect(nav(page).getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");

  // neuer Tab startet dort; das Dashboard bleibt erreichbar
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search pages").fill("dashboard");
  await page.getByRole("option", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/#home/);

  // Einstellungen zeigen die Wahl; zurück aufs Dashboard über das Seitenmenü
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Use dashboard as Home" }).click();
  await nav(page).getByRole("button", { name: "Chat" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL(/#home/);

  // gewählte Seite im Papierkorb: Home fällt aufs Dashboard zurück
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as Home" }).click();
  await command(page, { op: "trash", ids: [id] });
  await nav(page).getByRole("button", { name: "Chat" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL(/#home/);
});

const openGraph = async (page: Page) => {
  await nav(page).getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
};
const pos = (page: Page, id: string) => page.getByTestId("graph-canvas").evaluate((el, i) => (el as unknown as { __basedGraph: { layoutPosition(id: string): { x: number; y: number } | undefined } }).__basedGraph.layoutPosition(i), id);

test("Graph: kommt eine Seite dazu, bleibt das Bild stehen – nur die neue sucht sich einen Platz", async ({ page }) => {
  await ready(page);
  const hub = await command<string>(page, { op: "createPage", title: "Hub" });
  const leaves: string[] = [];
  for (const t of ["Leaf one", "Leaf two", "Leaf three", "Leaf four"]) leaves.push(await command<string>(page, { op: "createPage", parent: hub, title: t }));
  await openGraph(page);
  const canvas = page.getByTestId("graph-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(6);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });
  const before = await Promise.all([hub, ...leaves].map((id) => pos(page, id)));

  // weg, neue Seite anlegen, wieder hin
  await nav(page).getByRole("button", { name: "Home" }).click();
  const fresh = await command<string>(page, { op: "createPage", parent: leaves[0], title: "Newcomer" });
  await openGraph(page);
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(7);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });
  const after = await Promise.all([hub, ...leaves].map((id) => pos(page, id)));
  after.forEach((p, i) => {
    expect(Math.abs(p!.x - before[i]!.x)).toBeLessThan(0.5);
    expect(Math.abs(p!.y - before[i]!.y)).toBeLessThan(0.5);
  });
  const np = await pos(page, fresh);
  expect(np).toBeTruthy();

  // und auch die neue Seite steht beim nächsten Öffnen sofort an ihrem Platz
  await nav(page).getByRole("button", { name: "Home" }).click();
  await openGraph(page);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 2000 });
  const again = await pos(page, fresh);
  expect(Math.abs(again!.x - np!.x)).toBeLessThan(0.5);
});
