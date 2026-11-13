// BSD-381 (ADR 0016, E0): Testseite und Baum des neuen Block-Editors – alle Blöcke in richtiger Reihenfolge und
// Verschachtelung, die Inline-Datenbanken in den Spalten, die lange Tabelle.
import { rowsOf } from "@based/core";
import { describe, expect, it } from "vitest";
import { blockFixtureOutline, blockTree, buildBlockFixture, FIXTURE_TABLE_ROWS, flatIDs, outlineOf } from "../src/blocks/index.js";
import { corpusStore } from "./helpers.js";

describe("Block-Editor E0: Testseite", () => {
  it("Baum der Seite = Gliederung der Fixture (Reihenfolge und Tiefe)", () => {
    const store = corpusStore();
    const page = buildBlockFixture(store);
    const tree = blockTree(store, page);
    expect(outlineOf(tree)).toEqual(blockFixtureOutline());
    // Stichproben: Spalten mit je einer Überschrift und einer Datenbank, verschachtelte Liste drei Ebenen tief
    const outline = outlineOf(tree);
    expect(outline).toContain("columnList");
    expect(outline.filter((l) => l === "    databaseInline")).toHaveLength(2);
    expect(outline).toContain("    bulletedList");
    expect(new Set(flatIDs(tree)).size).toBe(flatIDs(tree).length);
  });

  it("Inline-Datenbanken haben ihre Zeilen, die Tabelle ihre 40 Zeilen", () => {
    const store = corpusStore();
    const page = buildBlockFixture(store);
    const ids = flatIDs(blockTree(store, page));
    const dbs = ids.map((id) => store.blocks.get(id)!).filter((b) => b.type === "databaseInline");
    expect(dbs.map((b) => rowsOf(store, b.props!.databaseID!).length)).toEqual([5, 3]);
    const table = ids.map((id) => store.blocks.get(id)!).find((b) => b.type === "table")!;
    expect(store.children("b:" + table.id)).toHaveLength(FIXTURE_TABLE_ROWS);
  });

  it("Papierkorb und Unterseiten: gelöschte Blöcke fehlen, Unterseiten bleiben zu", () => {
    const store = corpusStore();
    const page = buildBlockFixture(store);
    const first = blockTree(store, page)[0]!;
    store.transact("Trash", (tx) => tx.update(first.id, (b) => { b.trashedAt = store.now(); }));
    expect(blockTree(store, page)[0]!.type).toBe("text");
    const sub = buildBlockFixture(store, { parent: page, title: "Child" });
    const last = blockTree(store, page).at(-1)!;
    expect(last).toEqual({ id: sub, type: "page", children: [] });
  });
});
