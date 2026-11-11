import { describe, expect, it } from "vitest";
import { clampSidebar, isSidebarToggle, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebarSize.js";

describe("sidebarSize", () => {
  it("klemmt die Breite", () => {
    expect(clampSidebar(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebar(300.4)).toBe(300);
    expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });

  it("erkennt ⌘\\ und Strg+\\, aber nicht mit Shift/Alt", () => {
    const k = { key: "\\", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isSidebarToggle({ ...k, metaKey: true })).toBe(true);
    expect(isSidebarToggle({ ...k, ctrlKey: true })).toBe(true);
    expect(isSidebarToggle({ ...k, metaKey: true, shiftKey: true })).toBe(false);
    expect(isSidebarToggle(k)).toBe(false);
  });

  it("deutsche Tastatur: ⌘# (Taste an der Stelle von \\) und ⌘⌥⇧7 schalten um", () => {
    const k = { key: "#", code: "Backslash", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isSidebarToggle(k)).toBe(true);
    expect(isSidebarToggle({ ...k, key: "\\", code: "Digit7", altKey: true, shiftKey: true })).toBe(true);
    expect(isSidebarToggle({ ...k, key: "7", code: "Digit7" })).toBe(false);
    expect(isSidebarToggle({ ...k, shiftKey: true })).toBe(false);
  });
});
