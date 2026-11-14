import { expect, test as base, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-304: Tastatur- und Zugänglichkeits-Durchlauf. Auf jedem Screen per Tab durch alles Bedienbare: jedes fokussierte
// Element ist sichtbar, hat einen sichtbaren Fokusrahmen, einen Namen und eine Klickfläche von mindestens 24 × 24 px.
// Maßstab: docs/quality/checklist.md, Abschnitt 3 und 5. (axe-core für Kontrast und Rollen: offen, siehe Backlog.)

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-a11y-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

interface Stop { name: string; tag: string; problems: string[] }

/** Prüft das gerade fokussierte Element. */
async function inspect(page: Page): Promise<Stop | undefined> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return undefined;
    const problems: string[] = [];
    const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : undefined;
    const wrapLabel = el.closest("label")?.textContent;
    const name = (el.getAttribute("aria-label") || labelled || forLabel || wrapLabel || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? "" : el.textContent) || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    // Texteingabe: die Schreibmarke ist der Fokus (wie Notion); Rahmen und Fläche zählen am umgebenden Feld.
    const textEntry = el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "submit"].includes(el.type));
    if (!name && !el.isContentEditable) problems.push("ohne Namen");
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) problems.push("unsichtbar");
    else if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) problems.push("außerhalb des Fensters");
    /** Sichtbarer Rahmen am Element, an seinen Pseudo-Elementen oder an den zwei nächsten Vorfahren (Astryx-Zeilen). */
    const ringOn = (n: Element, pseudo?: string) => {
      const c = getComputedStyle(n, pseudo);
      if (pseudo && c.content === "none") return false;
      return (c.outlineStyle !== "none" && parseFloat(c.outlineWidth) > 0) || (c.boxShadow !== "none" && c.boxShadow !== "") || (pseudo !== undefined && (c.backgroundColor !== "rgba(0, 0, 0, 0)" || (c.borderTopStyle !== "none" && parseFloat(c.borderTopWidth) > 0)));
    };
    const ring = [el, el.parentElement, el.parentElement?.parentElement].some((n) => n && (ringOn(n) || ringOn(n, "::before") || ringOn(n, "::after")));
    if (!ring && !textEntry) problems.push("kein sichtbarer Fokusrahmen");
    // Klickfläche (WCAG 2.5.8, 24 × 24): das Element, sein Feld (Texteingabe), oder ein absolut gesetztes
    // Pseudo-Element, das die Fläche vergrößert (dann zählt sein Rahmen-Vorfahr). Text-Links im Fließtext und
    // Trenngriffe (role=separator, per Tastatur bedienbar) sind ausgenommen.
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
    let area = r;
    if (textEntry && el.parentElement) area = el.parentElement.getBoundingClientRect();
    for (const p of ["::before", "::after"]) {
      const ps = getComputedStyle(el, p);
      if (ps.content !== "none" && ps.position === "absolute") {
        const w = r.width - (parseFloat(ps.left) || 0) - (parseFloat(ps.right) || 0);
        const h = r.height - (parseFloat(ps.top) || 0) - (parseFloat(ps.bottom) || 0);
        if (ps.left !== "auto" && ps.top !== "auto") area = { ...area, width: Math.max(area.width, w), height: Math.max(area.height, h) } as DOMRect;
      }
    }
    const pressable = el.closest("[data-astryx-pressable]");
    if (pressable && pressable !== el) area = pressable.getBoundingClientRect(); // Astryx: die ganze Zeile nimmt den Klick
    if (!inline && !el.isContentEditable && el.getAttribute("role") !== "separator" && (area.width < 24 || area.height < 24)) {
      // WCAG-Abstandsausnahme: ein Kreis von 24 px um die Mitte überschneidet kein anderes Ziel.
      const cx = area.left + area.width / 2, cy = area.top + area.height / 2;
      const others = [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=menuitem], [tabindex]:not([tabindex='-1'])")]
        .filter((o) => o !== el && !o.contains(el) && !el.contains(o) && o.getClientRects().length > 0);
      const crowded = others.some((o) => {
        const q = o.getBoundingClientRect();
        const dx = Math.max(q.left - cx, 0, cx - q.right), dy = Math.max(q.top - cy, 0, cy - q.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      if (crowded) problems.push(`Klickfläche ${Math.round(area.width)}×${Math.round(area.height)} und zu nah am Nachbarn`);
    }
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => c && !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 2).join(".") : "";
    return { name: name.slice(0, 40), tag: `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`, problems };
  });
}

/** Tab durch den Screen, höchstens `max` Schritte oder bis der Fokus wieder am Anfang ist. */
async function walk(page: Page, screen: string, max = 60, within?: string): Promise<string[]> {
  const found: string[] = [];
  if (!within) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => undefined);
  }
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(140); // Fokus-Übergänge (--duration-fast) abwarten
    if (within && !(await page.evaluate((sel) => !!document.activeElement?.closest(sel), within))) {
      found.push(`${screen}: Fokus verlässt den Dialog`);
      break;
    }
    const s = await inspect(page);
    if (!s) continue;
    const key = `${s.tag}|${s.name}`;
    if (seen.has(key) && seen.size > 3) break;
    seen.add(key);
    for (const p of s.problems) found.push(`${screen}: ${s.tag} „${s.name}“ – ${p}`);
  }
  return [...new Set(found)];
}

test.describe.configure({ timeout: 180_000 });

test("Tab-Durchlauf: Namen, Fokusrahmen, Klickflächen auf allen Hauptscreens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pageID = (await command(page, { op: "createPage", title: "A11y page" })) as string;
  // Seite mit Überschriften, damit die Gliederung rechts erscheint
  await page.getByRole("treeitem", { name: "A11y page" }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.evaluate((md) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", md);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "# One\n\nText\n\n## Two\n\nText\n\n## Three\n\nText");
  await expect(page.getByTestId("page-outline")).toBeVisible();
  // Fund vom 11.11.: Gliederungs-Einträge waren 16 px hoch und standen 4 px auseinander
  for (const h of await page.locator(".bx-outline-item").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(24);
  await command(page, { op: "createDatabase", title: "A11y database" });
  await page.getByRole("treeitem", { name: "A11y database" }).click();
  await page.waitForTimeout(500);
  const db = await page.evaluate(() => location.hash);
  const found: string[] = [];
  for (const [name, hash] of [["Home", "#home"], ["Seite", "#page-" + pageID], ["Datenbank", db], ["Library", "#library"], ["Trash", "#trash"], ["Settings", "#prefs-my-settings"]] as const) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(500);
    found.push(...(await walk(page, name)));
  }
  // Quick Find
  await page.evaluate(() => { location.hash = "#home"; });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog").first()).toBeVisible();
  found.push(...(await walk(page, "Quick Find", 20, "[role=dialog]")));
  // Fund vom 11.11.: Filter im Quick Find waren 17 px hoch
  for (const h of await page.locator(".qf-filters").locator("button, label, input:not([type=hidden])").evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(24);
  console.log(found.join("\n"));
  expect(found).toEqual([]);
});

// Fotos der in BSD-304 geänderten Stellen (Gliederung 24 px, Quick Find, Tabelle mit Fokus), hell und dunkel in
// drei Größen: nur mit BASED_SCREENSHOTS=1 in Chromium.
test("Fotos: Gliederung, Quick Find, Tabelle mit Fokus", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur für Fotos");
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Outline" });
  await page.getByRole("treeitem", { name: "Outline" }).click();
  await focusEditorEnd(page);
  await page.evaluate((md) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", md);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "# One\n\nText\n\n## Two\n\nText\n\n## Three\n\nText");
  await command(page, { op: "createDatabase", title: "Table focus" });
  await page.waitForTimeout(600);
  const pageHash = await page.evaluate(() => location.hash);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((x) => { location.hash = x; }, pageHash);
      await page.waitForTimeout(500);
      await page.getByTestId("page-outline").hover().catch(() => undefined);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-a11y-outline-${theme}${suffix}.png` });
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-a11y-quickfind-${theme}${suffix}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("treeitem", { name: "Table focus" }).click();
      await page.locator(".dbui-table").first().focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-a11y-table-focus-${theme}${suffix}.png` });
    }
  }
});

// BSD-304 Teil 2: Fokus kehrt nach dem Schließen des Quick Find dorthin zurück, wo er vorher war.
test("Quick Find: Esc gibt den Fokus zurück", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Focus back" });
  const row = page.getByRole("treeitem", { name: "Focus back" });
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toHaveCount(0);
  await expect(row).toBeFocused();
});

// BSD-304 Teil 3: Export, „Move to“ (aus dem Seitenmenü) und die Icon-Auswahl geben beim Schließen mit Esc den Fokus
// an den Auslöser zurück – vorher landete er auf <body>.
test("Dialoge geben den Fokus zurück: Export, Move to, Icon-Auswahl", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  // Export
  const exportBtn = page.getByRole("button", { name: "Export" });
  await exportBtn.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /Export/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Export/ })).toHaveCount(0);
  await expect(exportBtn).toBeFocused();
  // Move to aus dem Seitenmenü → zurück an „…“
  const more = page.getByRole("button", { name: "Page menu" });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: /^Move to/ }).first().click();
  await expect(page.getByTestId("move-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("move-dialog")).toHaveCount(0);
  await expect(more).toBeFocused();
  // Icon-Auswahl
  await page.getByLabel("Page title").hover();
  const add = page.getByRole("button", { name: "Add icon" });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Choose an icon" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose an icon" })).toHaveCount(0);
  await expect(add).toBeFocused();
});
