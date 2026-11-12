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

test("Volltextsuche findet Text aus dem Seiteninhalt, auch frisch geschriebenen", { tag: "@smoke" }, async ({ page }) => {
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
  await expect(dialog.getByTestId("import-summary")).toHaveText(/Imported 2 pages, 2 databases, \d+ rows, \d+ attached files?\./);
  // Bilder und Anhänge kommen in den Asset-Speicher (IndexedDB) statt zu entfallen
  await expect(dialog.getByTestId("import-summary")).toContainText("attached file");
  await expect(dialog.getByText(/not imported — file storage/)).toHaveCount(0);
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

test("Import eines Obsidian-Vaults (ZIP): Ordner, Wikilinks als Erwähnungen, Bild (BSD-260)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toContainText("Obsidian vault");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const vault = zip([
    { path: "Garden/.obsidian/app.json", data: Buffer.from("{}") },
    { path: "Garden/Welcome.md", data: Buffer.from("---\ntags: [start]\n---\nGo to [[Ideas/Seeds|my seeds]].\n\n![[pixel.png]]\n") },
    { path: "Garden/Ideas/Seeds.md", data: Buffer.from("Tomato seeds from [[Welcome]].") },
    { path: "Garden/assets/pixel.png", data: png },
  ]);
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "Garden.zip", mimeType: "application/zip", buffer: vault });
  await expect(dialog.getByTestId("import-summary")).toHaveText("Imported 4 pages, 1 attached file.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("treeitem", { name: "Garden" })).toBeVisible();
  const hits = await quickFind(page, "Tomato seeds");
  await expect(hits.first()).toContainText("Seeds");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Page title")).toHaveValue("Seeds");
  // Erwähnung [[Welcome]] führt zur Seite
  await page.getByTestId("page-content").getByText("Welcome").first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome");
  const content = page.getByTestId("page-content");
  await expect(content).toContainText("Go to 📄Seeds"); // Erwähnung zeigt den Seitentitel
  await expect(content).not.toContainText("[[");
  await expect(content.locator("img").first()).toBeVisible();
});

test("Import eines Logseq-Graphs (ZIP): Journale, Namensräume, Alias-Links, Block-Verweise (BSD-260 Teil 8)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toContainText("Logseq");
  const id = "6573f1f2-1a2b-4c3d-8e9f-0123456789ab";
  const graph = zip([
    { path: "notes/logseq/config.edn", data: Buffer.from("{}") },
    { path: "notes/pages/Garden___Herbs.md", data: Buffer.from(`alias:: Herbs\n\n- Basil needs sun\n  id:: ${id}\n  collapsed:: true\n- Mint spreads`) },
    { path: "notes/journals/2026_11_12.md", data: Buffer.from(`- Planted [[Herbs]] today\n- Remember: ((${id}))`) },
  ]);
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: graph });
  await expect(dialog.getByTestId("import-summary")).toContainText("Imported");
  await dialog.getByRole("button", { name: "Done" }).click();
  const hits = await quickFind(page, "Planted");
  await expect(hits.first()).toContainText("Nov 12th, 2026");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Page title")).toHaveValue("Nov 12th, 2026");
  const content = page.getByTestId("page-content");
  await expect(content).toContainText("Remember: Basil needs sun");
  await expect(content).not.toContainText("((");
  await content.getByText("Garden/Herbs").first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Garden/Herbs");
  await expect(page.getByTestId("page-content")).not.toContainText("collapsed::");
});

test("Import eines Evernote-Notizbuchs (.enex) als Datenbank (BSD-260)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toContainText("Evernote");
  const enex = `<?xml version="1.0" encoding="UTF-8"?><en-export><note><title>Garden log</title><created>20230115T093000Z</created><tag>garden</tag>
<content><![CDATA[<en-note><div>Planted <b>basil</b> today.</div><div><en-todo checked="true"/>Water</div></en-note>]]></content></note></en-export>`;
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "Hobby.enex", mimeType: "application/xml", buffer: Buffer.from(enex) });
  await expect(dialog.getByTestId("import-summary")).toContainText("1 database");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("treeitem", { name: "Hobby" })).toBeVisible();
  const hits = await quickFind(page, "basil");
  await expect(hits.first()).toContainText("Garden log");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-content")).toContainText("Planted basil today.");
  await expect(page.getByTestId("page-content")).toContainText("Water");
});

test("OPML: Gliederung importieren und als OPML wieder exportieren (BSD-260)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  const opml = '<?xml version="1.0"?><opml version="2.0"><head><title>Outline</title></head><body><outline text="Alpha"><outline text="Beta" _complete="true"/></outline></body></opml>';
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "outline.opml", mimeType: "text/x-opml", buffer: Buffer.from(opml) });
  await expect(dialog.getByTestId("import-summary")).toContainText("Imported 1 page");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("treeitem", { name: "Outline" }).click();
  await expect(page.getByTestId("page-content")).toContainText("Beta");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exp = page.getByRole("dialog", { name: "Export page" });
  await exp.getByRole("radio", { name: /OPML/ }).click();
  const [file] = await Promise.all([page.waitForEvent("download"), exp.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(file.suggestedFilename()).toBe("Outline.opml");
  const xml = readFileSync((await file.path())!, "utf8");
  expect(xml).toContain('<outline text="Alpha">');
  expect(xml).toContain('<outline text="Beta" _complete="true"/>');
  // BSD-260 Teil 6: dieselbe Seite als Word-Dokument
  // Der Dialog bleibt nach dem Export offen
  const exp2 = page.getByRole("dialog", { name: "Export page" });
  if (!(await exp2.isVisible())) await page.getByRole("button", { name: "Export", exact: true }).click();
  await exp2.getByRole("radio", { name: /Word/ }).click();
  const [doc] = await Promise.all([page.waitForEvent("download"), exp2.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(doc.suggestedFilename()).toBe("Outline.docx");
  const bytes = readFileSync((await doc.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("word/document.xml"))).toBe(true);
});

test("Word-Dokument (.docx) importieren (BSD-260)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  const docx = readFileSync(new URL("../../../fixtures/import/docx/pandoc-report.docx", import.meta.url));
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
  await expect(dialog.getByTestId("import-summary")).toHaveText("Imported 1 page, 1 attached file.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("treeitem", { name: "Quarterly report" }).click();
  const content = page.getByTestId("page-content");
  await expect(content.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(content).toContainText("Nested bullet");
  await expect(content.locator("table")).toContainText("North");
  await expect(content.locator("img").first()).toBeVisible();
});

test("JSON Lines importieren: Liste von Objekten wird Datenbank (BSD-260 Teil 7)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  const jsonl = '{"name":"Ada","age":36,"tags":["math","code"]}\n{"name":"Alan","age":41}\n';
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "people.jsonl", mimeType: "application/jsonl", buffer: Buffer.from(jsonl) });
  await expect(dialog.getByTestId("import-summary")).toContainText("Imported");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("treeitem", { name: "people" }).click();
  await expect(page.getByText("Alan").first()).toBeVisible();
  await expect(page.getByText("math").first()).toBeVisible();
});

test("Export: Markdown mit Frontmatter und JSON (BSD-260)", async ({ page }) => {
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export page" });
  await dialog.getByRole("radio", { name: /Markdown/ }).click();
  await dialog.getByTestId("markdown-export-options").getByText("Properties as YAML front matter").click();
  const [md] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const text = readFileSync((await md.path())!, "utf8");
  expect(text).toMatch(/^---\ntitle: Welcome to Based\n(icon: .+\n)?created: \d{4}-\d{2}-\d{2}T/);
  expect(text).toContain("---\n\n# Welcome to Based");
  await dialog.getByRole("radio", { name: /JSON/ }).click();
  await expect(dialog.getByTestId("markdown-export-options")).toHaveCount(0);
  const [json] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(json.suggestedFilename()).toMatch(/^Welcome.to.Based\.json$/);
  const v = JSON.parse(readFileSync((await json.path())!, "utf8"));
  expect(v).toMatchObject({ format: "based.page", version: 1, title: "Welcome to Based" });
  expect(v.blocks.length).toBeGreaterThan(0);
});

test("Export: Seite als Markdown, Workspace als Based-Archiv", { tag: "@smoke" }, async ({ page }) => {
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
