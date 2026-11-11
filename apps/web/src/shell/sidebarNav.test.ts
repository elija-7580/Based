// BSD-281: Einträge der Seitenleiste – Stammplätze, Coding nur im erweiterten Modus, anpinnen/lösen/ausblenden pro
// Gerät, Säubern gespeicherter Werte, ⌘K-Befehle.
import { describe, expect, it } from "vitest";
import { cleanNavPrefs, EMPTY_NAV_PREFS, hideNav, matchCommands, moveNav, navLayout, navPlace, pinNav, showNav, unpinNav } from "./sidebarNav.js";

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
    expect(matchCommands("meet").map((c) => c.id)).toEqual(["meetings", "meeting"]);
    expect(matchCommands("cod").map((c) => c.id)).toEqual(["coding"]);
    expect(matchCommands("prefer").map((c) => c.id)).toEqual(["settings"]);
  });
});

// Feedback 11. 11.: Die Reihenfolge von Search, Home, Chat … ließ sich nicht ändern.
describe("Seitenleiste: Einträge ziehen", () => {
  it("oben umsortieren: vor einen Eintrag oder ans Ende", () => {
    let p = moveNav(EMPTY_NAV_PREFS, "chat", "top", "search", basic);
    expect(navLayout(p, basic).top).toEqual(["chat", "search", "home"]);
    p = moveNav(p, "chat", "top", undefined, basic);
    expect(navLayout(p, basic).top).toEqual(["search", "home", "chat"]);
    expect(navLayout(p, basic).footer).toEqual(["library", "trash", "settings"]);
  });

  it("zwischen oben und Fuß: Library nach oben zwischen Search und Home, Search in den Fuß vor Trash", () => {
    let p = moveNav(EMPTY_NAV_PREFS, "library", "top", "home", basic);
    expect(navLayout(p, basic)).toEqual({ top: ["search", "library", "home", "chat"], footer: ["trash", "settings"] });
    p = moveNav(p, "search", "footer", "trash", basic);
    expect(navLayout(p, basic)).toEqual({ top: ["library", "home", "chat"], footer: ["search", "trash", "settings"] });
    expect(navPlace("search", p, basic)).toBe("footer");
    // anpinnen holt Search zurück nach oben, ausblenden nimmt ihn ganz heraus
    expect(navLayout(pinNav(p, "search"), basic).top).toContain("search");
    expect(navLayout(hideNav(p, "search"), basic)).toEqual({ top: ["library", "home", "chat"], footer: ["trash", "settings"] });
  });

  it("im Fuß umsortieren; später Angepinntes kommt hinter die eigene Reihenfolge", () => {
    let p = moveNav(EMPTY_NAV_PREFS, "settings", "footer", "library", basic);
    expect(navLayout(p, basic).footer).toEqual(["settings", "library", "trash"]);
    p = pinNav(p, "tasks");
    expect(navLayout(p, basic).top).toEqual(["search", "home", "chat", "tasks"]);
  });

  it("auf sich selbst ziehen ändert nichts; Coding bleibt angepinnt, auch wenn es gerade nicht erscheint", () => {
    expect(moveNav(EMPTY_NAV_PREFS, "home", "top", "home", basic)).toBe(EMPTY_NAV_PREFS);
    const p = moveNav(pinNav(EMPTY_NAV_PREFS, "coding"), "chat", "top", "search", basic);
    expect(navLayout(p, basic).top).toEqual(["chat", "search", "home"]);
    expect(navLayout(p, adv).top).toContain("coding");
  });

  it("gespeicherte Werte säubern: unbekannte IDs fallen weg, alte Werte ohne Reihenfolge bleiben gültig", () => {
    expect(cleanNavPrefs({ pinned: ["tasks"], hidden: [], order: ["chat", "nope", "search"], lowered: ["home", "x"], footerOrder: [] })).toEqual({ pinned: ["tasks"], hidden: [], lowered: ["home"], order: ["chat", "search"] });
    expect(cleanNavPrefs({ pinned: ["tasks"], hidden: ["chat"] })).toEqual({ pinned: ["tasks"], hidden: ["chat"] });
  });
});
