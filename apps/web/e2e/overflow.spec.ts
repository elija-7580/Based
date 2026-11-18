import { expect, test as base, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { overflows, overlaps, primaryVisible } from "./layout-checks.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-301: Überlauf mit Extremdaten. Nirgendwo läuft Text aus seinem Kasten oder aus dem Fenster, gekürzter Text
// endet auf „…“, die Seite hat keinen waagrechten Rollbalken – leerer Workspace und Extrem-Workspace (Titel mit 150
// Zeichen, ein Wort mit 200 Zeichen, tiefe Verschachtelung, lange Namen), in 1280 × 820, 900 × 600 und 1728 × 1000.
// Maßstab: docs/quality/checklist.md, Abschnitt 2. Fotos mit BASED_SCREENSHOTS=1 (Chromium): web-overflow-*.png

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-overflow-"));
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

// BSD-309: dazu schmale Fenster (halbe Bildschirmbreite am MacBook, Mindestbreite der Desktop-App 640 px).
const VIEWPORTS = [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"], [720, 900, "-720"], [640, 800, "-640"]] as const;

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function go(page: Page, hash: string) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(400);
}

interface Screen { name: string; hash: string; /** CSS-Auswahl der wichtigsten Bedienung (BSD-301 Teil 4) */ primary?: string }

async function check(page: Page, screens: Screen[], shotPrefix: string, browserName: string) {
  const found: string[] = [];
  for (const [w, h, suffix] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    for (const s of screens) {
      await go(page, s.hash);
      await page.mouse.move(w / 2, h - 5);
      await page.waitForTimeout(200);
      for (const f of await overflows(page)) found.push(`${s.name} ${w}×${h}: ${f}`);
      for (const f of await overlaps(page)) found.push(`${s.name} ${w}×${h}: ${f}`);
      const p = s.primary ? await primaryVisible(page, s.primary) : undefined;
      if (p) found.push(`${s.name} ${w}×${h}: ${p}`);
      if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-overflow-${shotPrefix}-${s.name}-light${suffix}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  if (SHOTS && browserName === "chromium") {
    // Dunkel wie über Settings → Appearance (gespeichert, neu geladen); Überlauf hängt nicht am Thema, die Fotos schon.
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
    await page.reload();
    await ready(page);
    for (const s of screens) {
      await go(page, s.hash);
      await page.mouse.move(640, 815);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-overflow-${shotPrefix}-${s.name}-dark.png` });
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  }
  return found;
}

test.describe.configure({ timeout: 180_000 });

// BSD-301 Teil 4: wichtigste Bedienung je Screen – muss ohne Scrollen ganz im Fenster liegen.
const HOME_COMPOSER = ".home-dock .composer";
const LIBRARY_SEARCH = "[data-testid=library] input[type=search]";
const PAGE_TITLE = "[aria-label='Page title']";

test("Leerer Workspace: nichts läuft über", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const found = await check(page, [
    { name: "home", hash: "#home", primary: HOME_COMPOSER }, { name: "library", hash: "#library", primary: LIBRARY_SEARCH }, { name: "trash", hash: "#trash" },
    { name: "chat", hash: "#chat", primary: ".chat-composer" }, { name: "settings", hash: "#prefs-appearance" },
  ], "empty", browserName);
  expect(found).toEqual([]);
});

const LONG_TITLE = "A very long page title that keeps going on and on to test truncation in every place it appears, sidebar tabs breadcrumb";
const TITLE_150 = (LONG_TITLE + " and more words until one hundred fifty characters are reached").slice(0, 150);
const LONG_WORD = "Supercalifragilistic".repeat(10); // 200 Zeichen ohne Leerzeichen

test("Extrem-Workspace: lange Titel, langes Wort, tiefe Verschachtelung", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const long = (await command(page, { op: "createPage", title: TITLE_150 })) as string;
  let parent = long;
  for (let i = 1; i <= 10; i++) parent = (await command(page, { op: "createPage", title: `Level ${i} ${LONG_TITLE}`, parent })) as string;
  await page.getByRole("treeitem", { name: TITLE_150 }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type(`Word: ${LONG_WORD} end.`);
  await page.waitForTimeout(600);
  const found = await check(page, [
    { name: "page", hash: "#page-" + long, primary: PAGE_TITLE }, { name: "deep", hash: "#page-" + parent, primary: PAGE_TITLE },
    { name: "home", hash: "#home", primary: HOME_COMPOSER }, { name: "library", hash: "#library", primary: LIBRARY_SEARCH },
  ], "extreme", browserName);
  expect(found).toEqual([]);
});

// BSD-324: Die Gliederung rechts lag bei 900 px Breite (Seitenleiste offen) über dem Text. Jetzt blendet sie sich aus,
// wenn neben dem Text kein Platz ist, und ist im Startfenster sichtbar.
test("Gliederung überdeckt nie den Text", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await command(page, { op: "createPage", title: "Outline room" });
  await page.getByRole("treeitem", { name: "Outline room" }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.evaluate((md) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", md);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "# One\n\n" + "Long text line that fills the whole column of the page. ".repeat(6) + "\n\n## Two\n\nText");
  const outline = page.getByTestId("page-outline");
  await expect(outline).toBeVisible();
  const state = () => page.evaluate(() => {
    const o = document.querySelector<HTMLElement>("[data-testid=page-outline]")!;
    // Textspalte des Block-Editors: sein Rahmen ohne den Innenabstand für Griff und Rand
    const ed = document.querySelector<HTMLElement>("[data-testid=block-editor]")!;
    const box = ed.getBoundingClientRect();
    const text = { right: box.right - (parseFloat(getComputedStyle(ed).paddingRight) || 0) };
    const shown = getComputedStyle(o).visibility !== "hidden" && getComputedStyle(o).display !== "none";
    return { shown, clear: !shown || o.getBoundingClientRect().left >= text.right };
  });
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    // Unter Last kommt die Messung (ResizeObserver) einen Moment später: auf den Endzustand warten statt fester Zeit.
    await expect.poll(async () => (await state()).clear, { message: `Gliederung frei vom Text bei ${w}` }).toBe(true);
    if (w === 1280) await expect.poll(async () => (await state()).shown).toBe(true);
  }
});

// BSD-301 Teil 2: 30 Tabs mit langen Titeln und eine Datenbank mit langen Spaltennamen und vielen Zeilen.
test("30 Tabs und eine breite Datenbank: nichts läuft über", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const ids: string[] = [];
  for (let i = 1; i <= 30; i++) ids.push((await command(page, { op: "createPage", title: `Tab ${i} ${LONG_TITLE}` })) as string);
  await page.evaluate((list) => {
    const h = (globalThis as unknown as { __based: { history: { openTab: (r: unknown, o?: unknown) => string } } }).__based.history;
    for (const id of list) h.openTab({ name: "page", id }, { background: true });
  }, ids);
  const dbID = (await command(page, { op: "createDatabase", title: "Wide " + LONG_TITLE })) as string;
  const db = "#page-" + dbID;
  await go(page, db);
  await expect(page.locator(".dbui-table").first()).toBeVisible();
  const found = await check(page, [{ name: "tabs-db", hash: db, primary: ".dbui-toolbar" }, { name: "tabs-home", hash: "#home", primary: HOME_COMPOSER }], "tabs", browserName);
  expect(found).toEqual([]);
  // Die Tab-Leiste rollt waagrecht statt das Fenster zu verbreitern
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

// BSD-345: Kopfzeile bricht in 900 × 600 auf tiefen Seiten nicht in zwei Zeilen um; Breadcrumb und „Edited …“ kürzen,
// alle Knöpfe bleiben sichtbar in einer Zeile.
test("Kopfzeile bleibt in 900 × 600 einzeilig, auch 6 Ebenen tief mit langen Namen", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");
  await ready(page);
  let parent = (await command(page, { op: "createPage", title: `Root ${LONG_TITLE}` })) as string;
  for (let i = 1; i <= 6; i++) parent = (await command(page, { op: "createPage", title: `Level ${i} ${LONG_TITLE}`, parent })) as string;
  for (const hash of ["#page-" + parent, "#page-" + parent]) {
    await page.goto("/" + hash);
    await ready(page);
    const bar = page.locator("header.topbar").first();
    await expect(bar.getByLabel("Breadcrumb")).toBeVisible();
    const tops = await bar.evaluate((el) => [...el.children].filter((c) => (c as HTMLElement).offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
    expect(Math.max(...tops) - Math.min(...tops), "eine Zeile").toBeLessThanOrEqual(4);
    const box = (await bar.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(64);
    // nichts ragt rechts aus der Kopfzeile, Knöpfe vollständig sichtbar
    for (const name of ["Share", "Add to Favorites"]) {
      const b = (await bar.getByRole("button", { name }).first().boundingBox())!;
      expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // zweiter Durchlauf: ohne Seitenleiste (falls die Shell den Knopf zeigt)
    const hide = page.getByRole("button", { name: /Hide sidebar|Close sidebar/ }).first();
    if (await hide.isVisible()) await hide.click();
  }
});

// BSD-338: Werkzeugleiste der Inline-Datenbank bleibt in 900 × 600 und in einer schmalen Spalte einzeilig („Open as
// full page“ rutscht nicht allein in eine zweite Zeile); Filter/Sort zeigen dann nur ihr Icon.
test("Inline-Datenbank: Werkzeugleiste in 900 × 600 einzeilig", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  await db.hover();
  const bar = db.locator(".dbui-toolbar").first();
  const centers = await bar.evaluate((el) => [...el.querySelectorAll(".dbui-tab, .dbui-actions > *, .dbui-open-full")]
    .filter((c) => (c as HTMLElement).offsetParent !== null).map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  expect(centers.length).toBeGreaterThan(3);
  expect(Math.max(...centers) - Math.min(...centers), "eine Zeile").toBeLessThanOrEqual(4);
  const box = (await bar.boundingBox())!;
  const full = (await db.getByRole("button", { name: "Open as full page" }).boundingBox())!;
  expect(full.x + full.width).toBeLessThanOrEqual(box.x + box.width + 1);
  await expect(db.getByRole("button", { name: "Filter" })).toBeVisible();
});

// BSD-301 Teil 3: Datenbank mit 1.000 Zeilen, langen Spaltennamen und langen Optionen in drei Größen – nichts läuft
// aus seinem Kasten, nichts schneidet ohne „…“ ab, kein waagrechter Rollbalken der Seite.
test("Datenbank: 1.000 Zeilen, lange Spaltennamen und Optionen", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const blockID = (await command(page, { op: "seedDatabase", count: 1000 })) as string;
  await page.goto("/#page-" + blockID);
  await ready(page);
  await expect(page.getByRole("grid").first()).toBeVisible();
  await page.evaluate(async ({ id, long }) => {
    interface Tx { put(r: unknown): void; update(id: string, f: (b: { values?: Record<string, unknown> }) => void): void }
    interface Store { blocks: Map<string, { id: string; parent: string; props?: { databaseID?: string } }>; databases: Map<string, { id: string; properties: unknown[] }>; children(p: string): string[]; transact(n: string, f: (tx: Tx) => void): void }
    const b = (globalThis as unknown as { __based: { client: { openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const { store } = await b.client.openPage(id);
    const dbID = store.blocks.get(id)!.props!.databaseID!;
    const db = structuredClone(store.databases.get(dbID)!);
    const options = [{ id: "o1", name: long, color: "blue" }, { id: "o2", name: "Short", color: "green" }];
    db.properties.push({ id: "pl", name: `Status of the review process ${long}`, type: "select", options }, { id: "pt", name: `Notes ${long}`, type: "text" });
    const rows = store.children("d:" + dbID).slice(0, 40);
    store.transact("Long", (tx) => {
      tx.put({ kind: "database", data: db });
      rows.forEach((r, i) => tx.update(r, (x) => { x.values = { ...(x.values ?? {}), pl: { select: { _0: i % 2 ? "o1" : "o2" } }, pt: { text: { _0: i % 3 ? long : "x" } } }; }));
    });
  }, { id: blockID, long: LONG_TITLE });
  await expect(page.getByRole("columnheader", { name: /Status of the review/ })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: /^A very long page title/ }).first()).toBeVisible(); // Werte angekommen
  const found = await check(page, [{ name: "database-long", hash: "#page-" + blockID, primary: ".dbui-toolbar" }], "extreme", browserName);
  expect(found).toEqual([]);
});

// BSD-309: Schmales Fenster (halbe Bildschirmbreite am Mac, Mindestbreite 640 px): Die Seitenleiste klappt ein und
// schwebt auf „Show sidebar“ (oder ⌘\) über der Seite – Seitenbaum erreichbar, nach dem Öffnen einer Seite wieder zu;
// die gespeicherte Einstellung „ausgeblendet“ ändert sich dabei nicht. Kopf von Home und Seite bleiben einzeilig.
test("Schmales Fenster: Seitenleiste schwebt bei Bedarf, Köpfe einzeilig", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const id = (await command(page, { op: "createPage", title: "Narrow window page" })) as string;
  for (const [w, h] of [[720, 900], [640, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await go(page, "#home");
    await page.mouse.move(w / 2, h / 2); // nicht am linken Rand (dort schwebt die Leiste beim Überfahren herein)
    const sidebar = page.getByRole("navigation", { name: "Workspace" });
    await expect(sidebar).toBeHidden();
    // Home-Kopf in einer Zeile: alle Knöpfe auf derselben Höhe
    const tops = await page.locator(".home-head > *").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
    expect(Math.max(...tops) - Math.min(...tops), `Home-Kopf ${w}`).toBeLessThan(6);
    await expect(page.getByRole("button", { name: "New database" })).toBeVisible();
    // Show sidebar → schwebend mit Seitenbaum; Seite öffnen schließt sie
    await page.getByTestId("sidebar-show").click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveClass(/peek/);
    if (SHOTS && test.info().project.name === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-narrow-sidebar-light-${w}x${h}.png` });
    await sidebar.getByRole("treeitem", { name: "Narrow window page" }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Narrow window page");
    await page.mouse.move(w / 2, h / 2);
    await expect(sidebar).toBeHidden();
    // Kopfzeile der Seite einzeilig
    const head = page.locator("header.topbar").first();
    const box = (await head.boundingBox())!;
    expect(box.height, `Kopfzeile ${w}`).toBeLessThan(64);
    // ⌘\ öffnet und Escape schließt
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.move(w / 2, h / 2);
    await expect(sidebar).toBeHidden();
  }
  if (SHOTS && test.info().project.name === "chromium") {
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
    for (const [w, h] of [[720, 900], [640, 800]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await ready(page);
      await page.mouse.move(w / 2, h / 2);
      await page.getByTestId("sidebar-show").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-narrow-sidebar-dark-${w}x${h}.png` });
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
    await page.reload();
    await ready(page);
  }
  // Breit: Seitenleiste wieder fest, die Einstellung ist unverändert
  await page.setViewportSize({ width: 1280, height: 820 });
  await go(page, "#page-" + id);
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).not.toHaveClass(/peek/);
});
