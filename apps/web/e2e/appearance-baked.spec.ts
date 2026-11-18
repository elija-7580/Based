import { expect, test, type Page } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";

// Elija 18.11.: Schrift umgestellt und zurück – im HTML-Ergebnis blieb die andere Schrift stehen. Der Rahmen
// übernimmt Schrift und Tokens als feste Werte und zeichnete nur bei hell/dunkel neu (blocks/hostAppearance.ts).

const frameFont = (page: Page) => page.getByTestId("html-preview").locator("iframe").evaluate((f) => {
  const doc = (f as HTMLIFrameElement).srcdoc;
  return { body: /:where\(body\)\{[^}]*font-family:([^;}]*)/.exec(doc)?.[1] ?? "", ui: /--font-ui:([^;}]*)/.exec(doc)?.[1] ?? "" };
});

test("HTML-Ergebnis folgt Stil und Seitenschrift – auch wieder zurück", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Fonts");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "<p>Plain text and a <button>Button</button></p>");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await blockEditor(page).locator(".bx2-code-lang-btn").click();
  await page.getByLabel("Search languages").fill("html");
  await page.keyboard.press("Enter");
  await page.getByLabel("Page title").click();
  await expect(page.getByTestId("html-preview").locator("iframe")).toBeVisible();
  const start = await frameFont(page);
  expect(start.body).not.toContain("Literata");

  // Stil Bold und zurück, ohne Neuladen (Wurzel-Attribut wie Settings → Appearance)
  const style = (s: string | undefined) => page.evaluate((v) => {
    if (v) document.documentElement.dataset.style = v;
    else delete document.documentElement.dataset.style;
  }, s);
  await style("bold");
  await expect.poll(async () => (await frameFont(page)).body).toContain("Literata");
  await expect.poll(async () => (await frameFont(page)).ui).toContain("Schibsted Grotesk");
  await style(undefined);
  await expect.poll(() => frameFont(page)).toEqual(start);

  // Seitenschrift Serif und zurück
  const pageFont = (f: string) => page.locator(".page[data-font]").evaluate((el, v) => el.setAttribute("data-font", v), f);
  await pageFont("serif");
  await expect.poll(async () => (await frameFont(page)).body).toContain("serif");
  await pageFont("default");
  await expect.poll(() => frameFont(page)).toEqual(start);
});
