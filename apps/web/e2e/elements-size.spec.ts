import { expect, test, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-528 (Element-System 4, docs/design/elements.md Abschnitt 2): alles, was man anklicken oder ausfüllen kann, ist
// mindestens 14 px groß. Der Test geht die Kernflächen durch (Seitenleiste, Home, Library, Seite mit Inline-Datenbank,
// Quick Find, Papierkorb, Einstellungen) und sammelt jedes sichtbare Bedienelement mit Text unter 14 px.

const CLICKABLE = "button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=option], [role=tab], [role=radio], [role=link], input:not([type=hidden]):not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, summary";

async function small(page: Page, where: string): Promise<string[]> {
  return page.evaluate(({ sel, where }) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      if (el.closest("[aria-hidden=true], [inert], .bx2-content, .ProseMirror, [contenteditable=true]")) continue;
      // Gruppenüberschriften („Private“, „Teamspaces“) sind laut elements.md Abschnitt 2 `meta`, auch wenn sie zuklappen.
      if (el.matches(".tree-header-label")) continue;
      // Sync-Status unten in der Seitenleiste: Statusanzeige in `meta`, die nie gekürzt werden darf (BSD-308); offen als
      // eigener Feinschliff-Eintrag.
      if (el.matches("[data-testid=sync-status]")) continue;
      // Text, den man liest: das Element selbst (Feld) oder seine Textknoten
      const field = el.matches("input, textarea, select");
      const text = field ? ((el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || "") : (el.innerText || "").trim();
      if (!text) continue;
      let size = parseFloat(cs.fontSize);
      if (!field) {
        // kleinster sichtbarer Text im Element (z. B. Label in einem Span)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        size = Infinity;
        while ((n = walker.nextNode())) {
          if (!(n.textContent ?? "").trim()) continue;
          const p = n.parentElement;
          if (!p || p.closest("kbd, .keycap, .keycaps, .bx2-menu-hint, .dbui-menu-hint, .menu-kbd, [aria-hidden=true]")) continue;
          const pr = p.getBoundingClientRect();
          if (pr.width <= 1 || pr.height <= 1) continue; // nur für Screenreader (clip)
          size = Math.min(size, parseFloat(getComputedStyle(p).fontSize));
        }
        if (size === Infinity) continue;
      }
      if (size < 14) out.push(`${where}: ${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} „${text.slice(0, 40).replace(/\s+/g, " ")}“ ${size}px`);
    }
    return out;
  }, { sel: CLICKABLE, where });
}

test("Anklickbares ist mindestens 14 px groß (Kernflächen)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const found: string[] = [];
  found.push(...await small(page, "Home"));
  // Seite mit Text und Inline-Datenbank
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("Hello");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  await expect(page.locator(".shell-database.inline")).toBeVisible();
  found.push(...await small(page, "Seite"));
  // Slash-Menü
  await focusEditorEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByRole("option").first()).toBeVisible();
  found.push(...await small(page, "Slash-Menü"));
  await page.keyboard.press("Escape");
  // Quick Find
  await page.keyboard.press("Escape");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await expect(page.getByRole("dialog").first()).toBeVisible();
  found.push(...await small(page, "Quick Find"));
  await page.keyboard.press("Escape");
  for (const [hash, where] of [["#library", "Library"], ["#graph", "Graph"], ["#trash", "Papierkorb"], ["#prefs-appearance", "Einstellungen"], ["#prefs-sync", "Einstellungen Sync"], ["#prefs-agents", "Einstellungen Agenten"], ["#prefs-import", "Einstellungen Import"]] as const) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(300);
    found.push(...await small(page, where));
  }
  expect([...new Set(found)]).toEqual([]);
});

// Fotos der Seitenleiste nach BSD-528 („Create a teamspace“ in 14 px), hell und dunkel, nur Chromium.
test("Fotos: Seitenleiste mit 14-px-Zeilen", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "nur für Fotos");
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const create = page.getByRole("button", { name: "Create a teamspace" });
    await expect(create).toHaveCSS("font-size", "14px");
    await page.screenshot({ path: `../../docs/design/screens/web-elements-v11-size-${theme}.png` });
  }
});
