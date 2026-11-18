// Notion „Markdown & CSV“-Export: Relationsspalten („Titel (Ordner/Titel%20<id>.md), …“) wurden Text – Boards nach so
// einer Spalte gruppierten dann nach dem rohen Pfad-String. Jetzt: echte Relation zur Zieldatenbank.
import { describe, expect, it } from "vitest";
import { ImportFiles, importNotionItems, MemoryPersistence, parseRelationCell, WorkspaceStore, type Block } from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

function run(files: [string, string][]) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
  importNotionItems(store, [{ files: new ImportFiles(files.map(([p, t]) => [p, enc(t)])), path: "Export" }]);
  const dbs = [...store.databases.values()];
  const rows = (title: string) => {
    const db = dbs.find((d) => d.title === title)!;
    return { db, rows: [...store.blocks.values()].filter((b: Block) => b.parent === "d:" + db.id) };
  };
  return { store, rows };
}

describe("CSV-Import: Relationen", () => {
  it("parst Titel mit Komma und Klammern", () => {
    expect(parseRelationCell("Bachelor Thesis (SB_PARA/Bachelor%20Thesis%20abc.md), Home (v2), page (SB_PARA/Home%20def.md)")).toEqual([
      { title: "Bachelor Thesis", path: "SB_PARA/Bachelor%20Thesis%20abc.md" },
      { title: "Home (v2), page", path: "SB_PARA/Home%20def.md" },
    ]);
  });

  it("löst Pfade auf Zeilen der Zieldatenbank auf", () => {
    const { rows } = run([
      ["Export/SB_PARA abc.csv", "Name,Kind\nBachelor Thesis,Project\nHomepage,Project\n"],
      ["Export/SB_PARA abc/Bachelor Thesis 0123456789abcdef0123456789abcdef.md", "# Bachelor Thesis\n\nKind: Project\n"],
      ["Export/SB_PARA abc/Homepage fedcba9876543210fedcba9876543210.md", "# Homepage\n\nKind: Project\n"],
      ["Export/SB_Weekly abc.csv", "Name,PARA\nWeek 1,\"Bachelor Thesis (SB_PARA/Bachelor%20Thesis%200123456789abcdef0123456789abcdef.md), Homepage (SB_PARA/Homepage%20fedcba9876543210fedcba9876543210.md)\"\nWeek 2,Homepage (SB_PARA/Homepage%20fedcba9876543210fedcba9876543210.md)\n"],
    ]);
    const para = rows("SB_PARA abc");
    const weekly = rows("SB_Weekly abc");
    const prop = weekly.db.properties.find((p) => p.name === "PARA")!;
    expect(prop.type).toBe("relation");
    expect(prop.relation?.databaseID).toBe(para.db.id);
    const id = (t: string) => para.rows.find((r) => r.text === t || (Array.isArray(r.text) && JSON.stringify(r.text).includes(t)))!.id;
    const val = (t: string) => (weekly.rows.find((r) => JSON.stringify(r.text).includes(t))!.values as Record<string, unknown>)[prop.id];
    expect(val("Week 1")).toEqual({ relation: { _0: [id("Bachelor Thesis"), id("Homepage")] } });
    expect(val("Week 2")).toEqual({ relation: { _0: [id("Homepage")] } });
  });

  it("ohne Ziel im Export: Text mit Titeln statt Pfaden", () => {
    const { rows } = run([["Export/Tasks abc.csv", "Name,Project\nA,\"Alpha (Projects/Alpha%20x.md), Beta (Projects/Beta%20y.md)\"\n"]]);
    const t = rows("Tasks abc");
    const prop = t.db.properties.find((p) => p.name === "Project")!;
    expect(prop.type).toBe("text");
    expect((t.rows[0]!.values as Record<string, unknown>)[prop.id]).toEqual({ text: { _0: "Alpha, Beta" } });
  });
});
