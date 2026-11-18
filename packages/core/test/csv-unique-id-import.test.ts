// BSD-487: Markdown-Export → Wiederimport. Der Export schreibt eine Unique-ID als „TASK-7“ in die CSV; der Import las
// das als Text. Jetzt wird eine Spalte, deren Werte alle „<Präfix>-<n>“ mit gleichem Präfix und ohne doppelte Nummer
// sind, wieder eine Unique-ID-Eigenschaft mit Präfix – und neue Zeilen zählen danach weiter.
import { describe, expect, it } from "vitest";
import { ImportFiles, importNotionItems, inferCSVType, MemoryPersistence, uniqueIDPrefix, WorkspaceStore, type Block } from "../src/index.js";

function importCSV(text: string) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
  importNotionItems(store, [{ files: new ImportFiles([["Tasks.csv", new TextEncoder().encode(text)]]), path: "Tasks.csv" }]);
  const db = [...store.databases.values()][0]!;
  const rows = [...store.blocks.values()].filter((b: Block) => b.parent === "d:" + db.id);
  return { db, rows };
}

describe("CSV-Import: Unique-ID (BSD-487)", () => {
  it("„TASK-1..3“ wird Unique-ID mit Präfix TASK und Werten 1..3; nächste Nummer 4", () => {
    const { db, rows } = importCSV("Name,ID,Notiz\nA,TASK-1,x\nB,TASK-3,y\nC,TASK-2,z\n");
    const id = db.properties.find((p) => p.name === "ID")!;
    expect(id.type).toBe("uniqueID");
    expect(id.idPrefix).toBe("TASK");
    const byTitle = Object.fromEntries(rows.map((r) => [r.text as string, (r.values as Record<string, unknown>)[id.id]]));
    expect(byTitle).toEqual({ A: { uniqueID: { _0: 1 } }, B: { uniqueID: { _0: 3 } }, C: { uniqueID: { _0: 2 } } });
    expect(db.nextUniqueID).toBe(4);
    expect(db.properties.find((p) => p.name === "Notiz")!.type).toBe("text");
  });

  it("Spalte „ID“ mit leerer Zelle behält den Präfix (Export schreibt wieder „TASK-7“)", () => {
    const { db } = importCSV("Name,ID\nPlan,\nWrite docs,TASK-7\n");
    const id = db.properties.find((p) => p.name === "ID")!;
    expect(id.type).toBe("uniqueID");
    expect(id.idPrefix).toBe("TASK");
    expect(db.nextUniqueID).toBe(8);
  });

  it("gemischte Präfixe, doppelte Nummern oder leere Zellen bleiben Text", () => {
    expect(inferCSVType("Ticket", ["ABC-1", "XYZ-2"])).toBe("text");
    expect(inferCSVType("Ticket", ["ABC-1", "ABC-1"])).not.toBe("uniqueID");
    expect(inferCSVType("Ticket", ["ABC-1", ""])).not.toBe("uniqueID");
    expect(inferCSVType("ID", ["", "TASK-7"])).toBe("uniqueID"); // Zeile ohne Nummer, Spalte heißt „ID“
    expect(inferCSVType("Task ID", ["TASK-1", ""])).toBe("uniqueID");
    expect(inferCSVType("Ticket", ["ABC-1 x", "ABC-2"])).toBe("text");
    expect(uniqueIDPrefix(["BSD-487", "BSD-12"])).toBe("BSD");
    expect(uniqueIDPrefix(["487"])).toBeUndefined();
  });

  it("BSD-543: Textspalten mit Kennungen bleiben Text und bearbeitbar", () => {
    // eine Zeile: „COVID-19“, „GPT-4“ sind Text
    for (const v of ["COVID-19", "GPT-4", "ISO-9001"]) expect(inferCSVType("Topic", [v]), v).toBe("text");
    // Ticket-Verweise: zwei Werte oder weit auseinander → Text
    expect(inferCSVType("Ticket", ["JIRA-12", "JIRA-40"])).toBe("text");
    expect(inferCSVType("Ticket", ["JIRA-12", "JIRA-400", "JIRA-7"])).toBe("text");
    const { db } = importCSV("Name,Ticket\nA,JIRA-12\nB,JIRA-40\n");
    expect(db.properties.find((p) => p.name === "Ticket")!.type).toBe("text");
    expect(db.nextUniqueID).toBeUndefined();
    // dicht nummeriert ab drei Zeilen (auch ohne „ID“ im Namen) und alles mit „ID“ im Namen bleiben Unique-ID
    expect(inferCSVType("Number", ["TASK-1", "TASK-2", "TASK-4"])).toBe("uniqueID");
    expect(inferCSVType("ID", ["COVID-19"])).toBe("uniqueID");
    expect(inferCSVType("Task ID", ["T-5", "T-900"])).toBe("uniqueID");
  });
});
