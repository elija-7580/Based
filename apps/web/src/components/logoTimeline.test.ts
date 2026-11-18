import { describe, expect, it } from "vitest";
import { LOGO_INTRO_DONE, MARK, TIMING, logoIntroFrame } from "./logoTimeline.js";

const steps = (from: number, to: number, by = 8) => Array.from({ length: Math.ceil((to - from) / by) + 1 }, (_, i) => Math.min(to, from + i * by));

describe("Logo-Intro", () => {
  it("beginnt als Punkt: nur die Basis, so breit wie hoch, keine Einfügemarke", () => {
    const f = logoIntroFrame(0);
    expect(f.baseWidth).toBe(MARK.base.height);
    expect(f.stem.visible).toBe(false);
    expect(f.belly.visible).toBe(false);
    expect(f.caret.opacity).toBe(0);
    expect(f.done).toBe(false);
  });

  it("Reihenfolge: Linie in einem Zug, dann der Stamm, dann der Bauch", () => {
    const widths = steps(0, TIMING.caretStart).map((t) => logoIntroFrame(t).baseWidth);
    expect(widths.every((w, i) => i === 0 || w >= widths[i - 1]!)).toBe(true);
    expect(logoIntroFrame(TIMING.caretStart).baseWidth).toBeCloseTo(MARK.base.width, 5);

    const beforeStem = logoIntroFrame(TIMING.stemKey - 1);
    expect([beforeStem.stem.visible, beforeStem.belly.visible]).toEqual([false, false]);
    const beforeBelly = logoIntroFrame(TIMING.bellyKey - 1);
    expect([beforeBelly.stem.visible, beforeBelly.belly.visible]).toEqual([true, false]);
    expect(logoIntroFrame(TIMING.bellyKey).belly.visible).toBe(true);
  });

  it("die Einfügemarke steht dort, wo als Nächstes getippt wird, und verschwindet am Ende", () => {
    expect(logoIntroFrame(TIMING.caretStart).caret).toEqual({ x: MARK.stem.x, opacity: 1 });
    expect(logoIntroFrame(TIMING.stemKey).caret).toEqual({ x: MARK.belly.x, opacity: 1 });
    const after = logoIntroFrame(TIMING.bellyKey).caret;
    expect(after.x).toBeGreaterThan(MARK.belly.x + MARK.belly.width);
    expect(logoIntroFrame(TIMING.bellyKey + TIMING.caretLeave + TIMING.caretFade).caret.opacity).toBe(0);
  });

  it("Blöcke fallen auf die Linie und kippeln, ohne umzufallen oder sich zu berühren", () => {
    expect(logoIntroFrame(TIMING.stemKey).stem.dy).toBeLessThan(0);
    const gap = MARK.belly.x - (MARK.stem.x + MARK.stem.width);
    for (const t of steps(TIMING.stemKey, LOGO_INTRO_DONE, 4)) {
      const f = logoIntroFrame(t);
      expect(Math.abs(f.stem.angle)).toBeLessThan(5);
      expect(Math.abs(f.belly.angle)).toBeLessThan(5);
      if (f.belly.visible) {
        // Stamm neigt sich nach rechts, Bauch nach links: zusammen weniger als die Lücke (auf Höhe der Bauchoberkante)
        const lean = Math.sin((Math.max(0, f.stem.angle) * Math.PI) / 180) * MARK.belly.height + Math.sin((Math.max(0, -f.belly.angle) * Math.PI) / 180) * MARK.belly.height;
        expect(lean).toBeLessThan(gap);
      }
    }
  });

  it("endet genau im ruhenden Zeichen", () => {
    for (const t of [LOGO_INTRO_DONE, LOGO_INTRO_DONE + 5000, Infinity]) {
      const f = logoIntroFrame(t);
      expect(f.done).toBe(true);
      expect(f.baseWidth).toBe(MARK.base.width);
      expect(f.dip).toBe(0);
      expect(f.caret.opacity).toBe(0);
      for (const b of [f.stem, f.belly]) expect([b.visible, b.dy, b.angle]).toEqual([true, 0, 0]);
    }
    expect(Math.abs(logoIntroFrame(LOGO_INTRO_DONE - 1).stem.angle)).toBeLessThan(0.05);
  });
});
