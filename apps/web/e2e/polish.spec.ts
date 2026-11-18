import { expect, test, type Page } from "@playwright/test";
import { blockEditor, focusEditorEnd } from "./editor-helpers.js";

// Feinschliff (docs/quality/checklist.md): Mängel aus dem Durchgang vom 11. 11., jeweils mit einem Test, der den
// Rückfall verhindert.

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Home: der Composer ist im Startfenster (1280 × 820) ohne Scrollen ganz sichtbar", async ({ page }) => {
  for (const [width, height] of [[1280, 820], [1280, 720], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await fresh(page);
    await expect(page.getByTestId("time-arc")).toBeVisible();
    await expect.poll(() => page.locator(".panel").evaluate((el) => el.scrollHeight - el.clientHeight), { message: `${width}×${height}` }).toBeLessThanOrEqual(1);
    const dock = (await page.locator(".home-dock").boundingBox())!;
    expect(dock.y + dock.height).toBeLessThanOrEqual(height);
  }
  // Wird das Fenster wieder größer, nimmt der Bogen die volle Breite zurück.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await expect(page.getByTestId("time-arc")).not.toHaveAttribute("data-fitted", "");
});

test("Tabs tragen das Icon ihres Ziels, nicht pauschal das Haus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ modifiers: ["ControlOrMeta"] });
  const icon = (name: string) => page.getByRole("tab", { name }).locator("svg path").first().getAttribute("d");
  const library = await icon("Library");
  expect(library).toBe(await page.getByRole("button", { name: "Library" }).locator("svg path").first().getAttribute("d"));
  expect(library).not.toBe(await icon("Welcome to Based"));
});

// BSD-407 Teil 6.1: Editor-Menüs sehen aus wie das Seitenmenü – Überfahren = `.menu-item:hover` (--surface-raised).
test("Slash-Menü: Überfahren färbt die Zeile wie das Seitenmenü, nicht mit dem Blau der Bibliothek", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("button", { name: "New page" }).first().click();
  await focusEditorEnd(page);
  await page.keyboard.type("/");
  const item = page.getByTestId("slash-menu").getByRole("option").nth(4);
  await item.hover();
  const [bg, selected, ink, color] = await item.evaluate((el) => {
    const probe = document.createElement("i");
    probe.style.cssText = "background: var(--surface-raised); color: var(--ink)";
    document.body.append(probe);
    const p = getComputedStyle(probe);
    const out = [getComputedStyle(el).backgroundColor, p.backgroundColor, p.color, getComputedStyle(el).color];
    probe.remove();
    return out;
  });
  expect(bg).toBe(selected);
  expect(color).toBe(ink);
});

test("Seitenleiste: im ruhigen Zustand nur der Punkt, Text nur wenn etwas Aufmerksamkeit braucht – und nie gekürzt (BSD-308)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  const status = page.getByTestId("sync-status");
  const text = status.locator(".synced-text");
  const set = (state: string, label: string) => status.evaluate((el, [s, l]) => {
    el.setAttribute("data-state", s!);
    el.querySelector(".synced-text")!.textContent = l!;
  }, [state, label]);
  const width = () => text.evaluate((el) => el.getBoundingClientRect().width);

  for (const [state, label] of [["local", "On this device"], ["synced", "Synced"]] as const) {
    await set(state, label);
    expect(await width(), state).toBeLessThanOrEqual(1);
    await expect(status.locator(".dot")).toBeVisible();
    await expect(status).toHaveText(label); // bleibt für Screenreader lesbar
    // BSD-422: statt Tooltip eine Karte mit Details (eigener Test unten); der Name bleibt für Screenreader
    await expect(status).toHaveAttribute("aria-label", /^Sync status: /);
  }
  for (const [state, label] of [["memory", "Not saved"], ["offline", "Offline"], ["error", "Sync error"], ["readonly", "Read-only"], ["syncing", "Syncing…"], ["starting", "Opening…"]] as const) {
    await set(state, label);
    await expect(text, state).toBeVisible();
    expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth), `${state} ungekürzt`).toBe(true);
  }
});

// Feedback 11. 11. (Mac): Ampel, Knopf „Show sidebar“ und die Pfeile der Kopfzeile lagen übereinander.
test("Seitenleiste ausgeblendet: der Knopf zum Einblenden steht in einer eigenen Zeile über der Seite und überdeckt nichts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  for (const shell of ["web", "desktop"] as const) {
    await page.evaluate((s) => { if (s === "desktop") document.documentElement.dataset.shell = "desktop"; }, shell);
    if (await page.locator("nav.sidebar").isVisible()) await page.keyboard.press("ControlOrMeta+Backslash");
    const show = (await page.getByTestId("sidebar-show").boundingBox())!;
    const panel = (await page.locator(".panel").boundingBox())!;
    const back = (await page.getByRole("button", { name: /^Back/ }).first().boundingBox())!;
    expect(show.y + show.height, shell).toBeLessThanOrEqual(panel.y); // ganz über dem Panel
    expect(back.y, shell).toBeGreaterThanOrEqual(show.y + show.height); // Pfeile liegen darunter, nicht daneben
    if (shell === "desktop") expect(show.x).toBeGreaterThanOrEqual(76); // rechts neben der Ampel (18 … 70 px)
    // Hover-Vorschau: unter der Zeile, bündig mit dem Panel, ohne zweiten Seitenleisten-Knopf und ohne Leerraum oben
    await page.mouse.move(2, 400);
    const peek = page.locator("nav.sidebar.peek");
    await expect(peek).toBeVisible();
    const pk = (await peek.boundingBox())!;
    expect(Math.round(pk.y), shell).toBe(Math.round(panel.y));
    expect(pk.y, shell).toBeGreaterThanOrEqual(show.y + show.height);
    await expect(peek.getByTestId("sidebar-hide")).toBeHidden();
    const brand = (await peek.locator(".brand").boundingBox())!;
    expect(brand.y - pk.y, shell).toBeLessThanOrEqual(20);
    await page.mouse.move(700, 400);
    await expect(peek).toBeHidden();
  }
  // Mit Tabs: die Tab-Leiste beginnt rechts neben Ampel und Knopf.
  await page.getByTestId("sidebar-show").click();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ControlOrMeta+Backslash");
  const show = (await page.getByTestId("sidebar-show").boundingBox())!;
  const tab = (await page.getByRole("tab").first().boundingBox())!;
  expect(tab.x).toBeGreaterThanOrEqual(show.x + show.width);
});

test("Gliederung: die Markierung folgt dem Scrollen; am Seitenende gilt die letzte Überschrift", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("button", { name: "New page" }).first().click();
  await focusEditorEnd(page);
  // Die Gliederung hängt sich ein, solange die Seite noch nicht scrollt – genau der Fall, in dem sie früher stehen blieb.
  for (const h of ["One", "Two", "Three", "Four"]) {
    await page.keyboard.type(`## ${h}`);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 16; i++) { await page.keyboard.type("t"); await page.keyboard.press("Enter"); }
  }
  const outline = page.getByTestId("page-outline");
  const current = () => outline.locator("[aria-current]").getAttribute("data-tip");
  const panel = page.locator(".panel");
  await panel.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(current).toBe("One");
  await blockEditor(page).locator(".bx2-block", { hasText: /^Two$/ }).last().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(current).toBe("Two");
  await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(current).toBe("Four");
  await panel.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(current).toBe("One");
});

// Feedback 11. 11. (Mac): „alle Seiten löschen“ in der Library und „Papierkorb leeren“ reagierten nicht. Die Arbeit
// im Speicher ist jetzt linear (store-perf.test.ts); hier: die Oberfläche bleibt bedienbar und sagt, was läuft.
test("Alles löschen: Library → alle in den Papierkorb, Papierkorb leeren; die Oberfläche bleibt bedienbar", { tag: "@perf" }, async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown> } } }).__based.client.command({ op: "seed", count: 1000 }));
  await expect(page.getByRole("treeitem", { name: "Page 0001" })).toBeVisible();
  // Hänger-Messer: größte Lücke zwischen zwei 20-ms-Ticks
  await page.evaluate(() => { const g = globalThis as { __gap?: number }; g.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); g.__gap = Math.max(g.__gap!, n - last - 20); last = n; }, 20); });
  const gap = () => page.evaluate(() => { const g = globalThis as { __gap?: number }; const v = g.__gap ?? 0; g.__gap = 0; return Math.round(v); });
  const steps: string[] = [];
  const mark = async (name: string) => steps.push(`${name}: ${await gap()}`);
  const trashCount = () => page.evaluate(() => (globalThis as unknown as { __based: { client: { getState(): { outline?: { trash: unknown[] } } } } }).__based.client.getState().outline?.trash.length ?? 0);

  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library" }).click();
  // Die Library lädt ihre Einträge nachträglich; vorher ist „Select all“ gesperrt.
  await expect(page.getByRole("list", { name: "Library items" }).getByRole("listitem").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: "Select all" }).click({ force: true });
  await expect(page.getByTestId("library-selected")).toContainText(/\d{4} selected/);
  await mark('await page.getByRole("checkbox", { name:');
  await page.getByRole("button", { name: "Move to Trash" }).first().click();
  await mark('await page.getByRole("button", { name: "');
  await page.getByRole("button", { name: "Move to Trash" }).last().click();
  await expect.poll(trashCount, { timeout: 60_000 }).toBeGreaterThanOrEqual(1000);
  await expect(page.getByRole("treeitem", { name: "Page 0001" })).toHaveCount(0);
  await mark('await expect(page.getByRole("treeitem", ');

  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: /^Trash/ }).click();
  // nur eine Seite voll Zeilen im DOM, der Rest auf Wunsch
  await expect(page.getByRole("list", { name: "Pages in Trash" }).getByRole("listitem")).toHaveCount(100);
  await expect(page.getByTestId("trash-more")).toContainText(/\d+ more in Trash/);
  await page.getByRole("button", { name: "Empty Trash" }).click();
  await mark('await page.getByRole("button", { name: "');
  await page.getByRole("button", { name: /^Delete \d+ forever$/ }).click();
  await mark('await page.getByRole("button", { name: /');
  await expect(page.getByTestId("trash-emptying")).toBeVisible();
  await expect.poll(trashCount, { timeout: 60_000 }).toBe(0);
  await expect(page.getByText("The Trash is empty.")).toBeVisible();
  await mark('await expect(page.getByText("The Trash i');
  for (const st of steps) expect(Number(st.split(": ").pop()), st).toBeLessThan(1000);
});

// BSD-367: Fokus und Auswahl sind neutral (grau hell, weiß dunkel) – auch mit Marker „Mint“, der vorher grüne
// Fokusrahmen in Tabelle, Feldern und Editor erzeugte. Der Marker bleibt der Agentenarbeit vorbehalten.
test("Fokusrahmen und Textauswahl neutral, unabhängig vom Marker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  for (const theme of ["light", "dark"] as const) {
    await page.goto("/");
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem("based.appearance", JSON.stringify({ theme: t, marker: "mint" })); }, theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const tok = (name: string) => page.evaluate((n) => {
      const probe = document.createElement("i");
      probe.style.color = `var(--${n})`;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, name);
    const ring = await tok("focus-ring");
    expect(ring).not.toBe(await tok("marker-strong"));
    // Tastatur-Fokus auf einem Knopf der Seitenleiste
    await page.getByRole("button", { name: "Search" }).first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineColor);
    expect(outline, theme).toBe(ring);
    // Textauswahl
    const sel = await page.evaluate(() => getComputedStyle(document.body, "::selection").backgroundColor);
    expect(sel, theme).toBe(await tok("selection-bg"));
  }
});

// BSD-376: Die Icon-Auswahl rollt nur senkrecht – das Raster passt zur Breite, die erste Spalte ist ganz sichtbar.
test("Icon-Auswahl: kein seitliches Rollen, Raster passt zur Breite", async ({ page }) => {
  for (const [width, height] of [[1280, 820], [900, 600]] as const) {
    await page.setViewportSize({ width, height });
    await fresh(page);
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await page.getByLabel("Page title").hover();
    await page.getByRole("button", { name: "Add icon" }).click();
    const grid = page.getByRole("listbox", { name: "Emoji" });
    await expect(grid).toBeVisible();
    // Breite Emoji-Glyphen wie auf dem Mac (Apple Color Emoji) nachstellen: Zellen dürfen trotzdem nicht breiter werden.
    await page.addStyleTag({ content: ".bx-emoji-cell { font-size: 40px; }" });
    const [sw, cw] = await grid.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(sw - cw, `${width}×${height}`).toBeLessThanOrEqual(0);
    const first = (await grid.getByRole("option").first().boundingBox())!;
    const box = (await grid.boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(box.x - 0.5);
    await page.keyboard.press("Escape");
  }
});

// BSD-376 (Mac 13.11.): In WebKit fielen die Rasterzeilen zusammen, Emojis lagen übereinander. Zeilen haben eine
// feste Höhe – keine zwei Zellen dürfen sich senkrecht überlappen, auch mit großen Glyphen.
test("Icon-Auswahl: Rasterzellen überlappen sich nicht", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByLabel("Page title").hover();
  await page.getByRole("button", { name: "Add icon" }).click();
  const grid = page.getByRole("listbox", { name: "Emoji" });
  await page.addStyleTag({ content: ".bx-emoji-cell { font-size: 40px; }" });
  const cells = grid.getByRole("option");
  const a = (await cells.nth(0).boundingBox())!;
  const b = (await cells.nth(10).boundingBox())!; // erste Zelle der zweiten Zeile
  expect(a.height).toBeGreaterThanOrEqual(28);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 0.5);
});

// BSD-376 Teil 2: Reiter „Icons“ mit Phosphor in Farben; das gewählte Icon steht im Titel und in der Seitenleiste
// (gespeichert wird es als String wie ein Emoji – Persistenz deckt der Emoji-Fall ab).
test("Icon-Auswahl: Phosphor-Icon mit Farbe als Seiten-Icon", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByLabel("Page title").hover();
  await page.getByRole("button", { name: "Add icon" }).click();
  await page.getByRole("tab", { name: "Icons" }).click();
  const grid = page.getByRole("listbox", { name: "Icons" });
  await expect(grid.getByRole("option").first()).toBeVisible();
  expect(await grid.getByRole("option").count()).toBeGreaterThan(1000);
  await page.getByRole("radio", { name: "blue" }).click();
  await page.getByLabel("Filter icons").fill("rocket");
  await expect(grid.getByRole("option").first()).toHaveAttribute("data-icon", /^rocket/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Choose an icon" })).toHaveCount(0);
  const head = page.locator(".page-icon .bx-phosphor");
  await expect(head).toHaveAttribute("data-phosphor", /^rocket/);
  await expect(page.getByRole("treeitem", { name: "Welcome to Based" }).locator(".bx-phosphor")).toBeVisible();
  const color = await head.evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe(await page.locator("body").evaluate((el) => getComputedStyle(el).color));
  // Wieder öffnen: Reiter „Icons“ und die Farbe sind vorgewählt.
  await page.locator(".page-icon").click();
  await expect(page.getByRole("tab", { name: "Icons" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("radio", { name: "blue" })).toHaveAttribute("aria-checked", "true");
});

// BSD-347: Unterseiten-Blöcke, Seiten-Erwähnungen und Datei-Blöcke ohne eigenes Icon zeigen das Linien-Icon des
// Based-Satzes (wie die Seitenleiste), kein Emoji 📄/📎. Gesetzte Emoji-Icons bleiben.
test("Unterseite, Erwähnung und Datei ohne Icon: Linien-Icon statt Emoji", async ({ page }) => {
  await fresh(page);
  const cmd = (c: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command(x), c);
  const host = await cmd({ op: "createPage", title: "Icon host" });
  await cmd({ op: "createPage", title: "Plain child", parent: host });
  await cmd({ op: "createPage", title: "Mention target" });
  await page.goto(`/#page-${host}`);
  const ed = blockEditor(page);
  await expect(ed.locator(".bx2-pagelink", { hasText: "Plain child" })).toBeVisible();
  await focusEditorEnd(page);
  await page.keyboard.type("See @Mention targ");
  await expect(page.getByTestId("mention-menu").getByRole("option", { name: /Mention target/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/File");
  await page.keyboard.press("Enter");
  await ed.locator("input[type=file]").last().setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("based") });
  const link = ed.locator(".bx2-pagelink", { hasText: "Plain child" });
  const mention = ed.locator(".bx2-mention[data-page]").first();
  const file = ed.locator(".bx2-file", { hasText: "notes.txt" });
  for (const el of [link, mention, file]) {
    await expect(el.locator("svg").first()).toBeVisible();
    await expect(el).not.toContainText(/📄|📎|📕|▦/u);
  }
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    await page.waitForTimeout(800);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await expect(file).toBeVisible();
        await page.mouse.move(w - 10, h - 10);
        await page.screenshot({ path: `../../docs/design/screens/web-block-editor-icons-${theme}-${w}x${h}.png` });
      }
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  }
});

// BSD-344: Lange Seiten haben Luft unter der letzten Zeile (die letzte Zeile klebt nach dem Rollen nicht am Fensterrand),
// kurze Seiten rollen dadurch nicht.
test("Luft unter der letzten Zeile nur auf langen Seiten", async ({ page }) => {
  await fresh(page);
  const cmd = (c: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command(x), c);
  const id = await cmd({ op: "createPage", title: "Air below" });
  await page.goto(`/#page-${id}`);
  const ed = blockEditor(page);
  await focusEditorEnd(page);
  await page.keyboard.type("Short page");
  const panel = page.locator(".panel").first();
  await page.waitForTimeout(300);
  await expect(ed).not.toHaveAttribute("data-long", "");
  expect(await panel.evaluate((p) => p.scrollHeight - p.clientHeight)).toBeLessThanOrEqual(1);
  // lang: viele Absätze
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}`).join("\n\n"));
  await expect(ed.locator("[data-editable-id]", { hasText: "Paragraph 40" })).toBeVisible();
  await expect(ed).toHaveAttribute("data-long", "");
  await panel.evaluate((p) => { p.scrollTop = p.scrollHeight; });
  await page.waitForTimeout(200);
  const gap = await page.evaluate(() => {
    const last = [...document.querySelectorAll("[data-testid=block-editor] [data-editable-id]")].at(-1)!.getBoundingClientRect();
    const panel = document.querySelector(".panel")!.getBoundingClientRect();
    return (panel.bottom - last.bottom) / panel.height;
  });
  expect(gap).toBeGreaterThan(0.3);
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await expect(ed.locator("[data-editable-id]", { hasText: "Paragraph 40" })).toBeAttached();
        await page.waitForTimeout(300);
        await panel.evaluate((p) => { p.scrollTop = p.scrollHeight; });
        await page.waitForTimeout(200);
        await page.screenshot({ path: `../../docs/design/screens/web-block-editor-air-below-${theme}-${w}x${h}.png` });
      }
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  }
});

// BSD-422: Sync-Status in der Seitenleiste – Überfahren und Tastaturfokus zeigen die Karte mit Speicherort und
// Zustand, Klick öffnet Einstellungen → Sync.
test("Sync-Status: Karte beim Überfahren und mit der Tastatur, Klick öffnet die Sync-Einstellungen", async ({ page }) => {
  await fresh(page);
  const status = page.getByTestId("sync-status");
  const card = page.getByTestId("sync-card");
  await expect(card).toBeHidden();
  await status.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Stored");
  await expect(card).toContainText(/This device only|In memory only/); // WebKit: frisches Profil ohne OPFS
  await expect(card).toContainText("Status");
  // Karte ganz im Fenster und über dem Status
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await status.hover();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `../../docs/design/screens/web-sync-card-${theme}-${w}x${h}.png` });
      }
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  }
  await page.mouse.move(700, 400);
  await expect(card).toBeHidden();
  await status.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(status).toBeFocused();
  await expect(card).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#prefs-sync/);
});

// BSD-429: In einem Synced Block liegen „+“ und Griff der Kinder links neben der Randlinie, nicht auf ihr –
// in allen drei Fenstergrößen; auch für ein eingerücktes Kind.
test("Synced Block: Griff und Plus der Kinder schneiden die Randlinie nicht", async ({ page }) => {
  await fresh(page);
  const cmd = (c: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command(x), c);
  const host = await cmd({ op: "createPage", title: "Synced host" });
  await page.goto(`/#page-${host}`);
  const ed = blockEditor(page);
  await focusEditorEnd(page);
  await page.keyboard.type("Shared line");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Nested line");
  const first = ed.locator(".bx2-block").first();
  await first.locator(".bx2-row").first().hover();
  await first.locator(":scope > .bx2-gutter [data-handle]").click();
  await page.keyboard.type("copy and sync");
  await page.keyboard.press("Enter");
  const synced = ed.locator(".bx2-synced");
  await expect(synced).toContainText("Nested line");
  // ohne Neuladen (WebKit speichert in den Tests nur im Speicher); das Theme ändert die Geometrie nicht, die Fotos
  // hell/dunkel macht editor-parity.spec.ts „Fotos: Synced-Block-Kopie“
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const text of ["Shared line", "Nested line"]) {
      const child = synced.locator(".bx2-block", { has: page.locator(":scope > .bx2-row", { hasText: text }) });
      await child.locator(":scope > .bx2-row").hover();
      const gutter = child.locator(":scope > .bx2-gutter");
      await expect(gutter).toHaveCSS("opacity", "1");
      const plus = (await gutter.getByRole("button", { name: "Add block below" }).boundingBox())!;
      const grip = (await gutter.locator("[data-handle]").boundingBox())!;
      const g = { x: Math.min(plus.x, grip.x), width: Math.max(plus.x + plus.width, grip.x + grip.width) - Math.min(plus.x, grip.x) };
      const line = await synced.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.left + parseFloat(getComputedStyle(el).borderLeftWidth) }; });
      const clear = g.x + g.width <= line.left || g.x >= line.right;
      expect(clear, `${text} ${w}×${h}: Griff ${g.x}–${g.x + g.width}, Linie ${line.left}–${line.right}`).toBe(true);
    }
  }
});

// BSD-260 Teil 17: Text- und CSV-Dateien aus der Ablage zeigen im Datei-Block eine Vorschau (Text in Monospace, CSV als
// Tabelle mit erkanntem Trennzeichen); andere Dateien bleiben ein Link. Fotos mit BASED_SCREENSHOTS=1 (Chromium).
test("Datei-Block: Vorschau für Text und CSV", async ({ page }) => {
  await fresh(page);
  const cmd = (c: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command(x), c);
  const host = await cmd({ op: "createPage", title: "File preview" });
  await page.goto(`/#page-${host}`);
  const ed = blockEditor(page);
  await focusEditorEnd(page);
  const upload = async (name: string, mimeType: string, body: string) => {
    await page.keyboard.type("/File");
    await page.keyboard.press("Enter");
    await ed.locator("input[type=file]").last().setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
    await expect(ed.locator(".bx2-file", { hasText: name })).toBeVisible();
    await focusEditorEnd(page);
  };
  await upload("notes.txt", "text/plain", "First line\nSecond line");
  await upload("prices.csv", "text/csv", "Item;Price\nApple;1,20\nPear;0,90\n");
  await upload("blob.bin", "application/octet-stream", "\u0000\u0001");
  const previews = ed.getByTestId("file-preview");
  await expect(previews).toHaveCount(2);
  await expect(previews.nth(0)).toHaveAttribute("data-kind", "text");
  await expect(previews.nth(0)).toContainText("Second line");
  const table = previews.nth(1).locator("table");
  await expect(table.locator("th")).toHaveText(["Item", "Price"]);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText(["Apple", "1,20"]);
  // Vorschau ist Inhalt: markierbar
  await expect(previews.nth(0)).toHaveCSS("user-select", "text");
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await expect(previews).toHaveCount(2);
        await page.mouse.move(w - 10, h - 10);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-block-editor-file-preview-${theme}-${w}x${h}.png` });
      }
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  }
});

// BSD-484: Jeder Gruppenkopf im Slash-Menü höchstens einmal – ungefiltert (vorher „Advanced“ zweimal) und gefiltert.
test("Slash-Menü: Gruppenköpfe kommen je einmal vor, auch beim Filtern", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await focusEditorEnd(page);
  const menu = page.getByTestId("slash-menu");
  const heads = () => menu.locator(".bx2-menu-label").allTextContents();
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  const all = await heads();
  expect(all.filter((h) => h === "Advanced")).toHaveLength(1);
  expect(new Set(all).size).toBe(all.length);
  for (const q of ["h", "e", "co"]) {
    await page.keyboard.type(q);
    await expect(menu.getByRole("option").first()).toBeVisible();
    const filtered = await heads();
    expect(new Set(filtered).size, `/${q}: ${filtered.join(", ")}`).toBe(filtered.length);
    if (q === "h" && browserName === "chromium") {
      await page.screenshot({ path: "../../docs/design/screens/slash-menu-groups-light.png" });
      await page.keyboard.press("ControlOrMeta+Shift+l");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.waitForTimeout(400);
      await page.screenshot({ path: "../../docs/design/screens/slash-menu-groups-dark.png" });
      await page.keyboard.press("ControlOrMeta+Shift+l");
    }
    for (let i = 0; i < q.length; i++) await page.keyboard.press("Backspace");
  }
});

// BSD-498: Unten im Fenster klappen Slash- und @-Menü über die Zeile, statt sie zu überdecken.
test("Slash- und @-Menü überdecken die Eingabezeile nicht, auch unten im Fenster", async ({ page, browserName }) => {
  for (const [w, h] of [[1280, 820], [900, 600]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await fresh(page);
    await page.keyboard.press("ControlOrMeta+Alt+n");
    await focusEditorEnd(page);
    // Zeilen bis kurz vor den unteren Rand
    for (let i = 0; i < 40; i++) {
      const box = await page.locator("[data-editable-id]:focus").boundingBox();
      if (box && box.y > h - 140) break;
      await page.keyboard.type(`Line ${i + 1}`);
      await page.keyboard.press("Enter");
    }
    const line = (await page.locator("[data-editable-id]:focus").boundingBox())!;
    for (const [key, id] of [["/", "slash-menu"], ["@", "mention-menu"]] as const) {
      await page.keyboard.type(key);
      const menu = page.getByTestId(id);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("option").first()).toBeVisible();
      const m = (await menu.boundingBox())!;
      const overlaps = m.y < line.y + line.height && m.y + m.height > line.y;
      expect(overlaps, `${key} ${w} × ${h}: Menü ${Math.round(m.y)}–${Math.round(m.y + m.height)}, Zeile ${Math.round(line.y)}–${Math.round(line.y + line.height)}`).toBe(false);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y + m.height).toBeLessThanOrEqual(h);
      if (key === "/" && w === 1280 && browserName === "chromium") {
        await page.screenshot({ path: "../../docs/design/screens/slash-menu-above-light.png" });
        await page.keyboard.press("ControlOrMeta+Shift+l");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.waitForTimeout(400);
        await page.screenshot({ path: "../../docs/design/screens/slash-menu-above-dark.png" });
        await page.keyboard.press("ControlOrMeta+Shift+l");
      }
      // Filtern: das Menü bleibt über der Zeile
      if (key === "/") {
        await page.keyboard.type("he");
        await expect(menu.getByRole("option").first()).toBeVisible();
        const f = (await menu.boundingBox())!;
        expect(f.y + f.height, "gefiltert über der Zeile").toBeLessThanOrEqual(line.y + 1);
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await page.keyboard.press("Backspace");
    }
  }
});

// BSD-562: Mit Font „Based“ (Schibsted Grotesk) machten die globalen Tabellenziffern auch Komma und Punkt so breit wie
// eine Ziffer – im Fließtext stand eine Lücke vor jedem Satzzeichen. Im Fließtext ist das Komma deutlich schmaler als
// in `t-meta` (Tabellenziffern, Komma so breit wie eine Ziffer).
test("Font „Based“: Komma und Punkt im Fließtext ohne Lücke, Zeiten behalten Tabellenziffern", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", font: "based" })));
  await page.goto("/#prefs-appearance");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const widths = await page.evaluate(async () => {
    await document.fonts.load("450 13px 'Schibsted Grotesk'");
    await document.fonts.ready;
    const measure = (cls: string) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = "0,.";
      document.querySelector("[data-testid=settings-page]")!.appendChild(el);
      const w = (i: number) => { const r = document.createRange(); r.setStart(el.firstChild!, i); r.setEnd(el.firstChild!, i + 1); return r.getBoundingClientRect().width; };
      const out = { zero: w(0), comma: w(1), period: w(2), font: getComputedStyle(el).fontFamily };
      el.remove();
      return out;
    };
    return { desc: measure("t-desc"), meta: measure("t-meta") };
  });
  expect(widths.desc.font).toContain("Schibsted Grotesk");
  expect(widths.meta.comma, JSON.stringify(widths)).toBeGreaterThanOrEqual(widths.meta.zero);
  expect(widths.desc.comma, JSON.stringify(widths)).toBeLessThan(widths.meta.comma * 0.7);
  expect(widths.desc.period, JSON.stringify(widths)).toBeLessThan(widths.meta.period * 0.7);
  // Zeit und Anzahl: Tabellenziffern bleiben
  expect(await page.evaluate(() => { const el = document.createElement("span"); el.className = "t-meta"; document.body.appendChild(el); const v = getComputedStyle(el).fontVariantNumeric; el.remove(); return v; })).toBe("tabular-nums");
});

// BSD-571: Rest von BSD-562 – packages/database-ui setzte an `.dbui-root` und `.dbui-data` die Tabellenziffern erneut,
// mit Font „Based“ (Schibsted Grotesk) stand dort weiter eine Lücke vor Komma und Punkt („Nov 18 , 2026“). Titel und
// Datum sind proportional, Zahlenspalten behalten Tabellenziffern (ohne breites Komma) und fluchten rechts. Fotos mit BASED_SCREENSHOTS=1.
test("Font „Based“: keine Lücke vor Komma und Punkt in der Datenbank-Tabelle, Zahlen fluchten", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => { if (!localStorage.getItem("based.appearance")) localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", font: "based" })); });
  await fresh(page);
  await expect(page.locator("html")).toHaveAttribute("data-typeface", "based");
  const blockID = await page.evaluate(async () => {
    interface Store {
      blocks: Map<string, { props?: { databaseID?: string } }>;
      databases: Map<string, Record<string, unknown>>;
      children(parent: string): string[];
      transact(name: string, f: (tx: { put(r: unknown): void; remove(k: string): void }) => void): void;
    }
    const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string>; openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const id = await b.client.command({ op: "createDatabase", title: "Punctuation" });
    const { store } = await b.client.openPage(id);
    const dbID = store.blocks.get(id)!.props!.databaseID!;
    const db = store.databases.get(dbID)!;
    const now = (Date.now() - 978_307_200_000) / 1000;
    const day = (d: number) => ({ date: { _0: { start: (new Date(2026, 10, d).getTime() - 978_307_200_000) / 1000, includeTime: false } } });
    const num = (n: number) => ({ number: { _0: n } });
    store.transact("Seed", (tx) => {
      for (const r of [...store.children("d:" + dbID)]) tx.remove("block:" + r);
      tx.put({ kind: "database", data: { ...db, properties: [{ id: "title", name: "Name", type: "title" }, { id: "when", name: "Date", type: "date", dateFormat: "MMM D, YYYY" }, { id: "n", name: "Amount", type: "number", numberFormat: "numberWithCommas" }] } });
      [["Plan, review and ship.", 18, 1234.56], ["Write notes, then rest.", 19, 12.34], ["Call Ada, Bob and Eve.", 20, 98765.25]].forEach(([t, d, n], i) =>
        tx.put({ kind: "block", data: { id: crypto.randomUUID(), type: "page", parent: "d:" + dbID, sk: "c0" + i, text: t, values: { when: day(d as number), n: num(n as number) }, createdAt: now, updatedAt: now } }));
    });
    return id;
  });
  await page.evaluate((id) => (globalThis as unknown as { __based: { history: { navigate(r: unknown): void } } }).__based.history.navigate({ name: "page", id }), blockID);
  const dateCell = page.locator(".dbui-table .dbui-data", { hasText: "Nov 18, 2026" }).first();
  await expect(dateCell).toBeVisible();
  const titleCell = page.locator(".dbui-table .dbui-cell.title", { hasText: "Plan, review and ship." }).first();
  await expect(titleCell).toBeVisible();
  await expect.poll(() => dateCell.evaluate((el) => document.fonts.check(`${getComputedStyle(el).fontWeight} ${getComputedStyle(el).fontSize} "Schibsted Grotesk"`))).toBe(true);
  // Breite eines Zeichens im Verhältnis zur Schriftgröße: Komma/Punkt proportional ≈ 0,27 em, tabellarisch ≈ 0,63 em
  const em = (loc: typeof dateCell, ch: string) => loc.evaluate((root, c) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      const i = n.data.indexOf(c);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      return r.getBoundingClientRect().width / parseFloat(getComputedStyle(n.parentElement!).fontSize);
    }
    return -1;
  }, ch);
  await expect.poll(() => em(dateCell, ",")).toBeGreaterThan(0);
  expect(await em(dateCell, ",")).toBeLessThan(0.4);
  expect(await em(titleCell, ",")).toBeGreaterThan(0);
  expect(await em(titleCell, ",")).toBeLessThan(0.4);
  expect(await em(titleCell, ".")).toBeLessThan(0.4);
  expect(await dateCell.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toBe("normal");
  // Zahlenspalte: Tabellenziffern, rechte Kanten und Dezimalpunkte stehen untereinander
  const nums = page.locator(".dbui-table .dbui-num");
  await expect(nums).toHaveCount(3);
  for (const v of await nums.evaluateAll((els) => els.map((el) => getComputedStyle(el).fontVariantNumeric))) expect(v).toBe("tabular-nums");
  const edges = await nums.evaluateAll((els) => els.map((el) => {
    const point = [...el.querySelectorAll(".dbui-punct")].find((p) => p.textContent === ".")!;
    return { right: el.getBoundingClientRect().right, point: point.getBoundingClientRect().left };
  }));
  for (const e of edges) {
    expect(Math.abs(e.right - edges[0]!.right), JSON.stringify(edges)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.point - edges[0]!.point), JSON.stringify(edges)).toBeLessThanOrEqual(1);
  }
  // Komma und Punkt in der Zahl sind schmal (nur die Ziffern tabellarisch), der Wert liest sich unverändert
  await expect(nums.first()).toHaveText("1,234.56");
  expect(await em(nums.first(), ",")).toBeLessThan(0.4);
  expect(await em(nums.first(), ".")).toBeLessThan(0.4);
  // Formel-/Rollup-Zahlen (`dbui-tnum`) bleiben ebenfalls tabellarisch
  expect(await page.locator(".dbui-root").first().evaluate((root) => { const s = document.createElement("span"); s.className = "dbui-data dbui-tnum"; root.appendChild(s); const v = getComputedStyle(s).fontVariantNumeric; s.remove(); return v; })).toBe("tabular-nums");

  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t, font: "based" })), theme);
      await page.reload();
      await expect(page.locator(".dbui-table .dbui-data", { hasText: "Nov 18, 2026" }).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(5, 815);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-font-based-punctuation-${theme}.png` });
    }
  }
});
