// BSD-30: Properties als eigene Records – Aufteilen, Zusammensetzen, Unterschiede, Zusammenführen, Prüfer.
import { describe, expect, it } from "vitest";
import { compareStamps, createPage, dbops, MemoryPersistence, WorkspaceStore, type Database, type PropertySchema, type Stamp } from "../src/index.js";
import {
  checkSchemas, diffProperties, dryRunMigration, formatMigrationReport, isSplit, joinDatabase, mergePropertyRecords, propertyRecordID,
  restoreLegacy, sameJSON, splitDatabase, viewPropertyReferences, type PropertyRecord,
} from "../src/model/property-records.js";

const stamp = (millis: number, node = "a"): Stamp => ({ millis, counter: 0, node });
const prop = (id: string, name = id, extra: Partial<PropertySchema> = {}): PropertySchema => ({ id, name, type: "text", ...extra });
const db = (properties: PropertySchema[], s = stamp(100)): Database => ({
  id: "db1", blockID: "blk1", title: [{ t: "Tasks" }], properties: [{ id: "title", name: "Name", type: "title" }, ...properties], createdAt: 1, updatedAt: 2, stamp: s,
} as Database);
const split = (d: Database) => {
  const s = splitDatabase(d);
  if (!s.ok) throw new Error(s.reason);
  return s;
};
/** Wendet einen Unterschied an, wie der Store es tun wird. */
const apply = (records: PropertyRecord[], next: PropertySchema[], s: Stamp) => {
  const d = diffProperties("db1", records, next, s);
  const gone = new Set(d.removed), changed = new Map(d.upserts.map((r) => [r.id, r]));
  return { records: [...records.filter((r) => !gone.has(r.id) && !changed.has(r.id)), ...d.upserts], diff: d };
};

describe("aufteilen und zusammensetzen", () => {
  const original = db([prop("a", "Status", { type: "select", options: [{ id: "o1", name: "Open", color: "blue" }] }), prop("b"), prop("c", "Sum", { type: "formula", formula: "1 + 1" })]);

  it("deterministisch: IDs aus Datenbank und Property, Stempel der Datenbank, Reihenfolge aus der Position", () => {
    const s = split(original), again = split(structuredClone(original));
    expect(s.properties.map((r) => r.id)).toEqual(["db1/title", "db1/a", "db1/b", "db1/c"]);
    expect(s.properties.every((r) => compareStamps(r.stamp, original.stamp) === 0 && r.databaseID === "db1")).toBe(true);
    expect(s.properties.map((r) => r.sk)).toEqual([...s.properties.map((r) => r.sk)].sort());
    expect(new Set(s.properties.map((r) => r.sk)).size).toBe(4);
    expect(again).toEqual(s);
    expect(propertyRecordID("db1", "title")).toBe("db1/title");
  });

  it("Kern ohne Properties, alte Liste eingefroren; zusammengesetzt wieder die ursprüngliche Datenbank", () => {
    const s = split(original);
    expect(s.core.properties).toEqual([]);
    expect(s.core.legacyProperties).toEqual(original.properties);
    expect(isSplit(s.core)).toBe(true);
    expect(isSplit(original)).toBe(false);
    expect(joinDatabase(s.core, s.properties)).toEqual(original);
    expect(joinDatabase(s.core, [...s.properties].reverse())).toEqual(original);
    expect(restoreLegacy(s.core)).toEqual(original);
    // Records einer anderen Datenbank zählen nicht
    expect(joinDatabase(s.core, [...s.properties, { ...s.properties[1]!, id: "other/a", databaseID: "other" }])).toEqual(original);
    // nichts hängt am Original (keine geteilten Objekte)
    s.properties[1]!.schema.name = "changed";
    expect(original.properties[1]!.name).toBe("Status");
  });

  it("unbekannte Felder einer neueren Version bleiben erhalten", () => {
    const future = db([{ ...prop("a"), futureField: { x: [1, 2] } } as PropertySchema]);
    (future as Record<string, unknown>).futureDatabaseField = "kept";
    const s = split(future);
    expect(joinDatabase(s.core, s.properties)).toEqual(future);
  });

  it("zwei Properties mit derselben ID: wird nicht aufgeteilt (nichts geht verloren)", () => {
    const r = splitDatabase(db([prop("a"), prop("a", "again")]));
    expect(r).toEqual({ ok: false, reason: "property id “a” appears twice" });
    expect(() => diffProperties("db1", [], [prop("a"), prop("a")], stamp(1))).toThrow();
  });

  it("leere Datenbank (nur Titel) und ganz ohne Properties", () => {
    for (const d of [db([]), { ...db([]), properties: [] } as Database]) {
      const s = split(d);
      expect(joinDatabase(s.core, s.properties)).toEqual(d);
    }
  });
});

describe("Unterschiede: nur Geändertes bekommt einen neuen Stempel", () => {
  const base = db([prop("a"), prop("b"), prop("c"), prop("d")]);
  const records = split(base).properties;
  const names = (rs: PropertyRecord[]) => joinDatabase(split(base).core, rs).properties.map((p) => p.id);

  it("nichts geändert: nichts zu schreiben", () => {
    expect(diffProperties("db1", records, base.properties, stamp(200))).toEqual({ upserts: [], removed: [] });
  });

  it("eine Property umbenannt: genau ein Record", () => {
    const next = base.properties.map((p) => (p.id === "b" ? { ...p, name: "Renamed" } : p));
    const { diff, records: after } = apply(records, next, stamp(200));
    expect(diff.upserts.map((r) => [r.id, r.stamp.millis, r.schema.name])).toEqual([["db1/b", 200, "Renamed"]]);
    expect(diff.removed).toEqual([]);
    expect(after.filter((r) => r.id !== "db1/b").every((r) => r.stamp.millis === 100)).toBe(true);
    expect(diff.upserts[0]!.sk).toBe(records.find((r) => r.id === "db1/b")!.sk);
  });

  it("neu am Ende, in der Mitte, am Anfang: ein Record, Schlüssel zwischen den Nachbarn", () => {
    for (const at of [5, 2, 0]) {
      const next = [...base.properties];
      next.splice(at, 0, prop("new"));
      const { diff, records: after } = apply(records, next, stamp(200));
      expect(diff.upserts.map((r) => r.id)).toEqual(["db1/new"]);
      expect(names(after)).toEqual(next.map((p) => p.id));
    }
  });

  it("entfernt: Record-ID in removed, sonst nichts", () => {
    const { diff, records: after } = apply(records, base.properties.filter((p) => p.id !== "c"), stamp(200));
    expect(diff).toEqual({ upserts: [], removed: ["db1/c"] });
    expect(names(after)).toEqual(["title", "a", "b", "d"]);
  });

  it("verschoben: nur die bewegte Property wird neu geschrieben (letzte nach vorn, erste nach hinten)", () => {
    const toFront = [base.properties[4]!, ...base.properties.slice(0, 4)];
    const f = apply(records, toFront, stamp(200));
    expect(f.diff.upserts.map((r) => r.id)).toEqual(["db1/d"]);
    expect(names(f.records)).toEqual(["d", "title", "a", "b", "c"]);
    const toBack = [...base.properties.slice(1), base.properties[0]!];
    const b = apply(records, toBack, stamp(200));
    expect(b.diff.upserts.map((r) => r.id)).toEqual(["db1/title"]);
    expect(names(b.records)).toEqual(["a", "b", "c", "d", "title"]);
  });

  it("Records anderer Datenbanken bleiben unberührt", () => {
    const foreign: PropertyRecord = { id: "other/x", databaseID: "other", sk: "a0", schema: prop("x"), stamp: stamp(1) };
    expect(diffProperties("db1", [...records, foreign], base.properties, stamp(200))).toEqual({ upserts: [], removed: [] });
  });

  it("beliebige Folgen von Änderungen: die Sicht ist immer genau die gewünschte Liste, Schlüssel bleiben eindeutig", () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let current = [...base.properties], recs = records, counter = 0;
    for (let step = 0; step < 400; step++) {
      const next = [...current];
      const op = rnd(5);
      if (op === 0 || next.length < 2) next.splice(rnd(next.length + 1), 0, prop("n" + counter++));
      else if (op === 1) next.splice(rnd(next.length), 1);
      else if (op === 2) { const [m] = next.splice(rnd(next.length), 1); next.splice(rnd(next.length + 1), 0, m!); }
      else if (op === 3) { const i = rnd(next.length); next[i] = { ...next[i]!, name: "r" + step }; }
      else next.reverse();
      const r = apply(recs, next, stamp(1000 + step));
      recs = r.records;
      expect(names(recs)).toEqual(next.map((p) => p.id));
      expect(new Set(recs.map((x) => x.sk)).size).toBe(recs.length);
      // nur was sich geändert oder bewegt hat, trägt den neuen Stempel
      const untouched = next.filter((p, i) => current[i] === p && current.length === next.length);
      for (const p of untouched) if (op === 3) expect(recs.find((x) => x.id === "db1/" + p.id)!.stamp.millis).not.toBe(1000 + step);
      current = next;
    }
  });
});

describe("zusammenführen: zwei Geräte ändern gleichzeitig verschiedene Spalten", () => {
  const base = db([prop("status", "Status", { type: "select", options: [{ id: "o1", name: "Open", color: "blue" }] }), prop("notes", "Notes")]);
  const start = split(base);

  it("Umbenennen auf dem Mac und neue Option am Handy: beide bleiben (mit dem alten Format ginge eine verloren)", () => {
    const mac = base.properties.map((p) => (p.id === "notes" ? { ...p, name: "Remarks" } : p));
    const phone = base.properties.map((p) => (p.id === "status" ? { ...p, options: [...p.options!, { id: "o2", name: "Done", color: "green" as const }] } : p));
    const a = apply(start.properties, mac, stamp(200, "mac")).records;
    const b = apply(start.properties, phone, stamp(210, "phone")).records;
    const merged = joinDatabase(start.core, mergePropertyRecords(a, b));
    expect(merged.properties.find((p) => p.id === "notes")!.name).toBe("Remarks");
    expect(merged.properties.find((p) => p.id === "status")!.options!.map((o) => o.name)).toEqual(["Open", "Done"]);
    // symmetrisch
    expect(mergePropertyRecords(b, a)).toEqual(mergePropertyRecords(a, b));
    // altes Format: ein Record, der spätere gewinnt – das Umbenennen ist weg
    const old = compareStamps(stamp(210, "phone"), stamp(200, "mac")) > 0 ? phone : mac;
    expect(old.find((p) => p.id === "notes")!.name).toBe("Notes");
  });

  it("beide legen gleichzeitig eine Spalte an: beide da, Reihenfolge auf beiden Geräten gleich", () => {
    const a = apply(start.properties, [...base.properties, prop("fromMac")], stamp(200, "mac")).records;
    const b = apply(start.properties, [...base.properties, prop("fromPhone")], stamp(200, "phone")).records;
    const ab = joinDatabase(start.core, mergePropertyRecords(a, b)).properties.map((p) => p.id);
    const ba = joinDatabase(start.core, mergePropertyRecords(b, a)).properties.map((p) => p.id);
    expect(ab).toEqual(ba);
    expect([...ab].sort()).toEqual(["fromMac", "fromPhone", "notes", "status", "title"]);
  });

  it("dieselbe Spalte auf beiden geändert: die spätere Änderung gewinnt ganz (wie bisher, nur je Spalte)", () => {
    const a = apply(start.properties, base.properties.map((p) => (p.id === "notes" ? { ...p, name: "A" } : p)), stamp(200, "mac")).records;
    const b = apply(start.properties, base.properties.map((p) => (p.id === "notes" ? { ...p, name: "B" } : p)), stamp(201, "phone")).records;
    expect(joinDatabase(start.core, mergePropertyRecords(a, b)).properties.find((p) => p.id === "notes")!.name).toBe("B");
  });

  it("Löschen gegen Ändern: der spätere Stempel entscheidet", () => {
    const edited = apply(start.properties, base.properties.map((p) => (p.id === "notes" ? { ...p, name: "Kept" } : p)), stamp(300, "mac")).records;
    const deletedEarlier = mergePropertyRecords(edited, [], new Map([["db1/notes", stamp(250, "phone")]]));
    expect(deletedEarlier.some((r) => r.id === "db1/notes")).toBe(true);
    const deletedLater = mergePropertyRecords(edited, [], new Map([["db1/notes", stamp(350, "phone")]]));
    expect(deletedLater.some((r) => r.id === "db1/notes")).toBe(false);
  });

  it("zwei Geräte migrieren unabhängig, eines hat danach geändert: keine Dubletten, die Änderung bleibt", () => {
    const deviceA = split(base).properties, deviceB = split(structuredClone(base)).properties;
    const changed = apply(deviceA, base.properties.map((p) => (p.id === "notes" ? { ...p, name: "After" } : p)), stamp(500, "mac")).records;
    const merged = mergePropertyRecords(deviceB, changed);
    expect(merged).toHaveLength(3);
    expect(merged.find((r) => r.id === "db1/notes")!.schema.name).toBe("After");
    expect(mergePropertyRecords(changed, deviceB)).toEqual(merged);
  });
});

describe("Prüfer und Probelauf", () => {
  function workspace() {
    let t = 0;
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1), propertyRecords: false });
    const page = createPage(store, { title: "Home" });
    const clients = dbops.createDatabase(store, { parent: "b:" + page, title: "Clients" });
    const revenue = dbops.addProperty(store, clients.databaseID, "Revenue", "number")!;
    const tasks = dbops.createDatabase(store, { parent: "b:" + page, title: "Tasks" });
    const rel = dbops.addProperty(store, tasks.databaseID, "Client", "relation")!;
    dbops.setRelationTarget(store, tasks.databaseID, rel, clients.databaseID);
    const roll = dbops.addProperty(store, tasks.databaseID, "Sum", "rollup")!;
    dbops.setRollup(store, tasks.databaseID, roll, { relationPropertyID: rel, targetPropertyID: revenue, function: "sum" });
    dbops.addProperty(store, tasks.databaseID, "Status", "status");
    const row = dbops.addRow(store, tasks.databaseID)!;
    dbops.setValue(store, row, revenue, dbops.pv("number", 1)); // Wert für eine Property, die es in Tasks nicht gibt
    return { store, tasks, clients, rel, roll, revenue, row };
  }

  it("ein gebauter Workspace mit Relation, Rollup, Status, Ansichten und Zeilen besteht den Probelauf", () => {
    const w = workspace();
    const report = dryRunMigration(w.store.allRecords());
    expect(report.roundTripFailures).toEqual([]);
    expect(report.issuesChanged).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.databases).toBe(2);
    expect(report.properties).toBe([...w.store.databases.values()].reduce((n, d) => n + d.properties.length, 0));
    expect(report.rows).toBeGreaterThan(0);
    // die Altlast (verwaister Wert) wird gezählt, verhindert die Umstellung aber nicht
    expect(report.issuesBefore.orphanValue).toBe(1);
    expect(formatMigrationReport(report)).toContain("Result: OK");
  });

  it("findet: verwaisten Wert, Verweise einer Ansicht, Rollup ohne Ziel, Relation ins Leere, fehlenden Titel", () => {
    const w = workspace();
    const dbs = [...w.store.databases.values()].map((d) => structuredClone(d)), views = [...w.store.views.values()].map((v) => structuredClone(v));
    const tasks = dbs.find((d) => d.id === w.tasks.databaseID)!, clients = dbs.find((d) => d.id === w.clients.databaseID)!;
    const view = views.find((v) => v.databaseID === tasks.id)!;
    view.sorts = [{ propertyID: "gone1", ascending: true }];
    view.filter = { combinator: "and", items: [{ group: { _0: { combinator: "or", items: [{ condition: { _0: { id: "c", propertyID: "gone2", op: "isEmpty" } } }] } } }] };
    view.groupBy = { propertyID: "gone3" };
    view.datePropertyID = "gone4";
    expect(viewPropertyReferences(view).map((r) => r.propertyID)).toEqual(expect.arrayContaining(["gone1", "gone2", "gone3", "gone4"]));
    clients.properties = clients.properties.filter((p) => p.id !== w.revenue && p.type !== "title");
    const kinds = (list: ReturnType<typeof checkSchemas>) => [...new Set(list.map((i) => i.kind))].sort();
    const issues = checkSchemas(dbs, views, w.store.blocks.values());
    expect(kinds(issues)).toEqual(["missingTitle", "orphanValue", "rollupReference", "viewReference"]);
    expect(issues.filter((i) => i.kind === "viewReference" && i.subject === view.id)).toHaveLength(4);
    // Relation ins Leere, Ansicht ohne Datenbank
    const alone = checkSchemas([tasks], views, []);
    expect(kinds(alone)).toEqual(expect.arrayContaining(["relationTarget", "viewWithoutDatabase"]));
  });

  it("meldet, wenn eine Datenbank nicht aufteilbar ist, und fasst schon aufgeteilte nicht an", () => {
    const w = workspace();
    const records = w.store.allRecords().map((r) => structuredClone(r));
    const first = records.find((r) => r.kind === "database")!;
    if (first.kind === "database") first.data.properties.push({ ...first.data.properties[0]! });
    const bad = dryRunMigration(records);
    expect(bad.ok).toBe(false);
    expect(bad.refused).toHaveLength(1);
    expect(formatMigrationReport(bad)).toContain("NOT OK");
    const done = w.store.allRecords().map((r) => (r.kind === "database" ? { kind: r.kind, data: (splitDatabase(r.data) as { core: Database }).core } : r));
    expect(dryRunMigration(done).alreadySplit).toBe(2);
  });

  it("sameJSON: Schlüsselreihenfolge egal, undefined wie fehlend, Listenreihenfolge zählt", () => {
    expect(sameJSON({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJSON({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJSON([1, 2], [2, 1])).toBe(false);
    expect(sameJSON({ a: null }, { a: 0 })).toBe(false);
  });
});
