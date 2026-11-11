// BSD-260 Teil 4: Word (.docx) – XML-Leser, zwei echte Dateien (pandoc, LibreOffice; fixtures/import/docx) mit
// Überschriften, Formatierung, Link, Code, Listen (verschachtelt, nummeriert), Zitat, Codeblock, Tabelle, Bild.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ImportFiles, importNotionItems, MemoryAssetSink, MemoryPersistence, parseXML, plainText, WorkspaceStore, type Block } from "../src/index.js";

const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
const kids = (s: WorkspaceStore, parent: string): Block[] => s.children(parent).map((id) => s.blocks.get(id)!);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/import/docx/${name}`, import.meta.url)));

describe("Word (.docx)", () => {
  it("XML-Leser: Präfixe, Attribute, Entities, Leerraum in w:t", () => {
    const x = parseXML('<?xml version="1.0"?><w:p a="1 &amp; 2"><w:t xml:space="preserve"> hi </w:t><w:br/></w:p>');
    const p = x.children[0]!;
    expect(p.name).toBe("w:p");
    expect(p.attrs.a).toBe("1 & 2");
    expect(p.children.map((c) => c.name)).toEqual(["w:t", "w:br"]);
    expect(p.children[0]!.children[0]!.text).toBe(" hi ");
  });

  for (const file of ["pandoc-report.docx", "libreoffice-report.docx"]) {
    it(`${file}: Seite mit allen Bausteinen`, () => {
      const s = store();
      const assets = new MemoryAssetSink();
      const r = importNotionItems(s, [{ files: new ImportFiles([[file, fixture(file)]]), path: file }], { assets });
      const page = s.blocks.get(r.rootIDs[0]!)!;
      expect(plainText(page.text)).toBe("Quarterly report");
      const b = kids(s, "b:" + page.id);
      const by = (type: string) => b.filter((x) => x.type === type);
      expect(by("heading1").map((x) => plainText(x.text))).toEqual(["Summary"]);
      expect(by("heading2").map((x) => plainText(x.text))).toEqual(["Tasks"]);
      expect(by("heading3").map((x) => plainText(x.text))).toEqual(["Done"]);
      const para = b.find((x) => plainText(x.text).startsWith("Revenue grew"))!;
      const json = JSON.stringify(para.text);
      expect(json).toContain("https://example.com/dash");
      expect(json).toMatch(/"b":true/);
      expect(json).toMatch(/"i":true/);
      if (file.startsWith("pandoc")) expect(json).toMatch(/"c":true/); // `npm test` (Zeichenformat VerbatimChar)
      expect(by("bulletedList").map((x) => plainText(x.text))).toEqual(["First bullet", "Second bullet"]);
      expect(kids(s, "b:" + by("bulletedList")[0]!.id).map((x) => [x.type, plainText(x.text)])).toEqual([["bulletedList", "Nested bullet"]]);
      expect(by("numberedList").map((x) => plainText(x.text))).toEqual(["Step one", "Step two"]);
      const table = by("table")[0]!;
      expect(table.props?.tableColumns).toBe(2);
      expect(kids(s, "b:" + table.id).map((row) => (row.props?.cells as unknown[]).map((c) => plainText(c as never)))).toEqual([["Region", "Sales"], ["North", "10"], ["South", "20"]]);
      expect(by("image")).toHaveLength(1);
      expect(by("image")[0]!.props?.asset?.name).toMatch(/\.png$/);
      expect(r.assets).toBe(1);
      const text = b.map((x) => plainText(x.text)).join("\n");
      expect(text).toContain("A wise quote.");
      expect(text).toContain("let x = 1;");
    });
  }

  it("keine Word-Datei: verständlicher Fehler", () => {
    expect(() => importNotionItems(store(), [{ files: new ImportFiles([["x.docx", new TextEncoder().encode("not a zip")]]), path: "x.docx" }])).toThrow();
  });
});
