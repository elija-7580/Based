import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcuts.js";

const key = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; code: string }> = {}) => ({
  key, code: mods.code ?? "", metaKey: mods.meta ?? true, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: mods.alt ?? false,
});

describe("Tastaturkürzel (BSD-204)", () => {
  it("ordnet ⌘-Kürzel Aktionen zu (Strg gilt wie ⌘)", () => {
    expect(matchShortcut(key("k"))).toEqual({ kind: "quickFind" });
    expect(matchShortcut(key("p"))).toEqual({ kind: "quickFind" });
    expect(matchShortcut(key("n"))).toEqual({ kind: "palette" });
    expect(matchShortcut(key("n", { meta: false, ctrl: true }))).toEqual({ kind: "palette" });
    expect(matchShortcut(key("˜", { alt: true, code: "KeyN" }))).toEqual({ kind: "newPage" });
    expect(matchShortcut(key("L", { shift: true, code: "KeyL" }))).toEqual({ kind: "toggleTheme" });
    expect(matchShortcut(key(","))).toEqual({ kind: "settings" });
    expect(matchShortcut(key("t"))).toEqual({ kind: "newTab" });
    expect(matchShortcut(key("w"))).toEqual({ kind: "closeTab" });
    expect(matchShortcut(key("["))).toEqual({ kind: "back" });
    expect(matchShortcut(key("]"))).toEqual({ kind: "forward" });
    expect(matchShortcut(key("}", { shift: true, code: "BracketRight" }))).toEqual({ kind: "cycleTab", delta: 1 });
    expect(matchShortcut(key("1", { code: "Digit1" }))).toEqual({ kind: "tab", index: 0 });
    expect(matchShortcut(key("4"))).toEqual({ kind: "tab", index: 3 });
    expect(matchShortcut(key("9", { code: "Digit9" }))).toEqual({ kind: "tab", index: -1 });
  });

  it("ohne ⌘/Strg oder mit fremden Kombinationen: nichts", () => {
    expect(matchShortcut(key("n", { meta: false }))).toBeUndefined();
    expect(matchShortcut(key("0", { code: "Digit0" }))).toBeUndefined();
    expect(matchShortcut(key("k", { alt: true, code: "KeyK" }))).toBeUndefined();
    expect(matchShortcut(key("x", { shift: true, code: "KeyX" }))).toBeUndefined();
  });
});
