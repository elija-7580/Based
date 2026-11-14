// BSD-319: Beispielbündel für replay.spec.ts erzeugen (nur auf Wunsch: BASED_RECORD_SAMPLE=1).
//   BASED_RECORD_SAMPLE=1 pnpm --filter @based/web exec playwright test e2e/replay/record-sample.spec.ts
// Schreibt e2e/replay/bundles/blocks-typing-basics-<engine>.json (Block-Editor) und typing-basics-<engine>.json (alter
// Editor) – so, wie ⇧⌘B es am Mac speichert (Text ersetzt).
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { editor, legacyTest, openNewLegacyPage, openNewPage, ready, test } from "./fixture.js";
import { settle } from "./replay.js";

test.skip(!process.env.BASED_RECORD_SAMPLE, "nur zum Erzeugen des Beispielbündels");
legacyTest.skip(!process.env.BASED_RECORD_SAMPLE, "nur zum Erzeugen des Beispielbündels");
// Nach jeder Taste wie ⇧Home/End warten, bis der Editor die Auswahl übernommen hat – wie ein Mensch und wie die
// Wiedergabe (settle in replay.ts); sonst hängt das Ergebnis (fett oder nicht) vom Zufall ab.
// Je Engine ein Bündel: Tastenbelegung (Home/End, ⌘/Strg) folgt der Engine, also wird in derselben wiedergegeben.

const NOTE = "Sample: typing, bold, list, heading, paste, click and backspace";

/** Tippen, ⇧Home + ⌘B, Liste, Überschrift, Einfügen, Klick in „Second item“, ⌫⌫, „!“. */
async function sample(page: Page, clickSecond: () => Promise<void>) {
  await page.keyboard.type("Hello world");
  await page.keyboard.press("Shift+Home");
  await settle(page);
  await page.keyboard.press("ControlOrMeta+b");
  await settle(page);
  await page.keyboard.press("End");
  await settle(page);
  await page.keyboard.press("Enter");
  await settle(page);
  await page.keyboard.type("- First item");
  await page.keyboard.press("Enter");
  await settle(page);
  await page.keyboard.type("Second item");
  await page.keyboard.press("Enter");
  await settle(page);
  await page.keyboard.press("Enter");
  await settle(page);
  await page.keyboard.type("# Heading");
  await page.keyboard.press("Enter");
  await settle(page);
  await page.keyboard.type("Pasted: ");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "from the clipboard");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await clickSecond();
  await page.keyboard.press("End");
  await settle(page);
  await page.keyboard.press("Backspace");
  await settle(page);
  await page.keyboard.press("Backspace");
  await settle(page);
  await page.keyboard.type("!");
  await page.waitForTimeout(400);
  return page.evaluate((note) => (globalThis as unknown as { __basedReport: { bundle(n: string): unknown } }).__basedReport.bundle(note), NOTE);
}

const write = (name: string, bundle: unknown) => writeFileSync(new URL(`./bundles/${name}.json`, import.meta.url), JSON.stringify(bundle, null, 1) + "\n");

test("Beispielbündel Block-Editor", async ({ page, browserName }) => {
  await ready(page);
  await openNewPage(page, "Sample");
  write(`blocks-typing-basics-${browserName}`, await sample(page, () => editor(page).locator("[data-editable-id]", { hasText: "Second item" }).click()));
});

legacyTest("Beispielbündel alter Editor", async ({ page, browserName }) => {
  await ready(page);
  await openNewLegacyPage(page, "Sample");
  write(`typing-basics-${browserName}`, await sample(page, () => page.locator(".bn-inline-content", { hasText: "Second item" }).click()));
});
