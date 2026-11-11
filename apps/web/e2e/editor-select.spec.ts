import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-258: Auswahl mit der Maus – Text über mehrere Absätze, über ein Bild hinweg wird es eine Blockauswahl,
// Rechteck aus dem Seitenrand, ⇧-Klick erweitert, ⌘A zweimal, Kopieren/Ausschneiden/Löschen der Auswahl.


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

const settled = (page: Page) => page.waitForTimeout(600);
test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

const content = (page: Page, text: string) => editor(page).locator(".bn-block-content", { has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) }).last();
const selection = (page: Page) => page.locator(".bx-doc").first().getAttribute("data-block-selection");
const topOrder = (page: Page) => editor(page).locator(":scope > .bn-block-group > .bn-block-outer").evaluateAll((os) => os.map((o) => o.querySelector(".bn-inline-content")?.textContent ?? o.querySelector("[data-content-type]")?.getAttribute("data-content-type") ?? ""));
const idOf = (page: Page, text: string) => content(page, text).evaluate((el) => el.closest(".bn-block-outer")!.getAttribute("data-id")!);

async function setup(page: Page) {
  await createPage(page, "Select");
  await openPage(page, "Select");
  await editor(page).locator(".bn-block-content").first().click();
  for (const t of ["One", "Two", "Three", "Four"]) {
    await page.keyboard.type(t);
    if (t !== "Four") await page.keyboard.press("Enter");
  }
  await expect.poll(() => topOrder(page)).toEqual(["One", "Two", "Three", "Four"]);
}

async function dragSelect(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test("Text über mehrere Absätze markieren; über einen Block ohne Text wird es eine Blockauswahl", async ({ page, browserName }) => {
  await createPage(page, "Select text");
  await openPage(page, "Select text");
  await editor(page).locator(".bn-block-content").first().click();
  // Inhalt per Markdown einfügen (wie aus der Zwischenablage)
  await page.evaluate((md) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", md);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "One\n\nTwo\n\nThree\n\n---\n\nFour\n\nFive");
  await expect.poll(() => topOrder(page)).toEqual(["One", "Two", "Three", "divider", "Four", "Five"]);
  // Text über Absätze (nur Text dazwischen): bleibt Textauswahl
  const four = (await content(page, "Four").boundingBox())!;
  const five0 = (await content(page, "Five").boundingBox())!;
  await dragSelect(page, { x: four.x + 2, y: four.y + four.height / 2 }, { x: five0.x + 20, y: five0.y + five0.height / 2 });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString().replace(/\s+/g, " ").trim())).toMatch(/^Four Fi/);
  expect(await selection(page)).toBeNull();
  // WebKit unter Linux verliert beim simulierten Ziehen über den Trenner die Mausereignisse unregelmäßig (in Chromium
  // stabil); dort am Mac prüfen (Backlog BSD-258: Mac-Test).
  if (browserName === "webkit") return;
  // Von Five rückwärts über den Trenner bis Three: Blockauswahl (vorher die Textauswahl aufheben)
  await content(page, "One").click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
  const five = (await content(page, "Five").boundingBox())!;
  const t3 = (await content(page, "Three").boundingBox())!;
  await dragSelect(page, { x: five.x + 30, y: five.y + five.height / 2 }, { x: t3.x + 2, y: t3.y + t3.height / 2 });
  const ids = [await idOf(page, "Three"), await idOf(page, "Five")];
  await expect.poll(() => selection(page)).toContain(ids[0]!);
  await expect.poll(() => selection(page)).toContain(ids[1]!);
  // Löschen entfernt die ganze Auswahl
  await page.keyboard.press("Backspace");
  await expect.poll(() => topOrder(page)).toEqual(["One", "Two"]);
});

test("Rechteck aus dem Rand, ⇧-Klick erweitert, ⌘A zweimal, Kopieren und Ausschneiden", async ({ page, browserName }) => {
  await setup(page);
  const two = (await content(page, "Two").boundingBox())!;
  const three = (await content(page, "Three").boundingBox())!;
  // Rechteck im linken Rand des Editors von Two bis Three
  const ed = (await editor(page).boundingBox())!;
  await dragSelect(page, { x: ed.x + 6, y: two.y + 4 }, { x: ed.x + 20, y: three.y + three.height - 4 });
  const [i2, i3, i4, i1] = [await idOf(page, "Two"), await idOf(page, "Three"), await idOf(page, "Four"), await idOf(page, "One")];
  await expect.poll(() => selection(page)).toBe(`${i2} ${i3}`);
  // ⇧-Klick auf Four erweitert
  await content(page, "Four").click({ modifiers: ["Shift"] });
  await expect.poll(() => selection(page)).toBe(`${i2} ${i3} ${i4}`);
  // Kopieren als Markdown
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copied = await page.evaluate(() => new Promise<string>((resolve) => {
    document.addEventListener("copy", (e) => setTimeout(() => resolve((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? ""), 0), { once: true });
    const dt = new DataTransfer();
    document.activeElement!.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
  }));
  expect(copied.replace(/\s+/g, " ").trim()).toBe("Two Three Four");
  // Esc, dann ⌘A zweimal im Text: alle Blöcke
  await page.keyboard.press("Escape");
  await content(page, "One").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => selection(page)).toBe(`${i1} ${i2} ${i3} ${i4}`);
  // Ausschneiden entfernt sie
  await page.evaluate(() => {
    const dt = new DataTransfer();
    document.activeElement!.dispatchEvent(new ClipboardEvent("cut", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => editor(page).locator(".bn-inline-content", { hasText: /One|Two|Three|Four/ }).count()).toBe(0);
  await settled(page);
});
