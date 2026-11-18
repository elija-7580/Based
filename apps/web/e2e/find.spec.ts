import { expect, test, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-206: Suchen in der Seite (⌘F), Wortzahl im •••-Menü, Filter in Quick Find. BSD-244: Zurück/Vor per Maustaste,
// Tastatur und Wischen.

const based = (page: Page, fn: string) => page.evaluate(`(async () => { const b = globalThis.__based; ${fn} })()`);

async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newPageWith(page: Page, lines: string[]) {
  await page.keyboard.press("ControlOrMeta+Alt+n");
  const editor = blockEditor(page);
  await expectEditable(page);
  await focusEditorEnd(page);
  for (const l of lines) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  return editor;
}

test("⌘F: Fundstellen zählen, Enter/⇧Enter/⌘G wandern, Tippen im Editor zählt nach, Esc schließt", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  const editor = await newPageWith(page, ["Café notes for the café team", "Nothing here", "A third CAFE line"]);
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.getByTestId("find-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("textbox")).toBeFocused();
  await page.keyboard.type("cafe");
  const count = page.getByTestId("find-count");
  await expect(count).toHaveText("1 of 3");
  expect(await page.evaluate(() => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.has("based-find") ?? true)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 3");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("3 of 3");
  await page.keyboard.press("ControlOrMeta+g");
  await expect(count).toHaveText("1 of 3");
  // Der Editor-Text bleibt unberührt (keine Markierung im Dokument).
  await expect(editor.locator("mark")).toHaveCount(0);

  await focusEditorEnd(page);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("one more cafe");
  await expect(count).toHaveText(/of 4$/);

  await page.keyboard.press("ControlOrMeta+f");
  await expect(bar.getByRole("textbox")).toBeFocused();
  await page.keyboard.type("zzz");
  await expect(count).toHaveText("No results");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  expect(await page.evaluate(() => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.has("based-find") ?? false)).toBe(false);
});

test("•••-Menü: Find in page und Wortzahl", async ({ page }) => {
  await ready(page);
  await newPageWith(page, ["one two three", "four five"]);
  await page.getByRole("button", { name: "Page menu" }).click();
  await expect(page.getByTestId("page-menu-words")).toHaveText("5 words · 22 characters");
  await page.getByRole("menuitem", { name: /Find in page/ }).click();
  await expect(page.getByTestId("find-bar").getByRole("textbox")).toBeFocused();
});

test("Quick Find: Title only, In this page und Sortierung filtern die Treffer", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  await newPageWith(page, ["the zebra lives in this text"]);
  await page.getByLabel("Page title").fill("Animals");
  await based(page, `await b.client.command({ op: "seed", count: 3, prefix: "Zebra" });`);

  await page.keyboard.press("ControlOrMeta+k");
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  await qf.getByRole("combobox", { name: "Search pages" }).fill("zebra");
  const options = qf.getByRole("listbox", { name: "Results" }).getByRole("option");
  await expect(options).toHaveCount(4);

  await qf.getByRole("button", { name: "Title only" }).click();
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: "Animals" })).toHaveCount(0);
  await qf.getByRole("button", { name: "Title only" }).click();

  await qf.getByRole("button", { name: "In this page" }).click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Animals");
  await qf.getByRole("button", { name: "In this page" }).click();

  await qf.getByLabel("Sort").selectOption("createdOldest");
  await expect(options.first()).toContainText("Animals");
  await qf.getByLabel("Edited").selectOption("today");
  await expect(options).toHaveCount(4);
});

test("Quick Find: Tippfehler finden, markieren und heißen „Closest matches“; kein Treffer sagt, was hilft", async ({ page }) => {
  await ready(page);
  await newPageWith(page, ["Die Umsatzprognose wird nach oben korrigiert"]);
  await page.getByLabel("Page title").fill("Quartalsabschluss");
  await page.keyboard.press("ControlOrMeta+k");
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  const input = qf.getByRole("combobox", { name: "Search pages" });
  const options = qf.getByRole("listbox", { name: "Results" }).getByRole("option");
  await input.fill("Umsatzprognsoe");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Quartalsabschluss");
  await expect(qf.getByTestId("qf-head")).toHaveText("Closest matches");
  await expect(options.first().locator("mark")).toHaveText("Umsatzprognose");
  await input.fill("Quartalsabschluss");
  await expect(qf.getByTestId("qf-head")).toHaveText("Best matches");
  await expect(options.first().locator("strong mark")).toHaveText("Quartalsabschluss");
  await input.fill("xqzvwy");
  await expect(qf.getByTestId("qf-none")).toContainText("No results for “xqzvwy”");
  await expect(qf.getByTestId("qf-none")).toContainText("Check the spelling");
  // Mit Filter: der Leerzustand nennt den Filter und räumt ihn auf Wunsch weg
  await input.fill("Umsatzprognose");
  await qf.getByRole("button", { name: "Title only" }).click();
  await expect(qf.getByTestId("qf-none")).toContainText("filters");
  await qf.getByRole("button", { name: "Clear filters" }).click();
  await expect(options).toHaveCount(1);
  await expect(input).toBeFocused();
});

test("Quick Find: die Auswahl bleibt beim Blättern mit den Pfeiltasten sichtbar", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await based(page, `await b.client.command({ op: "seed", count: 30, prefix: "Zebra" });`);
  await page.keyboard.press("ControlOrMeta+k");
  const qf = page.getByRole("dialog", { name: "Quick Find" });
  await qf.getByRole("combobox", { name: "Search pages" }).fill("zebra");
  const list = qf.getByRole("listbox", { name: "Results" });
  await expect(list.getByRole("option")).toHaveCount(30);
  const visible = () => list.evaluate((ul) => {
    const sel = ul.querySelector("[aria-selected='true']")!.getBoundingClientRect(), box = ul.getBoundingClientRect();
    return sel.top >= box.top - 1 && sel.bottom <= box.bottom + 1;
  });
  for (let i = 0; i < 17; i++) await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option").nth(17)).toHaveAttribute("aria-selected", "true");
  expect(await visible()).toBe(true);
  await page.keyboard.press("PageDown");
  await expect(list.getByRole("option").nth(25)).toHaveAttribute("aria-selected", "true");
  expect(await visible()).toBe(true);
  for (let i = 0; i < 4; i++) await page.keyboard.press("PageUp");
  await expect(list.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  expect(await visible()).toBe(true);
});

test("Zurück/Vor: Maustasten 4/5, Tastatur außerhalb von Text, Wischen mit Hinweis", async ({ page }) => {
  await ready(page);
  await based(page, `b.history.navigate({ name: "library" }); b.history.navigate({ name: "trash" });`);
  const at = () => page.evaluate(() => location.hash);
  await expect.poll(at).toBe("#trash");
  const button = (b: number) => page.evaluate((b) => {
    window.dispatchEvent(new MouseEvent("mousedown", { button: b, cancelable: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: b, cancelable: true }));
  }, b);
  await button(3);
  await expect.poll(at).toBe("#library");
  await button(4);
  await expect.poll(at).toBe("#trash");

  // Tastatur: ⌘← auf Apple, Alt+← sonst (WebKit-Testprofil meldet Mac).
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.locator(".panel").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(mac ? "Meta+ArrowLeft" : "Alt+ArrowLeft");
  await expect.poll(at).toBe("#library");
  await page.keyboard.press(mac ? "Meta+ArrowRight" : "Alt+ArrowRight");
  await expect.poll(at).toBe("#trash");

  // Wischen: zwei Finger nach rechts = zurück; halber Weg zeigt nur den Hinweis.
  const wheel = (dx: number, n: number) => page.evaluate(async ({ dx, n }) => {
    for (let i = 0; i < n; i++) {
      document.querySelector(".panel")!.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: 0, bubbles: true }));
      await new Promise((r) => setTimeout(r, 8));
    }
  }, { dx, n });
  await wheel(-20, 6);
  await expect(page.locator(".swipe-hint")).toHaveAttribute("data-side", "back");
  await expect.poll(at).toBe("#trash");
  await page.waitForTimeout(400);
  await expect(page.locator(".swipe-hint")).toHaveAttribute("data-side", "");
  await wheel(-20, 14);
  await expect.poll(at).toBe("#library");
});

// Checkliste: das Suchfenster in drei Größen, hell und dunkel – Treffer, Tippfehler, kein Treffer, offenes Menü.
for (const theme of ["light", "dark"] as const) {
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    test(`Quick Find ${w}×${h} ${theme}: passt ins Fenster, nichts läuft heraus`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.goto("/");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await based(page, `await b.client.command({ op: "seed", count: 30, prefix: "Budget meeting notes" });
        await b.client.command({ op: "createPage", title: "Besprechungsnotiz Quartalsabschluss mit einem wirklich sehr langen Titel, der nicht in eine Zeile passt und umbrechen muss, ohne das Fenster zu sprengen" });`);
      await page.keyboard.press("ControlOrMeta+k");
      const qf = page.getByRole("dialog", { name: "Quick Find" });
      const input = qf.getByRole("combobox", { name: "Search pages" });
      const shots = process.env.BASED_SCREENSHOTS && browserName === "chromium";
      const shot = async (name: string) => { if (shots) await page.screenshot({ path: `../../docs/design/screens/web-quick-find-${name}-${theme}-${w}x${h}.png` }); };
      const inside = async () => {
        const box = (await qf.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(w);
        expect(box.y + box.height).toBeLessThanOrEqual(h);
        // kein Eintrag und kein Text ragt rechts aus dem Fenster der Suche
        expect(await qf.evaluate((el) => {
          const right = el.getBoundingClientRect().right;
          return [...el.querySelectorAll("li, li strong, li .t-desc, .qf-filters > *, .qf-foot > *")].every((e) => e.getBoundingClientRect().right <= right + 1);
        })).toBe(true);
      };
      await input.fill("budget");
      await expect(qf.getByRole("listbox", { name: "Results" }).getByRole("option")).toHaveCount(30);
      await inside();
      await shot("hits");
      await input.fill("Quartalsabschlus mti");
      await expect(qf.getByTestId("qf-head")).toHaveText("Closest matches");
      await inside();
      await shot("typo");
      await input.fill("xqzvwy");
      await expect(qf.getByTestId("qf-none")).toBeVisible();
      await inside();
      await qf.locator("select[aria-label=Sort]").click();
      await expect(page.getByRole("listbox", { name: "Sort" })).toBeVisible();
      await shot("none-menu");
    });
  }
}
