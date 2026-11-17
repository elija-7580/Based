import { expect, test, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// Elija 17.11.: ⌘A und Ziehen wie in Notion – ausgewählt werden nur die Blöcke der Seite, nie Titel, Metazeile,
// Kopfzeile, Backlinks oder die Seitenleiste; von der Oberfläche lässt sich nichts markieren oder kopieren.

const selectedText = (page: Page) => page.evaluate(() => (getSelection()?.toString() ?? "").trim());
const selectedBlocks = (page: Page) => blockEditor(page).locator(".bx2-block[data-selected]");

async function pageWithLines(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expectEditable(page);
  await page.getByLabel("Page title").fill("Wiki");
  await focusEditorEnd(page);
  for (const l of ["first line", "second line", "third line"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
}

test("⌘A neben dem Text wählt alle Blöcke der Seite – keinen Titel, keine Metazeile, nichts von der Oberfläche", { tag: "@smoke" }, async ({ page }) => {
  await pageWithLines(page);
  // Fokus aus dem Text nehmen: Klick auf die Metazeile (kein Eingabefeld)
  await page.locator(".meta-line").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(selectedBlocks(page)).toHaveCount(await blockEditor(page).locator(".bx2-block").count());
  expect(await selectedBlocks(page).count()).toBeGreaterThanOrEqual(3);
  expect(await selectedText(page)).toBe("");
  // Kopieren nimmt die Blöcke, nicht „Edited just now“
  await page.keyboard.press("Escape");
  await expect(selectedBlocks(page)).toHaveCount(0);
});

test("im Titel: erstes ⌘A markiert den Titel, das zweite die Blöcke", async ({ page }) => {
  await pageWithLines(page);
  const title = page.getByLabel("Page title");
  await title.click();
  await page.keyboard.press("ControlOrMeta+a");
  expect(await title.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, 4, 4]);
  await expect(selectedBlocks(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  expect(await selectedBlocks(page).count()).toBeGreaterThanOrEqual(3);
});

test("im Text bleibt es wie bisher: erst der Block, dann alle Blöcke", async ({ page }) => {
  await pageWithLines(page);
  await blockEditor(page).getByText("second line").click();
  await page.keyboard.press("ControlOrMeta+a");
  expect(await selectedText(page)).toBe("second line");
  await page.keyboard.press("ControlOrMeta+a");
  expect(await selectedBlocks(page).count()).toBeGreaterThanOrEqual(3);
});

test("ohne Seite (Home, Einstellungen) markiert ⌘A nichts; Felder behalten ihr ⌘A", async ({ page }) => {
  await page.goto("/#home");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.locator("body").click({ position: { x: 700, y: 300 } });
  await page.keyboard.press("ControlOrMeta+a");
  expect(await selectedText(page)).toBe("");
  await page.goto("/#prefs-sync");
  await page.getByLabel("Server URL").fill("https://example.org");
  await page.keyboard.press("ControlOrMeta+a");
  expect(await page.getByLabel("Server URL").evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 19]);
  await page.getByRole("heading", { name: "Sync & server" }).click();
  await page.keyboard.press("ControlOrMeta+a");
  // nichts von der Seite kommt dazu (manche Browser zählen die Markierung im Feld weiter mit)
  expect(await selectedText(page)).not.toContain("Sync & server");
  expect(await selectedText(page)).not.toContain("Status");
});

test("Kopfzeile, Metazeile und Backlinks lassen sich nicht markieren (Ziehen, Doppelklick)", async ({ page }) => {
  await pageWithLines(page);
  for (const sel of [".meta-line", ".topbar", ".sidebar"]) {
    expect(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).userSelect || (getComputedStyle(el) as unknown as { webkitUserSelect: string }).webkitUserSelect), sel).toBe("none");
  }
  await page.locator(".meta-line span").first().dblclick();
  expect(await selectedText(page)).toBe("");
  // von der Metazeile bis unter den Text ziehen: Blöcke werden ausgewählt, kein Text der Oberfläche
  const meta = (await page.locator(".meta-line").boundingBox())!;
  const last = (await blockEditor(page).getByText("third line").boundingBox())!;
  await page.mouse.move(meta.x + meta.width - 5, meta.y + 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 40, last.y + last.height + 30, { steps: 8 });
  await page.mouse.up();
  expect(await selectedBlocks(page).count()).toBeGreaterThanOrEqual(3);
  expect(await selectedText(page)).not.toContain("Edited");
});
