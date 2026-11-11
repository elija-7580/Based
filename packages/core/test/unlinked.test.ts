// BSD-90: unverlinkte Erwähnungen finden (ganze Wörter, Groß/klein, nicht in der Seite selbst, nicht in Erwähnungen)
// und verlinken (Lauf wird zur Seiten-Erwähnung, Rest bleibt, ein Undo-Schritt).
import { describe, expect, it } from "vitest";
import { linkUnlinkedMention, MemoryPersistence, plainText, unlinkedMentions, WorkspaceStore, ZERO_STAMP, type WireRecord } from "../src/index.js";

const stamp = ZERO_STAMP;
const block = (id: string, parent: string, sk: string, type: string, text?: unknown): WireRecord => ({ kind: "block", data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp, ...(text !== undefined ? { text } : {}) } as never });

function setup() {
  const records: WireRecord[] = [
    block("target", "w", "a0", "page", "Roadmap"),
    block("t1", "b:target", "a0", "text", "The Roadmap mentions itself"),
    block("other", "w", "a1", "page", "Notes"),
    block("n1", "b:other", "a0", "text", "See the roadmap for Q1. Roadmaps are plural."),
    block("n2", "b:other", "a1", "text", [{ t: "Linked " }, { t: "Roadmap", mention: { page: { _0: "target" } } }, { t: " and roadmap again" }]),
    block("n3", "b:other", "a2", "text", "notroadmap here"),
  ];
  return new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });
}

describe("Unverlinkte Erwähnungen (BSD-90)", () => {
  it("findet ganze Wörter außerhalb der Seite und außerhalb vorhandener Erwähnungen", () => {
    const store = setup();
    const found = unlinkedMentions(store, "target");
    expect(found.map((f) => [f.blockID, f.start, f.length])).toEqual([["n1", 8, 7], ["n2", 19, 7]]);
    expect(found[0]!.pageID).toBe("other");
    expect(found[0]!.snippet).toContain("roadmap for Q1");
  });

  it("verlinkt eine Stelle als Erwähnung, Text bleibt gleich, ein Undo-Schritt", () => {
    const store = setup();
    expect(linkUnlinkedMention(store, "n1", 8, 7, "target")).toBe(true);
    const runs = store.blocks.get("n1")!.text as { t: string; mention?: unknown }[];
    expect(runs.map((r) => r.t)).toEqual(["See the ", "roadmap", " for Q1. Roadmaps are plural."]);
    expect(runs[1]!.mention).toEqual({ page: { _0: "target" } });
    expect(plainText(store.blocks.get("n1")!.text)).toBe("See the roadmap for Q1. Roadmaps are plural.");
    expect(unlinkedMentions(store, "target").map((f) => f.blockID)).toEqual(["n2"]);
    store.undo();
    expect(store.blocks.get("n1")!.text).toBe("See the roadmap for Q1. Roadmaps are plural.");
    // Stelle passt nicht (mitten in eine Erwähnung): nichts passiert
    expect(linkUnlinkedMention(store, "n2", 9, 7, "target")).toBe(false);
  });
});
