// BSD-407 Teil 3: gemeinsame Griffe für den Block-Editor (ADR 0016), der jetzt Standard ist. Ein Editor ist
// `getByTestId("block-editor")`, jeder Block `.bx2-block[data-block-id][data-type]`, jedes Textfeld
// `[data-editable-id]` (ein eigenes contenteditable pro Block).
import { expect, type Locator, type Page } from "@playwright/test";

type Scope = Page | Locator;

/** Der (erste) Block-Editor in `scope` – Seite oder z. B. Side Peek. */
export const blockEditor = (scope: Scope): Locator => scope.getByTestId("block-editor").first();
/** Textfelder der Blöcke in Dokumentreihenfolge. */
export const editorFields = (scope: Scope): Locator => blockEditor(scope).locator("[data-editable-id]");
/** Block nach ID. */
export const editorBlock = (scope: Scope, id: string): Locator => blockEditor(scope).locator(`.bx2-block[data-block-id="${id}"]`);
/** Blöcke eines Typs (Record-Typ, z. B. `bulletedList`, `databaseInline`, `image`). */
export const editorBlocksOfType = (scope: Scope, type: string): Locator => blockEditor(scope).locator(`.bx2-block[data-type="${type}"]`);

/** Editor sichtbar und bearbeitbar (er hat die Fläche unter dem letzten Block). */
export async function expectEditable(scope: Scope): Promise<void> {
  await expect(blockEditor(scope)).toBeVisible();
  await expect(blockEditor(scope).getByTestId("block-editor-tail")).toHaveCount(1);
}

/**
 * Schreibmarke ans Ende der Seite: Klick unter den letzten Block (wie in Notion). Ist der letzte Block leerer Text,
 * landet sie dort, sonst entsteht ein neuer leerer Absatz. Danach tippt `page.keyboard` in dieses Feld.
 */
export async function focusEditorEnd(scope: Scope): Promise<void> {
  // Oben in die Fläche klicken: ihre Höhe wächst auf langen Seiten (BSD-344), die Oberkante bleibt am letzten Block.
  await blockEditor(scope).getByTestId("block-editor-tail").click({ position: { x: 40, y: 12 } });
  await expect(blockEditor(scope).locator("[data-editable-id]:focus")).toHaveCount(1);
}

/** Text in die Seite einfügen wie ⌘V (Klartext, Markdown wird zu Blöcken) – ins fokussierte Feld. */
export async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
