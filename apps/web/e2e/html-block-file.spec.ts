import { expect, test, type Page } from "@playwright/test";

// BSD-535: HTML-Block wie bei Notion – Größe ziehen (Breite am rechten, Höhe am unteren Rand, bleibt nach dem Neuladen,
// ein Undo-Schritt), HTML-Datei öffnen (ersetzt den Code) und HTML-Datei auf die Seite ziehen (neuer HTML-Block).

const SHOTS = "../../docs/design/screens/";
const ARTIFACT = "<!doctype html><html><body><h1 id='t'>Exported artifact</h1><p>Made elsewhere.</p></body></html>";

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
    return c.command({ op: "createPage", title: "HTML" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

const editor = (page: Page) => page.getByTestId("block-editor");

async function htmlBlock(page: Page, code: string) {
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("```");
  await page.keyboard.insertText(code);
  await editor(page).locator(".bx2-code-lang-btn").last().click();
  await page.getByLabel("Search languages").fill("html");
  await page.keyboard.press("Enter");
  await page.getByLabel("Page title").click();
  const wrap = editor(page).getByTestId("code-block").last();
  await expect(wrap).toHaveAttribute("data-code-hidden", "");
  return wrap;
}

test("Größe ziehen: Breite rechts, Höhe unten; bleibt nach dem Neuladen; ⌘Z nimmt sie zurück", async ({ page, browserName }) => {
  await newPage(page);
  const wrap = await htmlBlock(page, "<p style='margin:0'>Small widget</p>");
  const preview = wrap.getByTestId("html-preview");
  const frame = wrap.locator("iframe.bx-html-preview");
  const before = (await preview.boundingBox())!;
  await preview.hover();
  // Breite: rechten Griff 200 px nach links
  const hx = (await wrap.getByTestId("html-resize-x").boundingBox())!;
  await page.mouse.move(hx.x + hx.width / 2, hx.y + hx.height / 2);
  await page.mouse.down();
  await page.mouse.move(hx.x + hx.width / 2 - 200, hx.y + hx.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await preview.boundingBox())!.width)).toBe(Math.round(before.width - 200));
  // Höhe: unteren Griff 150 px nach unten
  await preview.hover();
  const fh = (await frame.boundingBox())!.height;
  const hy = (await wrap.getByTestId("html-resize-y").boundingBox())!;
  await page.mouse.move(hy.x + hy.width / 2, hy.y + hy.height / 2);
  await page.mouse.down();
  await page.mouse.move(hy.x + hy.width / 2, hy.y + hy.height / 2 + 150, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await frame.boundingBox())!.height)).toBe(Math.round(fh + 150));
  const w = Math.round((await preview.boundingBox())!.width), h = Math.round((await frame.boundingBox())!.height);
  // ⌘Z: die Höhe ist ein Schritt; ⇧⌘Z wieder her
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.round((await frame.boundingBox())!.height)).toBeLessThan(h);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => Math.round((await frame.boundingBox())!.height)).toBe(h);
  // nach dem Neuladen gleich (WebKit hat im flüchtigen Testprofil keinen dauerhaften Speicher)
  if (browserName === "webkit") return;
  await page.waitForTimeout(500);
  await page.reload();
  await expect(editor(page).getByTestId("html-preview")).toBeVisible();
  await expect.poll(async () => Math.round((await editor(page).getByTestId("html-preview").boundingBox())!.width)).toBe(w);
  await expect.poll(async () => Math.round((await editor(page).locator("iframe.bx-html-preview").boundingBox())!.height)).toBe(h);
});

test("HTML-Datei öffnen ersetzt den Code; HTML-Datei auf die Seite ziehen legt einen HTML-Block an", async ({ page }) => {
  await newPage(page);
  const wrap = await htmlBlock(page, "<p>old</p>");
  await wrap.hover();
  await wrap.getByTestId("code-open-html-input").setInputFiles({ name: "artifact.html", mimeType: "text/html", buffer: Buffer.from(ARTIFACT) });
  await expect(page.frameLocator("iframe.bx-html-preview").locator("#t")).toHaveText("Exported artifact");
  await expect(wrap).toHaveAttribute("data-view", "preview");

  // Ablegen unter dem Inhalt: neuer HTML-Block am Ende
  const tail = editor(page).getByTestId("block-editor-tail");
  const dt = await page.evaluateHandle((html) => {
    const d = new DataTransfer();
    d.items.add(new File([html.replace("Exported artifact", "Dropped artifact")], "drop.html", { type: "text/html" }));
    return d;
  }, ARTIFACT);
  await tail.dispatchEvent("dragover", { dataTransfer: dt });
  await tail.dispatchEvent("drop", { dataTransfer: dt });
  await expect(editor(page).getByTestId("code-block")).toHaveCount(2);
  await expect(page.frameLocator("iframe.bx-html-preview").nth(1).locator("#t")).toHaveText("Dropped artifact");
  await expect(page).toHaveURL(/#page-/); // der Browser hat die Datei nicht selbst geöffnet
});

for (const theme of ["light", "dark"] as const) {
  for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }]) {
    test(`Griffe beim Überfahren (${theme}, ${size.width}×${size.height})`, async ({ page, browserName }) => {
      await newPage(page, theme, size);
      const wrap = await htmlBlock(page, "<div style='padding:12px'><b>Habit tracker</b><p style='margin:4px 0 0'>Glasses of water: 3</p></div>");
      await wrap.getByTestId("html-preview").hover();
      await expect(wrap.getByTestId("html-resize-x")).toHaveCSS("opacity", "0.6");
      await expect(wrap.getByTestId("html-resize-y")).toHaveCSS("opacity", "0.6");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}web-editor-html-resize-${theme}-${size.width}x${size.height}.png` });
    });
  }
}

// Klareres Einbetten: Ergebnis auf einer Based-Karte, Grundstil in Based-Optik, Höhe stimmt und schaukelt sich nicht auf.
test("HTML-Ergebnis: Karte, Based-Grundstil, Schnipsel nicht abgeschnitten, 100vh-Datei wächst nicht endlos", async ({ page }) => {
  await newPage(page);
  const snip = await htmlBlock(page, "<h2>Packing list</h2><p>Text</p><button>Add item</button>");
  const preview = snip.getByTestId("html-preview");
  await expect(preview).toHaveCSS("background-color", await page.evaluate(() => {
    const p = document.createElement("i"); p.style.color = "var(--surface-soft)"; document.body.append(p);
    const c = getComputedStyle(p).color; p.remove(); return c;
  }));
  const inner = page.frameLocator("iframe.bx-html-preview").first();
  await expect(inner.locator("button")).toHaveCSS("height", "32px");
  await expect(inner.locator("button")).toHaveCSS("border-top-width", "0px");
  // die ganze Höhe des Inhalts ist zu sehen (Außenabstand der Überschrift fällt nicht aus dem body)
  await expect.poll(async () => inner.locator("body").evaluate((b) => b.scrollHeight <= innerHeight)).toBe(true);
  // eine Datei mit min-height: 100vh und Innenabstand hängt an der Fensterhöhe: der Rahmen hört auf zu wachsen
  const doc = await htmlBlock(page, "<!doctype html><html><body style='min-height:100vh;padding:24px'><p>Full page</p></body></html>");
  const frame = doc.locator("iframe.bx-html-preview");
  await expect(doc.getByTestId("html-preview")).toHaveAttribute("data-document", "");
  await page.waitForTimeout(800);
  const h1 = (await frame.boundingBox())!.height;
  await page.waitForTimeout(800);
  expect((await frame.boundingBox())!.height).toBe(h1);
  expect(h1).toBeLessThan(600);
});
