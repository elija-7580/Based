import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { useLegacyEditor } from "./legacy-editor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Textbearbeitung wie Notion (12. 11. 2026): Titel ↔ Text mit Enter und Pfeiltasten, Rücktaste macht Überschrift und
// Listenpunkt wieder zu Text, Klick unter den Inhalt, Blockmenü im Stil des Seitenmenüs, Kopierknopf im Codeblock,
// Breadcrumb mit Unterseiten, und: beim Öffnen einer Seite springt der Titel nicht.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-notion-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);
const editor = (page: Page) => blockEditor(page);
/** Alter Editor (gepinnte Tests unten). */
const bnEditor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();
const titleField = (page: Page) => page.getByRole("textbox", { name: "Page title" });
/** Blöcke der Seite als „typ:text“ (Block-Editor; Text heißt wie im alten Editor „paragraph“). */
const blocks = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-testid=block-editor] .bx2-block")]
  .map((e) => `${(e as HTMLElement).dataset.type === "text" ? "paragraph" : (e as HTMLElement).dataset.type}:${e.querySelector("[data-editable-id]")?.textContent ?? ""}`));

async function open(page: Page, title: string, parent?: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = (await command(page, { op: "createPage", title, ...(parent ? { parent } : {}) })) as string;
  await page.getByRole("treeitem", { name: title, exact: true }).click();
  await expect(page.locator("[data-testid=block-editor] [data-testid=block-editor-tail], .bx-editor > .bx-doc .bn-editor[contenteditable=true]").first()).toBeVisible();
  return id;
}

async function paste(page: Page, md: string) {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, md);
}

test("Titel und Text: Enter teilt, ↓ und ↑ wechseln", async ({ page }) => {
  await open(page, "Alpha Beta");
  await titleField(page).click();
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(titleField(page)).toHaveValue("Alpha");
  await expect.poll(() => blocks(page)).toEqual(["paragraph: Beta"]);
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:X Beta"]);
  await page.keyboard.press("ArrowUp");
  await expect(titleField(page)).toBeFocused();
  await page.keyboard.type("!");
  await expect(titleField(page)).toHaveValue("Alpha!");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Y");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:YX Beta"]);
});

test("Enter im Titel nimmt die leere erste Zeile, statt eine weitere anzulegen", async ({ page }) => {
  await open(page, "Empty start");
  await titleField(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("first");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:first"]);
  await expect(titleField(page)).toHaveValue("Empty start");
});

test("Rücktaste am Zeilenanfang macht Überschrift und Listenpunkt zu Text", async ({ page }) => {
  await open(page, "Backspace");
  await focusEditorEnd(page);
  await page.keyboard.type("intro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Head");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:intro", "heading2:Head"]);
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:intro", "paragraph:Head"]);
  await page.waitForTimeout(150); // der umgewandelte Block ist neu gezeichnet, bevor die nächste Taste kommt
  await page.keyboard.press("End");
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");
  await page.keyboard.type("- item");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:intro", "paragraph:Head", "paragraph:item"]);
});

test("Klick unter den Inhalt setzt die Schreibmarke ans Ende", async ({ page }) => {
  await open(page, "Below");
  await focusEditorEnd(page);
  await page.keyboard.type("only line");
  const body = (await page.getByTestId("page-content").boundingBox())!;
  await page.mouse.click(body.x + 200, body.y + body.height + 160);
  await page.keyboard.type("END");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:only line", "paragraph:END"]);
  // die neue Zeile ist leer gewesen: ein zweiter Klick legt keine weitere an
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.mouse.click(body.x + 200, body.y + body.height + 200);
  await page.keyboard.type("Z");
  await expect.poll(() => blocks(page)).toEqual(["paragraph:only line", "paragraph:Z"]);
});

test("Breadcrumb: Klick klappt die Seite mit ihren Unterseiten auf", async ({ page }) => {
  const top = await open(page, "Top page");
  const kids: string[] = [];
  for (let i = 0; i < 7; i++) kids.push((await command(page, { op: "createPage", title: `Kid ${i}`, parent: top })) as string);
  const deep = (await command(page, { op: "createPage", title: "Deep", parent: kids[0] })) as string;
  await page.evaluate((id) => { location.hash = `#page-${id}`; }, deep);
  const nav = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(nav).toContainText("Kid 0");
  await nav.getByRole("button", { name: "Top page" }).click();
  const menu = page.getByTestId("crumb-menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(7); // Seite selbst, fünf Unterseiten, „2 more“
  await menu.getByRole("menuitem", { name: "2 more" }).click();
  await expect(menu.getByRole("menuitem")).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await nav.getByRole("button", { name: "Top page" }).click();
  await page.getByTestId("crumb-menu").getByRole("menuitem", { name: "Kid 4" }).click();
  await expect(titleField(page)).toHaveValue("Kid 4");
  await expect(page.getByTestId("crumb-menu")).toHaveCount(0);
});

test("Beim Öffnen einer Seite springt der Titel nicht", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Layout-Shift-Messung gibt es nur in Chromium");
  await open(page, "One");
  await command(page, { op: "createPage", title: "Two" });
  await page.evaluate(() => {
    const w = globalThis as unknown as { __shifts: string[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { sources?: { node?: Element }[] }[]) {
        for (const s of e.sources ?? []) if (s.node instanceof Element && s.node.closest(".page-head, .page-body")) w.__shifts.push(s.node.className);
      }
    }).observe({ type: "layout-shift" });
  });
  for (const name of ["Two", "One", "Two"]) {
    await page.getByRole("treeitem", { name, exact: true }).click();
    await expect(titleField(page)).toHaveValue(name);
    await expectEditable(page);
    await page.waitForTimeout(300);
  }
  expect(await page.evaluate(() => (globalThis as unknown as { __shifts: string[] }).__shifts)).toEqual([]);
});

// BSD-343: Kurznamen wie „js“, „ts“, „py“ aus Markdown/Notion zeigen die Sprache in der Auswahl (vorher leer).
test("Codeblock: Kurznamen der Sprache zeigen die Sprache in der Auswahl", async ({ page }) => {
  await open(page, "Langs");
  await focusEditorEnd(page);
  await paste(page, "```js\nconst a = 1;\n```\n\n```TS\nlet b: number = 2;\n```\n\n```py\nx = 3\n```\n\n```cobol\nDISPLAY 'X'.\n```");
  const langs = editor(page).locator('.bx2-block[data-type="code"] .bx2-code-lang-btn');
  await expect(langs).toHaveCount(4);
  await expect(langs.nth(0)).toHaveText("JavaScript");
  await expect(langs.nth(1)).toHaveText("TypeScript");
  await expect(langs.nth(2)).toHaveText("Python");
  // Hervorhebung über die CSS Highlight API (kein DOM im Text): das Schlüsselwort ist markiert
  await expect.poll(() => page.evaluate(() => [...((CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get("bx2-syn-keyword") ?? [])].map((r) => r.toString()))).toContain("const");
});

// BSD-407 Teil 6.1: Blockmenü des Block-Editors mit Kopf, Fuß, Icons in einer Spalte, Suche und Untermenüs.
async function openBlockMenu(page: Page, text: string) {
  const block = editor(page).locator(".bx2-block").filter({ has: page.locator(":scope > .bx2-row", { hasText: text }) }).last();
  await block.locator(":scope > .bx2-row").hover();
  await block.locator(":scope > .bx2-gutter [data-handle]").click();
  await expect(page.getByRole("textbox", { name: "Search actions" })).toBeFocused();
}

test("Blockmenü: Kopf mit Blocktyp, Gruppen, Fuß mit Wortzahl", async ({ page }) => {
  await open(page, "Menu");
  await focusEditorEnd(page);
  await paste(page, "## Heading two\n\nSome text here");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "paragraph:Some text here"]);
  await openBlockMenu(page, "Heading two");
  const menu = page.getByTestId("block-menu");
  await expect(page.getByTestId("block-menu-head")).toHaveText("Heading 2");
  await expect(page.getByTestId("block-menu-foot")).toContainText("2 words · 11 characters");
  await expect(page.getByTestId("block-menu-foot")).toContainText("Last edited");
  for (const name of ["Turn into", "Color", "Duplicate", "Move to", "Delete", "Copy as Markdown", "Copy and sync"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }
  // jeder Eintrag hat genau ein Icon (aus dem Icon-Satz der App wie im Seitenmenü „…“), das Menü bleibt im Fenster
  expect(await menu.locator("[role=menuitem] .nf-glyph svg").count()).toBeGreaterThanOrEqual(7);
  for (const item of await menu.getByRole("menuitem").all()) expect(await item.locator(".bx2-menu-glyph").count()).toBe(1);
  // Icons stehen in einer Spalte links, auch bei Einträgen ohne Kürzel
  const iconX = async (name: string) => (await menu.getByRole("menuitem", { name }).locator(".bx2-menu-glyph").boundingBox())!.x;
  for (const name of ["Copy as Markdown", "Copy and sync", "Turn into"]) expect(Math.abs((await iconX(name)) - (await iconX("Duplicate"))), name).toBeLessThanOrEqual(1);
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveClass(/bx2-menu-danger/);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(820);
  // Turn into ist ein Untermenü mit Icons; das aktuelle Ziel ist markiert
  await menu.getByRole("menuitem", { name: "Turn into" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Heading 2", exact: true })).toHaveAttribute("aria-checked", "true");
  expect(await menu.locator("[role=menuitemradio] svg.bx-menu-icon").count()).toBeGreaterThanOrEqual(10);
  await menu.getByRole("menuitemradio", { name: "Quote" }).click();
  await expect.poll(() => blocks(page)).toEqual(["quote:Heading two", "paragraph:Some text here"]);
  await openBlockMenu(page, "Heading two");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => blocks(page)).toEqual(["paragraph:Some text here"]);
});

test("Blockmenü: Suchfeld filtert, Enter führt den ersten Treffer aus, Tastatur im Untermenü", async ({ page }) => {
  await open(page, "Search");
  await focusEditorEnd(page);
  await paste(page, "## Heading two\n\nSome text here");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "paragraph:Some text here"]);
  const search = page.getByRole("textbox", { name: "Search actions" });
  await openBlockMenu(page, "Heading two");
  await page.keyboard.type("cop");
  await expect(page.getByRole("menuitem")).toHaveText([/Copy link to block/, /Copy as Markdown/, /Copy and sync/]);
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "paragraph:Some text here"]);
  await page.keyboard.press("Escape"); // erst das Feld leeren …
  await expect(search).toHaveValue("");
  await expect(page.getByRole("menuitem", { name: "Turn into" })).toBeVisible();
  await page.keyboard.type("zzz");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(page.getByText("No actions")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.type("dup");
  await page.keyboard.press("Enter");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "heading2:Heading two", "paragraph:Some text here"]);
  await expect(search).toHaveCount(0);
  // ↓ geht in die Liste (erster Eintrag „Turn into“), → öffnet das Untermenü, Enter wählt, Escape schließt
  await openBlockMenu(page, "Some text");
  await expect(search).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Turn into" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "heading2:Heading two", "heading1:Some text here"]);
  await openBlockMenu(page, "Some text");
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});

// BSD-408: Das Blockmenü bleibt offen, wenn sich die Seitenliste ändert (Editor zeichnet neu).
test("Blockmenü bleibt offen, wenn der Editor neu zeichnet", async ({ page }) => {
  await open(page, "Stable");
  await focusEditorEnd(page);
  await paste(page, "## Heading two\n\nSome text here");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "paragraph:Some text here"]);
  await openBlockMenu(page, "Heading two");
  const search = page.getByRole("textbox", { name: "Search actions" });
  await page.keyboard.type("dup");
  for (let i = 0; i < 3; i++) {
    await command(page, { op: "createPage", title: `Other ${i}` });
    await expect(page.getByRole("treeitem", { name: `Other ${i}`, exact: true })).toBeVisible();
  }
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("dup");
  await page.keyboard.press("Enter");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "heading2:Heading two", "paragraph:Some text here"]);
});

// BSD-407 Teil 3: Kopier- und Umbruch-Knopf im Codeblock und die kompakte Formatleiste gibt es bisher nur im alten Editor.
// Gepinnt auf den alten Editor (docs/editor-parity.md, „noch BlockNote“; Liste für Teil 4).
test.describe("alter Editor (BlockNote)", () => {
  useLegacyEditor(test);

  test("Codeblock: Kopierknopf kopiert den Code, die Leiste verschiebt nichts", async ({ page }) => {
    await open(page, "Code");
    await bnEditor(page).locator(".bn-block-content").first().click();
    await paste(page, "```javascript\nconst answer = 42;\n```\n\nafter");
    const code = bnEditor(page).locator("[data-content-type=codeBlock]").first();
    await expect(code).toBeVisible();
    const before = (await code.boundingBox())!;
    await code.hover();
    const copy = code.getByRole("button", { name: "Copy code" });
    await expect(copy).toBeVisible();
    const during = (await code.boundingBox())!;
    expect(during.height).toBe(before.height);
    await copy.click();
    await expect(code.getByRole("button", { name: /Copied|Couldn’t copy/ })).toBeVisible();
    // der Knopf gehört nicht zum Text
    await expect.poll(() => page.evaluate(() => document.querySelector("[data-content-type=codeBlock] code")?.textContent)).toBe("const answer = 42;");
  });

  test("Codeblock: Umbruch aus rollt im Block, bleibt nach dem Neuladen", async ({ page }) => {
    await open(page, "Wrap");
    await bnEditor(page).locator(".bn-block-content").first().click();
    await paste(page, "```javascript\nconst long = '" + "on and ".repeat(40) + "';\n```\n\nafter");
    const code = bnEditor(page).locator("[data-content-type=codeBlock]").first();
    await expect(code).toBeVisible();
    const pre = code.locator("pre");
    expect(await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true); // Standard: umbrochen
    await code.hover();
    const wrap = code.getByRole("button", { name: "Wrap code" });
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    await wrap.click();
    await expect(code).toHaveAttribute("data-wrap", "false");
    await expect(code.getByRole("button", { name: "Wrap code" })).toHaveAttribute("aria-pressed", "false");
    expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth + 50)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); // die Seite rollt nicht
    await page.waitForTimeout(1200); // gespeichert
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(bnEditor(page).locator("[data-content-type=codeBlock]").first()).toHaveAttribute("data-wrap", "false");
  });

  test("Formatleiste: kompaktes Feld, ganz im Fenster", async ({ page }) => {
    await open(page, "Format");
    await bnEditor(page).locator(".bn-block-content").first().click();
    await page.keyboard.type("x ".repeat(60) + "tail");
    await bnEditor(page).getByText("tail").dblclick({ position: { x: 5, y: 8 } });
    const bar = page.locator(".bn-formatting-toolbar");
    await expect(bar).toBeVisible();
    for (const name of ["Bold", "Italic", "Underline", "Strike"]) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.width).toBeLessThan(220);
    await bar.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Bold", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});
