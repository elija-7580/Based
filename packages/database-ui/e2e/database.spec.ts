import { expect, test, type Page } from "@playwright/test";

// BSD-155: Datenbank-Ansichten auf der eigenen Testseite – 10.000 Zeilen flüssig in Tabelle und Board
// (begrenzte DOM-Zeilen, keine langen Frames beim Scrollen), Zellen bearbeiten, filtern, sortieren, gruppieren.

interface ScrollStats { frames: number[]; maxFrame: number; long: number; p95: number; maxRows: number; rowsAtEnd: number }

/** Scrollt `selector` in `steps` Frames von oben nach unten und misst die Frame-Abstände (requestAnimationFrame). */
async function scrollAndMeasure(page: Page, selector: string, steps: number, pxPerFrame?: number): Promise<ScrollStats> {
  return page.evaluate(async ({ selector, steps, pxPerFrame }) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
    const max = el.scrollHeight - el.clientHeight;
    const frames: number[] = [];
    let maxRows = 0;
    let last = await raf();
    for (let i = 1; i <= steps; i++) {
      el.scrollTop = pxPerFrame ? Math.min(max, i * pxPerFrame) : (max * i) / steps;
      const now = await raf();
      frames.push(now - last);
      last = now;
      maxRows = Math.max(maxRows, document.querySelectorAll("[data-row-id]").length);
    }
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames, maxFrame: sorted[sorted.length - 1]!, long: frames.filter((f) => f > 50).length, p95: sorted[Math.floor(sorted.length * 0.95)]!,
      maxRows, rowsAtEnd: document.querySelectorAll("[data-row-id]").length,
    };
  }, { selector, steps, pxPerFrame });
}

/** Chromium malt mit GPU-Pfad flüssig; Headless-WebKit (Software-Rendering) bekommt mehr Spielraum. */
function expectSmooth(s: ScrollStats, browser: string, jumps = false) {
  if (browser === "webkit") {
    // Sprünge (ganze Bildschirmseiten pro Frame) sind ein Stresstest; sanftes Scrollen ist der Maßstab.
    expect(s.long).toBeLessThanOrEqual(Math.ceil(s.frames.length * (jumps ? 0.3 : 0.15)));
    expect(s.p95).toBeLessThan(jumps ? 120 : 80);
  } else {
    expect(s.long).toBeLessThanOrEqual(jumps ? 6 : 3);
    if (!jumps) expect(s.maxFrame).toBeLessThan(150);
  }
}

const fmt = (s: ScrollStats) => `max ${s.maxFrame.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, >50 ms: ${s.long}/${s.frames.length}, DOM rows ≤ ${s.maxRows}`;

test.describe("10.000 Zeilen", () => {
  test("Tabelle: virtualisiert, flüssiges Scrollen bis zur letzten Zeile", async ({ page }, info) => {
    await page.goto("/?view=v-table");
    await expect(page.getByRole("grid", { name: "All tasks" })).toBeVisible();
    await expect(page.getByLabel("Pages in view")).toHaveText("10,000");
    expect(await page.locator("[data-row-id]").count()).toBeLessThan(80);

    const smooth = await scrollAndMeasure(page, "[data-testid=table-scroll]", 180, 60);
    const jumps = await scrollAndMeasure(page, "[data-testid=table-scroll]", 60);
    info.annotations.push({ type: "Tabelle sanft (60 px/Frame)", description: fmt(smooth) }, { type: "Tabelle Sprünge", description: fmt(jumps) });
    console.log(`[${info.project.name}] Tabelle sanft: ${fmt(smooth)} | Sprünge: ${fmt(jumps)}`);
    expect(smooth.maxRows).toBeLessThan(80);
    expect(jumps.maxRows).toBeLessThan(80);
    expectSmooth(smooth, info.project.name);
    expectSmooth(jumps, info.project.name, true);
    await expect(page.getByText("BSD-10000")).toBeVisible();
  });

  test("Board: Spalten virtualisiert, flüssiges Scrollen", async ({ page }, info) => {
    await page.goto("/?view=v-board");
    const col = page.getByRole("region", { name: "Backlog", exact: true });
    await expect(col).toBeVisible();
    await expect(col.locator(".dbui-count")).toHaveText("2000");
    expect(await page.locator("[data-row-id]").count()).toBeLessThan(120);
    const sel = "section[aria-label='Backlog'] .dbui-board-scroll";
    const smooth = await scrollAndMeasure(page, sel, 180, 60);
    const jumps = await scrollAndMeasure(page, sel, 60);
    info.annotations.push({ type: "Board sanft", description: fmt(smooth) }, { type: "Board Sprünge", description: fmt(jumps) });
    console.log(`[${info.project.name}] Board sanft: ${fmt(smooth)} | Sprünge: ${fmt(jumps)}`);
    expect(smooth.maxRows).toBeLessThan(120);
    expectSmooth(smooth, info.project.name);
    expectSmooth(jumps, info.project.name, true);
    // Gemessene Kartenhöhen ändern die Gesamthöhe: bis ans echte Ende scrollen.
    for (let i = 0; i < 5; i++) await page.locator(sel).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(col.getByText("BSD-9996")).toBeVisible();
  });

  test("Filtern, Sortieren und Gruppieren auf 10.000 Zeilen", async ({ page }) => {
    await page.goto("/?view=v-table");
    const count = page.getByLabel("Pages in view");
    await expect(count).toHaveText("10,000");

    // Filter: Status is Done
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("button", { name: "Add filter rule" }).click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.getByLabel("Property").selectOption({ label: "Status" });
    await dialog.getByRole("group", { name: "Options" }).getByRole("button", { name: "Done" }).click();
    await expect(count).toHaveText("2,000");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("filter-chip")).toHaveText("Status is Done");

    // Sortieren: Estimate absteigend
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await page.getByRole("dialog", { name: "Sorts" }).getByLabel("Add sort").selectOption({ label: "Estimate" });
    await page.getByRole("dialog", { name: "Sorts" }).getByLabel("Direction").selectOption("desc");
    await page.keyboard.press("Escape");
    const firstEstimate = page.locator(".dbui-vrow[data-row-id]").first().locator("[data-cell$=':5']");
    await expect(firstEstimate).toHaveText("13");

    // Gruppieren nach Priority
    await page.getByRole("button", { name: "View settings" }).click();
    await page.getByRole("dialog", { name: "View settings" }).getByLabel("Group by").selectOption({ label: "Priority" });
    await page.keyboard.press("Escape");
    const heads = page.locator(".dbui-group-head");
    await expect(heads.first()).toContainText("No Priority");
    // Gruppen einklappen: dann rückt „High“ in den sichtbaren (virtualisierten) Bereich
    await page.getByRole("button", { name: "Collapse Low" }).click();
    await page.getByRole("button", { name: "Collapse Medium" }).click();
    await expect(page.getByRole("button", { name: "Expand Low" })).toBeVisible();
    await expect(page.locator(".dbui-group-head", { hasText: "High" }).locator(".dbui-count")).toHaveText(/^\d+$/);
  });
});

test.describe("Bearbeiten (kleine Datenbank)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?rows=40&view=v-table");
    await expect(page.getByRole("grid", { name: "All tasks" })).toBeVisible();
  });

  const value = (page: Page, row: string, prop: string) => page.evaluate(([r, p]) => {
    const b = window.__store.blocks.get(r!);
    return p === "title" ? b?.text : JSON.stringify(b?.values?.[p!] ?? null);
  }, [row, prop]);
  const cell = (page: Page, row: string, col: number) => page.locator(`[data-cell="${row}:${col}"]`);
  /** Spalten werden horizontal virtualisiert: Kopf ins Bild scrollen, damit die Zellen gerendert werden. */
  const showCol = (page: Page, col: number) => page.locator(".dbui-th").nth(col).scrollIntoViewIfNeeded();

  test("Titel, Zahl, Auswahl, Checkbox, Datum bearbeiten", async ({ page }) => {
    // Titel: klicken, tippen, Enter
    await cell(page, "row-0", 0).click();
    const input = page.getByRole("dialog", { name: "Edit Name" }).getByRole("textbox");
    await input.fill("Renamed task");
    await input.press("Enter");
    expect(await value(page, "row-0", "title")).toBe("Renamed task");
    await expect(cell(page, "row-0", 0)).toContainText("Renamed task");

    // Zahl: ungültig → Hinweis, gültig → gespeichert
    await cell(page, "row-0", 5).click();
    const num = page.getByRole("dialog", { name: "Edit Estimate" }).getByRole("textbox");
    await num.fill("zwölf");
    await num.press("Enter");
    await expect(page.getByText("Enter a number")).toBeVisible();
    await num.fill("42");
    await num.press("Enter");
    expect(await value(page, "row-0", "est")).toBe(JSON.stringify({ number: { _0: 42 } }));
    await expect(cell(page, "row-0", 5)).toHaveText("42");
    // Formel rechnet mit (Double estimate = 84)
    await showCol(page, 12);
    await expect(cell(page, "row-0", 12)).toHaveText("84");

    await showCol(page, 0);
    // Auswahl: Priority auf High, neue Option anlegen
    await cell(page, "row-1", 3).click();
    const sel = page.getByRole("dialog", { name: "Edit Priority" });
    await sel.getByRole("option", { name: "High" }).click();
    expect(await value(page, "row-1", "prio")).toBe(JSON.stringify({ select: { _0: "p-high" } }));
    await cell(page, "row-2", 3).click();
    await page.getByRole("dialog", { name: "Edit Priority" }).getByLabel("Search options").fill("Urgent");
    await page.getByRole("dialog", { name: "Edit Priority" }).getByLabel("Search options").press("Enter");
    await expect(cell(page, "row-2", 3)).toContainText("Urgent");

    // Checkbox direkt umschalten
    await showCol(page, 8);
    const done = cell(page, "row-0", 8).getByRole("checkbox");
    await expect(done).toHaveAttribute("aria-checked", "false");
    await done.click();
    await expect(done).toHaveAttribute("aria-checked", "true");

    // Datum
    await showCol(page, 7);
    await cell(page, "row-3", 7).click();
    await page.getByRole("dialog", { name: "Edit Due" }).getByLabel("Due start").fill("2026-12-24");
    await page.keyboard.press("Escape");
    await expect(cell(page, "row-3", 7)).toHaveText("December 24, 2026");

    // Undo über den Store: das Datum ist wieder das alte
    await page.evaluate(() => window.__store.undo());
    await expect(cell(page, "row-3", 7)).not.toHaveText("December 24, 2026");
  });

  test("Tastatur: Pfeile, Tippen startet die Bearbeitung, Enter springt weiter", async ({ page }) => {
    await cell(page, "row-0", 1).click(); // ID (nur lesen) – wählt die Zelle aus
    await page.keyboard.press("ArrowLeft");
    await expect(cell(page, "row-0", 0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(cell(page, "row-1", 0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.type("X");
    const input = page.getByRole("dialog", { name: "Edit Name" }).getByRole("textbox");
    await expect(input).toHaveValue("X");
    await input.press("Enter");
    expect(await value(page, "row-1", "title")).toBe("X");
    await expect(cell(page, "row-2", 0)).toHaveAttribute("aria-selected", "true");
  });

  test("Neue Zeile, Property anlegen, umbenennen, Typ ändern mit Verlust-Warnung", async ({ page }) => {
    await page.getByRole("button", { name: "New", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit Name" }).getByRole("textbox");
    await editor.fill("Brand new");
    await editor.press("Enter");
    await expect(page.getByLabel("Pages in view")).toHaveText("41");
    expect(await page.evaluate(() => [...window.__store.blocks.values()].some((b) => b.text === "Brand new"))).toBe(true);

    // Property anlegen (Text) und umbenennen
    await page.getByRole("button", { name: "Add property" }).click();
    await page.getByTestId("type-text").click();
    await expect(page.locator(".dbui-th", { hasText: /^Text$/ })).toBeVisible();
    await page.locator(".dbui-th", { hasText: /^Text$/ }).getByRole("button").first().click();
    const name = page.getByRole("dialog", { name: "Property Text" }).getByLabel("Property name");
    await name.fill("Size");
    await name.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.locator(".dbui-th", { hasText: /^Size$/ })).toBeVisible();

    await page.getByTestId("table-scroll").evaluate((el) => { el.scrollTop = 0; });
    // Werte: eine Zahl und ein Wort, dann Typ → Number: 1 Zelle geht verloren → Warnung
    const sizeCol = await page.getByRole("columnheader").evaluateAll((hs) => hs.findIndex((h) => h.textContent === "Size"));
    await showCol(page, sizeCol);
    await cell(page, "row-0", sizeCol).click();
    await page.getByRole("dialog", { name: "Edit Size" }).getByRole("textbox").fill("12");
    await page.keyboard.press("Enter");
    await cell(page, "row-1", sizeCol).click();
    await page.getByRole("dialog", { name: "Edit Size" }).getByRole("textbox").fill("large");
    await page.keyboard.press("Enter");
    await page.locator(".dbui-th", { hasText: /^Size$/ }).getByRole("button").first().click();
    await page.getByTestId("property-type").click();
    await page.getByTestId("type-number").click();
    const confirm = page.getByRole("alertdialog", { name: "Confirm" });
    await expect(confirm).toContainText("1 cell will lose its value");
    await confirm.getByRole("button", { name: "Change type" }).click();
    await page.keyboard.press("Escape");
    await expect(cell(page, "row-0", sizeCol)).toHaveText("12");
    await expect(cell(page, "row-1", sizeCol)).toHaveText("");
  });

  test("Board: Karte per Drag & Drop in andere Spalte", async ({ page }) => {
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const card = page.locator(".dbui-card[data-row-id='row-0']");
    await expect(page.getByRole("region", { name: "Backlog", exact: true }).locator(card)).toBeVisible();
    // Ziel im sichtbaren Bereich (Spalte rechts daneben)
    await card.dragTo(page.getByRole("region", { name: "Ready", exact: true }).locator(".dbui-board-scroll"));
    await expect(page.getByRole("region", { name: "Ready", exact: true }).locator(".dbui-card[data-row-id='row-0']")).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(window.__store.blocks.get("row-0")?.values?.status))).toBe(JSON.stringify({ status: { _0: "s-ready" } }));
    await page.evaluate(() => window.__store.undo());
    await expect(page.getByRole("region", { name: "Backlog", exact: true }).locator(card)).toBeVisible();
  });

  test("Ansichten: Tabs, neue Ansicht, Layout wechseln, Liste/Galerie/Diagramm/Dashboard", async ({ page }) => {
    for (const [tab, testid] of [["List", "list-scroll"], ["Gallery", "gallery-scroll"], ["By status", "chart"], ["Dashboard", "dashboard"]] as const) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.getByTestId(testid)).toBeVisible();
    }
    await expect(page.getByTestId("chart-number")).toBeVisible();
    await expect(page.getByTestId("chart-slice")).toHaveCount(3);
    await page.getByRole("tab", { name: "Calendar", exact: true }).click();
    await expect(page.getByText("is coming soon")).toBeVisible();

    await page.getByRole("button", { name: "Add view" }).click();
    await page.getByTestId("add-view-board").click();
    await expect(page.getByRole("tab", { name: "Board", exact: true }).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "View settings" }).click();
    await page.getByRole("radio", { name: "Table" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByRole("tab", { name: "By status", exact: true }).click();
    await expect(page.getByTestId("chart-bar")).toHaveCount(5);
  });

  test("Relation bearbeiten und Rollup rechnet mit; Seite öffnen", async ({ page }) => {
    const relCol = await page.getByRole("columnheader").evaluateAll((hs) => hs.findIndex((h) => h.textContent === "Project"));
    await showCol(page, relCol + 1);
    await cell(page, "row-1", relCol).click();
    const dlg = page.getByRole("dialog", { name: "Edit Project" });
    await dlg.getByRole("option", { name: "Gamma" }).click();
    await page.keyboard.press("Escape");
    await expect(cell(page, "row-1", relCol)).toContainText("Gamma");
    await expect(cell(page, "row-1", relCol + 1)).toHaveText("3000");
    expect(await page.evaluate(() => JSON.stringify(window.__store.blocks.get("proj-2")?.values?.tasks ?? null))).toContain("row-1");
    await cell(page, "row-1", relCol).getByRole("button", { name: "Gamma" }).click();
    await expect(page.getByTestId("opened")).toHaveText("Opened proj-2");
  });
});
