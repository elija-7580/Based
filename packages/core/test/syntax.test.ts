// BSD-209: dieselben Fälle wie Swift SyntaxHighlighterTests.
import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, codeLanguageID, syntaxTokens, type SyntaxKind } from "../src/index.js";

const kinds = (code: string, lang: string | undefined): [string, SyntaxKind][] =>
  syntaxTokens(code, lang).map((t) => [code.slice(t.from, t.from + t.length), t.kind]);
const has = (k: [string, SyntaxKind][], s: string, kind: SyntaxKind) => k.some(([a, b]) => a === s && b === kind);

describe("Syntax-Hervorhebung (Swift SyntaxHighlighter)", () => {
  it("Swift-Grundlagen", () => {
    const k = kinds("let x = 1 // one\nfunc go(a: Int) -> String { return \"hi\\\"\" }", "swift");
    expect(has(k, "let", "keyword")).toBe(true);
    expect(has(k, "1", "number")).toBe(true);
    expect(has(k, "// one", "comment")).toBe(true);
    expect(has(k, "func", "keyword")).toBe(true);
    expect(has(k, "go", "function")).toBe(true);
    expect(has(k, "Int", "type")).toBe(true);
    expect(has(k, "\"hi\\\"\"", "string")).toBe(true);
    expect(k.some(([a]) => a === "x")).toBe(false);
  });

  it("Python und Blockkommentare", () => {
    expect(kinds("def f(x):\n    # note\n    return None", "python").map((x) => x[1])).toEqual(["keyword", "function", "comment", "keyword", "keyword"]);
    const js = kinds("/* a\n b */ const s = `t\n${x}`; obj.prop", "javascript");
    expect(js[0]?.[1]).toBe("comment");
    expect(has(js, "`t\n${x}`", "string")).toBe(true);
    expect(has(js, "prop", "property")).toBe(true);
  });

  it("Klartext und kaputter Code", () => {
    expect(syntaxTokens("anything", "plain text")).toEqual([]);
    expect(syntaxTokens("anything", undefined)).toEqual([]);
    expect(syntaxTokens("anything", "text")).toEqual([]);
    for (const code of ["\"open", "/* open", "x = 'a\nb'", "😀 let y = \"é\""]) {
      expect(syntaxTokens(code, "swift").every((t) => t.from + t.length <= code.length)).toBe(true);
    }
    expect(kinds("SELECT name FROM users -- all", "sql").map((x) => x[1])).toEqual(["keyword", "keyword", "comment"]);
  });
});

describe("BSD-343: Sprach-Kurznamen im Codeblock", () => {
  it("Kurznamen und Schreibweisen ergeben den Schlüssel aus CODE_LANGUAGES", () => {
    for (const [raw, id] of [["js", "javascript"], ["JS", "javascript"], ["ts", "typescript"], ["tsx", "typescript"], ["py", "python"], ["yml", "yaml"], ["c++", "cpp"], ["sh", "bash"], ["md", "markdown"], [" Rust ", "rust"], ["rs", "rust"], ["javascript", "javascript"]] as const) {
      expect(codeLanguageID(raw), raw).toBe(id);
      expect(CODE_LANGUAGES.some((l) => l.id === id)).toBe(true);
    }
  });
  it("Unbekanntes bleibt, wie es ist; ohne Sprache keine Sprache", () => {
    expect(codeLanguageID("cobol")).toBe("cobol");
    expect(codeLanguageID(undefined)).toBeUndefined();
  });
});
