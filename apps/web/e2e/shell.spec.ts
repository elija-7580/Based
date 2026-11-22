import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestOf, expectFaster } from "./perf.js";

// BSD-153: Shell auf echten Daten – Seiten anlegen/umbenennen/löschen/wiederherstellen, Verlauf, Quick Find,
// 5.000 Seiten in der Seitenleiste, Neuladen mit OPFS, Sync-Status.

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const based = (page: Page) => ({
  seed: (count: number) =>
    page.evaluate((n) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown> } } }).__based.client.command({ op: "seed", count: n }), count),
});

async function newTopLevelPage(page: Page, title: string) {
  const header = page.locator(".tree-header", { hasText: "Private" });
  await header.hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  const field = page.getByLabel("Page title");
  await expect(field).toHaveValue("");
  await field.fill(title);
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
}

test.beforeEach(async ({ page }) => fresh(page));

test("Seite anlegen, umbenennen, in den Papierkorb, wiederherstellen, endgültig löschen", { tag: "@smoke" }, async ({ page, browserName }) => {
  await newTopLevelPage(page, "Project notes");

  // Umbenennen in der Seitenleiste (Kontextmenü)
  await page.getByRole("treeitem", { name: "Project notes" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Page name").fill("Project plan");
  await page.getByLabel("Page name").press("Enter");
  await expect(page.getByRole("treeitem", { name: "Project plan" })).toBeVisible();
  await expect(page.getByLabel("Page title")).toHaveValue("Project plan");

  // Unterseite
  const row = page.getByRole("treeitem", { name: "Project plan" });
  await row.hover();
  await page.getByRole("button", { name: "Add a page inside Project plan" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("");
  await page.getByLabel("Page title").fill("Milestones");
  await expect(page.getByRole("treeitem", { name: "Milestones" })).toHaveAttribute("aria-level", "2");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Project plan");

  // Papierkorb
  await page.getByRole("treeitem", { name: "Project plan" }).click();
  { await page.getByRole("button", { name: "Page menu" }).click(); await page.getByRole("menuitem", { name: "Move to Trash" }).click(); }
  await expect(page.getByRole("treeitem", { name: "Project plan" })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "Milestones" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Trash/ }).click();
  const entry = page.getByRole("listitem", { name: "Project plan" });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("treeitem", { name: "Project plan" })).toBeVisible();
  await expect(page.getByText("The Trash is empty.")).toBeVisible();

  // endgültig löschen
  await page.getByRole("treeitem", { name: "Project plan" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await page.getByRole("button", { name: /^Trash/ }).click();
  // BSD-505: ein Klick fragt in der Zeile nach; Cancel und Esc lassen die Seite im Papierkorb
  const trashRow = page.getByRole("listitem", { name: "Project plan" });
  await trashRow.getByRole("button", { name: "Delete forever" }).click();
  await expect(trashRow).toBeVisible();
  await expect(trashRow.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await expect(trashRow.getByRole("button", { name: "Delete “Project plan” forever" })).toBeFocused();
  await trashRow.getByRole("button", { name: "Cancel" }).click();
  await expect(trashRow.getByRole("button", { name: "Restore" })).toBeVisible();
  await trashRow.getByRole("button", { name: "Delete forever" }).click();
  await page.keyboard.press("Escape");
  await expect(trashRow.getByRole("button", { name: "Restore" })).toBeVisible();
  await trashRow.getByRole("button", { name: "Delete forever" }).click();
  if (browserName === "chromium") {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "../../docs/design/screens/trash-delete-forever-ask-light.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForTimeout(400);
    await page.screenshot({ path: "../../docs/design/screens/trash-delete-forever-ask-dark.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
  }
  await trashRow.getByRole("button", { name: "Delete “Project plan” forever" }).click();
  await expect(page.getByText("The Trash is empty.")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Project plan" })).toHaveCount(0);
});

test("Vor und zurück; Favoriten; Ziehen sortiert um", { tag: "@smoke" }, async ({ page }) => {
  await newTopLevelPage(page, "Alpha");
  await newTopLevelPage(page, "Beta");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Beta");

  await page.getByRole("button", { name: "Add to Favorites" }).click();
  await expect(page.locator(".tree-header", { hasText: "Favorites" })).toBeVisible();

  const names = () => page.locator('[role="treeitem"][aria-level="1"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await expect.poll(names).toEqual(["Beta", "Welcome to Based", "Alpha", "Beta"]);
  const rows = page.locator(".tree-row").filter({ hasText: "Alpha" });
  await rows.last().dragTo(page.locator(".tree-row").filter({ hasText: "Welcome to Based" }), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(names).toEqual(["Beta", "Alpha", "Welcome to Based", "Beta"]);
});

// BSD-322 Nachtrag: Der Drop entscheidet die Zone aus seiner eigenen Position. Vorher galt der Zustand des letzten
// dragover; kam der Drop vor dem Neuzeichnen an (Last in der CI, WebKit), landete die Seite „inside“ statt davor.
test("Drop ohne vorheriges dragover auf dieselbe Zeile: Zone aus der Drop-Position", async ({ page }) => {
  await newTopLevelPage(page, "Alpha");
  const names = () => page.locator('[role="treeitem"][aria-level="1"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await expect.poll(names).toEqual(["Welcome to Based", "Alpha"]);
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(".tree-row").filter({ hasText: "Alpha" }).dispatchEvent("dragstart", { dataTransfer: dt });
  const target = page.locator(".tree-row").filter({ hasText: "Welcome to Based" });
  const box = (await target.boundingBox())!;
  await target.dispatchEvent("drop", { dataTransfer: dt, clientX: box.x + 40, clientY: box.y + 2 });
  await expect.poll(names).toEqual(["Alpha", "Welcome to Based"]);
});

// Feedback 20. 11. („muss ein paar Mal draufdrücken“): WebKit macht aus einem Klick mit ein paar Pixeln Zittern eine
// native Ziehbewegung auf die Stelle selbst – der Klick ging verloren. Jetzt zählt das als Klick (shell/clickSlop.ts).
test("Klick mit leichtem Zittern öffnet die Seite und die Suche", async ({ page }) => {
  await newTopLevelPage(page, "Alpha");
  await newTopLevelPage(page, "Beta");
  const wobble = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 5, y + 1, { steps: 3 });
    await page.mouse.up();
  };
  const row = (await page.getByRole("treeitem", { name: "Alpha" }).boundingBox())!;
  await wobble(row.x + 60, row.y + row.height / 2);
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  const names = () => page.locator('[role="treeitem"][aria-level="1"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await expect.poll(names).toEqual(["Welcome to Based", "Alpha", "Beta"]);
  const search = (await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Search" }).boundingBox())!;
  await wobble(search.x + 30, search.y + search.height / 2);
  await expect(page.getByLabel("Search pages")).toBeVisible();
});

test("Quick Find über 5.000 Seiten antwortet in < 50 ms", { tag: "@perf" }, async ({ page }, info) => {
  await based(page).seed(5000);
  await expect(page.getByRole("treeitem", { name: "Page 0001" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: "Search pages" });
  await expect(box).toBeFocused();
  const list = page.getByRole("listbox", { name: "Results" });
  const run = async () => {
    const t: number[] = [];
    for (const [q, first] of [["Page 4321", "Page 4321"], ["page 0815", "Page 0815"], ["topic 2500", "Page 2500"], ["welcome", "Welcome to Based"], ["Page 5000", "Page 5000"]] as const) {
      await box.fill(q);
      await expect(list.getByRole("option").first()).toContainText(first);
      t.push(Number(await list.getAttribute("data-took")));
    }
    return t.sort((a, b) => a - b);
  };
  // BSD-450: bester von höchstens 3 Durchgängen (ein rechnender Nachbar kostet nur manchmal Zeit)
  const took = await bestOf(3, run, (t) => t[2]! >= 50 || t[4]! >= 100, (a, b) => a[4]! + a[2]! < b[4]! + b[2]!);
  info.annotations.push({ type: "quick-find-ms", description: `median ${took[2]!.toFixed(1)} · max ${took[4]!.toFixed(1)} · ${took.join(", ")}` });
  console.log(`[${info.project.name}] Quick Find (Hin und zurück zum Worker, ms):`, took.join(", "));
  // BSD-450: Zeiten lokal hart, in der CI Warnung
  expectFaster(info, "Quick Find Median", took[2]!, 50);
  expectFaster(info, "Quick Find Max", took[4]!, 100);
  await box.press("Enter");
  await expect(page.getByLabel("Page title")).toHaveValue("Page 5000");
  await expect(page.getByRole("dialog", { name: "Quick Find" })).toHaveCount(0);
});

test("5.000 Seiten in der Seitenleiste scrollen ohne Ruckeln", { tag: "@perf" }, async ({ page }, info) => {
  await based(page).seed(5000);
  await expect(page.getByRole("treeitem", { name: "Page 0001" })).toBeVisible();
  const measure = () => page.evaluate(async () => {
    const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
    tree.scrollTop = 0;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const frames: number[] = [];
    let maxRows = 0;
    let last = performance.now();
    const step = tree.scrollHeight / 180; // ganz nach unten in ~3 s bei 60 fps
    await new Promise<void>((done) => {
      const tick = (t: number) => {
        frames.push(t - last);
        last = t;
        maxRows = Math.max(maxRows, tree.querySelectorAll("[data-row]").length);
        tree.scrollTop += step;
        if (tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 1) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    frames.shift();
    frames.sort((a, b) => a - b);
    const p = (q: number) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]!;
    return { count: frames.length, p50: p(0.5), p95: p(0.95), max: frames[frames.length - 1]!, maxRows, total: tree.scrollHeight };
  });
  // Die Tests laufen zu mehreren nebeneinander: ein Nachbar, der gerade rechnet, kostet Frames. Eine echte
  // Verschlechterung ist bei jedem Durchgang langsam, also zählt der beste von höchstens drei.
  const r = await bestOf(3, measure, (x) => x.p95 >= 34, (a, b) => a.p95 < b.p95);
  info.annotations.push({ type: "sidebar-scroll", description: JSON.stringify(r) });
  console.log(`[${info.project.name}] Seitenleiste 5.000 Seiten:`, JSON.stringify(r));
  expect(r.maxRows).toBeLessThanOrEqual(80);
  // BSD-450: Zeit lokal hart, in der CI Warnung (unter Last ~20 auch beim besten von 3 über der Schwelle)
  expectFaster(info, "Seitenleiste scrollen p95", r.p95, 34);
  await expect(page.getByRole("treeitem", { name: "Page 5000" })).toBeVisible();
});

test("Neuladen behält Daten (OPFS)", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
  // WebKit hat OPFS nur in einem dauerhaften Profil, deshalb für beide Browser ein eigenes Profil.
  const dir = mkdtempSync(join(tmpdir(), "based-opfs-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    await newTopLevelPage(page, "Kept after reload");
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Trash" }).click();
    await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveCount(0);
    // BSD-335: erst neu laden, wenn der Store-Tab jede Anfrage beantwortet hat (= in OPFS geschrieben). Ohne das lag
    // „Move to Trash“ unter Last (WebKit, 1 von 20) noch in der Warteschlange des Workers und ging beim Neuladen mit
    // ihm verloren – der Test prüft den Datenerhalt geschriebener Änderungen, nicht ein Neuladen mitten im Befehl.
    await page.evaluate(() => (globalThis as unknown as { __based: { client: { settled(): Promise<void> } } }).__based.client.settled());
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByRole("treeitem", { name: "Kept after reload" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Trash/ })).toContainText("1");
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Sync-Server in den Einstellungen: Status in der Seitenleiste", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill("http://127.0.0.1:9");
  await page.getByLabel("Token").fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveText(/Offline|Sync error/);
  await page.reload();
  await expect(page.getByLabel("Server URL")).toHaveValue("http://127.0.0.1:9");
  await expect(page.getByTestId("sync-status")).toHaveText(/Offline|Sync error/);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText(/On this device|Not saved/);
});

// BSD-619 (Elija 20.11.): Nach „Move to Trash“ der Hinweis „Moved to Trash · Undo“ (4 s); Undo holt die Seite zurück
// und öffnet sie wieder. ⌘Z außerhalb eines Textfelds tut dasselbe – auch nachdem der Hinweis gegangen ist. Im Text
// einer Seite bleibt ⌘Z das Undo des Editors.
test("Move to Trash: Hinweis mit Undo, ⌘Z holt die Seite zurück", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await newTopLevelPage(page, "Keep me please");
  const toast = page.getByTestId("trash-toast");
  const tree = page.getByRole("treeitem", { name: "Keep me please" });
  { await page.getByRole("button", { name: "Page menu" }).click(); await page.getByRole("menuitem", { name: "Move to Trash" }).click(); }
  await expect(tree).toHaveCount(0);
  await expect(toast).toContainText("Moved to Trash");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(tree).toHaveCount(1);
  await expect(page.getByLabel("Page title")).toHaveValue("Keep me please");
  await expect(toast).toHaveCount(0);

  // ⌘Z, nachdem der Hinweis von selbst gegangen ist
  { await page.getByRole("button", { name: "Page menu" }).click(); await page.getByRole("menuitem", { name: "Move to Trash" }).click(); }
  await expect(tree).toHaveCount(0);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 6000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tree).toHaveCount(1);
  await expect(page.getByLabel("Page title")).toHaveValue("Keep me please");
  // noch einmal ⌘Z: nichts mehr zurückzuholen, nichts passiert
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tree).toHaveCount(1);

  // im Text der Seite gehört ⌘Z dem Editor (die gelöschte Seite bleibt im Papierkorb)
  await newTopLevelPage(page, "Second page");
  { await page.getByRole("button", { name: "Page menu" }).click(); await page.getByRole("menuitem", { name: "Move to Trash" }).click(); }
  await expect(page.getByRole("treeitem", { name: "Second page" })).toHaveCount(0);
  await page.getByRole("treeitem", { name: "Keep me please" }).click();
  await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
  await page.keyboard.type("typed");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("treeitem", { name: "Second page" })).toHaveCount(0);
});
