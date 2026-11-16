// Prüfung Pass 37 (Import/Export): Rundreise Markdown-Export → Markdown-Import. Text, der wie Markdown aussieht,
// muss als derselbe Text zurückkommen – vorher wurden Absätze zu Listen/Überschriften/Zitaten, „<b>“ zu Fett, Code mit
// Backtick zerfiel und Links mit Klammern wurden abgeschnitten. Grenzen (bewusst): führende Leerzeichen und zwei
// Leerzeichen am Zeilenende gehen verloren (Markdown-Leerraum); Klammern im Linkziel kommen prozent-kodiert zurück.
import { describe, expect, it } from "vitest";
import { codeSpan, createPage, decodeInlineMarkdown, escapeBlockStart, linkTarget, MarkdownExporter, MarkdownImporter, MemoryPersistence, runsOf, WorkspaceStore, type Block } from "../src/index.js";

const CASES: [string, unknown][] = [
  ["text", "Plain *star* _under_ `tick` # hash [br] | pipe \\ backslash"],
  ["text", "1. not a list"], ["text", "2) not a list either"], ["text", "- not a bullet"], ["text", "+ plus"], ["text", "* star"],
  ["text", "> not a quote"], ["text", "# not a heading"], ["text", "###### six"], ["text", "```not a fence"], ["text", "---"],
  ["text", "~~not strike~~ and ==not hl=="],
  ["text", [{ t: "bold", m: { b: true } }, { t: " and " }, { t: "ital*ic", m: { i: true } }, { t: " " }, { t: "code `x`", m: { c: true } }]],
  ["text", [{ t: "`edge``", m: { c: true } }]],
  ["text", [{ t: "both", m: { b: true, i: true } }, { t: "strike", m: { s: true } }]],
  ["heading1", "H1 *x*"], ["bulletedList", "item * one"], ["numberedList", "num"], ["todo", "todo [x]"],
  ["quote", "multi\nline quote"], ["text", "line1\nline2"], ["text", "emoji 🧠 Ä ß"],
  ["text", "<b>html</b> &amp; entity </i> <!-- c --> a < b"], ["text", "1\\. escaped"], ["text", "*"], ["text", "_"], ["text", "12345"],
];

function roundTrip(cases: [string, unknown][]) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const page = createPage(store, { title: "RT" });
  const now = store.now();
  store.transact("t", (tx) => cases.forEach(([type, text], i) => tx.put({ kind: "block", data: { id: "b" + i, type, parent: "b:" + page, sk: "a" + String(i).padStart(3, "0"), text, createdAt: now, updatedAt: now } as Block })));
  const md = new MarkdownExporter(store).export(page, false);
  const flat = (bs: ReturnType<MarkdownImporter["parse"]>): ReturnType<MarkdownImporter["parse"]> => bs.flatMap((b) => [b, ...flat(b.children)]);
  return { md, back: flat(new MarkdownImporter().parse(md)) };
}

describe("Markdown-Rundreise (Prüfung Pass 37)", () => {
  it("Absätze, Marks, Code, HTML-artiger Text kommen unverändert zurück", () => {
    const { md, back } = roundTrip(CASES);
    expect(back.map((b) => b.type), md).toEqual(CASES.map(([t]) => t));
    CASES.forEach(([, text], i) => expect(JSON.stringify(runsOf(back[i]!.text as never)), `#${i}\n${md}`).toBe(JSON.stringify(runsOf(text as never))));
  });

  it("Link mit Klammern und Leerzeichen bleibt ganz (prozent-kodiert)", () => {
    const { back } = roundTrip([["text", [{ t: "link", m: { link: "https://example.com/a_(b) c" } }, { t: " danach" }]]]);
    expect(runsOf(back[0]!.text as never)).toEqual([{ t: "link", m: { link: "https://example.com/a_%28b%29%20c" } }, { t: " danach", m: {} }]);
  });

  it("Hilfen: Blockanfang, Code-Span, Linkziel", () => {
    expect(escapeBlockStart("1. x")).toBe("1\\. x");
    expect(escapeBlockStart("10) x")).toBe("10\\) x");
    expect(escapeBlockStart("- x")).toBe("\\- x");
    expect(escapeBlockStart("#hashtag")).toBe("#hashtag");
    expect(escapeBlockStart("2024 war gut")).toBe("2024 war gut");
    expect(codeSpan("a")).toBe("`a`");
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x")).toBe("`` `x ``");
    expect(decodeInlineMarkdown("``a`b`` und `c`")).toEqual([{ t: "a`b", m: { c: true } }, { t: " und ", m: {} }, { t: "c", m: { c: true } }]);
    expect(decodeInlineMarkdown("`` `x ``")).toEqual([{ t: "`x", m: { c: true } }]);
    expect(decodeInlineMarkdown("``ohne Ende")).toEqual([{ t: "``ohne Ende", m: {} }]);
    expect(linkTarget("https://x.org/a(b) c")).toBe("https://x.org/a%28b%29%20c");
  });
});
