// BSD-212: Vorlagen-Bedienung (Standard setzen, löschen, Reihenfolge) und verknüpfte Ansichten (Abhängigkeiten der
// Seiten-Replik: verknüpfte Datenbanken, Zeilen darin).
import { describe, expect, it } from "vitest";
import { MemoryPersistence, WorkspaceStore, addRow, addTemplate, createDatabase, createLinkedView, dbops, plainText, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };

function setup() {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "p1", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0, stamp } },
    { kind: "block", data: { id: "p2", type: "page", parent: "w", sk: "a1", createdAt: 0, updatedAt: 0, stamp } },
  ];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });
  const made = createDatabase(store, { parent: "b:p1", inline: true, title: "Tasks", sampleRows: 1 });
  return { store, db: made.databaseID, made };
}

describe("Vorlagen (BSD-212)", () => {
  it("Standard setzen, neue Zeile nutzt ihn, leere Seite trotz Standard, löschen räumt auf", () => {
    const { store, db } = setup();
    const a = addTemplate(store, db, "Bug")!;
    const b = addTemplate(store, db, "Feature")!;
    expect(dbops.templatesOf(store, db).map((t) => plainText(t.text))).toEqual(["Bug", "Feature"]);

    dbops.setDefaultTemplate(store, db, b);
    expect(store.databases.get(db)!.defaultTemplateID).toBe(b);
    const row = addRow(store, db)!;
    expect(plainText(store.blocks.get(row)!.text)).toBe("Feature");
    expect(store.blocks.get(row)!.props?.isTemplate).toBeUndefined();
    const empty = addRow(store, db, { template: "" })!;
    expect(plainText(store.blocks.get(empty)!.text)).toBe("");

    dbops.deleteTemplate(store, db, b);
    expect(store.databases.get(db)!.defaultTemplateID).toBeUndefined();
    expect(store.databases.get(db)!.templateIDs).toEqual([a]);
    expect(store.blocks.get(b)!.trashedAt).toBeDefined(); // Papierkorb, nicht weg
    expect(dbops.templatesOf(store, db).map((t) => t.id)).toEqual([a]);

    dbops.setDefaultTemplate(store, db, a);
    dbops.setDefaultTemplate(store, db, undefined);
    expect(store.databases.get(db)!.defaultTemplateID).toBeUndefined();
    store.undo();
    expect(store.databases.get(db)!.defaultTemplateID).toBe(a);
  });
});

describe("Verknüpfte Ansichten (BSD-212)", () => {
  it("createLinkedView mit fester Block-ID; linkedDatabases/enclosingDatabases", () => {
    const { store, db, made } = setup();
    const linked = createLinkedView(store, db, "b:p2", "board", { blockID: "LINK" })!;
    expect(linked.blockID).toBe("LINK");
    expect(store.blocks.get("LINK")!.props).toMatchObject({ databaseID: db, viewIDs: [linked.viewID] });
    expect(store.views.get(linked.viewID)!).toMatchObject({ type: "board", blockID: "LINK", databaseID: db });

    expect([...dbops.linkedDatabases(store, ["p2", "LINK"])]).toEqual([db]);
    expect([...dbops.linkedDatabases(store, ["p1", made.blockID])]).toEqual([]); // eigene Datenbank, keine Verknüpfung
    const row = store.children("d:" + db)[0]!;
    expect(dbops.enclosingDatabases(store, row)).toEqual([db]);
    expect(dbops.enclosingDatabases(store, "p2")).toEqual([]);
    expect(createLinkedView(store, "missing", "b:p2")).toBeUndefined();
  });
});

describe("Workspace umbenennen (BSD-205)", () => {
  it("setzt den Namen, ignoriert Leeres, ein Undo-Schritt", async () => {
    const { renameWorkspace } = await import("../src/index.js");
    const { store } = setup();
    const before = store.workspace.name;
    renameWorkspace(store, "  Acme  ");
    expect(store.workspace.name).toBe("Acme");
    renameWorkspace(store, "   ");
    expect(store.workspace.name).toBe("Acme");
    store.undo();
    expect(store.workspace.name).toBe(before);
  });
});

describe("Zeilen-Sammelaktionen (BSD-213)", () => {
  it("duplicateRows: Kopien unter den Originalen, ein Undo-Schritt; deleteRows ebenso", async () => {
    const { addRow, deleteRows, duplicateRows } = { ...(await import("../src/index.js")), ...(await import("../src/index.js")).dbops };
    const { store, db } = setup();
    const a = addRow(store, db, { title: "A" })!;
    const b = addRow(store, db, { title: "B" })!;
    const before = store.children("d:" + db).length;
    const copies = duplicateRows(store, [a, b]);
    expect(copies).toHaveLength(2);
    const order = store.children("d:" + db).map((id) => plainText(store.blocks.get(id)!.text));
    expect(order.slice(-4)).toEqual(["A", "A", "B", "B"]);
    store.undo();
    expect(store.children("d:" + db).length).toBe(before);
    deleteRows(store, [a, b]);
    expect(store.blocks.get(a)!.trashedAt).toBeDefined();
    store.undo();
    expect(store.blocks.get(a)!.trashedAt).toBeUndefined();
    expect(store.blocks.get(b)!.trashedAt).toBeUndefined();
  });
});
