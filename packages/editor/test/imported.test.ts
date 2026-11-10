// Eingefügtes Markdown → BlockNote-Blöcke → Records: was der Editor nach dem Einfügen speichert.
import { describe, expect, it } from "vitest";
import { MemoryPersistence, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { markdownToBlocks, singleParagraph } from "../src/mapping/imported.js";
import { applyDocChanges, materializeDoc } from "../src/mapping/materialize.js";
import { projectDoc } from "../src/mapping/blocks.js";

const page: WireRecord = { kind: "block", data: { id: "P", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0 } };

function paste(md: string) {
  let n = 0;
  const blocks = markdownToBlocks(md, () => "id-" + ++n);
  const store = new WorkspaceStore({ persistence: new MemoryPersistence([page]), node: "t", now: () => 5 });
  applyDocChanges(store, materializeDoc(store, "P", blocks, { now: 5, newID: () => "row-" + ++n }));
  const tree = (parent: string): unknown[] => store.children(parent).map((id) => {
    const b = store.blocks.get(id) as Block;
    const o: Record<string, unknown> = { type: b.type };
    if (b.text !== undefined) o.text = b.text;
    if (b.props) o.props = b.props;
    const kids = tree("b:" + id);
    if (kids.length) o.children = kids;
    return o;
  });
  return { blocks, store, records: tree("b:P") };
}

describe("Markdown einfügen", () => {
  it("Überschriften, verschachtelte Listen, To-dos, Zitat, Code mit Sprache, Trenner", () => {
    const { records } = paste("# Title\n\n- one\n  - nested\n    1. deep\n- [x] done\n- [ ] open\n\n> quote\n\n```swift\nlet a = 1\n```\n\n---\n#### Small");
    expect(records).toEqual([
      { type: "heading1", text: "Title" },
      { type: "bulletedList", text: "one", children: [{ type: "bulletedList", text: "nested", children: [{ type: "numberedList", text: "deep" }] }] },
      { type: "todo", text: "done", props: { checked: true } },
      { type: "todo", text: "open" },
      { type: "quote", text: "quote" },
      { type: "code", text: "let a = 1", props: { language: "swift" } },
      { type: "divider" },
      { type: "heading4", text: "Small" },
    ]);
  });

  it("Inline-Formatierung, Links und Code ohne Sprache", () => {
    const { records } = paste("Some **bold**, *italic*, ~~gone~~, `code` and [a link](https://example.com).\n\n```\nplain\n```");
    expect(records).toEqual([
      { type: "text", text: [
        { t: "Some " }, { t: "bold", m: { b: true } }, { t: ", " }, { t: "italic", m: { i: true } }, { t: ", " }, { t: "gone", m: { s: true } },
        { t: ", " }, { t: "code", m: { c: true } }, { t: " and " }, { t: "a link", m: { link: "https://example.com" } }, { t: "." },
      ] },
      { type: "code", text: "plain" },
    ]);
  });

  it("Tabelle mit Kopfzeile und Bild-Link", () => {
    const { records } = paste("| Name | Role |\n| --- | :-: |\n| Ada | **Lead** |\n\n![Chart](https://example.com/chart.png)");
    expect(records).toEqual([
      { type: "table", props: { tableColumns: 2, tableHeaderRow: true }, children: [
        { type: "tableRow", props: { cells: ["Name", "Role"] } },
        { type: "tableRow", props: { cells: ["Ada", [{ t: "Lead", m: { b: true } }]] } },
      ] },
      { type: "image", props: { url: "https://example.com/chart.png", caption: "Chart" } },
    ]);
  });

  it("mehrzeiliger Klartext: eine Zeile je Block; neu öffnen zeigt dieselben Blöcke", () => {
    const { blocks, store, records } = paste("first line\nsecond line\n\nthird line\n");
    expect(records).toEqual([{ type: "text", text: "first line" }, { type: "text", text: "second line" }, { type: "text", text: "third line" }]);
    expect(projectDoc(store, "P")).toEqual(blocks);
  });

  it("eine Zeile mit Inline-Markdown ist ein einzelner Absatz (wird an der Schreibmarke eingefügt)", () => {
    expect(singleParagraph(markdownToBlocks("just **this**"))?.content).toEqual([
      { type: "text", text: "just ", styles: {} }, { type: "text", text: "this", styles: { bold: true } },
    ]);
    expect(singleParagraph(markdownToBlocks("# heading"))).toBeUndefined();
    expect(singleParagraph(markdownToBlocks("a\nb"))).toBeUndefined();
  });
});
