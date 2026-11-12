import { describe, expect, it } from "vitest";
import { matchShortcut, parentPage } from "./shortcuts.js";

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
    // BSD-319: ⇧⌘B meldet ein Problem (ohne ⇧ bleibt ⌘B beim Editor: fett)
    expect(matchShortcut(key("B", { shift: true, code: "KeyB" }))).toEqual({ kind: "reportProblem" });
    expect(matchShortcut(key("b", { code: "KeyB" }))).toBeUndefined();
    expect(matchShortcut(key(","))).toEqual({ kind: "settings" });
    expect(matchShortcut(key("t"))).toEqual({ kind: "newTab" });
    expect(matchShortcut(key("w"))).toEqual({ kind: "closeTab" });
    expect(matchShortcut(key("["))).toEqual({ kind: "back" });
    expect(matchShortcut(key("]"))).toEqual({ kind: "forward" });
    expect(matchShortcut(key("}", { shift: true, code: "BracketRight" }))).toEqual({ kind: "cycleTab", delta: 1 });
    expect(matchShortcut(key("1", { code: "Digit1" }))).toEqual({ kind: "tab", index: 0 });
    expect(matchShortcut(key("4"))).toEqual({ kind: "tab", index: 3 });
    expect(matchShortcut(key("9", { code: "Digit9" }))).toEqual({ kind: "tab", index: -1 });
    expect(matchShortcut(key("f"))).toEqual({ kind: "find" });
    expect(matchShortcut(key("g"))).toEqual({ kind: "findStep", delta: 1 });
    expect(matchShortcut(key("G", { shift: true, code: "KeyG" }))).toEqual({ kind: "findStep", delta: -1 });
  });

  it("ohne ⌘/Strg oder mit fremden Kombinationen: nichts", () => {
    expect(matchShortcut(key("n", { meta: false }))).toBeUndefined();
    expect(matchShortcut(key("0", { code: "Digit0" }))).toBeUndefined();
    expect(matchShortcut(key("k", { alt: true, code: "KeyK" }))).toBeUndefined();
    expect(matchShortcut(key("x", { shift: true, code: "KeyX" }))).toBeUndefined();
  });
});

describe("⇧⌘U (BSD-168)", () => {
  it("öffnet die Elternseite", () => {
    expect(matchShortcut({ key: "U", code: "KeyU", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toEqual({ kind: "openParent" });
    expect(matchShortcut({ key: "u", code: "KeyU", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBeUndefined();
    const outline = { nodes: { a: {}, b: { parent: "a" }, c: { parent: "gone" } } };
    expect(parentPage(outline, "b")).toBe("a");
    expect(parentPage(outline, "a")).toBeUndefined();
    expect(parentPage(outline, "c")).toBeUndefined();
    expect(parentPage(undefined, "b")).toBeUndefined();
  });
});
