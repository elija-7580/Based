// BSD-265 (Whiteboard 3): Tinte ausdünnen, Treffer nur auf dem Strich, Lasso, Frame nur am Rand greifbar.
import { describe, expect, it } from "vitest";
import { distanceToInk, encodeInk, hitsObject, inkObjectGeometry, inkPointsOf, pointInPolygon, shareInside, simplifyInk, type InkPoint, type WBShape } from "../src/index.js";

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
