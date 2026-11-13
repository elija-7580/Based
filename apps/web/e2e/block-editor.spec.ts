import { expect, test, type Page } from "@playwright/test";
import { blockFixtureOutline, FIXTURE_TABLE_ROWS } from "@based/editor/blocks/fixture";

// BSD-381 (ADR 0016, E0): neuer Block-Editor hinter dem Schalter „New editor“ (Settings → Diagnostics → For
// developers, pro Gerät, Standard aus). Die Testseite (Spalten mit zwei Inline-Datenbanken, Callout, Zitat, Listen,
// Überschriften, lange Tabelle) erscheint in richtiger Reihenfolge und Verschachtelung, direkt aus den Records.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

/** Blöcke im neuen Editor als „Tiefe · Typ“ (Tiefe = Anzahl umgebender Blöcke), wie `outlineOf`. */
const outline = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-editor=blocks] .bx-b[data-block-id]")].map((el) => {
  let depth = 0;
  for (let p = el.parentElement?.closest(".bx-b[data-block-id]"); p; p = p.parentElement?.closest(".bx-b[data-block-id]")) depth++;
  return "  ".repeat(depth) + el.getAttribute("data-block-type");
}));

async function newEditorOn(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/#prefs-diagnostics");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const dev = page.getByTestId("settings-section-diagnostics-dev");
  const sw = dev.getByRole("switch", { name: /New editor/ });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
}

test("Schalter „New editor“: Testseite in Reihenfolge und Verschachtelung, Datenbanken in Spalten, lange Tabelle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" || /ResizeObserver/.test(m.text())) errors.push(m.text()); });
  await newEditorOn(page);
  await command(page, { op: "seedBlockFixture" });
  await page.getByRole("treeitem", { name: "Block editor test page" }).click();
  const doc = page.locator("[data-editor=blocks]");
  await expect(doc).toBeVisible();
  await expect(page.locator(".bx-editor")).toHaveCount(0); // BlockNote ist aus
  await expect.poll(() => outline(page)).toEqual(blockFixtureOutline());
  // Zwei Inline-Datenbanken, je eine in einer Spalte, nebeneinander
  const cols = doc.locator(".bx-b-column");
  await expect(cols).toHaveCount(2);
  for (const [i, n] of [[0, 5], [1, 3]] as const) await expect(cols.nth(i).getByRole("row").filter({ has: page.getByRole("gridcell") })).toHaveCount(n);
  const [a, b] = [(await cols.nth(0).boundingBox())!, (await cols.nth(1).boundingBox())!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  // Lange Tabelle mit Kopfzeile, Texte in Lesereihenfolge
  const table = doc.locator(".bx-b-tablegrid");
  await expect(table.locator("tr")).toHaveCount(FIXTURE_TABLE_ROWS);
  await expect(table.locator("th")).toHaveText(["Week", "Focus", "Notes"]);
  await expect(doc.locator("[data-block-type=heading1]")).toHaveText("Second Brain");
  await expect(doc.locator("[data-block-type=todo]").first()).toHaveClass(/done/);
  // Seite scrollt bis zum Ende, ohne waagrechten Rollbalken im Panel
  await doc.locator("[data-block-type=text]").last().scrollIntoViewIfNeeded();
  await expect(doc.getByText("End of page.")).toBeInViewport();
  expect(await page.evaluate(() => { const p = document.querySelector(".panel"); return p ? p.scrollWidth - p.clientWidth : 0; })).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("Schalter aus: wieder der bisherige Editor; die Wahl gilt pro Gerät und übersteht das Neuladen", async ({ page }) => {
  await newEditorOn(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.locator("[data-editor=blocks]")).toBeVisible();
  await expect(page.locator("[data-editor=blocks] [data-block-type=todo]")).toHaveCount(4);
  await page.goto("/#prefs-diagnostics");
  await page.getByTestId("settings-section-diagnostics-dev").getByRole("switch", { name: /New editor/ }).click();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.locator(".bx-editor .bn-editor[contenteditable=true]")).toBeVisible();
  await expect(page.locator("[data-editor=blocks]")).toHaveCount(0);
});
