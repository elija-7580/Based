import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { blockEditor, editorBlock, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-407 Teil 3: Blöcke, die der Block-Editor (jetzt Standard) noch nicht bearbeiten kann – Meeting mit Abschnitten und
// Transkript, Button mit Aktionen, Breadcrumb, Tabelle mit Formatierung in den Zellen – werden angezeigt und bleiben
// beim Arbeiten auf der Seite unverändert (Records gleich vor und nach dem Tippen und Neuladen). Tabellen liegen im
// gemeinsamen Format (Zeilen-Records `tableRow`) und werden angezeigt; eine bearbeitete Zelle behält ihre Formatierung.
// Seiten mit Meeting öffnen beim nächsten Laden im alten Editor (bis Teil 2f).

interface Rec { id: string; type: string; parent: string; sk: string; text?: unknown; props?: Record<string, unknown> }
interface Store { blocks: Map<string, Rec>; transact(n: string, f: (tx: { put(r: unknown): void }) => void): void }
type W = { __based: { client: { command(c: unknown): Promise<unknown>; openPage(id: string): Promise<{ store: Store }> } } };

const IDS = ["PT-MEET", "PT-SECTION", "PT-NOTE", "PT-TRANSCRIPT", "PT-BUTTON", "PT-CRUMB", "PT-TABLE", "PT-ROW1", "PT-ROW2", "PT-AFTER"];

async function seed(page: Page, pageID: string) {
  await page.evaluate(async (pid) => {
    const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
    const now = (Date.now() - 978_307_200_000) / 1000;
    const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}) => ({ kind: "block", data: { id, type, parent, sk, createdAt: now, updatedAt: now, ...extra } });
    store.transact("Seed", (tx) => {
      tx.put(blk("PT-MEET", "meeting", "b:" + pid, "a1", { text: "Weekly sync", props: { meeting: { status: "ready", attendees: ["Ada", "Alan"], language: "en" } } }));
      tx.put(blk("PT-SECTION", "meetingSection", "b:PT-MEET", "a0", { props: { meetingSection: "notes" } }));
      tx.put(blk("PT-NOTE", "text", "b:PT-SECTION", "a0", { text: "Decision: ship on Friday" }));
      tx.put(blk("PT-TRANSCRIPT", "transcript", "b:PT-MEET", "a1", { props: { segments: [] } }));
      tx.put(blk("PT-BUTTON", "button", "b:" + pid, "a2", { props: { buttonLabel: "Start standup", buttonActions: [{ kind: "openPage", targetID: pid, openAfter: true }] } }));
      tx.put(blk("PT-CRUMB", "breadcrumb", "b:" + pid, "a3"));
      // Tabelle im gemeinsamen Format: Zeilen sind `tableRow`-Blöcke mit `cells` (wie Importer, Swift, alter Editor)
      tx.put(blk("PT-TABLE", "table", "b:" + pid, "a4", { props: { tableColumns: 2, tableHeaderRow: true } }));
      tx.put(blk("PT-ROW1", "tableRow", "b:PT-TABLE", "a0", { props: { cells: [[{ t: "Owner", m: { b: true } }], "Status"] } }));
      tx.put(blk("PT-ROW2", "tableRow", "b:PT-TABLE", "a1", { props: { cells: [[{ t: "Ada", m: { link: "https://example.com/ada" } }, { t: " (lead)", m: { i: true } }], [{ t: "Ready", m: { color: "green" } }]] } }));
      tx.put(blk("PT-AFTER", "text", "b:" + pid, "a5", { text: "Typing here" }));
    });
  }, pageID);
}

const records = (page: Page, pageID: string) => page.evaluate(async ([pid, ids]) => {
  const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
  return Object.fromEntries(ids.map((id) => {
    const b = store.blocks.get(id);
    const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
    return [id, b ? JSON.stringify(stable({ type: b.type, parent: b.parent, sk: b.sk, text: b.text, props: b.props })) : "missing"];
  }));
}, [pageID, IDS] as const);

test("Nicht bearbeitbare Blöcke: angezeigt und beim Tippen und Neuladen unverändert", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pageID = (await page.evaluate(() => (globalThis as unknown as W).__based.client.command({ op: "createPage", title: "Passthrough" }))) as string;
  await page.goto(`/#page-${pageID}`);
  await expectEditable(page);
  await seed(page, pageID);
  const before = await records(page, pageID);
  expect(Object.values(before)).not.toContain("missing");

  const ed = blockEditor(page);
  // angezeigt: Meeting als Platzhalter mit Titel und Inhalt darunter, Button mit Beschriftung, Tabelle mit Text
  await expect(editorBlock(page, "PT-MEET")).toContainText("Meeting");
  await expect(editorBlock(page, "PT-NOTE")).toContainText("Decision: ship on Friday");
  await expect(editorBlock(page, "PT-BUTTON").getByRole("button", { name: "Start standup" })).toBeVisible();
  await expect(editorBlock(page, "PT-CRUMB")).toBeVisible();
  await expect(editorBlock(page, "PT-TABLE").locator("td")).toHaveText(["Ada (lead)", "Ready"]);

  // auf der Seite arbeiten: tippen, neue Zeilen, Klick auf den Platzhalter
  await ed.locator('[data-editable-id="PT-AFTER"]').click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Enter");
  await page.keyboard.type("New line");
  await editorBlock(page, "PT-MEET").locator(".bx2-unsupported").first().click();
  await focusEditorEnd(page);
  await page.keyboard.type("At the end");

  // Tabellenzelle bearbeiten: Klartext-Feld, Formatierung der Zelle bleibt (Link, kursiv), andere Zellen unberührt
  const cell = editorBlock(page, "PT-TABLE").getByRole("textbox", { name: "Row 2, column 1" });
  await cell.click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  const row2 = [[{ t: "Ada", m: { link: "https://example.com/ada" } }, { t: " (lead)!", m: { i: true } }], [{ t: "Ready", m: { color: "green" } }]];
  await expect.poll(async () => JSON.parse((await records(page, pageID))["PT-ROW2"]!).props.cells).toEqual(row2);
  const expected = { ...before, "PT-ROW2": JSON.stringify({ ...JSON.parse(before["PT-ROW2"]!), props: { cells: row2 } }) };
  const unchanged = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "PT-AFTER").map(([k, v]) => [k, v === "missing" ? v : JSON.parse(v)]));
  expect(unchanged(await records(page, pageID))).toEqual(unchanged(expected));
  expect(JSON.parse((await records(page, pageID))["PT-TABLE"]!).props.cells).toBeUndefined(); // kein zweites Format am Tabellen-Block

  // Neu laden: eine Seite mit Meeting öffnet bis Teil 2f im alten Editor (dort gibt es Aufnahme und Notizen) –
  // auch dabei ändert sich nichts
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("meeting-block")).toBeVisible();
  await expect(page.getByTestId("page-content")).toContainText("At the end");
  await page.waitForTimeout(800);
  expect(unchanged(await records(page, pageID))).toEqual(unchanged(expected));
});

/** Kleiner ZIP-Schreiber (gespeichert, ohne Kompression), wie image-block.spec.ts. */
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

/** Alle Block-Records der Seite (Replik), ohne Stempel und Zeiten. */
const pageRecords = (page: Page, pageID: string) => page.evaluate(async (pid) => {
  const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
  // Schlüssel sortiert: nach dem Neuladen kommen die Records aus dem Speicher (andere Reihenfolge, gleicher Inhalt)
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return [...store.blocks.values()].map((b) => JSON.stringify(stable({ id: b.id, type: b.type, parent: b.parent, sk: b.sk, text: b.text, props: b.props }))).sort();
}, pageID);

// Notion-Import-Rundreise: eine importierte Seite (Spalten, Bild mit Caption, PDF, Datenbank, Unterseite, Callout …) im
// Block-Editor öffnen, Schreibmarke setzen, wechseln, neu laden – die Records bleiben genau so, wie der Import sie schrieb.
test("Notion-Import: Öffnen und Klicken im Block-Editor ändert keine Records", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const fx = JSON.parse(readFileSync(new URL("../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files: { path: string; text?: string; base64?: string }[] } }[] };
  const data = zip(fx.cases[0]!.input.files.map((f) => ({ path: f.path, data: f.base64 !== undefined ? Buffer.from(f.base64, "base64") : Buffer.from(f.text ?? "", "utf8") })));
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "Export-abc.zip", mimeType: "application/zip", buffer: data });
  await expect(dialog.getByTestId("import-summary")).toContainText("Imported");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("treeitem", { name: "Home" }).first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  await expectEditable(page);
  const pageID = await page.evaluate(() => location.hash.replace(/^#page-/, "").split("/")[0]!);
  await page.waitForTimeout(800);
  const before = await pageRecords(page, pageID);
  expect(before.length).toBeGreaterThan(5);

  const fields = blockEditor(page).locator("[data-editable-id]");
  await fields.first().click();
  await page.keyboard.press("End");
  await fields.last().click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page.goBack();
  await expectEditable(page);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expectEditable(page);
  expect(await pageRecords(page, pageID)).toEqual(before);
});
