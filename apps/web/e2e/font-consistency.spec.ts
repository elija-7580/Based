import { expect, test, type Page } from "@playwright/test";

// Elija 20.11.: „Die Schriftarten sind immer noch nicht konsistent – sie wechseln hin und her, springen hin und her.“
// Ursachen: Font „Based“ kam als feste Schnitte ohne 600/700 in Literata (künstlich verdickt), wurde erst nach dem
// ersten Bild und je Gewicht nachgeladen (Ersatzschrift, dann Sprung), Überschriften im Editor standen in der
// Textschrift statt in der Überschriften-Schrift, Eingabefelder in der Browser-Schrift, Zeiten in Mono.

const ready = (page: Page) => expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
// WebKit schreibt Familien ohne Anführungszeichen – verglichen wird die Liste der Namen.
const norm = (f: string) => f.replace(/["']/g, "").split(",").map((x) => x.trim()).join(", ");
const family = async (page: Page, sel: string) => norm(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily));
const rootVar = async (page: Page, name: string) => norm(await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name));

async function pageWithHeadings(page: Page) {
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Fonts");
  await page.keyboard.press("Enter");
  for (const l of ["Text mit **fett** und _kursiv_", "# Eins", "## Zwei", "### Drei"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".bx2-t-heading3")).toHaveText("Drei");
}

for (const font of ["system", "based"] as const) {
  test(`Font ${font}: Überschriften wie der Titel, Text in der Textschrift, Felder erben`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.addInitScript((f) => { if (!sessionStorage.getItem("fc")) { sessionStorage.setItem("fc", "1"); localStorage.clear(); localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", font: f })); } }, font);
    await page.goto("/");
    await ready(page);
    await pageWithHeadings(page);

    const head = await rootVar(page, "--font-head");
    const body = await rootVar(page, "--font-body");
    for (const h of [".bx2-t-heading1", ".bx2-t-heading2", ".bx2-t-heading3"]) expect(await family(page, h)).toBe(head);
    expect(await family(page, ".bx2-t-text")).toBe(body);
    expect(await family(page, "textarea.title-input")).toBe(head);
    // Eingabefelder: nie die Browser-Standardschrift
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const qf = page.locator(".qf-field input");
    await expect(qf).toBeVisible();
    expect(norm(await qf.evaluate((el) => getComputedStyle(el).fontFamily))).toBe(await rootVar(page, "--font-ui"));
    await page.keyboard.press("Escape");

    if (font === "based") {
      // Variable Schriften: jedes Gewicht und echte Kursive – nichts wird künstlich verdickt oder schräggestellt.
      const faces = await page.evaluate(() => [...document.fonts].filter((f) => /Schibsted|Literata/.test(f.family)).map((f) => ({ family: f.family, weight: f.weight, style: f.style })));
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        const [lo, hi] = f.weight.split(" ").map(Number);
        expect(lo! <= 400 && (hi ?? 0) >= 800, `${f.family} ${f.style}: ${f.weight}`).toBe(true);
      }
      for (const fam of ["Schibsted Grotesk Variable", "Literata Variable"]) {
        expect(faces.some((f) => f.family === fam && f.style === "italic"), `${fam} kursiv`).toBe(true);
      }
      // Schon beim ersten Bild geladen (Start wartet auf die Dateien), auch nach dem Neuladen
      await page.reload();
      await ready(page);
      expect(await page.evaluate(() => ['400 16px "Schibsted Grotesk Variable"', '700 16px "Literata Variable"', 'italic 400 16px "Literata Variable"'].every((f) => document.fonts.check(f, "Based Äöü")))).toBe(true);
    }
  });
}

test("Font umschalten: die Wurzel wechselt erst, wenn die Schrift geladen ist (kein Sprung über die Ersatzschrift)", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("fc")) { sessionStorage.setItem("fc", "1"); localStorage.clear(); } });
  await page.goto("/#appearance");
  await ready(page);
  await page.evaluate(() => {
    const w = window as unknown as { __fontAtSwitch?: boolean };
    new MutationObserver(() => {
      if (document.documentElement.dataset.typeface === "based" && w.__fontAtSwitch === undefined) {
        w.__fontAtSwitch = document.fonts.check('400 16px "Schibsted Grotesk Variable"', "Based") && document.fonts.check('400 16px "Literata Variable"', "Based");
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-typeface"] });
  });
  await page.getByRole("radiogroup", { name: "Font" }).getByRole("radio", { name: "Based" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-typeface", "based");
  expect(await page.evaluate(() => (window as unknown as { __fontAtSwitch?: boolean }).__fontAtSwitch)).toBe(true);
});

test("Mono nur für Code und IDs: Zeiten auf Home in der UI-Schrift", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const ticks = page.locator(".arc-tick");
  if (await ticks.count()) expect(await ticks.first().evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain("monospace");
});

// Elija 23.11.: „Verschiedene Optionen ja, aber die müssen systemweit bleiben und nicht zufällig variieren – Anzeigen,
// Seiten, Notifications.“ Font Based setzte den Seitentext in Literata und alles andere in Schibsted Grotesk; die
// Seiten-Schrift „Serif“ war je System eine andere (New York, Georgia). Jetzt: eine Familie je Wahl, überall.
for (const font of ["system", "based"] as const) {
  test(`Font ${font}: eine Schrift für Seite, Datenbank, Suche, Meldung und Einstellungen`, async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.addInitScript((f) => { if (!sessionStorage.getItem("fc")) { sessionStorage.setItem("fc", "1"); localStorage.clear(); localStorage.setItem("based.appearance", JSON.stringify({ theme: "light", font: f })); } }, font);
    await page.goto("/");
    await ready(page);
    const ui = await rootVar(page, "--font-ui");
    expect(await rootVar(page, "--font-head")).toBe(ui);
    expect(await rootVar(page, "--font-body")).toBe(ui);
    if (font === "based") expect(ui).toContain("Schibsted Grotesk");
    const mono = await rootVar(page, "--font-mono");
    /** Jedes sichtbare Element mit eigenem Text: UI-Schrift, oder Mono (Code, IDs). */
    const strays = () => page.evaluate(({ ui, mono }) => {
      const norm = (f: string) => f.replace(/["']/g, "").split(",").map((x) => x.trim()).join(", ");
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
        const r = el.getBoundingClientRect();
        if (!own || !r.width || !r.height) continue;
        const f = norm(getComputedStyle(el).fontFamily);
        if (f !== ui && f !== mono) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}: ${f}`);
      }
      return [...new Set(out)];
    }, { ui, mono });

    await pageWithHeadings(page);
    expect(await strays(), "Seite").toEqual([]);
    // Fotos mit BASED_SCREENSHOTS=1 (Chromium): docs/design/screens/web-font-<font>-<theme>-<breite>.png
    if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        for (const size of [{ width: 1280, height: 820 }, { width: 900, height: 600 }, { width: 1728, height: 1000 }]) {
          await page.setViewportSize(size);
          await page.screenshot({ path: `../../docs/design/screens/web-font-${font}-${theme}-${size.width}.png` });
        }
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    // Meldung: Seite in den Papierkorb → „Moved to Trash · Undo“
    await page.getByRole("treeitem", { name: "Fonts" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Move to Trash/ }).click();
    await expect(page.locator(".based-toast")).toBeVisible();
    expect(await family(page, ".based-toast")).toBe(ui);
    expect(await strays(), "Meldung").toEqual([]);
    // Datenbank
    await page.goto("/#home");
    await page.getByRole("button", { name: "New database" }).first().click();
    await expect(page.locator(".dbui-root, [data-testid=database-view]").first()).toBeVisible();
    expect(await strays(), "Datenbank").toEqual([]);
    // Suche
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await page.locator(".qf-field input").fill("a");
    expect(await strays(), "Suche").toEqual([]);
    await page.keyboard.press("Escape");
    // Einstellungen
    await page.goto("/#appearance");
    await expect(page.getByRole("radiogroup", { name: "Font" })).toBeVisible();
    expect(await strays(), "Einstellungen").toEqual([]);
  });
}

test("Seiten-Schrift Serif: auf jedem System Literata, nicht die Serifenschrift des Systems", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await pageWithHeadings(page);
  await page.locator(".page[data-font]").evaluate((el) => el.setAttribute("data-font", "serif"));
  for (const sel of [".bx2-t-text", ".bx2-t-heading1", "textarea.title-input"]) expect(await family(page, sel)).toMatch(/^Literata Variable, Literata/);
  await expect.poll(() => page.evaluate(() => document.fonts.check('400 16px "Literata Variable"', "Based Äöü"))).toBe(true);
});
