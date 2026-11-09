// BSD-125: „Limit to 1 page“ wird beim Schreiben im Kern erzwungen (UI, Agenten, Import, MCP).
import { describe, expect, it } from "vitest";
import { MemoryPersistence, WorkspaceStore, relationLimitViolations, setRelation, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const db = (id: string, props: unknown[]): WireRecord => ({
  kind: "database",
  data: { id, blockID: `blk-${id}`, title: id, properties: [{ id: "title", name: "Name", type: "title" }, ...props], createdAt: 0, updatedAt: 0, stamp } as never,
});
const row = (id: string, dbID: string): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent: `d:${dbID}`, sk: "a0" + id, text: id, createdAt: 0, updatedAt: 0, stamp },
});

/** Aufgaben (A) ↔ Projekte (B), two-way: A.proj ↔ B.tasks. */
function setup(opts: { forwardLimit?: boolean; mirrorLimit?: boolean } = {}) {
  const records = [
    db("A", [{ id: "proj", name: "Projekt", type: "relation", relation: { databaseID: "B", syncedPropertyID: "tasks", ...(opts.forwardLimit ? { limitOne: true } : {}) } }]),
    db("B", [{ id: "tasks", name: "Aufgaben", type: "relation", relation: { databaseID: "A", syncedPropertyID: "proj", ...(opts.mirrorLimit ? { limitOne: true } : {}) } }]),
    row("a1", "A"), row("a2", "A"), row("b1", "B"), row("b2", "B"), row("b3", "B"),
  ];
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
  const ids = (id: string, prop: string) => ((s.blocks.get(id)?.values?.[prop] as { relation?: { _0: string[] } } | undefined)?.relation?._0 ?? []);
  return { s, ids };
}

describe("setRelation", () => {
  it("ohne Limit: alle Ziele, Gegenseite zeigt zurück", () => {
    const { s, ids } = setup();
    setRelation(s, "a1", "proj", ["b1", "b2", "b3"]);
    expect(ids("a1", "proj")).toEqual(["b1", "b2", "b3"]);
    for (const b of ["b1", "b2", "b3"]) expect(ids(b, "tasks")).toEqual(["a1"]);
  });

  it("Limit to 1 page: 3 Ziele → das letzte, Gegenseite konsistent", () => {
    const { s, ids } = setup({ forwardLimit: true });
    setRelation(s, "a1", "proj", ["b1", "b2", "b3"]);
    expect(ids("a1", "proj")).toEqual(["b3"]);
    expect(ids("b3", "tasks")).toEqual(["a1"]);
    expect(ids("b1", "tasks")).toEqual([]);
    expect(ids("b2", "tasks")).toEqual([]);
  });

  it("Limit to 1 page: Wechsel des Ziels räumt die alte Gegenseite auf", () => {
    const { s, ids } = setup({ forwardLimit: true });
    setRelation(s, "a1", "proj", ["b1"]);
    setRelation(s, "a1", "proj", ["b2"]);
    expect(ids("a1", "proj")).toEqual(["b2"]);
    expect(ids("b1", "tasks")).toEqual([]);
    expect(ids("b2", "tasks")).toEqual(["a1"]);
  });

  it("Limit auf der Gegenseite: ein Ziel gehört nur einer Zeile, die frühere verliert es", () => {
    const { s, ids } = setup({ mirrorLimit: true });
    setRelation(s, "a1", "proj", ["b1", "b2"]);
    setRelation(s, "a2", "proj", ["b1"]);
    expect(ids("b1", "tasks")).toEqual(["a2"]);
    expect(ids("a1", "proj")).toEqual(["b2"]);
    expect(ids("a2", "proj")).toEqual(["b1"]);
  });

  it("ein Undo-Schritt für beide Seiten", () => {
    const { s, ids } = setup({ forwardLimit: true });
    setRelation(s, "a1", "proj", ["b1"]);
    setRelation(s, "a1", "proj", ["b2"]);
    s.undo();
    expect(ids("a1", "proj")).toEqual(["b1"]);
    expect(ids("b1", "tasks")).toEqual(["a1"]);
    expect(ids("b2", "tasks")).toEqual([]);
  });

  it("Einschalten lässt Mehrfachwerte stehen und meldet sie", () => {
    const { s, ids } = setup();
    setRelation(s, "a1", "proj", ["b1", "b2"]);
    setRelation(s, "a2", "proj", ["b3"]);
    s.transact("Limit", (tx) => {
      const d = structuredClone(s.databases.get("A")!);
      d.properties[1]!.relation!.limitOne = true;
      tx.put({ kind: "database", data: d });
    });
    expect(ids("a1", "proj")).toEqual(["b1", "b2"]);
    expect(relationLimitViolations(s, "A", "proj")).toEqual(["a1"]);
  });
});
