import { describe, expect, it } from "vitest";
import { countWords, findInText, pageTextStats, textStats } from "../src/editor/text-stats.js";
import { MemoryPersistence, WorkspaceStore, type Block } from "../src/index.js";

describe("Wortzahl (BSD-206)", () => {
  it("zählt Wörter mit Apostroph, Bindestrich und Zahlen als eins", () => {
    expect(countWords("Don't over-think it: 3.5 km, e.g. today!")).toBe(7);
    expect(countWords("")).toBe(0);
    expect(countWords("  — … ")).toBe(0);
    expect(countWords("Größe über Maß")).toBe(3);
  });
  it("zählt CJK-Zeichen einzeln", () => {
    expect(countWords("今日は good")).toBe(4);
  });
  it("Zeichen als Codepunkte, ohne Zeilenumbrüche", () => {
    expect(textStats(["ab\ncd", "👍 ok"])).toEqual({ words: 3, characters: 8 });
  });
});

describe("Suchen in der Seite (BSD-206)", () => {
  it("findet ohne Rücksicht auf Groß/klein und Akzente, Stellen im Original", () => {
    expect(findInText("Café im CAFE, cafés", "cafe")).toEqual([{ start: 0, end: 4 }, { start: 8, end: 12 }, { start: 14, end: 18 }]);
  });
  it("ß und ss treffen sich, die Stelle umfasst das ganze Zeichen", () => {
    expect(findInText("Die Straße", "strasse")).toEqual([{ start: 4, end: 10 }]);
    expect(findInText("STRASSE", "straße")).toEqual([{ start: 0, end: 7 }]);
  });
  it("überlappt nicht, achtet auf Emoji-Breite und das Limit", () => {
    expect(findInText("aaaa", "aa")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(findInText("👍 note", "note")).toEqual([{ start: 3, end: 7 }]);
    expect(findInText("x".repeat(100), "x", 5)).toHaveLength(5);
    expect(findInText("abc", "")).toEqual([]);
  });
});

describe("Wortzahl einer Seite", () => {
  it("zählt den Inhalt ohne Titel, Unterseiten und Papierkorb", () => {
    const b = (id: string, type: string, parent: string, sk: string, t?: string, extra: object = {}) =>
      ({ kind: "block" as const, data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, ...(t ? { text: [{ t }] } : {}), ...extra } as Block });
    const s = new WorkspaceStore({
      persistence: new MemoryPersistence([
        b("p", "page", "w", "a0", "Title words here"),
        b("a", "paragraph", "b:p", "a0", "one two three"),
        b("a2", "paragraph", "b:a", "a0", "four"),
        b("sub", "page", "b:p", "a1", "Sub page"),
        b("s1", "paragraph", "b:sub", "a0", "not counted at all"),
        b("gone", "paragraph", "b:p", "a2", "deleted text", { trashedAt: 5 }),
      ]),
      node: "t", now: () => 1,
    });
    expect(pageTextStats(s, "p")).toEqual({ words: 4, characters: 17 });
  });
});
