import { describe, expect, it } from "vitest";
import { clipboardData, isMobileShell, isTauri, updatePrompt, upToDateText } from "./desktop.js";

describe("desktop (BSD-164)", () => {
  it("erkennt die Tauri-Hülle an __TAURI_INTERNALS__", () => {
    expect(isTauri({})).toBe(false);
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
  it("Handy-Hülle (apps/mobile): verhält sich wie der Browser, nicht wie die Mac-App", () => {
    const iphone = { __TAURI_INTERNALS__: {}, navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", maxTouchPoints: 5 } };
    const ipad = { __TAURI_INTERNALS__: {}, navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", maxTouchPoints: 5 } };
    const mac = { __TAURI_INTERNALS__: {}, navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", maxTouchPoints: 0 } };
    expect([isMobileShell(iphone), isTauri(iphone)]).toEqual([true, false]);
    expect([isMobileShell(ipad), isTauri(ipad)]).toEqual([true, false]);
    expect([isMobileShell(mac), isTauri(mac)]).toEqual([false, true]);
    expect(isMobileShell({ navigator: iphone.navigator })).toBe(false);
  });
});

describe("Seitenfenster (BSD-202)", () => {
  it("Adresse mit ?window=page und Hash der Seite; erkennt das Seitenfenster", async () => {
    const { isPageWindow, pageWindowURL } = await import("./desktop.js");
    expect(pageWindowURL("tauri://localhost/index.html#home", "page-ABC")).toBe("tauri://localhost/index.html?window=page#page-ABC");
    expect(pageWindowURL("http://localhost:5173/?x=1#home", "page-ABC")).toBe("http://localhost:5173/?x=1&window=page#page-ABC");
    expect(isPageWindow("?window=page")).toBe(true);
    expect(isPageWindow("")).toBe(false);
  });
});

describe("Update-Notizen (BSD-168)", () => {
  it("zeigt die Notizen aus latest.json, kürzt auf 8 Zeilen", () => {
    expect(updatePrompt("0.1.70", "0.1.62")).toBe("Based Next 0.1.70 is available (you have 0.1.62).\n\nInstall it and restart now?");
    // Feedback 17. 11.: die Beta nennt sich selbst (nicht „Based Next“), und „kein Update“ sagt, welche Version läuft.
    expect(updatePrompt("0.2.3", "0.2.2", undefined, "Based Beta")).toBe("Based Beta 0.2.3 is available (you have 0.2.2).\n\nInstall it and restart now?");
    expect(upToDateText({ name: "Based Beta", version: "0.2.2" })).toBe("You’re on the newest version: Based Beta 0.2.2.");
    const p = updatePrompt("0.1.70", "0.1.62", "• AI chat button\n\n• ⇧⌘U opens the parent page\n");
    expect(p).toContain("What’s new:\n• AI chat button\n• ⇧⌘U opens the parent page\n\nInstall");
    // Elija 17.11.: lange Notizen (33 Zeilen in beta 0.2.4) machten den Dialog unbedienbar – 8 Zeilen, je ≤ 110 Zeichen
    const huge = updatePrompt("0.2.4", "0.2.2", Array.from({ length: 33 }, (_, i) => `- line ${i} ${"x".repeat(200)}`).join("\n"), "Based Beta");
    const noteLines = huge.split("\n").filter((l) => l.startsWith("- line"));
    expect(noteLines).toHaveLength(8);
    expect(Math.max(...noteLines.map((l) => l.length))).toBe(110);
    expect(noteLines[0]!.endsWith("…")).toBe(true);
    expect(huge).toContain("… and 25 more");
    expect(huge.endsWith("Install it and restart now?")).toBe(true);
    const long = updatePrompt("1", "0", Array.from({ length: 15 }, (_, i) => `• item ${i}`).join("\n"));
    expect(long).toContain("• item 7\n… and 7 more");
    expect(long).not.toContain("item 8");
  });
});

// BSD-358: „Paste“ im Based-Kontextmenü der Mac-App bekommt Text und HTML (clipboard_html) – wie ⌘V.
describe("clipboardData", () => {
  it("HTML kommt mit, wenn vorhanden", () => {
    expect(clipboardData("bold", "<b>bold</b>")).toEqual({ text: "bold", html: "<b>bold</b>" });
  });
  it("ohne oder leeres HTML: nur Text; fehlender Text wird leer", () => {
    expect(clipboardData("plain", undefined)).toEqual({ text: "plain" });
    expect(clipboardData("plain", "  ")).toEqual({ text: "plain" });
    expect(clipboardData(null, "<p>x</p>")).toEqual({ text: "", html: "<p>x</p>" });
  });
});

describe("Update-Suche im laufenden Betrieb (Elija 22.11.)", () => {
  it("ist frühestens alle 4 Stunden fällig und fragt nicht erneut nach einer abgelehnten Version", async () => {
    const { UPDATE_CHECK_EVERY_MS, UPDATE_CHECK_TICK_MS, shouldOfferUpdate, updateCheckDue } = await import("./desktop.js");
    const t0 = 1_800_000_000_000;
    expect(updateCheckDue(t0 + UPDATE_CHECK_EVERY_MS - 1, t0)).toBe(false);
    expect(updateCheckDue(t0 + UPDATE_CHECK_EVERY_MS, t0)).toBe(true);
    // nach langem Schlaf des Macs: sofort beim nächsten Takt
    expect(updateCheckDue(t0 + 3 * UPDATE_CHECK_EVERY_MS, t0)).toBe(true);
    expect(UPDATE_CHECK_TICK_MS).toBeLessThan(UPDATE_CHECK_EVERY_MS);
    const declined = new Set(["0.2.13"]);
    expect(shouldOfferUpdate("0.2.13", declined, false)).toBe(false);
    expect(shouldOfferUpdate("0.2.14", declined, false)).toBe(true);
    // „Check for Updates…“ von Hand fragt immer
    expect(shouldOfferUpdate("0.2.13", declined, true)).toBe(true);
  });
});
