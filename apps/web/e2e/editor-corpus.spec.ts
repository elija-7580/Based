import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockEditor, editorBlock, expectEditable } from "./editor-helpers.js";

// BSD-407 Teil 4: Der alte BlockNote-Editor ist entfernt – Seiten, die er (oder die Swift-App, ein Import, ein Agent)
// geschrieben hat, müssen im Block-Editor weiter lesbar sein. Beide Editoren arbeiten auf denselben Block-Records; hier
// wird der Swift-Korpus (fixtures/records/corpus.jsonl, jeder Blocktyp mit allen Feldern, auch ein unbekannter Typ aus
// der Zukunft) unter eine neue Seite gelegt: jeder Block erscheint, Öffnen und Neuladen ändern keinen Record.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-corpus-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

interface Wire { kind: string; data: Record<string, unknown> & { id: string; type?: string; parent?: string } }
const CORPUS = readFileSync(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Wire);
const ROOT = "p-root";

/** Blöcke unter der Startseite des Korpus (ohne die Seite selbst, Datenbankzeilen und Papierkorb). */
function corpusBlocks(): Wire[] {
  const blocks = CORPUS.filter((r) => r.kind === "block");
  const keep = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of blocks) {
      const p = b.data.parent ?? "";
      if (!keep.has(b.data.id) && (p === "b:" + ROOT || keep.has(p.slice(2)))) { keep.add(b.data.id); grew = true; }
    }
  }
  return blocks.filter((b) => keep.has(b.data.id));
}

type W = { __based: { client: { command(c: unknown): Promise<unknown>; openPage(id: string): Promise<{ store: { blocks: Map<string, Record<string, unknown>>; transact(n: string, f: (tx: { put(r: unknown): void }) => void): void } }> } } };

const BLOCKS = corpusBlocks();
const IDS = BLOCKS.map((b) => b.data.id);

async function seed(page: Page, pageID: string) {
  await page.evaluate(async ([pid, blocks, root]) => {
    const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
    store.transact("Seed corpus", (tx) => {
      for (const b of blocks) tx.put({ kind: "block", data: { ...b.data, parent: b.data.parent === "b:" + root ? "b:" + pid : b.data.parent } });
    });
  }, [pageID, BLOCKS, ROOT] as const);
}

const records = (page: Page, pageID: string) => page.evaluate(async ([pid, ids]) => {
  const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return Object.fromEntries(ids.map((id) => {
    const b = store.blocks.get(id);
    return [id, b ? JSON.stringify(stable({ type: b.type, parent: b.parent, sk: b.sk, text: b.text, props: b.props, trashedAt: b.trashedAt })) : "missing"];
  }));
}, [pageID, IDS] as const);

test("Swift-Korpus: jeder Blocktyp erscheint im Block-Editor, Öffnen und Neuladen ändern keinen Record", async ({ page }) => {
  const errors: string[] = [];
  // WebKit meldet die harmlose Browser-Warnung „ResizeObserver loop …“ (Medien-/Einbettungs-Blöcke) als Fehler.
  page.on("pageerror", (e) => { if (!e.message.startsWith("ResizeObserver loop")) errors.push(e.message); });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pageID = (await page.evaluate(() => (globalThis as unknown as W).__based.client.command({ op: "createPage", title: "Corpus" }))) as string;
  await page.goto(`/#page-${pageID}`);
  await expectEditable(page);
  await seed(page, pageID);
  const before = await records(page, pageID);
  expect(Object.values(before)).not.toContain("missing");

  const check = async () => {
    // jeder Block des Korpus hat seine Zeile im Editor (Abschnitte und Transkript stecken im Meeting-Block)
    for (const b of BLOCKS) {
      if (["meetingSection", "transcript", "tableRow"].includes(b.data.type!)) continue;
      await expect(editorBlock(page, b.data.id), `${b.data.type} ${b.data.id}`).toBeAttached();
    }
    const ed = blockEditor(page);
    await expect(ed.locator("[data-editable-id]", { hasText: "Einfacher Text" })).toBeVisible();
    await expect(ed.locator('.bx2-block[data-type="heading1"] [data-editable-id]')).toHaveText("Überschrift");
    await expect(editorBlock(page, "btod-0009-0000-4000-8000-000000000000").locator("input[type=checkbox]")).toBeChecked();
    await expect(editorBlock(page, "btod-0010-0000-4000-8000-000000000000").locator("input[type=checkbox]")).not.toBeChecked();
    await expect(ed.locator('.bx2-block[data-type="callout"]')).toContainText("Hinweis");
    await expect(ed.locator('.bx2-block[data-type="code"] [data-editable-id]')).toContainText("let x = 1");
    await expect(ed.locator('.bx2-block[data-type="table"]')).toBeVisible();
    await expect(ed.getByTestId("meeting-block").getByLabel("Meeting title")).toHaveValue("Meeting");
  };
  await check();
  await page.waitForTimeout(800);
  expect(await records(page, pageID)).toEqual(before);

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expectEditable(page);
  await check();
  await page.waitForTimeout(800);
  expect(await records(page, pageID)).toEqual(before);
  expect(errors).toEqual([]);
});
