import { expect, test } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-375: Datenbank-Tabellen wie Notion – leerer Titel ohne „Untitled“ (Zeilen und Inline-Titel), Zelleneditor als
// BasedField, keine Markierung (Rahmen/Blau) um die Inline-Datenbank, während man in ihr arbeitet.

test("Inline-Tabelle: leere Titel bleiben leer, Zelleneditor ist ein BasedField, kein Rahmen um den Block", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  // Zeilen ohne Titel: kein „Untitled“ in der Tabelle
  await expect(db.locator(".dbui-cell.title").first()).toBeVisible();
  await expect(db.locator(".dbui-cell.title", { hasText: "Untitled" })).toHaveCount(0);
  // Titel der Datenbank leer: Platzhalter unsichtbar, solange die Maus nicht darüber ist
  await page.mouse.move(5, 815);
  const title = db.getByLabel("Database title");
  const placeholder = () => title.evaluate((el) => getComputedStyle(el, "::placeholder").color);
  await expect.poll(placeholder).toBe("rgba(0, 0, 0, 0)");
  await db.hover();
  await expect.poll(placeholder).not.toBe("rgba(0, 0, 0, 0)");
  // Zelleneditor: BasedField (Astryx-Feld mit Label für Screenreader), Eingabe übernimmt mit Enter
  await db.locator(".dbui-cell.title").first().click();
  const field = page.locator(".dbui-cell-editor").getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await expect(page.locator(".dbui-cell-editor input.dbui-input")).toHaveCount(0);
  await page.keyboard.type("Hello");
  // Während der Bearbeitung kein Rahmen und keine Tönung um den Datenbank-Block
  // (Block-Editor: weder die Blockauswahl am Block noch ein Rahmen am Einbettungs-Kasten)
  const block = page.locator('.bx2-block[data-type="databaseInline"]').first();
  await expect(block).not.toHaveAttribute("data-selected", "");
  const after = await block.locator(".bx2-database").first().evaluate((el) => { const s = getComputedStyle(el, "::after"); const o = getComputedStyle(el); return [s.boxShadow, s.backgroundColor, o.boxShadow, o.backgroundColor]; });
  expect(after[0]).toBe("none");
  expect(after[1]).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(after[2]).toBe("none");
  expect(after[3]).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await page.keyboard.press("Enter");
  await expect(db.locator(".dbui-cell.title").first()).toHaveText(/Hello/);
});

// Element-System (docs/design/elements.md, Abschnitt 3): beim Tippen in einer Textzelle ist genau ein Rahmen zu sehen –
// der Editor liegt deckungsgleich auf der Zelle, das Feld darin hat weder Fläche noch Rahmen noch Kontur.
test("Textzelle bearbeiten zeigt genau einen Rahmen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  const cell = db.locator(".dbui-cell").first();
  await cell.dblclick();
  const editor = page.locator(".dbui-cell-editor");
  await expect(editor).toBeVisible();
  const input = editor.locator("input");
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("outline-style", "none");
  const field = editor.locator(".astryx-text-input");
  await expect(field).toHaveCSS("box-shadow", "none");
  await expect(field).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await editor.evaluate((e) => getComputedStyle(e).boxShadow)).toContain("inset");
  const [c, e] = [await cell.boundingBox(), await editor.boundingBox()];
  expect(Math.abs(e!.y - c!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(e!.height - c!.height)).toBeLessThanOrEqual(1);
});

// BSD-536: Wer in einer Zelle sofort lostippt, verliert keine Zeichen, während der Editor öffnet. Das erste Zeichen
// öffnet den Editor; was eintrifft, bevor das Feld den Fokus hat, landet trotzdem im Feld (10 Wiederholungen, ohne
// Verzögerung zwischen den Tasten).
test("Lostippen in einer Zelle verliert keine Zeichen, während der Editor öffnet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  const titles = db.locator(".dbui-cell.title");
  await expect(titles.nth(1)).toBeVisible();
  const editor = page.locator(".dbui-cell-editor");
  for (let i = 0; i < 10; i++) {
    const text = `Clawther.com - Instructions ${i}`;
    // Erste Zeile öffnen, mit Enter übernehmen: die aktive Zelle springt eine Zeile tiefer, der Editor ist zu.
    await titles.first().click();
    await expect(editor.locator("input")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    await page.keyboard.type(text);
    await expect(editor.locator("input")).toHaveValue(text);
    await page.keyboard.press("Enter");
    // Zellentext ohne den „Open“-Knopf, der in der Titelzelle mitsteht
    await expect(titles.nth(1)).toHaveText(new RegExp(`^${text}(Open)?$`));
  }
});

// BSD-621 (Elija 20.11.): (1) Eine Filterbedingung bleibt eine Zeile – der Mülleimer steht rechts neben dem Wert, auch
// in 900 × 600. (2) Datumsauswahl ohne Systemfeld: Datum als Based-Feld (kein <input type=date>, kein System-Blau);
// solange es den Fokus zeigt, hat die Zelle darunter keinen Rahmen – ein Rahmen zur Zeit.
test("Filterzeile ohne Umbruch, Datumsauswahl mit einem Fokusrahmen und Based-Feld", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // Vorlage „Tasks“ (Name, Status, Due, Priority) – Ansicht „All tasks“ ist die Tabelle
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "addStarterTemplate", template: "tasks" }));
  await page.goto(`/#page-${id}`);
  const db = page.locator(".shell-database.full");
  await db.getByText("All tasks", { exact: true }).click();
  await expect(db.getByRole("columnheader", { name: /Due/ }).first()).toBeVisible();

  for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(size);
    await db.getByRole("button", { name: "Filter" }).first().click();
    await page.getByText("Add filter rule").click();
    const row = page.getByTestId("filter-condition").first();
    await expect(row).toBeVisible();
    const value = (await row.getByRole("textbox", { name: "Value" }).boundingBox())!;
    const bin = (await row.getByRole("button", { name: "Remove filter" }).boundingBox())!;
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(Math.abs(mid(bin) - mid(value)), `${size.width}: Mülleimer in der Zeile`).toBeLessThan(4);
    expect(bin.x, `${size.width}: rechts neben dem Wert`).toBeGreaterThan(value.x + value.width - 1);
    await row.getByRole("button", { name: "Remove filter" }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 820 });

  // Datumszelle „Due“ der ersten Zeile bearbeiten
  const header = db.getByRole("columnheader", { name: /^Due/ }).first();
  const col = await header.evaluate((h) => [...h.parentElement!.children].indexOf(h));
  const cell = db.locator(".dbui-vrow[data-row-id]").first().locator(".dbui-cell").nth(col - 1);
  await cell.dblclick();
  const editor = page.locator(".dbui-date-editor");
  await expect(editor).toBeVisible();
  expect(await editor.locator("input[type=date], input[type=datetime-local], input[type=time]").count()).toBe(0);
  const day = editor.getByRole("textbox", { name: "Due start" });
  await day.focus();
  await page.keyboard.press("End");
  await expect(day).toBeFocused();
  // ein Rahmen zur Zeit: die Zelle nimmt ihren zurück, solange das Feld den Fokus zeigt
  const active = db.locator(".dbui-cell.active");
  await expect(active).toHaveCount(1);
  expect(await day.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  expect(await active.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  await day.fill("2026-11-24");
  await page.keyboard.press("Tab");
  await expect(cell).toContainText(/Nov(ember)? 24, 2026/);
});
