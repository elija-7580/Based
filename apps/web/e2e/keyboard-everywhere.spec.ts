import { expect, test, type Page } from "@playwright/test";

// Elija 17.11.: die ganze App per Tastatur – Pfeiltasten zwischen Bedienelementen, Seitenleiste als Liste, Übersicht
// aller Kürzel (⇧⌘/), Kurzanzeige beim Halten von ⌘ passend zur Stelle, Blockmenü per ⌘/, Befehle aus dem Mac-Menü.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
});

async function ready(page: Page, hash = "") {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

/** Beschriftung des fokussierten Elements. */
const focused = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim();
});

async function newPage(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (t) => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: t });
  }, title);
  return id;
}

/** ⌘ (Strg) lange halten, bis die Kurzanzeige erscheint; liefert ihre Überschriften. */
async function holdMod(page: Page): Promise<string[]> {
  const mod = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent) ? "Meta" : "Control"));
  await page.keyboard.down(mod);
  const hud = page.getByTestId("shortcut-hud");
  await expect(hud).toBeVisible();
  const titles = await hud.locator(".keys-group-title").allTextContents();
  await page.keyboard.up(mod);
  await expect(hud).toHaveCount(0);
  return titles;
}

test("Seitenleiste: ⇧⌘E hinein, Pfeile durch alles, ←/→ im Baum, Enter öffnet, Esc zurück in die Seite", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  const parent = await newPage(page, "Alpha");
  await page.evaluate(async (p) => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    await b.client.command({ op: "createPage", title: "Alpha child", parent: p });
  }, parent);
  await page.goto(`/#page-${parent}`);
  await expect(page.getByRole("treeitem", { name: "Alpha", exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+E");
  expect(await focused(page)).toBe("Alpha");
  // → klappt auf, noch einmal → geht zur ersten Unterseite; ← zurück zur Elternseite, ← klappt zu
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Alpha child" })).toBeVisible();
  expect(await focused(page)).toBe("Alpha");
  await page.keyboard.press("ArrowRight");
  expect(await focused(page)).toBe("Alpha child");
  await page.keyboard.press("ArrowLeft");
  expect(await focused(page)).toBe("Alpha");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("treeitem", { name: "Alpha child" })).toHaveCount(0);

  // ↑ läuft durch alle Zeilen (auch die, die Tab überspringt) bis zu Search; ↓ wieder zurück
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowUp");
    const now = await focused(page);
    if (seen.at(-1) === now) break;
    seen.push(now);
  }
  expect(seen).toContain("Private");
  expect(seen).toContain("Teamspaces");
  expect(seen.some((x) => x.startsWith("Search"))).toBe(true);
  expect(seen.some((x) => x.startsWith("Home"))).toBe(true);

  // unten: Fußzeile mit ←/→, von dort ↑ auf die letzte Seite
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".sidebar-footer"))).toBe(true);
  await page.keyboard.press("ArrowUp");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");

  // Enter öffnet die Seite, Esc geht in die Seite zurück
  await page.getByRole("treeitem", { name: /Welcome/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#page-/);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".panel"))).toBe(true);
});

test("⇧F10 öffnet das Menü am fokussierten Eintrag; nach Esc holt die nächste Pfeiltaste den Fokus zurück", async ({ page }) => {
  await ready(page);
  await page.getByRole("treeitem", { name: /Welcome/ }).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  expect(await page.evaluate(() => !!document.activeElement?.closest("nav.sidebar"))).toBe(true);
});

test("Einstellungen: Pfeile in der Liste links, → in den Inhalt, ← zurück", async ({ page }) => {
  await ready(page, "#settings");
  await page.getByRole("button", { name: "Appearance", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("Pages");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Pages" })).toBeVisible();
  const navRight = await page.evaluate(() => document.activeElement!.getBoundingClientRect().right);
  await page.keyboard.press("ArrowRight");
  const inContent = await page.evaluate(() => document.activeElement!.getBoundingClientRect().left);
  expect(inContent).toBeGreaterThan(navRight);
  // im Inhalt geht es mit ↓ Zeile für Zeile weiter (Schalter, Knöpfe)
  const top = await page.evaluate(() => document.activeElement!.getBoundingClientRect().top);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement!.getBoundingClientRect().top)).toBeGreaterThan(top);
});

test("Übersicht aller Kürzel: ⇧⌘/ öffnet, Suche filtert, Esc schließt; auch über ⌘K", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Shift+/");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("group", { name: "Database table" })).toBeVisible();
  await expect(sheet.getByPlaceholder("Search shortcuts")).toBeFocused();
  // Alle Abschnitte liegen in der Liste (rollen senkrecht) – nichts läuft seitlich aus dem Dialog.
  const fit = await sheet.locator(".keys-sheet").evaluate((list) => {
    const r = list.getBoundingClientRect();
    return { scrolls: list.scrollHeight > list.clientHeight, inside: [...list.querySelectorAll(".keys-group")].every((g) => g.getBoundingClientRect().right <= r.right + 1) };
  });
  expect(fit).toEqual({ scrolls: true, inside: true });
  await page.keyboard.type("duplicate");
  await expect(sheet.locator(".keys-row")).toHaveCount(2);
  await expect(sheet.getByRole("group", { name: "Database table" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("keyboard sh");
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
});

test("⌘ halten zeigt die Tasten der Stelle: überall, Seitenleiste, Text, Blöcke, Datenbank", async ({ page }) => {
  await ready(page);
  const id = await newPage(page, "Keys here");
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await expect(editor).toBeVisible();
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.type("hello");
  expect(await holdMod(page)).toEqual(["While writing", "Everywhere"]);
  await page.keyboard.press("Escape");
  expect(await holdMod(page)).toEqual(["With blocks selected", "Everywhere"]);
  await page.keyboard.press("ControlOrMeta+Shift+E");
  expect(await holdMod(page)).toEqual(["In the sidebar", "Everywhere"]);
  // ein normales Kürzel lässt die Anzeige nicht aufblitzen
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("shortcut-hud")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  const grid = page.locator(".shell-database.full").getByRole("grid");
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  expect(await holdMod(page)).toEqual(["In a database table", "Everywhere"]);
});

test("Editor: ⌘/ öffnet das Blockmenü, Pfeile und Enter wählen", async ({ page }) => {
  await ready(page);
  const id = await newPage(page, "Block menu");
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.type("one");
  await page.keyboard.press("ControlOrMeta+/");
  const menu = page.getByTestId("block-menu");
  await expect(menu).toBeVisible();
  await expect(editor.locator(".bx2-block[data-selected]")).toHaveCount(1);
  await menu.getByRole("menuitem", { name: /Duplicate/ }).focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(editor.locator("[data-editable-id]").filter({ hasText: "one" })).toHaveCount(2);
});

test("Mac-Menü: ein Befehl aus dem Register läuft über dieselbe Taste (based:command)", async ({ page }) => {
  await ready(page);
  const send = (id: string) => page.evaluate((x) => { window.dispatchEvent(new CustomEvent("based:command", { detail: x })); }, id);
  await send("quickFind");
  await expect(page.getByPlaceholder(/Search/).first()).toBeFocused();
  await send("quickFind");
  await send("shortcuts");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await send("toggleSidebar");
  await expect(page.getByTestId("sidebar-show")).toBeVisible();
  await send("toggleSidebar");
  await expect(page.getByTestId("sidebar-show")).toHaveCount(0);
  await send("settings");
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  await send("back");
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toHaveCount(0);
});
