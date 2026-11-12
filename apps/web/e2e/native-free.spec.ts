import { expect, test, type Page } from "@playwright/test";

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
