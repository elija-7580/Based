import { describe, expect, it } from "vitest";
import { appearanceStore, DEFAULT_APPEARANCE, effectiveTheme, loadAppearance, platformMaterial, systemPrefersDark } from "./appearance.js";

describe("appearance", () => {
  it("lädt Standard bei fehlendem oder kaputtem Speicher", () => {
    expect(loadAppearance({ getItem: () => null })).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance({ getItem: () => "{kaputt" })).toEqual(DEFAULT_APPEARANCE);
  });
  it("BSD-550: Standard ist „system“; eine gespeicherte Wahl bleibt", () => {
    expect(DEFAULT_APPEARANCE.theme).toBe("system");
    expect(loadAppearance({ getItem: () => null }).theme).toBe("system");
    expect(loadAppearance({ getItem: () => JSON.stringify({ ...DEFAULT_APPEARANCE, theme: "light" }) }).theme).toBe("light");
    expect(loadAppearance({ getItem: () => JSON.stringify({ ...DEFAULT_APPEARANCE, theme: "dark" }) }).theme).toBe("dark");
    expect(loadAppearance({ getItem: () => JSON.stringify({ density: "compact" }) }).theme).toBe("system");
  });
  it("übernimmt nur bekannte Werte", () => {
    const a = loadAppearance({ getItem: () => JSON.stringify({ theme: "dark", marker: "neon", calm: true }) });
    expect(a).toMatchObject({ theme: "dark", marker: "butter", calm: true });
  });
  it("Schrift und Stil sind getrennt; wer früher Bold gespeichert hat, behält dessen Schrift", () => {
    const load = (v: object) => loadAppearance({ getItem: () => JSON.stringify(v) });
    expect(load({ style: "bold" })).toMatchObject({ style: "bold", font: "based" });
    expect(load({ style: "bold", font: "system" })).toMatchObject({ style: "bold", font: "system" });
    expect(load({ font: "based" })).toMatchObject({ style: "default", font: "based" });
    expect(load({ font: "comic" }).font).toBe("system");
    expect(DEFAULT_APPEARANCE.font).toBe("system");
  });
  it("Glas nur auf Apple-Plattformen", () => {
    expect(platformMaterial({ platform: "MacIntel" })).toBe("glass");
    expect(platformMaterial({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe("glass");
    expect(platformMaterial({ platform: "Win32" })).toBe("solid");
    expect(platformMaterial({ platform: "Linux x86_64" })).toBe("solid");
  });
  it("„system“ wird gespeichert und nach dem Systemwunsch aufgelöst", () => {
    expect(loadAppearance({ getItem: () => JSON.stringify({ theme: "system" }) }).theme).toBe("system");
    expect(effectiveTheme({ theme: "system" }, true)).toBe("dark");
    expect(effectiveTheme({ theme: "system" }, false)).toBe("light");
    expect(effectiveTheme({ theme: "dark" }, false)).toBe("dark");
    expect(systemPrefersDark({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(systemPrefersDark({})).toBe(false);
  });
  it("der Store meldet Änderungen an alle Leser", () => {
    appearanceStore._reset();
    let calls = 0;
    const off = appearanceStore.subscribe(() => calls++);
    appearanceStore.set({ ...DEFAULT_APPEARANCE, density: "compact" });
    expect(appearanceStore.get().density).toBe("compact");
    expect(calls).toBe(1);
    off();
    appearanceStore.set(DEFAULT_APPEARANCE);
    expect(calls).toBe(1);
    appearanceStore._reset();
  });
});
