import { describe, expect, it } from "vitest";
import { graphStep } from "./graphKeys.js";

describe("Graph per Tastatur (BSD-238 Teil 3)", () => {
  // 0 Mitte, 1 rechts nah, 2 rechts weit, 3 oben, 4 schräg rechts unten (45°), 5 links weit
  const xs = [0, 10, 40, 0, 20, -100], ys = [0, 1, 0, -30, 20, 0];
  it("wählt den nächsten Knoten im Kegel der Richtung", () => {
    expect(graphStep(xs, ys, 0, "right")).toBe(1);
    expect(graphStep(xs, ys, 1, "right")).toBe(2);
    expect(graphStep(xs, ys, 0, "up")).toBe(3);
    expect(graphStep(xs, ys, 0, "down")).toBe(4);
    expect(graphStep(xs, ys, 0, "left")).toBe(5);
    expect(graphStep(xs, ys, 5, "left")).toBe(-1);
  });
});
