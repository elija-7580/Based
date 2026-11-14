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
  await expect(menu.getByRole("option")).toHaveCount(8); // Heading 1–3, Toggle heading 1–3, Section, Table of contents
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
  // Die Erwähnung zählt ihre Textlänge (wie im Kern): Pfeile springen über sie, ⌫ nimmt sie als Ganzes
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await expect(fields(page).first()).toHaveText("see Welcome to Based");
  await page.keyboard.press("Backspace");
  await expect(fields(page).first().locator(".bx2-mention")).toHaveCount(0);
  await expect(fields(page).first()).toHaveText("see");
  await page.keyboard.type("!");
  await expect(fields(page).first()).toHaveText("see !");
});

test("Titel ↔ Text: Enter im Titel legt die erste Zeile an, ↑ in der ersten Zeile geht in den Titel", async ({ page }) => {
  await newPage(page);
  const title = page.getByLabel("Page title");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(fields(page).first()).toBeFocused();
  await page.keyboard.type("First line");
  await page.keyboard.press("ArrowUp");
  await expect(title).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(fields(page).first()).toBeFocused();
});

test("Blockmenü: Farbe, Code-Sprache, Callout-Icon, einfache Tabelle, Datum per @", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("Colored");
  await page.keyboard.press("Escape");
  await editor(page).locator(".bx2-block").first().locator(".bx2-grip").click();
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Color" }).click();
  await page.getByTestId("block-menu").getByRole("menuitemradio", { name: "Red background" }).click();
  await expect(editor(page).locator(".bx2-block").first().locator(".bx2-row")).toHaveClass(/bx2-color-redBackground/);

  // Code-Sprache
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("```");
  await page.keyboard.type("print(1)");
  await editor(page).locator(".bx2-code-lang-btn").click();
  await page.getByLabel("Search languages").fill("pyth");
  await page.keyboard.press("Enter");
  await expect(editor(page).locator(".bx2-code-lang-btn")).toHaveText("Python");

  // Callout-Icon
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Note");
  await editor(page).getByRole("button", { name: "Change icon" }).click();
  await page.getByRole("dialog", { name: "Choose an icon" }).getByRole("textbox").fill("rocket");
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("button", { name: "Change icon" })).toHaveText("🚀");

  // Tabelle
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/simple table");
  await page.keyboard.press("Enter");
  const cell = editor(page).getByRole("textbox", { name: "Row 1, column 1" });
  await cell.click();
  await page.keyboard.type("Name");
  await page.keyboard.press("Enter");
  await expect(cell).toHaveText("Name");
  await editor(page).getByRole("button", { name: "Add row" }).click();
  await expect(editor(page).locator(".bx2-table tr")).toHaveCount(3);
  // Rahmen sichtbar (Farbtoken --line darf nicht von einer Block-Variable überdeckt sein)
  expect(await editor(page).locator(".bx2-table td").first().evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("1px");

  // Datum
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("Due @tod");
  await expect(page.getByTestId("mention-menu").getByRole("option", { name: /Today/ })).toBeVisible();
  await page.getByTestId("mention-menu").getByRole("option", { name: /Today/ }).click();
  await expect(fields(page).last().locator(".bx2-mention")).toHaveText("@Today");
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  if (test.info().project.name === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-block-editor-embeds-1280x820-light.png" });
});

test("⌘⌥-Kürzel, Textfarbe, Spalten per Slash, Toggle-Überschrift, Syntax-Hervorhebung", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("Shortcut");
  await page.keyboard.press("Meta+Alt+Digit2");
  await expect(editor(page).locator(".bx2-block").first()).toHaveAttribute("data-type", "heading2");
  await page.keyboard.press("Meta+Alt+Digit0");
  await expect(editor(page).locator(".bx2-block").first()).toHaveAttribute("data-type", "text");

  // Textfarbe über die Formatleiste
  await page.keyboard.press("Shift+Home");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  await page.getByTestId("format-bar").getByRole("button", { name: "Text color" }).click();
  await page.getByTestId("format-bar").getByRole("menuitem", { name: "Blue", exact: true }).click();
  await expect(fields(page).first().locator(".bx2-color-blue")).toHaveText("Shortcut");

  // 3 Spalten
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/3 col");
  await page.keyboard.press("Enter");
  await expect(editor(page).locator(".bx2-column")).toHaveCount(3);
  await page.keyboard.type("left");
  await expect(editor(page).locator(".bx2-column").first().locator("[data-editable-id]")).toHaveText("left");

  // Toggle-Überschrift zu- und aufklappen
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/toggle heading 2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Section");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Inside");
  const head = editor(page).locator('.bx2-block[data-type="heading2"]').last();
  await expect(head.locator(".bx2-children [data-editable-id]")).toHaveText("Inside");
  await head.locator(":scope > .bx2-row .bx2-toggle").click();
  await expect(head.locator(".bx2-children")).toHaveCount(0);
  await page.keyboard.press("Meta+Alt+KeyT");
  await expect(head.locator(".bx2-children [data-editable-id]")).toHaveText("Inside");

  // Syntax-Hervorhebung
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("```");
  await page.keyboard.type("const x = 1 // note");
  await editor(page).locator(".bx2-code-lang-btn").last().click();
  await page.getByLabel("Search languages").fill("javascript");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("bx2-syn-keyword"))).toBe(true);
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

// BSD-407 (Parität mit dem alten Editor): Suchfeld im Blockmenü – filtert, Enter führt den ersten Treffer aus,
// Escape leert erst und schließt dann, ↓ geht in die Liste; „Copy as Markdown“ kopiert die Blöcke.
test("Blockmenü: Suchfeld filtert, Enter führt aus, Copy as Markdown", async ({ page, browserName }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("## Heading two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Some text here");
  await expect.poll(() => texts(page)).toEqual(["Heading two", "Some text here"]);
  const menu = page.getByTestId("block-menu");
  const search = menu.getByRole("textbox", { name: "Search actions" });
  const openMenu = async () => {
    const first = editor(page).locator(".bx2-block").first();
    await first.locator(".bx2-row").hover();
    await first.locator(":scope > .bx2-gutter [data-handle]").click();
    await expect(search).toBeFocused();
  };
  await openMenu();
  await page.keyboard.type("cop");
  await expect(menu.getByRole("menuitem")).toHaveText([/Copy link to block/, /Copy as Markdown/, /Copy and sync/]);
  expect(await texts(page)).toEqual(["Heading two", "Some text here"]); // getippt wurde ins Feld
  await page.keyboard.press("Escape"); // erst das Feld leeren …
  await expect(search).toHaveValue("");
  await expect(menu.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await page.keyboard.type("zzz");
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
  await expect(menu.getByText("No actions")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.type("dup");
  await page.keyboard.press("Enter");
  await expect.poll(() => texts(page)).toEqual(["Heading two", "Heading two", "Some text here"]);
  await expect(menu).toHaveCount(0);
  // beim nächsten Öffnen ist das Feld leer; ↓ geht in die Liste, Escape schließt
  await openMenu();
  await expect(search).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Copy as Markdown (Zwischenablage nur in Chromium lesbar)
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openMenu();
  await page.keyboard.type("markdown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  if (browserName === "chromium") await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("## Heading two");
});

// BSD-407 Checkliste: Blockmenü mit Suchfeld in drei Größen, hell und dunkel; nichts läuft aus dem Fenster.
test("Blockmenü-Fotos: Suchfeld, gefiltert, leer", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Fotos nur einmal (die Bedienung prüft der Test oben in beiden Browsern)");
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("A heading to open the block menu on");
  await expect(page.getByTestId("save-status").or(page.getByText("Edited just now").first())).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(editor(page)).toBeVisible();
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const menu = page.getByTestId("block-menu");
      const first = editor(page).locator(".bx2-block").first();
      await first.locator(".bx2-row").hover();
      await first.locator(":scope > .bx2-gutter [data-handle]").click();
      await expect(menu.getByRole("textbox", { name: "Search actions" })).toBeFocused();
      const box = (await menu.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(h + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(w + 1);
      const shot = async (name: string) => {
        await page.waitForTimeout(200);
        if (browserName === "chromium" && process.env.BASED_SCREENSHOTS === "1") await page.screenshot({ path: `../../docs/design/screens/web-block-editor-menu-${name}-${theme}-${w}x${h}.png` });
      };
      await shot("open");
      await page.keyboard.type("co");
      await shot("filtered");
      await page.keyboard.type("zzz");
      await expect(menu.getByText("No actions")).toBeVisible();
      await shot("empty");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  }
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});

// BSD-407 Teil 2b: „Move to“ (Blockmenü, ⌘⇧P) in eine andere Seite, „Turn into page“ (Blockmenü, ⌘⌥9).
test("Blockmenü: Move to in eine andere Seite, Turn into page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await newPage(page);
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Target page" }));
  await expect(page.getByRole("treeitem", { name: "Target page", exact: true })).toBeVisible();
  await startTyping(page);
  await page.keyboard.type("Stays here");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Moves away");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sub idea");
  await expect.poll(() => texts(page)).toEqual(["Stays here", "Moves away", "Sub idea"]);
  const menu = page.getByTestId("block-menu");
  const openMenu = async (i: number) => {
    const b = editor(page).locator(".bx2-block").nth(i);
    await b.locator(".bx2-row").hover();
    await b.locator(":scope > .bx2-gutter [data-handle]").click();
    await expect(menu.getByRole("textbox", { name: "Search actions" })).toBeFocused();
  };
  // Move to
  await openMenu(1);
  await page.keyboard.type("move to");
  await page.keyboard.press("Enter");
  const picker = page.getByTestId("block-move");
  await expect(picker).toBeVisible();
  await page.keyboard.type("Target");
  await expect(picker.getByRole("option").first()).toContainText("Target page");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect.poll(() => texts(page)).toEqual(["Stays here", "Sub idea"]);
  // Turn into page
  await openMenu(1);
  await page.keyboard.type("page");
  await page.keyboard.press("Enter");
  await expect.poll(() => blockTypes(page)).toEqual(["text", "page"]);
  await expect(editor(page).locator(".bx2-block").nth(1)).toContainText("Sub idea");
  // ⌘⌥9 im Text
  await editor(page).locator("[data-editable-id]").first().click();
  await page.keyboard.press("ControlOrMeta+Alt+Digit9");
  await expect.poll(() => blockTypes(page)).toEqual(["page", "page"]);
  // Die verschobene Zeile steht auf der Zielseite
  await page.getByRole("treeitem", { name: "Target page", exact: true }).click();
  await expect(editor(page)).toContainText("Moves away");
  expect(errors).toEqual([]);
});

// BSD-407 Teil 2c: „[[“ öffnet die Seitensuche (nur Seiten, keine Daten) und setzt einen Seitenlink.
test("[[ verlinkt eine Seite", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("see [[Welc");
  const menu = page.getByTestId("mention-menu");
  await expect(menu.getByRole("option", { name: /Welcome to Based/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /Today/ })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(fields(page).first().locator(".bx2-mention")).toHaveText("Welcome to Based");
  await page.keyboard.type(" ok");
  await expect(fields(page).first()).toHaveText("see Welcome to Based ok");
  // einzelne Klammer bleibt Text
  await page.keyboard.type(" [x]");
  await expect(menu).toHaveCount(0);
  await expect(fields(page).first()).toHaveText("see Welcome to Based ok [x]");
});

// BSD-407 Teil 2c: nackte URL in eine leere Zeile wird ein Web-Bookmark; in Text bleibt sie Text.
test("URL einfügen: leere Zeile → Bookmark", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  const pasteText = (t: string) => page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, t);
  await page.keyboard.type("Read ");
  await pasteText("https://example.com/a");
  await expect(fields(page).first()).toHaveText("Read https://example.com/a");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await pasteText("https://example.com/b");
  await expect.poll(() => blockTypes(page)).toEqual(["text", "bookmark"]);
  await expect(editor(page).locator(".bx2-block").nth(1)).toContainText("example.com");
});

// BSD-407 Teil 2d: Web-Bookmark – „Fetch preview“ nur auf Klick und nur mit Abruf der Hülle (hier: Test-Haken).
test("Bookmark: Fetch preview holt Titel und Beschreibung", async ({ page }) => {
  await newPage(page);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __based: { linkPreviewHTML?: (u: string) => Promise<string> } };
    g.__based.linkPreviewHTML = async () => `<html><head><meta property="og:title" content="Calm workspace"><meta property="og:description" content="Pages that stay on your Mac."></head></html>`;
  });
  // der Abruf wird beim Öffnen des Editors festgelegt: Seite einmal wechseln
  await page.getByRole("treeitem", { name: "Welcome to Based", exact: true }).click();
  await page.getByRole("treeitem", { name: "Editor test", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await startTyping(page);
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "https://example.com/calm");
  const card = editor(page).locator(".bx2-bookmark-block");
  await expect(card).toContainText("https://example.com/calm");
  await card.getByRole("button", { name: "Fetch preview" }).click();
  await expect(card.locator(".bx2-bookmark-title")).toHaveText("Calm workspace");
  await expect(card).toContainText("Pages that stay on your Mac.");
  await expect(card.getByRole("button", { name: "Refresh preview" })).toBeVisible();
});

// BSD-407 Teil 2d: Bild per Link – leerer Bildblock nimmt eine Adresse an.
test("Bild per Link", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("/image");
  await page.keyboard.press("Enter");
  const link = editor(page).getByLabel("Image link");
  await expect(link).toBeVisible();
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await link.fill(png);
  await link.press("Enter");
  await expect(editor(page).locator(".bx2-image img")).toHaveAttribute("src", png);
  await expect(link).toHaveCount(0);
});

// BSD-407 Teil 2c: Inline-Gleichung über „/Inline equation“ anlegen, per Klick bearbeiten, leer entfernen.
test("Inline-Gleichung anlegen und bearbeiten", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("Area ");
  await page.keyboard.type("/inline eq");
  await page.keyboard.press("Enter");
  const pop = page.getByTestId("inline-equation");
  await expect(pop.getByRole("textbox", { name: "TeX" })).toBeFocused();
  await page.keyboard.type("\\pi r^2");
  await page.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  const eq = fields(page).first().locator(".bx2-eq");
  await expect(eq).toHaveAttribute("data-tex", "\\pi r^2");
  await expect(eq.locator(".katex")).toBeVisible(); // KaTeX statt TeX-Text
  await expect(fields(page).first()).toContainText("Area ");
  // Klick: bearbeiten
  await eq.click();
  await expect(pop.getByRole("textbox", { name: "TeX" })).toHaveValue("\\pi r^2");
  await pop.getByRole("textbox", { name: "TeX" }).fill("2\\pi r");
  await page.keyboard.press("Enter");
  await expect(eq).toHaveAttribute("data-tex", "2\\pi r");
  // Undo stellt die vorige Fassung her
  await page.keyboard.press("ControlOrMeta+z");
  await expect(fields(page).first().locator(".bx2-eq")).toHaveAttribute("data-tex", "\\pi r^2");
  // leer + Enter entfernt sie
  await fields(page).first().locator(".bx2-eq").click();
  await pop.getByRole("textbox", { name: "TeX" }).fill("");
  await page.keyboard.press("Enter");
  await expect(fields(page).first().locator(".bx2-eq")).toHaveCount(0);
  await expect(fields(page).first()).toHaveText("Area ");
});

// BSD-407 Teil 2d: Embed bekannter Anbieter als iframe, unbekannte Adresse als Karte.
test("Embed: YouTube als iframe, sonst Karte", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("/embed");
  await page.keyboard.press("Enter");
  const field = editor(page).getByLabel("Embed link");
  await field.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await field.press("Enter");
  const frame = editor(page).locator("iframe.bx2-embed-frame");
  await expect(frame).toHaveAttribute("src", /dQw4w9WgXcQ/);
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/embed");
  await page.keyboard.press("Enter");
  await editor(page).getByLabel("Embed link").fill("https://example.com/x");
  await editor(page).getByLabel("Embed link").press("Enter");
  await expect(editor(page).locator(".bx2-bookmark")).toContainText("https://example.com/x");
  await expect(editor(page).locator("iframe")).toHaveCount(1);
});

// BSD-407 Teil 2e: Zeile und Spalte der bearbeiteten Zelle löschen.
test("Tabelle: Zeile und Spalte löschen", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("/simple table");
  await page.keyboard.press("Enter");
  const table = editor(page).locator(".bx2-table");
  const rows = await table.locator("tr").count();
  const cols = await table.locator("tr").first().locator("td, th").count();
  expect(cols).toBeGreaterThan(1);
  await editor(page).getByRole("textbox", { name: "Row 1, column 2" }).click();
  await page.keyboard.type("gone");
  await editor(page).getByRole("button", { name: "Delete column" }).click();
  await expect(table.locator("tr").first().locator("td, th")).toHaveCount(cols - 1);
  await expect(table).not.toContainText("gone");
  await editor(page).getByRole("textbox", { name: "Row 2, column 1" }).click();
  await editor(page).getByRole("button", { name: "Delete row" }).click();
  await expect(table.locator("tr")).toHaveCount(rows - 1);
});

// BSD-407 Teil 2f: „Copy and sync“ macht den Block zum Original; „based-sync:<id>“ einfügen legt eine Kopie an,
// die denselben Inhalt zeigt und bearbeitet.
test("Copy and sync: Original und synchronisierte Kopie", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("Shared line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("After");
  const first = editor(page).locator(".bx2-block").first();
  await first.locator(".bx2-row").hover();
  await first.locator(":scope > .bx2-gutter [data-handle]").click();
  await page.keyboard.type("copy and sync");
  await page.keyboard.press("Enter");
  const synced = editor(page).locator('.bx2-block[data-type="syncedBlock"]');
  await expect(synced).toHaveCount(1);
  await expect(synced).toContainText("Shared line");
  const id = await synced.getAttribute("data-block-id");
  // Auf derselben Seite gibt es keine zweite Kopie (wie Swift): Kopie auf einer anderen Seite
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Other page" }));
  await page.getByRole("treeitem", { name: "Other page", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await startTyping(page);
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "based-sync:" + id);
  await expect(synced).toHaveCount(1);
  await expect(synced).toContainText("Shared line");
  await synced.locator("[data-editable-id]").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(synced.locator("[data-editable-id]").first()).toHaveText("Shared line!");
  // zurück: das Original zeigt die Änderung
  await page.getByRole("treeitem", { name: "Editor test", exact: true }).click();
  await expect(editor(page).locator('.bx2-block[data-type="syncedBlock"] [data-editable-id]').first()).toHaveText("Shared line!");
});

// BSD-407 Teil 2e: HTML-Codeblock zeigt eine Vorschau im abgeschotteten Rahmen (sandbox ohne same-origin, CSP).
test("HTML-Codeblock mit Vorschau", async ({ page }) => {
  await newPage(page);
  await startTyping(page);
  await page.keyboard.type("```");
  await page.keyboard.type("<b>Hi preview</b>");
  await editor(page).locator(".bx2-code-lang-btn").click();
  await page.getByLabel("Search languages").fill("html");
  await page.keyboard.press("Enter");
  const frame = editor(page).locator("iframe.bx-html-preview");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.frameLocator("iframe.bx-html-preview").locator("b")).toHaveText("Hi preview");
});
