import { describe, expect, it } from "vitest";
import { nextRegion } from "./regions.js";

describe("F6-Bereiche (BSD-238)", () => {
  it("wandert Seitenleiste → Kopfzeile → Seite und rundherum, überspringt fehlende", () => {
    const all = ["sidebar", "header", "page"] as const;
    expect(nextRegion(undefined, 1, all)).toBe("sidebar");
    expect(nextRegion(undefined, -1, all)).toBe("page");
    expect(nextRegion("sidebar", 1, all)).toBe("header");
    expect(nextRegion("page", 1, all)).toBe("sidebar");
    expect(nextRegion("sidebar", -1, all)).toBe("page");
    expect(nextRegion("sidebar", 1, ["sidebar", "page"])).toBe("page"); // Seiten ohne Kopfzeile (Home)
    expect(nextRegion("header", 1, [])).toBeUndefined();
  });
});
