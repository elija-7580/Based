import { expect, test } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-209: /Embed mit einem YouTube-Link zeigt den Inhalt eingebettet (ohne Cookies); unbekannte Seiten bleiben Karte.
// Netzzugriffe auf die Anbieter werden im Test abgefangen.

test("Embed: YouTube eingebettet (ohne Cookies, sandbox)", async ({ page }) => {
  await page.route(/youtube-nocookie\.com/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>video</p>" }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  const editor = blockEditor(page);
  await expectEditable(page);
  await focusEditorEnd(page);

  await page.keyboard.type("/embed");
  await page.getByRole("option", { name: /^Embed/ }).click();
  const field = editor.getByRole("textbox", { name: "Embed link" });
  await field.fill("https://youtu.be/dQw4w9WgXcQ");
  await field.press("Enter");
  const frame = editor.locator("iframe.bx2-embed-frame");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);

  // Unbekannte Seiten bleiben eine Link-Karte: editor-parity.spec.ts (URL einfügen → Embed, example.com).
});
