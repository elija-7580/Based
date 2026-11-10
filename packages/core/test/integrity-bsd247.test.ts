// BSD-247: Datenbank-Integrität wie in Swift – doppelte ID-Nummern nach Sync (BSD-123, UniqueIDRepairTests) und Werte
// einer Zeile, die aus dem Papierkorb zurückkommt (BSD-122, TrashedRowSchemaTests).
import { describe, expect, it } from "vitest";
import {
  addOption, addProperty, addRow, changePropertyType, createDatabase, deleteOption, MemoryPersistence, pv, restorePages, trashPages,
  uniqueIDRepair, valuesMatchingSchema, WorkspaceStore, type Database, type WireRecord,
} from "../src/index.js";

function device(node: string, records: WireRecord[] = [], start = 1000) {
  let t = start;
  return new WorkspaceStore({ persistence: new MemoryPersistence(records), node, now: () => (t += 1) });
}

const idOf = (s: WorkspaceStore, row: string, prop: string) => (s.blocks.get(row)?.values?.[prop] as { uniqueID?: { _0: number } } | undefined)?.uniqueID?._0;

describe("BSD-123: ID-Nummern nach Sync", () => {
  it("zwei Geräte legen offline je eine Zeile an – nach dem Abgleich eindeutig und auf beiden gleich", () => {
    const a = device("a");
    const { databaseID } = createDatabase(a, { parent: "w", title: "Bugs", sampleRows: 0 });
    const uid = addProperty(a, databaseID, "ID", "uniqueID")!;
    addRow(a, databaseID);
    const b = device("b", a.allRecords(), 5000);
    const ra = addRow(a, databaseID)!;
    const rb = addRow(b, databaseID)!;
    expect(idOf(a, ra, uid)).toBe(2);
    expect(idOf(b, rb, uid)).toBe(2);
    // Abgleich in beide Richtungen (wie Sync v2), danach die Reparaturen beider Seiten ebenfalls.
    const fromA = a.allRecords(), fromB = b.allRecords();
    b.applyRemote(fromA);
    a.applyRemote(fromB);
    b.applyRemote(a.allRecords());
    a.applyRemote(b.allRecords());
    const ids = (s: WorkspaceStore) => [idOf(s, ra, uid), idOf(s, rb, uid)];
    expect(ids(a)).toEqual(ids(b));
    expect(new Set(ids(a)).size).toBe(2);
    expect(ids(a)).toContain(2);
    expect(ids(a)).toContain(3);
    expect(a.databases.get(databaseID)!.nextUniqueID).toBe(4);
    expect(b.databases.get(databaseID)!.nextUniqueID).toBe(4);
    // Die ältere Zeile (createdAt) behält ihre Nummer.
    const older = a.blocks.get(ra)!.createdAt <= b.blocks.get(rb)!.createdAt ? ra : rb;
    expect(idOf(a, older, uid)).toBe(2);
  });

  it("nichts zu tun: keine Änderung; Zeilen im Papierkorb zählen mit", () => {
    const s = device("a");
    const { databaseID } = createDatabase(s, { parent: "w", title: "T", sampleRows: 0 });
    addProperty(s, databaseID, "ID", "uniqueID");
    const r1 = addRow(s, databaseID)!;
    addRow(s, databaseID);
    expect(uniqueIDRepair(s, databaseID)).toBeUndefined();
    trashPages(s, [r1]);
    expect(uniqueIDRepair(s, databaseID)).toBeUndefined();
  });
});

describe("BSD-122: Zeile aus dem Papierkorb", () => {
  it("Option gelöscht und Typ geändert, während die Zeile im Papierkorb lag (anderes Gerät) → ungültige Werte fallen weg", () => {
    const a = device("a");
    const { databaseID } = createDatabase(a, { parent: "w", title: "Aufgaben", sampleRows: 0 });
    const status = addProperty(a, databaseID, "Status", "select")!;
    const tags = addProperty(a, databaseID, "Tags", "multiSelect")!;
    const num = addProperty(a, databaseID, "Punkte", "number")!;
    const open = addOption(a, databaseID, status, "Offen")!;
    const t1 = addOption(a, databaseID, tags, "rot")!;
    const t2 = addOption(a, databaseID, tags, "blau")!;
    const row = addRow(a, databaseID, { values: { [status]: pv("select", open), [tags]: pv("multiSelect", [t1, t2]), [num]: pv("number", 3), zukunft: { neu: { _0: 1 } } as never } })!;
    trashPages(a, [row]);
    // Ein anderes Gerät ändert das Schema; die Zeile (im Papierkorb) bekommt die Änderung hier nicht mit.
    const b = device("b", a.allRecords(), 9000);
    deleteOption(b, databaseID, status, open);
    deleteOption(b, databaseID, tags, t2);
    changePropertyType(b, databaseID, num, "text");
    a.applyRemote(b.allRecords().filter((r) => r.kind === "database"));
    restorePages(a, [row]);
    const v = a.blocks.get(row)!.values!;
    expect(v[status]).toBeUndefined();
    expect(v[tags]).toEqual(pv("multiSelect", [t1]));
    expect(v[num]).toBeUndefined();
    expect(v.zukunft).toEqual({ neu: { _0: 1 } });
  });

  it("valuesMatchingSchema lässt berechnete und unbekannte Properties stehen", () => {
    const db = { id: "d", properties: [{ id: "f", name: "F", type: "formula" }, { id: "t", name: "T", type: "text" }] } as unknown as Database;
    const values = { f: pv("number", 1), t: pv("text", [{ t: "x" }]), weg: pv("number", 2) };
    expect(valuesMatchingSchema(values, db)).toEqual(values);
    expect(valuesMatchingSchema({ t: pv("number", 5) }, db)).toEqual({});
  });
});
