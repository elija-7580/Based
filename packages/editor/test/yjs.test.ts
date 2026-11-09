// @vitest-environment jsdom
// BSD-154: Records ⇄ Y.Doc ⇄ BlockNote mit dem Korpus aus Swift (fixtures/records): alle Blocktypen hin und
// zurück ohne Verlust; unbekannte Felder und Typen bleiben erhalten.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { canonicalStringify, ENUMS, MemoryPersistence, WorkspaceStore, type Block } from "@based/core";
import type { BNBlock } from "../src/mapping/bn.js";
import { extractOwned, projectBlock, projectDoc } from "../src/mapping/blocks.js";
import { materializeDoc } from "../src/mapping/materialize.js";
import { createConverter } from "../src/schema/schema.js";
import { corpusRecords, corpusStore } from "./helpers.js";

const converter = createConverter();

/** Über Y.Doc und ein zweites Y.Doc (wie Speichern und Laden) zurück. */
function viaY(blocks: BNBlock[]): BNBlock[] {
  const doc = new Y.Doc();
  converter.toFragment(blocks, doc.getXmlFragment("blocks"));
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
  return converter.fromFragment(doc2.getXmlFragment("blocks"));
}

const flat = (bs: BNBlock[]): BNBlock[] => bs.flatMap((b) => [b, ...flat(b.children)]);

describe("Y-Dokument", () => {
  it("Korpus deckt alle Blocktypen ab", () => {
    const types = new Set(corpusRecords().filter((r) => r.kind === "block").map((r) => (r.data as Block).type));
    for (const t of ENUMS.BlockType) expect(types, t).toContain(t);
  });

  it("Korpus: alle Blocktypen hin und zurück über Y ohne Verlust", () => {
    const store = corpusStore();
    const blocks = viaY(projectDoc(store, "p-root"));
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    expect(changes.puts.map((b) => [b.id, b])).toEqual([]);
    expect(changes.removeBlocks).toEqual([]);
  });

  it("jeder Block: eigene Felder überstehen Y unverändert", () => {
    const store = corpusStore();
    for (const rec of store.blocks.values()) {
      const direct = projectBlock(rec);
      const [back] = viaY([direct]);
      expect(canonicalStringify(extractOwned(back!)), rec.id + " " + rec.type).toBe(canonicalStringify(extractOwned(direct)));
    }
  });

  it("unbekannter Typ und unbekannte Felder: auch ohne Record (z. B. eingefügt) vollständig", () => {
    const store = corpusStore();
    const fut = store.blocks.get("fut-1")!;
    const [back] = viaY([projectBlock(fut)]);
    const empty = new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "x" });
    const changes = materializeDoc(empty, "p-root", [back!], { now: 5 });
    const made = changes.puts[0]! as Record<string, unknown>;
    const strip = (b: Record<string, unknown>) => {
      const c = { ...b };
      for (const k of ["createdAt", "updatedAt", "createdBy", "updatedBy", "stamp", "sk"]) delete c[k];
      return c;
    };
    expect(strip(made)).toEqual(strip(fut as unknown as Record<string, unknown>));
  });

  it("Bearbeiten über Y behält fremde Felder (Bild-Asset, Läufe, toggleable: false)", () => {
    const store = corpusStore();
    const blocks = viaY(projectDoc(store, "p-root"));
    const all = flat(blocks);
    const heading = all.find((b) => b.id === "bhea-0003-0000-4000-8000-000000000000")!;
    heading.content = [{ type: "text", text: "Neu", styles: {} }];
    const image = all.find((b) => b.id === "bima-0017-0000-4000-8000-000000000000")!;
    image.props = { ...image.props, caption: "Neue Bildunterschrift" };
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    expect(changes.puts.map((b) => b.id).sort()).toEqual([heading.id, image.id].sort());
    const h = changes.puts.find((b) => b.id === heading.id)!;
    expect(h.text).toBe("Neu");
    expect(h.props).toEqual({ isOpen: false, toggleable: false });
    const img = changes.puts.find((b) => b.id === image.id)!;
    expect(img.props!.asset).toEqual(store.blocks.get(image.id)!.props!.asset);
    expect(img.props!.caption).toBe("Neue Bildunterschrift");
  });

  it("Tabelle: Zellen ändern schreibt nur die Zeile", () => {
    let t = 1;
    const store = new WorkspaceStore({
      persistence: new MemoryPersistence([
        { kind: "block", data: { id: "p", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0 } },
        { kind: "block", data: { id: "tb", type: "table", parent: "b:p", sk: "a0", createdAt: 0, updatedAt: 0, props: { tableColumns: 2, tableHeaderRow: true, tableColumnColors: [null, "green"] } } },
        { kind: "block", data: { id: "r1", type: "tableRow", parent: "b:tb", sk: "a0", createdAt: 0, updatedAt: 0, props: { cells: ["A", "B"], cellColors: ["redBackground", null] } } },
        { kind: "block", data: { id: "r2", type: "tableRow", parent: "b:tb", sk: "a1", createdAt: 0, updatedAt: 0, props: { cells: ["C", [{ t: "D", m: { b: true } }]] } } },
      ]),
      node: "x",
      now: () => t++,
    });
    const blocks = viaY(projectDoc(store, "p"));
    expect(materializeDoc(store, "p", blocks, { now: 1 }).puts).toEqual([]);
    const content = blocks[0]!.content as { rows: { cells: { content: unknown[] }[] }[] };
    content.rows[1]!.cells[0]!.content = [{ type: "text", text: "C2", styles: {} }];
    const changes = materializeDoc(store, "p", blocks, { now: 1 });
    expect(changes.puts.map((b) => b.id)).toEqual(["r2"]);
    expect(changes.puts[0]!.props!.cells).toEqual(["C2", [{ t: "D", m: { b: true } }]]);
    // neue Zeile
    content.rows.push({ cells: [{ content: [{ type: "text", text: "E", styles: {} }] }, { content: [] }] } as never);
    const more = materializeDoc(store, "p", blocks, { now: 1, newID: () => "r3" });
    const r3 = more.puts.find((b) => b.id === "r3")!;
    expect(r3.parent).toBe("b:tb");
    expect(r3.props!.cells).toEqual(["E", ""]);
  });

  it("Unterseite entfernen → Papierkorb; wieder einfügen (Undo) → zurück", () => {
    const store = corpusStore();
    const blocks = projectDoc(store, "p-root");
    const without = blocks.filter((b) => b.id !== "p-url");
    const c1 = materializeDoc(store, "p-root", without, { now: 9 });
    expect(c1.removeBlocks).toEqual([]);
    expect(c1.puts.map((b) => [b.id, b.trashedAt])).toEqual([["p-url", 9]]);
    store.transact("x", (tx) => tx.put({ kind: "block", data: c1.puts[0]! }));
    const c2 = materializeDoc(store, "p-root", blocks, { now: 10 });
    expect(c2.puts.map((b) => [b.id, b.trashedAt])).toEqual([["p-url", undefined]]);
  });
});
