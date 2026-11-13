import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ADR 0016: neuer Block-Editor (Schalter „New editor“). Prüft Elijas Meldungen vom 13.11.: Griff an der ersten
// Zeile, Klick auf ⋮⋮ verschiebt nichts, Ziehen stabil (auch in Spalten), Blockauswahl; dazu Tippen, Enter, ⌫,
// Markdown-Kürzel, Tab, Slash-Menü, Undo und dass alles nach dem Neuladen da ist.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function newPage(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "Editor test" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  return id;
}

const editor = (page: Page) => page.getByTestId("block-editor");
const fields = (page: Page) => editor(page).locator("[data-editable-id]");
const blockTypes = (page: Page) => editor(page).locator(".bx2-block").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type));
const texts = (page: Page) => fields(page).evaluateAll((els) => els.map((e) => e.textContent ?? ""));

async function startTyping(page: Page) {
  await editor(page).getByTestId("block-editor-tail").click();
  await expect(fields(page).first()).toBeFocused();
}

test("Tippen, Enter, Markdown-Kürzel, ⌫ zusammenführen, Undo, Neuladen", { tag: "@smoke" }, async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("# Plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // leerer Listenpunkt → Text
  await page.keyboard.type("[] buy milk");
  expect(await blockTypes(page)).toEqual(["heading1", "bulletedList", "bulletedList", "todo"]);
  expect(await texts(page)).toEqual(["Plan", "one", "two", "buy milk"]);

  // ⌫ am Anfang: To-do → Text → mit „two“ zusammenführen
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect(await texts(page)).toEqual(["Plan", "one", "twobuy milk"]);
  // Cursor steht an der Naht: Tippen landet dort
  await page.keyboard.type("|");
  expect(await texts(page)).toEqual(["Plan", "one", "two|buy milk"]);

  await page.keyboard.press("ControlOrMeta+z");
  expect(await texts(page)).toEqual(["Plan", "one", "twobuy milk"]);
});

test("Nach dem Neuladen ist alles da (dauerhaftes Profil, Records über den Store-Worker)", async ({ playwright, browserName, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "based-blockeditor-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
    await newPage(page);
    await startTyping(page);
    await page.keyboard.type("## Kept");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- after reload");
    await page.waitForTimeout(600);
    await page.reload();
    await expect(editor(page)).toBeVisible();
    await expect.poll(() => texts(page)).toEqual(["Kept", "after reload"]);
    expect(await blockTypes(page)).toEqual(["heading2", "bulletedList"]);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tab rückt ein, ⇧Tab aus; Pfeile wechseln zwischen Blöcken", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("parent");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  await expect(editor(page).locator('.bx2-block .bx2-children [data-editable-id]')).toHaveText("child");
  await page.keyboard.type("!");
  await expect(editor(page).locator('.bx2-children [data-editable-id]')).toHaveText("child!");
  await page.keyboard.press("Shift+Tab");
  await expect(editor(page).locator(".bx2-children")).toHaveCount(0);
  // ↑ hält die x-Position: „child!“ endet etwa unter dem „t“ von „parent“
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  expect(await texts(page)).toEqual(["parentX", "child!"]);
});

test("Griff sitzt an der ersten Zeile jedes Blocktyps; Klick darauf verschiebt nichts und öffnet das Blockmenü", { tag: "@smoke" }, async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  for (const line of ["# Title", "Text", "- Bullet", "[] Todo"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Backspace");
  const blocks = editor(page).locator(".bx2-block");
  const n = await blocks.count();
  for (let i = 0; i < n; i++) {
    const block = blocks.nth(i);
    await block.locator(".bx2-row").hover();
    const handle = block.locator(":scope > .bx2-gutter [data-handle]");
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    // erste Textzeile des Felds
    const line = await block.locator("[data-editable-id]").evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const first = r.getClientRects()[0] ?? el.getBoundingClientRect();
      return { top: first.top, height: first.height };
    });
    expect(Math.abs(hb.y + hb.height / 2 - (line.top + line.height / 2))).toBeLessThanOrEqual(3);
  }
  // Klick auf ⋮⋮: Seite bewegt sich nicht, Blockmenü öffnet, Block ist ausgewählt
  const scroller = await editor(page).evaluate((el) => { let p = el.parentElement; while (p && getComputedStyle(p).overflowY !== "auto" && getComputedStyle(p).overflowY !== "scroll") p = p.parentElement; return p ? p.scrollTop : 0; });
  const second = blocks.nth(1);
  const before = (await second.boundingBox())!;
  await second.locator(".bx2-row").hover();
  await second.locator(":scope > .bx2-gutter [data-handle]").click();
  await expect(page.getByTestId("block-menu")).toBeVisible();
  await expect(second).toHaveAttribute("data-selected", "");
  const after = (await second.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  const scroller2 = await editor(page).evaluate((el) => { let p = el.parentElement; while (p && getComputedStyle(p).overflowY !== "auto" && getComputedStyle(p).overflowY !== "scroll") p = p.parentElement; return p ? p.scrollTop : 0; });
  expect(scroller2).toBe(scroller);
});

async function dragHandle(page: Page, from: number, to: { x: number; y: number }) {
  const block = editor(page).locator(".bx2-block").nth(from);
  await block.locator(".bx2-row").hover();
  const h = (await block.locator(":scope > .bx2-gutter [data-handle]").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 20, h.y + 10, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("Ziehen am Griff: davor/danach, Spalte rechts daneben und wieder heraus", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  for (const t of ["Alpha", "Beta", "Gamma"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Backspace");
  // Gamma vor Alpha
  const alpha = (await fields(page).nth(0).boundingBox())!;
  await dragHandle(page, 2, { x: alpha.x + 40, y: alpha.y + 3 });
  await expect.poll(() => texts(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  // Beta rechts neben Gamma → Spalten
  const gamma = editor(page).locator(".bx2-block").nth(0).locator(".bx2-row");
  const gb = (await gamma.boundingBox())!;
  await dragHandle(page, 2, { x: gb.x + gb.width - 8, y: gb.y + gb.height / 2 });
  await expect(editor(page).locator(".bx2-columns .bx2-column")).toHaveCount(2);
  await expect(editor(page).locator(".bx2-column").nth(1)).toContainText("Beta");
  // Beta aus der Spalte unter Alpha ziehen → Spalten lösen sich auf
  const alphaRow = editor(page).locator('.bx2-block:has(> .bx2-row [data-editable-id]:text-is("Alpha"))');
  const ab = (await alphaRow.boundingBox())!;
  const betaIndex = await editor(page).locator(".bx2-block").evaluateAll((els) => els.findIndex((e) => e.querySelector(":scope > .bx2-row")?.textContent === "Beta"));
  await dragHandle(page, betaIndex, { x: ab.x + 40, y: ab.y + ab.height - 3 });
  await expect(editor(page).locator(".bx2-columns")).toHaveCount(0);
  await expect.poll(() => texts(page)).toEqual(["Gamma", "Alpha", "Beta"]);
});

test("Blockauswahl: Esc, ⇧↓, Rechteck aus dem Rand, Ziehen über Blöcke, ⌫ löscht", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  for (const t of ["one", "two", "three", "four"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Backspace");
  const selected = () => editor(page).locator(".bx2-block[data-selected]").evaluateAll((els) => els.map((e) => e.querySelector("[data-editable-id]")?.textContent));
  await page.keyboard.press("Escape");
  expect(await selected()).toEqual(["four"]);
  await page.keyboard.press("Shift+ArrowUp");
  expect(await selected()).toEqual(["three", "four"]);
  await page.keyboard.press("Escape");
  expect(await selected()).toEqual([]);

  // Text-Auswahl aus „one“ nach „two“ ziehen → Blockauswahl
  const one = (await fields(page).nth(0).boundingBox())!;
  const two = (await fields(page).nth(1).boundingBox())!;
  await page.mouse.move(one.x + 5, one.y + one.height / 2);
  await page.mouse.down();
  await page.mouse.move(two.x + 10, two.y + two.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await selected()).toEqual(["one", "two"]);

  // Rechteck aus dem rechten Rand über „three“ und „four“
  const three = (await fields(page).nth(2).boundingBox())!;
  const four = (await fields(page).nth(3).boundingBox())!;
  const ed = (await editor(page).boundingBox())!;
  await page.mouse.move(ed.x + ed.width - 10, three.y - 2);
  await page.mouse.down();
  await page.mouse.move(ed.x + ed.width - 200, four.y + four.height - 2, { steps: 6 });
  await page.mouse.up();
  expect(await selected()).toEqual(["three", "four"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => texts(page)).toEqual(["one", "two"]);
});

test("Slash-Menü: filtern, Pfeile, Enter macht aus dem leeren Block eine Überschrift", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("/heading");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(4);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  expect(await blockTypes(page)).toEqual(["heading2"]);
  await page.keyboard.type("Section");
  expect(await texts(page)).toEqual(["Section"]);
  // Datenbank und Gleichung über das Slash-Menü
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  await expect(editor(page).locator('.bx2-block[data-type="databaseInline"]')).toHaveCount(1);
  await expect(editor(page).locator(".bx2-database").getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/equation");
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "TeX" }).fill("a^2+b^2=c^3");
  // ⌫ im Gleichungsfeld löscht ein Zeichen, nicht den Block
  await page.keyboard.press("Backspace");
  await page.keyboard.type("2");
  await page.keyboard.press("Escape");
  await expect(editor(page).locator('.bx2-block[data-type="equation"] .katex')).toBeVisible();
});

test("Formatierung: ⌘B auf Auswahl, Formatleiste erscheint", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("hello world");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(fields(page).first().locator(".bx2-b")).toHaveText("world");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("!");
  await expect(fields(page).first()).toHaveText("hello world!");
  // **fett** beim Tippen, danach ohne Formatierung weiter
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("say **bold** after");
  await expect(fields(page).nth(1).locator(".bx2-b")).toHaveText("bold");
  await expect(fields(page).nth(1)).toHaveText("say bold after");
  // ⌘B ohne Auswahl: nächste Zeichen fett
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("X");
  await expect(fields(page).nth(1).locator(".bx2-b").last()).toHaveText("X");
});

test("Einfügen aus dem Web: HTML wird zu Blöcken, URL über Auswahl wird Link; ⌘K setzt Link", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.evaluate(() => {
    const el = document.activeElement!;
    const dt = new DataTransfer();
    dt.setData("text/html", "<h2>Pasted title</h2><ul><li>first</li><li>second</li></ul><p>with <b>bold</b></p>");
    dt.setData("text/plain", "Pasted title\nfirst\nsecond\nwith bold");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => blockTypes(page)).toEqual(["heading2", "bulletedList", "bulletedList", "text"]);
  await expect(fields(page).nth(3).locator(".bx2-b")).toHaveText("bold");
  // ⌘K auf markiertem Wort
  await fields(page).nth(0).click();
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("link-popover").getByRole("textbox").fill("https://based.example");
  await page.keyboard.press("Enter");
  await expect(fields(page).nth(0).locator("a")).toHaveAttribute("href", "https://based.example");
  await expect(fields(page).nth(0).locator("a")).toHaveText("title");
});

test("@ erwähnt eine Seite", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("see @Welc");
  const menu = page.getByTestId("mention-menu");
  await expect(menu.getByRole("option", { name: /Welcome to Based/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(fields(page).first().locator(".bx2-mention")).toHaveText("Welcome to Based");
  await page.keyboard.type("now");
  await expect(fields(page).first()).toHaveText("see Welcome to Based now");
});

test("Spaltenbreite ziehen", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  for (const t of ["Left", "Right"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Backspace");
  const left = editor(page).locator(".bx2-block").nth(0).locator(".bx2-row");
  const lb = (await left.boundingBox())!;
  await dragHandle(page, 1, { x: lb.x + lb.width - 8, y: lb.y + lb.height / 2 });
  await expect(editor(page).locator(".bx2-column")).toHaveCount(2);
  const sep = editor(page).locator(".bx2-col-resize");
  const sb = (await sep.boundingBox())!;
  const before = (await editor(page).locator(".bx2-column").first().boundingBox())!.width;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 10);
  await page.mouse.down();
  await page.mouse.move(sb.x + 120, sb.y + 10, { steps: 6 });
  await page.mouse.up();
  const after = (await editor(page).locator(".bx2-column").first().boundingBox())!.width;
  expect(after - before).toBeGreaterThan(80);
  // bleibt (Records) – nach Seitenwechsel
  await page.goBack();
  await page.goForward();
  await expect.poll(async () => (await editor(page).locator(".bx2-column").first().boundingBox())!.width).toBeGreaterThan(before + 80);
});

// Checkliste: Bildschirmfotos des neuen Editors (hell/dunkel, drei Größen) mit allen Grundtypen und Spalten.
for (const theme of ["light", "dark"] as const) {
  test(`Screenshots neuer Editor (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await newPage(page);
    await startTyping(page);
    const lines = ["# Weekly plan", "Notes for the week, with **bold** and `code` inside.", "- First bullet", "Second bullet", "", "1. Numbered", "Next", "", "[] Open task", "", "\" A quote worth keeping", "/call"];
    for (const line of lines) {
      if (line) await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("Callout text");
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-block-editor-${w}x${h}-${theme}.png` });
    }
    // Griff sichtbar am zweiten Block
    await page.setViewportSize({ width: 1280, height: 820 });
    await editor(page).locator(".bx2-block").nth(1).locator(".bx2-row").hover();
    await page.screenshot({ path: `../../docs/design/screens/web-block-editor-handle-${theme}.png` });
  });
}
