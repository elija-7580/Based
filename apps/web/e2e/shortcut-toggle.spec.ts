import { expect, test, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-421: Kurzbefehle, die eine Leiste oder ein Fenster öffnen, schließen es beim zweiten Drücken wieder und geben den
// Fokus zurück – im Editor an dieselbe Schreibmarke: ⌘F (Suchen in der Seite), ⌘K und ⌘P (Quick Find), ⌘N (Neu-Palette),
// ⌘, (Einstellungen → zurück). ⌘J (Chat) und ⌘\ (Seitenleiste) waren schon Umschalter.

async function openTypedPage(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Toggle keys" }));
  await page.goto(`/#page-${id}`);
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("Caret stays here");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // Schreibmarke vor „here“
}

/** Fokus wieder im Editor an derselben Stelle: Tippen landet vor „here“. */
async function expectCaretBack(page: Page, mark: string) {
  await expect(blockEditor(page).locator("[data-editable-id]:focus")).toHaveCount(1);
  await page.keyboard.type(mark);
  await expect(blockEditor(page).locator("[data-editable-id]").first()).toHaveText(`Caret stays ${mark}here`);
  for (let i = 0; i < mark.length; i++) await page.keyboard.press("Backspace");
}

test("⌘F zweimal: Suchleiste zu, Schreibmarke zurück", async ({ page }) => {
  await openTypedPage(page);
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.getByTestId("find-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(bar).toHaveCount(0);
  await expectCaretBack(page, "F");
});

for (const key of ["k", "p"]) test(`⌘${key.toUpperCase()} zweimal: Quick Find zu, Schreibmarke zurück`, async ({ page }) => {
  await openTypedPage(page);
  await page.keyboard.press(`ControlOrMeta+${key}`);
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  await expect(qf).toBeVisible();
  await expect(qf.getByRole("combobox").or(qf.getByLabel("Search pages")).first()).toBeFocused();
  await page.keyboard.press(`ControlOrMeta+${key}`);
  await expect(qf).toHaveCount(0);
  await expectCaretBack(page, key.toUpperCase());
});

test("⌘N zweimal: Neu-Palette zu, Schreibmarke zurück", async ({ page }) => {
  await openTypedPage(page);
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(palette).toHaveCount(0);
  await expectCaretBack(page, "N");
});

test("⌘, zweimal: Einstellungen auf und zurück zur Seite", async ({ page }) => {
  await openTypedPage(page);
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page).toHaveURL(/#appearance|#prefs/);
  await expect(page.getByLabel("Page title")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.getByLabel("Page title")).toHaveValue("Toggle keys");
});

// BSD-438: Wer aus Quick Find eine Seite öffnet, behält den Fokus in der neuen Seite – er springt nicht in die Seitenleiste
// zurück (Rückfall durch BSD-421: der Hook gab den Fokus immer zurück und überstimmte BSD-304).
test("Quick Find: Seite öffnen lässt den Fokus nicht in die Seitenleiste springen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Zebra target" }));
  const hide = page.getByTestId("sidebar-hide");
  await hide.focus();
  await expect(hide).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  await expect(qf).toBeVisible();
  await page.keyboard.type("Zebra target");
  await expect(qf.locator('[role="option"][aria-selected="true"]')).toContainText("Zebra target");
  await page.keyboard.press("Enter");
  await expect(qf).toHaveCount(0);
  await expect(page).toHaveURL(/#page-/);
  await expect(page.getByLabel("Page title")).toHaveValue("Zebra target");
  await page.waitForTimeout(150); // ein Mikrotask/Frame später käme die falsche Rückgabe
  await expect(hide).not.toBeFocused();
});

test("⌘N: „New page“ lässt den Fokus nicht in die Seitenleiste springen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const hide = page.getByTestId("sidebar-hide");
  await hide.focus();
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option").first()).toHaveAccessibleName(/^New page/);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/#page-/);
  await page.waitForTimeout(150);
  await expect(hide).not.toBeFocused();
});

// BSD-439: Befehle fallen beim Tippen sofort weg – die Auswahl springt auf den ersten Eintrag, Enter öffnet ihn.
test("Quick Find: nach Weitertippen ist der erste Eintrag ausgewählt, Enter öffnet ihn", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+k");
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  await expect(qf).toBeVisible();
  await page.keyboard.type("set");
  await expect(qf.getByTestId("qf-command").first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Sofort Enter – bevor die Suche antwortet (die setzte die Auswahl früher erst zurück)
  await page.keyboard.type("tings");
  await page.keyboard.press("Enter");
  await expect(qf).toHaveCount(0);
  await expect(page).toHaveURL(/#prefs|#appearance/);
});
