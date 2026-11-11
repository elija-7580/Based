// BSD-260 Teil 7: JSON/JSONL importieren – Rundreise mit dem Seiten-JSON-Export, Tabellen als Datenbank, Rest als Code.
import { describe, expect, it } from "vitest";
import {
  exportPageJSON, ImportFiles, importNotionItems, MemoryPersistence, parseJSONFile, plainText, WorkspaceStore, type Block,
} from "../src/index.js";
import { samplePage } from "./docx-export.test.js";

const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
const kids = (s: WorkspaceStore, parent: string): Block[] => s.children(parent).map((id) => s.blocks.get(id)!);
const enc = (s: string) => new TextEncoder().encode(s);
const importOne = (name: string, text: string) => {
  const s = store();
  const r = importNotionItems(s, [{ files: new ImportFiles([[name, enc(text)]]), path: name }]);
  return { s, r };
};

describe("JSON-Import", () => {
  it("parseJSONFile: JSON, JSONL, BOM, kaputt", () => {
    expect(parseJSONFile('\uFEFF{"a":1}', false)).toEqual({ a: 1 });
    expect(parseJSONFile('{"a":1}\n{"a":2}\n', true)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJSONFile('{"a":1}\n{"a":2}', false)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJSONFile("{kaputt", false)).toBeUndefined();
  });

  it("Seiten-JSON (Export Teil 5) → gleiche Seite: Typen, Formatierung, Kinder, Eigenschaften; Unterseite nur mit Titel", () => {
    const { s, page } = samplePage();
    const json = exportPageJSON(s, page).json;
    const { s: t, r } = importOne("Report.json", json);
    const root = t.blocks.get(r.rootIDs[0]!)!;
    expect(plainText(root.text)).toBe("Quarterly <report> & more");
    const shape = (st: WorkspaceStore, id: string): unknown[] => kids(st, "b:" + id).map((b) => [b.type, b.text ?? null, b.props?.checked ?? null, b.props?.cells ?? null, shape(st, b.id)]);
    const expected = shape(s, page);
    const got = shape(t, root.id);
    expect(got).toEqual(expected);
    expect(r.warnings.join("\n")).toMatch(/1 sub-page imported by title only/);
    // Bild behält seine Referenz (die Datei fehlt auf einem anderen Gerät, wie beim Markdown-Import)
    expect(kids(t, "b:" + root.id).find((b) => b.type === "image")!.props!.asset!.name).toBe("chart.png");
  });

  it("unbekannte Blocktypen werden Text, fremde Verweise in props fallen weg", () => {
    const json = JSON.stringify({ format: "based.page", version: 1, title: "X", blocks: [
      { type: "hologram", text: "**hi**" },
      { type: "text", plain: "plain", props: { databaseID: "zzz", color: "red" } },
    ] });
    const { s, r } = importOne("x.json", json);
    const b = kids(s, "b:" + r.rootIDs[0]!);
    expect(b.map((x) => [x.type, plainText(x.text)])).toEqual([["text", "hi"], ["text", "plain"]]);
    expect(JSON.stringify(b[0]!.text)).toMatch(/"b":true/);
    expect(b[1]!.props?.databaseID).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/1 block of an unknown type/);
  });

  it("Liste von Objekten und JSONL → Datenbank, Titelspalte nach vorn, Listen als Mehrfachauswahl", () => {
    for (const [name, text] of [
      ["people.json", JSON.stringify([{ age: 36, name: "Ada", tags: ["math", "code"] }, { name: "Alan", age: 41, city: "London" }])],
      ["people.jsonl", '{"age":36,"name":"Ada","tags":["math","code"]}\n{"name":"Alan","age":41,"city":"London"}\n'],
      ["people.json", JSON.stringify({ items: [{ age: 36, name: "Ada", tags: ["math", "code"] }, { name: "Alan", age: 41, city: "London" }] })],
    ] as const) {
      const { s } = importOne(name, text);
      const db = [...s.databases.values()][0]!;
      expect(db.properties.map((p) => p.name)).toEqual(["name", "age", "tags", "city"]);
      const rows = s.children("d:" + db.id).map((id) => s.blocks.get(id)!);
      expect(rows.map((r) => plainText(r.text))).toEqual(["Ada", "Alan"]);
      // Listen werden (über den CSV-Import) Mehrfachauswahl
      const tags = db.properties.find((p) => p.name === "tags")!;
      expect(tags.type).toBe("multiSelect");
      expect(tags.options!.map((o) => o.name).sort()).toEqual(["code", "math"]);
    }
  });

  it("anderes oder ungültiges JSON wird wie bisher übersprungen (Swift-Verhalten)", () => {
    for (const [name, text] of [["config.json", '{"theme":"dark","n":[1,2]}'], ["broken.json", "{oops"], ["nums.json", "[1,2,3]"]] as const) {
      const { s, r } = importOne(name, text);
      expect(r.rootIDs).toEqual([]);
      expect(s.blocks.size).toBe(0);
      expect(r.warnings.join("\n")).toContain(`Skipped ${name}`);
    }
  });
});
