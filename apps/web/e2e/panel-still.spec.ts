import { expect, test, type Page } from "@playwright/test";

// Elija 14.11.: Mit dem Trackpad ließ sich die ganze Inhaltsfläche (Kopfzeile + Seite) seitlich verschieben. Ursache:
// der Editor ragt mit seinem Griffrand über die Fläche hinaus, und ein schräges Wischen rollte sie über scrollBy
// seitlich, obwohl sie `overflow-x: hidden` hat. Jetzt: kein seitlicher Überhang mehr, scrollBy nur in erlaubten
// Richtungen, und ein Versatz wird sofort zurückgesetzt.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function longPage(page: Page, width: number) {
  await page.setViewportSize({ width, height: 760 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Still" }));
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
  for (let i = 0; i < 30; i++) { await page.keyboard.type(`Line ${i}`); await page.keyboard.press("Enter"); }
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  await expect(page.locator(".dbui-table").first()).toBeVisible();
  await page.keyboard.press("Escape");
}

const panel = (page: Page) => page.locator(".panel");

for (const width of [900, 1100, 1280]) {
  test(`Inhaltsfläche hat keinen seitlichen Überhang (${width} px)`, async ({ page }) => {
    await longPage(page, width);
    const m = await panel(page).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
  });
}

test("schräges Wischen und Code verschieben die Fläche nicht seitlich", async ({ page }) => {
  await longPage(page, 1100);
  await panel(page).evaluate((el) => el.scrollTo(0, 300));
  await page.mouse.move(700, 400);
  // senkrecht anfangen (Geste rastet an der Fläche ein), dann schräg weiter
  await page.mouse.wheel(0, 40);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(60, 3);
  await page.waitForTimeout(150);
  expect(await panel(page).evaluate((el) => el.scrollLeft)).toBe(0);
  // auch ein Versatz von außen (scrollIntoView, Fokus) bleibt nicht stehen
  await panel(page).evaluate((el) => { el.scrollLeft = 40; el.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => panel(page).evaluate((el) => el.scrollLeft)).toBe(0);
  // senkrecht rollt die Fläche weiter
  const top = await panel(page).evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => panel(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(top);
});

for (const width of [900, 1100]) {
  test(`Library: Filterleiste bricht um statt überzustehen (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto("/#library");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByRole("button", { name: /Sort:/ })).toBeVisible();
    const m = await panel(page).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
  });
}
