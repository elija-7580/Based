import { expect, test, type Page } from "@playwright/test";
import { blockEditor, expectEditable } from "./editor-helpers.js";
import { useLegacyEditor } from "./legacy-editor.js";

// „Nichts vom System“ (@based/ui/native): Jeder Klick öffnet Based-Oberfläche – eigenes Kontextmenü an jeder Stelle,
// eigene Auswahlliste für <select>, eigene Tooltips statt der title-Blase, keine Systemauswahl für Datum/Uhrzeit.

async function fresh(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

/** Löst an (x, y) einen Rechtsklick aus und meldet, ob das Systemmenü unterdrückt wurde. */
async function rightClickSuppressed(page: Page, x: number, y: number): Promise<boolean> {
  await page.evaluate(() => {
    (window as unknown as { __ctx?: boolean[] }).__ctx = [];
    // Letzter Lauscher am Fenster (nach dem der App): sieht, was am Ende gilt.
    window.addEventListener("contextmenu", (e) => (window as unknown as { __ctx: boolean[] }).__ctx.push(e.defaultPrevented), { once: true });
  });
  await page.mouse.click(x, y, { button: "right" });
  return page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx.every(Boolean) && (window as unknown as { __ctx: boolean[] }).__ctx.length === 1);
}

test("Rechtsklick auf freie Fläche: Based-Menü mit den Wegen der App, kein Systemmenü", { tag: "@smoke" }, async ({ page }) => {
  await fresh(page);
  const panel = (await page.locator(".panel").boundingBox())!;
  expect(await rightClickSuppressed(page, panel.x + panel.width - 24, panel.y + panel.height - 24)).toBe(true);
  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/^Search…/, /^New page/, /^Back/, /^Forward/, /^Settings/]);
  // Das Menü bleibt im Fenster.
  const box = (await menu.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(820);
  await menu.getByRole("menuitem", { name: /Search/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /Search|Quick Find/i }).or(page.locator(".qf"))).toBeVisible();
});

test("Rechtsklick an vielen Stellen: überall unterdrückt, Escape und Klick daneben schließen", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByTestId("page-content")).toContainText("This is your workspace");
  const spots = [".sidebar", ".main", ".panel", "[data-testid=page-content]"];
  for (const sel of spots) {
    const b = (await page.locator(sel).first().boundingBox())!;
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1]] as const) {
      expect(await rightClickSuppressed(page, b.x + b.width * fx, b.y + b.height * fy), `${sel} ${fx}/${fy}`).toBe(true);
      await page.keyboard.press("Escape");
    }
  }
  const panel = (await page.locator(".panel").boundingBox())!;
  await page.mouse.click(panel.x + panel.width - 20, panel.y + panel.height - 20, { button: "right" });
  await expect(page.locator(".nf-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".nf-menu")).toHaveCount(0);
  await page.mouse.click(panel.x + panel.width - 20, panel.y + panel.height - 20, { button: "right" });
  await expect(page.locator(".nf-menu")).toBeVisible();
  await page.mouse.click(panel.x + 20, panel.y + panel.height - 20);
  await expect(page.locator(".nf-menu")).toHaveCount(0);
});

test("Rechtsklick im Text: Ausschneiden, Kopieren, Einfügen, Alles auswählen – Auswahl und Fokus bleiben", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  const title = page.getByLabel("Page title");
  await expect(title).toHaveValue("Welcome to Based");
  await title.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu.getByRole("menuitem")).toHaveText([/^Cut/, /^Copy/, /^Paste/, /^Select all/]);
  await expect(menu.getByRole("menuitem", { name: /Cut/ })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: /Select all/ }).click();
  await expect(title).toBeFocused();
  expect(await title.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0))).toBe("Welcome to Based");
  // Mit Auswahl sind Ausschneiden/Kopieren aktiv; Ausschneiden leert das Feld.
  await title.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: /Copy/ })).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Cut/ })).toHaveAttribute("data-active", "");
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("");
});

test("Bausteine mit eigenem Menü behalten es (Seitenleiste), ohne zweites Menü darüber", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
  await expect(page.getByRole("menu").first()).toBeVisible();
  await expect(page.locator(".nf-menu")).toHaveCount(0);
});

test("Auswahlfeld: Klick öffnet die Based-Liste; Maus, Pfeile und Tippen wählen", { tag: "@smoke" }, async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("ControlOrMeta+k");
  const sort = page.locator("select[aria-label=Sort]");
  await expect(sort).toBeVisible();
  expect(await sort.evaluate((el) => getComputedStyle(el).appearance)).toBe("none");
  await sort.click();
  const list = page.getByRole("listbox", { name: "Sort" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "Best match" })).toHaveAttribute("aria-selected", "true");
  // Die Suche darunter bleibt offen, obwohl die Liste außerhalb ihres Kastens liegt.
  await list.getByRole("option", { name: "Created: newest" }).click();
  await expect(list).toHaveCount(0);
  await expect(sort).toHaveValue("createdNewest");
  await expect(sort).toBeVisible();
  // Tastatur: Pfeil öffnet, Pfeil wandert, Enter wählt; Escape schließt nur die Liste.
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(sort).toHaveValue("lastEditedOldest");
  await sort.focus();
  await page.keyboard.press("Space");
  await expect(list).toBeVisible();
  await page.keyboard.type("best");
  await expect(list.getByRole("option", { name: "Best match" })).toHaveAttribute("data-active", "");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(sort).toBeVisible();
  await expect(sort).toHaveValue("lastEditedOldest");
  // Zweiter Klick aufs Feld schließt die Liste wieder.
  await sort.click();
  await expect(list).toBeVisible();
  await sort.click();
  await expect(list).toHaveCount(0);
});

test("Tooltips: kein title mehr im Dokument, Based-Tooltip beim Überfahren, Name bleibt zugänglich", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByTestId("page-content")).toContainText("This is your workspace");
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("body [title]:not(iframe)").length)).toBe(0);
  const tipped = page.locator("[data-tip]").first();
  await expect(tipped).toBeVisible();
  const text = (await tipped.getAttribute("data-tip"))!;
  // Der Titel trägt weiter Name oder Beschreibung.
  expect(await tipped.evaluate((el) => el.getAttribute("aria-label") ?? el.getAttribute("aria-description") ?? el.textContent)).toBeTruthy();
  await tipped.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(text);
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  await page.mouse.move(640, 700);
  await expect(tip).toHaveCount(0);
});

test("Keine Systemauswahl für Datum und Uhrzeit in der App", async ({ page }) => {
  await fresh(page);
  for (const name of ["Library", "Home"]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(await page.locator("input[type=date], input[type=time], input[type=datetime-local], input[type=color], input[type=month], input[type=week]").count()).toBe(0);
  }
});

// BSD-407 Teil 3: Blockmenü mit Icons und Glas wie das Seitenmenü hat bisher nur der alte Editor (im Block-Editor:
// Teil 2g, Menüs aus @based/ui/astryx). Diese zwei Tests pinnen ihn (docs/editor-parity.md, „noch BlockNote“).
test.describe("Blockmenü des alten Editors", () => {
useLegacyEditor();

test("Blockmenü (⋮⋮) öffnet direkt am Griff, nicht je nach Block verschoben", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByTestId("page-content")).toContainText("This is your workspace");
  for (const text of ["Start here", "Press ⌘K"]) {
    await page.getByTestId("page-content").locator("h1, h2, h3, p, [data-content-type]").filter({ hasText: text }).last().hover();
    const handle = page.locator(".bn-side-menu [draggable=true]").last();
    const h = (await handle.boundingBox())!;
    await handle.click();
    const menu = page.locator(".bn-drag-handle-menu");
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    expect(Math.abs(m.y - h.y), `${text}: oben bündig`).toBeLessThanOrEqual(4);
    expect(Math.abs(m.x + m.width - h.x), `${text}: links neben dem Griff`).toBeLessThanOrEqual(12);
    // Gleiche Icons wie im Seitenmenü „…“
    await expect(menu.locator(".bn-ak-menu-item .nf-glyph svg")).not.toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});

test("Glas wie die übrigen Menüs: Kontextmenü und Blockmenü sehen aus wie „…“ oben rechts", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await fresh(page);
  await expect(page.locator("html")).toHaveAttribute("data-material", "glass");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByTestId("page-content")).toContainText("This is your workspace");
  const look = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"), shadow: cs.boxShadow, radius: cs.borderTopLeftRadius };
  });
  await page.getByRole("button", { name: "Page menu" }).click();
  const reference = await look(".page-menu");
  expect(reference.filter).not.toBe("none");
  await page.keyboard.press("Escape");
  await page.getByLabel("Page title").click({ button: "right" });
  expect(await look(".nf-menu")).toEqual(reference);
  await page.keyboard.press("Escape");
  await page.getByTestId("page-content").locator("h1, h2, h3").filter({ hasText: "Start here" }).first().hover();
  await page.locator(".bn-side-menu [draggable=true]").last().click();
  expect(await look(".bn-drag-handle-menu")).toEqual(reference);
});
});

// BSD-366: keine macOS Writing Tools und keine Siri-/Inline-Vorschläge – weder im Editor noch in Feldern.
// `writingsuggestions` vererbt sich; die Prüfung nimmt die Eigenschaft des Browsers (falls vorhanden) und sonst das
// nächste Attribut darüber.
test("Writing Tools und Schreibvorschläge sind überall aus, Rechtschreibprüfung bleibt", async ({ page }) => {
  await fresh(page);
  const state = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const prop = (el as HTMLElement & { writingSuggestions?: string }).writingSuggestions;
    return { prop: typeof prop === "string" ? prop : "false", attr: el.closest("[writingsuggestions]")?.getAttribute("writingsuggestions") ?? null };
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("writingsuggestions"))).toBe("false");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expectEditable(page);
  for (const sel of ["[data-testid=block-editor] [data-editable-id]", "[aria-label='Page title']"]) expect(await state(sel), sel).toEqual({ prop: "false", attr: "false" });
  // Felder in Dialogen und Menüs (Quick Find)
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog").locator("input").first();
  await expect(search).toBeVisible();
  expect(await search.evaluate((el) => el.closest("[writingsuggestions]")?.getAttribute("writingsuggestions"))).toBe("false");
  // Wer es ausdrücklich einschaltet, wird zurückgestellt.
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "ws-probe"; i.setAttribute("writingsuggestions", "true"); document.body.append(i); });
  await expect(page.locator("#ws-probe")).toHaveAttribute("writingsuggestions", "false");
  // Rechtschreibprüfung ist eine eigene Einstellung und bleibt an
  expect(await page.evaluate(() => document.body.spellcheck)).toBe(true);
});

// BSD-359: Kästchen in Based-Optik (keine Systemzeichnung), Leertaste schaltet weiter, Rolle bleibt „checkbox“.
test("Kästchen und Optionsfelder: Based-Zeichnung, Tastatur und Rolle unverändert", async ({ page }) => {
  await fresh(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  const box = blockEditor(page).locator("input[type=checkbox]").first();
  await expect(box).toBeVisible();
  const look = () => box.evaluate((el) => { const s = getComputedStyle(el); return { appearance: s.appearance || s.getPropertyValue("-webkit-appearance"), bg: s.backgroundColor, border: s.borderTopColor, w: Math.round(el.getBoundingClientRect().width) }; });
  const tok = (name: string) => page.evaluate((n) => { const p = document.createElement("i"); p.style.color = `var(--${n})`; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }, name);
  const off = await look();
  expect(off.appearance).toBe("none");
  expect(off.border).toBe(await tok("control-border"));
  expect(off.w).toBe(16);
  expect(await box.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(16); // quadratisch
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  const button = await tok("button");
  await expect.poll(async () => (await look()).bg).toBe(button); // Farbübergang (--duration-fast) abwarten
  await box.click(); // (der Editor zeichnet das Kästchen nach dem Umschalten neu, der Fokus bleibt nicht darauf)
  await expect(box).not.toBeChecked();
});
