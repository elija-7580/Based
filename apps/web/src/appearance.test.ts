import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, loadAppearance, platformMaterial } from "./appearance.js";

describe("appearance", () => {
  it("lädt Standard bei fehlendem oder kaputtem Speicher", () => {
    expect(loadAppearance({ getItem: () => null })).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance({ getItem: () => "{kaputt" })).toEqual(DEFAULT_APPEARANCE);
  });
  it("übernimmt nur bekannte Werte", () => {
    const a = loadAppearance({ getItem: () => JSON.stringify({ theme: "dark", marker: "neon", calm: true }) });
    expect(a).toMatchObject({ theme: "dark", marker: "butter", calm: true });
  });
  it("Glas nur auf Apple-Plattformen", () => {
    expect(platformMaterial({ platform: "MacIntel" })).toBe("glass");
    expect(platformMaterial({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe("glass");
    expect(platformMaterial({ platform: "Win32" })).toBe("solid");
    expect(platformMaterial({ platform: "Linux x86_64" })).toBe("solid");
  });
});
