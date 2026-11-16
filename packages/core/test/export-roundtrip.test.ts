// Prüfung Pass 37 (Import/Export): Rundreisen über Word (.docx) und den Markdown-Workspace-Export (ZIP mit
// Unterseite und Datenbank). Word kennt keine Code-Sprache (fällt weg); Aufgaben schreibt der Export als ☐/☑ und der
// Import liest sie jetzt wieder als Aufgaben (vorher Absatz mit „☑ …“). Spaltentypen einer Datenbank leitet der
// CSV-Import neu ab (hier: Tags → Text) – bewusst, CSV trägt keine Typen.
import { describe, expect, it } from "vitest";
import { addProperty, addRow, cellText, createDatabase, createPage, pv, QueryEngine, rowsOf, setValue, plainText, exportDocx, ImportFiles, importNotionItems, MemoryPersistence, planWorkspaceExport, runsOf, titleOf, topLevelPages, writeExportZip, WorkspaceStore, type Block } from "../src/index.js";

const CASES: [string, unknown, Record<string, unknown>?][] = [
  ["text", "Plain *star* <b>x</b> & \"q\""], ["text", "line1\nline2"],
  ["text", [{ t: "bold", m: { b: true } }, { t: " and " }, { t: "ital", m: { i: true } }, { t: " " }, { t: "code", m: { c: true } }, { t: "u", m: { u: true } }, { t: "s", m: { s: true } }]],
  ["text", [{ t: "link", m: { link: "https://example.com/a?x=1&y=2" } }]],
  ["heading1", "H1"], ["heading2", "H2"], ["heading3", "H3"], ["bulletedList", "item"], ["numberedList", "num"],
  ["todo", "todo", { checked: true }], ["todo", "open", { checked: false }], ["quote", "quote"], ["code", "a <b> &\n  x"], ["text", "emoji 🧠 Ä ß"],
];

function fill(store: WorkspaceStore, page: string) {
  const now = store.now();
  store.transact("t", (tx) => CASES.forEach(([type, text, props], i) => tx.put({ kind: "block", data: { id: page.slice(0, 4) + "b" + i, type, parent: "b:" + page, sk: "a" + String(i).padStart(3, "0"), text, ...(props ? { props } : {}), createdAt: now, updatedAt: now } as Block })));
}

function expectSame(dst: WorkspaceStore, root: string) {
  const got = dst.children("b:" + root).map((k) => dst.blocks.get(k)!).filter((b) => !["page", "databaseInline", "databasePage"].includes(b.type));
  expect(got.map((b) => b.type)).toEqual(CASES.map(([t]) => t));
  CASES.forEach(([, text, props], i) => {
    expect(JSON.stringify(runsOf(got[i]!.text as never)), `#${i}`).toBe(JSON.stringify(runsOf(text as never)));
    for (const [k, v] of Object.entries(props ?? {})) expect((got[i]!.props as Record<string, unknown> | undefined)?.[k], `#${i} ${k}`).toEqual(v);
  });
}

const importInto = (name: string, data: Uint8Array) => {
  const dst = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "d" });
  return { dst, report: importNotionItems(dst, [{ files: new ImportFiles([[name, data]]), path: name }]) };
};

describe("Rundreisen Word und Markdown-Workspace (Prüfung Pass 37)", () => {
  it("Word: Blöcke, Marks, Aufgaben (☐/☑) kommen zurück", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const page = createPage(store, { title: "Rundreise" });
    fill(store, page);
    const d = exportDocx(store, page);
    const { dst, report } = importInto(d.name, d.data);
    expect(titleOf(dst, report.rootIDs[0]!)).toBe("Rundreise");
    expectSame(dst, report.rootIDs[0]!);
  });

  it("Markdown-Workspace (ZIP): Seite, Unterseite und Datenbank kommen zurück", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const page = createPage(store, { title: "Rundreise" });
    fill(store, page);
    const sub = createPage(store, { title: "Unterseite", parent: page });
    fill(store, sub);
    createDatabase(store, { parent: "b:" + page, title: "Tasks", sampleRows: 2 } as never);
    const { zip } = writeExportZip(planWorkspaceExport(store, topLevelPages(store), "markdown"), () => undefined);
    const { dst, report } = importInto("Export.zip", zip);
    expect(report).toMatchObject({ pages: 2, databases: 1, rows: 2 });
    const root = report.rootIDs.find((id) => titleOf(dst, id) === "Rundreise")!;
    expectSame(dst, root);
    const subPage = [...dst.blocks.values()].find((b) => b.type === "page" && titleOf(dst, b.id) === "Unterseite")!;
    expect(subPage.parent).toBe("b:" + root);
    expectSame(dst, subPage.id);
  });

  it("Datenbank als CSV: Zellen mit Formel-Zeichen, Kommas, Anführungszeichen, Umbrüchen kommen gleich zurück", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const page = createPage(store, { title: "Mit Tabelle" });
    const { databaseID } = createDatabase(store, { parent: "b:" + page, title: "Werte", sampleRows: 0 } as never);
    const note = addProperty(store, databaseID, "Notiz", "text")!;
    const cells = ["=SUM(A1:A3)", "-Gedankenstrich", "@jemand", "+49 30 1234", "-5", "a, b; \"c\"", "zwei\nZeilen"];
    for (const [i, c] of cells.entries()) {
      const row = addRow(store, databaseID)!;
      store.transact("t", (tx) => tx.update(row, (b) => { b.text = "Zeile " + i; }));
      setValue(store, row, note, pv("text", c) as never);
    }
    const { zip } = writeExportZip(planWorkspaceExport(store, topLevelPages(store), "markdown"), () => undefined);
    const { dst } = importInto("Export.zip", zip);
    const db = [...dst.databases.values()][0]!;
    const col = db.properties.find((p) => p.name === "Notiz")!;
    const q = new QueryEngine(dst);
    const got = rowsOf(dst, db.id).sort((a, b) => plainText(a.text).localeCompare(plainText(b.text))).map((r) => cellText(dst, q.value(r, col, db)));
    expect(got).toEqual(cells);
  });
});
