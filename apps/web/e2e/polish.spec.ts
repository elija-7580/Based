import { expect, test, type Page } from "@playwright/test";

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

test("Slash-Menü: Überfahren färbt die Zeile mit der Auswahl-Fläche, nicht mit dem Blau der Bibliothek", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.locator(".bn-editor[contenteditable='true']").first().click();
  await page.keyboard.type("/");
  const item = page.locator(".bn-suggestion-menu-item").nth(4);
  await item.hover();
  const [bg, selected, ink, color] = await item.evaluate((el) => {
    const probe = document.createElement("i");
    probe.style.cssText = "background: var(--selected); color: var(--ink)";
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
    await expect(status).toHaveAttribute("data-tip", /.+/);
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
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await editor.click();
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
  await page.locator(".bn-block-outer", { hasText: /^Two$/ }).last().evaluate((el) => el.scrollIntoView({ block: "start" }));
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
