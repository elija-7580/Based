// BSD-260 Teil 6: Seite als Word (.docx) – Rundreise über den eigenen Import, Bilder eingebettet, Steuerzeichen.
import { describe, expect, it } from "vitest";
import {
  exportDocx, extractZip, imageSize, ImportFiles, importNotionItems, makeBlock, MemoryAssetSink, MemoryPersistence, plainText,
  WorkspaceStore, type Block, type WireRecord,
} from "../src/index.js";

const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
const kids = (s: WorkspaceStore, parent: string): Block[] => s.children(parent).map((id) => s.blocks.get(id)!);

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

export function samplePage(): { s: WorkspaceStore; page: string; img: Uint8Array } {
  const s = store();
  const img = png(1600, 900);
  let n = 0;
  const add = (parent: string, type: string, text: unknown, props: Record<string, unknown> = {}) => {
    const id = `b${++n}`;
    s.transact("add", (tx) => tx.put({ kind: "block", data: makeBlock({ id, type, parent, sk: "a" + String(n).padStart(3, "0"), text: text as never, props: props as never }, s.now()) } as WireRecord));
    return id;
  };
  const page = add("w", "page", "Quarterly <report> & more");
  const P = "b:" + page;
  add(P, "heading1", "Summary");
  add(P, "text", [{ t: "Revenue grew ", m: {} }, { t: "fast", m: { b: true } }, { t: " and ", m: {} }, { t: "steady", m: { i: true } }, { t: ", see ", m: {} }, { t: "dashboard", m: { link: "https://example.com/dash?a=1&b=2" } }, { t: " or run ", m: {} }, { t: "npm test", m: { c: true } }, { t: ".", m: {} }]);
  add(P, "heading2", "Tasks");
  const l1 = add(P, "bulletedList", "First bullet");
  add("b:" + l1, "bulletedList", "Nested bullet");
  add(P, "bulletedList", "Second bullet");
  add(P, "numberedList", "Step one");
  add(P, "numberedList", "Step two");
  add(P, "heading3", "Done");
  add(P, "quote", "Simplicity is prerequisite for reliability.");
  add(P, "code", "const x = 1;\nconsole.log(x);");
  add(P, "todo", "Ship it", { checked: true });
  const t = add(P, "table", [], { tableColumns: 2, tableHeaderRow: true });
  add("b:" + t, "tableRow", [], { cells: ["Name", "Value"] });
  add("b:" + t, "tableRow", [], { cells: ["Alpha", "1\u0007"] });
  add(P, "image", [], { asset: { id: "img-1", name: "chart.png", size: img.length, mime: "image/png" } });
  add(P, "page", "Sub page");
  return { s, page, img };
}

describe("Word-Export (.docx)", () => {
  it("imageSize liest PNG, GIF und JPEG", () => {
    expect(imageSize(png(10, 20))).toEqual({ w: 10, h: 20 });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 4, 0, 0]))).toEqual({ w: 3, h: 4 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 70, 3, 0, 0, 0]);
    expect(imageSize(jpg)).toEqual({ w: 70, h: 50 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("Rundreise über den eigenen Import: Titel, Überschriften, Formatierung, Link, Listen, Zitat, Code, Tabelle, Bild", () => {
    const { s, page, img } = samplePage();
    const out = exportDocx(s, page, { assetBytes: (a) => (a.id === "img-1" ? img : undefined), now: new Date(Date.UTC(2026, 10, 11)) });
    expect(out.name).toMatch(/^Quarterly .*report.* & more\.docx$/);
    const { files } = extractZip(out.data);
    expect(files.isFile("word/media/image1.png")).toBe(true);
    const t = store();
    const assets = new MemoryAssetSink();
    const r = importNotionItems(t, [{ files: new ImportFiles([["Report.docx", out.data]]), path: "Report.docx" }], { assets });
    const root = t.blocks.get(r.rootIDs[0]!)!;
    expect(plainText(root.text)).toBe("Quarterly <report> & more");
    const b = kids(t, "b:" + root.id);
    const by = (type: string) => b.filter((x) => x.type === type).map((x) => plainText(x.text));
    expect(by("heading1")).toEqual(["Summary"]);
    expect(by("heading2")).toEqual(["Tasks"]);
    expect(by("heading3")).toEqual(["Done"]);
    const para = b.find((x) => plainText(x.text).startsWith("Revenue grew"))!;
    const json = JSON.stringify(para.text);
    expect(json).toContain("https://example.com/dash?a=1&b=2");
    expect(json).toMatch(/"b":true/);
    expect(json).toMatch(/"i":true/);
    expect(json).toMatch(/"c":true/);
    expect(by("bulletedList")).toEqual(["First bullet", "Second bullet"]);
    expect(kids(t, "b:" + b.find((x) => x.type === "bulletedList")!.id).map((x) => [x.type, plainText(x.text)])).toEqual([["bulletedList", "Nested bullet"]]);
    expect(by("numberedList")).toEqual(["Step one", "Step two"]);
    expect(by("quote")).toEqual(["Simplicity is prerequisite for reliability."]);
    expect(by("code")).toEqual(["const x = 1;\nconsole.log(x);"]);
    expect(b.some((x) => plainText(x.text) === "☑ Ship it")).toBe(true);
    const table = b.find((x) => x.type === "table")!;
    expect(kids(t, "b:" + table.id).map((row) => (row.props!.cells as unknown[]).map((c) => plainText(c as never)))).toEqual([["Name", "Value"], ["Alpha", "1"]]);
    const image = b.find((x) => x.type === "image")!;
    expect(assets.files.get(image.props!.asset!.id)!.data).toEqual(img);
    expect(b.some((x) => plainText(x.text) === "↳ Sub page")).toBe(true);
  });

  it("ohne Bild-Bytes: Name statt Bild, gültiges Paket", () => {
    const { s, page } = samplePage();
    const out = exportDocx(s, page);
    const { files } = extractZip(out.data);
    expect(files.isDirectory("word/media")).toBe(false);
    expect(files.readText("word/document.xml")).toContain("chart.png");
    expect(files.readText("[Content_Types].xml")).toContain("wordprocessingml.document.main+xml");
  });
});
