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
  it("kommt ein Knoten dazu, bleiben die bekannten genau stehen; nur der neue sucht sich einen Platz", () => {
    forgetPositions();
    rememberPositions({ ids: ["a", "b"], x: Float32Array.from([10, 80]), y: Float32Array.from([30, 40]) });
    const l = startLayout(["a", "b", "c"], [[0, 1], [1, 2]], undefined, false);
    expect(l.settled).toBe(false);
    const start = { x: l.x[2]!, y: l.y[2]! };
    for (let i = 0; i < 400 && !l.settled; i++) l.tick(5);
    expect(l.settled).toBe(true);
    expect([l.x[0], l.y[0], l.x[1], l.y[1]]).toEqual([10, 30, 80, 40]);
    expect(Number.isFinite(l.x[2]!) && Number.isFinite(l.y[2]!)).toBe(true);
    expect(start.x !== 0 || start.y !== 0).toBe(true);
  });
  it("gemerkt wird je Knoten: ein Teilbild (Filter) verdrängt die übrigen Plätze nicht", () => {
    forgetPositions();
    rememberPositions({ ids: ["a", "b", "c"], x: Float32Array.from([1, 2, 3]), y: Float32Array.from([4, 5, 6]) });
    rememberPositions({ ids: ["b"], x: Float32Array.from([20]), y: Float32Array.from([50]) });
    const l = startLayout(["a", "b", "c"], [], undefined, false);
    expect(l.settled).toBe(true);
    expect([l.x[0], l.x[1], l.x[2]]).toEqual([1, 20, 3]);
  });
  it("ein Layout, das noch rechnet, wird durch neue Daten nicht eingefroren", () => {
    forgetPositions();
    const running = startLayout(["a", "b"], [[0, 1]], undefined, false);
    expect(running.settled).toBe(false);
    const next = startLayout(["a", "b"], [[0, 1]], running, false);
    expect(next.settled).toBe(false);
  });
});
