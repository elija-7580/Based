// BSD-275: wann der Willkommensbildschirm aussteht.
import { afterEach, describe, expect, it } from "vitest";
import { firstRun, welcomeAllowed } from "./firstRun.js";

afterEach(() => {
  firstRun.done();
  firstRun._reset();
});

describe("firstRun", () => {
  it("frisch angelegter Workspace → Willkommen steht aus, mit der Willkommensseite", () => {
    let calls = 0;
    const off = firstRun.subscribe(() => calls++);
    firstRun.noteInit({ created: true, homePageID: "W1" }, true);
    expect(firstRun.get()).toEqual({ page: "W1" });
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
});
