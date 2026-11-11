// BSD-263: Board-Schema in Yjs – gleichzeitige Änderungen verschiedener Felder bleiben beide, Löschen nimmt
// hängende Verbindungen mit, Tinte und unbekannte Felder überstehen den Weg durch Yjs.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeInk, decodeInk, type WBObject } from "@based/core";
import { addObject, BOARD_META, BOARD_VERSION, bringToFront, readBoard, removeObjects, updateObject } from "../src/whiteboard/yboard.js";

const note = (id: string, z: string): WBObject => ({ id, kind: "note", z, x: 0, y: 0, w: 100, h: 80, rot: 0, text: id });
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

describe("Whiteboard in Yjs", () => {
  it("behält gleichzeitige Änderungen verschiedener Felder", () => {
    const a = new Y.Doc(), b = new Y.Doc();
    addObject(a, note("n1", "a0"));
    sync(a, b);
    expect(a.getMap(BOARD_META).get("version")).toBe(BOARD_VERSION);
    updateObject(a, "n1", { x: 50, y: 60 });
    updateObject(b, "n1", { style: { color: "yellow" } });
    sync(a, b);
    for (const d of [a, b]) {
      const [o] = readBoard(d);
      expect(o).toMatchObject({ id: "n1", x: 50, y: 60, style: { color: "yellow" } });
    }
  });

  it("holt nach vorn und sortiert nach z", () => {
    const d = new Y.Doc();
    addObject(d, note("n1", "a0"));
    addObject(d, note("n2", "a1"));
    expect(readBoard(d).map((o) => o.id)).toEqual(["n1", "n2"]);
    bringToFront(d, "n1");
    expect(readBoard(d).map((o) => o.id)).toEqual(["n2", "n1"]);
  });

  it("löscht hängende Verbindungen mit", () => {
    const d = new Y.Doc();
    addObject(d, note("n1", "a0"));
    addObject(d, note("n2", "a1"));
    addObject(d, { id: "c1", kind: "connector", z: "a2", from: { id: "n1", side: "right" }, to: { id: "n2", side: "auto" }, shape: "curved" });
    expect(removeObjects(d, ["n1"]).sort()).toEqual(["c1", "n1"]);
    expect(readBoard(d).map((o) => o.id)).toEqual(["n2"]);
  });

  it("Tinte und unbekannte Felder überstehen Yjs", () => {
    const pts = [{ x: 0, y: 0, p: 0.5 }, { x: 3.2, y: -1.5, p: 0.7 }];
    const a = new Y.Doc(), b = new Y.Doc();
    addObject(a, { id: "i1", kind: "ink", z: "a0", x: 10, y: 10, w: 5, h: 5, rot: 0, ink: encodeInk(pts), extra: { future: { k: 1 } } });
    sync(a, b);
    const [o] = readBoard(b);
    expect(o?.kind).toBe("ink");
    if (o?.kind !== "ink") return;
    expect(o.extra).toEqual({ future: { k: 1 } });
    expect(decodeInk(o.ink!).map((p) => p.x)).toEqual([0, 3.2]);
  });
});
