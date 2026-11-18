import { expect, test, type Page } from "@playwright/test";

// BSD-530 (Element-System 6, docs/design/elements.md Abschnitt 4 „Kopf eines App-Screens“): Zeile 1 Titel `heading`
// (20 / 600) und daneben die Anzahl in `meta`, rechts die Hauptaktion; Zeile 2 Umschalter, Filter, Suchfeld (md).
// Der große Titel (32) gehört nur eigenen Seiten und Datenbanken.

async function head(page: Page) {
  const h1 = page.locator("main h1, [data-testid=library] h1, [data-testid=graph] h1, .content h1, .settings-page h1").first();
  await expect(h1).toBeVisible();
  return h1.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const count = el.parentElement?.querySelector<HTMLElement>("[data-head-count]");
    const c = count ? getComputedStyle(count) : undefined;
    const cr = count?.getBoundingClientRect();
    return {
      size: s.fontSize, weight: s.fontWeight,
      count: count ? { size: c!.fontSize, sameLine: Math.abs((cr!.top + cr!.height / 2) - (r.top + r.height / 2)) < r.height / 2 + 2 } : undefined,
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Köpfe der App-Screens: Titel 20/600, Anzahl in meta daneben (${theme})`, async ({ page, browserName }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const wrong: string[] = [];
    for (const [hash, name, withCount] of [["#library", "Library", true], ["#trash", "Trash", true], ["#graph", "Graph", true], ["#prefs-appearance", "Settings", false]] as const) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(400);
      const h = await head(page);
      if (h.size !== "20px" || h.weight !== "600") wrong.push(`${name}: Titel ${h.size}/${h.weight}`);
      if (withCount) {
        if (!h.count) wrong.push(`${name}: keine Anzahl`);
        else {
          if (h.count.size !== "12px") wrong.push(`${name}: Anzahl ${h.count.size}`);
          if (!h.count.sameLine) wrong.push(`${name}: Anzahl nicht neben dem Titel`);
        }
      }
      if (browserName === "chromium" && name !== "Library") await page.screenshot({ path: `../../docs/design/screens/web-elements-v11-head-${name.toLowerCase()}-${theme}.png` });
    }
    expect(wrong).toEqual([]);
  });
}
