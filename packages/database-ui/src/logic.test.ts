// BSD-155: View-Logik ohne DOM – Filter bearbeiten/beschreiben, flache Listen für die Virtualisierung,
// Werte der Editoren, Werte neuer Zeilen (Gruppe + Filter), Agent-Strich, nur Token-Farben im CSS.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, QueryEngine, WorkspaceStore, pv, setFilter, type Block, type Database, type DatabaseView, type FilterGroup, type WireRecord,
} from "@based/core";
import {
  addItem, conditionItem, countConditions, describeCondition, groupItem, isComplete, itemAt, newCondition, removeItem, replaceItem,
  setCombinator, topConditions, valueKind, EMPTY_FILTER,
} from "./logic/filters.js";
import { columnWidth, flatten, galleryColumns, nextRowIndex } from "./logic/layout.js";
import { defaultIsAgentEdit, editText, fromInputValue, optionTone, parseNumberInput, parseTextInput, toInputValue, withDate } from "./logic/values.js";
import { groupProperty, newRowValues } from "./layouts/shared.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const db: Database = {
  id: "db", blockID: "blk", title: "T", createdAt: 0, updatedAt: 0, stamp,
  properties: [
    { id: "title", name: "Name", type: "title" },
    { id: "st", name: "Status", type: "status", options: [{ id: "a", name: "Todo", color: "gray" }, { id: "b", name: "Done", color: "green" }] },
    { id: "n", name: "Points", type: "number" },
    { id: "c", name: "Done?", type: "checkbox" },
    { id: "f", name: "F", type: "formula", formula: 'prop("Points") * 2' },
    { id: "d", name: "Due", type: "date" },
    { id: "tags", name: "Tags", type: "multiSelect", options: [{ id: "x", name: "X", color: "blue" }] },
  ],
};
const view = (extra: Partial<DatabaseView> = {}): DatabaseView => ({ id: "v", databaseID: "db", blockID: "blk", name: "V", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp, ...extra });
const row = (id: string, values: Record<string, unknown> = {}): Block => ({ id, type: "page", parent: "d:db", sk: "a" + id, text: id, values: values as never, createdAt: 0, updatedAt: 0 });

function store() {
  const records: WireRecord[] = [
    { kind: "database", data: db },
    { kind: "view", data: view() },
    { kind: "block", data: row("1", { st: pv("status", "a"), n: pv("number", 3) }) },
    { kind: "block", data: row("2", { st: pv("status", "b"), n: pv("number", 5) }) },
  ];
  return new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
}

describe("Filter-Logik", () => {
  it("bearbeitet verschachtelte Gruppen über Pfade", () => {
    const c1 = { ...newCondition(db.properties[1]!), id: "c1" };
    const c2 = { ...newCondition(db.properties[2]!), id: "c2" };
    let g: FilterGroup = addItem(EMPTY_FILTER, [], conditionItem(c1));
    g = addItem(g, [], groupItem({ combinator: "or", items: [conditionItem(c2)] }));
    expect(countConditions(g)).toBe(2);
    expect(topConditions(g).map((t) => t.condition.id)).toEqual(["c1"]);
    expect(itemAt(g, [1, 0])).toEqual(conditionItem(c2));
    g = replaceItem(g, [1, 0], conditionItem({ ...c2, op: "greater", value: { number: { _0: 2 } } }));
    g = setCombinator(g, [1], "and");
    expect((itemAt(g, [1]) as { group: { _0: FilterGroup } }).group._0.combinator).toBe("and");
    g = removeItem(g, [1, 0]); // leere Untergruppe verschwindet mit
    expect(g.items).toHaveLength(1);
  });

  it("Operatoren/Wertfelder nach Typ, Formeln nach Ergebnistyp", () => {
    expect(newCondition(db.properties[1]!).op).toBe("equals");
    expect(newCondition(db.properties[3]!).value).toEqual({ bool: { _0: true } });
    expect(valueKind(db.properties[1], "equals")).toBe("options");
    expect(valueKind(db.properties[2], "isEmpty")).toBe("none");
    expect(valueKind(db.properties[4], "greater", "number")).toBe("number");
    expect(valueKind(db.properties[4], "equals")).toBe("text");
    expect(valueKind(db.properties[5], "before")).toBe("date");
  });

  it("beschreibt Chips und erkennt unfertige Bedingungen", () => {
    const s = store();
    expect(describeCondition(s, db, { id: "c", propertyID: "st", op: "equals", value: { options: { _0: ["b"] } } })).toBe("Status is Done");
    expect(describeCondition(s, db, { id: "c", propertyID: "n", op: "greater", value: { number: { _0: 2 } } })).toBe("Points > 2");
    expect(describeCondition(s, db, { id: "c", propertyID: "d", op: "within", value: { relative: { _0: "nextWeek" } } })).toBe("Due is within Next week");
    expect(describeCondition(s, db, { id: "c", propertyID: "n", op: "isEmpty" })).toBe("Points is empty");
    expect(describeCondition(s, db, { id: "c", propertyID: "gone", op: "equals" })).toBe("Deleted property is …");
    expect(isComplete({ id: "c", propertyID: "n", op: "equals" })).toBe(false);
    expect(isComplete({ id: "c", propertyID: "n", op: "isNotEmpty" })).toBe(true);
  });

  it("ein Filter über die UI-Logik wirkt in der Engine", () => {
    const s = store();
    const g = addItem(EMPTY_FILTER, [], conditionItem({ id: "c", propertyID: "st", op: "equals", value: { options: { _0: ["b"] } } }));
    setFilter(s, "v", g);
    expect(new QueryEngine(s).run(s.views.get("v")!).rows.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("Layout-Logik", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => row(id));
  it("flatten: ungruppiert, gruppiert (eingeklappt), Kartenreihen", () => {
    expect(flatten({ rows }, { newRow: true }).map((i) => i.kind)).toEqual(["row", "row", "row", "row", "row", "new"]);
    const groups = [{ id: "g1", title: "G1", color: null, rows: rows.slice(0, 2) }, { id: "g2", title: "G2", color: null, rows: rows.slice(2) }];
    expect(flatten({ rows, groups }, { collapsed: new Set(["g1"]) }).map((i) => i.key)).toEqual(["g:g1", "g:g2", "r:g2:c", "r:g2:d", "r:g2:e"]);
    const cards = flatten({ rows }, { columns: 2 });
    expect(cards.map((i) => (i.kind === "cards" ? i.rows.length : 0))).toEqual([2, 2, 1]);
    const items = flatten({ rows, groups }, { newRow: true });
    expect(nextRowIndex(items, 2, 1)).toBe(5); // über „+ New“ und den nächsten Gruppenkopf hinweg
    expect(nextRowIndex(items, 1, -1)).toBe(-1);
  });

  it("10.000 Zeilen flach in wenigen Millisekunden", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => row(String(i)));
    const t = performance.now();
    const items = flatten({ rows: many, groups: [{ id: "g", title: "G", color: null, rows: many }] }, { newRow: true });
    expect(items).toHaveLength(10_002);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("Galerie-Spalten und Spaltenbreiten", () => {
    expect(galleryColumns(1000, "medium")).toBe(3);
    expect(galleryColumns(1000, "small")).toBe(5);
    expect(galleryColumns(100, "large")).toBe(1);
    expect(columnWidth(view(), db, "title")).toBe(280);
    expect(columnWidth(view({ properties: [{ id: "n", visible: true, width: 20 }] }), db, "n")).toBe(72);
  });
});

describe("Werte der Editoren", () => {
  it("Zahlen und Text", () => {
    expect(parseNumberInput("1,234.5")).toBe(1234.5);
    expect(parseNumberInput("€ 3")).toBe(3);
    expect(parseNumberInput("abc")).toBeUndefined();
    expect(parseTextInput("number", "12")).toEqual(pv("number", 12));
    expect(parseTextInput("number", "x")).toBeUndefined();
    expect(parseTextInput("url", "  ")).toBeNull();
    expect(parseTextInput("title", "Hi")).toEqual(pv("text", "Hi"));
    expect(editText(row("1", { n: pv("number", 2.5) }), db.properties[2]!)).toBe("2.5");
    expect(editText(row("Hallo"), db.properties[0]!)).toBe("Hallo");
  });

  it("Datum: Input ↔ Swift-Datum (UTC), Ende an/aus", () => {
    const s = fromInputValue("2026-11-09")!;
    expect(toInputValue(s, false)).toBe("2026-11-09");
    expect(toInputValue(fromInputValue("2026-11-09T14:30")!, true)).toBe("2026-11-09T14:30");
    expect(fromInputValue("09.11.2026")).toBeUndefined();
    const d = withDate({ start: s, includeTime: false }, { end: s + 86_400 });
    expect(d.end).toBe(s + 86_400);
    expect("end" in withDate(d, { end: undefined })).toBe(false);
  });

  it("Töne ohne Marker, Agent-Strich", () => {
    expect(optionTone("yellow")).toBe("orange");
    expect(optionTone("blueBackground")).toBe("blue");
    expect(optionTone(undefined)).toBe("gray");
    expect(defaultIsAgentEdit({ ...row("1"), updatedBy: "agent:based" })).toBe(true);
    expect(defaultIsAgentEdit({ ...row("1"), updatedBy: "me" })).toBe(false);
  });
});

describe("Neue Zeile", () => {
  it("übernimmt Gruppe und eindeutige „ist“-Filter", () => {
    const filter: FilterGroup = { combinator: "and", items: [conditionItem({ id: "c", propertyID: "c", op: "equals", value: { bool: { _0: true } } }), conditionItem({ id: "d", propertyID: "tags", op: "contains", value: { options: { _0: ["x"] } } })] };
    const v = view({ type: "board", filter });
    const gp = groupProperty(db, v)!;
    expect(gp.id).toBe("st");
    expect(newRowValues(db, v, gp, "b")).toEqual({ c: pv("checkbox", true), tags: pv("multiSelect", ["x"]), st: pv("status", "b") });
    expect(newRowValues(db, v, gp, "")).toEqual({ c: pv("checkbox", true), tags: pv("multiSelect", ["x"]) });
    expect(newRowValues(db, view(), undefined, null)).toEqual({});
  });
});

describe("Design-Tokens", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  it("keine Farbliterale in src/ (ADR 0009)", () => {
    const offenders = files(new URL(".", import.meta.url).pathname)
      .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith(".test.ts"))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const))
      .filter(([, , l]) => /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(/.test(l));
    expect(offenders).toEqual([]);
  });
});

import { nearestInDirection, type Box } from "./logic/spatial.js";

describe("Pfeiltasten zwischen Karten (BSD-238)", () => {
  const box = (col: number, row: number, h = 60): Box => ({ left: col * 280, right: col * 280 + 260, top: row * 70, bottom: row * 70 + h });
  // Board: Spalte 0 mit drei Karten, Spalte 1 mit zwei.
  const cards = [box(0, 0), box(0, 1), box(0, 2), box(1, 0), box(1, 1)];
  it("↓/↑ bleiben in der Spalte und enden am Rand", () => {
    expect(nearestInDirection(cards[0]!, cards, "down")).toBe(1);
    expect(nearestInDirection(cards[2]!, cards, "up")).toBe(1);
    expect(nearestInDirection(cards[2]!, cards, "down")).toBe(-1);
    expect(nearestInDirection(cards[4]!, cards, "down")).toBe(-1);
  });
  it("→/← gehen in die Nachbarspalte auf gleiche Höhe, sonst zur nächstliegenden Karte", () => {
    expect(nearestInDirection(cards[1]!, cards, "right")).toBe(4);
    expect(nearestInDirection(cards[2]!, cards, "right")).toBe(4);
    expect(nearestInDirection(cards[3]!, cards, "left")).toBe(0);
    expect(nearestInDirection(cards[0]!, cards, "left")).toBe(-1);
  });
  it("Galerie-Raster: Zeilenweise rechts, spaltenweise runter", () => {
    const grid = [box(0, 0, 200), box(1, 0, 200), box(2, 0, 200), box(0, 4, 200), box(1, 4, 200)];
    expect(nearestInDirection(grid[0]!, grid, "right")).toBe(1);
    expect(nearestInDirection(grid[1]!, grid, "down")).toBe(4);
    expect(nearestInDirection(grid[2]!, grid, "down")).toBe(-1);
  });
});
