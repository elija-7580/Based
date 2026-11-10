import { expect, test as base, type Locator, type Page } from "@playwright/test";
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

const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

/** Schreibmarke ans Ende eines Blocks mit diesem Text. */
async function caretAtEnd(page: Page, scope: Locator, text: string) {
  const el = scope.getByText(text, { exact: false }).first();
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  await el.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press("End");
}

/** Schreibmarke in einen leeren Absatz am Seitenende (legt ihn an, wenn der letzte Block Text hat). */
async function caretInLastLine(page: Page) {
  const last = editor(page).locator(":scope > .bn-block-group > .bn-block-outer").last();
  await last.scrollIntoViewIfNeeded();
  const content = last.locator(".bn-block-content").first();
  await content.click();
  await page.keyboard.press("End");
  if (((await content.innerText()).trim() !== "") || (await content.getAttribute("data-content-type")) !== "paragraph") await page.keyboard.press("Enter");
}

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

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }, theme);
  await expect(page.locator(".bn-container").first()).toHaveAttribute("data-color-scheme", theme);
}

async function shots(page: Page, browserName: string, name: string) {
  if (!SHOTS || browserName !== "chromium") return;
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(800); // Farbübergänge abwarten
    await page.screenshot({ path: `../../docs/design/screens/web-editor-${name}-${theme}.png` });
  }
  await setTheme(page, "light");
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
  await openPage(page, "Paste target");
  await caretInLastLine(page);
  await page.keyboard.type("Intro line");
  await settled(page);
  await page.keyboard.press("Enter");
  await paste(page, { "text/plain": MARKDOWN });

  const ed = editor(page);
  const check = async () => {
    await expect(ed.locator("[data-content-type=heading] h1")).toHaveText("Launch plan");
    const para = ed.locator("[data-content-type=paragraph]", { hasText: "Ship with" });
    await expect(para.locator("strong")).toHaveText("bold");
    await expect(para.locator("em")).toHaveText("care");
    await expect(para.locator("code")).toHaveText("code");
    await expect(para.locator("a")).toHaveAttribute("href", "https://example.com/docs");
    // Verschachtelung: Research › Interviews › Synthesis
    const research = ed.locator(".bn-block-outer", { has: page.locator(":scope > .bn-block > [data-content-type=bulletListItem]", { hasText: "Research" }) }).first();
    const interviews = research.locator(".bn-block-group .bn-block-outer", { has: page.locator(":scope > .bn-block > [data-content-type=bulletListItem]", { hasText: "Interviews" }) }).first();
    await expect(interviews).toBeVisible();
    await expect(interviews.locator(".bn-block-group [data-content-type=bulletListItem]", { hasText: "Synthesis" })).toBeVisible();
    await expect(ed.locator("[data-content-type=numberedListItem]")).toHaveCount(2);
    await expect(ed.locator("[data-content-type=checkListItem]", { hasText: "Kickoff done" }).locator("input[type=checkbox]")).toBeChecked();
    await expect(ed.locator("[data-content-type=checkListItem]", { hasText: "Launch pending" }).locator("input[type=checkbox]")).not.toBeChecked();
    await expect(ed.locator("[data-content-type=quote]")).toHaveText("Stay calm and ship.");
    const code = ed.locator("[data-content-type=codeBlock]");
    await expect(code).toContainText("const answer = 42;");
    await expect(code).toHaveAttribute("data-language", "ts");
    const table = ed.locator("[data-content-type=table]");
    await expect(table.locator("th")).toHaveText(["Owner", "Status"]);
    await expect(table.locator("td")).toHaveText(["Ada", "Ready"]);
    await expect(ed.locator("[data-content-type=divider]")).toHaveCount(1);
    await expect(ed.locator("[data-content-type=image]")).toHaveAttribute("data-url", "https://example.com/roadmap.png");
  };
  await check();

  // Ein Undo-Schritt nimmt alles Eingefügte zurück, der Text davor bleibt; Redo bringt es wieder.
  await ed.locator("[data-content-type=quote]").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ed.locator("[data-content-type=heading]")).toHaveCount(0);
  await expect(ed.locator("[data-content-type=table]")).toHaveCount(0);
  await expect(ed.locator("[data-content-type=codeBlock]")).toHaveCount(0);
  await expect(ed.getByText("Intro line")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await check();

  await settled(page);
  await page.reload();
  await openPage(page, "Paste target");
  await check();
  expect(errors).toEqual([]);
});

test("Einfügen: HTML hat Vorrang, ⇧⌘V bleibt Klartext, eine Zeile mit Inline-Markdown landet im Absatz", async ({ page }) => {
  await createPage(page, "Paste rules");
  await openPage(page, "Paste rules");
  const ed = editor(page);
  await caretInLastLine(page);
  // HTML und Markdown-Text zugleich: HTML gewinnt.
  await paste(page, { "text/html": "<h2>From HTML</h2><p>Body</p>", "text/plain": "# From Markdown" });
  await expect(ed.locator("[data-content-type=heading] h2")).toHaveText("From HTML");
  await expect(ed.getByText("From Markdown")).toHaveCount(0);

  // Als Klartext einfügen: Markdown-Zeichen bleiben stehen, keine Überschrift, keine Liste.
  await caretInLastLine(page);
  await paste(page, { "text/plain": "# Not a heading\n- not a list" }, { plain: true });
  await expect(ed.getByText("# Not a heading")).toBeVisible();
  await expect(ed.getByText("- not a list")).toBeVisible();
  await expect(ed.locator("[data-content-type=heading]")).toHaveCount(1);
  await expect(ed.locator("[data-content-type=bulletListItem]")).toHaveCount(0);

  // Eine Zeile mit Inline-Markdown mitten im Text: bleibt im selben Absatz.
  await caretInLastLine(page);
  await page.keyboard.type("Before ");
  await paste(page, { "text/plain": "**strong** words" });
  const para = ed.locator("[data-content-type=paragraph]", { hasText: "Before" });
  await expect(para).toHaveText("Before strong words");
  await expect(para.locator("strong")).toHaveText("strong");

  // Mehrzeiliger Klartext ohne Markdown: ein Absatz je Zeile.
  await caretInLastLine(page);
  await paste(page, { "text/plain": "alpha line\nbeta line\ngamma line" });
  for (const t of ["alpha line", "beta line", "gamma line"]) await expect(ed.locator("[data-content-type=paragraph]", { hasText: t })).toHaveText(t);
});

test("@ und [[ erwähnen Seiten: Titel live, Klick navigiert, Backlink sichtbar, Papierkorb markiert", async ({ page, browserName }) => {
  const zeppelin = await createPage(page, "Project Zeppelin");
  await createPage(page, "Notes");
  await openPage(page, "Notes");
  const ed = editor(page);
  await caretInLastLine(page);
  await page.keyboard.type("See @Zepp");
  const item = page.locator(".bn-suggestion-menu-item", { hasText: "Project Zeppelin" }).first();
  await expect(item).toBeVisible();
  if (SHOTS && browserName === "chromium") await shots(page, browserName, "mention-menu");
  await page.keyboard.press("Enter");
  const mention = ed.locator(".bx-mention[data-kind=page]").first();
  await expect(mention).toContainText("Project Zeppelin");
  await expect(mention).toHaveAttribute("data-page", zeppelin);

  // Datum mit Erinnerungs-Flagge
  await page.keyboard.type("due @tomor");
  // Warten, bis das Menü zur ganzen Eingabe passt (vorher stehen Today und Tomorrow beide da).
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Today" })).toHaveCount(0);
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Tomorrow" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const date = ed.locator(".bx-mention[data-kind=date]").first();
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
  });
  await expect(date).toHaveText("@" + tomorrow);
  await date.click();
  await page.getByRole("dialog", { name: "Date options" }).getByLabel("Remind me").check();
  await expect(date).toHaveAttribute("data-remind", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Date options" })).toHaveCount(0);

  // [[ sucht nur Seiten; „New page“ legt eine an und erwähnt sie
  await caretAtEnd(page, ed, "See");
  await page.keyboard.type(" [[Brand new idea");
  const create = page.locator(".bn-suggestion-menu-item", { hasText: "New page “Brand new idea”" });
  await expect(create).toBeVisible();
  await expect(page.locator(".bn-suggestion-menu-item", { hasText: "Tomorrow" })).toHaveCount(0);
  await create.click();
  await expect(ed.locator(".bx-mention[data-kind=page]", { hasText: "Brand new idea" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Brand new idea" })).toBeVisible();
  await expect(ed.getByText("[[")).toHaveCount(0);

  // Titel live: Umbenennen der Zielseite ändert die Erwähnung
  await command(page, { op: "rename", id: zeppelin, title: "Project Airship" });
  await expect(mention).toContainText("Project Airship");
  await shots(page, browserName, "mention");

  // Nach dem Neuladen ist alles noch da
  await settled(page);
  await page.reload();
  await openPage(page, "Notes");
  await expect(ed.locator(".bx-mention[data-kind=page]", { hasText: "Project Airship" })).toBeVisible();
  await expect(ed.locator(".bx-mention[data-kind=page]", { hasText: "Brand new idea" })).toBeVisible();
  await expect(ed.locator(".bx-mention[data-kind=date]")).toHaveAttribute("data-remind", "true");

  // Klick navigiert zur Seite; dort steht der Backlink
  await ed.locator(".bx-mention[data-kind=page]", { hasText: "Project Airship" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Project Airship");
  const backlinks = page.getByTestId("backlinks");
  await expect(backlinks).toContainText("1 backlink");
  await expect(backlinks.getByRole("button", { name: "Notes" })).toBeVisible();
  await backlinks.getByRole("button", { name: "Notes" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Notes");

  // Papierkorb: die Erwähnung ist markiert; nach dem Wiederherstellen nicht mehr
  await command(page, { op: "trash", ids: [zeppelin] });
  const trashed = editor(page).locator(".bx-mention[data-kind=page]", { hasText: "Project Airship" });
  await expect(trashed).toHaveAttribute("data-trashed", "true");
  await expect(trashed).toContainText("in Trash");
  await command(page, { op: "restore", ids: [zeppelin] });
  await expect(trashed).not.toHaveAttribute("data-trashed", "true");
});

test("Gliederung: Balken am rechten Rand, Klick scrollt, aktuelle Position, pro Seite abschaltbar", async ({ page, browserName }) => {
  await createPage(page, "Long read");
  await openPage(page, "Long read");
  await caretInLastLine(page);
  const filler = (n: number) => Array.from({ length: 14 }, (_, i) => `Paragraph ${n}.${i + 1} of the long read.`).join("\n\n");
  const md = ["# Opening", filler(1), "## Background", filler(2), "### Details", filler(3), "## Results", filler(4), "# Closing", filler(5)].join("\n\n");
  await paste(page, { "text/plain": md });
  const ed = editor(page);
  await expect(ed.locator("[data-content-type=heading]")).toHaveCount(5);

  const outline = page.getByTestId("page-outline");
  await expect(outline).toBeVisible();
  const items = outline.getByRole("button");
  await expect(items).toHaveCount(5);
  expect(await outline.locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-depth")))).toEqual(["0", "1", "2", "1", "0"]);

  // Eingeklappt: nur Balken; bei Hover die Titel
  await page.mouse.move(10, 10);
  await expect(outline.locator(".bx-outline-label").first()).toBeHidden();
  await outline.hover();
  await expect(outline.locator(".bx-outline-label")).toHaveText(["Opening", "Background", "Details", "Results", "Closing"]);
  await shots(page, browserName, "outline");

  // Klick scrollt zur Überschrift und markiert sie
  const results = ed.locator("[data-content-type=heading]", { hasText: "Results" });
  await expect(results).not.toBeInViewport();
  await items.nth(3).click();
  await expect(results).toBeInViewport();
  await expect(items.nth(3)).toHaveAttribute("aria-current", "location");
  // Scrollen von Hand ändert die Markierung
  await page.mouse.move(400, 300);
  await ed.locator("[data-content-type=heading]", { hasText: "Opening" }).scrollIntoViewIfNeeded();
  await expect(items.nth(0)).toHaveAttribute("aria-current", "location");
  await ed.getByText("Paragraph 5.14 of the long read.").scrollIntoViewIfNeeded();
  await expect(items.nth(4)).toHaveAttribute("aria-current", "location");

  // Inhaltsverzeichnis-Block zeigt dieselben Überschriften
  await caretAtEnd(page, ed, "Paragraph 5.14 of the long read.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table of cont");
  await page.locator(".bn-suggestion-menu-item", { hasText: "Table of contents" }).first().click();
  await expect(ed.locator(".bx-toc a")).toHaveText(["Opening", "Background", "Details", "Results", "Closing"]);
  await ed.locator(".bx-toc a", { hasText: "Background" }).click();
  await expect(ed.locator("[data-content-type=heading]", { hasText: "Background" })).toBeInViewport();

  // Pro Seite abschalten (Seitenmenü), bleibt nach dem Neuladen; andere Seiten sind nicht betroffen
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Hide outline" }).click();
  await expect(outline).toHaveCount(0);
  await settled(page);
  await page.reload();
  await openPage(page, "Long read");
  await expect(editor(page).locator("[data-content-type=heading]")).toHaveCount(5);
  await expect(page.getByTestId("page-outline")).toHaveCount(0);
  await openPage(page, "Welcome to Based");
  await expect(page.getByTestId("page-outline")).toBeVisible();
  await openPage(page, "Long read");
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Show outline" }).click();
  await expect(page.getByTestId("page-outline").getByRole("button")).toHaveCount(5);
});

test("Synced Block: Copy and sync, auf zwei Seiten derselbe Inhalt, Unsync, Hinweis bei Original im Papierkorb", async ({ page, browserName }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const source = await createPage(page, "Source page");
  await createPage(page, "Mirror page");
  await createPage(page, "Third page");
  await openPage(page, "Source page");
  await caretInLastLine(page);
  await page.keyboard.type("Shared launch checklist");
  await settled(page);

  // Blockmenü → Copy and sync
  const block = editor(page).locator(".bn-block-content", { hasText: "Shared launch checklist" }).first();
  await block.hover();
  await page.locator(".bn-side-menu [draggable=true]").first().click();
  await page.getByRole("menuitem", { name: "Copy and sync" }).click();
  const original = editor(page).locator(".bx-synced[data-copy=false]");
  await expect(original).toBeVisible();
  await expect(original).toContainText("Shared launch checklist");
  const originalID = await original.evaluate((el) => el.closest(".bn-block-outer")!.getAttribute("data-id")!);
  await settled(page);

  // Auf der zweiten Seite einfügen (Zwischenablage-Text `based-sync:<id>`)
  await openPage(page, "Mirror page");
  await caretInLastLine(page);
  await page.keyboard.type("Above the copy");
  await paste(page, { "text/plain": "based-sync:" + originalID });
  const copy = editor(page).locator(".bx-synced[data-copy=true]");
  await expect(copy).toBeVisible();
  await expect(copy).toContainText("Shared launch checklist");
  await expect(copy.getByRole("button", { name: "Original in Source page" })).toBeAttached();

  // Derselbe Block ein zweites Mal auf derselben Seite: abgelehnt, mit Hinweis
  await caretAtEnd(page, editor(page), "Above the copy");
  await paste(page, { "text/plain": "based-sync:" + originalID });
  await expect(page.getByTestId("editor-notice")).toContainText("already on this page");
  await expect(editor(page).locator(".bx-synced")).toHaveCount(1);

  // In der Kopie schreiben …
  await caretAtEnd(page, copy, "Shared launch checklist");
  await page.keyboard.type(" – edited in the mirror");
  await expect(copy).toContainText("Shared launch checklist – edited in the mirror");
  await settled(page);
  await shots(page, browserName, "synced");

  // … erscheint im Original, und umgekehrt
  await openPage(page, "Source page");
  const orig = editor(page).locator(".bx-synced[data-copy=false]");
  await expect(orig).toContainText("Shared launch checklist – edited in the mirror");
  await caretAtEnd(page, orig, "edited in the mirror");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line from the source");
  await settled(page);
  await openPage(page, "Mirror page");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).toContainText("Second line from the source");

  // Dritte Seite: über „Paste synced block“ im Slash-Menü (ohne Zwischenablage)
  await openPage(page, "Third page");
  await caretInLastLine(page);
  await page.keyboard.type("/paste synced");
  await page.locator(".bn-suggestion-menu-item", { hasText: "Paste synced block" }).first().click();
  const third = editor(page).locator(".bx-synced[data-copy=true]");
  await expect(third).toContainText("Second line from the source");

  // Nach dem Neuladen ist alles noch da
  await settled(page);
  await page.reload();
  await openPage(page, "Third page");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).toContainText("Shared launch checklist – edited in the mirror");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).toContainText("Second line from the source");

  // Unsync: der Inhalt bleibt als eigene Kopie und folgt dem Original nicht mehr
  const unsynced = editor(page).locator(".bx-synced");
  await unsynced.hover();
  await unsynced.getByRole("button", { name: "Unsync" }).click();
  await expect(editor(page).locator(".bx-synced[data-copy=false]")).toContainText("Second line from the source");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).toHaveCount(0);
  await caretAtEnd(page, editor(page).locator(".bx-synced"), "Second line from the source");
  await page.keyboard.type(" (independent)");
  await settled(page);
  await openPage(page, "Mirror page");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).toContainText("Second line from the source");
  await expect(editor(page).locator(".bx-synced[data-copy=true]")).not.toContainText("(independent)");

  // Original im Papierkorb: die Kopie zeigt einen Hinweis; nach dem Wiederherstellen ist er weg
  await command(page, { op: "trash", ids: [source] });
  const mirror = editor(page).locator(".bx-synced[data-copy=true]");
  await expect(mirror).toHaveAttribute("data-trashed", "true");
  await expect(mirror.getByRole("status")).toContainText("is in the Trash");
  if (SHOTS && browserName === "chromium") await shots(page, browserName, "synced-trashed");
  await command(page, { op: "restore", ids: [source] });
  await expect(mirror).not.toHaveAttribute("data-trashed", "true");
  expect(errors).toEqual([]);
});
