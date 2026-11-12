import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-305: Feinschliff-Durchgang Editor. Eine Seite mit vielen Blocktypen in Ruhe und in den wichtigsten Zuständen
// (leere Seite, Slash-Menü oben/gefiltert/ohne Treffer, Formatleiste, Blockmenü am Griff, Blockauswahl), hell und
// dunkel, 1280 × 820 und 900 × 600. Fotos mit BASED_SCREENSHOTS=1 (Chromium): docs/design/screens/web-editor-polish-*.
// Ohne Fotos prüft der Test die Zustände selbst (jede Fläche erscheint, nichts läuft über das Fenster).

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-polish-"));
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

const MD = [
  "# Heading one", "Plain paragraph with **bold**, *italic*, `code` and a [link](https://example.com).",
  "## Heading two", "- Bullet one", "- Bullet two", "1. First", "2. Second", "- [ ] Open task", "- [x] Done task",
  "> A quote that says something worth quoting.", "> [!NOTE] A callout with an icon and some text.",
  "```js\nconst answer = 42;\nconsole.log(answer);\n```", "---",
  "| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |",
  "### Heading three", "Supercalifragilistic".repeat(8) + " long word paragraph.",
].join("\n\n");

async function paste(page: Page, md: string) {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, md);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test.describe.configure({ timeout: 240_000 });

test("Editor in Ruhe und in seinen Zuständen", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Polish" });
  await command(page, { op: "createPage", title: "Empty" });
  await page.getByRole("treeitem", { name: "Polish" }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, MD);
  await expect(editor(page).locator("[data-content-type=codeBlock], [data-content-type=code]").first()).toBeVisible();
  await page.waitForTimeout(800);
  const pageHash = await page.evaluate(() => location.hash);
  const shoot = async (name: string, theme: string, w: number) => {
    await noHorizontalOverflow(page);
    await page.waitForTimeout(350); // Ein- und Ausblenden (--duration) abwarten
    if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-${name}-${theme}${w === 900 ? "-900" : ""}.png` });
  };
  const firstText = () => editor(page).getByText("Plain paragraph", { exact: false });

  for (const theme of SHOTS && browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    for (const w of [1280, 900] as const) {
      await page.setViewportSize({ width: w, height: w === 1280 ? 820 : 600 });
      await page.evaluate((h) => { location.hash = h; }, pageHash);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await page.mouse.move(w - 5, 300);
      await page.waitForTimeout(400);
      await shoot("rest", theme, w);
      // Formatleiste über einem markierten Wort
      await firstText().dblclick();
      await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
      await shoot("toolbar", theme, w);
      // Slash-Menü: oben, gefiltert, ohne Treffer (vorher Leiste schließen, sonst trifft der Klick die Leiste)
      await page.keyboard.press("Escape");
      await page.mouse.move(w - 5, 300);
      await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
      await firstText().click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await expect(page.locator(".bn-suggestion-menu")).toBeVisible();
      await shoot("slash", theme, w);
      await page.keyboard.type("hea");
      await page.waitForTimeout(200);
      await shoot("slash-filtered", theme, w);
      await page.keyboard.type("zzzz");
      await page.waitForTimeout(200);
      await shoot("slash-empty", theme, w);
      // Zurück: „/heazzzz“ und die leere Zeile wieder weg
      for (let i = 0; i < 9; i++) await page.keyboard.press("Backspace");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(firstText()).toBeVisible();
      // Blockmenü am Griff
      await firstText().hover({ timeout: 5000 });
      const handle = page.locator(".bn-side-menu [draggable=true], .bn-side-menu button").last();
      await expect(handle).toBeVisible();
      await handle.click();
      await expect(page.getByRole("menu").first()).toBeVisible();
      await shoot("block-menu", theme, w);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // Blockauswahl über mehrere Blöcke
      await firstText().click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await page.waitForTimeout(300);
      await shoot("block-selection", theme, w);
      await page.keyboard.press("Escape");
      // Leere Seite mit Platzhalter
      await page.getByRole("treeitem", { name: "Empty" }).click();
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await editor(page).locator(".bn-block-content").first().click();
      await page.waitForTimeout(300);
      await shoot("empty", theme, w);
    }
  }
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});

test("Links und Häkchen im Editor ohne Browser-Blau", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Colors" });
  await page.getByRole("treeitem", { name: "Colors" }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "A [link](https://example.com) here.\n\n- [x] Done");
  const link = editor(page).locator("a").first();
  await expect(link).toBeVisible();
  const [linkColor, textColor] = await link.evaluate((a) => [getComputedStyle(a).color, getComputedStyle(a.parentElement!).color]);
  expect(linkColor).toBe(textColor);
  const accent = await editor(page).locator("input[type=checkbox]").first().evaluate((c) => getComputedStyle(c).accentColor);
  const ink = await page.evaluate(() => { const d = document.createElement("div"); d.style.color = "var(--ink)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  expect(accent).toBe(ink);
});

// BSD-323: Blockfarben kommen hell und dunkel aus den Tokens (block-*), nicht aus BlockNotes grellen Dunkelfarben.
test("Blockfarben im Dunkelmodus aus den Tokens", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Block colors" });
  await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Block colors" }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).locator(".bn-block-content").first().click();
  await paste(page, "> [!NOTE] Blue callout\n\n> [!WARNING] Warning callout\n\nAfter");
  const callout = editor(page).locator(".bn-block-content[data-content-type=callout]").first();
  await expect(callout).toBeVisible();
  const [bg, token] = await callout.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.background = `var(--block-${el.getAttribute("data-background-color")})`;
    document.body.appendChild(probe);
    const t = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(el).backgroundColor, t];
  });
  expect(bg).toBe(token);
  if (SHOTS && browserName === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-editor-polish-block-colors-dark.png" });
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});
