import { describe, expect, it } from "vitest";
import { marqueeRange, rectFrom, siblingSpan } from "../src/ui/blockSelect.js";

describe("Blockauswahl mit der Maus (BSD-258)", () => {
  it("Rechteck trifft Blöcke nach der Höhe", () => {
    const blocks = [{ id: "a", top: 0, bottom: 20 }, { id: "b", top: 24, bottom: 44 }, { id: "c", top: 48, bottom: 68 }];
    expect(marqueeRange(rectFrom({ x: 5, y: 30 }, { x: 0, y: 50 }), blocks)).toEqual({ anchor: "b", head: "c" });
    expect(marqueeRange(rectFrom({ x: 0, y: 10 }, { x: 5, y: 12 }), blocks)).toEqual({ anchor: "a", head: "a" });
    expect(marqueeRange(rectFrom({ x: 0, y: 80 }, { x: 5, y: 90 }), blocks)).toBeUndefined();
  });
  it("Spanne über Ebenen: die Vorfahren unter dem gemeinsamen Elternteil", () => {
    const parent: Record<string, string> = { a1: "a", a2: "a", b1: "b", b11: "b1" };
    const parentOf = (id: string) => (parent[id] ? { id: parent[id]! } : undefined);
    expect(siblingSpan(parentOf, "a1", "b11")).toEqual({ anchor: "a", head: "b" });
    expect(siblingSpan(parentOf, "a1", "a2")).toEqual({ anchor: "a1", head: "a2" });
    expect(siblingSpan(parentOf, "x", "b11")).toEqual({ anchor: "x", head: "b" });
    expect(siblingSpan(parentOf, "b", "b11")).toEqual({ anchor: "b", head: "b" });
  });
});
