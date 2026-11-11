// BSD-168: Breadcrumb und ⇧⌘U auch für Datenbank-Zeilen.
import { describe, expect, it } from "vitest";
import { createDatabase, createPage, MemoryPersistence, pageAncestors, WorkspaceStore } from "../src/index.js";

describe("pageAncestors", () => {
  it("Seite in Seite, Zeile einer Datenbankseite, Zeile einer Inline-Datenbank", () => {
    let t = 1;
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
    const top = createPage(store, { title: "Top" });
    const child = createPage(store, { title: "Child", parent: top });
    expect(pageAncestors(store, child)).toEqual([top]);
    expect(pageAncestors(store, top)).toEqual([]);
    const full = createDatabase(store, { parent: "b:" + child, sampleRows: 1 });
    const row = [...store.blocks.values()].find((b) => b.parent === "d:" + full.databaseID);
    expect(row).toBeDefined();
    expect(pageAncestors(store, row!.id)).toEqual([top, child, full.blockID]);
    const inline = createDatabase(store, { parent: "b:" + top, inline: true, sampleRows: 1 });
    const inlineRow = [...store.blocks.values()].find((b) => b.parent === "d:" + inline.databaseID);
    expect(pageAncestors(store, inlineRow!.id)).toEqual([top]);
  });
});
