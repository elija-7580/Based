// BSD-436: Startvorlagen beim ersten Start. Läuft in beiden Datenformaten (run-ts: einmal mit BASED_PROPERTY_RECORDS=1),
// prüft je Vorlage Struktur, Ansichten und Werte, die Gültigkeit aller Records und die Zeit (Akzeptanz: < 3 s).
import { describe, expect, it } from "vitest";
import { MemoryPersistence, parseRecord, STARTER_TEMPLATES, WorkspaceStore, addStarterTemplate, plainText, rowsOf, viewsForBlock } from "../src/index.js";

const fresh = (opts: { propertyRecords?: boolean } = {}) =>
  new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "n", ...(opts.propertyRecords !== undefined ? { propertyRecords: opts.propertyRecords } : {}) });

const title = (store: WorkspaceStore, id: string) => {
  const b = store.blocks.get(id)!;
  const db = b.props?.databaseID ? store.databases.get(b.props.databaseID) : undefined;
  return plainText(db ? db.title : b.text);
};

describe("Startvorlagen (BSD-436)", () => {
  it("vier Vorlagen mit Titel, Beschreibung und Symbol", () => {
    expect(STARTER_TEMPLATES.map((t) => t.id)).toEqual(["tasks", "notes", "journal", "wiki"]);
    for (const t of STARTER_TEMPLATES) expect(t.title && t.description && t.icon, t.id).toBeTruthy();
  });

  it("Tasks: Board + Tabelle, Status/Due/Priority, vier Zeilen mit Werten", () => {
    const store = fresh();
    const id = addStarterTemplate(store, "tasks")!;
    const block = store.blocks.get(id)!;
    expect(block.type).toBe("databasePage");
    expect(block.parent).toBe("w");
    expect(title(store, id)).toBe("Tasks");
    const db = store.databases.get(block.props!.databaseID!)!;
    expect(db.properties.map((p) => p.name)).toEqual(["Name", "Status", "Due", "Priority"]);
    expect(viewsForBlock(store, id).map((v) => v.type)).toEqual(["board", "table"]);
    const rows = rowsOf(store, db.id);
    expect(rows.map((r) => plainText(r.text))).toEqual(["Try Based for a day", "Move one list from Notion", "Drag a card to Done", "Open Based"]);
    const status = db.properties.find((p) => p.name === "Status")!;
    const done = status.options!.find((o) => o.name === "Done")!.id;
    expect(rows.filter((r) => JSON.stringify(r.values?.[status.id] ?? null).includes(done)).length).toBe(1);
    const due = db.properties.find((p) => p.name === "Due")!;
    expect(rows.filter((r) => r.values?.[due.id] !== undefined).length).toBe(2);
  });

  it("Notes, Journal, Wiki: nutzbar, mit Inhalt", () => {
    const store = fresh();
    const notes = addStarterTemplate(store, "notes")!;
    const ndb = store.blocks.get(notes)!.props!.databaseID!;
    expect(viewsForBlock(store, notes).map((v) => v.type)).toEqual(["list", "table"]);
    const first = rowsOf(store, ndb)[0]!;
    expect(store.children("b:" + first.id).length).toBeGreaterThan(0);

    const journal = addStarterTemplate(store, "journal")!;
    expect(viewsForBlock(store, journal).map((v) => v.type)).toEqual(["calendar", "list"]);
    expect(rowsOf(store, store.blocks.get(journal)!.props!.databaseID!).map((r) => plainText(r.text))).toEqual(["Today"]);

    const wiki = addStarterTemplate(store, "wiki")!;
    expect(title(store, wiki)).toBe("Wiki");
    expect(store.children("b:" + wiki).map((c) => store.blocks.get(c)!).filter((b) => b.type === "page").map((b) => plainText(b.text)))
      .toEqual(["Getting started", "How we work", "Glossary"]);
    // oben unter Private, in Reihenfolge des Anlegens
    expect(store.children("w")).toEqual([notes, journal, wiki]);
  });

  for (const propertyRecords of [false, true]) {
    it(`alle vier in einem frischen Workspace in < 3 s, Records überstehen Neuladen (${propertyRecords ? "Property-Records" : "klassisch"})`, () => {
      const persistence = new MemoryPersistence([]);
      const store = new WorkspaceStore({ persistence, node: "n", propertyRecords });
      const t0 = performance.now();
      const ids = STARTER_TEMPLATES.map((t) => addStarterTemplate(store, t.id));
      expect(performance.now() - t0).toBeLessThan(3000);
      expect(ids.every(Boolean)).toBe(true);
      for (const r of persistence.loadAll()) expect(() => parseRecord(r)).not.toThrow();
      const again = new WorkspaceStore({ persistence, node: "m", propertyRecords });
      expect(again.children("w")).toEqual(store.children("w"));
      const tasks = again.blocks.get(ids[0]!)!;
      const db = again.databases.get(tasks.props!.databaseID!)!;
      expect(db.properties.map((p) => p.name)).toEqual(["Name", "Status", "Due", "Priority"]);
      expect(rowsOf(again, db.id).length).toBe(4);
    });
  }
});
