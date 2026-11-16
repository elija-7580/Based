import { expect, test, type Page } from "@playwright/test";

// Elija 16.11.: ordentliche Tab- und Pfeilsteuerung in Tabellen und Datenbanken, Zellbereiche und Blockauswahl mit
// der Maus von überall (wie Notion); ⌫ außerhalb eines Textfelds springt nicht mehr zur vorigen Seite (WebKit).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newPage(page: Page): Promise<string> {
  await ready(page);
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "Keys" });
  });
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  return id;
}

const editor = (page: Page) => page.getByTestId("block-editor");

/** Zwischenablage-Ereignis auf dem Dokument auslösen (wie ⌘C/⌘V) und den Inhalt zurückgeben. */
async function clipboard(page: Page, type: "copy" | "paste" | "cut", text = ""): Promise<string> {
  return page.evaluate(([t, s]) => {
    const dt = new DataTransfer();
    if (s) dt.setData("text/plain", s);
    document.dispatchEvent(new ClipboardEvent(t, { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData("text/plain");
  }, [type, text] as const);
}

test("Einfache Tabelle: Tab, ⇧Tab, Pfeile, Enter, Tab am Ende legt eine Zeile an", async ({ page }) => {
  await newPage(page);
  await editor(page).getByTestId("block-editor-tail").click();
  await page.keyboard.type("/simple table");
  await page.keyboard.press("Enter");
  const table = editor(page).locator(".bx2-table");
  const cell = (i: number, j: number) => editor(page).getByRole("textbox", { name: `Row ${i}, column ${j}` });
  const cols = await table.locator("tr").first().locator("td, th").count();
  const rows = await table.locator("tr").count();
  await cell(1, 1).click();
  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await expect(cell(1, 2)).toBeFocused();
  await page.keyboard.type("b");
  await page.keyboard.press("Shift+Tab");
  await expect(cell(1, 1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell(2, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cell(1, 1)).toBeFocused();
  // → am Textende in die Nachbarzelle
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await expect(cell(1, 2)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cell(2, 2)).toBeFocused();
  await expect(cell(1, 1)).toHaveText("a");
  await expect(cell(1, 2)).toHaveText("b");
  // Letzte Zelle + Tab → neue Zeile, Schreibmarke in deren erster Zelle
  await cell(rows, cols).click();
  await page.keyboard.press("Tab");
  await expect(table.locator("tr")).toHaveCount(rows + 1);
  await expect(cell(rows + 1, 1)).toBeFocused();
  // Escape wählt den Tabellenblock
  await page.keyboard.press("Escape");
  await expect(editor(page).locator('.bx2-block[data-type="table"][data-selected]')).toHaveCount(1);
});

test("Datenbank: Tab im Zellen-Editor, ⇧-Pfeile wählen Bereich, Kopieren, Einfügen, Leeren, Ziehen", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const db = page.locator(".shell-database.full");
  const grid = db.getByRole("grid");
  const title = (r: number) => db.locator(".dbui-vrow[data-row-id] .dbui-cell.title").nth(r);
  await expect(title(2)).toBeVisible();

  // Titel eintippen: Enter übernimmt und geht eine Zeile tiefer, Tab eine Zelle weiter
  for (const [r, t] of [[0, "A"], [1, "B"], [2, "C"]] as const) {
    await title(r).click();
    await expect(page.locator(".dbui-cell-editor input")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(t);
    await page.keyboard.press(r === 2 ? "Tab" : "Enter");
  }
  await expect(grid).toBeFocused();
  await expect(db.locator(".dbui-vrow[data-row-id]").nth(2).locator(".dbui-cell.active")).not.toHaveClass(/title/);
  await expect(title(2)).toContainText("C");

  // ⇧↑ ⇧↑ von der Titelzelle der dritten Zeile → drei Zellen
  await page.keyboard.press("Shift+Tab");
  await expect(title(2)).toHaveClass(/active/);
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(db.locator(".dbui-cell.in-range")).toHaveCount(3);
  expect(await clipboard(page, "copy")).toBe("A\nB\nC");

  // Einfügen eines Werts füllt den ganzen Bereich; Esc hebt den Bereich auf
  await clipboard(page, "paste", "X");
  await expect(title(0)).toContainText("X");
  await expect(title(2)).toContainText("X");
  // Ein Undo-Schritt für alles
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(title(0)).toContainText("A");
  await expect(title(2)).toContainText("C");
  await page.keyboard.press("Escape");
  await expect(db.locator(".dbui-cell.in-range")).toHaveCount(0);

  // Mit der Maus über zwei Zeilen ziehen → Bereich, kein Editor; ⌫ leert ihn, ohne die Seite zu verlassen
  const url = page.url();
  const a = (await title(0).boundingBox())!, b = (await title(1).boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(db.locator(".dbui-cell.in-range")).toHaveCount(2);
  await expect(page.locator(".dbui-cell-editor")).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(title(0)).not.toContainText("A");
  await expect(title(1)).not.toContainText("B");
  await expect(title(2)).toContainText("C");
  expect(page.url()).toBe(url);
});

test("Blockauswahl: Rechteck aus dem Seitenrand außerhalb der Textspalte, ⇧-Klick erweitert", async ({ page }) => {
  await newPage(page);
  await editor(page).getByTestId("block-editor-tail").click();
  for (const t of ["one", "two", "three", "four"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Backspace");
  const fields = editor(page).locator("[data-editable-id]");
  const selected = () => editor(page).locator(".bx2-block[data-selected]").evaluateAll((els) => els.map((e) => e.querySelector("[data-editable-id]")?.textContent));
  const ed = (await editor(page).boundingBox())!;
  const two = (await fields.nth(1).boundingBox())!;
  const three = (await fields.nth(2).boundingBox())!;
  // links neben dem Editor (im Seitenrand) beginnen und nach unten ziehen – nur die Höhe zählt
  const x = ed.x - 40;
  expect(x).toBeGreaterThan(0);
  await page.mouse.move(x, two.y + 2);
  await page.mouse.down();
  await page.mouse.move(x + 5, three.y + three.height - 2, { steps: 6 });
  await page.mouse.up();
  expect(await selected()).toEqual(["two", "three"]);
  // ⇧-Klick auf „four“ erweitert
  await fields.nth(3).click({ modifiers: ["Shift"] });
  expect(await selected()).toEqual(["two", "three", "four"]);
  // ⌘-Klick nimmt „three“ wieder heraus
  await fields.nth(2).click({ modifiers: ["ControlOrMeta"] });
  expect(await selected()).toEqual(["two", "four"]);
});

test("⌫ ohne Textfeld im Fokus geht nicht zur vorigen Seite zurück", async ({ page }) => {
  await newPage(page);
  const prevented = await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const e = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    const inField = document.createElement("input");
    document.body.append(inField);
    const f = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    inField.dispatchEvent(f);
    inField.remove();
    return [e.defaultPrevented, f.defaultPrevented];
  });
  expect(prevented).toEqual([true, false]);
});
