import { describe, expect, it } from "vitest";
import { holdDetector, shortcutLabel } from "../src/holdKey.js";

function setup() {
  const timers: { f: () => void; id: number }[] = [];
  let id = 0;
  const seen: boolean[] = [];
  const d = holdDetector({
    modifier: "Meta", delayMs: 500, onChange: (v) => seen.push(v),
    setTimer: (f) => { timers.push({ f, id: ++id }); return id; },
    clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = () => { const t = timers.splice(0); t.forEach((x) => x.f()); };
  const ev = (key: string, meta = true, extra: Partial<{ shiftKey: boolean; altKey: boolean; repeat: boolean }> = {}) => ({ key, metaKey: meta, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
  return { d, fire, seen, ev, timers };
}

describe("⌘ halten zeigt Kürzel (BSD-270)", () => {
  it("nach der Verzögerung sichtbar, Loslassen blendet aus", () => {
    const { d, fire, seen, ev } = setup();
    d.keydown(ev("Meta"));
    expect(seen).toEqual([]);
    fire();
    expect(d.visible).toBe(true);
    d.keyup(ev("Meta", false));
    expect(seen).toEqual([true, false]);
  });
  it("⌘+Taste vor Ablauf: nichts blitzt auf; Taste bei sichtbaren Plaketten blendet aus", () => {
    const { d, fire, seen, ev, timers } = setup();
    d.keydown(ev("Meta"));
    d.keydown(ev("k"));
    expect(timers).toHaveLength(0);
    fire();
    expect(seen).toEqual([]);
    d.keyup(ev("Meta", false));
    d.keydown(ev("Meta"));
    fire();
    d.keydown(ev("1"));
    expect(seen).toEqual([true, false]);
  });
  it("Wiederholung startet nicht neu; ⇧⌘ zählt nicht; Abbruch durch Klick", () => {
    const { d, fire, seen, ev, timers } = setup();
    d.keydown(ev("Meta", true, { shiftKey: true }));
    expect(timers).toHaveLength(0);
    d.keydown(ev("Meta"));
    d.keydown(ev("Meta", true, { repeat: true }));
    expect(timers).toHaveLength(1);
    d.cancel();
    fire();
    expect(seen).toEqual([]);
  });
  it("Beschriftung je Plattform", () => {
    expect(shortcutLabel("k", { apple: true })).toBe("⌘K");
    expect(shortcutLabel("l", { apple: true, shift: true })).toBe("⇧⌘L");
    expect(shortcutLabel("k", { apple: false })).toBe("Ctrl+K");
  });
});
