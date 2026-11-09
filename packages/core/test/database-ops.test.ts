// BSD-155: Datenbank-Operationen (portiert aus DatabaseOps.swift / RelationIntegrity.swift): je ein Undo-Schritt,
// Reparaturen an Ansichten, Spiegeln und Rollups; Dashboard-Layout; Diagrammdaten; gefilterte Beobachtung.
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, QueryEngine, WorkspaceStore, addDashboardWidget, addOption, addProperty, addRow, addView, calculationOptions,
  calculationText, changeAffects, changePropertyType, chartNumber, chartPoints, conversionLoss, createDatabase, dashboardInsert,
  dashboardMove, dashboardRemove, dashboardSetWidth, databaseDependencies, deleteOption, deleteProperty, deleteView, duplicateProperty,
  duplicateRow, duplicateView, evenWidths, filledCellCount, formatNumber, makeRelationTwoWay, movePropertyInView, moveRowToGroup, moveView,
  pv, removeDashboardWidget, renameProperty, renamingFormulaReferences, renamingRelatedReferences, setCalculation, setColumnWidth,
  setFilter, setPropertyVisible, setRelationTarget, setSorts, setValue, setViewType, valueCase, viewsForBlock, visiblePropertyIDs,
  watchDatabase, wouldCreateRollupCycle, type StoreChange, type WireRecord,
} from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const opt = (id: string, name: string, color = "blue") => ({ id, name, color });

function fixture() {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "dbblk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "block", data: { id: "pblk", type: "databasePage", parent: "w", sk: "a1", props: { databaseID: "proj" }, createdAt: 0, updatedAt: 0, stamp } },
    {
      kind: "database",
      data: {
        id: "db", blockID: "dbblk", title: "Tasks", createdAt: 0, updatedAt: 0, stamp,
        properties: [
          { id: "title", name: "Name", type: "title" },
          { id: "st", name: "Status", type: "status", options: [opt("todo", "Todo", "gray"), opt("doing", "Doing"), opt("done", "Done", "green")], statusGroups: [{ id: "g", name: "To-do", color: "gray", optionIDs: ["todo", "doing", "done"] }] },
          { id: "est", name: "Estimate", type: "number" },
          { id: "tags", name: "Tags", type: "multiSelect", options: [opt("a", "A"), opt("b", "B")] },
          { id: "f", name: "Double", type: "formula", formula: 'prop("Estimate") * 2' },
          { id: "note", name: "Note", type: "text" },
          { id: "proj", name: "Project", type: "relation", relation: { databaseID: "proj" } },
        ],
      },
    },
    { kind: "database", data: { id: "proj", blockID: "pblk", title: "Projects", createdAt: 0, updatedAt: 0, stamp, properties: [{ id: "title", name: "Name", type: "title" }, { id: "cost", name: "Cost", type: "number" }] } },
    { kind: "view", data: { id: "v1", databaseID: "db", blockID: "dbblk", name: "Table", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp } },
    { kind: "view", data: { id: "v2", databaseID: "db", blockID: "dbblk", name: "Board", type: "board", sortKey: "a1", groupBy: { propertyID: "st", hiddenGroups: ["done"] }, createdAt: 0, updatedAt: 0, stamp } },
  ];
  const rows: [string, string, number, string][] = [["r1", "todo", 1, "a"], ["r2", "doing", 3, "b"], ["r3", "done", 5, "a"]];
  rows.forEach(([id, st, est, tag], i) => records.push({
    kind: "block",
    data: { id, type: "page", parent: "d:db", sk: "a" + i, text: id.toUpperCase(), values: { st: pv("status", st), est: pv("number", est), tags: pv("multiSelect", [tag]) }, createdAt: i, updatedAt: i, stamp },
  }));
  records.push({ kind: "block", data: { id: "p1", type: "page", parent: "d:proj", sk: "a0", text: "Alpha", values: { cost: pv("number", 10) }, createdAt: 0, updatedAt: 0, stamp } });
  records.push({ kind: "block", data: { id: "p2", type: "page", parent: "d:proj", sk: "a1", text: "Beta", values: { cost: pv("number", 20) }, createdAt: 0, updatedAt: 0, stamp } });
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });
  return store;
}
const val = (s: WorkspaceStore, row: string, prop: string) => valueCase(s.blocks.get(row)?.values?.[prop]);

describe("Datenbank anlegen", () => {
  it("createDatabase: Board mit Status-Gruppe und drei Beispielzeilen, ein Undo-Schritt", () => {
    const s = fixture();
    const c = createDatabase(s, { parent: "w", title: "Neu", viewType: "board", inline: false });
    const db = s.databases.get(c.databaseID)!;
    expect(db.properties.map((p) => p.type)).toEqual(["title", "status"]);
    expect(s.views.get(c.viewID)!.groupBy!.propertyID).toBe(db.properties[1]!.id);
    expect(s.blocks.get(c.blockID)!.props!.viewIDs).toEqual([c.viewID]);
    expect(s.children("d:" + c.databaseID)).toHaveLength(3);
    s.undo();
    expect(s.databases.has(c.databaseID)).toBe(false);
  });
});

describe("Zeilen", () => {
  it("addRow vergibt ID-Nummern und verlinkt two-way-Relationen, ein Undo-Schritt", () => {
    const s = fixture();
    addProperty(s, "db", "ID", "uniqueID");
    expect(val(s, "r1", s.databases.get("db")!.properties.at(-1)!.id)?.[1]).toBe(1);
    makeRelationTwoWay(s, "db", "proj");
    const mirror = s.databases.get("db")!.properties.find((p) => p.id === "proj")!.relation!.syncedPropertyID!;
    const id = addRow(s, "db", { title: "Neu", values: { proj: pv("relation", ["p1"]) } })!;
    const uid = s.databases.get("db")!.properties.find((p) => p.type === "uniqueID")!.id;
    expect(val(s, id, uid)?.[1]).toBe(4);
    expect(s.databases.get("db")!.nextUniqueID).toBe(5);
    expect(val(s, "p1", mirror)?.[1]).toEqual([id]);
    expect(s.children("d:db").at(-1)).toBe(id);
    s.undo();
    expect(s.blocks.has(id)).toBe(false);
    expect(val(s, "p1", mirror)).toBeUndefined();
  });

  it("addRow an Position: vor einer Zeile", () => {
    const s = fixture();
    const id = addRow(s, "db", { position: { before: "r2" } })!;
    expect(s.children("d:db")).toEqual(["r1", id, "r2", "r3"]);
  });

  it("setValue: Titel über setText, leeren mit null, Tippen zusammengefasst", () => {
    const s = fixture();
    setValue(s, "r1", "title", pv("text", "Hallo"));
    expect(s.blocks.get("r1")!.text).toBe("Hallo");
    setValue(s, "r1", "note", pv("text", "a"));
    setValue(s, "r1", "note", pv("text", "ab"));
    expect(val(s, "r1", "note")?.[1]).toBe("ab");
    s.undo();
    expect(val(s, "r1", "note")).toBeUndefined();
    setValue(s, "r1", "est", null);
    expect(s.blocks.get("r1")!.values!.est).toBeUndefined();
  });

  it("duplicateRow legt die Kopie direkt dahinter", () => {
    const s = fixture();
    const id = duplicateRow(s, "r1")!;
    expect(s.children("d:db").slice(0, 2)).toEqual(["r1", id]);
    expect(s.blocks.get(id)!.text).toBe("R1");
  });

  it("moveRowToGroup: Board-Karte wechselt Status und Position in einem Schritt", () => {
    const s = fixture();
    expect(moveRowToGroup(s, "r3", "st", "done", "todo", { before: "r1" })).toBe(true);
    expect(val(s, "r3", "st")?.[1]).toBe("todo");
    expect(s.children("d:db")[0]).toBe("r3");
    s.undo();
    expect(val(s, "r3", "st")?.[1]).toBe("done");
    expect(moveRowToGroup(s, "r1", "tags", "a", "b")).toBe(true);
    expect(val(s, "r1", "tags")?.[1]).toEqual(["b"]);
    expect(moveRowToGroup(s, "r1", "st", "todo", "")).toBe(true);
    expect(s.blocks.get("r1")!.values!.st).toBeUndefined();
    expect(moveRowToGroup(s, "r1", "f", "x", "y")).toBe(false);
  });
});

describe("Properties", () => {
  it("addProperty: eindeutiger Name, sichtbar in der Ansicht nach `after`", () => {
    const s = fixture();
    const id = addProperty(s, "db", "Note", "text", { after: "title", showIn: "v2" })!;
    const db = s.databases.get("db")!;
    expect(db.properties[1]!.id).toBe(id);
    expect(db.properties[1]!.name).toBe("Note 2");
    expect(visiblePropertyIDs(s.views.get("v2")!, db)).toEqual(["title", id]);
    const st = addProperty(s, "db", "Phase", "status")!;
    expect(s.databases.get("db")!.properties.find((p) => p.id === st)!.statusGroups).toHaveLength(3);
  });

  it("renameProperty zieht prop(\"…\") in Formeln mit (ein Undo-Schritt)", () => {
    const s = fixture();
    renameProperty(s, "db", "est", "Punkte");
    expect(s.databases.get("db")!.properties.find((p) => p.id === "f")!.formula).toBe('prop("Punkte") * 2');
    s.undo();
    const db = s.databases.get("db")!;
    expect(db.properties.find((p) => p.id === "est")!.name).toBe("Estimate");
    expect(db.properties.find((p) => p.id === "f")!.formula).toBe('prop("Estimate") * 2');
  });

  it("renamingFormulaReferences/renamingRelatedReferences", () => {
    expect(renamingFormulaReferences('prop("A") + x.prop("A") + prop( "A" )', "A", 'B"')).toBe('prop("B\\"") + x.prop("A") + prop("B\\"")');
    expect(renamingRelatedReferences('prop("Rel").map(current.prop("Cost")).sum() + prop("Cost")', new Set(["Rel"]), "Cost", "Preis"))
      .toBe('prop("Rel").map(current.prop("Preis")).sum() + prop("Cost")');
  });

  it("deleteProperty räumt Ansichten (Sortierung, Filter, Gruppe, Berechnung) auf", () => {
    const s = fixture();
    setSorts(s, "v1", [{ propertyID: "st", ascending: true }, { propertyID: "est", ascending: false }]);
    setFilter(s, "v1", { combinator: "and", items: [{ condition: { _0: { id: "c", propertyID: "st", op: "equals", value: { options: { _0: ["todo"] } } } } }] });
    setCalculation(s, "v1", "st", "countAll");
    expect(filledCellCount(s, "db", "st")).toBe(3);
    deleteProperty(s, "db", "st");
    const v1 = s.views.get("v1")!, v2 = s.views.get("v2")!;
    expect(v1.sorts).toEqual([{ propertyID: "est", ascending: false }]);
    expect(v1.filter?.items).toEqual([]);
    expect(v1.calculations).toEqual({});
    expect(v2.groupBy).toBeUndefined();
    expect(s.blocks.get("r1")!.values!.st).toBeUndefined();
    deleteProperty(s, "db", "title");
    expect(s.databases.get("db")!.properties[0]!.id).toBe("title");
  });

  it("duplicateProperty kopiert Werte", () => {
    const s = fixture();
    const id = duplicateProperty(s, "db", "est")!;
    expect(s.databases.get("db")!.properties.find((p) => p.id === id)!.name).toBe("Estimate 2");
    expect(val(s, "r2", id)?.[1]).toBe(3);
  });

  it("changePropertyType wandelt Werte um; conversionLoss warnt vorher", () => {
    const s = fixture();
    setValue(s, "r1", "note", pv("text", "12"));
    setValue(s, "r2", "note", pv("text", "viel"));
    expect(conversionLoss(s, "db", "note", "number")).toBe(1);
    changePropertyType(s, "db", "note", "number");
    expect(val(s, "r1", "note")?.[1]).toBe(12);
    expect(s.blocks.get("r2")!.values!.note).toBeUndefined();
    s.undo();
    expect(val(s, "r2", "note")?.[1]).toBe("viel");
    changePropertyType(s, "db", "note", "select");
    const p = s.databases.get("db")!.properties.find((x) => x.id === "note")!;
    expect(p.options!.map((o) => o.name)).toEqual(["12", "viel"]);
  });

  it("Relation: two-way, Zielwechsel räumt Spiegel und Werte auf", () => {
    const s = fixture();
    setValue(s, "r1", "proj", pv("relation", ["p1", "p2"]));
    const m = makeRelationTwoWay(s, "db", "proj")!;
    expect(s.databases.get("proj")!.properties.find((p) => p.id === m)!.name).toBe("Related to Tasks");
    expect(val(s, "p2", m)?.[1]).toEqual(["r1"]);
    setRelationTarget(s, "db", "proj", "db");
    expect(s.databases.get("proj")!.properties.some((p) => p.id === m)).toBe(false);
    expect(s.blocks.get("r1")!.values!.proj).toBeUndefined();
    expect(s.databases.get("db")!.properties.find((p) => p.id === "proj")!.relation).toEqual({ databaseID: "db" });
  });

  it("wouldCreateRollupCycle erkennt Rollups, die sich selbst lesen", () => {
    const s = fixture();
    const m = makeRelationTwoWay(s, "db", "proj")!;
    const back = addProperty(s, "proj", "Sum", "rollup")!;
    s.transact("cfg", (tx) => {
      const d = structuredClone(s.databases.get("proj")!);
      d.properties.find((p) => p.id === back)!.rollup = { relationPropertyID: m, targetPropertyID: "est", function: "sum" };
      tx.put({ kind: "database", data: d });
    });
    const roll = addProperty(s, "db", "Kosten", "rollup")!;
    expect(wouldCreateRollupCycle(s, "db", roll, "proj", "cost")).toBe(false);
    expect(wouldCreateRollupCycle(s, "proj", back, m, "f")).toBe(false);
    s.transact("cfg2", (tx) => {
      const d = structuredClone(s.databases.get("db")!);
      d.properties.find((p) => p.id === roll)!.rollup = { relationPropertyID: "proj", targetPropertyID: back, function: "sum" };
      tx.put({ kind: "database", data: d });
    });
    expect(wouldCreateRollupCycle(s, "proj", back, m, roll)).toBe(true);
  });

  it("Optionen: anlegen (Status-Gruppe), löschen bereinigt Werte, Filter und Gruppen", () => {
    const s = fixture();
    expect(addOption(s, "db", "st", "doing")).toBe("doing");
    const id = addOption(s, "db", "st", "Blocked")!;
    expect(s.databases.get("db")!.properties.find((p) => p.id === "st")!.statusGroups![0]!.optionIDs).toContain(id);
    setFilter(s, "v2", { combinator: "and", items: [{ condition: { _0: { id: "c", propertyID: "st", op: "equals", value: { options: { _0: ["done"] } } } } }] });
    deleteOption(s, "db", "st", "done");
    expect(s.blocks.get("r3")!.values!.st).toBeUndefined();
    const v2 = s.views.get("v2")!;
    expect(v2.groupBy!.hiddenGroups).toEqual([]);
    const cond = (v2.filter!.items[0] as { condition: { _0: { value?: unknown } } }).condition._0;
    expect(cond.value).toBeUndefined();
  });
});

describe("Ansichten", () => {
  it("addView legt fehlende Properties an; Tabs nach sortKey; deleteView behält die letzte", () => {
    const s = fixture();
    const cal = addView(s, "dbblk", "calendar")!;
    expect(s.views.get(cal)!.datePropertyID).toBeDefined();
    expect(s.databases.get("db")!.properties.at(-1)!.type).toBe("date");
    expect(viewsForBlock(s, "dbblk").map((v) => v.id)).toEqual(["v1", "v2", cal]);
    moveView(s, cal, "v1");
    expect(viewsForBlock(s, "dbblk").map((v) => v.id)).toEqual([cal, "v1", "v2"]);
    const dup = duplicateView(s, "v1")!;
    expect(viewsForBlock(s, "dbblk").map((v) => v.id)).toEqual([cal, "v1", dup, "v2"]);
    expect(s.views.get(dup)!.name).toBe("Table (1)");
    for (const v of [cal, "v1", dup]) deleteView(s, v);
    expect(viewsForBlock(s, "dbblk").map((v) => v.id)).toEqual(["v2"]);
    deleteView(s, "v2");
    expect(s.views.has("v2")).toBe(true);
  });

  it("setViewType ergänzt Vorgaben des neuen Layouts", () => {
    const s = fixture();
    setViewType(s, "v1", "board");
    expect(s.views.get("v1")!.groupBy).toEqual({ propertyID: "st" });
    setViewType(s, "v1", "chart");
    expect(s.views.get("v1")!.chart!.xPropertyID).toBe("st");
  });

  it("Properties zeigen/verstecken/verschieben und Spaltenbreite", () => {
    const s = fixture();
    const db = () => s.databases.get("db")!;
    expect(visiblePropertyIDs(s.views.get("v1")!, db())).toEqual(["title", "st", "est", "tags", "f", "note", "proj"]);
    setPropertyVisible(s, "v1", "est", false);
    expect(visiblePropertyIDs(s.views.get("v1")!, db())).not.toContain("est");
    movePropertyInView(s, "v1", "note", 1);
    expect(visiblePropertyIDs(s.views.get("v1")!, db()).slice(0, 2)).toEqual(["title", "note"]);
    setColumnWidth(s, "v1", "note", 240);
    setColumnWidth(s, "v1", "note", 260);
    expect(s.views.get("v1")!.properties!.find((p) => p.id === "note")!.width).toBe(260);
    s.undo();
    expect(s.views.get("v1")!.properties!.find((p) => p.id === "note")!.width).toBeUndefined();
    // Board zeigt neue Properties nicht automatisch
    expect(visiblePropertyIDs(s.views.get("v2")!, db())).toEqual(["title"]);
  });

  it("Dashboard: neue Dashboard-Ansicht mit Widgets, hinzufügen/entfernen", () => {
    const s = fixture();
    const dash = addView(s, "dbblk", "dashboard")!;
    const d = s.views.get(dash)!;
    expect(d.dashboard!.rows.map((r) => r.widgets.length)).toEqual([2, 1]);
    expect(viewsForBlock(s, "dbblk").map((v) => v.id)).toEqual(["v1", "v2", dash]);
    const w = addDashboardWidget(s, dash, "board", { rowIndex: 1, newRow: false })!;
    expect(s.views.get(dash)!.dashboard!.rows[1]!.widgets.map((x) => x.width)).toEqual([6, 6]);
    removeDashboardWidget(s, dash, w);
    expect(s.views.has(w)).toBe(false);
    expect(s.views.get(dash)!.dashboard!.rows[1]!.widgets.map((x) => x.width)).toEqual([12]);
    const widgets = d.dashboard!.rows.flatMap((r) => r.widgets.map((x) => x.viewID));
    deleteView(s, dash);
    for (const x of widgets) expect(s.views.has(x)).toBe(false);
  });

  it("Dashboard-Layout (rein): einfügen, Breite, verschieben", () => {
    expect(evenWidths(5)).toEqual([3, 3, 2, 2, 2]);
    let c = dashboardInsert({ rows: [] }, "a", undefined, true);
    c = dashboardInsert(c, "b", 0, false);
    c = dashboardInsert(c, "c", 0, false);
    expect(c.rows[0]!.widgets.map((w) => w.width)).toEqual([4, 4, 4]);
    c = dashboardSetWidth(c, "a", 6);
    expect(c.rows[0]!.widgets.map((w) => w.width)).toEqual([6, 2, 4]);
    c = dashboardMove(c, "c", 1, undefined, true);
    expect(c.rows.map((r) => r.widgets.map((w) => w.viewID))).toEqual([["a", "b"], ["c"]]);
    c = dashboardMove(c, "a", 0, 2);
    expect(c.rows[0]!.widgets.map((w) => w.viewID)).toEqual(["b", "a"]);
    c = dashboardRemove(c, "c");
    expect(c.rows).toHaveLength(1);
  });
});

describe("Diagramm, Berechnungen, Anzeige", () => {
  it("chartPoints nach Status (Options-Reihenfolge), Summe und Limit", () => {
    const s = fixture();
    const e = new QueryEngine(s);
    const db = s.databases.get("db")!;
    const rows = e.run(s.views.get("v1")!).rows;
    const base = { kind: "bar", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false };
    expect(chartPoints(e, rows, db, { ...base, xPropertyID: "st" }).map((p) => [p.label, p.value])).toEqual([["Todo", 1], ["Doing", 1], ["Done", 1]]);
    expect(chartPoints(e, rows, db, { ...base, xPropertyID: "tags", yPropertyID: "est", aggregate: "sum" }).map((p) => [p.label, p.value])).toEqual([["A", 6], ["B", 3]]);
    expect(chartPoints(e, rows, db, { ...base, xPropertyID: "est", sortByValue: true, limit: 1 }).map((p) => p.label)).toEqual(["1", "Other"]);
    expect(chartNumber(e, rows, db, { ...base, kind: "number" })).toBe(3);
    expect(chartNumber(e, rows, db, { ...base, kind: "number", yPropertyID: "f", aggregate: "average" })).toBe(6);
  });

  it("calculationText und Zahlformate", () => {
    const s = fixture();
    const e = new QueryEngine(s);
    const db = s.databases.get("db")!;
    const rows = e.run(s.views.get("v1")!).rows;
    const est = db.properties.find((p) => p.id === "est")!;
    expect(calculationText(e, "sum", est, rows, db)).toBe("9");
    expect(calculationText(e, "percentNotEmpty", db.properties.find((p) => p.id === "note")!, rows, db)).toBe("0%");
    expect(calculationText(e, "none", est, rows, db)).toBeUndefined();
    expect(calculationOptions("checkbox")).toContain("percentChecked");
    expect(formatNumber(1234.5, "dollar")).toBe("$1,234.50");
    expect(formatNumber(-3, "euro")).toBe("-€3.00");
    expect(formatNumber(1234.567, "numberWithCommas")).toBe("1,234.57");
    expect(formatNumber(12.5, "percent")).toBe("12.5%");
    expect(formatNumber(1500, "yen")).toBe("¥1,500");
  });
});

describe("Gefilterte Beobachtung", () => {
  it("nur Änderungen der eigenen (oder verknüpften) Datenbank lösen aus", () => {
    const s = fixture();
    expect([...databaseDependencies(s, "db")].sort()).toEqual(["db", "proj"]);
    expect([...databaseDependencies(s, "proj")]).toEqual(["proj"]);
    const seen: StoreChange[] = [];
    const stop = watchDatabase(s, "proj", (c) => seen.push(c));
    setValue(s, "r1", "est", pv("number", 9)); // andere Datenbank
    expect(seen).toHaveLength(0);
    setValue(s, "p1", "cost", pv("number", 11));
    expect(seen).toHaveLength(1);
    s.transact("Seite", (tx) => tx.put({ kind: "block", data: { id: "x", type: "page", parent: "w", sk: "b0", createdAt: 0, updatedAt: 0 } }));
    expect(seen).toHaveLength(1);
    stop();
    const deps = databaseDependencies(s, "db");
    expect(changeAffects(s, deps, { keys: ["block:p2"], origin: "remote" })).toBe(true);
    expect(changeAffects(s, deps, { keys: ["block:x", "workspace:workspace"], origin: "local" })).toBe(false);
    expect(changeAffects(s, deps, { keys: ["view:v2"], origin: "local" })).toBe(true);
  });
});
