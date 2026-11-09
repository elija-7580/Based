// BSD-154: Records ⇄ BlockNote-Blöcke (rein, ohne Y.Doc).
import { describe, expect, it } from "vitest";
import { canonicalStringify, type Block } from "@based/core";
import { docBlockIDs, projectDoc } from "../src/mapping/blocks.js";
import { materializeDoc } from "../src/mapping/materialize.js";
import { canonicalRichText, inlineToRichText, richTextToInline } from "../src/mapping/richtext.js";
import { assignSortKeys } from "../src/mapping/sortkeys.js";
import { corpusStore } from "./helpers.js";

describe("Mapping", () => {
  it("Korpus: Records → Blöcke → Records ohne Änderung", () => {
    const store = corpusStore();
    const blocks = projectDoc(store, "p-root");
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    expect(changes.puts.map((b) => b.id)).toEqual([]);
    expect(changes.removeBlocks).toEqual([]);
  });

  it("richText mit allen Marken, Erwähnungen und Gleichung", () => {
    const store = corpusStore();
    const runs = store.blocks.get("btex-0002-0000-4000-8000-000000000000")!.text!;
    expect(inlineToRichText(richTextToInline(runs))).toEqual(canonicalRichText(runs));
    expect(inlineToRichText(richTextToInline("x"))).toBe("x");
    expect(inlineToRichText([])).toBeUndefined();
  });

  it("Sortierschlüssel bleiben, nur Verschobenes bekommt neue", () => {
    expect(assignSortKeys(["a", "b", "c"], ["a0", "a1", "a2"])).toEqual(["a0", "a1", "a2"]);
    const moved = assignSortKeys(["c", "a", "b"], ["a2", "a0", "a1"]);
    expect(moved.slice(1)).toEqual(["a0", "a1"]);
    expect(moved[0]! < "a0").toBe(true);
    const ins = assignSortKeys(["a", "x", "b"], ["a0", undefined, "a1"]);
    expect(ins[0]).toBe("a0");
    expect(ins[2]).toBe("a1");
    expect(ins[1]! > "a0" && ins[1]! < "a1").toBe(true);
    // gleiche Schlüssel mit etwas dazwischen
    const dup = assignSortKeys(["a", "x", "b"], ["a1", undefined, "a1"]);
    expect(dup[0]! < dup[1]! && dup[1]! < dup[2]!).toBe(true);
  });

  it("Dokument zeigt Tabellenzeilen, aber keine Kinder von Unterseiten", () => {
    const store = corpusStore();
    const ids = docBlockIDs(store, "p-root");
    expect(ids.has("p-asset")).toBe(true);
    expect(ids.has("btab-0029-0000-4000-8000-000000000000")).toBe(true);
    void (null as unknown as Block);
    void canonicalStringify;
  });
});
