import { expect, test, type Page } from "@playwright/test";

// BSD-225: „Ask AI“ im Editor mit der Skript-Engine (kein Netz): Leertaste auf leerer Zeile → schreiben → Insert
// (ein Undo-Schritt); Auswahl → Formatleiste „Ask AI“ → Make shorter → Replace selection.

async function useScript(page: Page, turns: Record<string, unknown>[][]) {
  await page.waitForFunction(() => "__basedChat" in globalThis);
  await page.evaluate((s) => (globalThis as unknown as { __basedChat: { useScript(s: unknown, d: number): void } }).__basedChat.useScript(s, 0), turns);
}

async function newPage(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  const editor = page.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  return editor;
}

test("Leertaste auf leerer Zeile: AI schreibt, Insert fügt ein, ⌘Z nimmt es in einem Schritt zurück", async ({ page }) => {
  const editor = await newPage(page);
  await useScript(page, [[{ text: "- Sunscreen\n- Tram tickets" }]]);
  await page.keyboard.press("Space");
  const box = page.getByTestId("ai-box");
  await expect(box).toBeVisible();
  await box.getByLabel("Ask AI").fill("Packing list for Lisbon");
  await page.keyboard.press("Enter");
  await expect(box.getByTestId("ai-preview")).toHaveText("- Sunscreen\n- Tram tickets");
  await box.getByRole("button", { name: "Insert" }).click();
  await expect(box).toBeHidden();
  await expect(editor.locator("[data-content-type='bulletListItem']")).toHaveCount(2);
  await expect(editor).toContainText("Tram tickets");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("[data-content-type='bulletListItem']")).toHaveCount(0);
});

test("Auswahl → Ask AI → Make shorter → Replace selection; Discard lässt alles stehen", async ({ page }) => {
  const editor = await newPage(page);
  await page.keyboard.type("This sentence is much longer than it needs to be.");
  await useScript(page, [[{ text: "Short sentence." }], [{ text: "Unused." }]]);
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const box = page.getByTestId("ai-box");
  await box.getByRole("button", { name: "Make shorter" }).click();
  await expect(box.getByTestId("ai-preview")).toHaveText("Short sentence.");
  await box.getByRole("button", { name: "Replace selection" }).click();
  await expect(editor).toContainText("Short sentence.");
  await expect(editor).not.toContainText("much longer");

  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Ask AI" }).click();
  await box.getByLabel("Ask AI").fill("Translate");
  await page.keyboard.press("Enter");
  await expect(box.getByTestId("ai-preview")).toHaveText("Unused.");
  await box.getByRole("button", { name: "Discard" }).click();
  await expect(box).toBeHidden();
  await expect(editor).toContainText("Short sentence.");
});
