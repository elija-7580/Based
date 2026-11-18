import { expect, test, type Page } from "@playwright/test";
import { expectFaster } from "./perf.js";

// BSD-532 (Elija 17.11.): Blöcke ziehen so flüssig wie Objekte auf dem Board – mehrere gewählte gemeinsam, Esc bricht ab,
// ⌘Z holt in einem Schritt zurück; das Geisterbild folgt in jedem Bild ohne Layout-Arbeit. Davor/danach und Spalten
// prüft block-editor.spec („Ziehen am Griff“).

const SHOTS = "../../docs/design/screens/";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function newPage(page: Page, theme: "light" | "dark" = "light", size = { width: 1280, height: 820 }) {
  await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.setViewportSize(size);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const c = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client;
    return c.command({ op: "createPage", title: "Drag" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

const editor = (page: Page) => page.getByTestId("block-editor");
const fields = (page: Page) => editor(page).locator("[data-editable-id]");
const texts = (page: Page) => fields(page).evaluateAll((els) => els.map((e) => e.textContent ?? ""));
const selected = (page: Page) => editor(page).locator(".bx2-block[data-selected]").evaluateAll((els) => els.map((e) => e.querySelector("[data-editable-id]")?.textContent ?? ""));

async function typeLines(page: Page, lines: string[]) {
  await editor(page).getByTestId("block-editor-tail").click();
  for (const [i, t] of lines.entries()) {
    await page.keyboard.insertText(t);
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

/** Griff des Blocks `i` greifen und ein Stück ziehen (das Ziehen beginnt). */
async function grab(page: Page, i: number) {
  const block = editor(page).locator(".bx2-block").nth(i);
  await block.locator(".bx2-row").hover();
  const h = (await block.locator(":scope > .bx2-gutter [data-handle]").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 20, h.y + 12, { steps: 4 });
}

test("Drei gewählte Blöcke ziehen gemeinsam; ⌘Z holt in einem Schritt zurück; Esc bricht ab", async ({ page }) => {
  await newPage(page);
  await typeLines(page, ["A", "B", "C", "D", "E", "F"]);
  // B, C, D wählen (Klick auf B, ⇧↓↓ – Tastatur-Blockauswahl)
  await fields(page).nth(1).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selected(page)).toEqual(["B", "C", "D"]);
  // am Griff von C ziehen, hinter F ablegen
  await grab(page, 2);
  const f = (await fields(page).nth(5).boundingBox())!;
  await page.mouse.move(f.x + 40, f.y + f.height - 3, { steps: 8 });
  await expect(page.locator(".bx2-ghost")).toContainText("B · C · D");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).cursor)).toBe("grabbing");
  await page.mouse.up();
  await expect.poll(() => texts(page)).toEqual(["A", "E", "F", "B", "C", "D"]);
  await expect(page.locator(".bx2-ghost, .bx2-drop")).toHaveCount(0);
  // ein Schritt zurück
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => texts(page)).toEqual(["A", "B", "C", "D", "E", "F"]);

  // Esc mitten im Ziehen: nichts bewegt sich, Geisterbild und Strich verschwinden
  await grab(page, 0);
  const e = (await fields(page).nth(4).boundingBox())!;
  await page.mouse.move(e.x + 40, e.y + e.height - 3, { steps: 6 });
  await expect(page.locator(".bx2-drop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".bx2-ghost, .bx2-drop")).toHaveCount(0);
  await page.mouse.up();
  expect(await texts(page)).toEqual(["A", "B", "C", "D", "E", "F"]);
  await expect(editor(page).locator(".bx2-block[data-dragging]")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }]) {
    test(`Ziehen: Geisterbild, Einfügestrich, kein Überlauf (${theme}, ${size.width}×${size.height})`, async ({ page, browserName }) => {
      await newPage(page, theme, size);
      await typeLines(page, ["Plan the trip", "Book flights", "Pack", "Call Ana"]);
      await grab(page, 3);
      const b = (await fields(page).nth(1).boundingBox())!;
      await page.mouse.move(b.x + 40, b.y + b.height - 3, { steps: 6 });
      await expect(page.locator(".bx2-drop")).toBeVisible();
      await expect(page.locator(".bx2-ghost")).toHaveText("Call Ana");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}web-editor-block-drag-${theme}-${size.width}x${size.height}.png` });
      await page.mouse.up();
      await expect.poll(() => texts(page)).toEqual(["Plan the trip", "Book flights", "Call Ana", "Pack"]);
    });
  }
}

test("300 Blöcke: Ziehen über die Seite bleibt bei einem Bild je Bewegung", { tag: "@perf" }, async ({ page, browserName }, info) => {
  test.setTimeout(120_000);
  await newPage(page);
  await typeLines(page, Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`));
  await fields(page).nth(0).scrollIntoViewIfNeeded();
  const block = editor(page).locator(".bx2-block").nth(0);
  await block.locator(".bx2-row").hover();
  const h = (await block.locator(":scope > .bx2-gutter [data-handle]").boundingBox())!;
  const result = await page.evaluate(async (start) => {
    const handle = document.elementFromPoint(start.x, start.y)!.closest("[data-handle]")!;
    const opts = (x: number, y: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true });
    handle.dispatchEvent(new PointerEvent("pointerdown", opts(start.x, start.y)));
    const t0 = performance.now();
    document.dispatchEvent(new PointerEvent("pointermove", opts(start.x + 20, start.y + 10)));
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    const first = performance.now() - t0;
    const times: number[] = [];
    const bottom = window.innerHeight - 200;
    for (let i = 1; i <= 40; i++) {
      const y = start.y + ((bottom - start.y) * i) / 40;
      const t = performance.now();
      document.dispatchEvent(new PointerEvent("pointermove", opts(start.x + 40, y)));
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      await new Promise((r) => setTimeout(r, 0));
      times.push(performance.now() - t);
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent("pointerup", opts(start.x + 40, bottom)));
    times.sort((a, b) => a - b);
    return { first, p50: times[20]!, p95: times[38]! };
  }, { x: h.x + h.width / 2, y: h.y + h.height / 2 });
  console.log(`block drag ${browserName}, 300 blocks: start ${result.first.toFixed(1)} ms, p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms`);
  expect(await texts(page).then((t) => t[0])).toBe("Line 1"); // Esc: nichts bewegt
  if (browserName === "chromium") {
    expectFaster(info, "Block ziehen über 300 Blöcke (p95 je Bewegung samt Bild)", result.p95, 34);
    expectFaster(info, "Block ziehen: Start (Vermessen + erstes Bild)", result.first, 120);
  }
});
