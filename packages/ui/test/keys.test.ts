import { describe, expect, it } from "vitest";
import { kbdKeys } from "../src/astryx/keys.js";
import { comboAccelerator, comboKeys, comboLabel, matchCombo, nextInDirection, parseCombo } from "../src/index.js";

const ev = (key: string, code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });

describe("Tastenkombinationen", () => {
  it("liest Zusätze und Taste", () => {
    expect(parseCombo("Mod+Shift+K")).toEqual({ mod: true, ctrl: false, shift: true, alt: false, key: "k" });
    expect(parseCombo("ArrowUp").key).toBe("arrowup");
  });
  it("zeigt Apple-Symbole bzw. Namen", () => {
    expect(comboLabel("Mod+Shift+K", true)).toBe("⇧⌘K");
    expect(comboLabel("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(comboLabel("Mod+Alt+N", true)).toBe("⌥⌘N");
    expect(comboKeys("Shift+Tab", true)).toEqual(["⇧", "⇥"]);
    expect(comboLabel("ArrowUp / ArrowDown", false)).toBe("↑ / ↓");
    expect(comboLabel("F6", true)).toBe("F6");
  });
  it("gleicht Ereignisse über die physische Taste ab (⌥ und ⇧ verändern key)", () => {
    expect(matchCombo(ev("˜", "KeyN", { metaKey: true, altKey: true }), parseCombo("Mod+Alt+N"), true)).toBe(true);
    expect(matchCombo(ev("?", "Slash", { metaKey: true, shiftKey: true }), parseCombo("Mod+Shift+/"), true)).toBe(true);
    expect(matchCombo(ev("/", "Slash", { metaKey: true }), parseCombo("Mod+Shift+/"), true)).toBe(false);
    expect(matchCombo(ev("k", "KeyK", { ctrlKey: true }), parseCombo("Mod+K"), false)).toBe(true);
    expect(matchCombo(ev("k", "KeyK", { ctrlKey: true }), parseCombo("Mod+K"), true)).toBe(false);
  });
  it("übersetzt für die Tastenkappen (Astryx Kbd)", () => {
    expect(kbdKeys("Mod+Shift+ArrowUp")).toBe("mod+shift+up");
    expect(kbdKeys("Shift+Arrows")).toBe("shift+↑↓←→");
    expect(kbdKeys("Mod+Alt+0–9")).toBe("mod+alt+0–9");
    expect(comboLabel("Mod+Arrows", true)).toBe("⌘↑↓←→");
  });
  it("schreibt Menü-Accelerator", () => {
    expect(comboAccelerator("Mod+Shift+/")).toBe("CmdOrCtrl+Shift+/");
    expect(comboAccelerator("Mod+Alt+N")).toBe("CmdOrCtrl+Alt+N");
    expect(comboAccelerator("Mod+\\")).toBe("CmdOrCtrl+\\");
  });
});

describe("Fokus in Pfeilrichtung", () => {
  const box = (left: number, top: number, w = 80, h = 28) => ({ left, top, right: left + w, bottom: top + h });
  it("nimmt in einer Spalte das nächste darunter, nicht das seitlich nähere", () => {
    const from = box(0, 0);
    const list = [box(0, 40), box(0, 80), box(200, 10)];
    expect(nextInDirection(from, list, "down")).toBe(0);
    expect(nextInDirection(list[1]!, [from, list[0]!], "up")).toBe(1);
  });
  it("bleibt in einer Zeile in der Zeile", () => {
    const from = box(0, 0);
    expect(nextInDirection(from, [box(100, 0), box(90, 60)], "right")).toBe(0);
    expect(nextInDirection(from, [box(100, 0)], "left")).toBe(-1);
  });
  it("ohne Überlappung gewinnt der kleinste Versatz", () => {
    const from = box(0, 0);
    expect(nextInDirection(from, [box(300, 40), box(120, 44)], "down")).toBe(1);
  });
});
