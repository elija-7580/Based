import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-318: Meldung „Textbearbeitung verbuggt“ mit Screenshot – Blockauswahl über einem großen Block, darüber eine
// helle Fläche, darunter Zitat, ein leerer Callout (📌) und „Daily Pages“. Nachgestellt; Ursachen:
// - Bei einer Blockauswahl blieb die Formatleiste stehen (die Editor-Auswahl spannt für Blockaktionen über die Blöcke)
//   und lag als helle Fläche über der Auswahl, beim Ausblenden auch nur noch als leerer Kasten.
// - Der Dokument-Rahmen hatte bei der Blockauswahl einen Fokusring um die ganze Seite.
// - Der Callout malte einen eigenen hellen Kasten über die Auswahlfarbe; Kinder (mehrzeilige Callouts aus Notion)
//   lagen außerhalb des Kastens, der Callout sah leer aus.
// Screenshots (hell/dunkel, drei Fenstergrößen) mit BASED_SCREENSHOTS=1 in Chromium: docs/design/screens/web-editor-callout-select-*.png

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-editor-"));
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
const doc = (page: Page) => page.locator(".bx-editor > .bx-doc").first();

/** Hell/Dunkel wie über Settings → Appearance (gespeichert, neu geladen), dann `scene` wieder herstellen. */
async function setTheme(page: Page, theme: "light" | "dark", scene: () => Promise<void>) {
  await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await scene();
}

async function shots(page: Page, name: string, scene: () => Promise<void>) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme, scene);
    for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-${name}-${theme}${suffix}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  await setTheme(page, "light", scene);
}

const HTML = `<p>Big block. ${"Capture what resonates, organize for action, distill the essence, express your work. ".repeat(3)}</p>`
  + `<blockquote><em>“Your mind is for having ideas, not holding them.” — Tiago Forte</em></blockquote>`
  + `<aside><span class="icon">📌</span><p>First line of the callout</p><p>Second line inside</p></aside>`
  + `<h2>Daily Pages</h2><p>After</p>`;

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const CALLOUT_BLOCK = ".bn-block:has(> .react-renderer > .bn-block-content[data-content-type=callout])";

test("Blockauswahl über Zitat und Callout: keine Formatleiste, kein Seiten-Fokusring, Callout-Kasten mit Kindern", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Second Brain" });
  await page.getByRole("treeitem", { name: "Second Brain" }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).locator(".bn-block-content").first().click();
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "x");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, HTML);
  await expect(editor(page).locator("[data-content-type=callout]")).toHaveCount(1);
  await expect(editor(page).getByText("Second line inside")).toBeVisible();

  // Kind liegt im Kasten des Callouts (nicht darunter daneben)
  const calloutBox = await box(page, `.bx-doc ${CALLOUT_BLOCK}`);
  const child = (await editor(page).getByText("Second line inside").boundingBox())!;
  expect(child.y + child.height).toBeLessThanOrEqual(calloutBox.y + calloutBox.height);
  expect(child.x).toBeGreaterThan(calloutBox.x);
  // Der innere Kasten malt keinen eigenen Grund (sonst liegt er hell über der Auswahl)
  expect(await bg(page, ".bx-callout")).toBe("rgba(0, 0, 0, 0)");
  const open = async () => {
    await page.getByRole("treeitem", { name: "Second Brain" }).click();
    await expect(editor(page).getByText("Second line inside")).toBeVisible();
  };
  // Graue Callouts (Notion-Standard) im Dunkelmodus: dunkle Fläche aus den Tokens, keine helle
  await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
  await page.waitForTimeout(600);
  await page.reload();
  await open();
  const raised = await page.evaluate(() => {
    const p = document.createElement("div");
    p.style.background = "var(--surface-raised)";
    document.body.appendChild(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  });
  expect(await bg(page, `.bx-doc ${CALLOUT_BLOCK}`)).toBe(raised);
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
  await page.reload();
  await open();
  if (SHOTS && browserName === "chromium") { // gespeichert, bevor neu geladen wird
    await shots(page, "callout", open);
  }

  // Blockauswahl: Esc im ersten Block, dann ⇧↓ bis zum Callout
  const selectThree = async () => {
    await editor(page).locator(".bn-block-content").first().click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => ((await doc(page).getAttribute("data-block-selection")) ?? "").split(" ").filter(Boolean).length).toBe(3);
  };
  await selectThree();

  // Keine Formatleiste über der Blockauswahl
  await page.waitForTimeout(400);
  await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
  // Kein Fokusring um die ganze Seite
  expect(await doc(page).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  // Der markierte Callout trägt die Auswahlfarbe, nichts Helles darin
  const selected = await bg(page, `.bx-doc ${CALLOUT_BLOCK}`);
  const first = await bg(page, ".bx-doc .bn-block-group > .bn-block-outer:first-child > .bn-block");
  expect(selected).toBe(first);
  expect(await bg(page, `.bx-doc ${CALLOUT_BLOCK} > .react-renderer > .bn-block-content`)).toBe("rgba(0, 0, 0, 0)");
  if (SHOTS && browserName === "chromium") {
    await shots(page, "callout-select", async () => {
      await open();
      await selectThree();
    });
  }

  // Esc beendet die Auswahl; Text markieren zeigt die Formatleiste wieder
  await page.keyboard.press("Escape");
  await editor(page).getByText("After").dblclick();
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
});
