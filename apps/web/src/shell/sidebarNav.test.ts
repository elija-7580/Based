// BSD-281: Einträge der Seitenleiste – Stammplätze, Coding nur im erweiterten Modus, anpinnen/lösen/ausblenden pro
// Gerät, Säubern gespeicherter Werte, ⌘K-Befehle.
import { describe, expect, it } from "vitest";
import { cleanNavPrefs, EMPTY_NAV_PREFS, hideNav, matchCommands, navLayout, navPlace, pinNav, showNav, unpinNav } from "./sidebarNav.js";

const basic = { advanced: false }, adv = { advanced: true };

describe("Seitenleiste: Einträge", () => {
  it("Stammplätze: oben Search, Home, Chat; unten Library, Trash, Settings; Coding nur im erweiterten Modus", () => {
    expect(navLayout(EMPTY_NAV_PREFS, basic)).toEqual({ top: ["search", "home", "chat"], footer: ["library", "trash", "settings"] });
    expect(navPlace("coding", EMPTY_NAV_PREFS, basic)).toBe("none");
    expect(navLayout(pinNav(EMPTY_NAV_PREFS, "coding"), basic).top).not.toContain("coding");
    expect(navLayout(pinNav(EMPTY_NAV_PREFS, "coding"), adv).top).toContain("coding");
  });

  it("anpinnen holt Einträge nach oben (auch aus dem Fuß), lösen bringt sie an den Stammplatz zurück", () => {
    let p = pinNav(EMPTY_NAV_PREFS, "tasks");
    p = pinNav(p, "library");
    expect(navLayout(p, basic)).toEqual({ top: ["search", "home", "chat", "tasks", "library"], footer: ["trash", "settings"] });
    p = unpinNav(p, "library");
    expect(navLayout(p, basic).footer).toEqual(["library", "trash", "settings"]);
    p = unpinNav(p, "tasks");
    expect(navPlace("tasks", p, basic)).toBe("none");
  });

  it("ausblenden und wieder zeigen; Einträge ohne Stammplatz kommen beim Zeigen oben hin", () => {
    let p = hideNav(EMPTY_NAV_PREFS, "chat");
    p = hideNav(p, "trash");
    expect(navLayout(p, basic)).toEqual({ top: ["search", "home"], footer: ["library", "settings"] });
    p = showNav(p, "chat");
    p = showNav(p, "graph");
    expect(navLayout(p, basic)).toEqual({ top: ["search", "home", "chat", "graph"], footer: ["library", "settings"] });
    expect(navPlace("graph", hideNav(p, "graph"), basic)).toBe("none");
  });

  it("gespeicherte Wahl wird gesäubert", () => {
    expect(cleanNavPrefs(undefined)).toEqual(EMPTY_NAV_PREFS);
    expect(cleanNavPrefs({ pinned: ["graph", "nope", "graph", 3, "trash"], hidden: ["trash"] })).toEqual({ pinned: ["graph"], hidden: ["trash"] });
  });

  it("⌘K: Befehle nach Wortanfang und Suchwort, Coding immer, leere Eingabe keine", () => {
    expect(matchCommands("")).toEqual([]);
    expect(matchCommands("ta").map((c) => c.id)).toEqual(["tasks"]);
    expect(matchCommands("graph").map((c) => c.id)).toEqual(["graph"]);
    expect(matchCommands("meet").map((c) => c.id)).toEqual(["meeting"]);
    expect(matchCommands("cod").map((c) => c.id)).toEqual(["coding"]);
    expect(matchCommands("prefer").map((c) => c.id)).toEqual(["settings"]);
  });
});
