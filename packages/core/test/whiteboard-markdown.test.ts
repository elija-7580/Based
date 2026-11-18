// Markdown auf dem Board: Lesen (Blöcke, Auszeichnung), Aufgaben abhaken, Listen fortsetzen.
import { describe, expect, it } from "vitest";
import { continueList, hasMarkdown, markdownPlain, parseInline, parseMarkdown, toggleTask } from "../src/index.js";

describe("parseInline", () => {
  it("fett, kursiv, Code, durchgestrichen, markiert", () => {
    expect(parseInline("a **b** *c* `d` ~~e~~ ==f==")).toEqual([
      { text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " },
      { text: "d", code: true }, { text: " " }, { text: "e", strike: true }, { text: " " }, { text: "f", mark: true },
    ]);
  });
  it("verschachtelt und ***fett kursiv***", () => {
    expect(parseInline("**fett *beides* fett**")).toEqual([{ text: "fett ", bold: true }, { text: "beides", bold: true, italic: true }, { text: " fett", bold: true }]);
    expect(parseInline("***x***")).toEqual([{ text: "x", bold: true, italic: true }]);
  });
  it("Links und nackte Adressen", () => {
    expect(parseInline("see [Based](https://basednotes.app) now")).toEqual([{ text: "see " }, { text: "Based", link: "https://basednotes.app" }, { text: " now" }]);
    expect(parseInline("go https://x.dev/a.")).toEqual([{ text: "go " }, { text: "https://x.dev/a", link: "https://x.dev/a" }, { text: "." }]);
  });
  it("was kein Markdown ist, bleibt Text", () => {
    expect(parseInline("snake_case_name and 2 * 3 * 4")).toEqual([{ text: "snake_case_name and 2 * 3 * 4" }]);
    expect(parseInline("**offen")).toEqual([{ text: "**offen" }]);
    expect(parseInline("\\*kein\\* kursiv")).toEqual([{ text: "*kein* kursiv" }]);
    expect(parseInline("`a*b*c`")).toEqual([{ text: "a*b*c", code: true }]);
  });
});

describe("parseMarkdown", () => {
  it("Überschriften, Listen, Aufgaben, Zitat, Linie, Leerzeile", () => {
    const b = parseMarkdown("# Titel\n- a\n  - b\n1. eins\n- [ ] offen\n- [x] fertig\n> zitat\n---\n\ntext");
    expect(b.map((x) => x.type)).toEqual(["h", "li", "li", "li", "li", "li", "quote", "hr", "blank", "p"]);
    expect(b[0]).toMatchObject({ level: 1, runs: [{ text: "Titel" }] });
    expect(b[2]).toMatchObject({ depth: 1, marker: "•" });
    expect(b[3]).toMatchObject({ ordered: true, marker: "1." });
    expect(b[4]).toMatchObject({ checked: false, line: 4 });
    expect(b[5]).toMatchObject({ checked: true });
  });
  it("####### wird h3, Codeblock zeilenweise ohne Auszeichnung", () => {
    const b = parseMarkdown("#### klein\n```ts\nconst a = **1**;\n\n```\nnach");
    expect(b[0]).toMatchObject({ type: "h", level: 3 });
    expect(b.slice(1, 3)).toEqual([
      { type: "code", text: "const a = **1**;", first: true, last: false, line: 2 },
      { type: "code", text: "", first: false, last: true, line: 3 },
    ]);
    expect(b[3]).toMatchObject({ type: "p", line: 5 });
  });
  it("ungeschlossener Codeblock (wird gerade getippt) und leerer Codeblock", () => {
    expect(parseMarkdown("```\nx")).toEqual([{ type: "code", text: "x", first: true, last: true, line: 1 }]);
    expect(parseMarkdown("```\n```")).toEqual([{ type: "code", text: "", first: true, last: true, line: 1 }]);
  });
});

describe("Helfer", () => {
  it("toggleTask hakt nur Aufgaben ab", () => {
    expect(toggleTask("- [ ] a\n- [x] b", 0)).toBe("- [x] a\n- [x] b");
    expect(toggleTask("- [ ] a\n- [X] b", 1)).toBe("- [ ] a\n- [ ] b");
    expect(toggleTask("- a", 0)).toBe("- a");
    expect(toggleTask("a", 5)).toBe("a");
  });
  it("continueList setzt Listen fort und beendet sie auf leerer Zeile", () => {
    expect(continueList("- a")).toEqual({ insert: "- " });
    expect(continueList("  * a")).toEqual({ insert: "  * " });
    expect(continueList("9. a")).toEqual({ insert: "10. " });
    expect(continueList("- [x] erledigt")).toEqual({ insert: "- [ ] " });
    expect(continueList("> zitat")).toEqual({ insert: "> " });
    expect(continueList("- ")).toEqual({ end: true });
    expect(continueList("-")).toEqual({ end: true });
    expect(continueList("text")).toBeUndefined();
  });
  it("hasMarkdown und markdownPlain", () => {
    expect(hasMarkdown("Nur ein Satz.")).toBe(false);
    expect(hasMarkdown("- Punkt")).toBe(true);
    expect(hasMarkdown("ein **fetter** Satz")).toBe(true);
    expect(markdownPlain("# T\n- [x] **a**\n[l](u)")).toBe("T\n☑ a\nl");
  });
});
