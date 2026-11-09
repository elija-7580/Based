// @vitest-environment jsdom
// BSD-154: Records ⇄ Y.Doc ⇄ BlockNote, Migration und Rückweg in den Store.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { projectDoc } from "../src/mapping/blocks.js";
import { materializeDoc } from "../src/mapping/materialize.js";
import { createConverter } from "../src/schema/schema.js";
import { corpusStore } from "./helpers.js";

const converter = createConverter();

describe("Y-Dokument", () => {
  it("Korpus: alle Blocktypen hin und zurück über Y ohne Verlust", () => {
    const store = corpusStore();
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment("blocks");
    converter.toFragment(projectDoc(store, "p-root"), frag);
    // über ein zweites Y.Doc (wie nach Speichern und Laden)
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
    const blocks = converter.fromFragment(doc2.getXmlFragment("blocks"));
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    expect(changes.puts.map((b) => [b.id, b])).toEqual([]);
    expect(changes.removeBlocks).toEqual([]);
    console.log(blocks.map((b) => b.type).join(","));
  });
});
