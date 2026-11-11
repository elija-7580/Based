import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Shell-Parität mit der Swift-App: Library (Filter, Bulk-Papierkorb), Teamspaces (anlegen, Seite verschieben, nach
// Neuladen noch da), HTML-Export als Download, Import eines ZIPs mit Bild (Bildblock zeigt das Bild), Graph auf
// echten Seiten. Mit BASED_SHOTS=1 entstehen dabei die Screenshots web-library/-teamspaces/-graph (hell und dunkel).

const SHOTS = process.env.BASED_SHOTS === "1";
const shotDir = fileURLToPath(new URL("../../../docs/design/screens/", import.meta.url));

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

type Client = { command(c: unknown): Promise<unknown> };
const command = <T>(page: Page, c: unknown) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c) as Promise<T>;

async function theme(page: Page, t: "light" | "dark") {
  await page.evaluate((v) => {
    document.documentElement.dataset.theme = v;
  }, t);
}

/** Screenshots hell und dunkel (nur mit BASED_SHOTS=1, nur Chromium). */
async function shots(page: Page, name: string, browser: string) {
  if (!SHOTS || browser !== "chromium") return;
  for (const t of ["light", "dark"] as const) {
    await theme(page, t);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shotDir}web-${name}-${t}.png` });
  }
  await theme(page, "light");
}

/** Kleiner ZIP-Schreiber (gespeichert, ohne Kompression). */
function zip(files: { path: string; data: Uint8Array }[]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (d: Uint8Array) => { let c = 0xffffffff; for (const b of d) c = table[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8"), c = crc(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(c, 14);
    h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    local.push(h, name, Buffer.from(f.data));
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0800, 8); e.writeUInt32LE(c, 16);
    e.writeUInt32LE(f.data.length, 20); e.writeUInt32LE(f.data.length, 24); e.writeUInt16LE(name.length, 28); e.writeUInt32LE(offset, 42);
    central.push(e, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** 4×4-PNG (rot), damit das Bild eine echte Größe hat. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");

test.beforeEach(async ({ page }) => fresh(page));

test("Library: suchen, nach Typ und Favorit filtern, mehrere in den Papierkorb", async ({ page }, info) => {
  await command(page, { op: "seed", count: 40, prefix: "Report" });
  await command(page, { op: "seed", count: 3, prefix: "Recipe" });
  await page.getByRole("button", { name: "Library" }).click();
  const lib = page.getByTestId("library");
  await expect(lib).toHaveAttribute("data-loaded", "");
  await expect(page.getByTestId("library-count")).toHaveText(/^44 items/); // + Willkommensseite
  // nur sichtbare Zeilen im DOM (virtualisiert)
  expect(await lib.getByRole("listitem").count()).toBeLessThan(44);

  await lib.getByRole("searchbox", { name: "Search the library" }).fill("recipe");
  await expect(page.getByTestId("library-count")).toHaveText(/^3 of 44 items/);
  await expect(lib.getByRole("listitem")).toHaveCount(3);

  // Favorit über die Auswahl, dann Filter „Favorites“
  await lib.getByRole("checkbox", { name: "Select Recipe 1" }).check();
  await page.getByRole("button", { name: "Add to Favorites" }).click();
  await lib.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(lib.getByRole("listitem")).toHaveCount(1);
  await lib.getByRole("button", { name: "Favorites", exact: true }).click();
  await shots(page, "library", info.project.name);

  // Typ-Filter: Datenbanken → nichts
  await lib.getByRole("button", { name: /^Type:/ }).click();
  await page.getByRole("menuitem", { name: "Databases", exact: true }).click();
  await expect(lib.getByText("Nothing matches")).toBeVisible();
  await lib.getByRole("button", { name: /^Type:/ }).click();
  await page.getByRole("menuitem", { name: "All types" }).click();

  // alle drei auswählen und in den Papierkorb (mit Bestätigung)
  await lib.getByRole("checkbox", { name: "Select all" }).check();
  await expect(page.getByTestId("library-selected")).toHaveText("3 selected");
  await page.getByRole("button", { name: "Move to Trash" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByTestId("library-count")).toHaveText(/^0 of 41 items/);
  await expect(page.getByRole("button", { name: /^Trash/ })).toContainText("3");
});

test("Teamspace anlegen, Seite hineinverschieben, nach Neuladen noch da; löschen schickt sie nach Private", async ({ playwright, browserName, baseURL }, info) => {
  test.slow();
  // Neuladen mit OPFS: WebKit hat OPFS nur in einem dauerhaften Profil, deshalb ein eigenes Profil.
  const dir = mkdtempSync(join(tmpdir(), "based-ts-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
  await page.getByRole("button", { name: "Create a teamspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New teamspace" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Research");
  await dialog.getByRole("button", { name: "Icon 🧪" }).click();
  await dialog.getByRole("button", { name: "Create teamspace" }).click();
  await expect(dialog).toHaveCount(0);
  const ts = page.getByRole("treeitem", { name: "Research" });
  await expect(ts).toBeVisible();

  // Seite über „Move to…“ in den Teamspace
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: /Move .* to/ });
  await move.getByRole("searchbox").fill("Research");
  await move.getByText("Research", { exact: true }).click();
  await expect(move).toHaveCount(0);
  const welcome = page.getByRole("treeitem", { name: "Welcome to Based" });
  await expect(welcome).toHaveAttribute("aria-level", "2");

  // zweite Seite per Ziehen auf den Teamspace
  await command(page, { op: "createPage", title: "Field notes" });
  const notes = page.getByRole("treeitem", { name: "Field notes" });
  await expect(notes).toHaveAttribute("aria-level", "1");
  await notes.dragTo(ts);
  await expect(notes).toHaveAttribute("aria-level", "2");
  await shots(page, "teamspaces", info.project.name);

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByRole("treeitem", { name: "Research" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveAttribute("aria-level", "2");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Research");

  // umbenennen und löschen über das Teamspace-Menü
  const row = page.getByRole("treeitem", { name: "Research" });
  await row.hover();
  await page.getByRole("button", { name: "Teamspace actions for Research" }).click();
  await page.getByRole("menuitem", { name: "Delete teamspace…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete teamspace" }).click();
  await expect(page.getByRole("treeitem", { name: "Research" })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveAttribute("aria-level", "1");
  await expect(page.getByRole("treeitem", { name: "Field notes" })).toHaveAttribute("aria-level", "1");
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTML-Export: Download enthält Titel und Text, Stylesheet aus den Tokens", async ({ page }) => {
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export page" });
  await dialog.getByRole("radio", { name: /HTML/ }).click();
  await expect(dialog.getByTestId("html-export-options")).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(file.suggestedFilename()).toMatch(/^Welcome.to.Based\.html$/);
  const html = readFileSync((await file.path())!, "utf8");
  expect(html).toContain("<title>Welcome to Based</title>");
  expect(html).toContain("<h1 class=\"title\">Welcome to Based</h1>");
  expect(html).toContain("Press ⌘K");
  expect(html).toContain("--ink:");
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).not.toMatch(/<script src=|<link /);
  await expect(dialog.getByTestId("export-result")).toContainText("Exported");
});

test("Import eines ZIPs mit Bild: der Bildblock zeigt das Bild aus dem Asset-Speicher", async ({ page }) => {
  const md = "# Hike\n\nUp the hill.\n\n![Summit](images/summit.png)\n";
  const data = zip([{ path: "Notes/Hike.md", data: Buffer.from(md) }, { path: "Notes/images/summit.png", data: PNG }]);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: data });
  await expect(dialog.getByTestId("import-summary")).toHaveText(/Imported 1 page, 1 attached file\./);
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("treeitem", { name: "Hike" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Hike");
  const img = page.locator(".bn-editor img").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveAttribute("src", /^blob:/, { timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(4);
});

test("Graph zeigt echte Seiten; Suche, Hervorheben, Klick öffnet", async ({ page }, info) => {
  const home = await page.evaluate(() => (JSON.parse(localStorage.getItem("based.recent") ?? "[]") as { id: string }[])[0]?.id);
  const a = await command<string>(page, { op: "createPage", title: "Roadmap" });
  await command(page, { op: "createPage", parent: a, title: "Q1 goals" });
  await command(page, { op: "createPage", parent: a, title: "Q2 goals" });
  if (home) await command(page, { op: "createPage", parent: home, title: "Getting started" });
  await command(page, { op: "seed", count: 120, prefix: "Note" });
  // BSD-281: Graph ist ein Reiter der Library
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  const canvas = page.getByTestId("graph-canvas");
  // Der Graph füllt sich asynchron aus dem Worker (erst 0 Knoten): warten statt einmal lesen.
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(124);
  await expect(page.getByTestId("graph-stats")).toContainText("pages");
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });

  // nur verbundene: die Note-Seiten (ohne Links) fallen weg
  await page.getByRole("switch", { name: "Only connected pages" }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes"))).toBeLessThan(10);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });

  // Suche wählt eine Seite, Überfahren hebt hervor, Klick öffnet
  await page.getByRole("searchbox", { name: "Find a page" }).fill("Roadmap");
  await page.getByRole("button", { name: /^Roadmap/ }).click();
  await expect(page.getByTestId("graph-selected")).toContainText("Roadmap");
  await expect(page.getByTestId("graph-selected")).toContainText("0 in · 2 out");
  await shots(page, "graph", info.project.name);
  const pos = await canvas.evaluate((el, id) => (el as unknown as { __basedGraph: { position(id: string): { x: number; y: number } | undefined } }).__basedGraph.position(id), a);
  expect(pos).toBeTruthy();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + pos!.x, box.y + pos!.y);
  await expect(canvas).toHaveAttribute("data-hovered", a);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByLabel("Page title")).toHaveValue("Roadmap");
});

test("Graph bleibt mit 5.000 Seiten bedienbar", async ({ page }) => {
  test.slow();
  await command(page, { op: "seed", count: 5000, prefix: "Bulk" });
  // BSD-281: Graph ist ein Reiter der Library
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  const canvas = page.getByTestId("graph-canvas");
  await expect(canvas).toHaveAttribute("data-nodes", /^50\d\d$/, { timeout: 20_000 });
  // Das Layout rechnet im Worker; der Hauptthread zeichnet nur: die Arbeit je Frame bleibt klein.
  const stats = () => canvas.evaluate((el) => (el as unknown as { __basedGraph: { stats(): { frames: number; drawMs: number; maxFrameMs: number } } }).__basedGraph.stats());
  await expect.poll(async () => (await stats()).frames, { timeout: 30_000 }).toBeGreaterThan(10);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 60_000 });
  expect((await stats()).maxFrameMs).toBeLessThan(80);
  // Danach ruhige Frames (nichts wird mehr gerechnet oder gezeichnet).
  const gaps = await page.evaluate(() => new Promise<number[]>((resolve) => {
    const out: number[] = [];
    let last = performance.now();
    const tick = (t: number) => {
      out.push(t - last);
      last = t;
      if (out.length < 30) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  }));
  gaps.sort((x, y) => x - y);
  expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(40);
  await page.getByRole("searchbox", { name: "Find a page" }).fill("Bulk 4999");
  await expect(page.getByRole("button", { name: /^Bulk 4999/ })).toBeVisible();
});
