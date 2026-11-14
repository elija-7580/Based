import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-209: Mermaid-Vorschau unter einem Codeblock – „/Mermaid diagram“, Diagramm erscheint als Bild (gebündelt,
// ohne Netz), Fehler in einem Satz, nach dem Neuladen wieder da, neu gezeichnet beim Umschalten hell/dunkel.
// Bildschirmfotos (BASED_SCREENSHOTS=1, Chromium): docs/design/screens/web-editor-mermaid-*.png.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-mermaid-"));
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

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expectEditable(page);
}

/** Mermaid-Block per Slash-Menü anlegen und Code schreiben (Enter im Codeblock = neue Zeile). */
async function mermaidBlock(page: Page, lines: string[]) {
  await focusEditorEnd(page);
  await page.keyboard.type("/Mermaid");
  await expect(page.getByRole("option", { name: /Mermaid diagram/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const code = editor(page).locator('.bx2-block[data-type="code"]').first();
  await expect(code.locator(".bx2-code-lang-btn")).toHaveText("Mermaid");
  await expect(code.locator("[data-editable-id]")).toBeFocused();
  // als Text einfügen (Tippen von Zeilenumbrüchen im Codeblock ist in WebKit unter Last unzuverlässig)
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, lines.join("\n"));
  await expect(code.locator("[data-testid=mermaid-preview]")).toHaveAttribute("data-code", lines.join("\n"));
  return code;
}

test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

test("Mermaid: Diagramm als Bild ohne Netz, Fehler in einem Satz, nach dem Neuladen wieder da", async ({ page }) => {
  // Nichts darf von fremden Servern kommen (Mermaid ist gebündelt)
  const remote: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://localhost") && !/^(blob|data):/.test(r.url())) remote.push(r.url()); });
  await command(page, { op: "createPage", title: "Flow" });
  await openPage(page, "Flow");
  const code = await mermaidBlock(page, ["graph TD", "A[Idea] --> B[Draft]", "B --> C[Ship]"]);
  const preview = code.locator("[data-testid=mermaid-preview]");
  await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  const img = preview.locator("img.bx-mermaid-image");
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(20);
  // Das SVG enthält die Beschriftungen als Text, kein Skript und kein foreignObject (htmlLabels aus)
  const svg = await img.evaluate(async (el: HTMLImageElement) => (await fetch(el.src)).text());
  expect(svg).toContain("Idea");
  expect(svg).toContain("Ship");
  expect(svg).not.toMatch(/<script|<foreignObject/i);

  // Fehler: ein Satz statt eines Stacktraces (eigene Seite mit unvollständigem Code)
  await command(page, { op: "createPage", title: "Broken" });
  await openPage(page, "Broken");
  const bad = (await mermaidBlock(page, ["graph TD", "A -->"])).locator("[data-testid=mermaid-preview]");
  await expect(bad).toHaveAttribute("data-state", "error", { timeout: 20_000 });
  await expect(bad.locator(".bx-mermaid-error")).toContainText("Can’t draw this diagram.");
  await expect(bad.locator("img")).toHaveCount(0);

  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Flow");
  const again = editor(page).locator("[data-testid=mermaid-preview]").first();
  await expect(again).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(again.locator("img.bx-mermaid-image")).toBeVisible();
  expect(remote).toEqual([]);
});

test("Mermaid: beim Umschalten auf dunkel zeichnet sich die Vorschau in den dunklen Farben neu", async ({ page }) => {
  await command(page, { op: "createPage", title: "Themes" });
  await openPage(page, "Themes");
  const code = await mermaidBlock(page, ["graph LR", "A --> B"]);
  const img = code.locator("[data-testid=mermaid-preview] img.bx-mermaid-image");
  await expect(img).toHaveAttribute("src", /^blob:/, { timeout: 20_000 });
  const light = await img.getAttribute("src");
  const lightSvg = await img.evaluate(async (el: HTMLImageElement) => (await fetch(el.src)).text());
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect.poll(() => img.getAttribute("src"), { timeout: 20_000 }).not.toBe(light);
  const darkSvg = await img.evaluate(async (el: HTMLImageElement) => (await fetch(el.src)).text());
  expect(darkSvg).not.toBe(lightSvg);
});

test("Bildschirmfotos: Mermaid-Vorschau", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
  const id = (await command(page, { op: "createPage", title: "Release flow" })) as string;
  await openPage(page, "Release flow");
  await mermaidBlock(page, ["graph LR", "A[Write] --> B{Review}", "B -->|ok| C[Merge]", "B -->|changes| A", "C --> D[Ship]"]);
  await expect(editor(page).locator("[data-testid=mermaid-preview]").first()).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
      await page.goto("/#page-" + id);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(editor(page).locator("[data-testid=mermaid-preview]").first()).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-mermaid-${w}x${h}-${theme}.png` });
    }
  }
});
