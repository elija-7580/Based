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
  /** Lasttest: jede Zusatzzeile bekommt in dieser Place-Property einen Ort (pseudozufällig, Europa). */
  bulkPlace?: string;
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
      for (let i = 0; i < (s.bulk ?? 0); i++) {
        const values: Record<string, unknown> = { ...(s.rows[i % Math.max(1, s.rows.length)]?.values ?? {}) };
        if (s.bulkPlace) {
          const r = (k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
          values[s.bulkPlace] = { place: { _0: JSON.stringify({ lat: Math.round((36 + r(1) * 24) * 1e4) / 1e4, lon: Math.round((-9 + r(2) * 38) * 1e4) / 1e4 }) } };
        }
        rows.push({ title: "Row " + String(i + 1).padStart(4, "0"), values });
      }
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

/** Wie Einstellungen → Darstellung (appearance.ts) bei gleichem System-Modus: Astryx folgt dem System (Theme „system“). */
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }, theme);
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
test("Peek: öffnen, blättern (Buttons und ⌃⇧↑/↓), Esc, Neuladen, Center Peek, Full page", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
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

  // Esc schließt; nach dem Neuladen bleibt er zu. (Ein offener Tooltip unter dem Zeiger nimmt das erste Esc –
  // Astryx-Ebenenstapel, WCAG 1.4.13 –, darum den Zeiger vorher von den Knöpfen nehmen.)
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
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
  if (browserName === "chromium") { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}web-db-peek-center-light.png` }); }
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

test("Formular: Fragen bearbeiten, ausfüllen, Pflicht/Typ prüfen, absenden → Zeile da", async ({ page }) => {
  await seedDatabase(page, {
    title: "Feedback",
    properties: [title, { id: "mail", name: "Email", type: "email" }, { id: "n", name: "Rating", type: "number" }, status, { id: "note", name: "Comments", type: "text" }],
    rows: [],
    views: [
      { id: "v-form", name: "Feedback form", type: "form", extra: { properties: [{ id: "title", visible: true }, { id: "mail", visible: true }, { id: "n", visible: true }, { id: "st", visible: true }] } },
      { id: "v-table", name: "Responses", type: "table" },
    ],
  });
  const form = page.getByTestId("form-view");
  await expect(form).toHaveAttribute("data-mode", "edit");

  // Bearbeiten: Email Pflicht, Hilfetext, Comments als Frage hinzufügen, Formular-Titel.
  const mail = form.getByRole("region", { name: "Question Email" });
  await mail.getByRole("switch", { name: "Required" }).check();
  await mail.getByLabel("Help text").fill("We only use it to reply");
  await form.getByLabel("Form title").fill("Tell us what you think");
  await form.getByRole("combobox", { name: "Add a question" }).click();
  await page.getByRole("option", { name: /Comments/ }).click();
  await expect(form.getByRole("region", { name: "Question Comments" })).toBeVisible();
  await shots(page, "web-db-form-edit");

  // Ausfüllen
  await form.getByRole("radio", { name: "Fill out" }).click();
  await expect(form).toHaveAttribute("data-mode", "fill");
  await expect(form.getByRole("heading", { name: "Tell us what you think" })).toBeVisible();
  await expect(form.getByText("We only use it to reply")).toBeVisible();
  await form.getByRole("textbox", { name: /Rating/ }).fill("great");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form.getByText("This question is required")).toHaveCount(2); // Name, Email
  await expect(form.getByText("Enter a number")).toBeVisible();
  await shots(page, "web-db-form-errors");

  await form.getByRole("textbox", { name: /Name/ }).fill("Ada Lovelace");
  await form.getByRole("textbox", { name: /Email/ }).fill("ada@example");
  await form.getByRole("textbox", { name: /Rating/ }).fill("5");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form.getByText("Enter an email address")).toBeVisible();
  await form.getByRole("textbox", { name: /Email/ }).fill("ada@example.com");
  await form.getByRole("combobox", { name: /Status/ }).click();
  await page.getByRole("option", { name: "Doing" }).click();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form.getByText("Response submitted")).toBeVisible();
  await expect(form.getByText("1 response", { exact: true })).toBeVisible();
  await expect(form.getByRole("textbox", { name: /Name/ })).toHaveValue("");
  await shots(page, "web-db-form");

  // Die Zeile steht in der Tabelle.
  await page.getByRole("tab", { name: "Responses" }).click();
  const row = page.getByRole("row", { name: /Ada Lovelace/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("ada@example.com");
  await expect(row).toContainText("Doing");
  await expect(row).toContainText("5");
});

test("Datumsfilter: Zeitraum, dessen Ende im Fenster liegt, bleibt sichtbar", async ({ page }) => {
  const now = new Date();
  const ymd = (offset: number) => { const d = new Date(now); d.setDate(d.getDate() + offset); return [d.getFullYear(), d.getMonth() + 1, d.getDate()] as const; };
  const at = (offset: number, h = 0, m = 0) => { const [y, mo, d] = ymd(offset); return swift(page, y, mo, d, h, m); };
  const range = async (from: number, to: number) => pv("date", { start: await at(from), end: await at(to), includeTime: false });
  const filter = (op: string, value: unknown) => ({ combinator: "and", items: [{ condition: { _0: { id: "c1", propertyID: "when", op, value } } }] });
  await seedDatabase(page, {
    title: "Trips",
    properties: [title, { id: "when", name: "When", type: "date" }],
    rows: [
      { title: "Ends in window", values: { when: await range(-20, -2) } },
      { title: "Runs through today", values: { when: await range(-3, 3) } },
      { title: "Long ago", values: { when: await range(-60, -40) } },
      { title: "Ends at midnight", values: { when: pv("date", { start: await at(-1, 20), end: await at(0), includeTime: true }) } },
    ],
    views: [
      { id: "v-week", name: "Past week", type: "table", extra: { filter: filter("within", { relative: { _0: "pastWeek" } }) } },
      { id: "v-before", name: "Before today", type: "table", extra: { filter: filter("before", { relative: { _0: "today" } }) } },
      { id: "v-today", name: "Today", type: "table", extra: { filter: filter("equals", { relative: { _0: "today" } }) } },
    ],
  });
  const names = () => page.getByRole("grid").getByRole("gridcell").filter({ hasText: /Ends|Runs|Long/ }).allTextContents();
  await expect(page.getByTestId("filter-chip")).toHaveText("When is within Past week");
  await expect.poll(async () => (await names()).map((t) => t.replace(/Open$/, "")).sort()).toEqual(["Ends at midnight", "Ends in window", "Runs through today"]);
  await page.getByRole("tab", { name: "Before today" }).click();
  await expect.poll(async () => (await names()).map((t) => t.replace(/Open$/, "")).sort()).toEqual(["Ends at midnight", "Ends in window", "Long ago"]);
  await page.getByRole("tab", { name: "Today", exact: true }).click();
  await expect.poll(async () => (await names()).map((t) => t.replace(/Open$/, "")).sort()).toEqual(["Runs through today"]);
});

test("Karte: Pins offline, Auswahl zeigt die Zeilenkarte, „No location“, Ort von Hand eingeben", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname) && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push(r.url()); });
  const place = (name: string, lat: number, lon: number) => pv("place", JSON.stringify({ lat, lon, name }));
  await seedDatabase(page, {
    title: "Places",
    properties: [title, { id: "where", name: "Where", type: "place" }, status],
    rows: [
      { id: "vie", title: "Vienna office", values: { where: place("Vienna", 48.2082, 16.3738) } },
      { id: "ber", title: "Berlin office", values: { where: place("Berlin", 52.52, 13.405) } },
      { id: "lis", title: "Lisbon office", values: { where: place("Lisbon", 38.7223, -9.1393), st: pv("status", "doing") } },
      { id: "nyc", title: "New York office", values: { where: place("New York", 40.7128, -74.006) } },
      { id: "txt", title: "Somewhere", values: { where: pv("place", "Old harbour") } },
      { id: "none", title: "Nowhere yet" },
    ],
    views: [{ id: "v-map", name: "Map", type: "map", extra: { mapPropertyID: "where", mapHeight: "medium", properties: [{ id: "title", visible: true }, { id: "st", visible: true }] } }],
  });
  const map = page.getByTestId("map-view");
  await expect(map).toBeVisible();
  // Jede Zeile mit Koordinaten ist als Pin oder in einem Cluster da.
  const onMap = async () => (await map.getByTestId("map-pin").count()) + (await map.getByTestId("map-cluster").allTextContents()).reduce((n, t) => n + Number(t), 0);
  await expect.poll(onMap).toBe(4);
  await expect(map).toContainText("4 on map");
  await expect(page.getByTestId("map-no-location")).toContainText("Somewhere");
  await expect(page.getByTestId("map-no-location")).toContainText("Old harbour");
  await expect(page.getByTestId("map-no-location")).toContainText("Nowhere yet");

  // Auswahl → Zeilenkarte mit Status; Esc schließt.
  await map.getByRole("button", { name: "Pin: Lisbon office" }).click();
  const card = page.getByTestId("map-card");
  await expect(card).toContainText("Lisbon office");
  await expect(card).toContainText("Doing");
  await shots(page, "web-db-map");
  await page.getByRole("application", { name: "Map of Where" }).focus();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Herauszoomen fasst nahe Pins zusammen; Klick auf den Cluster zoomt wieder hinein.
  const canvas = page.getByRole("application", { name: "Map of Where" });
  for (let i = 0; i < 8; i++) await map.getByRole("button", { name: "Zoom out" }).click();
  await expect(map.getByTestId("map-cluster").first()).toBeVisible();
  const zoomOut = Number(await canvas.getAttribute("data-zoom"));
  const members = Number(await map.getByTestId("map-cluster").first().textContent());
  await map.getByTestId("map-cluster").first().click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(zoomOut);
  await expect.poll(() => map.getByTestId("map-pin").count()).toBeGreaterThanOrEqual(members);
  if (!(await map.getByRole("button", { name: "Pin: Berlin office" }).isVisible())) await map.getByRole("button", { name: "Show all pins" }).click();
  for (let i = 0; i < 4 && !(await map.getByRole("button", { name: "Pin: Berlin office" }).isVisible()); i++) await map.getByTestId("map-cluster").first().click();
  // Ziehen verschiebt die Karte.
  const before = await map.getByRole("button", { name: "Pin: Berlin office" }).boundingBox();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const after = await map.getByRole("button", { name: "Pin: Berlin office" }).boundingBox();
  expect(Math.round(after!.x - before!.x)).toBe(120);
  expect(Math.round(after!.y - before!.y)).toBe(40);

  // Ort von Hand: Koordinaten prüfen, dann erscheint der Pin.
  await page.getByRole("button", { name: "Add location to Nowhere yet" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Where" });
  await editor.getByLabel("Name").fill("Graz");
  await editor.getByLabel("Latitude").fill("47,07");
  await editor.getByLabel("Latitude").press("Enter");
  await expect(editor.getByRole("alert")).toHaveText("Enter both latitude and longitude");
  await editor.getByLabel("Longitude").fill("15.44");
  await editor.getByLabel("Longitude").press("Enter");
  await expect(editor).toHaveCount(0);
  await map.getByRole("button", { name: "Show all pins" }).click();
  await expect.poll(onMap).toBe(5);
  await expect(map).toContainText("5 on map");
  await expect(page.getByTestId("map-no-location")).not.toContainText("Nowhere yet");
  expect(external).toEqual([]);
});

// 5.000 Zeilen: Karte (Pins/Cluster, Ziehen, Zoomen), Peek (Blättern) und Formular (Absenden) dürfen nicht ruckeln.
test("5.000 Zeilen: Karte, Peek und Formular bleiben flüssig", { tag: "@perf" }, async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Zeitmessung nur in Chromium");
  test.setTimeout(180_000);
  await seedDatabase(page, {
    title: "Big",
    properties: [title, { id: "where", name: "Where", type: "place" }, status, { id: "n", name: "N", type: "number" }],
    rows: [{ title: "First", values: { st: pv("status", "todo"), n: pv("number", 1) } }],
    bulk: 5000, bulkPlace: "where",
    views: [
      { id: "v-map", name: "Map", type: "map", extra: { mapPropertyID: "where" } },
      { id: "v-list", name: "List", type: "list", extra: { sorts: [{ propertyID: "title", ascending: false }] } },
      { id: "v-form", name: "Form", type: "form", extra: { properties: [{ id: "title", visible: true }, { id: "n", visible: true }, { id: "st", visible: true }] } },
    ],
  });
  await expect(page.getByLabel("Pages in view")).toHaveText("5,001");
  // Lange Aufgaben (> 50 ms) mitschreiben.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(e.duration); }).observe({ type: "longtask", buffered: false });
  });
  const longTasks = () => page.evaluate(() => { const w = globalThis as unknown as { __long: number[] }; const l = w.__long; w.__long = []; return l; });
  const report: Record<string, unknown> = {};

  // Karte
  const map = page.getByTestId("map-view");
  await expect(map).toBeVisible();
  await expect(map).toContainText("5,000 on map");
  report.mapOpen = await longTasks();
  const canvas = page.getByRole("application", { name: "Map of Where" });
  const box = (await canvas.boundingBox())!;
  const t0 = Date.now();
  // Erst warten, bis der Worker die 5.000 gesäten Zeilen bestätigt hat (das Echo rechnet die Ansicht einmal neu).
  await page.waitForTimeout(3000);
  report.idleBeforePan = await longTasks();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 2);
  report.firstMove = await longTasks();
  for (let i = 2; i <= 30; i++) await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 2);
  await page.mouse.up();
  report.mapPanLong = await longTasks();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }
  report.mapPanZoomMs = Date.now() - t0;
  report.mapDom = { pins: await map.getByTestId("map-pin").count(), clusters: await map.getByTestId("map-cluster").count(), zoom: await canvas.getAttribute("data-zoom") };
  report.mapPanZoomLong = await longTasks();
  await map.getByTestId("map-cluster").first().click();
  report.mapClusterLong = await longTasks();

  // Peek: 20 × blättern
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("button", { name: "Row 5000", exact: true }).click();
  await expect(page.getByTestId("row-peek-position")).toHaveText("1 of 5,001");
  await longTasks();
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.getByTestId("row-peek-position")).toHaveText("21 of 5,001");
  report.peekStepMs = (Date.now() - t1) / 20;
  report.peekLong = await longTasks();
  await page.getByRole("button", { name: "Close" }).first().click();

  // Formular: absenden
  await page.getByRole("tab", { name: "Form" }).click();
  const form = page.getByTestId("form-view");
  await form.getByRole("radio", { name: "Fill out" }).click();
  await form.getByRole("textbox", { name: /Name/ }).fill("Load test");
  await longTasks();
  const t2 = Date.now();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form.getByText("Response submitted")).toBeVisible();
  report.formSubmitMs = Date.now() - t2;
  report.formLong = await longTasks();
  await expect(form.getByText("5,002 responses")).toBeVisible();

  console.log("perf 5000:", JSON.stringify(report));
  const worst = (k: string) => Math.max(0, ...(report[k] as number[]));
  expect(worst("mapPanZoomLong")).toBeLessThan(150);
  expect(worst("peekLong")).toBeLessThan(150);
  expect(report.peekStepMs as number).toBeLessThan(250);
  expect(report.formSubmitMs as number).toBeLessThan(1500);
});

test("Files-&-Media-Property: Datei hochladen, nach Neuladen da, öffnet als Blob (BSD-208)", async ({ page, browserName }) => {
  await fresh(page);
  await seedDatabase(page, {
    title: "Attachments",
    properties: [title, { id: "f", name: "Files", type: "files" }],
    rows: [{ title: "Alpha" }],
    views: [{ id: "v-table", name: "Table", type: "table" }],
  });
  const row = page.getByRole("row", { name: /Alpha/ });
  await row.getByRole("gridcell").nth(1).click();
  const editor = page.getByLabel("Edit Files");
  if (!(await editor.isVisible())) await row.getByRole("gridcell").nth(1).dblclick();
  await expect(editor).toBeVisible();
  await editor.locator("input[type=file][aria-label='Upload file']").setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly numbers") });
  await expect(editor.getByText("report.txt")).toBeVisible();
  await page.keyboard.press("Escape");
  const chip = row.getByRole("button", { name: "report.txt" });
  await expect(chip).toBeVisible();
  // window.open abfangen: geöffnet wird die Blob-URL aus dem Asset-Speicher, mit dem hochgeladenen Inhalt.
  await page.evaluate(() => { (window as unknown as { open: (u: string) => null }).open = (u: string) => { (window as unknown as { __opened: string }).__opened = u; return null; }; });
  await chip.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string }).__opened ?? "")).toMatch(/^blob:/);
  expect(await page.evaluate(async () => (await fetch((window as unknown as { __opened: string }).__opened)).text())).toBe("quarterly numbers");
  // Neuladen nur in Chromium: WebKit speichert in diesem (nicht dauerhaften) Kontext nichts (kein OPFS).
  if (browserName !== "chromium") return;
  await page.reload();
  await expect(page.getByTestId("database-view")).toBeVisible();
  await expect(page.getByRole("row", { name: /Alpha/ }).getByRole("button", { name: "report.txt" })).toBeVisible();
});

test("BSD-216: Dashboard – Widgets aus anderer Quelle, verschieben, Breite, Zeilenhöhe, entfernen", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "createDatabase", title: "Other source" }));
  await seedDatabase(page, {
    title: "Board room",
    properties: [{ id: "title", name: "Name", type: "title" }, status],
    rows: [{ title: "A", values: { st: { status: { _0: "todo" } } } }],
    views: [{ id: "vd", name: "Dashboard", type: "dashboard", extra: { dashboard: { rows: [] } } }],
  });
  const dash = page.getByTestId("dashboard");
  const add = async (type: string, source?: string) => {
    await dash.getByRole("button", { name: "Add widget" }).click();
    if (source) await page.getByTestId("widget-source").filter({ hasText: source }).click();
    await page.getByTestId(`add-widget-${type}`).click();
  };
  await add("table");
  await add("list", "Other source");
  const rows = dash.getByTestId("dashboard-row");
  await expect(rows).toHaveCount(2);
  await expect(dash.getByTestId("dashboard-widget")).toHaveCount(2);
  // zweites Widget (aus „Other source“) in die Zeile darüber → eine Zeile mit zwei Widgets
  await dash.getByTestId("widget-actions").nth(1).click();
  await page.getByTestId("widget-move-up").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("dashboard-widget")).toHaveCount(2);
  // Breite und Zeilenhöhe
  await dash.getByTestId("widget-actions").first().click();
  await page.getByTestId("widget-width-4").click();
  await expect(dash.locator(".dbui-dash-cell").first()).toHaveAttribute("data-width", "4");
  const body = dash.locator(".dbui-widget-body").first();
  const before = (await body.boundingBox())!.height;
  await dash.getByTestId("widget-actions").first().click();
  await page.getByTestId("row-height-large").click();
  await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(before + 100);
  // links/rechts tauschen, dann entfernen
  await dash.getByTestId("widget-actions").first().click();
  await page.getByTestId("widget-move-right").click();
  await expect(dash.locator(".dbui-dash-cell").nth(1)).toHaveAttribute("data-width", "4");
  await dash.getByTestId("widget-actions").first().click();
  await page.getByTestId("widget-remove").click();
  await expect(dash.getByTestId("dashboard-widget")).toHaveCount(1);
});

test("BSD-216 Teil 2: Diagramm – Farben und Höhe", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const st = (o: string) => ({ st: { status: { _0: o } } });
  await seedDatabase(page, {
    title: "Charts",
    properties: [{ id: "title", name: "Name", type: "title" }, status],
    rows: [{ title: "A", values: st("todo") }, { title: "B", values: st("doing") }, { title: "C", values: st("doing") }],
    views: [{ id: "vc", name: "Chart", type: "chart", extra: { chart: { kind: "bar", xPropertyID: "st", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false } } }],
  });
  const chart = page.getByTestId("chart");
  await expect(chart.locator("rect.mark").first()).toBeVisible();
  const svgH = async () => Number(await chart.locator("svg").first().getAttribute("height"));
  const before = await svgH();
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByLabel("Chart colors").selectOption("green");
  await page.getByLabel("Chart height").selectOption("large");
  await expect(chart).toHaveAttribute("data-theme", "green");
  await expect(chart.locator("rect.mark.tone-green")).not.toHaveCount(0);
  await expect.poll(svgH).toBeGreaterThan(before);
  await page.getByLabel("Chart colors").selectOption("colorful");
  await expect(chart.locator("rect.mark.tone-blue")).toHaveCount(1);
});

test("BSD-216 Teil 3: Personen aus einer Liste wählen (schon verwendete Namen)", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const owner = { id: "ow", name: "Owner", type: "person" };
  await seedDatabase(page, {
    title: "People",
    properties: [{ id: "title", name: "Name", type: "title" }, owner],
    rows: [{ id: "r-a", title: "Alpha", values: { ow: { person: { _0: ["Anna Berg"] } } } }, { id: "r-b", title: "Beta" }],
    views: [{ id: "vt", name: "Table", type: "table" }],
  });
  await page.locator('[data-cell="r-b:1"]').click();
  const pick = page.getByTestId("person-suggestion").filter({ hasText: "Anna Berg" });
  await expect(pick).toBeVisible();
  await pick.click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-cell="r-b:1"]')).toContainText("Anna Berg");
});

test("BSD-225 Teil 2 / BSD-293: Property per AI ausfüllen (Skript-Engine), ⌘Z/⇧⌘Z in der Datenbank", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const area = { id: "ar", name: "Area", type: "select", options: [{ id: "w", name: "Work", color: "blue" }, { id: "h", name: "Home", color: "green" }] };
  await seedDatabase(page, {
    title: "Fill",
    properties: [{ id: "title", name: "Name", type: "title" }, area],
    rows: [{ title: "Prepare the quarterly report" }, { title: "Water the plants" }],
    views: [{ id: "vt", name: "Table", type: "table" }],
  });
  await page.waitForFunction(() => "__basedChat" in globalThis);
  await page.evaluate(() => (globalThis as unknown as { __basedChat: { useScript(s: unknown, d: number): void } }).__basedChat.useScript([[{ text: "Work" }], [{ text: "Home" }]], 0));
  await page.getByRole("columnheader", { name: /Area/ }).getByRole("button").first().click();
  await page.getByTestId("property-autofill").click();
  const cell = (row: string) => page.locator(".dbui-vrow", { hasText: row });
  await expect(cell("quarterly report")).toContainText("Work");
  await expect(cell("Water the plants")).toContainText("Home");
  // BSD-293: ⌘Z nimmt das ganze Autofill in einem Schritt zurück, ⇧⌘Z stellt es wieder her
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell("quarterly report")).not.toContainText("Work");
  await expect(cell("Water the plants")).not.toContainText("Home");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(cell("quarterly report")).toContainText("Work");
  await expect(cell("Water the plants")).toContainText("Home");
  // im Titelfeld bleibt ⌘Z das Undo des Feldes
  await page.getByLabel("Page title").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell("quarterly report")).toContainText("Work");
});

test("BSD-238 Teil 3: Pfeiltasten wandern zwischen Kalender-Einträgen und Timeline-Balken", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const now = new Date();
  let mon = 2;
  while (new Date(now.getFullYear(), now.getMonth(), mon).getDay() !== 1) mon++;
  const day = (d: number) => ({ dt: { date: { _0: { start: (new Date(now.getFullYear(), now.getMonth(), d).getTime() - 978_307_200_000) / 1000, includeTime: false } } } });
  await seedDatabase(page, {
    title: "Dates",
    properties: [{ id: "title", name: "Name", type: "title" }, { id: "dt", name: "Date", type: "date" }],
    // Montag/Dienstag liegen bei Wochenstart Sonntag wie Montag in derselben Zeile; C3 eine Woche unter C2
    rows: [{ title: "C1", values: day(mon) }, { title: "C2", values: day(mon + 1) }, { title: "C3", values: day(mon + 8) }],
    views: [{ id: "vc", name: "Calendar", type: "calendar", extra: { datePropertyID: "dt" } }, { id: "vt", name: "Timeline", type: "timeline", extra: { datePropertyID: "dt" } }],
  });
  const entry = (t: string) => page.locator(".dbui-cal-entry", { hasText: t }).first();
  await expect(entry("C1")).toBeVisible();
  await entry("C1").focus();
  await page.keyboard.press("ArrowRight");
  await expect(entry("C2")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(entry("C3")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(entry("C2")).toBeFocused();

  await page.getByRole("tab", { name: "Timeline" }).click();
  const bar = (t: string) => page.locator(".dbui-tl-bar", { hasText: t }).first();
  await expect(bar("C1")).toBeAttached();
  await bar("C1").focus();
  await page.keyboard.press("ArrowDown");
  await expect(bar("C2")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(bar("C3")).toBeFocused();
});

test("BSD-238: Pfeiltasten wandern zwischen Board-Karten und Listenzeilen, ⇧F10 öffnet das Zeilenmenü", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const st = (o: string) => ({ st: { status: { _0: o } } });
  await seedDatabase(page, {
    title: "Keys",
    properties: [{ id: "title", name: "Name", type: "title" }, status],
    rows: [{ title: "A1", values: st("todo") }, { title: "A2", values: st("todo") }, { title: "A3", values: st("todo") }, { title: "B1", values: st("doing") }, { title: "B2", values: st("doing") }],
    views: [{ id: "vb", name: "Board", type: "board", extra: { groupBy: { propertyID: "st" } } }, { id: "vl", name: "List", type: "list" }],
  });
  const board = page.getByTestId("board");
  const card = (t: string) => board.locator(".dbui-card", { hasText: t }).locator(".dbui-card-open");
  await expect(card("A1")).toBeVisible();
  await card("A1").focus();
  await page.keyboard.press("ArrowDown");
  await expect(card("A2")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card("B2")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(card("B1")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(card("B1")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(card("A1")).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Row actions" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "List" }).click();
  const row = (t: string) => page.locator(".dbui-list-row", { hasText: t }).locator(".dbui-list-title");
  await row("A1").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(row("A3")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row("A2")).toBeFocused();
});
