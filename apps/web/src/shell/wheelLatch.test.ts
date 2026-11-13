import { describe, expect, it } from "vitest";
import { LATCH_MS, latch, type LatchState } from "./wheelLatch.js";

describe("BSD-374: Scroll-Geste bleibt am Bereich, in dem sie begann", () => {
  const start: LatchState<string> = { target: null, last: -Infinity };
  it("erste Geste: der natürliche Bereich, keine Umleitung", () => {
    const r = latch(start, 0, "page");
    expect(r).toEqual({ state: { target: "page", last: 0 }, redirect: null });
  });
  it("laufende Geste über einem inneren Feld: weiter der äußere Bereich", () => {
    let s = latch(start, 0, "page").state;
    const r = latch(s, 40, "log");
    expect(r.redirect).toBe("page");
    s = r.state;
    expect(latch(s, 40 + LATCH_MS - 1, "log").redirect).toBe("page");
  });
  it("nach der Pause beginnt eine neue Geste im inneren Feld", () => {
    const s = latch(start, 0, "page").state;
    expect(latch(s, LATCH_MS + 1, "log")).toEqual({ state: { target: "log", last: LATCH_MS + 1 }, redirect: null });
  });
  it("die Geste verlängert sich mit jedem Ereignis (Trackpad-Schwung)", () => {
    let s = latch(start, 0, "page").state;
    for (let t = 100; t <= 1000; t += 100) s = latch(s, t, "log").state;
    expect(s.target).toBe("page");
  });
  it("verschwundener Bereich: neue Geste", () => {
    const s = latch(start, 0, "gone").state;
    expect(latch(s, 10, "page", (t) => t !== "gone").redirect).toBeNull();
  });
});
