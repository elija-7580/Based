// BSD-275: wann der Willkommensbildschirm aussteht.
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstRun, welcomeAllowed, welcomeTour } from "./firstRun.js";

afterEach(() => {
  firstRun.done();
  firstRun._reset();
});

describe("firstRun", () => {
  it("frisch angelegter Workspace → Willkommen steht aus, mit der Willkommensseite", () => {
    let calls = 0;
    const off = firstRun.subscribe(() => calls++);
    firstRun.noteInit({ created: true, homePageID: "W1" }, true);
    expect(firstRun.get()).toEqual({ page: "W1", step: "welcome" });
    expect(calls).toBe(1);
    firstRun.done();
    expect(firstRun.get()).toBeUndefined();
    off();
  });

  it("bestehender Workspace, ohne Willkommensseite oder nicht erlaubt → nichts", () => {
    firstRun.noteInit({ created: false, homePageID: "W1" }, true);
    firstRun.noteInit({ created: true }, true);
    firstRun.noteInit({ created: true, homePageID: "W1" }, false);
    firstRun.noteInit({ created: true, homePageID: "W1", persistent: false }, true);
    expect(firstRun.get()).toBeUndefined();
  });

  it("automatisierte Browser bekommen ihn nur, wenn ein Test ihn einschaltet", () => {
    expect(welcomeAllowed({ webdriver: false })).toBe(true);
    expect(welcomeAllowed({})).toBe(true);
    expect(welcomeAllowed({ webdriver: true })).toBe(false);
    expect(welcomeAllowed({ webdriver: true, force: true })).toBe(true);
    expect(welcomeAllowed({ webdriver: false, force: false })).toBe(false);
  });

  it("BSD-551: Schritt des Einstiegs bleibt über Neuladen; alter Merker ohne Schritt bleibt ohne (direkt zur Wahl)", () => {
    const m = new Map<string, string>();
    const localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    vi.stubGlobal("localStorage", localStorage);
    firstRun.noteInit({ created: true, homePageID: "W1" }, true);
    firstRun.setStep("beta");
    firstRun._reset();
    expect(firstRun.get()).toEqual({ page: "W1", step: "beta" });
    localStorage.setItem("based.welcome", JSON.stringify({ page: "OLD" }));
    firstRun._reset();
    expect(firstRun.get()).toEqual({ page: "OLD" });
    localStorage.setItem("based.welcome", JSON.stringify({ page: "X", step: "nope" }));
    firstRun._reset();
    expect(firstRun.get()).toEqual({ page: "X" });
    // ohne ausstehendes Willkommen ändert setStep nichts
    firstRun.done();
    firstRun.setStep("data");
    expect(firstRun.get()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("BSD-551: Wiederaufruf öffnet und schließt, ohne den Merker anzufassen", () => {
    let calls = 0;
    const off = welcomeTour.subscribe(() => calls++);
    welcomeTour.show();
    welcomeTour.show();
    expect(welcomeTour.get()).toBe(true);
    welcomeTour.close();
    expect(welcomeTour.get()).toBe(false);
    expect(calls).toBe(2);
    expect(firstRun.get()).toBeUndefined();
    off();
  });
});
