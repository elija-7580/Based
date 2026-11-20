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
