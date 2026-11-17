import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overflows, overlaps } from "./layout-checks.js";

// BSD-264 (Whiteboard 2): Board-Fläche im Browser – anlegen, Zettel setzen, verschieben, Größe ändern, Undo, Zoom,
// Tastatur, Rechtsklick, Neuladen. Die Fläche ist ein Canvas; geprüft wird über die Zustände an der Wurzel
// (data-objects, data-selected, data-tool), die Zoom-Anzeige und das, was nach dem Neuladen noch da ist.

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newBoard(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("board");
  await palette.getByRole("option", { name: "New board" }).click();
  const board = page.getByTestId("board");
  await expect(board).toBeVisible();
  return board;
}

/** Mitte der Fläche in Seitenkoordinaten. */
async function center(page: Page) {
  const b = (await page.getByTestId("board").boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

async function placeNote(page: Page, dx = 0, dy = 0) {
  const c = await center(page);
  await page.getByTestId("board-tool-note").click();
  await page.mouse.click(c.x + dx, c.y + dy);
  // BSD-266: ein neuer Zettel nimmt sofort Text an; Esc übernimmt (leer) und lässt ihn gewählt.
  await expect(page.getByTestId("board-edit")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("board-edit")).toHaveCount(0);
  return { x: c.x + dx, y: c.y + dy };
}

test("Board anlegen: leere Fläche erklärt den nächsten Schritt; Zettel setzen, verschieben, Undo/Redo", { tag: "@smoke" }, async ({ page }) => {
  await fresh(page);
  const board = await newBoard(page);
  await expect(page.getByRole("treeitem", { name: "Untitled board" })).toBeVisible();
  await expect(board).toContainText("Nothing on this board yet");
  await expect(board).toHaveAttribute("data-objects", "0");
  await expect(page.getByTestId("board-undo")).toBeDisabled();

  const at = await placeNote(page);
  await expect(board).toHaveAttribute("data-objects", "1");
  await expect(board).toHaveAttribute("data-selected", "1");
  await expect(board).toHaveAttribute("data-tool", "select");
  await expect(board).not.toContainText("Nothing on this board yet");

  // Ziehen: verschiebt (Auswahl bleibt), dann liegt an der alten Stelle nichts mehr.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 60, { steps: 6 });
  await page.mouse.up();
  await page.mouse.click(at.x - 60, at.y - 50); // alte linke obere Ecke: jetzt leer
  await expect(board).toHaveAttribute("data-selected", "0");
  await page.mouse.click(at.x + 120, at.y + 60);
  await expect(board).toHaveAttribute("data-selected", "1");

  await page.getByTestId("board-undo").click(); // Verschieben zurück
  await page.mouse.click(at.x, at.y);
  await expect(board).toHaveAttribute("data-selected", "1");
  await page.getByTestId("board-undo").click(); // Anlegen zurück
  await expect(board).toHaveAttribute("data-objects", "0");
  await page.getByTestId("board-redo").click();
  await page.getByTestId("board-redo").click();
  await expect(board).toHaveAttribute("data-objects", "1");
  await expect(page.getByTestId("board-redo")).toBeDisabled();

});

// Dauerhaftes Profil in beiden Browsern (WebKit hat im flüchtigen Testprofil kein OPFS, siehe persist-reload.spec.ts).
test("Board bleibt nach sofortigem Neuladen: Zettel und Lage sind da", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), "based-board-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on("dialog", (d) => void d.accept());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    await newBoard(page);
    const at = await placeNote(page, -200, -100);
    await placeNote(page, 180, 90);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y + 30, { steps: 4 });
    await page.mouse.up();
    await page.reload(); // sofort, ohne auf den Store-Worker zu warten
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const board = page.getByTestId("board");
    await expect(board).toHaveAttribute("data-objects", "2");
    // Nach dem Neuladen passt die Fläche den Inhalt ein; beide Zettel sind noch zwei getrennte Objekte.
    await board.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(board).toHaveAttribute("data-selected", "2");
    await expect(page.getByRole("treeitem", { name: "Untitled board" })).toBeVisible();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tastatur: N + Enter legt an, Tab wählt in Leserichtung und sagt es an, Pfeile schieben, Entf löscht, ⌘Z holt zurück", async ({ page }) => {
  await fresh(page);
  const board = await newBoard(page);
  await board.focus();
  await page.keyboard.press("n");
  await expect(board).toHaveAttribute("data-tool", "note");
  await page.keyboard.press("Enter");
  await expect(board).toHaveAttribute("data-objects", "1");
  await page.keyboard.press("r");
  await page.keyboard.press("Enter");
  await expect(board).toHaveAttribute("data-objects", "2");
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-selected", "0");
  await page.keyboard.press("Tab");
  await expect(board).toHaveAttribute("data-selected", "1");
  await expect(board.locator(".wb-live")).toHaveText(/^(Sticky note|Shape), 1 of 2$/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Delete");
  await expect(board).toHaveAttribute("data-objects", "1");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(board).toHaveAttribute("data-objects", "2");
  await page.keyboard.press("ControlOrMeta+a");
  await expect(board).toHaveAttribute("data-selected", "2");
  // Nach einem Klick auf eine Pille wirken die Tasten sofort weiter (Fokus zurück auf der Fläche).
  await page.getByTestId("board-zoom-in").click();
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-selected", "0");
  // ⌘K gehört weiter der App (⌘1–9 ebenso: Controller-Test)
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: /Search|Quick Find/i }).or(page.locator(".qf"))).toBeVisible();
});

test("Zoom: Knöpfe, ⌘+Rad um den Zeiger, Fit; waagrechtes Wischen auf der Fläche blättert nicht zurück", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click(); // ein Eintrag im Verlauf, zu dem „Zurück“ ginge
  const board = await newBoard(page);
  await placeNote(page);
  const zoom = page.getByTestId("board-zoom");
  await expect(zoom).toHaveText("100 %");
  await page.getByTestId("board-zoom-in").click();
  await expect(zoom).toHaveText("150 %");
  await page.getByTestId("board-zoom-out").click();
  await page.getByTestId("board-zoom-out").click();
  await expect(zoom).toHaveText("75 %");
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await expect(zoom).not.toHaveText("75 %");
  await page.getByRole("button", { name: "Zoom to fit" }).click();
  await expect(zoom).toHaveText("100 %");

  // Zwei Finger nach rechts/links: verschiebt die Fläche, die App bleibt auf dem Board (kein „Zurück“) –
  // auch wenn der Zeiger dabei über einer Pille steht (hier: noch über „Fit“).
  for (let i = 0; i < 6; i++) await page.mouse.wheel(-60, 0);
  await page.waitForTimeout(300);
  await expect(board).toBeVisible();
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(-60, 0);
  await page.waitForTimeout(300);
  await expect(board).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Untitled board" })).toHaveAttribute("aria-selected", "true");
  // der Zettel ist mitgewandert: in der Mitte liegt nichts mehr
  await page.mouse.click(c.x, c.y);
  await expect(board).toHaveAttribute("data-selected", "0");
});

test("Seitenaktionen auf einem Board: ⌘F, •••-Menü, Verlauf und Export öffnen ohne Fehler", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fresh(page);
  const board = await newBoard(page);
  await placeNote(page);
  await board.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Page menu" }).click();
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  await expect(menu).not.toContainText("Small text"); // Schrift-Optionen gelten für Textseiten
  await menu.getByText("Version history").click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-objects", "1");
  expect(errors).toEqual([]);
});

test("Viele Objekte: 4 096 Zettel weit herausgezoomt, Verschieben der Fläche bleibt flüssig", { tag: "@perf" }, async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await fresh(page);
  const board = await newBoard(page);
  await board.focus();
  await page.keyboard.press("n");
  await page.keyboard.press("Enter");
  // ⌘A + ⌘D verdoppelt: 1 → 4096
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+d");
    await expect(board).toHaveAttribute("data-objects", String(2 ** (i + 1)), { timeout: 60_000 });
  }
  await page.keyboard.press("Escape");
  for (let i = 0; i < 4; i++) await page.getByTestId("board-zoom-out").click();
  await expect(page.getByTestId("board-zoom")).toHaveText("10 %");
  const frames = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>("[data-testid=board] canvas")!;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: 12, deltaY: 9, bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      await new Promise((r) => setTimeout(r, 0));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { p50: times[10]!, p95: times[18]! };
  });
  console.log(`board pan ${browserName}, 4096 objects at 10 %: p50 ${frames.p50.toFixed(0)} ms, p95 ${frames.p95.toFixed(0)} ms`);
  // Gemessen 17.11. (Linux, Software-Canvas): Chromium ~20 ms, WebKit ~90 ms; vor der Fernsicht 40 bzw. 360 ms.
  expect(frames.p95).toBeLessThan(400);
});

test("Rechtsklick auf der Fläche: Based-Menü für die Auswahl, kein Systemmenü", async ({ page }) => {
  await fresh(page);
  const board = await newBoard(page);
  const at = await placeNote(page);
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-selected", "0");
  await page.evaluate(() => {
    (window as unknown as { __ctx?: boolean[] }).__ctx = [];
    window.addEventListener("contextmenu", (e) => (window as unknown as { __ctx: boolean[] }).__ctx.push(e.defaultPrevented), { once: true });
  });
  await page.mouse.click(at.x, at.y, { button: "right" });
  expect(await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx)).toEqual([true]);
  await expect(board).toHaveAttribute("data-selected", "1");
  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu.getByRole("menuitem", { name: /Duplicate/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Duplicate/ }).click();
  await expect(board).toHaveAttribute("data-objects", "2");
});

test("Board im Papierkorb: nur lesen – ansehen und zoomen ja, ändern nein; nach dem Wiederherstellen wieder bearbeitbar", async ({ page }) => {
  await fresh(page);
  await newBoard(page);
  await placeNote(page);
  await page.getByRole("button", { name: "Move to Trash" }).click();
  await page.getByRole("button", { name: "Trash" }).click();
  await page.getByText("Untitled board").first().click();
  const trashed = page.getByTestId("board");
  await expect(trashed).toHaveAttribute("data-objects", "1");
  await expect(page.getByTestId("board-tool-note")).toBeDisabled();
  await expect(page.getByTestId("board-undo")).toBeDisabled();
  await expect(page.getByTestId("board-hint")).toContainText("Read only");
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 150, c.y + 80, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(c.x + 150, c.y + 80);
  await expect(trashed).toHaveAttribute("data-selected", "0"); // nicht verschoben
  await page.getByTestId("board-zoom-in").click();
  await expect(page.getByTestId("board-zoom")).toHaveText("150 %");
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("board-tool-note")).toBeEnabled();
});

const SHOTS = "../../docs/design/screens/";
for (const theme of ["light", "dark"] as const) {
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    test(`Fläche ${w} × ${h} ${theme}: leer und gefüllt, nichts läuft über oder überdeckt sich`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.goto("/");
      await page.evaluate(() => { const a = localStorage.getItem("based.appearance"); localStorage.clear(); if (a) localStorage.setItem("based.appearance", a); });
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const board = await newBoard(page);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      expect(await overflows(page), "leer").toEqual([]);
      expect(await overlaps(page), "leer").toEqual([]);
      if (browserName === "chromium" && w === 1280) await page.screenshot({ path: `${SHOTS}board-empty-${theme}.png` });

      await placeNote(page, -160, -40);
      await placeNote(page, 60, 30);
      await page.getByTestId("board-tool-shape").click();
      const c = await center(page);
      await page.mouse.move(c.x - 250, c.y + 90);
      await page.mouse.down();
      await page.mouse.move(c.x - 90, c.y + 170, { steps: 4 });
      await page.mouse.up();
      await expect(board).toHaveAttribute("data-objects", "3");
      await page.keyboard.press("ControlOrMeta+a");
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      expect(await overflows(page), "gefüllt").toEqual([]);
      expect(await overlaps(page), "gefüllt").toEqual([]);
      // Die Pillen liegen ganz in der Fläche.
      const box = (await board.boundingBox())!;
      for (const sel of [".wb-tools", ".wb-history", ".wb-zoom"]) {
        const r = (await page.locator(sel).boundingBox())!;
        expect(r.x, sel).toBeGreaterThanOrEqual(box.x);
        expect(r.x + r.width, sel).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(r.y + r.height, sel).toBeLessThanOrEqual(box.y + box.height + 0.5);
      }
      // Hinweis und Minimap überdecken sich nicht (900 × 600: der Hinweis weicht).
      const hint = await page.locator(".wb-hint").boundingBox();
      const map = await page.locator(".wb-minimap").boundingBox();
      if (hint && map) expect(hint.x + hint.width, "Hinweis endet vor der Minimap").toBeLessThanOrEqual(map.x);
      if (w === 1280) await expect(page.locator(".wb-hint")).toBeVisible();
      if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}board-${w}x${h}-${theme}.png` });
    });
  }
}

// BSD-265–267 (Whiteboard 3–5): Stift, Textmarker, Radierer, Text, Frame, Verbindung im Browser.
async function stroke(page: Page, pts: [number, number][]) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
}
const curve = (x: number, y: number, n = 14): [number, number][] => Array.from({ length: n }, (_, i) => [x + i * 14, y + Math.sin(i / 2.2) * 26]);

test("Stift, Textmarker, Radierer: zeichnen, Farbe wählen, radieren, Undo; nach dem Neuladen ist die Tinte da", async ({ page, browserName }) => {
  await fresh(page);
  const board = await newBoard(page);
  const c = await center(page);
  await board.focus();
  await page.keyboard.press("p");
  await expect(board).toHaveAttribute("data-tool", "pen");
  await expect(page.getByTestId("board-options")).toBeVisible();
  await stroke(page, curve(c.x - 260, c.y - 120));
  await expect(board).toHaveAttribute("data-objects", "1");
  await page.getByTestId("board-color-blue").click();
  await page.getByTestId("board-width-2").click();
  await stroke(page, curve(c.x - 260, c.y - 20));
  await page.keyboard.press("Shift+P");
  await expect(board).toHaveAttribute("data-tool", "highlighter");
  await stroke(page, [[c.x - 260, c.y - 120], [c.x - 80, c.y - 120]]);
  await expect(board).toHaveAttribute("data-objects", "3");
  // Radierer: über den zweiten Strich reiben
  await page.keyboard.press("e");
  await stroke(page, [[c.x - 200, c.y - 70], [c.x - 200, c.y + 40]]);
  await expect(board).toHaveAttribute("data-objects", "2");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(board).toHaveAttribute("data-objects", "3");
  // Neuladen: WebKit behält den lokalen Speicher nur in einem dauerhaften Profil (siehe Test oben), darum hier Chromium.
  if (browserName !== "chromium") return;
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByTestId("board")).toHaveAttribute("data-objects", "3");
});

test("Text: Doppelklick ins Leere tippt los; Zettel nimmt sofort Text, Tab legt den nächsten an; Frame und Verbindung", async ({ page }) => {
  await fresh(page);
  const board = await newBoard(page);
  const c = await center(page);
  await page.mouse.dblclick(c.x - 300, c.y - 160);
  const edit = page.getByTestId("board-edit");
  await expect(edit).toBeFocused();
  await page.keyboard.type("Least squares picks the line");
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-objects", "1");
  // Tippen im Feld darf kein Werkzeug umschalten (p, e, n sind Kürzel).
  await expect(board).toHaveAttribute("data-tool", "select");

  await page.keyboard.press("n");
  await page.mouse.click(c.x - 200, c.y + 20);
  await expect(edit).toBeFocused();
  await page.keyboard.type("first");
  await page.keyboard.press("Tab");
  await expect(edit).toBeFocused();
  await page.keyboard.type("second");
  await page.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-objects", "3");

  // Verbindung vom ersten zum zweiten Zettel
  await page.keyboard.press("a");
  await stroke(page, [[c.x - 200, c.y + 20], [c.x - 100, c.y + 30], [c.x - 16, c.y + 20]]);
  await expect(board).toHaveAttribute("data-objects", "4");
  // Frame um beide Zettel
  await page.keyboard.press("f");
  await stroke(page, [[c.x - 320, c.y - 100], [c.x, c.y + 60], [c.x + 110, c.y + 130]]);
  await expect(board).toHaveAttribute("data-objects", "5");
  await page.mouse.move(0, 0);
  expect(await overflows(page)).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`Zeichnen ${theme}: Werkzeugleiste mit Optionen passt in 1280 × 820, 900 × 600 und 390 × 760`, async ({ page, browserName }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await page.evaluate(() => { const a = localStorage.getItem("based.appearance"); localStorage.clear(); if (a) localStorage.setItem("based.appearance", a); });
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const board = await newBoard(page);
    const c = await center(page);
    await page.mouse.dblclick(c.x - 80, c.y + 110);
    await page.keyboard.type("Least squares picks the line with the smallest sum of squared residuals.");
    await page.keyboard.press("Escape");
    await page.keyboard.press("n");
    await page.mouse.click(c.x + 250, c.y + 60);
    await page.keyboard.type("Check: are the residuals roughly normal?");
    await page.keyboard.press("Escape");
    await page.keyboard.press("p");
    await stroke(page, [[c.x - 300, c.y + 40], [c.x - 60, c.y + 44]]);
    await stroke(page, [[c.x - 298, c.y + 42], [c.x - 300, c.y - 150]]);
    await page.getByTestId("board-color-blue").click();
    await stroke(page, curve(c.x - 290, c.y - 20).map(([x, y], i) => [x, y - i * 9] as [number, number]));
    await page.getByTestId("board-color-red").click();
    await stroke(page, [[c.x - 200, c.y - 30], [c.x - 200, c.y - 62]]);
    await page.keyboard.press("Shift+P");
    await stroke(page, [[c.x - 80, c.y + 124], [c.x + 180, c.y + 124]]);
    await page.keyboard.press("p");
    await expect(board).toHaveAttribute("data-objects", "7");
    for (const [w, h] of [[1280, 820], [900, 600], [390, 760]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      expect(await overflows(page), `${w}`).toEqual([]);
      const box = (await board.boundingBox())!;
      for (const sel of [".wb-tools", ".wb-options"]) {
        const r = (await page.locator(sel).boundingBox())!;
        expect(r.x, `${sel} ${w}`).toBeGreaterThanOrEqual(box.x);
        expect(r.x + r.width, `${sel} ${w}`).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      const tools = (await page.locator(".wb-tools").boundingBox())!, options = (await page.locator(".wb-options").boundingBox())!;
      expect(options.y + options.height, `Optionen über der Leiste ${w}`).toBeLessThanOrEqual(tools.y);
      if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}board-draw-${w}x${h}-${theme}.png` });
    }
  });
}

test("Dateien: Bild und HTML-Datei ablegen – Bild als Bild, Datei als Karte; bleibt nach dem Neuladen; im Record steht nur die Adresse", async ({ page, browserName }) => {
  await fresh(page);
  const board = await newBoard(page);
  const png = readFileSync(join(process.cwd(), SHOTS, "board-empty-light.png"));
  await page.getByTestId("board-file-input").setInputFiles([
    { name: "lecture.png", mimeType: "image/png", buffer: png },
    { name: "report.html", mimeType: "text/html", buffer: Buffer.from("<h1>Report</h1><script>document.title='ran'</script>") },
  ]);
  await expect(board).toHaveAttribute("data-objects", "2");
  await expect(board).toHaveAttribute("data-selected", "2");
  await page.mouse.move(0, 0);
  expect(await overflows(page)).toEqual([]);
  await page.waitForTimeout(600);
  if (browserName !== "chromium") return;
  await page.screenshot({ path: `${SHOTS}board-files-light.png` });
  await page.reload();
  await expect(page.getByTestId("board")).toHaveAttribute("data-objects", "2");
  // Die Datei läuft nie in der App: der Titel bleibt der der Seite.
  expect(await page.title()).not.toBe("ran");
});
