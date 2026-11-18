import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-527 (Element-System 3, docs/design/elements.md Abschnitt 4 „Menü“): jede Liste, aus der man wählt, ist dasselbe
// Menü – Fläche `surface-card`, Radius `radius-xl`, `shadow-menu`, Innenabstand `space-1`; Zeile Höhe `md`, Radius
// `radius-md`, Text `ui` (14 px). Geprüft an allen Menü-Familien: Slash-Menü (Editor), Spaltenmenü (Datenbank),
// Seitenmenü „…“ und Seitenleisten-Menü (Shell), Kontextmenü (Based statt System) und das Astryx-Menü (Design-Kit).

type Look = { radius: string; bg: string; padding: string; shadow: boolean; rowHeight: number; rowRadius: string; rowFont: string; rowPadLeft: string };

async function look(menu: Locator, row: Locator): Promise<Look> {
  const m = await menu.evaluate((el) => { const s = getComputedStyle(el); return { radius: s.borderTopLeftRadius, bg: s.backgroundColor, padding: s.paddingTop, shadow: s.boxShadow !== "none" }; });
  const r = await row.evaluate((el) => { const s = getComputedStyle(el); return { rowHeight: Math.round(el.getBoundingClientRect().height), rowRadius: s.borderTopLeftRadius, rowFont: s.fontSize, rowPadLeft: s.paddingLeft }; });
  return { ...m, ...r };
}

async function tokens(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const px = (v: string) => { probe.style.width = `var(${v})`; return getComputedStyle(probe).width; };
    // Auf Apple-Systemen (WebKit) sind Menüs Glas: dann gilt chrome-bg statt surface-card
    probe.style.color = document.querySelector("[data-material=glass]") ? "var(--chrome-bg)" : "var(--surface-card)";
    const bg = getComputedStyle(probe).color;
    const out = { radius: px("--radius-xl"), bg, padding: px("--space-1"), rowHeight: Math.round(parseFloat(px("--control-md"))), rowRadius: px("--radius-md"), rowPadLeft: px("--space-3") };
    probe.remove();
    return out;
  });
}

for (const theme of ["light", "dark"] as const) test(`Ein Menü: alle Menü-Familien sehen gleich aus (${theme})`, async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const want = await tokens(page);
  const looks: Record<string, Look> = {};

  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/");
  const slash = page.locator(".bx2-menu").first();
  await expect(slash).toBeVisible();
  looks["Slash"] = await look(slash, slash.locator(".bx2-menu-item").first());
  await page.keyboard.type("database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  await db.getByRole("columnheader", { name: /Name/ }).first().click();
  const col = page.locator(".dbui-popover").filter({ has: page.locator(".dbui-menu-item") }).first();
  await expect(col).toBeVisible();
  looks["Spaltenmenü"] = await look(col, col.locator(".dbui-menu-item").first());
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Page menu" }).click();
  const pm = page.getByRole("menu", { name: "Page menu" });
  await expect(pm).toBeVisible();
  looks["Seitenmenü"] = await look(pm, pm.locator(".menu-item").first());
  // Das Menü liegt über allem, auch über der Werkzeugleiste der Inline-Datenbank darunter (elements.md, Abschnitt 5)
  const covered = await pm.evaluate((menu) => [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")].filter((it) => {
    const r = it.getBoundingClientRect();
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.right - 8, r.top + r.height / 2], [r.left + 8, r.top + r.height / 2]] as const) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !menu.contains(hit)) return true;
    }
    return false;
  }).map((it) => it.textContent));
  expect(covered, "verdeckte Menüzeilen").toEqual([]);
  await page.keyboard.press("Escape");

  await page.getByLabel("Page title").click({ button: "right" });
  const ctx = page.getByRole("menu", { name: "Context menu" });
  await expect(ctx).toBeVisible();
  looks["Kontextmenü"] = await look(page.locator(".nf-layer").filter({ has: page.locator(".nf-item") }).first(), ctx.locator(".nf-item").first());
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Page menu" }).click();
  await expect(pm).toBeVisible();
  if (test.info().project.name === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-elements-v11-menu-${theme}.png` });
  await page.keyboard.press("Escape");

  const wrong: string[] = [];
  for (const [name, l] of Object.entries(looks)) {
    if (l.radius !== want.radius) wrong.push(`${name}: Radius ${l.radius} statt ${want.radius}`);
    if (l.bg !== want.bg) wrong.push(`${name}: Fläche ${l.bg} statt ${want.bg}`);
    if (l.padding !== want.padding) wrong.push(`${name}: Innenabstand ${l.padding} statt ${want.padding}`);
    if (!l.shadow) wrong.push(`${name}: ohne Schatten`);
    if (l.rowHeight !== want.rowHeight) wrong.push(`${name}: Zeile ${l.rowHeight} px statt ${want.rowHeight}`);
    if (l.rowRadius !== want.rowRadius) wrong.push(`${name}: Zeilenradius ${l.rowRadius} statt ${want.rowRadius}`);
    if (l.rowFont !== "14px") wrong.push(`${name}: Schrift ${l.rowFont} statt 14px`);
    if (l.rowPadLeft !== want.rowPadLeft) wrong.push(`${name}: Zeile links ${l.rowPadLeft} statt ${want.rowPadLeft}`);
  }
  expect(wrong).toEqual([]);
});
