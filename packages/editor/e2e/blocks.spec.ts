// BSD-154: alle Blocktypen aus dem Swift-Korpus im Browser, „Copy and sync“, Erwähnungen.
import { expect, test, type Page } from "@playwright/test";

type Rec = { kind: string; data: Record<string, unknown> & { id: string; type: string; parent: string } };
const records = (page: Page): Promise<Rec[]> => page.evaluate(() => JSON.parse(localStorage.getItem("based-e2e-records") ?? "[]"));
const editor = (page: Page) => page.locator(".bx-editor .bn-editor").first();
const settled = (page: Page) => page.waitForTimeout(400);

test("Korpus: jeder Blocktyp erscheint, nichts wird beim Öffnen geschrieben, neu laden → identisch", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?reset=1&corpus=1&page=p-root");
  await expect(editor(page).locator("[data-content-type]").first()).toBeVisible();
  const before = JSON.stringify(await records(page));
  await settled(page);
  for (const type of ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote",
    "callout", "divider", "codeBlock", "equation", "image", "video", "audio", "file", "embed", "toc", "breadcrumb", "columnList",
    "column", "table", "database", "page", "linkToPage", "syncedBlock", "button", "opaque"]) {
    await expect(editor(page).locator(`[data-content-type="${type}"]`).first(), type).toBeAttached();
  }
  await expect(editor(page).getByTestId("equation").first()).toHaveText("\\int_0^1 x^2\\,dx");
  await expect(editor(page).locator(".bx-mention[data-kind=page]").first()).toContainText("Startseite");
  expect(JSON.stringify(await records(page))).toBe(before);
  const text = await editor(page).innerText();
  await page.goto("/?page=p-root");
  await expect(editor(page).locator("[data-content-type]").first()).toBeVisible();
  await settled(page);
  expect(await editor(page).innerText()).toBe(text);
  expect(JSON.stringify(await records(page))).toBe(before);
  expect(errors).toEqual([]);
});

test("Copy and sync: Synced Block auf einer anderen Seite einfügen und dort bearbeiten", async ({ page, browserName }) => {
  await page.goto("/?reset=1");
  const block = editor(page).locator(".bn-block-content", { hasText: "Zweiter Absatz" }).first();
  await block.hover();
  await page.locator(".bn-side-menu [draggable=true]").first().click();
  await page.getByRole("menuitem", { name: "Copy and sync" }).click();
  await expect(editor(page).locator(".bx-synced")).toBeVisible();
  await settled(page);
  const recs = await records(page);
  const synced = recs.find((r) => r.data.type === "syncedBlock")!;
  expect(synced.data.parent).toBe("b:p-test");
  expect(recs.find((r) => r.data.id === "t-2")!.data.parent).toBe("b:" + synced.data.id);
  // Auf der anderen Seite einfügen (Zwischenablage; WebKit ohne Clipboard-Berechtigung: Text direkt einfügen)
  await page.goto("/?page=p-other");
  const other = editor(page).locator(".bn-block-content", { hasText: "Text auf der anderen Seite" }).first();
  await other.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  if (browserName === "chromium") await page.keyboard.press("ControlOrMeta+v");
  else {
    await page.evaluate((id) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "based-sync:" + id);
      document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, synced.data.id);
  }
  const copy = editor(page).locator(".bx-synced[data-copy=true]");
  await expect(copy).toBeVisible();
  await expect(copy).toContainText("Zweiter Absatz");
  // In der Kopie schreiben ändert das Original
  await copy.locator(".bn-block-content", { hasText: "Zweiter Absatz" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" synchron");
  await settled(page);
  await page.goto("/?page=p-test");
  await expect(editor(page).locator(".bx-synced").first()).toContainText("Zweiter Absatz synchron");
});

test("@-Erwähnung einer Seite", async ({ page }) => {
  await page.goto("/?reset=1");
  await editor(page).locator(".bn-block-content", { hasText: "Erster Absatz" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" siehe @Andere");
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Andere Seite" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await settled(page);
  const t1 = (await records(page)).find((r) => r.data.id === "t-1")!;
  expect(t1.data.text).toEqual([{ t: "Erster Absatz siehe " }, { t: "Andere Seite", mention: { page: { _0: "p-other" } } }, { t: " " }]);
  await editor(page).locator(".bx-mention[data-kind=page]").click();
  await expect(editor(page).locator(".bn-block-content", { hasText: "Text auf der anderen Seite" })).toBeVisible();
});
