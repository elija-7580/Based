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
