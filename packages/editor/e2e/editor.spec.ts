// BSD-154: Editor im Browser – tippen, Slash-Menü, Block ziehen, über Blöcke markieren, kopieren/einfügen,
// neu laden → identisch. Läuft auf Chromium und WebKit.
import { expect, test, type Page } from "@playwright/test";

type Rec = { kind: string; data: { id: string; type: string; parent: string; sk: string; text?: unknown; props?: Record<string, unknown>; trashedAt?: number } };

async function records(page: Page): Promise<Rec[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("based-e2e-records") ?? "[]"));
}

/** Kinder einer Seite in Reihenfolge, als [Typ, Text]. */
async function children(page: Page, pageID = "p-test"): Promise<[string, string][]> {
  const recs = (await records(page)).filter((r) => r.kind === "block" && r.data.parent === "b:" + pageID && r.data.trashedAt === undefined);
  recs.sort((a, b) => (a.data.sk < b.data.sk ? -1 : a.data.sk > b.data.sk ? 1 : a.data.id < b.data.id ? -1 : 1));
  const plain = (t: unknown) => (typeof t === "string" ? t : Array.isArray(t) ? t.map((r: { t?: string }) => r.t ?? "").join("") : "");
  return recs.map((r) => [r.data.type, plain(r.data.text)]);
}

const editor = (page: Page) => page.locator(".bx-editor .bn-editor").first();
const block = (page: Page, text: string) => editor(page).locator(".bn-block-content", { hasText: text }).first();

async function open(page: Page, query = "?reset=1") {
  await page.goto("/" + query);
  await expect(block(page, "Erster Absatz")).toBeVisible();
}

/** Warten, bis die Records geschrieben sind (Editor sammelt kurz). */
async function settled(page: Page) {
  await page.waitForTimeout(400);
}

test("tippen und neu laden → identisch", async ({ page }) => {
  await open(page);
  await block(page, "Zweiter Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" mit mehr Text");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Neuer Absatz");
  await settled(page);
  const before = await children(page);
  expect(before).toEqual([
    ["text", "Erster Absatz"], ["text", "Zweiter Absatz mit mehr Text"], ["text", "Neuer Absatz"], ["text", "Dritter Absatz"],
  ]);
  const html = await editor(page).innerText();
  await page.goto("/");
  await expect(block(page, "Neuer Absatz")).toBeVisible();
  expect(await editor(page).innerText()).toBe(html);
  expect(await children(page)).toEqual(before);
});

test("Slash-Menü: Überschrift, Callout, To-do", async ({ page }) => {
  await open(page);
  await block(page, "Dritter Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/heading 2");
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Heading 2" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Kapitel");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/callout");
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Callout" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Wichtig");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] Aufgabe");
  await settled(page);
  const kids = await children(page);
  expect(kids.slice(3)).toEqual([["heading2", "Kapitel"], ["callout", "Wichtig"], ["todo", "Aufgabe"]]);
  await page.goto("/");
  await expect(block(page, "Wichtig")).toBeVisible();
  expect(await children(page)).toEqual(kids);
  await expect(editor(page).locator("h2", { hasText: "Kapitel" })).toBeVisible();
});

test("Block ziehen", async ({ page }) => {
  await open(page);
  const source = block(page, "Dritter Absatz");
  await source.hover();
  const handle = page.locator(".bn-side-menu [draggable=true]").first();
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const target = (await block(page, "Erster Absatz").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 3; i++) await page.mouse.move(h.x + h.width / 2 + i * 4, h.y + h.height / 2);
  for (let i = 1; i <= 10; i++) await page.mouse.move(target.x + 40, h.y + ((target.y + 3) - h.y) * (i / 10));
  await page.mouse.up();
  await settled(page);
  expect((await children(page)).map((c) => c[1])).toEqual(["Dritter Absatz", "Erster Absatz", "Zweiter Absatz"]);
  await page.goto("/");
  await expect(block(page, "Erster Absatz")).toBeVisible();
  const texts = await editor(page).locator(".bn-block-content").allInnerTexts();
  expect(texts.slice(0, 3)).toEqual(["Dritter Absatz", "Erster Absatz", "Zweiter Absatz"]);
});

test("über Blöcke markieren, kopieren und einfügen", async ({ page }) => {
  await open(page);
  const first = block(page, "Erster Absatz");
  const second = block(page, "Zweiter Absatz");
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await second.click({ modifiers: ["Shift"] });
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("ControlOrMeta+c");
  await block(page, "Dritter Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+v");
  await settled(page);
  const kids = (await children(page)).map((c) => c[1]);
  expect(kids).toEqual(["Erster Absatz", "Zweiter Absatz", "Dritter Absatz", "Erster Absatz", "Zweiter Absatz"]);
  // über Blöcke markieren und löschen
  await block(page, "Zweiter Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await settled(page);
  const after = (await children(page)).map((c) => c[1]);
  expect(after).toEqual(["Erster Absatz", "Zweiter Absatz", "Erster Absatz", "Zweiter Absatz"]);
  await page.goto("/");
  await expect(block(page, "Erster Absatz")).toBeVisible();
  expect((await children(page)).map((c) => c[1])).toEqual(after);
});

test("Undo nimmt nur eigene Änderungen zurück", async ({ page }) => {
  await open(page);
  await block(page, "Erster Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" lokal");
  await settled(page);
  // Änderung von außen (wie Sync): anderer Absatz
  await page.evaluate(() => {
    const store = (window as unknown as { __based: { store: { setText(id: string, t: string): void } } }).__based.store;
    store.setText("t-3", "Dritter Absatz von außen");
  });
  await expect(block(page, "von außen")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await settled(page);
  expect((await children(page)).map((c) => c[1])).toEqual(["Erster Absatz", "Zweiter Absatz", "Dritter Absatz von außen"]);
});
