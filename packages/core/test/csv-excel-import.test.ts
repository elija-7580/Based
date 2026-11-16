// BSD-260 Teil 13: CSV-Dateien aus Excel (deutsches Windows: Semikolon, Windows-1252) importieren. Vorher fiel eine
// solche Datei still weg (nicht UTF-8) bzw. landete als eine einzige Spalte „Name;Ort;Betrag“.
import { describe, expect, it } from "vitest";
import { ImportFiles, importNotionItems, MemoryPersistence, WorkspaceStore, type Block } from "../src/index.js";

const cp1252 = (s: string) => new Uint8Array([...s].map((c) => ({ "ü": 0xfc, "ö": 0xf6, "€": 0x80 })[c] ?? c.charCodeAt(0)));

function importCSV(name: string, bytes: Uint8Array) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
  const report = importNotionItems(store, [{ files: new ImportFiles([[name, bytes]]), path: name }]);
  const db = [...store.databases.values()][0];
  const rows = [...store.blocks.values()].filter((b: Block) => b.parent === "d:" + db?.id);
  return { report, db, rows, store };
}

describe("CSV aus Excel (BSD-260 Teil 13)", () => {
  it("Semikolon und Windows-1252: Spalten und Umlaute kommen an", () => {
    const { db, rows } = importCSV("Kunden.csv", cp1252("Name;Ort;Betrag\r\nMüller;Köln;12\r\nSchmidt;Wien;7\r\n"));
    expect(db).toBeDefined();
    expect(db!.properties.map((p) => p.name)).toEqual(["Name", "Ort", "Betrag"]);
    expect(rows.map((r) => r.text).sort()).toEqual(["Müller", "Schmidt"]);
  });

  it("Tab-getrennt in UTF-16 mit BOM", () => {
    const text = "Name\tStadt\nA\tGraz\n";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff; bytes[1] = 0xfe;
    [...text].forEach((c, i) => { bytes[2 + i * 2] = c.charCodeAt(0); });
    const { db, rows } = importCSV("Liste.csv", bytes);
    expect(db!.properties.map((p) => p.name)).toEqual(["Name", "Stadt"]);
    expect(rows.map((r) => r.text)).toEqual(["A"]);
  });

  it("Komma-CSV bleibt wie bisher; eine Spalte mit Semikolon im Text wird nicht zerlegt, wenn es nicht passt", () => {
    const comma = importCSV("a.csv", new TextEncoder().encode("Name,Tags\nX,\"a, b\"\n"));
    expect(comma.db!.properties.map((p) => p.name)).toEqual(["Name", "Tags"]);
    const single = importCSV("b.csv", new TextEncoder().encode("Titel\nEins; zwei\nDrei\n"));
    expect(single.db!.properties.map((p) => p.name)).toEqual(["Titel"]);
    expect(single.rows.map((r) => r.text).sort()).toEqual(["Drei", "Eins; zwei"]);
  });
});
