// BSD-30 (ADR 0014): der Store mit Properties als eigenen Records – Sicht, Schreiben, Undo, Sync zwischen Geräten,
// Umstellung beim Öffnen, Rückweg-Kopie.
import { describe, expect, it } from "vitest";
import {
  compareStamps, createPage, dbops, keyOf, MemoryPersistence, trashPages, WorkspaceStore, type Database, type RecordKeyString, type StoreChange, type WireRecord,
} from "../src/index.js";
import { propertyRecordID } from "../src/model/property-records.js";

/** Persistenz, die mitschreibt, was gespeichert wurde. */
class Recording extends MemoryPersistence {
  writes: { upserts: RecordKeyString[]; deletions: RecordKeyString[] }[] = [];
  override write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, { millis: number; counter: number; node: string }>): void {
    this.writes.push({ upserts: upserts.map((r) => keyOf(r.kind, r.data.id)), deletions: [...deletions] });
    super.write(upserts, deletions, tombstones);
  }
  last() {
    return this.writes[this.writes.length - 1]!;
  }
}

function device(node: string, opts: { split?: boolean; persistence?: MemoryPersistence; wall?: () => number } = {}) {
  let t = 1000;
  const persistence = opts.persistence ?? new Recording();
  const store = new WorkspaceStore({ node, persistence, now: () => (t += 1), propertyRecords: opts.split ?? true });
  if (opts.wall) store.clock.wallClock = opts.wall;
  return { store, persistence: persistence as Recording };
}
const names = (s: WorkspaceStore, db: string) => s.databases.get(db)!.properties.map((p) => p.name);
const kinds = (keys: RecordKeyString[]) => keys.map((k) => k.slice(0, k.indexOf(":"))).sort();
/** Alles, was A hat, zu B (wie ein Pull), einschließlich Löschungen. */
function sync(from: WorkspaceStore, to: WorkspaceStore, deleted: RecordKeyString[] = []) {
  const stamps = new Map(deleted.map((k) => [k, from.persistence!.tombstone(k)!] as const).filter(([, s]) => s));
  return to.applyRemote(from.allRecords(), deleted, stamps);
}

function seeded() {
  const a = device("a");
  const page = createPage(a.store, { title: "Home" });
  const made = dbops.createDatabase(a.store, { parent: "b:" + page, title: "Tasks", sampleRows: 0 });
  const status = dbops.addProperty(a.store, made.databaseID, "Status", "select")!;
  const notes = dbops.addProperty(a.store, made.databaseID, "Notes", "text")!;
  return { ...a, page, db: made.databaseID, status, notes };
}

describe("Sicht und Speicherform", () => {
  it("die App liest Datenbanken wie bisher; gespeichert sind Kern ohne Properties und ein Record je Property", () => {
    const a = seeded();
    const view = a.store.databases.get(a.db)!;
    expect(view.properties.map((p) => p.name)).toEqual(expect.arrayContaining(["Name", "Status", "Notes"]));
    expect("legacyProperties" in view).toBe(false);
    const core = a.store.record(keyOf("database", a.db))!.data as Database;
    expect(core.properties).toEqual([]);
    const records = a.store.propertyRecordsOf(a.db);
    expect(records.map((r) => r.schema.name)).toEqual(view.properties.map((p) => p.name));
    expect(records.every((r) => r.id === propertyRecordID(a.db, r.schema.id) && r.databaseID === a.db)).toBe(true);
    expect(a.store.allRecords().filter((r) => r.kind === "property")).toHaveLength(records.length);
    // neu geöffnet: dieselbe Sicht
    const again = new WorkspaceStore({ node: "a", persistence: a.persistence, propertyRecords: true });
    expect(again.databases.get(a.db)).toEqual(view);
  });

  it("eine Property ändern schreibt genau ihren Record – nicht den Kern, nicht die anderen", () => {
    const a = seeded();
    const before = new Map(a.store.propertyRecordsOf(a.db).map((r) => [r.id, r.stamp]));
    const coreStamp = (a.store.record(keyOf("database", a.db))!.data as Database).stamp;
    dbops.renameProperty(a.store, a.db, a.notes, "Remarks");
    expect(names(a.store, a.db)).toContain("Remarks");
    expect(a.persistence.last().upserts).toEqual([keyOf("property", propertyRecordID(a.db, a.notes))]);
    expect(a.persistence.last().deletions).toEqual([]);
    for (const r of a.store.propertyRecordsOf(a.db)) {
      if (r.schema.id === a.notes) expect(compareStamps(r.stamp, before.get(r.id)!)).toBeGreaterThan(0);
      else expect(r.stamp).toEqual(before.get(r.id));
    }
    expect((a.store.record(keyOf("database", a.db))!.data as Database).stamp).toEqual(coreStamp);
  });

  it("neue Property: ein Record; löschen: eine Löschung; Titel der Datenbank ändern: nur der Kern", () => {
    const a = seeded();
    const due = dbops.addProperty(a.store, a.db, "Due", "date")!;
    const added = a.persistence.writes.flatMap((w) => w.upserts).filter((k) => k === keyOf("property", propertyRecordID(a.db, due)));
    expect(added).toHaveLength(1);
    const n = a.persistence.writes.length;
    dbops.deleteProperty(a.store, a.db, due);
    const del = a.persistence.writes.slice(n).flatMap((w) => w.deletions);
    expect(del).toEqual([keyOf("property", propertyRecordID(a.db, due))]);
    expect(names(a.store, a.db)).not.toContain("Due");
    a.store.transact("Rename", (tx) => tx.put({ kind: "database", data: { ...a.store.databases.get(a.db)!, title: [{ t: "Projects" }] } }));
    expect(kinds(a.persistence.last().upserts)).toEqual(["database"]);
    expect(names(a.store, a.db)).toEqual(expect.arrayContaining(["Name", "Status", "Notes"]));
  });

  it("Beobachter einer Datenbank erfahren von Änderungen an ihren Properties", () => {
    const a = seeded();
    const seen: StoreChange[] = [];
    a.store.observe((c) => seen.push(c));
    dbops.renameProperty(a.store, a.db, a.notes, "Remarks");
    expect(seen[0]!.keys).toContain(keyOf("database", a.db));
    expect(seen[0]!.keys).toContain(keyOf("property", propertyRecordID(a.db, a.notes)));
  });

  it("Undo und Redo je Property; die Reihenfolge bleibt", () => {
    const a = seeded();
    const order = names(a.store, a.db);
    dbops.renameProperty(a.store, a.db, a.notes, "Remarks");
    const due = dbops.addProperty(a.store, a.db, "Due", "date")!;
    expect(names(a.store, a.db)).toContain("Due");
    a.store.undo();
    expect(names(a.store, a.db)).not.toContain("Due");
    expect(a.store.properties.has(propertyRecordID(a.db, due))).toBe(false);
    a.store.undo();
    expect(names(a.store, a.db)).toEqual(order);
    a.store.redo();
    a.store.redo();
    expect(names(a.store, a.db)).toContain("Remarks");
    expect(names(a.store, a.db)).toContain("Due");
  });

  it("Datenbank löschen nimmt ihre Property-Records mit; Papierkorb lässt sie stehen", () => {
    const a = seeded();
    const block = a.store.databases.get(a.db)!.blockID;
    trashPages(a.store, [block]);
    expect(a.store.propertyRecordsOf(a.db).length).toBeGreaterThan(0);
    a.store.transact("Remove", (tx) => tx.remove(keyOf("database", a.db)));
    expect(a.store.databases.has(a.db)).toBe(false);
    expect(a.store.propertyRecordsOf(a.db)).toEqual([]);
    expect(a.store.allRecords().some((r) => r.kind === "property" && r.data.databaseID === a.db)).toBe(false);
    a.store.undo();
    expect(names(a.store, a.db)).toEqual(expect.arrayContaining(["Name", "Status", "Notes"]));
  });

  it("eine fehlgeschlagene Transaktion hinterlässt nichts (auch keine halben Properties)", () => {
    const a = seeded();
    const before = a.store.allRecords();
    expect(() => a.store.transact("Boom", (tx) => {
      tx.put({ kind: "database", data: { ...a.store.databases.get(a.db)!, properties: [...a.store.databases.get(a.db)!.properties, { id: "x", name: "X", type: "text" }] } });
      throw new Error("boom");
    })).toThrow("boom");
    expect(a.store.allRecords()).toEqual(before);
    expect(names(a.store, a.db)).not.toContain("X");
  });

  it("zwei Properties mit derselben ID in eine aufgeteilte Datenbank schreiben: wird abgelehnt, nichts ändert sich", () => {
    const a = seeded();
    const db = a.store.databases.get(a.db)!;
    const before = a.store.allRecords();
    expect(() => a.store.transact("Dup", (tx) => tx.put({ kind: "database", data: { ...db, properties: [...db.properties, { ...db.properties[1]! }] } }))).toThrow(/same id/);
    expect(a.store.allRecords()).toEqual(before);
  });
});

describe("zwei Geräte", () => {
  function pair() {
    const a = seeded();
    const b = device("b");
    sync(a.store, b.store);
    expect(b.store.databases.get(a.db)).toEqual(a.store.databases.get(a.db));
    return { a, b };
  }

  it("gleichzeitig verschiedene Spalten geändert: beide Änderungen bleiben, beide Geräte gleich", () => {
    const { a, b } = pair();
    dbops.renameProperty(a.store, a.db, a.notes, "Remarks");
    dbops.addOption(b.store, a.db, a.status, "Open");
    dbops.addProperty(b.store, a.db, "Due", "date");
    sync(a.store, b.store);
    sync(b.store, a.store);
    for (const s of [a.store, b.store]) {
      const db = s.databases.get(a.db)!;
      expect(db.properties.find((p) => p.id === a.notes)!.name).toBe("Remarks");
      expect(db.properties.find((p) => p.id === a.status)!.options!.map((o) => o.name)).toEqual(["Open"]);
      expect(db.properties.map((p) => p.name)).toContain("Due");
    }
    expect(a.store.databases.get(a.db)).toEqual(b.store.databases.get(a.db));
  });

  it("im alten Format ginge dabei eine Änderung verloren (Gegenprobe)", () => {
    const a = device("a", { split: false });
    const page = createPage(a.store, { title: "Home" });
    const db = dbops.createDatabase(a.store, { parent: "b:" + page, title: "Tasks", sampleRows: 0 }).databaseID;
    const notes = dbops.addProperty(a.store, db, "Notes", "text")!, status = dbops.addProperty(a.store, db, "Status", "select")!;
    const b = device("b", { split: false });
    sync(a.store, b.store);
    dbops.renameProperty(a.store, db, notes, "Remarks");
    dbops.addOption(b.store, db, status, "Open");
    sync(a.store, b.store);
    sync(b.store, a.store);
    const merged = a.store.databases.get(db)!;
    const kept = [merged.properties.find((p) => p.id === notes)!.name === "Remarks", (merged.properties.find((p) => p.id === status)!.options ?? []).length === 1];
    expect(kept.filter(Boolean)).toHaveLength(1);
  });

  it("Spalte auf A gelöscht, auf B vorher geändert: bleibt gelöscht; auf B danach geändert: kommt zurück", () => {
    let wall = 5_000_000;
    const mk = () => {
      const a = device("a", { wall: () => wall });
      const page = createPage(a.store, { title: "Home" });
      const db = dbops.createDatabase(a.store, { parent: "b:" + page, title: "T", sampleRows: 0 }).databaseID;
      const notes = dbops.addProperty(a.store, db, "Notes", "text")!;
      const b = device("b", { wall: () => wall });
      sync(a.store, b.store);
      return { a, b, db, notes, key: keyOf("property", propertyRecordID(db, notes)) };
    };
    const first = mk();
    wall += 1000;
    dbops.renameProperty(first.b.store, first.db, first.notes, "Earlier edit");
    wall += 1000;
    dbops.deleteProperty(first.a.store, first.db, first.notes);
    sync(first.a.store, first.b.store, [first.key]);
    sync(first.b.store, first.a.store);
    for (const s of [first.a.store, first.b.store]) expect(names(s, first.db)).not.toContain("Earlier edit");

    const second = mk();
    wall += 1000;
    dbops.deleteProperty(second.a.store, second.db, second.notes);
    wall += 1000;
    dbops.renameProperty(second.b.store, second.db, second.notes, "Later edit");
    expect(sync(second.a.store, second.b.store, [second.key]).stale).toContain(second.key);
    sync(second.b.store, second.a.store);
    for (const s of [second.a.store, second.b.store]) expect(names(s, second.db)).toContain("Later edit");
  });

  it("Property-Record trifft vor seiner Datenbank ein: nichts sichtbar, bis der Kern da ist, dann vollständig", () => {
    const { a } = pair();
    const c = device("c");
    const props = a.store.allRecords().filter((r) => r.kind === "property");
    c.store.applyRemote(props);
    expect(c.store.databases.has(a.db)).toBe(false);
    c.store.applyRemote(a.store.allRecords().filter((r) => r.kind !== "property"));
    expect(c.store.databases.get(a.db)).toEqual(a.store.databases.get(a.db));
  });
});

describe("Umstellung beim Öffnen", () => {
  function oldFile() {
    const a = device("a", { split: false });
    const page = createPage(a.store, { title: "Home" });
    const db = dbops.createDatabase(a.store, { parent: "b:" + page, title: "Tasks" }).databaseID;
    const notes = dbops.addProperty(a.store, db, "Notes", "text")!;
    dbops.addProperty(a.store, db, "Status", "status");
    const row = dbops.addRow(a.store, db)!;
    dbops.setValue(a.store, row, notes, dbops.pv("text", [{ t: "hello" }]));
    return { ...a, db, notes, row, records: a.store.allRecords().map((r) => structuredClone(r)) };
  }

  it("Datenbanken im alten Format werden aufgeteilt; Sicht, Zeilen und Ansichten bleiben gleich; alte Liste eingefroren", () => {
    const old = oldFile();
    const before = structuredClone(old.store.databases.get(old.db)!);
    const p = new Recording(old.records);
    const s = new WorkspaceStore({ node: "a", persistence: p, propertyRecords: true });
    expect(s.databases.get(old.db)).toEqual(before);
    expect(s.unsplittable).toEqual([]);
    const core = s.record(keyOf("database", old.db))!.data as Database & { legacyProperties?: unknown };
    expect(core.properties).toEqual([]);
    expect(core.legacyProperties).toEqual(before.properties);
    expect(core.stamp).toEqual(before.stamp);
    expect(s.propertyRecordsOf(old.db).every((r) => compareStamps(r.stamp, before.stamp) === 0)).toBe(true);
    // genau eine Schreibrunde: Kerne und Property-Records, sonst nichts (keine Zeile, keine Ansicht, kein Block)
    expect(p.writes).toHaveLength(1);
    expect([...new Set(kinds(p.writes[0]!.upserts))]).toEqual(["database", "property"]);
    expect(s.blocks.get(old.row)).toEqual(old.store.blocks.get(old.row));
    expect([...s.views.values()]).toEqual([...old.store.views.values()]);
    // zweites Öffnen: nichts mehr zu tun
    const again = new WorkspaceStore({ node: "a", persistence: p, propertyRecords: true });
    expect(p.writes).toHaveLength(1);
    expect(again.databases.get(old.db)).toEqual(before);
    // die eingefrorene Liste bleibt bei späteren Änderungen, wie sie war
    dbops.renameProperty(again, old.db, old.notes, "Remarks");
    again.transact("Title", (tx) => tx.put({ kind: "database", data: { ...again.databases.get(old.db)!, title: [{ t: "Renamed" }] } }));
    expect((again.record(keyOf("database", old.db))!.data as typeof core).legacyProperties).toEqual(before.properties);
  });

  it("zwei Geräte stellen unabhängig um und gleichen danach ab: keine Dubletten, nichts ändert sich", () => {
    const old = oldFile();
    const a = new WorkspaceStore({ node: "a", persistence: new Recording(old.records), propertyRecords: true });
    const pb = new Recording(old.records);
    const b = new WorkspaceStore({ node: "b", persistence: pb, propertyRecords: true });
    expect(b.allRecords()).toEqual(a.allRecords());
    const writes = pb.writes.length;
    const r = b.applyRemote(a.allRecords());
    expect(r.stale).toEqual([]);
    expect(pb.writes).toHaveLength(writes);
    // A ändert danach eine Spalte: kommt bei B an
    dbops.renameProperty(a, old.db, old.notes, "After");
    b.applyRemote(a.allRecords());
    expect(names(b, old.db)).toContain("After");
  });

  it("ein Record im alten Format kommt später noch an (altes Archiv, alter Verlaufsstand): je Spalte gilt der neuere Stempel", () => {
    const old = oldFile();
    const s = new WorkspaceStore({ node: "a", persistence: new Recording(old.records), propertyRecords: true });
    dbops.renameProperty(s, old.db, old.notes, "Newer name");
    const legacy = old.records.find((r) => r.kind === "database" && r.data.id === old.db)!;
    // derselbe alte Stand noch einmal: ändert nichts
    s.transact("Import", (tx) => tx.put(structuredClone(legacy)), { keepStamps: true });
    expect(names(s, old.db)).toContain("Newer name");
    // ein neuerer alter Stand (z. B. von einem Gerät, das vor seiner Umstellung noch geändert hat)
    const later = structuredClone(legacy) as { kind: "database"; data: Database };
    later.data.stamp = { millis: Date.now() + 60_000, counter: 0, node: "z" };
    later.data.properties = later.data.properties.filter((p) => p.name !== "Status").map((p) => (p.id === old.notes ? { ...p, name: "From old client" } : p));
    s.applyRemote([later]);
    expect(names(s, old.db)).toContain("From old client");
    expect(names(s, old.db)).not.toContain("Status");
    expect((s.record(keyOf("database", old.db))!.data as Database).properties).toEqual([]);
  });

  it("Datenbank mit doppelter Property-ID bleibt im alten Format lesbar und beschreibbar und wird gemeldet", () => {
    const old = oldFile();
    const records = old.records.map((r) => structuredClone(r));
    const rec = records.find((r) => r.kind === "database")! as { kind: "database"; data: Database };
    rec.data.properties.push({ ...rec.data.properties[0]!, name: "Twin" });
    const s = new WorkspaceStore({ node: "a", persistence: new Recording(records), propertyRecords: true });
    expect(s.unsplittable).toEqual([old.db]);
    expect(names(s, old.db)).toContain("Twin");
    expect(s.propertyRecordsOf(old.db)).toEqual([]);
    s.transact("Title", (tx) => tx.put({ kind: "database", data: { ...s.databases.get(old.db)!, title: [{ t: "Still works" }] } }));
    expect(s.databases.get(old.db)!.title).toEqual([{ t: "Still works" }]);
    expect(names(s, old.db)).toContain("Twin");
  });

  it("ohne den Schalter bleibt alles beim Alten, Property-Records werden nur aufbewahrt", () => {
    const old = oldFile();
    const s = new WorkspaceStore({ node: "a", persistence: new Recording(old.records), propertyRecords: false });
    expect(s.propertyRecords).toBe(false);
    expect((s.record(keyOf("database", old.db))!.data as Database).properties.length).toBeGreaterThan(0);
    expect(s.allRecords().some((r) => r.kind === "property")).toBe(false);
  });
});
