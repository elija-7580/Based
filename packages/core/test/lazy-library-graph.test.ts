// BSD-515 Teil 1 (ADR 0017 B2): Library und Graph mit Laden nach Bedarf – gleiche Ergebnisse wie voll geladen, ohne
// den Workspace in den Speicher zu holen (storeInfo.fullLoads bleibt leer).
import { describe, expect, it } from "vitest";
import { buildPageGraph, libraryItems, MemoryPersistence, WorkspaceStore, type Block, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "seed" };
const block = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, text: id, createdAt: 1, updatedAt: 2, stamp, ...extra } }) as WireRecord;
const mention = (page: string) => [{ t: "see " }, { mention: { page: { _0: page } } }];

function records(): WireRecord[] {
  return [
    block("A", "page", "w", "a0", { props: { icon: "📘" } }),
    block("B", "page", "w", "a1"),
    block("C", "page", "b:A", "a5"),
    block("T", "toggle", "b:B", "a0"),
    block("D", "page", "b:T", "a0"), // Unterseite in einem Toggle (Elternkette über einen Inhaltsblock)
    block("X", "page", "w", "a2", { trashedAt: 3 }),
    block("A-1", "text", "b:A", "a0", { text: mention("B") }),
    block("A-2", "text", "b:A", "a1", { text: [{ t: "link", m: { link: "based://page/C" } }] }),
    block("B-1", "linkToPage", "b:B", "a1", { props: { linkTarget: "A" } }),
    block("C-1", "text", "b:C", "a0", { text: mention("X") }), // auf eine Seite im Papierkorb: keine Kante
    block("D-1", "text", "b:D", "a0", { text: "plain text, no link" }),
    block("DB", "databasePage", "w", "a3", { props: { databaseID: "db" } }),
    block("R1", "page", "d:db", "a0", { values: { rel: { relation: { _0: ["A"] } } } }),
    { kind: "database", data: { id: "db", blockID: "DB", title: "Tasks", createdAt: 0, updatedAt: 0, stamp, properties: [
      { id: "title", name: "Name", type: "title" }, { id: "rel", name: "Pages", type: "relation", relation: { databaseID: "db" } },
    ] } } as WireRecord,
  ];
}

const open = (lazy: boolean) => new WorkspaceStore({ persistence: new MemoryPersistence(records()), node: "dev", now: () => 1000, lazy, propertyRecords: false });
const sortGraph = (g: ReturnType<typeof buildPageGraph>) => ({
  nodes: [...g.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)),
  edges: [...g.edges].map((e) => `${e.k}:${e.s}>${e.t}`).sort(),
});

describe("BSD-515 Teil 1: Library und Graph über das Gerüst", () => {
  it("Library: gleiche Einträge wie voll geladen, ohne Voll-Laden", () => {
    const eager = open(false), lazy = open(true);
    expect(lazy.isPartial).toBe(true);
    const byId = (xs: ReturnType<typeof libraryItems>) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(byId(libraryItems(lazy))).toEqual(byId(libraryItems(eager)));
    expect(libraryItems(lazy).map((i) => i.id).sort()).toEqual(["A", "B", "C", "D", "DB", "R1"]);
    expect(lazy.fullLoads).toBe(0);
  });

  it("Graph: gleiche Knoten und Kanten (Unterseiten, Erwähnungen, Links, Relationen), ohne Voll-Laden", () => {
    const eager = open(false), lazy = open(true);
    const g = sortGraph(buildPageGraph(lazy));
    expect(g).toEqual(sortGraph(buildPageGraph(eager)));
    expect(g.edges).toEqual(expect.arrayContaining(["child:A>C", "child:B>D", "mention:A>B", "mention:A>C", "mention:B>A", "relation:R1>A"]));
    expect(g.edges.some((e) => e.includes("X"))).toBe(false);
    expect(lazy.fullLoads).toBe(0);
  });
});
