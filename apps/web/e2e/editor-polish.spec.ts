import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
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
const editor = (page: Page) => blockEditor(page);

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
  await expectEditable(page);
  await focusEditorEnd(page);
  await paste(page, MD);
  await expect(editor(page).locator('.bx2-block[data-type="code"]').first()).toBeVisible();
  await page.waitForTimeout(800);
  const pageHash = await page.evaluate(() => location.hash);
  const shoot = async (name: string, theme: string, w: number) => {
    await noHorizontalOverflow(page);
    await page.waitForTimeout(350); // Ein- und Ausblenden (--duration) abwarten
    if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-${name}-${theme}${w === 1280 ? "" : "-" + w}.png` });
  };
  const firstText = () => editor(page).getByText("Plain paragraph", { exact: false });

  for (const theme of SHOTS && browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    // BSD-407 Teil 3: Block-Editor als Standard, dazu 1728 × 1000 (Checkliste: drei Größen)
    for (const w of [1280, 900, 1728] as const) {
      await page.setViewportSize({ width: w, height: w === 1280 ? 820 : w === 900 ? 600 : 1000 });
      await page.evaluate((h) => { location.hash = h; }, pageHash);
      await expectEditable(page);
      await page.mouse.move(w - 5, 300);
      await page.waitForTimeout(400);
      await shoot("rest", theme, w);
      // Formatleiste über einem markierten Wort
      await firstText().dblclick();
      await expect(page.getByTestId("format-bar")).toBeVisible();
      await shoot("toolbar", theme, w);
      // Slash-Menü: oben, gefiltert, ohne Treffer (vorher Leiste schließen, sonst trifft der Klick die Leiste)
      await page.keyboard.press("Escape");
      await page.mouse.move(w - 5, 300);
      await expect(page.getByTestId("format-bar")).toHaveCount(0);
      await firstText().click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await expect(page.getByTestId("slash-menu")).toBeVisible();
      await shoot("slash", theme, w);
      await page.keyboard.type("hea");
      await page.waitForTimeout(200);
      await shoot("slash-filtered", theme, w);
      // Keine leeren Gruppenüberschriften (BSD-305: doppelte Gruppen ließen sie beim Filtern stehen)
      const empty = await page.getByTestId("slash-menu").evaluate((m) => [...m.querySelectorAll(".bx2-menu-label")].filter((l) => !l.parentElement?.querySelector("[role=option]")).map((c) => c.textContent));
      expect(empty).toEqual([]);
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
      const handle = editor(page).locator(".bx2-block", { hasText: "Plain paragraph" }).last().getByTestId("block-handle").first();
      await expect(handle).toBeVisible();
      await handle.click();
      await expect(page.getByTestId("block-menu")).toBeVisible();
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
      await expectEditable(page);
      await focusEditorEnd(page);
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
  await expectEditable(page);
  await focusEditorEnd(page);
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
  await expectEditable(page);
  await focusEditorEnd(page);
  await paste(page, "> [!NOTE] Blue callout\n\n> [!WARNING] Warning callout\n\nAfter");
  // Block-Editor: die Farbe sitzt an der Zeile des Blocks (bx2-color-<farbe>Background), der Callout-Kasten ist durchsichtig
  const callout = editor(page).locator('.bx2-block[data-type="callout"] > .bx2-row').first();
  await expect(callout).toBeVisible();
  const [bg, token, inner] = await callout.evaluate((el) => {
    const color = /bx2-color-(\w+)Background/.exec(el.className)?.[1] ?? "none";
    const probe = document.createElement("div");
    probe.style.background = `var(--block-${color})`;
    document.body.appendChild(probe);
    const t = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(el).backgroundColor, t, getComputedStyle(el.querySelector(".bx2-callout")!).backgroundColor];
  });
  expect(bg).toBe(token);
  expect(inner).toBe("rgba(0, 0, 0, 0)");
  if (SHOTS && browserName === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-editor-polish-block-colors-dark.png" });
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});
