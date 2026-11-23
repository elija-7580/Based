import { expect, test, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-204: Kürzel ⌘N (Palette „New…“), ⌥⌘N, ⌘P, ⇧⌘L, ⌘1–9 – im Test kommen sie an (im Browser-Tab fängt der Browser
// einige ab, in der App nicht).

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("⌘N öffnet „New…“: tippen filtert, Enter legt eine Datenbank an; ⌥⌘N neue Seite", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  // Seite, AI-Chat, Meeting, Datenbank, Import, Board (BSD-264) und die vier Startvorlagen (BSD-436)
  await expect(palette.getByRole("option")).toHaveCount(10);
  await page.keyboard.type("datab");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.locator(".shell-database.full")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expectEditable(page);
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("⌘N und Ziffer: 1 legt eine Seite an, 3 Meeting notes, 4 eine Datenbank; beim Tippen filtern Ziffern (BSD-256)", async ({ page }) => {
  await ready(page);
  const palette = page.getByTestId("new-palette");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(palette.getByRole("option").nth(2)).toContainText("meeting notes");
  await expect(palette.locator(".qf-digit")).toHaveText(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  await page.keyboard.press("1");
  await expect(palette).toBeHidden();
  await expectEditable(page);
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("3");
  await expect(palette).toBeHidden();
  await expect(page.getByLabel("Page title")).toHaveValue(/^Meeting/);
  await expect(page.getByTestId("meeting-block")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("4");
  await expect(page.locator(".shell-database.full")).toBeVisible();

  // Mit Text im Feld ist eine Ziffer nur ein Zeichen
  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.type("x1");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox", { name: "New" })).toHaveValue("x1");
  await page.keyboard.press("Escape");
});

test("⌘P sucht, ⇧⌘L schaltet hell/dunkel, ⌘1/⌘9 wählen Tabs", async ({ page }) => {
  await ready(page);
  await page.locator(".panel").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
  await page.keyboard.press("Escape");

  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(before);

  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.press("ControlOrMeta+t");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+9");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
});

test("Kopfzeile: „Edited …“ und •••-Menü mit allen Seitenaktionen", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.getByLabel("Page title")).toBeFocused(); // BSD-659: erst die neue Seite, sonst trifft der Klick die vorige
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("Hello");
  // WebKit-Testprofile haben kein OPFS („Not saved“); dort zeigt nur das Menü die Zeit.
  await expect(page.getByTestId("page-edited")).toHaveText(/Edited just now|Not saved/);

  await page.getByRole("button", { name: "Page menu" }).click();
  const menu = page.getByRole("menu", { name: "Page menu" });
  for (const name of ["Copy link", "Duplicate", "Move to…", "Add to Favorites", "Export…", "Version history", "Move to Trash"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }
  await expect(menu.getByTestId("page-menu-edited")).toHaveText("Edited just now");
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeFocused();
  // Copy link → Open in new window → Find in page → Duplicate
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Find in page/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("treeitem", { name: "Untitled", exact: true })).toHaveCount(2);
});

// BSD-624: Im kleinsten Fenster (900 × 600) bleibt das •••-Menü 8 px über dem Fensterrand und rollt; die letzte Zeile
// („Edited …“) und „Move to Trash“ sind erreichbar, die Zeilen behalten ihre Höhe.
test("•••-Menü bei 900 × 600: bleibt im Fenster und rollt", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expectEditable(page);
  await page.getByRole("button", { name: "Page menu" }).click();
  const menu = page.getByRole("menu", { name: "Page menu" });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(600 - 8);
  const rows = await menu.getByRole("menuitem").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(Math.min(...rows), "Zeilen werden nicht gestaucht").toBeGreaterThanOrEqual(28);
  const edited = menu.getByTestId("page-menu-edited");
  await edited.scrollIntoViewIfNeeded();
  await expect(edited).toBeInViewport();
  await expect(menu.getByRole("menuitem", { name: "Move to Trash" })).toBeInViewport();
});

// BSD-482: Neue Seite → Schreibmarke im Titel (⌥⌘N, ⌘N → New page, „+“ neben Private), Enter springt in den Text.
// Eine vorhandene Seite öffnen stiehlt keinen Fokus.
test("Neue Seite: Schreibmarke steht im Titel, Enter geht in den Text; Öffnen einer Seite fokussiert nichts", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const title = page.getByLabel("Page title");

  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(title).toBeFocused();
  await page.keyboard.type("Typed right away");
  await expect(page.getByRole("treeitem", { name: "Typed right away", exact: true })).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Body text");
  await expect(page.getByTestId("block-editor")).toContainText("Body text");
  await expect(title).toHaveValue("Typed right away");

  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("new-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("");
  await expect(title).toBeFocused();
  await page.keyboard.type("From the palette");
  await expect(page.getByRole("treeitem", { name: "From the palette", exact: true })).toHaveCount(1);
  if (browserName === "chromium") {
    // Foto hell, dann ⇧⌘L → dunkel (der Fokus bleibt im Titel), wieder zurück
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "../../docs/design/screens/new-page-title-focus-light.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(title).toBeFocused();
    await page.waitForTimeout(400); // Farbwechsel abwarten
    await page.screenshot({ path: "../../docs/design/screens/new-page-title-focus-dark.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
  }
  await page.getByText("Private", { exact: true }).hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  await expect(title).toHaveValue("");
  await expect(title).toBeFocused();
  await page.keyboard.type("From the sidebar");
  await expect(page.getByRole("treeitem", { name: "From the sidebar", exact: true })).toHaveCount(1);

  // vorhandene Seite öffnen: kein Fokus im Titel
  await page.getByRole("treeitem", { name: "Typed right away", exact: true }).click();
  await expect(title).toHaveValue("Typed right away");
  await expect(title).not.toBeFocused();
});

// BSD-617: Neue Datenbank (⌘N → New database) → Schreibmarke im Titel, „Untitled database“ ist markiert: Tippen benennt
// die Datenbank. Vorher blieb der Fokus auf der Seite und das Getippte ging verloren.
test("Neue Datenbank: Titel hat den Fokus, Tippen ersetzt „Untitled database“", async ({ page }) => {
  await ready(page);
  const title = page.getByLabel("Page title");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("new-palette")).toBeVisible();
  await page.keyboard.type("datab");
  await page.keyboard.press("Enter");
  await expect(page.locator(".shell-database.full")).toBeVisible();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Untitled database");
  await expect.poll(() => title.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBe("Untitled database".length);
  await page.keyboard.type("Reading list");
  await expect(title).toHaveValue("Reading list");
  await expect(page.getByRole("treeitem", { name: "Reading list", exact: true })).toHaveCount(1);
  // vorhandene Datenbank wieder öffnen: kein Fokus im Titel
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("treeitem", { name: "Reading list", exact: true }).click();
  await expect(title).toHaveValue("Reading list");
  await expect(title).not.toBeFocused();
});

// Der Worker antwortet beim Anlegen künstlich spät (250 ms): So ist das Fenster zwischen „neue Seite“ und dem Fokus im
// Titel (auf dem Mac ~45 ms) in jedem Lauf offen.
const slowCreate = (page: Page) => page.evaluate(`(() => {
  const c = globalThis.__based.client, run = c.command.bind(c);
  c.command = (cmd, ...a) => /^create(Page|Database)$/.test(cmd.op) ? new Promise((ok) => setTimeout(ok, 250)).then(() => run(cmd, ...a)) : run(cmd, ...a);
})()`);

// BSD-644: Der späte Fokus der neuen Seite nahm sich den Fokus auch dann, wenn inzwischen Quick Find offen war – Esc
// ging an den Titel, Quick Find blieb offen (find.spec wackelte). Ein offener Dialog behält jetzt den Fokus.
test("Neue Seite: ⌘K gleich danach – Quick Find behält den Fokus, Esc schließt", async ({ page }) => {
  await ready(page);
  await slowCreate(page);
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  const input = qf.getByRole("combobox", { name: "Search pages" });
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input).toBeFocused();
  await page.keyboard.type("kes");
  await expect(page.getByLabel("Page title")).toHaveValue(""); // die neue Seite ist da
  await page.waitForTimeout(150); // Fenster, in dem der Titel sich früher den Fokus nahm
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("kes");
  await page.keyboard.press("Escape");
  await expect(qf).toHaveCount(0);
});

// BSD-645: Zwischen „neue Seite“ und dem Fokus im Titel vergeht etwas Zeit (Worker legt an, Seite lädt; auf dem Mac
// ~45 ms). Was man darin tippte, ging verloren oder landete im Titel der vorigen Seite. Jetzt kommt alles in den neuen
// Titel, Enter geht in den Text, das Getippte danach auch.
test("Neue Seite: sofort Getipptes geht nicht verloren (⌥⌘N, ⌘N, „+“), Enter und Weitertippen auch", async ({ page }) => {
  await ready(page);
  const title = page.getByLabel("Page title");
  const editor = page.getByTestId("block-editor");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(title).toBeFocused();
  await page.keyboard.type("Old page");
  await expect(page.getByRole("treeitem", { name: "Old page", exact: true })).toHaveCount(1);
  await slowCreate(page);

  // ⌥⌘N aus dem Titel der vorigen Seite: 20 Zeichen ohne Pause, Enter, weiter im Text
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.keyboard.type("Typed in the gap 20");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Body right after");
  await expect(title).toHaveValue("Typed in the gap 20");
  await expect(editor).toContainText("Body right after");
  await expect(page.getByRole("treeitem", { name: "Typed in the gap 20", exact: true })).toHaveCount(1);
  await expect(page.getByRole("treeitem", { name: "Old page", exact: true })).toHaveCount(1);
  await page.keyboard.type(" and more");
  await expect(editor).toContainText("Body right after and more");

  // ⌘N → New page
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("new-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("From the palette now");
  await expect(title).toHaveValue("From the palette now");
  await expect(title).toBeFocused();

  // „+“ in der Seitenleiste, Tippfehler mit ⌫ im Fenster
  await page.getByText("Private", { exact: true }).hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  await page.keyboard.type("Sidebar plusx");
  await page.keyboard.press("Backspace");
  await expect(title).toHaveValue("Sidebar plus");
  await expect(title).toBeFocused();
  await expect(page.getByRole("treeitem", { name: "Sidebar plus", exact: true })).toHaveCount(1);
});

// Ohne künstliche Verzögerung, wie ein Tester: 20 Zeichen gleich nach ⌥⌘N kommen vollständig an (BSD-645).
test("Neue Seite: 20 Zeichen gleich nach ⌥⌘N kommen alle an", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.keyboard.type("Twenty chars at once");
  await expect(page.getByLabel("Page title")).toHaveValue("Twenty chars at once");
});

// BSD-654: Zeichen ohne gewöhnlichen Tastendruck (tote Taste ´+e, Eingabemethode, Emoji-Auswahl) landeten im Fenster
// vor dem Titelfokus im Titel der vorigen Seite; zweimal ⌥⌘N schrieb in die erste neue Seite statt in die angezeigte.
test("Neue Seite: é ohne Tastendruck geht nie in die vorige Seite; zweimal ⌥⌘N – Text in der angezeigten Seite", async ({ page }) => {
  await ready(page);
  const title = page.getByLabel("Page title");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(title).toBeFocused();
  await page.keyboard.type("Page A");
  await expect(page.getByRole("treeitem", { name: "Page A", exact: true })).toHaveCount(1);
  await slowCreate(page);

  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.keyboard.type("Caf");
  await page.keyboard.insertText("é");
  await expect(title).toHaveValue(/^Café?$/);
  await expect(title).toBeFocused();
  await expect(page.getByRole("treeitem", { name: "Page A", exact: true })).toHaveCount(1);
  await expect(page.getByRole("treeitem", { name: /^Page A./ })).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.waitForTimeout(100);
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await page.keyboard.type("Second");
  await expect(title).toHaveValue("Second");
  await expect(title).toBeFocused();
  await expect(page.getByRole("treeitem", { name: "Second", exact: true })).toHaveCount(1);
  // die erste der beiden neuen Seiten bleibt leer, kein Text darin
  await expect(page.getByRole("treeitem", { name: /^Second./ })).toHaveCount(0);
});
