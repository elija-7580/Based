// BSD-262 Teil 1: gemerktes Graph-Layout – deckt es alle Knoten ab, startet das Layout ruhend.
import { describe, expect, it } from "vitest";
import { coversAll, forgetPositions, recalledPositions, rememberPositions, startLayout } from "./layoutClient.js";

describe("Graph-Layout merken (BSD-262)", () => {
  it("merken, wiederfinden, vergessen; nur vollständige Abdeckung zählt", () => {
    forgetPositions();
    expect(recalledPositions()).toBeUndefined();
    rememberPositions({ ids: ["a", "b"], x: Float32Array.from([1, 2]), y: Float32Array.from([3, 4]) });
    expect(recalledPositions()?.ids).toEqual(["a", "b"]);
    expect(coversAll(["a", "b"], recalledPositions())).toBe(true);
    expect(coversAll(["a", "c"], recalledPositions())).toBe(false);
    expect(coversAll([], recalledPositions())).toBe(false);
  });
  it("vollständig bekanntes Layout startet ruhend an denselben Plätzen (ohne Worker)", () => {
    rememberPositions({ ids: ["a", "b"], x: Float32Array.from([10, 20]), y: Float32Array.from([30, 40]) });
    const l = startLayout(["a", "b"], [[0, 1]], undefined, false);
    l.tick(50);
    expect(l.settled).toBe(true);
    expect([l.x[0], l.y[1]]).toEqual([10, 40]);
    forgetPositions();
    const fresh = startLayout(["a", "b"], [[0, 1]], undefined, false);
    expect(fresh.settled).toBe(false);
  });
});
