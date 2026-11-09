import { describe, expect, it } from "vitest";
import { scrollToReveal, windowRange } from "../src/index.js";

describe("windowRange", () => {
  it("leere Liste", () => expect(windowRange(0, 32, 0, 600)).toEqual({ start: 0, end: 0 }));
  it("oben: sichtbar + Vorrat unten", () => expect(windowRange(5000, 32, 0, 640, 8)).toEqual({ start: 0, end: 29 }));
  it("Mitte: begrenzt, unabhängig von der Länge", () => {
    const r = windowRange(5000, 32, 32 * 2500, 640, 8);
    expect(r).toEqual({ start: 2492, end: 2529 });
    expect(r.end - r.start).toBeLessThanOrEqual(640 / 32 + 2 * 8 + 1);
  });
  it("über das Ende hinaus gescrollt", () => expect(windowRange(10, 32, 10_000, 640, 2)).toEqual({ start: 7, end: 10 }));
});

describe("scrollToReveal", () => {
  it("lässt sichtbare Zeilen in Ruhe, scrollt sonst minimal", () => {
    expect(scrollToReveal(3, 32, 0, 320)).toBe(0);
    expect(scrollToReveal(20, 32, 0, 320)).toBe(21 * 32 - 320);
    expect(scrollToReveal(1, 32, 200, 320)).toBe(32);
  });
});
