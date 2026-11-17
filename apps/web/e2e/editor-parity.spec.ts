import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Editor-Parität: Markdown einfügen → Blöcke, @/[[-Erwähnungen mit Backlinks, schwebende Gliederung, Synced Blocks
// über zwei Seiten. Jeweils auch nach dem Neuladen. Screenshots (hell/dunkel) nur mit BASED_SCREENSHOTS=1 und nur
// in Chromium: docs/design/screens/web-editor-*.png.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

// Jeder Test in einem eigenen, dauerhaften Profil: WebKit hat OPFS nur dort (wie Shell- und Tab-Tests), und die
// Tests laden neu.
const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-editor-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 720 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function createPage(page: Page, title: string): Promise<string> {
  const id = await command(page, { op: "createPage", title });
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
  return id as string;
}

const editor = (page: Page) => blockEditor(page);

/** Block-Editor (Standard seit BSD-407 Teil 3): Seite öffnen, Schreibmarke in eine leere Zeile am Ende. */
async function openBlockPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expectEditable(page);
}
const bxType = (page: Page, type: string) => blockEditor(page).locator(`.bx2-block[data-type="${type}"]`);
const bxField = (page: Page, type: string, text: string) => bxType(page, type).locator("[data-editable-id]", { hasText: text }).first();

/** Einfügen wie aus der Zwischenablage (auch in WebKit, wo Tests die echte nicht lesen dürfen). */
async function paste(page: Page, data: Record<string, string>, opts: { plain?: boolean } = {}) {
  await page.evaluate(({ data, plain }) => {
    const target = document.activeElement!;
    if (plain) target.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { data, plain: opts.plain === true });
}

async function shots(page: Page, browserName: string, name: string) {
  if (!SHOTS || browserName !== "chromium") return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }, theme);
    await page.waitForTimeout(800); // Farbübergänge abwarten
    await page.screenshot({ path: `../../docs/design/screens/web-editor-${name}-${theme}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.colorScheme = "light"; });
}

/** Warten, bis der Editor seine Änderungen an den Store-Worker geschickt hat. */
const settled = (page: Page) => page.waitForTimeout(600);

// Lange Abläufe mit Neuladen; WebKit braucht unter Linux deutlich länger als Chromium.
test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

const MARKDOWN = [
  "# Launch plan",
  "",
  "Ship with **bold** moves, *care*, `code` and a [link](https://example.com/docs).",
  "",
  "- Research",
  "  - Interviews",
  "    - Synthesis",
  "- Build",
  "",
  "1. First",
  "2. Second",
  "",
  "- [x] Kickoff done",
  "- [ ] Launch pending",
  "",
  "> Stay calm and ship.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Owner | Status |",
  "| --- | --- |",
  "| Ada | Ready |",
  "",
  "---",
  "",
  "![Roadmap](https://example.com/roadmap.png)",
].join("\n");

test("Markdown einfügen erzeugt Blöcke, ist ein Undo-Schritt und bleibt nach dem Neuladen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await createPage(page, "Paste target");
  await openBlockPage(page, "Paste target");
  await focusEditorEnd(page);
  await page.keyboard.type("Intro line");
  await settled(page);
  await page.keyboard.press("Enter");
  await paste(page, { "text/plain": MARKDOWN });

  const ed = blockEditor(page);
  const check = async () => {
    await expect(bxType(page, "heading1").locator("[data-editable-id]")).toHaveText("Launch plan");
    const para = bxField(page, "text", "Ship with");
    await expect(para.locator(".bx2-b")).toHaveText("bold");
    await expect(para.locator(".bx2-i")).toHaveText("care");
    await expect(para.locator(".bx2-c")).toHaveText("code");
    await expect(para.locator("a")).toHaveAttribute("href", "https://example.com/docs");
    // Verschachtelung: Research › Interviews › Synthesis
    const research = bxType(page, "bulletedList").filter({ has: page.locator(":scope > .bx2-row [data-editable-id]", { hasText: "Research" }) }).first();
    const interviews = research.locator('.bx2-block[data-type="bulletedList"]').filter({ has: page.locator(":scope > .bx2-row [data-editable-id]", { hasText: "Interviews" }) }).first();
    await expect(interviews).toBeVisible();
    await expect(interviews.locator('.bx2-block[data-type="bulletedList"] [data-editable-id]', { hasText: "Synthesis" })).toBeVisible();
    await expect(bxType(page, "numberedList")).toHaveCount(2);
    await expect(bxType(page, "todo").filter({ hasText: "Kickoff done" }).locator("input[type=checkbox]")).toBeChecked();
    await expect(bxType(page, "todo").filter({ hasText: "Launch pending" }).locator("input[type=checkbox]")).not.toBeChecked();
    await expect(bxType(page, "quote").locator("[data-editable-id]")).toHaveText("Stay calm and ship.");
    const code = bxType(page, "code");
    await expect(code.locator("[data-editable-id]")).toContainText("const answer = 42;");
    await expect(code.locator(".bx2-code-lang-btn")).toHaveText("TypeScript"); // BSD-343: „ts“ wird als TypeScript angezeigt
    const table = bxType(page, "table");
    await expect(table.locator("th")).toHaveText(["Owner", "Status"]);
    await expect(table.locator("td")).toHaveText(["Ada", "Ready"]);
    await expect(bxType(page, "divider")).toHaveCount(1);
    await expect(bxType(page, "image").locator("figure")).toHaveAttribute("data-url", "https://example.com/roadmap.png");
  };
  await check();

  // Ein Undo-Schritt nimmt alles Eingefügte zurück, der Text davor bleibt; Redo bringt es wieder.
  await bxType(page, "quote").locator("[data-editable-id]").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(bxType(page, "heading1")).toHaveCount(0);
  await expect(bxType(page, "table")).toHaveCount(0);
  await expect(bxType(page, "code")).toHaveCount(0);
  await expect(ed.getByText("Intro line")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await check();

  await settled(page);
  await page.reload();
  await openBlockPage(page, "Paste target");
  await check();
  expect(errors).toEqual([]);
});

test("Einfügen: HTML hat Vorrang, ⇧⌘V bleibt Klartext, eine Zeile mit Inline-Markdown landet im Absatz", async ({ page }) => {
  await createPage(page, "Paste rules");
  await openBlockPage(page, "Paste rules");
  const ed = blockEditor(page);
  await focusEditorEnd(page);
  // HTML und Markdown-Text zugleich: HTML gewinnt.
  await paste(page, { "text/html": "<h2>From HTML</h2><p>Body</p>", "text/plain": "# From Markdown" });
  await expect(bxType(page, "heading2").locator("[data-editable-id]")).toHaveText("From HTML");
  await expect(ed.getByText("From Markdown")).toHaveCount(0);

  // Als Klartext einfügen: Markdown-Zeichen bleiben stehen, keine Überschrift, keine Liste.
  await focusEditorEnd(page);
  await paste(page, { "text/plain": "# Not a heading\n- not a list" }, { plain: true });
  await expect(ed.getByText("# Not a heading")).toBeVisible();
  await expect(ed.getByText("- not a list")).toBeVisible();
  await expect(ed.locator('.bx2-block[data-type^="heading"]')).toHaveCount(1);
  await expect(bxType(page, "bulletedList")).toHaveCount(0);

  // Eine Zeile mit Inline-Markdown mitten im Text: bleibt im selben Absatz.
  await focusEditorEnd(page);
  await page.keyboard.type("Before ");
  await paste(page, { "text/plain": "**strong** words" });
  const para = bxField(page, "text", "Before");
  await expect(para).toHaveText("Before strong words");
  await expect(para.locator(".bx2-b")).toHaveText("strong");

  // Mehrzeiliger Klartext ohne Markdown: ein Absatz je Zeile.
  await focusEditorEnd(page);
  await paste(page, { "text/plain": "alpha line\nbeta line\ngamma line" });
  for (const t of ["alpha line", "beta line", "gamma line"]) await expect(bxField(page, "text", t)).toHaveText(t);
});

/** Block mit diesem Text (innerster). */
const blockWith = (page: Page, text: string) => blockEditor(page).locator(".bx2-block", { has: page.locator(":scope > .bx2-row [data-editable-id]", { hasText: text }) }).last();

/** Blockmenü am Block mit diesem Text öffnen (Griff links). */
async function blockMenu(page: Page, text: string) {
  const b = blockWith(page, text);
  await b.locator(":scope > .bx2-row").hover();
  await b.locator(":scope > .bx2-gutter [data-handle]").click();
  await expect(page.getByTestId("block-menu")).toBeVisible();
}

test("Notion-/Google-Docs-HTML einfügen über den Kern-Importer (BSD-211)", async ({ page }) => {
  await createPage(page, "Paste Notion");
  await openBlockPage(page, "Paste Notion");
  await focusEditorEnd(page);
  const html = "<meta charset=\"utf-8\"><h2>Plan</h2><p>Some <span class=\"highlight-red\">red</span> text</p>"
    + "<ul class=\"to-do-list\"><li><div class=\"checkbox checkbox-on\"></div><span>Done thing</span></li></ul>"
    + "<aside><span class=\"icon\">🚀</span><div>Callout text</div></aside><pre><code class=\"language-swift\">let x = 1</code></pre>";
  await paste(page, { "text/html": html, "text/plain": "Plan\nSome red text" });
  await expect(bxType(page, "heading2").locator("[data-editable-id]", { hasText: "Plan" })).toBeVisible();
  await expect(bxType(page, "todo").locator("input[type=checkbox]")).toBeChecked();
  await expect(bxType(page, "callout")).toContainText("Callout text");
  await expect(bxType(page, "callout").getByRole("button", { name: "Change icon" })).toHaveText("🚀");
  await expect(bxType(page, "code").locator(".bx2-code-lang-btn")).toHaveText("Swift");
  await expect.poll(() => page.evaluate(() => [...((CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get("bx2-syn-keyword") ?? [])].map((r) => r.toString()))).toEqual(["let"]);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Paste Notion");
  await expect(bxType(page, "callout")).toContainText("Callout text");
});

const PDF = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

// BSD-407 Teil 6.5: Button-Block im Block-Editor wie im alten Editor (Schritte über runButton/setButton im Kern).
test("Button-Block: Vorlage einfügen, Seite in Datenbank anlegen, Rückfrage, öffnen (BSD-210)", async ({ page }) => {
  await command(page, { op: "createDatabase", title: "Tasks" });
  await createPage(page, "Buttons");
  await openBlockPage(page, "Buttons");
  // Button 1: Insert blocks mit Vorlage
  await focusEditorEnd(page);
  await page.keyboard.type("/Button");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /^Button/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const setup = page.getByRole("group", { name: "Button settings" });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Button name").fill("Add checklist");
  await expect(setup.getByLabel("Step 1", { exact: true })).toHaveValue("insertBlocks");
  await setup.getByRole("button", { name: "Add a block" }).click();
  await expect(setup.getByTestId("button-template").locator("[data-editable-id]")).toBeFocused();
  await page.keyboard.type("Template item");
  await setup.getByRole("button", { name: "Done" }).click();
  await expect(setup).toHaveCount(0);
  const outside = () => blockEditor(page).locator(":scope > .bx2-block [data-editable-id]", { hasText: "Template item" });
  await blockEditor(page).getByRole("button", { name: "Add checklist" }).click();
  await expect(outside()).toHaveCount(1);
  await page.waitForTimeout(450);
  await blockEditor(page).getByRole("button", { name: "Add checklist" }).click();
  await expect(outside()).toHaveCount(2);
  // BSD-419: zwei Klick-Ereignisse derselben Betätigung (kurz hintereinander) laufen nur einmal
  await page.waitForTimeout(450);
  await blockEditor(page).getByRole("button", { name: "Add checklist" }).evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); });
  await expect(outside()).toHaveCount(3);
  await page.waitForTimeout(500);
  await expect(outside()).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(outside()).toHaveCount(2);
  // ein Klick = Undo-Schritt
  await page.keyboard.press("ControlOrMeta+z");
  await expect(outside()).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(outside()).toHaveCount(2);

  // Button 2: Add page to Tasks → Rückfrage → öffnen
  await focusEditorEnd(page);
  await page.keyboard.type("/Button");
  await page.keyboard.press("Enter");
  await expect(setup).toBeVisible();
  await setup.getByLabel("Button name").fill("New task");
  await setup.getByLabel("Step 1", { exact: true }).selectOption("addPage");
  await setup.getByRole("button", { name: "Choose a database…" }).click();
  const dbPicker = page.getByTestId("database-link-picker");
  await dbPicker.getByLabel("Find a database").fill("Tasks");
  await dbPicker.getByRole("option", { name: /Tasks/ }).first().click();
  await expect(setup.getByRole("button", { name: "Tasks" })).toBeVisible();
  await setup.getByLabel("Page name").fill("From button");
  await setup.getByLabel("Page name").blur();
  await setup.getByLabel("Add step").selectOption("confirm");
  await setup.getByLabel("Message").fill("Open it?");
  await setup.getByLabel("Message").blur();
  await setup.getByLabel("Add step").selectOption("openAdded");
  await expect(setup.getByLabel("Step 3", { exact: true })).toHaveValue("openAdded");
  if (SHOTS) await page.screenshot({ path: "../../docs/design/screens/web-block-editor-button-setup-light-1280x720.png" });
  await setup.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(1000);

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Buttons");
  await expect(outside()).toHaveCount(2);
  await blockEditor(page).getByRole("button", { name: "New task" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Confirm" });
  await expect(confirm).toContainText("Open it?");
  await confirm.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("From button");
});

// BSD-407 Teil 4: Die Abläufe, die bis Teil 3 nur der alte Editor (BlockNote) hatte, im Block-Editor – Erwähnungen mit
// Titel live, Backlink und Papierkorb, Gliederung, Synced Block über drei Seiten mit Unsync und Papierkorb-Hinweis,
// Blockmenü- und Auswahl-Abläufe, Toggles, Nummerierung und Spalten, Callout-Icon, Datei-Uploads, Seiten-Optionen.

test("@ erwähnt Seiten: Titel live, Klick navigiert, Backlink sichtbar, Papierkorb markiert", async ({ page }) => {
  const zeppelin = await createPage(page, "Project Zeppelin");
  await createPage(page, "Notes");
  await openBlockPage(page, "Notes");
  await focusEditorEnd(page);
  await page.keyboard.type("See @Zepp");
  await expect(page.getByTestId("mention-menu").getByRole("option", { name: /Project Zeppelin/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const mention = editor(page).locator(".bx2-mention[data-page]").first();
  await expect(mention).toContainText("Project Zeppelin");
  await expect(mention).toHaveAttribute("data-page", zeppelin);

  // Titel live: Umbenennen der Zielseite ändert die Erwähnung
  await command(page, { op: "rename", id: zeppelin, title: "Project Airship" });
  await expect(mention).toContainText("Project Airship");
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Notes");
  await expect(mention).toContainText("Project Airship");

  // Klick navigiert zur Seite; dort steht der Backlink
  await mention.click();
  await expect(page.getByLabel("Page title")).toHaveValue("Project Airship");
  const backlinks = page.getByTestId("backlinks");
  await expect(backlinks).toContainText("1 backlink");
  await backlinks.getByRole("button", { name: "Notes" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Notes");

  // Papierkorb: die Erwähnung ist markiert; nach dem Wiederherstellen nicht mehr
  await command(page, { op: "trash", ids: [zeppelin] });
  await expect(mention).toHaveAttribute("data-trashed", "true");
  await expect(mention).toContainText("in Trash");
  await command(page, { op: "restore", ids: [zeppelin] });
  await expect(mention).not.toHaveAttribute("data-trashed", "true");
});

test("Gliederung: Balken am rechten Rand, Klick scrollt, aktuelle Position, Inhaltsverzeichnis, pro Seite abschaltbar", async ({ page, browserName }) => {
  await createPage(page, "Long read");
  await openBlockPage(page, "Long read");
  await focusEditorEnd(page);
  const filler = (n: number) => Array.from({ length: 14 }, (_, i) => `Paragraph ${n}.${i + 1} of the long read.`).join("\n\n");
  const md = ["# Opening", filler(1), "## Background", filler(2), "### Details", filler(3), "## Results", filler(4), "# Closing", filler(5)].join("\n\n");
  await paste(page, { "text/plain": md });
  const headings = editor(page).locator('.bx2-block[data-type^="heading"]');
  await expect(headings).toHaveCount(5);

  const outline = page.getByTestId("page-outline");
  await expect(outline).toBeVisible();
  const items = outline.getByRole("button");
  await expect(items).toHaveCount(5);
  expect(await outline.locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-depth")))).toEqual(["0", "1", "2", "1", "0"]);
  await page.mouse.move(10, 10);
  await expect(outline.locator(".bx-outline-label").first()).toBeHidden();
  // BSD-346 (wie Notion): ein Balken je Überschrift, kürzer je tiefer die Ebene; der aktuelle hebt sich ab
  const bars = await outline.locator(".bx-outline-bar").evaluateAll((els) => els.map((e) => ({ w: e.getBoundingClientRect().width, bg: getComputedStyle(e).backgroundColor })));
  expect(bars.map((b) => b.w).every((w) => w > 0)).toBe(true);
  expect(bars[0]!.w).toBeGreaterThan(bars[1]!.w);
  expect(bars[1]!.w).toBeGreaterThan(bars[2]!.w);
  expect(bars[4]!.w).toBe(bars[0]!.w);
  const current = await outline.locator("[aria-current] .bx-outline-bar").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bars.filter((b) => b.bg === current)).toHaveLength(1);
  await outline.hover();
  await expect(outline.locator(".bx-outline-label")).toHaveText(["Opening", "Background", "Details", "Results", "Closing"]);
  await shots(page, browserName, "outline");

  // Klick scrollt zur Überschrift und markiert sie; Scrollen von Hand ändert die Markierung
  const results = headings.filter({ hasText: "Results" });
  await expect(results).not.toBeInViewport();
  await items.nth(3).click();
  await expect(results).toBeInViewport();
  await expect(items.nth(3)).toHaveAttribute("aria-current", "location");
  await page.mouse.move(400, 300);
  await headings.filter({ hasText: "Opening" }).scrollIntoViewIfNeeded();
  await expect(items.nth(0)).toHaveAttribute("aria-current", "location");

  // Inhaltsverzeichnis-Block zeigt dieselben Überschriften
  await focusEditorEnd(page);
  await page.keyboard.type("/table of cont");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Table of contents/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const toc = editor(page).locator(".bx2-toc");
  await expect(toc.getByRole("button")).toHaveText(["Opening", "Background", "Details", "Results", "Closing"]);
  await toc.getByRole("button", { name: "Background" }).click();
  await expect(headings.filter({ hasText: "Background" })).toBeInViewport();

  // Pro Seite abschalten (Seitenmenü), bleibt nach dem Neuladen; andere Seiten sind nicht betroffen
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Hide outline" }).click();
  await expect(outline).toHaveCount(0);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Long read");
  await expect(headings).toHaveCount(5);
  await expect(page.getByTestId("page-outline")).toHaveCount(0);
  await openBlockPage(page, "Welcome to Based");
  await expect(page.getByTestId("page-outline")).toBeVisible();
  await openBlockPage(page, "Long read");
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Show outline" }).click();
  await expect(page.getByTestId("page-outline").getByRole("button")).toHaveCount(5);
});

test("Synced Block: zwei Seiten, Bearbeiten in beide Richtungen, zweite Kopie abgelehnt, Unsync, Hinweis bei Original im Papierkorb", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const source = await createPage(page, "Source page");
  await createPage(page, "Mirror page");
  await openBlockPage(page, "Source page");
  await focusEditorEnd(page);
  await page.keyboard.type("Shared launch checklist");
  await settled(page);
  await blockMenu(page, "Shared launch checklist");
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Copy and sync" }).click();
  const original = editor(page).locator('.bx2-block[data-type="syncedBlock"]');
  await expect(original).toContainText("Shared launch checklist");
  const originalID = (await original.getAttribute("data-block-id"))!;
  await settled(page);

  // Auf der zweiten Seite einfügen (Zwischenablage-Text `based-sync:<id>`)
  await openBlockPage(page, "Mirror page");
  await focusEditorEnd(page);
  await page.keyboard.type("Above the copy");
  await page.keyboard.press("Enter");
  await paste(page, { "text/plain": "based-sync:" + originalID });
  const copy = editor(page).locator('.bx2-block[data-type="syncedBlock"]');
  await expect(copy).toContainText("Shared launch checklist");
  await expect(copy.locator(".bx2-synced")).toHaveAttribute("data-synced-copy", "");
  await expect(copy.getByRole("button", { name: "Original in Source page" })).toBeAttached();

  // Derselbe Block ein zweites Mal auf derselben Seite: abgelehnt, mit Hinweis
  await editor(page).locator("[data-editable-id]", { hasText: "Above the copy" }).click();
  await page.keyboard.press("End");
  await paste(page, { "text/plain": "based-sync:" + originalID });
  await expect(page.getByTestId("editor-notice")).toContainText("already on this page");
  await expect(copy).toHaveCount(1);

  // In der Kopie schreiben → erscheint im Original
  await copy.locator("[data-editable-id]", { hasText: "Shared launch checklist" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" – edited in the mirror");
  await settled(page);
  await openBlockPage(page, "Source page");
  await expect(original).toContainText("Shared launch checklist – edited in the mirror");

  // Unsync in der Kopie: der Inhalt bleibt als eigener Synced Block (eigenes Original) und folgt dem alten nicht mehr
  await openBlockPage(page, "Mirror page");
  await copy.hover();
  await copy.getByRole("button", { name: "Unsync" }).click();
  await expect(copy.locator(".bx2-synced")).not.toHaveAttribute("data-synced-copy", "");
  await expect(copy.getByRole("button", { name: "Unsync" })).toHaveCount(0);
  await expect(editor(page).locator("[data-editable-id]", { hasText: "Shared launch checklist – edited in the mirror" })).toBeVisible();
  await settled(page);
  await openBlockPage(page, "Source page");
  await original.locator("[data-editable-id]").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (source only)");
  await settled(page);
  await openBlockPage(page, "Mirror page");
  await expect(editor(page)).not.toContainText("(source only)");

  // Neue Kopie; Original im Papierkorb: die Kopie zeigt einen Hinweis; nach dem Wiederherstellen ist er weg
  await focusEditorEnd(page);
  await paste(page, { "text/plain": "based-sync:" + originalID });
  const mirror = editor(page).locator(".bx2-synced[data-synced-copy]");
  await expect(mirror).toContainText("(source only)");
  await command(page, { op: "trash", ids: [source] });
  await expect(mirror).toHaveAttribute("data-trashed", "true");
  await expect(mirror.locator(".bx2-synced-note")).toContainText("is in the Trash");
  await command(page, { op: "restore", ids: [source] });
  await expect(mirror).not.toHaveAttribute("data-trashed", "true");
  expect(errors).toEqual([]);
});

test("Blockmenü: Turn into Heading 2 und Block equation, Duplicate, ⌘D", async ({ page }) => {
  await createPage(page, "Block actions");
  await openBlockPage(page, "Block actions");
  await focusEditorEnd(page);
  await page.keyboard.type("Launch plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a^2 + b^2 = c^2");
  await settled(page);
  const menu = page.getByTestId("block-menu");
  await blockMenu(page, "Launch plan");
  await menu.getByRole("menuitem", { name: "Turn into" }).click();
  await menu.getByRole("menuitemradio", { name: "Heading 2", exact: true }).click();
  const h2 = editor(page).locator('.bx2-block[data-type="heading2"]', { hasText: "Launch plan" });
  await expect(h2).toHaveCount(1);
  await blockMenu(page, "Launch plan");
  await menu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(h2).toHaveCount(2);
  await h2.nth(1).locator("[data-editable-id]").click();
  await page.keyboard.press("ControlOrMeta+d");
  await expect(h2).toHaveCount(3);

  await blockMenu(page, "a^2 + b^2 = c^2");
  await menu.getByRole("menuitem", { name: "Turn into" }).click();
  await menu.getByRole("menuitemradio", { name: "Block equation" }).click();
  await expect(editor(page).locator('.bx2-block[data-type="equation"] .katex').first()).toBeVisible();
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Block actions");
  await expect(h2).toHaveCount(3);
  await expect(editor(page).locator('.bx2-block[data-type="equation"] .katex').first()).toBeVisible();
});

test("⌘⌥T klappt alle Toggles auf und wieder zu", async ({ page }) => {
  await createPage(page, "Toggles");
  await openBlockPage(page, "Toggles");
  await focusEditorEnd(page);
  for (const t of ["First toggle", "Second toggle"]) {
    await page.keyboard.type("/Toggle list");
    await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Toggle list/i }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type(t);
    await focusEditorEnd(page);
  }
  const buttons = editor(page).locator('.bx2-block[data-type="toggle"] .bx2-toggle');
  await expect(buttons).toHaveCount(2);
  const expanded = () => buttons.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-expanded")));
  // Toggle list kommt offen; einen zuklappen
  await buttons.nth(1).click();
  await expect.poll(expanded).toEqual(["true", "false"]);
  await editor(page).locator("[data-editable-id]", { hasText: "Second toggle" }).click();
  await page.keyboard.press("ControlOrMeta+Alt+KeyT");
  await expect.poll(expanded).toEqual(["true", "true"]);
  await page.keyboard.press("ControlOrMeta+Alt+KeyT");
  await expect.poll(expanded).toEqual(["false", "false"]);
});

test("Esc-Blockauswahl: Pfeile, ⇧↓ erweitern, ⌘D, Löschen, Enter", async ({ page }) => {
  await createPage(page, "Block selection");
  await openBlockPage(page, "Block selection");
  await focusEditorEnd(page);
  for (const t of ["Row one", "Row two", "Row three"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("Row four");
  await settled(page);
  const marked = () => editor(page).locator(".bx2-block[data-selected] > .bx2-row [data-editable-id]").allInnerTexts();
  const field = (t: string) => editor(page).locator("[data-editable-id]", { hasText: t });

  await field("Row two").click();
  await page.keyboard.press("Escape");
  await expect.poll(marked).toEqual(["Row two"]);
  await page.keyboard.press("ArrowUp");
  await expect.poll(marked).toEqual(["Row one"]);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(marked).toEqual(["Row one", "Row two"]);
  await page.keyboard.press("ControlOrMeta+d");
  await expect(field("Row one")).toHaveCount(2);
  await expect(field("Row two")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(field("Row one")).toHaveCount(1);
  await expect.poll(marked).toEqual([]);

  await field("Row four").click();
  await page.keyboard.press("Escape");
  await expect.poll(marked).toEqual(["Row four"]);
  await page.keyboard.press("Enter");
  await expect.poll(marked).toEqual([]);
  await page.keyboard.press("End");
  await page.keyboard.type(" done");
  await expect(field("Row four done")).toBeVisible();
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Block selection");
  await expect(field("Row one")).toHaveCount(1);
  await expect(field("Row four done")).toBeVisible();
});

test("Duplicate kopiert Unterseiten tief", async ({ page }) => {
  await createPage(page, "Deep copy");
  await openBlockPage(page, "Deep copy");
  await focusEditorEnd(page);
  await page.keyboard.type("Nested plan");
  await settled(page);
  await blockMenu(page, "Nested plan");
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Turn into" }).click();
  await page.getByTestId("block-menu").getByRole("menuitemradio", { name: "Page", exact: true }).click();
  const links = editor(page).locator(".bx2-pagelink-title");
  await expect(links).toHaveText(["Nested plan"]);
  await settled(page);
  await links.first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Nested plan");
  await focusEditorEnd(page);
  await page.keyboard.type("Inside the sub-page");
  await settled(page);
  await page.goBack();
  await expect(page.getByLabel("Page title")).toHaveValue("Deep copy");
  const pageBlock = editor(page).locator('.bx2-block[data-type="page"]').first();
  await pageBlock.hover();
  await pageBlock.locator(":scope > .bx2-gutter [data-handle]").click();
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(links).toHaveText(["Nested plan", "Nested plan (1)"]);
  await links.nth(1).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Nested plan (1)");
  await expect(editor(page).getByText("Inside the sub-page")).toBeVisible();
});

test("Nummerierung 1./a./i. und Spalten 4–5 mit ziehbarer Breite", async ({ page }) => {
  await createPage(page, "Fine tuning");
  await openBlockPage(page, "Fine tuning");
  await focusEditorEnd(page);
  await page.keyboard.type("/4 columns");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /4 columns/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const cols = editor(page).locator('.bx2-block[data-type="columnList"] .bx2-column');
  await expect(cols).toHaveCount(4);
  const widths = () => cols.evaluateAll((os) => os.map((o) => Math.round(o.getBoundingClientRect().width)));
  const before = await widths();
  expect(Math.max(...before) - Math.min(...before)).toBeLessThan(3);
  const handle = editor(page).getByRole("separator", { name: "Resize columns" }).first();
  await cols.nth(1).hover();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await widths())[0]! - (await widths())[1]!).toBeGreaterThan(80);
  const kept = await widths();

  await focusEditorEnd(page);
  await page.keyboard.type("1. Top");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Sub");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Deep");
  const marker = (text: string) => blockWith(page, text).locator(":scope > .bx2-row .bx2-marker").first();
  await expect(marker("Top")).toHaveText("1.");
  await expect(marker("Sub")).toHaveText("a.");
  await expect(marker("Deep")).toHaveText("i.");

  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Fine tuning");
  await expect(cols).toHaveCount(4);
  await expect.poll(async () => Math.abs((await widths())[0]! - kept[0]!)).toBeLessThan(4);
});

test("Callout-Icon aus dem Emoji-Picker mit Suche", async ({ page }) => {
  await createPage(page, "Callout icons");
  await openBlockPage(page, "Callout icons");
  await focusEditorEnd(page);
  await page.keyboard.type("/Callout");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Callout/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Remember the milk");
  const icon = editor(page).getByRole("button", { name: "Change icon" });
  await expect(icon).toHaveText("💡");
  await icon.click();
  const picker = page.getByRole("dialog", { name: "Choose an icon" });
  await expect(picker).toBeVisible();
  await picker.getByLabel("Filter emoji").fill("rocket");
  await expect(picker.getByRole("option").first()).toHaveText("🚀");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(icon).toHaveText("🚀");
  await icon.click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(icon).toHaveText("🚀");
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Callout icons");
  await expect(icon).toHaveText("🚀");
  await icon.click();
  await page.getByRole("dialog", { name: "Choose an icon" }).getByRole("button", { name: "Remove" }).click();
  await expect(icon).toHaveText("💡");
});

test("Dateien hochladen: PDF mit Anzeige, Video, Audio und Datei offline", async ({ page }) => {
  await createPage(page, "Uploads");
  await openBlockPage(page, "Uploads");
  for (const [cmd, file, mime, type] of [
    ["/PDF", "plan.pdf", "application/pdf", "pdf"],
    ["/Video", "clip.mp4", "video/mp4", "video"],
    ["/Audio", "sound.mp3", "audio/mpeg", "audio"],
    ["/File", "notes.txt", "text/plain", "file"],
  ] as const) {
    await focusEditorEnd(page);
    await page.keyboard.type(cmd);
    await expect(page.getByTestId("slash-menu").getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    // BSD-450: das Feld genau dieses neuen Blocks nehmen (unter Last stand der Block noch nicht im DOM und `.last()` traf
    // das Feld eines anderen) und warten, bis der Upload durch ist (das Feld verschwindet), bevor der nächste kommt.
    const input = editor(page).locator(`.bx2-block[data-type="${type}"] input[type=file]`);
    await expect(input).toHaveCount(1);
    await input.setInputFiles({ name: file, mimeType: mime, buffer: file.endsWith(".pdf") ? PDF : Buffer.from("based-test-" + file) });
    await expect(input).toHaveCount(0, { timeout: 15_000 });
  }
  const check = async () => {
    await expect(editor(page).locator("object.bx2-pdf-frame")).toHaveAttribute("data", /^blob:/);
    await expect(editor(page).locator("video").last()).toHaveAttribute("src", /^blob:/);
    await expect(editor(page).locator("audio").last()).toHaveAttribute("src", /^blob:/);
    await expect(editor(page).locator('.bx2-block[data-type="file"]', { hasText: "notes.txt" })).toBeVisible();
  };
  await check();
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openBlockPage(page, "Uploads");
  await check();
});

test("Seiten-Optionen: Icon, Schrift, Small text, Full width, Sperre", async ({ page }) => {
  await createPage(page, "Options page");
  await openBlockPage(page, "Options page");
  await page.locator(".page-head").hover();
  await page.getByRole("button", { name: "Add icon" }).click();
  const picker = page.getByRole("dialog", { name: "Choose an icon" });
  await picker.getByLabel("Filter emoji").fill("rocket");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Page icon" })).toHaveText("🚀");

  const article = page.locator("article.page");
  const menu = async () => page.getByRole("button", { name: "Page menu" }).click();
  await menu();
  await page.getByRole("menuitemradio", { name: /Serif/ }).click();
  await expect(article).toHaveAttribute("data-font", "serif");
  await page.getByRole("menuitemcheckbox", { name: /Small text/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Full width/ }).click();
  await expect(article).toHaveAttribute("data-small-text", "");
  await expect(article).toHaveAttribute("data-full-width", "");
  expect(await page.locator(".page-grid").evaluate((g) => g.getBoundingClientRect().width)).toBeGreaterThan(900);
  await page.keyboard.press("Escape");

  await menu();
  await page.getByRole("menuitemcheckbox", { name: /Lock page/ }).click();
  await expect(article).toHaveAttribute("data-locked", "");
  await expect(editor(page).getByTestId("block-editor-tail")).toHaveCount(0);
  await expect(editor(page).locator("[data-editable-id][contenteditable=true]")).toHaveCount(0);
  await expect(page.getByLabel("Page title")).toHaveJSProperty("readOnly", true);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: /Options page/ }).click();
  await expect(page.getByRole("button", { name: "Page icon" })).toHaveText("🚀");
  await expect(article).toHaveAttribute("data-font", "serif");
  await expect(article).toHaveAttribute("data-locked", "");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(article).not.toHaveAttribute("data-locked", "");
  await expectEditable(page);
});

// BSD-407 Teil 4 Checkliste: Synced-Block-Kopie mit Leiste und Papierkorb-Hinweis, Hinweis-Leiste des Editors
// (nur mit BASED_SCREENSHOTS=1, Chromium) in 1280 × 820, 900 × 600 und 1728 × 1000, hell und dunkel.
test("Fotos: Synced-Block-Kopie, Hinweis am Editor", async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== "chromium");
  test.setTimeout(240_000);
  const source = await createPage(page, "Source page");
  await createPage(page, "Mirror page");
  await openBlockPage(page, "Source page");
  await focusEditorEnd(page);
  await page.keyboard.type("Shared launch checklist");
  await settled(page);
  await blockMenu(page, "Shared launch checklist");
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Copy and sync" }).click();
  const originalID = (await editor(page).locator('.bx2-block[data-type="syncedBlock"]').getAttribute("data-block-id"))!;
  await settled(page);
  await openBlockPage(page, "Mirror page");
  await focusEditorEnd(page);
  await paste(page, { "text/plain": "based-sync:" + originalID });
  await settled(page);
  const copy = editor(page).locator(".bx2-synced[data-synced-copy]");
  const shoot = async (name: string, prepare: () => Promise<void>) => {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await openBlockPage(page, "Mirror page");
        await prepare();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-block-editor-${name}-${theme}-${w}x${h}.png` });
      }
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  };
  await shoot("synced-copy", async () => {
    // BSD-429: über dem Kind, damit „+“ und Griff neben der Randlinie im Foto stehen
    await copy.locator(".bx2-block > .bx2-row").first().hover();
    await expect(copy.getByRole("button", { name: "Unsync" })).toBeVisible();
  });
  await shoot("notice", async () => {
    await editor(page).locator("[data-editable-id]").first().click();
    await paste(page, { "text/plain": "based-sync:" + originalID });
    await expect(page.getByTestId("editor-notice")).toBeVisible();
  });
  await command(page, { op: "trash", ids: [source] });
  await shoot("synced-trashed", async () => {
    await expect(copy.locator(".bx2-synced-note")).toBeVisible();
  });
});

// BSD-358: „Paste“ im Based-Kontextmenü fügt mit Formatierung ein (HTML aus der Zwischenablage) – wie ⌘V. In der
// Mac-App liest der Befehl clipboard_html (NSPasteboard) das HTML; hier der Browser-Weg (nur Chromium darf lesen).
test("Rechtsklick → Paste behält die Formatierung", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit lässt Tests die Zwischenablage nicht lesen");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await createPage(page, "Context paste");
  await openBlockPage(page, "Context paste");
  await focusEditorEnd(page);
  await page.keyboard.type("Start ");
  await page.evaluate(async () => {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob(["Bold and link"], { type: "text/plain" }),
      "text/html": new Blob(['<b>Bold</b> and <a href="https://example.com/x">link</a>'], { type: "text/html" }),
    })]);
  });
  const field = blockEditor(page).locator("[data-editable-id]").first();
  await field.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Paste/ }).click();
  await expect(field.locator(".bx2-b")).toHaveText("Bold");
  await expect(field.locator("a")).toHaveAttribute("href", "https://example.com/x");
});
