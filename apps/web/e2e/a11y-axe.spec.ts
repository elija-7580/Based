import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-304 Teil 4: axe-core (MPL-2.0) prüft auf den Hauptscreens hell und dunkel Rollen, Namen, ARIA-Beziehungen und
// Kontrast nach WCAG 2.1 A/AA. Maßstab: docs/quality/checklist.md, Abschnitt 3.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

/** Bekannte Funde mit eigenem Backlog-Eintrag – fällt einer weg, Ausnahme hier löschen. */
const KNOWN: { why: string; match: (screen: string, rule: string, target: string) => boolean }[] = [
  // BSD-443: Abschnittsköpfe und „Create a teamspace“ sind Knöpfe im role=tree der Seitenleiste
  { why: "BSD-443", match: (_s, rule, target) => rule === "aria-required-children" && target === ".tree" },
  // BSD-444: ARIA-Struktur der Datenbank-Tabelle (Gutter/„Add property“ ohne Zelle, Fuß außerhalb des Grids, „Add view“ im Tablist)
  { why: "BSD-444", match: (s, rule, target) => s === "database" && /^aria-required-(children|parent)$/.test(rule) && /dbui-|data-index/.test(target) },
];

async function scan(page: Page, name: string): Promise<string[]> {
  // Messen erst im Ruhezustand: Maus weg (sonst blendet ein Tooltip ein), kein Tooltip mehr sichtbar, keine laufende
  // Animation und kein Übergang – sonst misst axe Zwischenfarben (WebKit: .nf-tip mitten im Einblenden).
  await page.mouse.move(1, 1);
  await expect(page.locator(".nf-tip")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  await page.waitForTimeout(100);
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return res.violations.flatMap((v) => v.nodes
    .filter((n) => !KNOWN.some((k) => k.match(name, v.id, n.target.join(" "))))
    .map((n) => `${name}: ${v.id} – ${n.target.join(" ")} – ${n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() ?? ""}`));
}

for (const theme of ["light", "dark"] as const) {
  test(`axe: Hauptscreens ohne Verstöße (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const found: string[] = [];
    const go = async (hash: string) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500); };
    found.push(...await scan(page, "home"));
    const id = (await command(page, { op: "createPage", title: "Axe page" })) as string;
    await go("#page-" + id);
    await expectEditable(page);
    await focusEditorEnd(page);
    await page.keyboard.type("Some text for the page.");
    found.push(...await scan(page, "page"));
    const db = (await command(page, { op: "createDatabase", title: "Axe database" })) as string;
    await go("#page-" + db);
    await expect(page.locator(".dbui-table").first()).toBeVisible();
    found.push(...await scan(page, "database"));
    for (const [n, h] of [["library", "#library"], ["trash", "#trash"], ["chat", "#chat"], ["settings", "#prefs-my-settings"]] as const) {
      await go(h);
      found.push(...await scan(page, n));
    }
    await go("#home");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
    found.push(...await scan(page, "quick-find"));
    expect(found).toEqual([]);
  });
}
