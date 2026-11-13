// BSD-286: Text des Uhr-Hinweises in Sync & server und Diagnose.
import { describe, expect, it } from "vitest";
import { clockSkewText } from "./clockSkew.js";

describe("clockSkewText", () => {
  it("nach/vor, Stunden und Minuten, Tage", () => {
    expect(clockSkewText(3900)).toBe("This device's clock is 1 h 5 min behind the server");
    expect(clockSkewText(-172_800)).toBe("This device's clock is 2 d ahead of the server");
    expect(clockSkewText(-150)).toBe("This device's clock is 3 min ahead of the server");
    expect(clockSkewText(3600)).toBe("This device's clock is 1 h behind the server");
  });
});
