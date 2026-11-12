import { describe, expect, it } from "vitest";
import { aiOn } from "./ai.js";

describe("AI-Schalter: Regel", () => {
  it("Standard aus; gespeicherte Wahl gilt", () => {
    expect(aiOn(true, undefined, false)).toBe(false);
    expect(aiOn(true, true, false)).toBe(true);
    expect(aiOn(true, false, true)).toBe(false);
    expect(aiOn(true, "ja", false)).toBe(false);
  });
  it("Beta-Build (ohne Option): immer aus, auch mit gespeicherter Wahl oder Standard an", () => {
    expect(aiOn(false, true, true)).toBe(false);
  });
});
