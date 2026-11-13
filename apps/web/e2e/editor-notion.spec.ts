import { expect, test as base, type Page } from "@playwright/test";
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
const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();
const titleField = (page: Page) => page.getByRole("textbox", { name: "Page title" });
/** Blöcke der Seite als „typ:text“. */
const blocks = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".bx-editor > .bx-doc .bn-editor .bn-block-content")]
  .map((e) => `${e.getAttribute("data-content-type")}${e.getAttribute("data-level") ?? ""}:${e.querySelector(".bn-inline-content")?.textContent ?? ""}`));

async function open(page: Page, title: string, parent?: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = (await command(page, { op: "createPage", title, ...(parent ? { parent } : {}) })) as string;
  await page.getByRole("treeitem", { name: title, exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
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
  await editor(page).locator(".bn-block-content").first().click();
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
  await editor(page).locator(".bn-block-content").first().click();
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

test("Blockmenü: Kopf mit Blocktyp, Gruppen, Fuß mit Wortzahl", async ({ page }) => {
  await open(page, "Menu");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "## Heading two\n\nSome text here");
  await expect.poll(async () => (await blocks(page)).length).toBeGreaterThan(1);
  await page.waitForTimeout(500); // Einfügen fertig gezeichnet, bevor der Griff gesucht wird
  await editor(page).getByText("Heading two").hover();
  await expect(page.locator(".bn-side-menu [draggable=true]")).toBeVisible();
  await page.locator(".bn-side-menu [draggable=true]").last().click();
  const menu = page.getByRole("menu").first();
  await expect(page.getByTestId("block-menu-head")).toHaveText("Heading 2");
  await expect(page.getByTestId("block-menu-foot")).toContainText("2 words · 11 characters");
  for (const name of ["Turn into", "Color", "Duplicate", "Move to", "Delete", "Copy as Markdown", "Copy and sync"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }
  // jeder Eintrag hat genau ein Icon (aus dem Icon-Satz der App wie im Seitenmenü „…“), das Menü bleibt im Fenster
  expect(await menu.locator("[role=menuitem] :is(.bx-menu-icon, .nf-glyph)").count()).toBeGreaterThanOrEqual(7);
  for (const item of await menu.getByRole("menuitem").all()) expect(await item.locator(":is(.bx-menu-icon, .nf-glyph)").count()).toBe(1);
  // Icons stehen in einer Spalte links, auch bei Einträgen ohne Kürzel (vorher rechtsbündig nach dem Merge)
  const iconX = async (name: string) => (await menu.getByRole("menuitem", { name }).locator(":is(.bx-menu-icon, .nf-glyph)").boundingBox())!.x;
  for (const name of ["Copy as Markdown", "Copy and sync", "Turn into"]) expect(Math.abs((await iconX(name)) - (await iconX("Duplicate"))), name).toBeLessThanOrEqual(1);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(820);
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => blocks(page)).toEqual(["paragraph:Some text here"]);
});

test("Codeblock: Kopierknopf kopiert den Code, die Leiste verschiebt nichts", async ({ page }) => {
  await open(page, "Code");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "```javascript\nconst answer = 42;\n```\n\nafter");
  const code = editor(page).locator("[data-content-type=codeBlock]").first();
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

test("Blockmenü: Suchfeld filtert, Enter führt den ersten Treffer aus", async ({ page }) => {
  await open(page, "Search");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "## Heading two\n\nSome text here");
  await expect.poll(async () => (await blocks(page)).length).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  const openMenu = async () => {
    await editor(page).getByText("Heading two").first().hover();
    await expect(page.locator(".bn-side-menu [draggable=true]")).toBeVisible();
    await page.locator(".bn-side-menu [draggable=true]").last().click();
    await expect(page.getByRole("textbox", { name: "Search actions" })).toBeFocused();
  };
  await openMenu();
  await page.keyboard.type("cop");
  await expect(page.getByRole("menuitem")).toHaveText([/Copy link to block/, /Copy as Markdown/, /Copy and sync/]);
  // getippt wurde ins Feld, nicht in den Text der Seite
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "paragraph:Some text here"]);
  await page.keyboard.press("Escape"); // erst das Feld leeren …
  await expect(page.getByRole("textbox", { name: "Search actions" })).toHaveValue("");
  await expect(page.getByRole("menuitem", { name: "Turn into" })).toBeVisible();
  await page.keyboard.type("zzz");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(page.getByText("No actions")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.type("dup");
  await page.keyboard.press("Enter");
  await expect.poll(() => blocks(page)).toEqual(["heading2:Heading two", "heading2:Heading two", "paragraph:Some text here"]);
  await expect(page.getByRole("textbox", { name: "Search actions" })).toHaveCount(0);
  // beim nächsten Öffnen ist das Feld leer; ↓ geht in die Liste, Escape schließt
  await openMenu();
  await expect(page.getByRole("textbox", { name: "Search actions" })).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[role=menu] [data-active-item]")).toContainText("Turn into");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search actions" })).toHaveCount(0);
});

test("Codeblock: Umbruch aus rollt im Block, bleibt nach dem Neuladen", async ({ page }) => {
  await open(page, "Wrap");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "```javascript\nconst long = '" + "on and ".repeat(40) + "';\n```\n\nafter");
  const code = editor(page).locator("[data-content-type=codeBlock]").first();
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
  await expect(editor(page).locator("[data-content-type=codeBlock]").first()).toHaveAttribute("data-wrap", "false");
});

test("Formatleiste: kompaktes Feld, ganz im Fenster", async ({ page }) => {
  await open(page, "Format");
  await editor(page).locator(".bn-block-content").first().click();
  await page.keyboard.type("x ".repeat(60) + "tail");
  await editor(page).getByText("tail").dblclick({ position: { x: 5, y: 8 } });
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
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await page.waitForTimeout(300);
  }
  expect(await page.evaluate(() => (globalThis as unknown as { __shifts: string[] }).__shifts)).toEqual([]);
});
