// BSD-407 Teil 3: Der Block-Editor bearbeitet Tabellenzellen als Klartext. Formatierung, Erwähnungen und Formeln einer
// Zelle (z. B. aus dem Notion-Import oder dem alten Editor) dürfen dabei nicht verloren gehen.
import { describe, expect, it } from "vitest";
import { blockCommands as cmd, MemoryPersistence, WorkspaceStore, type Block, type RichText, type WireRecord } from "../src/index.js";

const STAMP = { millis: 1, counter: 0, node: "x" };
const blk = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp: STAMP, ...extra } as Block,
});
const runs = (t: RichText) => cmd.runsOf(t);
const edit = (t: RichText, next: string) => cmd.editPlainText(runs(t), next);
const mention = { t: "Roadmap", m: {}, mention: { page: "p1" } };

describe("editPlainText", () => {
  it("lässt Marks vor und hinter der Änderung stehen", () => {
    const t: RichText = [{ t: "Hello " }, { t: "bold", m: { b: true } }, { t: " world" }];
    expect(edit(t, "Hello bold big world")).toEqual([{ t: "Hello ", m: {} }, { t: "bold", m: { b: true } }, { t: " big world", m: {} }]);
  });
  it("Tippen mitten in fettem Text bleibt fett", () => {
    expect(edit([{ t: "abcd", m: { b: true } }], "abXcd")).toEqual([{ t: "abXcd", m: { b: true } }]);
  });
  it("Löschen hinter einer Erwähnung lässt die Erwähnung ganz", () => {
    const t = [mention, { t: " notes" }] as RichText;
    expect(edit(t, "Roadmap no")).toEqual([{ ...mention }, { t: " no", m: {} }]);
  });
  it("eine Änderung in der Erwähnung ersetzt sie als Ganzes durch Text (nichts geht doppelt oder verloren)", () => {
    const t = [{ t: "x" }, mention, { t: " y" }] as RichText;
    const out = edit(t, "xRoadXmap y");
    expect(out.map((r) => r.t).join("")).toBe("xRoadXmap y");
    expect(out.some((r) => r.mention !== undefined)).toBe(false);
  });
  it("unverändert = gleich", () => {
    const t: RichText = [{ t: "a", m: { i: true } }, { t: "b" }];
    expect(edit(t, "ab")).toEqual(runs(t));
  });
  it("alles gelöscht = leer", () => {
    expect(edit([{ t: "a", m: { i: true } }], "")).toEqual([]);
  });
});

describe.each([false, true])("Tabelle im gemeinsamen Format (propertyRecords=%s)", (propertyRecords) => {
  const row = (id: string, sk: string, cells: RichText[]) => blk(id, "tableRow", "b:T", sk, { props: { cells } });
  const make = (legacy = false) => new WorkspaceStore({
    persistence: new MemoryPersistence([blk("P", "page", "w", "a0", { text: "Page" }), ...(legacy
      ? [blk("T", "table", "b:P", "a0", { props: { tableColumns: 2, tableHeaderRow: true, cells: ["A", [{ t: "B", m: { b: true } }], "c", "d"] } })]
      : [blk("T", "table", "b:P", "a0", { props: { tableColumns: 2, tableHeaderRow: true } }),
        row("R1", "a0", [[{ t: "Name", m: { b: true } }], "Plain"]),
        row("R2", "a1", [[{ t: "Link", m: { link: "https://based.dev" } }, { t: " here" }], ""])])]),
    node: "n", propertyRecords,
  });
  const cells = (s: WorkspaceStore) => cmd.tableModel(s, "T")!.rows.map((r) => r.cells);

  it("liest Zeilen-Records (wie Importer und Swift)", () => {
    const s = make();
    expect(cmd.tableModel(s, "T")).toMatchObject({ cols: 2, header: true, rows: [{ id: "R1" }, { id: "R2" }] });
  });
  it("bearbeitet nur die eine Zelle und behält deren Formatierung; ein Undo-Schritt", () => {
    const s = make();
    expect(cmd.setTableCell(s, "T", 1, 0, "Link here!")).toBe(true);
    expect(s.blocks.get("R2")!.props!.cells).toEqual([[{ t: "Link", m: { link: "https://based.dev" } }, { t: " here!" }], ""]);
    expect(s.blocks.get("R1")!.props!.cells).toEqual([[{ t: "Name", m: { b: true } }], "Plain"]);
    expect(s.blocks.get("T")!.props!.cells).toBeUndefined();
    s.undo();
    expect(s.blocks.get("R2")!.props!.cells![0]).toEqual([{ t: "Link", m: { link: "https://based.dev" } }, { t: " here" }]);
  });
  it("unveränderter Text schreibt nichts; falsche Zellen und andere Blöcke werden ignoriert", () => {
    const s = make();
    const rev = s.revision;
    expect(cmd.setTableCell(s, "T", 0, 1, "Plain")).toBe(false);
    expect(cmd.setTableCell(s, "T", 5, 0, "x")).toBe(false);
    expect(cmd.setTableCell(s, "T", 0, 7, "x")).toBe(false);
    expect(cmd.setTableCell(s, "P", 0, 0, "x")).toBe(false);
    expect(s.revision).toBe(rev);
  });
  it("Zeile und Spalte anfügen und löschen", () => {
    const s = make();
    cmd.addTableRow(s, "T");
    cmd.addTableColumn(s, "T");
    expect(cells(s)).toEqual([[[{ t: "Name", m: { b: true } }], "Plain", ""], [[{ t: "Link", m: { link: "https://based.dev" } }, { t: " here" }], "", ""], ["", "", ""]]);
    expect(s.blocks.get("T")!.props!.tableColumns).toBe(3);
    cmd.deleteTableColumn(s, "T", 1);
    cmd.deleteTableRow(s, "T", 0);
    expect(cells(s)).toEqual([[[{ t: "Link", m: { link: "https://based.dev" } }, { t: " here" }], ""], ["", ""]]);
    expect(s.blocks.get("R1")?.trashedAt ?? "gone").toBeTruthy(); // Zeile R1 selbst gelöscht, R2 behält ihre ID
    expect(cmd.tableModel(s, "T")!.rows[0]!.id).toBe("R2");
  });
  it("alte flache Tabelle (props.cells): wird gelesen und beim Bearbeiten in Zeilen-Records überführt, nichts geht verloren", () => {
    const s = make(true);
    expect(cells(s)).toEqual([["A", [{ t: "B", m: { b: true } }]], ["c", "d"]]);
    cmd.setTableCell(s, "T", 1, 1, "dd");
    expect(s.blocks.get("T")!.props!.cells).toBeUndefined();
    expect(cmd.tableModel(s, "T")!.rows.every((r) => r.id)).toBe(true);
    expect(cells(s)).toEqual([["A", [{ t: "B", m: { b: true } }]], ["c", "dd"]]);
  });
  it("Slash „Simple table“: leere Zeile wird 2 × 2-Tabelle mit Zeilen-Records", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence([blk("P", "page", "w", "a0", { text: "Page" }), blk("X", "text", "b:P", "a0")]), node: "n", propertyRecords });
    const f = cmd.insertTable(s, "X", true);
    expect(f).toEqual({ blockId: "X", selected: true });
    expect(s.blocks.get("X")!.type).toBe("table");
    expect(cmd.tableModel(s, "X")).toMatchObject({ cols: 2, header: true });
    expect(cmd.tableModel(s, "X")!.rows.map((r) => r.cells)).toEqual([["", ""], ["", ""]]);
  });
});

describe("wikilinkBefore", () => {
  it("erkennt „[[Titel]“ vor der Schreibmarke", async () => {
    const { wikilinkBefore } = await import("../src/index.js");
    expect(wikilinkBefore("Today: [[Launch plan]")).toEqual({ title: "Launch plan", start: 7 });
    expect(wikilinkBefore("[[ spaced ]")).toEqual({ title: "spaced", start: 0 });
    expect(wikilinkBefore("no [[link] here")).toBeUndefined();
    expect(wikilinkBefore("[[]")).toBeUndefined();
    expect(wikilinkBefore("[[a\nb]")).toBeUndefined();
  });
});

describe("pageHasMeeting", () => {
  it("findet Meetings auf der Seite (auch verschachtelt), nicht auf Unterseiten und nicht im Papierkorb", async () => {
    const { pageHasMeeting } = await import("../src/index.js");
    const s = new WorkspaceStore({
      persistence: new MemoryPersistence([
        blk("P", "page", "w", "a0", { text: "Page" }), blk("T", "toggle", "b:P", "a0"), blk("M", "meeting", "b:T", "a0"),
        blk("Q", "page", "w", "a1", { text: "Other" }), blk("S", "page", "b:Q", "a0", { text: "Sub" }), blk("M2", "meeting", "b:S", "a0"),
        blk("R", "page", "w", "a2", { text: "Trashed" }), blk("M3", "meeting", "b:R", "a0", { trashedAt: 1 }),
      ]),
      node: "n",
    });
    expect(pageHasMeeting(s, "P")).toBe(true);
    expect(pageHasMeeting(s, "Q")).toBe(false);
    expect(pageHasMeeting(s, "S")).toBe(true);
    expect(pageHasMeeting(s, "R")).toBe(false);
  });
});
