import { expect, test, type Page } from "@playwright/test";
import { expectFaster } from "./perf.js";

// BSD-531 (Elija 17.11.): Rechteck-Auswahl im Seiten-Editor „so flüssig wie auf dem Board“. Aufziehen beginnt auf jeder
// leeren Stelle der Seite – rechts neben kurzem Text, in einer leeren Zeile, zwischen Blöcken, im Rand; wer im Text
// beginnt, markiert Text. Ein bloßer Klick rechts neben dem Text setzt den Cursor ans Zeilenende.

const SHOTS = "../../docs/design/screens/";

async function pageWith(page: Page, theme: "light" | "dark" = "light", size = { width: 1280, height: 820 }): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.setViewportSize(size);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const c = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client;
    return c.command({ op: "createPage", title: "Marquee" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

const editor = (page: Page) => page.getByTestId("block-editor");
const fields = (page: Page) => editor(page).locator("[data-editable-id]");
const selected = (page: Page) => editor(page).locator(".bx2-block[data-selected]").evaluateAll((els) => els.map((e) => e.querySelector("[data-editable-id]")?.textContent ?? ""));

async function typeLines(page: Page, lines: string[]) {
  await editor(page).getByTestId("block-editor-tail").click();
  for (const [i, t] of lines.entries()) {
    if (t) await page.keyboard.type(t);
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

/** Rechtes Ende des Textes einer Zeile (Bildschirmkoordinaten). */
const textEnd = (page: Page, i: number) => fields(page).nth(i).evaluate((el) => {
  const r = el.ownerDocument.createRange();
  r.selectNodeContents(el);
  const rects = [...r.getClientRects()];
  const b = el.getBoundingClientRect();
  return rects.length ? { x: Math.max(...rects.map((q) => q.right)), y: b.top + b.height / 2 } : { x: b.left, y: b.top + b.height / 2 };
});

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

test("Aufziehen rechts neben kurzem Text und aus einer leeren Zeile wählt Blöcke; im Text bleibt es Text; Klick setzt den Cursor ans Ende", async ({ page }) => {
  await pageWith(page);
  await typeLines(page, ["one", "", "three", "four"]);
  await expect(fields(page)).toHaveCount(4);

  // rechts neben „one“ beginnen, nach unten bis „three“
  const one = await textEnd(page, 0);
  const three = (await fields(page).nth(2).boundingBox())!;
  await drag(page, { x: one.x + 120, y: one.y }, { x: one.x + 60, y: three.y + three.height / 2 });
  expect(await selected(page)).toEqual(["one", "", "three"]);
  await expect(page.locator(".bx2-marquee")).toHaveCount(0);

  // aus der Mitte der leeren Zeile nach unten bis „four“
  await page.keyboard.press("Escape");
  const empty = (await fields(page).nth(1).boundingBox())!;
  const four = (await fields(page).nth(3).boundingBox())!;
  await drag(page, { x: empty.x + empty.width / 2, y: empty.y + empty.height / 2 }, { x: empty.x + empty.width / 2 - 40, y: four.y + four.height / 2 });
  expect(await selected(page)).toEqual(["", "three", "four"]);

  // ⇧/⌘ ergänzt: mit ⌘ rechts neben „one“ dazunehmen
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  const oneBox = (await fields(page).nth(0).boundingBox())!;
  await drag(page, { x: one.x + 120, y: one.y }, { x: one.x + 100, y: oneBox.y + oneBox.height - 2 });
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  expect(await selected(page)).toEqual(["one", "", "three", "four"]);

  // im Text beginnen: Textmarkierung, keine Blockauswahl
  await page.keyboard.press("Escape");
  const f3 = (await fields(page).nth(2).boundingBox())!;
  await drag(page, { x: f3.x + 2, y: f3.y + f3.height / 2 }, { x: f3.x + 20, y: f3.y + f3.height / 2 });
  expect(await selected(page)).toEqual([]);
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).not.toBe("");

  // bloßer Klick rechts neben „four“: Cursor am Ende, Tippen hängt an
  const fourEnd = await textEnd(page, 3);
  await page.mouse.click(fourEnd.x + 150, fourEnd.y);
  await page.keyboard.type("!");
  await expect(fields(page).nth(3)).toHaveText("four!");
  expect(await selected(page)).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }]) {
    test(`Aussehen wie auf dem Board: getönte Fläche, feiner Rand (${theme}, ${size.width}×${size.height})`, async ({ page, browserName }) => {
      await pageWith(page, theme, size);
      await typeLines(page, ["Plan the trip", "Book flights", "Pack", "Call Ana"]);
      const a = await textEnd(page, 0);
      const last = (await fields(page).nth(2).boundingBox())!;
      await page.mouse.move(a.x + 80, a.y);
      await page.mouse.down();
      await page.mouse.move(a.x + 20, last.y + last.height / 2, { steps: 6 });
      const box = page.locator(".bx2-marquee");
      await expect(box).toHaveCount(1);
      const style = await box.evaluate((el) => {
        const cs = getComputedStyle(el);
        const probe = document.createElement("div");
        probe.style.color = "var(--focus-ring)";
        document.body.append(probe);
        const ring = getComputedStyle(probe).color;
        probe.remove();
        return { border: cs.borderTopColor, width: cs.borderTopWidth, bg: cs.backgroundColor, ring };
      });
      expect(style.width).toBe("1px");
      expect(style.border).toBe(style.ring);
      expect(style.bg).not.toBe("rgba(0, 0, 0, 0)");
      await expect.poll(() => selected(page)).toEqual(["Plan the trip", "Book flights", "Pack"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}web-editor-marquee-${theme}-${size.width}x${size.height}.png` });
      await page.mouse.up();
      await expect(box).toHaveCount(0);
    });
  }
}

test("300 Blöcke: Aufziehen über alle bleibt unter einem Bild je Bewegung", { tag: "@perf" }, async ({ page, browserName }, info) => {
  test.setTimeout(120_000);
  await pageWith(page);
  await editor(page).getByTestId("block-editor-tail").click();
  for (let i = 1; i <= 300; i++) {
    await page.keyboard.insertText(`Line ${i}`);
    if (i < 300) await page.keyboard.press("Enter");
  }
  await expect(fields(page)).toHaveCount(300, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await fields(page).nth(0).scrollIntoViewIfNeeded();
  const first = await textEnd(page, 0);
  const result = await page.evaluate(async (start) => {
    const target = document.elementFromPoint(start.x + 150, start.y)!;
    const opts = (x: number, y: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true });
    target.dispatchEvent(new PointerEvent("pointerdown", opts(start.x + 150, start.y)));
    const times: number[] = [];
    const bottom = window.innerHeight - 200;
    for (let i = 1; i <= 40; i++) {
      const y = start.y + ((bottom - start.y) * i) / 40;
        const t0 = performance.now();
      document.dispatchEvent(new PointerEvent("pointermove", opts(start.x + 100, y)));
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      await new Promise((r) => setTimeout(r, 0));
      times.push(performance.now() - t0);
    }
    document.dispatchEvent(new PointerEvent("pointerup", opts(start.x + 100, bottom)));
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    await new Promise((r) => setTimeout(r, 50));
    times.sort((a, b) => a - b);
    return { p50: times[20]!, p95: times[38]!, selected: document.querySelectorAll(".bx2-block[data-selected]").length };
  }, first);
  console.log(`marquee ${browserName}, 300 blocks: p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, ${result.selected} selected`);
  expect(result.selected).toBeGreaterThan(5);
  // ein Bild = 16,7 ms; gemessen wird Bewegung + nächstes Bild + ein Takt. WebKit im Testlauf zeichnet in Software
  // (ein Bild einer langen Seite ~300 ms, auch ohne Auswahl) – dort nur die Funktion, keine Zeit.
  if (browserName === "chromium") expectFaster(info, "Rechteck-Auswahl über 300 Blöcke (p95 je Bewegung)", result.p95, 34);
});
