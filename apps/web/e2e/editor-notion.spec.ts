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
  await page.keyboard.press("End");
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
  // jeder Eintrag hat ein Icon, das Menü bleibt im Fenster
  expect(await menu.locator("[role=menuitem] .bx-menu-icon").count()).toBeGreaterThanOrEqual(7);
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
