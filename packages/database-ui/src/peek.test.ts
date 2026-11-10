// Zeile als Seite öffnen: Modus je Ansicht, Reihenfolge laut Ansicht (Filter/Sortierung/Gruppen), Vor/Zurück,
// Kürzel, Zustand übers Neuladen.
import { describe, expect, it } from "vitest";
import { MemoryPersistence, QueryEngine, WorkspaceStore, pv, type DatabaseView, type WireRecord } from "@based/core";
import { openModeOf, parsePeek, peekPosition, peekShortcut, restorePeek, rowOrder, serializePeek } from "./logic/peek.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const view = (extra: Partial<DatabaseView> = {}): DatabaseView => ({ id: "v", databaseID: "db", blockID: "blk", name: "V", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp, ...extra });

function engine() {
  const records: WireRecord[] = [
    { kind: "database", data: { id: "db", blockID: "blk", title: "T", createdAt: 0, updatedAt: 0, stamp, properties: [
      { id: "title", name: "Name", type: "title" }, { id: "n", name: "N", type: "number" },
      { id: "st", name: "Status", type: "status", options: [{ id: "a", name: "Todo", color: "gray" }, { id: "b", name: "Done", color: "green" }] },
      { id: "tags", name: "Tags", type: "multiSelect", options: [{ id: "x", name: "X", color: "blue" }, { id: "y", name: "Y", color: "red" }] },
    ] } },
  ];
  const rows: [string, number, string, string[]][] = [["r1", 3, "a", ["x", "y"]], ["r2", 1, "b", ["y"]], ["r3", 2, "a", []], ["r4", 4, "b", ["x"]]];
  rows.forEach(([id, n, st, tags], i) => records.push({ kind: "block", data: { id, type: "page", parent: "d:db", sk: "a" + i, text: id, values: { n: pv("number", n), st: pv("status", st), tags: pv("multiSelect", tags) }, createdAt: 0, updatedAt: 0, stamp } }));
  return new QueryEngine(new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" }));
}

describe("Modus", () => {
  it("Standard und Unbekanntes sind Side Peek", () => {
    expect(openModeOf(view())).toBe("sidePeek");
    expect(openModeOf(view({ openIn: "popover" }))).toBe("sidePeek");
    expect(openModeOf(view({ openIn: "centerPeek" }))).toBe("centerPeek");
    expect(openModeOf(view({ openIn: "fullPage" }))).toBe("fullPage");
    expect(openModeOf(undefined)).toBe("sidePeek");
  });
});

describe("Reihenfolge laut Ansicht", () => {
  it("folgt Sortierung und Filter", () => {
    const e = engine();
    expect(rowOrder(e.run(view()))).toEqual(["r1", "r2", "r3", "r4"]);
    expect(rowOrder(e.run(view({ sorts: [{ propertyID: "n", ascending: true }] })))).toEqual(["r2", "r3", "r1", "r4"]);
    const filter = { combinator: "and", items: [{ condition: { _0: { id: "c", propertyID: "n", op: "greater", value: { number: { _0: 1 } } } } }] };
    expect(rowOrder(e.run(view({ sorts: [{ propertyID: "n", ascending: false }], filter })))).toEqual(["r4", "r1", "r3"]);
  });

  it("gruppiert: Gruppe für Gruppe, ausgeblendete Gruppen fehlen, Mehrfachzeilen einmal", () => {
    const e = engine();
    expect(rowOrder(e.run(view({ type: "board", groupBy: { propertyID: "st" } })))).toEqual(["r1", "r3", "r2", "r4"]);
    expect(rowOrder(e.run(view({ type: "board", groupBy: { propertyID: "st", hiddenGroups: ["a"] } })))).toEqual(["r2", "r4"]);
    const multi = rowOrder(e.run(view({ groupBy: { propertyID: "tags" } })));
    expect([...multi].sort()).toEqual(["r1", "r2", "r3", "r4"]);
    expect(new Set(multi).size).toBe(multi.length);
  });

  it("Suche zählt mit", () => {
    expect(rowOrder(engine().run(view(), "r3"))).toEqual(["r3"]);
  });
});

describe("Vor/Zurück", () => {
  const order = ["a", "b", "c"];
  it("Nachbarn und Enden", () => {
    expect(peekPosition(order, "a")).toEqual({ index: 0, total: 3, prev: undefined, next: "b" });
    expect(peekPosition(order, "b")).toEqual({ index: 1, total: 3, prev: "a", next: "c" });
    expect(peekPosition(order, "c")).toEqual({ index: 2, total: 3, prev: "b", next: undefined });
  });
  it("Zeile fällt aus der Ansicht: weiter von der letzten Stelle", () => {
    expect(peekPosition(["a", "c"], "b", 1)).toEqual({ index: -1, total: 2, prev: "a", next: "c" });
    expect(peekPosition(["a", "b"], "c", 2)).toEqual({ index: -1, total: 2, prev: "b", next: undefined });
    expect(peekPosition(["a"], "x")).toEqual({ index: -1, total: 1, prev: undefined, next: undefined });
    expect(peekPosition([], "x", 5)).toEqual({ index: -1, total: 0, prev: undefined, next: undefined });
  });
  it("Kürzel ⌃⇧↑/↓", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => peekShortcut({ key, ctrlKey: true, shiftKey: true, ...mods });
    expect(k("ArrowUp")).toBe("prev");
    expect(k("ArrowDown")).toBe("next");
    expect(k("K")).toBe("prev");
    expect(k("J")).toBe("next");
    expect(k("ArrowDown", { shiftKey: false })).toBeUndefined();
    expect(k("ArrowDown", { ctrlKey: false })).toBeUndefined();
    expect(k("ArrowDown", { metaKey: true })).toBeUndefined();
    expect(k("ArrowLeft")).toBeUndefined();
  });
});

describe("Zustand übers Neuladen", () => {
  it("hin und zurück", () => {
    const s = { rowID: "r1", viewID: "v" };
    expect(parsePeek(serializePeek(s))).toEqual(s);
    expect(serializePeek(undefined)).toBeNull();
  });
  it("Unlesbares ist „nichts offen“", () => {
    for (const raw of [null, undefined, "", "x", "{}", '{"v":2,"row":"a","view":"b"}', '{"v":1,"row":"","view":"b"}', '{"v":1,"row":1,"view":"b"}', "null"]) expect(parsePeek(raw)).toBeUndefined();
  });
  it("öffnet nur vorhandene Zeilen; fehlende Ansicht → aktive", () => {
    const ctx = { rowIDs: new Set(["r1"]), viewIDs: ["v", "w"], activeViewID: "w" };
    expect(restorePeek({ rowID: "r1", viewID: "v" }, ctx)).toEqual({ rowID: "r1", viewID: "v" });
    expect(restorePeek({ rowID: "r1", viewID: "gone" }, ctx)).toEqual({ rowID: "r1", viewID: "w" });
    expect(restorePeek({ rowID: "r9", viewID: "v" }, ctx)).toBeUndefined();
    expect(restorePeek(undefined, ctx)).toBeUndefined();
    expect(restorePeek({ rowID: "r1", viewID: "v" }, { ...ctx, rowIDs: () => false })).toBeUndefined();
  });
});
