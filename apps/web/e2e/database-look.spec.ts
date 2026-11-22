import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Entscheidungen 14. 11. (Datenbank-Ansichten im Notion-Aufbau): inline ohne einzelnen „Table“-Tab, Werkzeuge gedimmt,
// Daten nicht in Monospace, Fußzeile ohne Linie; „Section“ = Toggle-Überschrift mit Fläche, die eine Datenbank aufnimmt.
// Fotos (hell/dunkel, 1280 × 820) mit BASED_SCREENSHOTS=1 in Chromium.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-dblook-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

test("Section mit Inline-Datenbank: Fläche, kein Einzel-Tab, Daten in UI-Schrift", async ({ page, browserName }) => {
  await page.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "EcoCoat" });
  });
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await expect(editor).toBeVisible();
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.type("/section");
  await expect(page.getByTestId("slash-menu").getByRole("option").first()).toContainText("Section");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Projects");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  const db = page.locator(".dbui-root.inline").first();
  await expect(db.locator(".dbui-table .dbui-cell.title").first()).toBeVisible();
  // Abschnitt als Fläche, Datenbank liegt darin
  const section = page.locator(".bx2-block.bx2-section").first();
  await expect(section).toBeVisible();
  await expect(section.locator(".dbui-root.inline")).toHaveCount(1);
  expect(await section.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  // eine Ansicht → kein Tab; Kopf- und Fußzeile ohne eigene Fläche
  await expect(db.locator(".dbui-tab")).toHaveCount(0);
  expect(await db.locator(".dbui-thead").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await db.locator(".dbui-tfoot").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.locator(".dbui-root.inline .dbui-table").first()).toBeVisible();
      await page.locator(".bx2-section").first().hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-section-1280x820-${theme}.png` });
    }
  }
});

test("Daten in UI-Schrift, IDs in Monospace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const mono = await page.evaluate(() => {
    const probe = (cls: string) => { const s = document.createElement("span"); s.className = cls; document.querySelector(".app, #root, body")!.appendChild(s); const f = getComputedStyle(s).fontFamily; s.remove(); return f; };
    return { data: probe("dbui-data"), id: probe("dbui-data dbui-id") };
  });
  expect(mono.data).not.toMatch(/mono|Menlo|Consolas/i);
  expect(mono.id).toMatch(/mono|Menlo|Consolas/i);
});

test("Ansichts-Tab: Klick auf den aktiven Tab öffnet das Menü – umbenennen, duplizieren, löschen", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate((cmd) => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<unknown> } } }).__based.client.command(cmd), { op: "createDatabase", title: "Views" });
  await page.getByRole("treeitem", { name: "Views" }).click();
  const tabs = page.getByRole("tablist", { name: "Views" }).getByRole("tab");
  await expect(tabs).toHaveCount(1);
  await tabs.first().click();
  const menu = page.getByRole("menu", { name: /^View / });
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("view-menu-delete")).toBeDisabled();
  await menu.getByLabel("View name").fill("Alle");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Alle" })).toBeVisible();
  // Rechtsklick → Duplizieren: neue Ansicht wird gewählt
  await page.getByRole("tab", { name: "Alle" }).click({ button: "right" });
  await page.getByTestId("view-menu-duplicate").click();
  await expect(tabs).toHaveCount(2);
  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(tabs).toHaveCount(2);
      await tabs.nth(1).click({ button: "right" });
      await expect(menu).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `../../docs/design/screens/web-db-view-menu-1280x820-${theme}.png` });
      await page.keyboard.press("Escape");
    }
  }
  await tabs.nth(1).click({ button: "right" });
  await page.getByTestId("view-menu-delete").click();
  await expect(tabs).toHaveCount(1);
  // „Edit view“ öffnet die Ansichts-Einstellungen
  await tabs.first().click();
  await page.getByTestId("view-menu-edit").click();
  await expect(page.getByRole("dialog", { name: "View settings" })).toBeVisible();
});

// 22. 11. 2026 (Elija): die Tabelle sieht aus wie auf basednotes.app – nur waagrechte Linien über die ganze Breite,
// Spaltenkopf leise ohne Typ-Icon, Status als Tag ohne Punkt, kurzes Datum, aktive Ansicht in Tinte, „New“ neutral.
// Fotos (hell/dunkel, drei Größen) mit BASED_SCREENSHOTS=1 in Chromium.
test("Tabelle wie auf der Website: Linien, Breite, Kopf, Status, Datum, Ansichts-Pille", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "addStarterTemplate", template: "tasks" }));
  await page.goto(`/#page-${id}`);
  const db = page.locator(".shell-database.full");
  await db.getByRole("tab", { name: "All tasks" }).click();
  const table = db.locator(".dbui-table");
  await expect(table.locator(".dbui-vrow[data-row-id]")).toHaveCount(4);

  // keine senkrechten Linien, kein Typ-Icon im Kopf, Kopf in `muted`
  const look = await table.evaluate((el) => {
    const css = (sel: string, prop: string) => [...el.querySelectorAll(sel)].map((n) => getComputedStyle(n).getPropertyValue(prop));
    const probe = document.createElement("span");
    probe.style.color = "var(--muted)";
    el.appendChild(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return { cell: css(".dbui-cell", "border-right-width"), th: css(".dbui-th", "border-right-width"), icons: el.querySelectorAll(".dbui-th-btn svg").length, head: css(".dbui-th-btn", "color"), muted };
  });
  expect(new Set([...look.cell, ...look.th])).toEqual(new Set(["0px"]));
  expect(look.icons).toBe(0);
  expect(new Set(look.head)).toEqual(new Set([look.muted]));

  // die Linien reichen bis zur rechten Kante der Werkzeugleiste, die Spalten sind über die Standardbreite gewachsen
  const edges = await db.evaluate((el) => {
    const r = (s: string) => el.querySelector(s)!.getBoundingClientRect();
    return { toolbar: r(".dbui-toolbar").right, head: r(".dbui-thead").right, title: r(".dbui-th").width, scroll: el.querySelector(".dbui-scroll")!.scrollWidth - el.querySelector(".dbui-scroll")!.clientWidth };
  });
  expect(Math.abs(edges.head - edges.toolbar)).toBeLessThanOrEqual(1);
  expect(edges.title).toBeGreaterThan(280);
  expect(edges.scroll).toBe(0);

  // Status ohne Punkt und eckig wie jedes Tag; Datum kurz
  const status = table.locator(".dbui-pill.status").first();
  await expect(status).toBeVisible();
  await expect(status.locator(".dbui-dot")).toHaveCount(0);
  expect(await status.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(await table.locator(".dbui-pill:not(.status)").first().evaluate((el) => getComputedStyle(el).borderRadius));
  const dates = (await table.locator(".dbui-cell .dbui-data").allTextContents()).filter(Boolean);
  expect(dates.length).toBeGreaterThan(0);
  for (const d of dates) expect(d).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);

  // aktive Ansicht in Tinte, „New“ neutral
  const colorsNow = () => db.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = "background: var(--button); color: var(--surface-raised)";
    el.appendChild(probe);
    const out = { ink: getComputedStyle(probe).backgroundColor, raised: getComputedStyle(probe).color,
      tab: getComputedStyle(el.querySelector('.dbui-tab[aria-selected="true"]')!).backgroundColor, fresh: getComputedStyle(el.querySelector(".dbui-chip.primary")!).backgroundColor };
    probe.remove();
    return out;
  });
  // (der Wechsel der Fläche läuft 120 ms – deshalb warten, bis er steht)
  await expect.poll(async () => { const c = await colorsNow(); return c.tab === c.ink && c.fresh === c.raised; }).toBe(true);

  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await db.getByRole("tab", { name: "All tasks" }).click();
      await expect(table.locator(".dbui-vrow[data-row-id]")).toHaveCount(4);
      await page.mouse.move(4, 4);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-db-table-website-${w}x${h}-${theme}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }

  // eine Spalte ziehen legt alle gezeigten Breiten fest: die anderen springen nicht auf die Standardbreite zurück
  const widths = () => table.locator(".dbui-th").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  const before = await widths();
  const handle = table.getByRole("separator", { name: "Resize Name" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(widths).toEqual([before[0]! - 60, ...before.slice(1)]);
  // … und bleiben nach dem Neuladen so
  await page.reload();
  await db.getByRole("tab", { name: "All tasks" }).click();
  await expect.poll(widths).toEqual([before[0]! - 60, ...before.slice(1)]);
});

// 22. 11. 2026 (Elija): auch die anderen Ansichten sehen aus wie auf basednotes.app – alle auf der Kante von Titel und
// Pillen, Board-Spalten teilen sich die Breite, Balken in der Farbe des Status, keine leeren Flächen.
test("Board, Timeline, Kalender, Liste, Galerie: eine Kante, volle Breite, Statusfarben, nichts Leeres", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    interface Tx { put(r: unknown): void; remove(k: string): void }
    interface Store {
      blocks: Map<string, { id: string; props?: { databaseID?: string } }>; databases: Map<string, Record<string, unknown>>;
      views: Map<string, { id: string; blockID: string }>; children(parent: string): string[]; transact(name: string, f: (tx: Tx) => void): void;
    }
    const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string>; openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const blockID = await b.client.command({ op: "createDatabase", title: "Projects" });
    const { store } = await b.client.openPage(blockID);
    const block = store.blocks.get(blockID)!;
    const dbID = block.props!.databaseID!;
    const db = store.databases.get(dbID)!;
    const now = (Date.now() - 978_307_200_000) / 1000;
    const T = new Date();
    const span = (off: number, len: number) => ({ start: (new Date(T.getFullYear(), T.getMonth(), T.getDate() + off).getTime() - 978_307_200_000) / 1000, end: (new Date(T.getFullYear(), T.getMonth(), T.getDate() + off + len).getTime() - 978_307_200_000) / 1000, includeTime: false });
    const properties = [{ id: "title", name: "Name", type: "title" },
      { id: "st", name: "Status", type: "status", options: [{ id: "rd", name: "Ready", color: "blue" }, { id: "ip", name: "In progress", color: "yellow" }, { id: "rv", name: "Review", color: "pink" }, { id: "lt", name: "Later", color: "gray" }] },
      { id: "du", name: "Due", type: "date" }];
    const rows: [string, string, number, number][] = [["Website relaunch", "ip", -3, 6], ["Q4 investor update", "rv", -5, 4], ["Acme onboarding", "rd", 1, 5], ["Thesis chapter 2", "ip", -2, 7], ["Offsite planning", "lt", -6, 3], ["Polar Studio proposal", "rv", 0, 3]];
    const views: [string, string, string, Record<string, unknown>][] = [["v1", "Board", "board", { groupBy: { propertyID: "st" } }], ["v2", "Timeline", "timeline", { datePropertyID: "du" }], ["v3", "Calendar", "calendar", { datePropertyID: "du" }], ["v4", "List", "list", {}], ["v5", "Gallery", "gallery", {}]];
    store.transact("Seed", (tx) => {
      for (const r of [...store.children("d:" + dbID)]) tx.remove("block:" + r);
      for (const v of [...store.views.values()]) if (v.blockID === blockID) tx.remove("view:" + v.id);
      tx.put({ kind: "database", data: { ...db, properties } });
      views.forEach((v, i) => tx.put({ kind: "view", data: { id: v[0], databaseID: dbID, blockID, name: v[1], type: v[2], sortKey: "a" + i, createdAt: now, updatedAt: now, stamp: db.stamp, ...v[3] } }));
      tx.put({ kind: "block", data: { ...block, props: { ...block.props, viewIDs: views.map((v) => v[0]) } } });
      rows.forEach((r, i) => tx.put({ kind: "block", data: { id: crypto.randomUUID(), type: "page", parent: "d:" + dbID, sk: "c00" + i, text: r[0], values: { st: { status: { _0: r[1] } }, du: { date: { _0: span(r[2], r[3]) } } }, createdAt: now, updatedAt: now } }));
    });
    return blockID;
  });
  await page.goto(`/#page-${id}`);
  const db = page.locator(".shell-database.full");
  // ein Klick auf die schon aktive Ansicht öffnet ihr Menü, deshalb nur wechseln
  const show = async (name: string) => { const tab = db.getByRole("tab", { name }); if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click(); await expect(db.locator(".dbui-body")).toHaveAttribute("data-view-type", name.toLowerCase()); };
  // linke und rechte Kante eines Elements gegen Kopf und Werkzeuge der Datenbank
  const edges = (sel: string) => db.evaluate((el, s) => {
    const t = el.querySelector(".dbui-actions")!.getBoundingClientRect(), title = el.querySelector(".dbui-head")!.getBoundingClientRect(), r = el.querySelector(s)!.getBoundingClientRect();
    return { left: Math.round(r.left - title.left), right: Math.round(t.right - r.right) };
  }, sel);

  // Board: an der Kante, Spalten breiter als die Grundbreite, leere Spalte „No Status“ fehlt, Kopf-Knöpfe erst beim Überfahren
  await show("Board");
  const cols = db.locator(".dbui-board-col");
  await expect(cols).toHaveCount(4);
  await expect(db.getByRole("region", { name: "No Status" })).toHaveCount(0);
  expect((await edges(".dbui-board-col")).left).toBe(0);
  expect(await db.evaluate((el) => { const b = el.querySelector(".dbui-board")!; return b.scrollWidth - b.clientWidth; })).toBe(0);
  expect((await edges(".dbui-board-col:last-of-type")).right).toBe(0);
  const hide = cols.first().getByRole("button", { name: /^Hide / });
  await page.mouse.move(4, 4);
  await expect.poll(() => hide.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await cols.first().hover();
  await expect.poll(() => hide.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  // Timeline: an der Kante, leere „No date“-Spalte zu, Balken in der Farbe des Status (neutral bleibt grau)
  await show("Timeline");
  await expect(db.getByRole("complementary", { name: "No date" })).toHaveCount(0);
  expect(await edges(".dbui-tl-scroll")).toEqual({ left: 0, right: 0 });
  const bar = (name: string) => db.locator(".dbui-tl-bar", { hasText: name });
  await expect(bar("Acme onboarding")).toHaveClass(/tone-blue/);
  await expect(bar("Offsite planning")).not.toHaveClass(/tone-/);
  expect(await bar("Acme onboarding").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await bar("Offsite planning").evaluate((el) => getComputedStyle(el).backgroundColor));
  await db.getByRole("button", { name: "No date (0)" }).click();
  await expect(db.getByRole("complementary", { name: "No date" })).toBeVisible();

  // Kalender, Liste, Galerie: an der Kante; Galerie ohne leere graue Fläche
  await show("Calendar");
  expect(await edges(".dbui-cal-scroll")).toEqual({ left: 0, right: 0 });
  await expect(db.locator(".dbui-cal-entry[class*='tone-']").first()).toBeVisible();
  await show("List");
  expect(await edges(".dbui-list-row")).toEqual({ left: -12, right: 0 }); // Fläche hängt heraus, das Icon steht auf der Kante
  expect((await edges(".dbui-list-icon")).left).toBe(0);
  await show("Gallery");
  expect(await edges(".dbui-vlist")).toEqual({ left: 0, right: 0 });
  await expect(db.locator(".dbui-card.gallery")).toHaveCount(6);
  await expect(db.locator(".dbui-cover")).toHaveCount(0);

  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const [w, h, themes] of [[1280, 820, ["light", "dark"]], [900, 600, ["light"]], [1728, 1000, ["light"]]] as const) for (const theme of themes) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      for (const v of ["Board", "Timeline", "Calendar", "List", "Gallery"]) {
        await show(v);
        await page.mouse.move(4, 4);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `../../docs/design/screens/web-db-${v.toLowerCase()}-website-${w}x${h}-${theme}.png` });
      }
    }
  }
});

// 22. 11. 2026 (wie basednotes.app): der Seitenkopf zeigt nur, was man ständig braucht. Export und Papierkorb stehen im
// •••-Menü, „Edited …“ steht einmal (oben rechts), nicht noch einmal unter dem Titel.
test("Seitenkopf ruhig: Export und Papierkorb nur im Menü, „Edited“ nur einmal", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  const top = page.locator(".topbar");
  await expect(top.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(top.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await expect(page.locator(".meta-line")).toContainText("Created");
  await expect(page.locator(".meta-line")).not.toContainText("Edited");
  await expect(page.getByTestId("page-edited")).toBeVisible();
  await top.getByRole("button", { name: "Page menu" }).click();
  const menu = page.getByRole("menu", { name: "Page menu" });
  await expect(menu.getByRole("menuitem", { name: "Export…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
  await page.keyboard.press("Escape");

  if (process.env.BASED_SCREENSHOTS === "1" && browserName === "chromium") {
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await page.mouse.move(4, 4);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-page-head-website-${w}x${h}-${theme}.png` });
    }
  }
});
