import { expect, test, type Page } from "@playwright/test";
import { blockEditor, focusEditorEnd } from "./editor-helpers.js";

// BSD-373: Side Peek – Breite am linken Rand ziehen (Grenzen, pro Gerät gemerkt, Doppelklick = Standard) und Esc
// schließt ihn in der Reihenfolge Menü/Popover → Blockauswahl → Peek, auch mit dem Fokus in der Ansicht dahinter.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function openPeek(page: Page, row: string) {
  await page.getByRole("gridcell", { name: new RegExp(`^${row}`) }).hover();
  await page.getByRole("button", { name: `Open ${row}` }).click();
  await expect(page.getByTestId("row-peek")).toBeVisible();
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "seedDatabase", count: 5 });
  await page.getByRole("treeitem", { name: "Big 5" }).click();
}

const peekBox = (page: Page) => page.locator("dialog:has(.row-peek-body)").boundingBox();

test("Side Peek: Breite ziehen, Grenzen, pro Gerät gemerkt, Doppelklick setzt zurück", async ({ page }) => {
  await setup(page);
  await openPeek(page, "Row 2");
  // Drawer ist eingefahren (Breite und Lage stehen)
  await expect.poll(async () => { const d = (await peekBox(page))!; return Math.round(d.x + d.width); }).toBe(1280);
  const before = (await peekBox(page))!;
  const handle = page.getByTestId("row-peek-resize");
  /** Zieht den Griff von seiner Mitte um dx (negativ = nach links = breiter). */
  const drag = async (toX: (center: number) => number) => {
    await page.waitForTimeout(250); // Breitenwechsel des Drawers abgeschlossen
    const b = (await handle.boundingBox())!;
    const cx = b.x + b.width / 2;
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(toX(cx), 400, { steps: 8 });
    await page.mouse.up();
  };
  const h = (await handle.boundingBox())!;
  expect(Math.abs(h.x + h.width / 2 - before.x), "Griff am linken Rand").toBeLessThanOrEqual(6);
  await drag((cx) => cx - 150);
  await expect.poll(async () => Math.round((await peekBox(page))!.width)).toBe(Math.round(before.width + 150));
  // Höchstens 90 % des Fensters
  await drag(() => 0);
  await expect.poll(async () => Math.round((await peekBox(page))!.width)).toBe(Math.round(1280 * 0.9));
  // Mindestbreite
  await drag(() => 1270);
  await expect.poll(async () => Math.round((await peekBox(page))!.width)).toBe(420);
  // gemerkt (pro Gerät im localStorage; der Workspace selbst überlebt das Neuladen in WebKit nur mit festem Profil):
  // schließen, wieder öffnen
  expect(await page.evaluate(() => localStorage.getItem("based.peekWidth"))).toBe("420");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-peek")).toHaveCount(0);
  await openPeek(page, "Row 3");
  await expect.poll(async () => Math.round((await peekBox(page))!.width)).toBe(420);
  // Doppelklick: zurück zur Standardbreite
  await page.getByTestId("row-peek-resize").dblclick();
  await expect.poll(async () => Math.round((await peekBox(page))!.width)).toBe(Math.round(before.width));
});

test("Esc schließt den Peek: aus dem Titel, nach der Blockauswahl im Editor, mit Fokus in der Tabelle", async ({ page }) => {
  await setup(page);
  const peek = page.getByTestId("row-peek");
  // Titel
  await openPeek(page, "Row 2");
  await page.getByLabel("Row title").click();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  // Editor: erstes Esc = Blockauswahl, zweites schließt
  await openPeek(page, "Row 2");
  await focusEditorEnd(peek);
  await page.keyboard.type("Hello");
  await page.keyboard.press("Escape");
  await expect(blockEditor(peek).locator(".bx2-block[data-selected]")).toHaveCount(1);
  await expect(peek).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  // Slash-Menü offen: Esc schließt erst das Menü
  await openPeek(page, "Row 3");
  await focusEditorEnd(peek);
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await expect(peek).toBeVisible();
  // Fokus in der Tabelle dahinter
  await page.getByRole("gridcell", { name: /^Row 1/ }).click();
  await page.keyboard.press("Escape"); // Zelleneditor
  await page.keyboard.press("Escape"); // Zellauswahl
  await page.keyboard.press("Escape"); // Peek
  await expect(peek).toHaveCount(0);
});
