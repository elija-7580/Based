// BSD-74: Ersetzen in RichText erhält die Formatierung (Swift-Plan `RichTextReplaceTests`).
import { describe, expect, it } from "vitest";
import { plainText, replaceInRichText, type RichText } from "../src/index.js";

describe("replaceInRichText", () => {
  it("reiner Text bleibt ein String", () => {
    expect(replaceInRichText("Hello world", "world", "Based")).toEqual({ text: "Hello Based", count: 1 });
    expect(replaceInRichText("a a a", "a", "b")).toEqual({ text: "b b b", count: 3 });
    expect(replaceInRichText("a a a", "a", "b", { all: false })).toEqual({ text: "b a a", count: 1 });
  });

  it("nichts gefunden: unverändert, count 0", () => {
    const t: RichText = [{ t: "bold", m: { b: true } }, { t: " plain" }];
    const r = replaceInRichText(t, "missing", "x");
    expect(r.count).toBe(0);
    expect(r.text).toBe(t);
    expect(replaceInRichText(undefined, "a", "b")).toEqual({ text: "", count: 0 });
    expect(replaceInRichText("abc", "", "b").count).toBe(0);
  });

  it("Fett, Kursiv und Links um die Stelle bleiben", () => {
    const t: RichText = [
      { t: "Ship " },
      { t: "the plan", m: { b: true } },
      { t: " by " },
      { t: "Friday", m: { i: true, link: "https://example.com/cal" } },
      { t: "." },
    ];
    const r = replaceInRichText(t, "Friday", "Monday");
    expect(r.count).toBe(1);
    expect(r.text).toEqual([
      { t: "Ship " },
      { t: "the plan", m: { b: true } },
      { t: " by " },
      { t: "Monday", m: { i: true, link: "https://example.com/cal" } },
      { t: "." },
    ]);
  });

  it("Treffer über mehrere Läufe: der Ersatz erbt die Formatierung am Anfang, der Rest bleibt", () => {
    const t: RichText = [{ t: "one " }, { t: "two", m: { b: true } }, { t: " three", m: { i: true } }, { t: " four" }];
    const r = replaceInRichText(t, "two three", "2+3");
    expect(plainText(r.text)).toBe("one 2+3 four");
    expect(r.text).toEqual([{ t: "one " }, { t: "2+3", m: { b: true } }, { t: " four" }]);
  });

  it("Erwähnungen und Formeln werden nie zerschnitten", () => {
    const mention = { t: "Roadmap", mention: { page: { _0: "p1" } } };
    const t: RichText = [{ t: "See " }, mention, { t: " and Roadmap notes" }];
    const r = replaceInRichText(t, "Roadmap", "Plan");
    expect(r.count).toBe(1);
    expect(r.text).toEqual([{ t: "See " }, mention, { t: " and Plan notes" }]);
  });

  it("löschen (leerer Ersatz) fasst gleich formatierte Nachbarn zusammen", () => {
    const r = replaceInRichText([{ t: "a", m: { b: true } }, { t: " x " }, { t: "b", m: { b: true } }], " x ", "");
    expect(r.text).toEqual([{ t: "ab", m: { b: true } }]);
  });
});
