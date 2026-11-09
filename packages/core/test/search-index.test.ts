// BSD-157: inkrementeller Suchindex, Worker-Protokoll, Abbruch.
import { describe, expect, it } from "vitest";
import { attachSearchIndex, handleSearchMessage, MemoryPersistence, SearchCorpus, SearchIndex, searchSnapshot, WorkspaceStore } from "../src/index.js";
import type { Block, SearchRequest } from "../src/index.js";

const page = (id: string, text: string, parent = "w", sk = "a0"): Block => ({ id, type: "page", parent, sk, text, createdAt: 0, updatedAt: 0 });
const para = (id: string, text: string, parent: string, sk = "a0"): Block => ({ id, type: "text", parent: "b:" + parent, sk, text, createdAt: 0, updatedAt: 0 });

function store() {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => 100 });
  s.transact("init", (tx) => {
    tx.put({ kind: "block", data: page("p1", "Alpha") });
    tx.put({ kind: "block", data: para("b1", "lorem ipsum dolor", "p1") });
    tx.put({ kind: "block", data: page("p2", "Beta", "b:p1", "a1") });
    tx.put({ kind: "block", data: para("b2", "second lorem", "p2") });
  });
  return s;
}

describe("SearchIndex", () => {
  it("folgt dem Store inkrementell wie ein Neuaufbau", () => {
    const s = store();
    const { index, dispose } = attachSearchIndex(s);
    expect(index.search("lorem", {}, "bestMatch", 50, 0).map((h) => h.pageID).sort()).toEqual(["p1", "p2"]);
    s.transact("trash", (tx) => tx.update("p1", (b) => { b.trashedAt = 1; }));
    expect(index.search("lorem", {}, "bestMatch", 50, 0)).toEqual([]);
    s.transact("restore", (tx) => tx.update("p1", (b) => { delete b.trashedAt; }));
    s.setText("b2", "changed text");
    expect(index.search("lorem", {}, "bestMatch", 50, 0).map((h) => h.pageID)).toEqual(["p1"]);
    expect(index.search("changed", {}, "bestMatch", 50, 0)).toEqual(new SearchCorpus(s).search("changed", {}, "bestMatch", 50, 0));
    dispose();
    s.setText("b1", "gone");
    expect(index.search("gone", {}, "bestMatch", 50, 0)).toEqual([]);
  });

  it("erster passender Block in Dokumentreihenfolge liefert das Snippet", () => {
    const s = store();
    s.transact("more", (tx) => tx.put({ kind: "block", data: para("b0", "lorem first", "p1", "Z") }));
    s.transact("more", (tx) => tx.put({ kind: "block", data: para("b9", "lorem early", "p1", "0") }));
    const hit = SearchIndex.fromSource(s).search("lorem", {}, "bestMatch", 50, 0).find((h) => h.pageID === "p1");
    expect(hit?.blockID).toBe("b9");
  });

  it("Worker-Protokoll: load, apply, search; Abbruch ohne Antwort", () => {
    const s = store();
    const index = new SearchIndex();
    const msg = (m: SearchRequest) => structuredClone(m);
    handleSearchMessage(index, msg({ type: "load", delta: searchSnapshot(s) }));
    const r = handleSearchMessage(index, msg({ type: "search", id: 7, query: "alpha", now: 0 }));
    expect(r?.id).toBe(7);
    expect(r?.hits.map((h) => h.pageID)).toEqual(["p1"]);
    handleSearchMessage(index, msg({ type: "apply", delta: { upserts: [], deletions: ["block:p1"] } }));
    expect(handleSearchMessage(index, msg({ type: "search", id: 8, query: "alpha", now: 0 }))?.hits).toEqual([]);
    // Abbruch: großer Index, isCancelled sofort wahr.
    const big = new SearchIndex();
    big.apply({ upserts: Array.from({ length: 10_000 }, (_, i) => ({ kind: "block" as const, data: page("x" + i, "lorem " + i, "w", "a" + i) })), deletions: [] });
    expect(big.run("lorem", { isCancelled: () => true })).toBeUndefined();
    expect(handleSearchMessage(big, { type: "search", id: 1, query: "lorem" }, () => true)).toBeUndefined();
    expect(big.run("lorem 9999", { now: 0 })?.[0]?.pageID).toBe("x9999");
  });
});
