import { describe, expect, it } from "vitest";
import { columnFractions, resizeColumns } from "../src/ui/columns.js";

describe("Spaltenbreiten", () => {
  it("ohne Anteile gleich breit, fehlende teilen sich den Rest", () => {
    expect(columnFractions([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25]);
    const f = columnFractions([0.5, 0, 0]);
    expect(f.map((x) => Math.round(x * 100))).toEqual([50, 25, 25]);
    expect(columnFractions([2, 2]).map((x) => x)).toEqual([0.5, 0.5]);
    expect(columnFractions([1, 0]).every((x) => x > 0)).toBe(true);
    expect(columnFractions([])).toEqual([]);
  });

  it("Ziehen ändert nur die Nachbarn und hält den Mindestanteil", () => {
    expect(resizeColumns([0.2, 0.2, 0.2, 0.2, 0.2], 2, 0.05)).toEqual([0.2, 0.25, 0.15, 0.2, 0.2]);
    expect(resizeColumns([0.5, 0.5], 1, 0.9)).toEqual([0.9, 0.1]);
    expect(resizeColumns([0.5, 0.5], 1, -0.9)).toEqual([0.1, 0.9]);
    expect(resizeColumns([0.5, 0.5], 0, 0.1)).toEqual([0.5, 0.5]);
  });
});
