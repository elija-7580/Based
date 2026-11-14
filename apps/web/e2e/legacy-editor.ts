// BSD-407 Teil 3: Der Block-Editor (ADR 0016) ist Standard. Specs, die Funktionen prüfen, die nur der alte Editor
// (BlockNote) hat, pinnen ihn ausdrücklich mit diesem Helfer – jede Datei, die ihn nutzt, steht in
// docs/editor-parity.md unter „noch BlockNote“ (Liste für Teil 4: BlockNote löschen).
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** Schlüssel des Notausgangs (apps/web/src/shell/storage.ts `legacyEditorPref`). */
export const LEGACY_EDITOR_KEY = "based.legacyEditor";

/** Alten Editor für diese Seite/diesen Kontext setzen, bevor die App lädt. */
export async function pinLegacyEditor(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((key) => localStorage.setItem(key, "true"), LEGACY_EDITOR_KEY);
}

/**
 * Für alle Tests der Datei (oder des `describe`): alter Editor. Auf oberster Ebene oder im `describe` aufrufen;
 * Dateien mit eigenem `test` (z. B. dauerhaftes Profil) geben ihn mit, damit dessen `page` gepinnt wird.
 */
export function useLegacyEditor(t: { beforeEach: (fn: (args: { page: Page }) => Promise<void>) => void } = test): void {
  t.beforeEach(async ({ page }) => {
    await pinLegacyEditor(page);
    // Hat ein äußeres beforeEach die App schon geladen, gilt der Schalter erst nach einem Neuladen.
    if (page.url() !== "about:blank") {
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    }
  });
}
