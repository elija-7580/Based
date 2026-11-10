import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Datenbank-Ansichten in der Shell: Zeile als Peek (Side/Center/Full, Blättern, Esc, Neuladen), Formular,
// Karte (offline), Datumsfilter auf Zeiträumen; dazu Screenshots (hell/dunkel) und 5.000 Zeilen.

const SHOTS = "../../docs/design/screens/";
const SWIFT_EPOCH_MS = 978_307_200_000;
/** Lokale Wandzeit im Browser → Swift-Sekunden (wie die App rechnet). */
const swift = (page: Page, y: number, m: number, d: number, h = 0, min = 0) =>
  page.evaluate(([yy, mm, dd, hh, mi, epoch]) => (new Date(yy!, mm! - 1, dd!, hh!, mi!).getTime() - epoch!) / 1000, [y, m, d, h, min, SWIFT_EPOCH_MS]);

interface SeedView { id: string; name: string; type: string; extra?: Record<string, unknown> }
interface SeedSpec {
  title: string;
  properties: Record<string, unknown>[];
  rows: { id?: string; title: string; values?: Record<string, unknown> }[];
  views: SeedView[];
  /** Zusätzlich so viele einfache Zeilen (für Lasttests). */
  bulk?: number;
}

/** Datenbank über die Seiten-Replik anlegen (wie es Editor und Ansichten tun) und öffnen. */
async function seedDatabase(page: Page, spec: SeedSpec): Promise<string> {
  const blockID = await page.evaluate(async (s: SeedSpec) => {
    interface Tx { put(r: unknown): void; remove(k: string): void }
    interface Store {
      blocks: Map<string, { id: string; props?: { databaseID?: string; viewIDs?: string[] } }>;
      databases: Map<string, Record<string, unknown>>;
      views: Map<string, { id: string; blockID: string }>;
      children(parent: string): string[];
      transact(name: string, f: (tx: Tx) => void): void;
    }
    const b = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string>; openPage(id: string): Promise<{ store: Store }> } } }).__based;
    const blockID = await b.client.command({ op: "createDatabase", title: s.title });
    const { store } = await b.client.openPage(blockID);
    const block = store.blocks.get(blockID)!;
    const dbID = block.props!.databaseID!;
    const db = store.databases.get(dbID)!;
    const now = (Date.now() - 978_307_200_000) / 1000;
    const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const sk = (i: number) => "c" + D[Math.floor(i / 3844) % 62] + D[Math.floor(i / 62) % 62] + D[i % 62];
    store.transact("Seed", (tx) => {
      for (const id of [...store.children("d:" + dbID)]) tx.remove("block:" + id);
      for (const v of [...store.views.values()]) if (v.blockID === blockID) tx.remove("view:" + v.id);
      tx.put({ kind: "database", data: { ...db, properties: s.properties } });
      s.views.forEach((v, i) => tx.put({ kind: "view", data: { id: v.id, databaseID: dbID, blockID, name: v.name, type: v.type, sortKey: "a" + i, createdAt: now, updatedAt: now, stamp: db.stamp, ...(v.extra ?? {}) } }));
      tx.put({ kind: "block", data: { ...block, props: { ...block.props, viewIDs: s.views.map((v) => v.id) } } });
      const rows = [...s.rows];
      for (let i = 0; i < (s.bulk ?? 0); i++) rows.push({ title: "Row " + String(i + 1).padStart(4, "0"), values: s.rows[i % Math.max(1, s.rows.length)]?.values ?? {} });
      rows.forEach((r, i) => tx.put({ kind: "block", data: { id: r.id ?? crypto.randomUUID(), type: "page", parent: "d:" + dbID, sk: sk(i), text: r.title, values: r.values ?? {}, createdAt: now, updatedAt: now } }));
    });
    return blockID;
  }, spec);
  await page.evaluate((id) => (globalThis as unknown as { __based: { history: { navigate(r: unknown): void } } }).__based.history.navigate({ name: "page", id }), blockID);
  await expect(page.getByLabel("Page title")).toHaveValue(spec.title);
  await expect(page.getByTestId("database-view")).toBeVisible();
  return blockID;
}

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
}

async function shots(page: Page, name: string) {
  // Nur Chromium schreibt die Bilder (WebKit malt Top-Layer-Flächen im Screenshot unzuverlässig).
  if (test.info().project.name !== "chromium") return;
  await page.waitForTimeout(400); // Einblenden von Drawer/Dialog abwarten
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}${name}-${theme}.png` });
  }
  await setTheme(page, "light");
}

const pv = (kind: string, value: unknown) => ({ [kind]: { _0: value } });
const title = { id: "title", name: "Name", type: "title" };
const status = { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "Todo", color: "gray" }, { id: "doing", name: "Doing", color: "blue" }, { id: "done", name: "Done", color: "green" }] };

const VIEWPORT = { width: 1360, height: 860 };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await fresh(page);
});

// Dauerhaftes Profil (wie phase2.spec.ts): nur so überleben die Daten in WebKit das Neuladen.
test("Peek: öffnen, blättern (Buttons und ⌃⇧↑/↓), Esc, Neuladen, Center Peek, Full page", async ({ playwright, browserName, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "based-dbviews-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: VIEWPORT });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await peekScenario(page, browserName);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function peekScenario(page: Page, browserName: string) {
  test.setTimeout(120_000);
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await seedDatabase(page, {
    title: "Tasks",
    properties: [title, status, { id: "n", name: "Points", type: "number" }, { id: "note", name: "Note", type: "text" }],
    rows: [
      { id: "row-a", title: "Alpha", values: { st: pv("status", "todo"), n: pv("number", 3) } },
      { id: "row-b", title: "Bravo", values: { st: pv("status", "doing"), n: pv("number", 1) } },
      { id: "row-c", title: "Charlie", values: { st: pv("status", "done"), n: pv("number", 2) } },
    ],
    views: [{ id: "v-table", name: "Table", type: "table", extra: { sorts: [{ propertyID: "n", ascending: true }] } }, { id: "v-center", name: "Center", type: "list", extra: { openIn: "centerPeek" } }, { id: "v-full", name: "Full", type: "list", extra: { openIn: "fullPage" } }],
  });
  const peek = page.getByTestId("row-peek");
  const position = page.getByTestId("row-peek-position");
  const rowTitle = page.getByLabel("Row title");

  // Sortiert nach Points: Bravo (1), Charlie (2), Alpha (3). Side Peek ist der Standard.
  await page.getByRole("gridcell", { name: /Charlie/ }).hover();
  await page.getByRole("button", { name: "Open Charlie" }).click();
  await expect(peek).toHaveAttribute("data-mode", "sidePeek");
  await expect(rowTitle).toHaveValue("Charlie");
  await expect(position).toHaveText("2 of 3");
  await expect(peek.getByTestId("row-properties")).toContainText("Done");
  await shots(page, "web-db-peek");

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(rowTitle).toHaveValue("Alpha");
  await expect(position).toHaveText("3 of 3");
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(rowTitle).toHaveValue("Charlie");
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(rowTitle).toHaveValue("Bravo");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(rowTitle).toHaveValue("Charlie");

  // Property im Peek bearbeiten: der Editor liegt über dem Drawer und schreibt in die Zeile.
  await peek.getByRole("button", { name: "Edit Note" }).click();
  await page.getByRole("dialog", { name: "Edit Note" }).getByLabel("Note").fill("from the peek");
  await page.keyboard.press("Enter");
  await expect(peek.getByTestId("row-properties")).toContainText("from the peek");

  // Inhalt der Zeile im Editor schreiben.
  const editor = peek.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("Notes inside the row");
  await expect(peek.getByText("Notes inside the row")).toBeVisible();
  await page.waitForTimeout(500);

  // Neuladen: derselbe Peek ist wieder offen.
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(rowTitle).toHaveValue("Charlie");
  await expect(position).toHaveText("2 of 3");
  await expect(peek.getByText("Notes inside the row")).toBeVisible();

  // Esc schließt; nach dem Neuladen bleibt er zu.
  await rowTitle.focus();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("database-view")).toBeVisible();
  await expect(peek).toHaveCount(0);

  // Center Peek (pro Ansicht), dort „Open as full page“.
  await page.getByRole("tab", { name: "Center" }).click();
  await page.getByRole("button", { name: "Bravo", exact: true }).click();
  await expect(peek).toHaveAttribute("data-mode", "centerPeek");
  await expect(position).toHaveText("2 of 3"); // ohne Sortierung: Alpha, Bravo, Charlie
  if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}web-db-peek-center-light.png` });
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(rowTitle).toHaveValue("Charlie");
  await page.getByRole("button", { name: "Open as full page" }).click();
  await expect(peek).toHaveCount(0);
  await expect(page.getByLabel("Page title")).toHaveValue("Charlie");

  // Full page als Einstellung der Ansicht: kein Peek.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Tasks");
  await page.getByRole("tab", { name: "Full" }).click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  await expect(peek).toHaveCount(0);
}
