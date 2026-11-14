// BSD-319: Beispielbündel für replay.spec.ts erzeugen (nur auf Wunsch: BASED_RECORD_SAMPLE=1).
//   BASED_RECORD_SAMPLE=1 pnpm --filter @based/web exec playwright test e2e/replay/record-sample.spec.ts
// Schreibt e2e/replay/bundles/typing-basics-<engine>.json – so, wie ⇧⌘B es am Mac speichert (Text ersetzt).
import { writeFileSync } from "node:fs";
import { legacyTest as test, openNewPage, ready } from "./fixture.js";
import { settle } from "./replay.js";

test.skip(!process.env.BASED_RECORD_SAMPLE, "nur zum Erzeugen des Beispielbündels");
// Nach jeder Taste wie ⇧Home/End warten, bis der Editor die Auswahl übernommen hat – wie ein Mensch und wie die
// Wiedergabe (settle in replay.ts); sonst hängt das Ergebnis (fett oder nicht) vom Zufall ab.
// Je Engine ein Bündel: Tastenbelegung (Home/End, ⌘/Strg) folgt der Engine, also wird in derselben wiedergegeben.

test("Beispielbündel: tippen, fett, Liste, Auswahl mit der Maus, Einfügen", async ({ page, browserName }) => {
  await ready(page);
  await openNewPage(page, "Sample");
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
  await page.locator(".bn-inline-content", { hasText: "Second item" }).click();
  await page.keyboard.press("End");
  await settle(page);
  await page.keyboard.press("Backspace");
  await settle(page);
  await page.keyboard.press("Backspace");
  await settle(page);
  await page.keyboard.type("!");
  await page.waitForTimeout(400);
  const bundle = await page.evaluate(() => (globalThis as unknown as { __basedReport: { bundle(n: string): unknown } }).__basedReport.bundle("Sample: typing, bold, list, heading, paste, click and backspace"));
  writeFileSync(new URL(`./bundles/typing-basics-${browserName}.json`, import.meta.url), JSON.stringify(bundle, null, 1) + "\n");
});
