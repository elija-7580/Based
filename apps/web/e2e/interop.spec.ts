import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Quick Find mit Volltext (Text aus dem Seiteninhalt), Import eines Notion-HTML-Exports (fixtures/import, als ZIP)
// und Export (Seite als Markdown, Workspace als Based-Archiv) als Download.

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

/** Kleiner ZIP-Schreiber (gespeichert, ohne Kompression) für die Fixture-Dateien. */
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

function notionExportZip(): Buffer {
  const fx = JSON.parse(readFileSync(new URL("../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files: { path: string; text?: string; base64?: string }[] } }[] };
  return zip(fx.cases[0]!.input.files.map((f) => ({ path: f.path, data: f.base64 !== undefined ? Buffer.from(f.base64, "base64") : Buffer.from(f.text ?? "", "utf8") })));
}

async function quickFind(page: Page, q: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: "Search pages" });
  await expect(box).toBeFocused();
  await box.fill(q);
  return page.getByRole("listbox", { name: "Results" }).getByRole("option");
}

test.beforeEach(async ({ page }) => fresh(page));

test("Volltextsuche findet Text aus dem Seiteninhalt, auch frisch geschriebenen", async ({ page }) => {
  // Text aus dem Inhalt der Willkommensseite (nicht im Titel)
  let hits = await quickFind(page, "sync server in Settings");
  await expect(hits.first()).toContainText("Welcome to Based");
  await expect(hits.first().getByTestId("qf-snippet")).toContainText("sync server in Settings");
  await expect(hits.first().locator("mark").first()).toHaveText(/sync/i);
  await page.keyboard.press("Escape");

  // Im Editor schreiben, dann danach suchen (Index arbeitet die Änderung ein)
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
  const last = page.getByText("Pages you delete wait in the Trash");
  const box = (await last.boundingBox())!;
  await last.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Quarterly zeppelin maintenance");
  await expect(page.getByText("Quarterly zeppelin maintenance")).toBeVisible();
  await page.locator(".page-head").click({ position: { x: 1, y: 1 } }); // Fokus aus dem Editor, damit ⌘K greift
  await expect.poll(async () => {
    hits = await quickFind(page, "zeppelin");
    const text = (await hits.first().textContent({ timeout: 2000 }).catch(() => "")) ?? "";
    await page.keyboard.press("Escape");
    return text;
  }, { timeout: 10_000 }).toContain("Quarterly zeppelin maintenance");
});

test("Import eines Notion-HTML-Exports (ZIP) legt die Seiten an", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "Export-abc.zip", mimeType: "application/zip", buffer: notionExportZip() });
  await expect(dialog.getByTestId("import-summary")).toHaveText(/Imported 2 pages, 2 databases, \d+ rows\./);
  await expect(dialog.getByText(/not imported — file storage/)).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "People" })).toBeVisible();

  // Importierter Inhalt ist durchsuchbar
  const hits = await quickFind(page, "Purple line");
  await expect(hits.first()).toContainText("Home");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  await expect(page.getByTestId("page-content")).toContainText("Purple line");
});

test("Export: Seite als Markdown, Workspace als Based-Archiv", async ({ page }) => {
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export page" });
  await dialog.getByRole("radio", { name: /Markdown/ }).click();
  const [md] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(md.suggestedFilename()).toMatch(/^Welcome.to.Based\.md$/); // WebKit ersetzt Leerzeichen
  const text = readFileSync((await md.path())!, "utf8");
  expect(text).toMatch(/^# Welcome to Based/);
  expect(text).toContain("Press ⌘K");
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Export workspace…" }).click();
  const ws = page.getByRole("dialog", { name: "Export workspace" });
  await ws.getByRole("radio", { name: /Based archive/ }).click();
  const [archive] = await Promise.all([page.waitForEvent("download"), ws.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(archive.suggestedFilename()).toMatch(/\.based\.zip$/);
  const bytes = readFileSync((await archive.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("workspace.jsonl"))).toBe(true);
});
