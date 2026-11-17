// BSD-265 (Whiteboard 3): Tinte ausdünnen, Treffer nur auf dem Strich, Lasso, Frame nur am Rand greifbar.
import { describe, expect, it } from "vitest";
import { backlinksTo, boardObjectToBlock, buildPageGraph, createBoardPage, createPage, distanceToInk, encodeInk, hitsObject, inkObjectGeometry, inkPointsOf, MemoryPersistence, pointInPolygon, recognizeShape, shareInside, simplifyInk, WorkspaceStore, type WBObject, type InkPoint, type WBShape } from "../src/index.js";

const line = (n: number, f: (i: number) => [number, number, number?]): InkPoint[] => Array.from({ length: n }, (_, i) => { const [x, y, p] = f(i); return { x, y, p: p ?? 0.5 }; });

describe("simplifyInk", () => {
  it("eine gerade Linie aus 500 Punkten wird zu zwei Punkten", () => {
    expect(simplifyInk(line(500, (i) => [i, i * 2]))).toHaveLength(2);
  });
  it("Ecken und Bögen bleiben innerhalb der Toleranz", () => {
    const pts = line(400, (i) => [Math.cos(i / 40) * 100, Math.sin(i / 40) * 100]);
    const out = simplifyInk(pts, 0.35);
    expect(out.length).toBeLessThan(pts.length / 3);
    for (const p of pts) expect(distanceToInk(out, p)).toBeLessThanOrEqual(0.36);
  });
  it("ein Druckwechsel auf gerader Strecke bleibt erhalten", () => {
    const out = simplifyInk(line(100, (i) => [i, 0, i < 50 ? 0.2 : 0.9]));
    expect(out.length).toBeGreaterThan(2);
    expect(Math.max(...out.map((p) => p.p))).toBe(0.9);
  });
  it("kurze Folgen bleiben, wie sie sind", () => {
    expect(simplifyInk([])).toEqual([]);
    expect(simplifyInk([{ x: 1, y: 2, p: 0.5 }])).toEqual([{ x: 1, y: 2, p: 0.5 }]);
  });
  it("ein ausgedünnter Strich braucht deutlich weniger Bytes", () => {
    const pts = line(2000, (i) => [i * 0.3, Math.sin(i / 200) * 40]);
    expect(encodeInk(simplifyInk(pts)).length).toBeLessThan(encodeInk(pts).length / 10);
  });
});

describe("Tinte als Objekt", () => {
  const world = line(50, (i) => [100 + i * 4, 200 + (i % 2)]);
  const geo = inkObjectGeometry(world, 3)!;
  const ink: WBShape = { id: "i", kind: "ink", z: "a0", x: geo.x, y: geo.y, w: geo.w, h: geo.h, rot: 0, ink: encodeInk(geo.points), style: { width: 2.6, bw: geo.w, bh: geo.h } };
  const byID = new Map([[ink.id, ink]]);

  it("Rahmen umschließt die Punkte mit Rand, Punkte liegen relativ dazu", () => {
    expect(geo.x).toBeLessThanOrEqual(97);
    expect(geo.points[0]!.x).toBeCloseTo(100 - geo.x, 5);
    expect(inkPointsOf(ink.ink!)).toHaveLength(50);
  });
  it("Treffer nur auf dem Strich, nicht irgendwo im Rahmen", () => {
    const tall: WBShape = { ...ink, h: 200, style: { ...ink.style, bh: 200 } };
    expect(hitsObject(ink, { x: 150, y: 200 }, byID)).toBe(true);
    expect(hitsObject(tall, { x: 150, y: geo.y + 150 }, byID)).toBe(false);
  });
  it("ein vergrößerter Strich wird an der gestreckten Stelle getroffen", () => {
    const big: WBShape = { ...ink, w: geo.w * 2 };
    expect(hitsObject(big, { x: geo.x + (150 - geo.x) * 2, y: 200 }, byID)).toBe(true);
  });
  it("Frame: Titel und Rand greifen, die Mitte nicht", () => {
    const frame: WBShape = { id: "f", kind: "frame", z: "a0", x: 0, y: 0, w: 400, h: 300, rot: 0 };
    const m = new Map([[frame.id, frame]]);
    expect(hitsObject(frame, { x: 200, y: 20 }, m)).toBe(true);
    expect(hitsObject(frame, { x: 3, y: 150 }, m)).toBe(true);
    expect(hitsObject(frame, { x: 200, y: 150 }, m)).toBe(false);
  });
});

describe("Lasso", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  it("Punkt im Vieleck", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });
  it("Anteil der Punkte im Lasso", () => {
    expect(shareInside([{ x: 5, y: 5 }, { x: 6, y: 6 }, { x: 20, y: 20 }, { x: 1, y: 1 }], square)).toBe(0.75);
    expect(shareInside([], square)).toBe(0);
  });
});

describe("recognizeShape", () => {
  const circle = Array.from({ length: 60 }, (_, i) => ({ x: 200 + Math.cos((i / 59) * Math.PI * 2) * 80 + (i % 3), y: 200 + Math.sin((i / 59) * Math.PI * 2) * 50 }));
  const box = [...Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: 0 })), ...Array.from({ length: 12 }, (_, i) => ({ x: 200, y: i * 10 })), ...Array.from({ length: 20 }, (_, i) => ({ x: 200 - i * 10, y: 120 })), ...Array.from({ length: 12 }, (_, i) => ({ x: 2, y: 120 - i * 10 }))];
  it("Oval, Rechteck, gerade Linie", () => {
    expect(recognizeShape(circle)?.kind).toBe("oval");
    expect(recognizeShape(box)?.kind).toBe("rect");
    expect(recognizeShape(Array.from({ length: 30 }, (_, i) => ({ x: i * 8, y: i * 3 + (i % 2) })))?.kind).toBe("line");
  });
  it("Handschrift und Winziges bleiben, was sie sind", () => {
    expect(recognizeShape(Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: Math.sin(i / 3) * 30 })))).toBeUndefined();
    expect(recognizeShape([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBeUndefined();
  });
});

// BSD-267: Seitenkarten und Verbindungen zwischen ihnen sind echte Links (Backlinks, Graph).
describe("echte Links vom Board", () => {
  it("Karte: Board → Seite. Verbindung zwischen zwei Karten: Seite → Seite. Verbindung zu einem Zettel: kein Link", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => 1 });
    const a = createPage(store, { title: "A" }), b = createPage(store, { title: "B" });
    const board = createBoardPage(store, { title: "Map" });
    const objs: WBObject[] = [
      { id: "ca", kind: "page", z: "a0", x: 0, y: 0, w: 240, h: 72, rot: 0, ref: a },
      { id: "cb", kind: "page", z: "a1", x: 400, y: 0, w: 240, h: 72, rot: 0, ref: b },
      { id: "n", kind: "note", z: "a2", x: 0, y: 200, w: 168, h: 150, rot: 0 },
      { id: "ab", kind: "connector", z: "a3", from: { id: "ca", side: "auto" }, to: { id: "cb", side: "auto" }, shape: "curved" },
      { id: "an", kind: "connector", z: "a4", from: { id: "ca", side: "auto" }, to: { id: "n", side: "auto" }, shape: "curved" },
    ];
    const byID = new Map(objs.map((o) => [o.id, o]));
    store.transact("draw", (tx) => { for (const o of objs) tx.put({ kind: "block", data: boardObjectToBlock(o, board, 1, undefined, byID) }); });
    expect(backlinksTo(store, b).sort()).toEqual([a, board].sort());
    expect(backlinksTo(store, a)).toEqual([board]);
    const edges = buildPageGraph(store).edges.filter((e) => e.k === "mention").map((e) => `${e.s}>${e.t}`);
    expect(edges).toContain(`${a}>${b}`);
    expect(edges).toContain(`${board}>${a}`);
    expect(edges).not.toContain(`${b}>${a}`);
    // Ohne die Karten (umgeschrieben ohne Nachbarn) verschwindet der Seiten-Link wieder.
    store.transact("redo", (tx) => tx.put({ kind: "block", data: boardObjectToBlock(objs[3]!, board, 2, store.blocks.get("ab")) }));
    expect(backlinksTo(store, b)).toEqual([board]);
  });
});
