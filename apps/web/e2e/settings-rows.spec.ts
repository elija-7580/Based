import { expect, test } from "@playwright/test";

// BSD-509: In einer Einstellungszeile bleibt der Wert oder Knopf rechts neben dem Text, auch wenn der Hinweis lang ist –
// der Hinweis bricht um, statt den Knopf in eine eigene Zeile nach links zu schieben. Alle Einstellungsseiten, drei Größen.

const PAGES = ["account", "my-settings", "workspace", "language", "agents", "import", "sync", "updates", "diagnostics", "about"];

// 900 × 600: dort darf ein breiter Umschalter in die nächste Zeile rutschen (overflow.spec prüft, dass nichts überläuft).
for (const [w, h] of [[1280, 820], [1728, 1000]] as const) {
  test(`Einstellungszeilen: Knopf bleibt rechts neben langem Hinweis (${w} × ${h})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const wrong: string[] = [];
    for (const p of PAGES) {
      await page.evaluate((x) => { location.hash = "#prefs-" + x; }, p);
      await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", p);
      await page.waitForTimeout(200);
      wrong.push(...await page.evaluate((pg) => [...document.querySelectorAll<HTMLElement>(".settings-row")].flatMap((row) => {
        const [text, ...rest] = [...row.children] as HTMLElement[];
        if (!text || !rest.length) return [];
        const t = text.getBoundingClientRect();
        const rowWidth = row.getBoundingClientRect().width;
        // Breite Bedienelemente (Icon-Raster, Umschalter mit langen Einträgen) dürfen in eine eigene Zeile.
        return rest.filter((c) => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().width < rowWidth / 2).filter((c) => {
          const r = c.getBoundingClientRect();
          // umgebrochen: liegt unter dem Text und beginnt links (statt rechts daneben)
          return r.top >= t.bottom - 1 && r.left < t.left + t.width / 2;
        }).map(() => `${pg}: „${(text.textContent ?? "").slice(0, 40)}“`);
      }), p));
    }
    expect(wrong).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Foto: Einstellungszeilen in Sync & server (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "nur für Fotos");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/#prefs-sync");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByText("Database columns").first()).toBeVisible();
    await page.screenshot({ path: `../../docs/design/screens/web-settings-rows-${theme}.png` });
  });
}
