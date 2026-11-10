import { describe, expect, it } from "vitest";
import { pickRange } from "./sidebarModel.js";

describe("Seitenleiste: Bereichsauswahl (BSD-203)", () => {
  it("nimmt alles zwischen Anker und Ziel, in beide Richtungen", () => {
    const order = ["a", "b", "c", "d"];
    expect(pickRange(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(pickRange(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(pickRange(order, "c", "c")).toEqual(["c"]);
    expect(pickRange(order, "x", "c")).toEqual([]);
  });
});
