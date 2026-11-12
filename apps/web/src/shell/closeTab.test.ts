import { describe, expect, it } from "vitest";
import { closeTabAction } from "./closeTab.js";

describe("⌘W (BSD-310)", () => {
  it("schließt Tabs, solange mehrere offen sind – in jedem Fenster", () => {
    expect(closeTabAction({ tabs: 3, pageWindow: false, otherVisibleWindows: 2 })).toBe("tab");
    expect(closeTabAction({ tabs: 2, pageWindow: true, otherVisibleWindows: 1 })).toBe("tab");
  });
  it("letzter Tab im Seitenfenster: Fenster zu", () => {
    expect(closeTabAction({ tabs: 1, pageWindow: true, otherVisibleWindows: 1 })).toBe("close-window");
    expect(closeTabAction({ tabs: 1, pageWindow: true, otherVisibleWindows: 0 })).toBe("close-window");
  });
  it("letzter Tab im Hauptfenster: ausblenden, wenn noch Fenster offen sind; sonst Startseite", () => {
    expect(closeTabAction({ tabs: 1, pageWindow: false, otherVisibleWindows: 1 })).toBe("hide-window");
    expect(closeTabAction({ tabs: 1, pageWindow: false, otherVisibleWindows: 0 })).toBe("home");
  });
});
