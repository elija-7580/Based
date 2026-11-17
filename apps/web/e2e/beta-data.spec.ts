import { expect, test, type Page } from "@playwright/test";
import { preUpdateName, readZipEntries, writeZip, zipEntryData } from "@based/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-469 (Beta-Weg 2): der Datenweg eines Testers als ein Durchgang – Notion-Export importieren, als Markdown, HTML
// und Based-Archiv exportieren, jeweils in einen geleerten Workspace wieder importieren, dazu die Sicherung vor dem
// Update (BSD-456) in einen neuen, leeren Workspace zurückspielen. Läuft im normalen Build (CI, beide Browser) und
// genauso im Beta-Build:
//   BASED_CHANNEL=beta BASED_E2E_PORT=4179 CI=1 pnpm --filter @based/web exec playwright test e2e/beta-data.spec.ts
// Verglichen wird ein Abbild des Workspaces: jeder Eintrag der Library (Art und Pfad) mit seinem Markdown-Export
// (Seiten) bzw. CSV (Datenbanken), dazu die Bytes der Dateien. Archiv und Sicherung müssen exakt gleich sein;
// Markdown und HTML bis auf die unten benannten, bekannten Unterschiede (je mit Backlog-Eintrag).

type Item = { id: string; title: string; kind: string; parentID?: string };
type Client = {
  command(c: unknown): Promise<unknown>;
  library(): Promise<Item[]>;
  exportPage(id: string, format: string): Promise<{ data: Uint8Array }>;
  exportWorkspace(format: string): Promise<{ name: string; data: Uint8Array }>;
};
type Snapshot = Record<string, string>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/import/${name}`, import.meta.url), "utf8")) as { cases: { name: string; input: { files: { path: string; text?: string; base64?: string }[] } }[] };
const bytes = (f: { text?: string; base64?: string }) => (f.base64 !== undefined ? Buffer.from(f.base64, "base64") : Buffer.from(f.text ?? "", "utf8"));
const notionHTML = fixture("notion-html.utc.json").cases[0]!.input.files;
const notionHTMLZip = Buffer.from(writeZip(notionHTML.map((f) => ({ path: f.path, data: bytes(f) }))));
const notionMarkdownZip = bytes(fixture("markdown.utc.json").cases.find((c) => c.name.startsWith("Notion-Markdown-Export (ZIP"))!.input.files[0]!);
const fixtureFile = (suffix: string) => bytes(notionHTML.find((f) => f.path.endsWith(suffix))!);

async function open(playwright: Parameters<Parameters<typeof test>[2]>[0]["playwright"], browserName: "chromium" | "webkit" | "firefox", baseURL: string) {
  // dauerhaftes Profil: WebKit hat OPFS nur dort, sonst liegt der Workspace nur im Speicher (siehe tabs.spec)
  const dir = mkdtempSync(join(tmpdir(), "based-beta-data-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL, viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  return { page, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const client = <T>(page: Page, fn: (c: Client, arg: unknown) => Promise<T>, arg?: unknown) =>
  page.evaluate(async ([src, a]) => (new Function("c", "a", `return (${src})(c, a)`) as (c: unknown, a: unknown) => Promise<unknown>)((globalThis as unknown as { __based: { client: unknown } }).__based.client, a), [fn.toString(), arg] as const) as Promise<T>;

/**
 * „Alles löschen“ wie ein Tester: alles in den Papierkorb, Papierkorb leeren. Vorher in die Einstellungen: ohne AI
 * (Beta-Build) legt die Shell auf Home in einem Workspace ganz ohne Seiten sonst eine leere Seite „Home“ an (BSD-461).
 */
async function wipe(page: Page) {
  await importPanel(page);
  await client(page, async (c) => {
    const top = (await c.library()).filter((i) => i.parentID === undefined).map((i) => i.id);
    if (top.length) await c.command({ op: "trash", ids: top });
    await c.command({ op: "emptyTrash" });
  });
  await expect.poll(() => client(page, async (c) => (await c.library()).length)).toBe(0);
}

/** Abbild: „<Art> <Pfad>“ → Markdown (Seite, Zeile) bzw. CSV (Datenbank). */
function snapshot(page: Page): Promise<Snapshot> {
  return client(page, async (c) => {
    const items = await c.library();
    const byID = new Map(items.map((i) => [i.id, i]));
    const out: Record<string, string> = {};
    for (const i of items) {
      const path: string[] = [];
      for (let p: Item | undefined = i; p; p = p.parentID ? byID.get(p.parentID) : undefined) path.unshift(p.title);
      out[`${i.kind} ${path.join(" / ")}`] = new TextDecoder().decode((await c.exportPage(i.id, "markdown")).data);
    }
    return out;
  });
}

/** Dateien im Workspace (über den Markdown-Export): Name in assets/ → Bytes. */
async function assetFiles(page: Page): Promise<Record<string, Buffer>> {
  const zip = new Uint8Array(await client(page, async (c) => Array.from((await c.exportWorkspace("markdown")).data)));
  const out: Record<string, Buffer> = {};
  for (const e of readZipEntries(zip)) if (e.path.startsWith("assets/")) out[e.path.slice(7)] = Buffer.from(zipEntryData(zip, e));
  return out;
}

async function importPanel(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
}

async function importFile(page: Page, name: string, buffer: Buffer): Promise<string> {
  await importPanel(page);
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.getByLabel("Choose files to import").setInputFiles({ name, mimeType: "application/zip", buffer });
  const summary = dialog.getByTestId("import-summary");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  const text = (await summary.textContent()) ?? "";
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  return text;
}

async function exportWorkspace(page: Page, format: RegExp): Promise<{ name: string; bytes: Buffer }> {
  await importPanel(page);
  await page.getByRole("button", { name: "Export workspace…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export workspace" });
  await dialog.getByRole("radio", { name: format }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const out = { name: download.suggestedFilename(), bytes: readFileSync((await download.path())!) };
  await dialog.getByRole("button", { name: "Done" }).click();
  return out;
}

// Bekannte Unterschiede nach dem Wiederimport eines Markdown-Exports. Sie werden auf beiden Seiten gleich gemacht, damit
// der Vergleich alles andere streng prüft und eine Behebung den Test nicht rot macht.
//  (Behoben in BSD-472/473: Zeileninhalt fehlte, eingebettete Datenbank rutschte ans Seitenende, eine verlinkte oberste
//  Datenbank landete unter der verlinkenden Seite – jetzt streng verglichen. BSD-487: Unique-ID „TASK-7“ kommt als
//  Unique-ID mit Präfix zurück, nicht mehr als Text – ebenfalls streng.)
//  - Created einer Zeile ohne Wert in Notion = Importzeit; Leerzeilen um Bilder und Links (nur Darstellung).
function normalizeMarkdownRoundTrip(s: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, text] of Object.entries(s)) {
    const kind = key.split(" ")[0];
    let t = text.replace(/^Created: .*$/gm, "");
    if (kind === "database") t = t.split("\n").map((l) => l.replace(/,"[A-Z][a-z]+ \d+, \d{4} \d+:\d\d [AP]M",/, ",,")).join("\n");
    t = t.replace(/\n{2,}/g, "\n").trim();
    out[key] = t;
  }
  return out;
}

test("BSD-469 Beta-Weg 2: Notion-Export importieren, als Markdown/HTML/Archiv exportieren und wieder importieren, Sicherung vor dem Update zurückspielen", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(240_000);
  const { page, close } = await open(playwright, browserName, baseURL!);
  let restored: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // 1. Notion-HTML-Export (ZIP) in einen leeren Workspace
    await wipe(page);
    expect(await importFile(page, "Export-abc.zip", notionHTMLZip)).toBe("Imported 2 pages, 2 databases, 3 rows, 2 attached files.");
    const original = await snapshot(page);
    expect(Object.keys(original).sort()).toEqual(["database Home / Tasks", "database People", "page Home", "page Home / Sub", "row Home / Tasks / Plan", "row Home / Tasks / Write docs", "row People / Ada"]);
    expect(original["page Home"]).toContain("Purple line");
    expect(original["page Home"]).toContain("![The diagram](assets/diagram.png)");
    expect(original["row Home / Tasks / Write docs"]).toContain("Row body text");
    const files = await assetFiles(page);
    expect(Object.keys(files).sort()).toEqual(["diagram.png", "report.pdf"]);
    expect(files["diagram.png"]!.equals(fixtureFile("diagram.png"))).toBe(true);
    expect(files["report.pdf"]!.equals(fixtureFile("report.pdf"))).toBe(true);
    await expect(page.getByRole("treeitem", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "People" })).toBeVisible();

    // 2. Exporte, wie ein Tester sie macht (Settings → Import → Export workspace…)
    const markdown = await exportWorkspace(page, /^Markdown/);
    expect(markdown.name).toMatch(/^Based.Export.Markdown.*\.zip$/);
    const html = await exportWorkspace(page, /^HTML/);
    const archive = await exportWorkspace(page, /Based archive/);
    expect(archive.name).toMatch(/\.based\.zip$/);
    // die Sicherung vor dem Update schreibt genau diese Bytes (main.tsx → setPreUpdateArchive)
    const preUpdate = Buffer.from(await client(page, async (c) => Array.from((await c.exportWorkspace("pre-update")).data)));

    // 3. Based-Archiv: alles löschen, Archiv importieren → exakt wie vorher (BSD-423), auch nach Neuladen
    await wipe(page);
    expect(await importFile(page, archive.name, archive.bytes)).toMatch(/^Imported 2 attached files, \d+ records from an archive\. \d+ records came back from Trash or deletion\.$/);
    expect(await snapshot(page)).toEqual(original);
    expect(await assetFiles(page)).toEqual(files);
    if (await page.getByTestId("sync-status").getAttribute("data-state") === "local") {
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      expect(await snapshot(page)).toEqual(original);
    }

    // 4. Markdown-Export wieder importieren: gleiche Zahlen, gleicher Inhalt bis auf die bekannten Unterschiede
    await wipe(page);
    // die Zeile „Write docs“ mit Inhalt liegt als eigene .md im Export und zählt wie im Notion-Import als Seite
    expect(await importFile(page, markdown.name, markdown.bytes)).toBe("Imported 3 pages, 2 databases, 3 rows, 2 attached files.");
    const fromMarkdown = await snapshot(page);
    expect(Object.keys(fromMarkdown)).toHaveLength(Object.keys(original).length);
    expect(normalizeMarkdownRoundTrip(fromMarkdown)).toEqual(normalizeMarkdownRoundTrip(original));
    expect(fromMarkdown["row Home / Tasks / Write docs"]).toContain("Row body text"); // BSD-472
    expect(await assetFiles(page)).toEqual(files);

    // 5. HTML-Export wieder importieren: HTML ist ein Leseformat – Seiten, Text und Dateien kommen zurück, Datenbanken
    //    als Tabellen auf Seiten (BSD-474). Verlustfrei zurück geht nur das Based-Archiv.
    await wipe(page);
    expect(await importFile(page, html.name, html.bytes)).toBe("Imported 4 pages, 2 attached files.");
    const fromHTML = await snapshot(page);
    expect(Object.keys(fromHTML).sort()).toEqual(["page Home", "page Home / Sub", "page Home / Tasks", "page People"]);
    expect(fromHTML["page Home"]).toContain("Purple line");
    expect(fromHTML["page Home / Sub"]).toContain("Sub body");
    expect(fromHTML["page Home / Tasks"]).toContain("Write docs");
    expect(fromHTML["page People"]).toContain("ada@example.com");
    expect(await assetFiles(page)).toEqual(files);

    // 6. Notion-Markdown-Export (ZIP mit Teil-Archiv, wie Notion ihn liefert)
    await wipe(page);
    expect(await importFile(page, "Export-md.zip", notionMarkdownZip)).toBe("Imported 4 pages, 1 database, 3 rows, 1 attached file.");
    expect(Object.keys(await snapshot(page)).sort()).toEqual(["database Projects / Tasks", "page Projects", "page Projects / Orphan", "page Projects / Sub Page", "row Projects / Tasks / Extra", "row Projects / Tasks / Plan", "row Projects / Tasks / Write docs"]);

    // 7. Sicherung vor dem Update (BSD-456) in einen neuen, leeren Workspace zurückspielen: alles wieder da
    restored = await open(playwright, browserName, baseURL!);
    await wipe(restored.page);
    const name = preUpdateName(new Date(), "0.2.2", "0.2.3");
    expect(await importFile(restored.page, name, preUpdate)).toMatch(/^Imported 2 attached files, \d+ records from an archive\./);
    expect(await snapshot(restored.page)).toEqual(original);
    expect(await assetFiles(restored.page)).toEqual(files);
    await expect(restored.page.getByRole("treeitem", { name: "Home" })).toBeVisible();
    await restored.page.getByRole("treeitem", { name: "Home" }).click();
    await expect(restored.page.getByLabel("Page title")).toHaveValue("Home");
    await expect(restored.page.getByTestId("page-content")).toContainText("Purple line");
  } finally {
    await restored?.close();
    await close();
  }
});
