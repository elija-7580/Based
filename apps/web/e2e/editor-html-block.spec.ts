import { expect, test } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";

// HTML-Codeblock „nur Ergebnis“ (wie Notions HTML-Block): Bildschirmfotos für docs/design/screens/
// (BASED_SCREENSHOTS=1, Chromium): web-editor-html-block-<größe>-<theme>.png, dazu Leiste beim Überfahren und Vollansicht.
// Das Verhalten selbst prüft block-editor.spec.ts „HTML-Codeblock: …“.

const HTML = `<style>.card{padding:16px;border-radius:14px;background:color-mix(in srgb, currentColor 7%, transparent)}button{font:inherit;padding:6px 12px;border-radius:999px;border:0;background:currentColor}button span{color:Canvas}</style>
<div class="card"><h3 style="margin:0 0 6px">Habit tracker</h3><p style="margin:0 0 10px">Glasses of water today: <b id="n">3</b></p><button onclick="n.textContent=+n.textContent+1"><span>Add one</span></button></div>`;

test("Bildschirmfotos: HTML-Block", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Habits");
  await page.keyboard.press("Enter");
  await page.keyboard.type("A small widget, written as HTML and shown as part of the page.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, HTML);
  await blockEditor(page).locator(".bx2-code-lang-btn").click();
  await page.getByLabel("Search languages").fill("html");
  await page.keyboard.press("Enter");
  await page.getByLabel("Page title").click();
  const wrap = blockEditor(page).getByTestId("code-block");
  await expect(wrap).toHaveAttribute("data-code-hidden", "");
  await page.waitForTimeout(800);
  const url = page.url();
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
      await page.goto(url);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(page.frameLocator("iframe.bx-html-preview").locator("h3")).toHaveText("Habit tracker");
      await page.mouse.move(4, 4);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-html-block-${w}x${h}-${theme}.png` });
      if (w !== 1280) continue;
      await wrap.hover();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-html-block-tools-${w}x${h}-${theme}.png` });
      await wrap.getByTestId("code-view-split").click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-html-block-split-${w}x${h}-${theme}.png` });
      await wrap.getByTestId("code-view-preview").click();
      await wrap.hover();
      await wrap.getByTestId("code-full").click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-html-block-full-${w}x${h}-${theme}.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    }
  }
});
