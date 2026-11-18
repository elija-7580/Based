import { describe, expect, it } from "vitest";
import { highlightRanges } from "./QuickFind.js";

const marked = (text: string, query: string) => highlightRanges(text, query).map(([a, z]) => text.slice(a, z));

describe("Quick Find: Markierung", () => {
  it("markiert die Begriffe, Groß/klein und Akzente egal", () => {
    expect(marked("Café notes for the CAFE team", "cafe")).toEqual(["Café", "CAFE"]);
    expect(marked("Budgetplanung 2027", "budget 2027")).toEqual(["Budget", "2027"]);
  });
  it("markiert bei einem Tippfehler das gemeinte Wort – auch wenn erst der Anfang getippt ist", () => {
    expect(marked("Die Umsatzprognose wird korrigiert", "Umsatzprognsoe")).toEqual(["Umsatzprognose"]);
    expect(marked("Tombstones are collected", "tombstnes")).toEqual(["Tombstones"]);
    expect(marked("Die Umsatzprognose wird korrigiert", "umsatzporg")).toEqual(["Umsatzprognose"]);
  });
  it("kurze Begriffe und Zahlen nie ungefähr; überlappende Stellen werden eine", () => {
    expect(marked("Brot und Butter", "brat")).toEqual(["Brot"]);
    expect(marked("Rot und Tor", "rat")).toEqual([]);
    expect(marked("Jahr 2026", "2027")).toEqual([]);
    expect(marked("meeting notes", "meet meeting")).toEqual(["meeting"]);
  });
  it("ändert die Faltung die Länge (ß), wird nichts an falscher Stelle markiert", () => {
    expect(marked("Jonas Weiß kommt", "weiss")).toEqual([]);
  });
});
