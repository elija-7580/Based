// BSD-263: Whiteboard-Datenmodell und Tinten-Codec.
import { describe, expect, it } from "vitest";
import { backZ, bounds, danglingConnectors, decodeInk, encodeInk, frontZ, INK_SCALE, InkFormatError, parseWBObject, sortByZ, wbFields, type InkPoint, type WBObject } from "../src/index.js";

function stroke(n: number): InkPoint[] {
  // Spirale mit wechselndem Druck (deterministisch)
  return Array.from({ length: n }, (_, i) => ({ x: 400 + Math.cos(i / 9) * i * 0.7, y: 300 + Math.sin(i / 9) * i * 0.7, p: 0.3 + 0.5 * Math.abs(Math.sin(i / 17)) }));
}

describe("Tinten-Codec", () => {
  it("Rundreise innerhalb der Quantisierung (1/10 px, Druck 1/255)", () => {
    const pts = stroke(500);
    const back = decodeInk(encodeInk(pts));
    expect(back).toHaveLength(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(Math.abs(back[i]!.x - pts[i]!.x)).toBeLessThanOrEqual(0.5 / INK_SCALE + 1e-9);
      expect(Math.abs(back[i]!.y - pts[i]!.y)).toBeLessThanOrEqual(0.5 / INK_SCALE + 1e-9);
      expect(Math.abs(back[i]!.p - pts[i]!.p)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
    }
  });

  it("kleiner als JSON (festgehalten: rund 27 % der kompakten JSON-Größe, 2 504 Bytes für 500 Punkte)", () => {
    const pts = stroke(500);
    const bin = encodeInk(pts).length;
    const json = new TextEncoder().encode(JSON.stringify(pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.p * 100) / 100]))).length;
    expect(bin).toBe(5 + 9 + 499 * 5);
    expect(bin / json).toBeLessThan(0.3);
  });

  it("große Sprünge (über Int16) über Escape, negative Koordinaten, leer, ein Punkt", () => {
    const pts: InkPoint[] = [{ x: -5, y: -7.3, p: 1 }, { x: 10_000, y: -9_000, p: 0 }, { x: 10_000.4, y: -9_000.1, p: 0.5 }];
    const back = decodeInk(encodeInk(pts));
    expect(back.map((p) => [p.x, p.y])).toEqual([[-5, -7.3], [10000, -9000], [10000.4, -9000.1]]);
    expect(decodeInk(encodeInk([]))).toEqual([]);
    expect(decodeInk(encodeInk([{ x: 1, y: 2, p: 0.5 }]))[0]!.x).toBe(1);
  });

  it("kaputte oder neuere Daten: Fehler statt falscher Punkte", () => {
    const ok = encodeInk(stroke(10));
    expect(() => decodeInk(ok.slice(0, ok.length - 3))).toThrow(InkFormatError);
    const newer = ok.slice(); newer[0] = 2;
    expect(() => decodeInk(newer)).toThrow(/newer version/);
    expect(() => decodeInk(new Uint8Array(2))).toThrow(InkFormatError);
    expect(() => encodeInk([{ x: Number.NaN, y: 0, p: 0 }])).toThrow(RangeError);
  });
});

describe("Board-Objekte", () => {
  it("parseWBObject: Standardwerte, unbekannte Felder bleiben, Unbrauchbares fällt weg", () => {
    const s = parseWBObject({ id: "a", kind: "note", x: 10, y: 20, w: 100, h: 80, z: "a0", text: "Hi", future: { x: 1 }, style: { color: "yellow", bad: {} } })!;
    expect(s).toMatchObject({ kind: "note", x: 10, rot: 0, text: "Hi", style: { color: "yellow" }, extra: { future: { x: 1 } } });
    expect(wbFields(s)).toMatchObject({ future: { x: 1 }, id: "a", text: "Hi" });
    expect(parseWBObject({ id: "b", kind: "shape", w: -5 })).toMatchObject({ w: 0, x: 0, z: "a0" });
    expect(parseWBObject({ id: "c", kind: "hologram" })).toBeUndefined();
    expect(parseWBObject({ kind: "note" })).toBeUndefined();
    expect(parseWBObject({ id: "d", kind: "connector", from: { id: "a" } })).toBeUndefined();
    expect(parseWBObject({ id: "e", kind: "connector", from: { id: "a", side: "left" }, to: { id: "b", side: "weird" }, shape: "elbow" })).toMatchObject({ from: { side: "left" }, to: { side: "auto" }, shape: "elbow" });
  });

  it("z-Reihenfolge: vorn/hinten ohne Umnummerieren, deterministisch bei Gleichstand", () => {
    const objs = [{ id: "b", z: "a1" }, { id: "a", z: "a1" }, { id: "c", z: "a0" }];
    expect(sortByZ(objs).map((o) => o.id)).toEqual(["c", "a", "b"]);
    const f = frontZ(objs), b = backZ(objs);
    expect(f > "a1").toBe(true);
    expect(b < "a0").toBe(true);
    expect(frontZ([])).toBeTruthy();
  });

  it("Bounds gedreht, verwaiste Verbindungen", () => {
    expect(bounds({ x: 0, y: 0, w: 100, h: 50, rot: 0 })).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    const r = bounds({ x: 0, y: 0, w: 100, h: 50, rot: 90 });
    expect(Math.round(r.w)).toBe(50);
    expect(Math.round(r.h)).toBe(100);
    const objs = [parseWBObject({ id: "a", kind: "note" })!, parseWBObject({ id: "b", kind: "note" })!, parseWBObject({ id: "k", kind: "connector", from: { id: "a" }, to: { id: "b" } })!] as WBObject[];
    expect(danglingConnectors(objs, new Set(["b"]))).toEqual(["k"]);
    expect(danglingConnectors(objs, new Set(["x"]))).toEqual([]);
  });
});
