import { expect, test, type Page } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";

// BSD-225 / BSD-407 Teil 6.6: „Ask AI“ im Block-Editor mit der Skript-Engine (kein Netz): Leertaste auf leerer Zeile →
// schreiben → Insert (ein Undo-Schritt); Auswahl → Formatleiste „Ask AI“ → Make shorter → Replace selection; /Ask AI.
// Der AI-Schalter (aus) blendet alles aus: e2e/ai-switch.spec.ts.

async function useScript(page: Page, turns: Record<string, unknown>[][]) {
  await page.waitForFunction(() => "__basedChat" in globalThis);
  await page.evaluate((s) => (globalThis as unknown as { __basedChat: { useScript(s: unknown, d: number): void } }).__basedChat.useScript(s, 0), turns);
}

async function newPage(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  const editor = blockEditor(page);
  await expect(editor).toBeVisible();
  await editor.getByTestId("block-editor-tail").click();
  await expect(editor.locator("[data-editable-id]:focus")).toHaveCount(1);
  return editor;
}

test("Leertaste auf leerer Zeile: AI schreibt, Insert fügt ein, ⌘Z nimmt es in einem Schritt zurück", async ({ page }) => {
  const editor = await newPage(page);
  await useScript(page, [[{ text: "- Sunscreen\n- Tram tickets" }]]);
  await page.keyboard.press("Space");
  const box = page.getByTestId("ai-box");
  await expect(box).toBeVisible();
  await expect(box.getByLabel("Ask AI")).toBeFocused();
  await box.getByLabel("Ask AI").fill("Packing list for Lisbon");
  await page.keyboard.press("Enter");
  await expect(box.getByTestId("ai-preview")).toHaveText("- Sunscreen\n- Tram tickets");
  await box.getByRole("button", { name: "Insert" }).click();
  await expect(box).toBeHidden();
  await expect(editor.locator(".bx2-block[data-type=bulletedList]")).toHaveCount(2);
  await expect(editor).toContainText("Tram tickets");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(".bx2-block[data-type=bulletedList]")).toHaveCount(0);
});

test("Auswahl → Ask AI → Make shorter → Replace selection; Discard lässt alles stehen", async ({ page }) => {
  const editor = await newPage(page);
  await page.keyboard.type("This sentence is much longer than it needs to be.");
  await useScript(page, [[{ text: "Short sentence." }], [{ text: "Unused." }]]);
  await page.keyboard.press("Shift+Home");
  await page.getByTestId("format-bar").getByRole("button", { name: "Ask AI" }).click();
  const box = page.getByTestId("ai-box");
  await box.getByRole("button", { name: "Make shorter" }).click();
  await expect(box.getByTestId("ai-preview")).toHaveText("Short sentence.");
  await box.getByRole("button", { name: "Replace selection" }).click();
  await expect(editor).toContainText("Short sentence.");
  await expect(editor).not.toContainText("much longer");

  await editor.locator("[data-editable-id]").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.getByTestId("format-bar").getByRole("button", { name: "Ask AI" }).click();
  await box.getByLabel("Ask AI").fill("Translate");
  await page.keyboard.press("Enter");
  await expect(box.getByTestId("ai-preview")).toHaveText("Unused.");
  await box.getByRole("button", { name: "Discard" }).click();
  await expect(box).toBeHidden();
  await expect(editor).toContainText("Short sentence.");
});

test("/Ask AI im Slash-Menü öffnet das Feld; Escape schließt ohne Änderung", async ({ page }) => {
  const editor = await newPage(page);
  await page.keyboard.type("Intro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/ask");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Ask AI/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const box = page.getByTestId("ai-box");
  await expect(box.getByLabel("Ask AI")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await expect(editor.locator("[data-editable-id]")).toHaveText(["Intro", ""]);
});
