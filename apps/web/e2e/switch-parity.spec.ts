import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-168: letzte Must-Lücken vor dem Umstieg von der Swift-App – AI-Knopf in der Kopfzeile, ⇧⌘U zur Elternseite,
// Vorgaben für neue Seiten und Rechtschreibprüfung, Bild in voller Größe und Bildbreite nach dem Neuladen.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-switch-"));
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
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAIAAADmAupWAAAAS0lEQVR4nO3PAQkAIBDAQOMY0YjGMoawP1iA3drnjmp9PwAGBgYGBgYeE3A94HrA9YDrAdcDrgdcD7gecD3gesD1gOsB1wOuB1zvAUrGlQAWzRHLAAAAAElFTkSuQmCC";

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
}

test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

test("AI-Knopf in der Kopfzeile öffnet und schließt das Chat-Panel (wie ⌘J)", async ({ page }) => {
  await command(page, { op: "createPage", title: "With AI" });
  await openPage(page, "With AI");
  const ai = page.getByTestId("topbar-ai");
  await expect(ai).toHaveAttribute("aria-pressed", "false");
  await ai.click();
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await ai.click();
  await expect(page.getByTestId("chat-dock")).toHaveCount(0);
  await expect(ai).toHaveAttribute("aria-pressed", "false");
});

test("⇧⌘U öffnet die Elternseite; oben angekommen passiert nichts", async ({ page }) => {
  const parent = (await command(page, { op: "createPage", title: "Parent page" })) as string;
  await command(page, { op: "createPage", parent, title: "Child page" });
  await page.getByRole("treeitem", { name: "Parent page" }).locator("[aria-label='Expand']").click().catch(() => undefined);
  await openPage(page, "Child page");
  await page.getByLabel("Page title").blur();
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.getByLabel("Page title")).toHaveValue("Parent page");
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.getByLabel("Page title")).toHaveValue("Parent page");
});

test("Einstellungen → Writing: neue Seiten mit Serif und voller Breite, Rechtschreibprüfung aus", async ({ page }) => {
  await page.goto("/#prefs-my-settings");
  await page.getByRole("radio", { name: "Serif" }).click();
  await page.getByRole("switch", { name: "Full width" }).click();
  await page.getByRole("switch", { name: "Spell-check" }).click();
  await expect(page.locator("body")).toHaveAttribute("spellcheck", "false");
  await expect(page.getByText("Default font, small text and full width for new pages")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+KeyN");
  const article = page.locator("article.page");
  await expect(article).toHaveAttribute("data-font", "serif");
  await expect(article).toHaveAttribute("data-full-width", "");
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.locator("body")).toHaveAttribute("spellcheck", "false");
});

test("Bild: Doppelklick zeigt es groß, Esc schließt; Breite bleibt nach dem Neuladen", async ({ page }) => {
  await command(page, { op: "createPage", title: "Pictures" });
  await openPage(page, "Pictures");
  const ed = editor(page);
  await expect(ed).toHaveAttribute("contenteditable", "true");
  await ed.locator(".bn-block-content").first().click();
  await page.evaluate((src) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", `![Chart](${src})`);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  const img = ed.locator("[data-content-type=image] img").first();
  await expect(img).toBeVisible();
  await img.dblclick();
  await expect(page.getByTestId("image-viewer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-viewer")).toHaveCount(0);

  // Breite per Griff
  const wrapper = ed.locator("[data-content-type=image] .bn-visual-media-wrapper").first();
  await wrapper.hover();
  const handle = wrapper.locator(".bn-resize-handle").last();
  await expect(handle).toBeVisible();
  const before = (await wrapper.boundingBox())!.width;
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 120, h.y + h.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await wrapper.boundingBox())!.width).toBeGreaterThan(before + 60);
  const after = Math.round((await wrapper.boundingBox())!.width);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Pictures");
  const again = editor(page).locator("[data-content-type=image] .bn-visual-media-wrapper").first();
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBe(after);
});

// Bildschirmfotos für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium), 1280 × 820 hell und dunkel.
test("Bildschirmfotos: Kopfzeile mit AI-Knopf, Writing-Einstellungen, Bildansicht", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
  // über die echte Einstellung (wie ⇧⌘L), damit auch die Astryx-Flächen umschalten; `prepare` läuft nach jedem Laden
  const shot = async (name: string, hash: string, prepare: () => Promise<void> = async () => undefined) => {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
      await page.goto("/" + hash);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await prepare();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `../../docs/design/screens/web-${name}-${theme}.png` });
    }
  };
  const id = (await command(page, { op: "createPage", title: "Roadmap" })) as string;
  await openPage(page, "Roadmap");
  await editor(page).locator(".bn-block-content").first().click();
  await page.evaluate((src) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", `![Chart](${src})`);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(editor(page).locator("[data-content-type=image] img").first()).toBeVisible();
  await page.waitForTimeout(800);
  const pageHash = "#page-" + id;
  await shot("topbar-ai", pageHash, async () => {
    if ((await page.getByTestId("topbar-ai").getAttribute("aria-pressed")) !== "true") await page.getByTestId("topbar-ai").click();
  });
  await shot("image-viewer", pageHash, async () => {
    if ((await page.getByTestId("topbar-ai").getAttribute("aria-pressed")) === "true") await page.getByTestId("topbar-ai").click();
    await editor(page).locator("[data-content-type=image] img").first().dblclick();
    await expect(page.getByTestId("image-viewer")).toBeVisible();
  });
  await shot("settings-writing", "#prefs-my-settings", async () => { await page.getByText("Spell-check").scrollIntoViewIfNeeded(); });
  await shot("settings-updates", "#prefs-updates");
});
