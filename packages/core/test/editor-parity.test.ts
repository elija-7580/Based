// Editor-Parität: Markdown-Erkennung beim Einfügen, ergänzte Parser-Fälle, Datums-Erwähnungen, Gliederung,
// Backlinks und Synced Blocks.
import { describe, expect, it } from "vitest";
import {
  LinkIndex, MarkdownImporter, MemoryPersistence, WorkspaceStore, activeHeadingIndex, backlinksTo, containingPage, dateMentionValue,
  dateSuggestions, dateFromSwift, headingOutline, importedJSON, linkedPages, looksLikeMarkdown, parseTypedDate, pasteKind, syncedDependencies,
  syncedInstances, syncedPasteProblem, subtree, trashedRoot, unsyncCopy, withDepth, type WireRecord,
} from "../src/index.js";

const blk = (id: string, parent: string, sk: string, type = "page", extra: Record<string, unknown> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, text: id, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" }, ...extra },
});
const make = (records: WireRecord[]) => new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });

describe("Einfügen: Erkennung", () => {
  it.each([
    ["# Title", true], ["## Sub", true], ["- item", true], ["* item", true], ["1. first", true], ["- [ ] todo", true], ["> quote", true],
    ["---", true], ["```ts", true], ["| a | b |", true], ["some **bold** text", true], ["see [docs](https://example.com)", true],
    ["use `code` here", true], ["~~gone~~", true], ["an *emphasised* word", true], ["![alt](pic.png)", true],
    ["line one\nline two", true], ["\n\nfirst\n\nsecond\n", true],
  ])("Markdown: %j", (text, expected) => expect(looksLikeMarkdown(text)).toBe(expected));

  it.each([
    [""], ["   "], ["just a sentence."], ["https://example.com/a_b_c"], ["2 * 3 * 4 = 24"], ["snake_case_name and other_name"],
    ["price: 5$ and 6$"], ["#hashtag"], ["a - b"], ["C:\\path\\file"], ["trailing newline only\n"], ["1.5 litres"], ["-5 degrees"],
  ])("Klartext: %j", (text) => expect(looksLikeMarkdown(text)).toBe(false));

  it("HTML vor Markdown vor Klartext; ⇧⌘V und Code-Block bleiben Klartext", () => {
    expect(pasteKind({ html: "<p>x</p>", text: "# x" })).toBe("html");
    expect(pasteKind({ html: "  ", text: "# x" })).toBe("markdown");
    expect(pasteKind({ text: "# x" })).toBe("markdown");
    expect(pasteKind({ text: "plain" })).toBe("plain");
    expect(pasteKind({ html: "<p>x</p>", text: "# x", plainOnly: true })).toBe("plain");
    expect(pasteKind({ text: "# x\n- y", plainOnly: true })).toBe("plain");
    expect(pasteKind({ text: "# x", inCode: true })).toBe("plain");
  });
});

describe("Markdown-Parser: ergänzte Fälle", () => {
  const parse = (md: string) => new MarkdownImporter({ lenient: true }).parse(md).map(importedJSON);
  it("~~~-Zäune mit Sprache, H5/H6, lange Trenner, Autolinks, To-do-Schreibweisen, Bild mit Titel", () => {
    expect(parse("~~~python\nprint(1)\n~~~")).toEqual([{ type: "code", text: "print(1)", children: [], props: { language: "python" } }]);
    expect(parse("```ts title=x\nlet a\n```")[0]).toMatchObject({ type: "code", props: { language: "ts" } });
    expect(parse("##### Five\n###### Six ##")).toEqual([
      { type: "heading4", text: "Five", children: [] }, { type: "heading4", text: "Six", children: [] },
    ]);
    expect(parse("-----\n* * *").map((b) => b.type)).toEqual(["divider", "divider"]);
    expect(parse("see <https://example.com/x>")[0]!.text).toEqual([{ t: "see " }, { t: "https://example.com/x", m: { link: "https://example.com/x" } }]);
    expect(parse("* [X] done\n+ [ ] open")).toEqual([
      { type: "todo", text: "done", children: [], props: { checked: true } }, { type: "todo", text: "open", children: [], props: { checked: false } },
    ]);
    expect(parse("![Cat](https://example.com/cat.png \"A cat\")")).toEqual([{ type: "image", text: "", children: [], props: { url: "https://example.com/cat.png", caption: "Cat" } }]);
  });

  it("ein ganzes Dokument: Überschriften, verschachtelte Listen, To-dos, Zitat, Code, Tabelle, Trenner, Inline", () => {
    const md = [
      "# Plan", "", "Intro with **bold**, *italic*, `code`, ~~old~~ and a [link](https://example.com).", "",
      "- one", "  - nested", "    - deeper", "- two", "", "1. first", "2. second", "", "- [ ] open", "- [x] done", "",
      "> quoted", "", "```js", "const a = 1;", "```", "", "| A | B |", "| --- | --- |", "| 1 | **2** |", "", "---", "", "![Diagram](https://example.com/d.png)",
    ].join("\n");
    const out = parse(md);
    expect(out.map((b) => b.type)).toEqual(["heading1", "text", "bulletedList", "bulletedList", "numberedList", "numberedList", "todo", "todo", "quote", "code", "table", "divider", "image"]);
    expect(out[1]!.text).toEqual([
      { t: "Intro with " }, { t: "bold", m: { b: true } }, { t: ", " }, { t: "italic", m: { i: true } }, { t: ", " }, { t: "code", m: { c: true } },
      { t: ", " }, { t: "old", m: { s: true } }, { t: " and a " }, { t: "link", m: { link: "https://example.com" } }, { t: "." },
    ]);
    const one = out[2] as { children: { text: string; children: { text: string }[] }[] };
    expect(one.children[0]!.text).toBe("nested");
    expect(one.children[0]!.children[0]!.text).toBe("deeper");
    expect(out[9]).toMatchObject({ props: { language: "js" }, text: "const a = 1;" });
    const table = out[10] as { props: { tableColumns: number }; children: { props: { cells: unknown[] } }[] };
    expect(table.props.tableColumns).toBe(2);
    expect(table.children.map((r) => r.props.cells)).toEqual([["A", "B"], ["1", [{ t: "2", m: { b: true } }]]]);
  });
});

describe("Datums-Erwähnungen", () => {
  const now = new Date(2026, 10, 10, 15, 30); // Di, 10. Nov 2026
  const ymd = (d: Date | undefined) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : undefined);
  it("Schlüsselwörter und Präfixe", () => {
    expect(dateSuggestions("", now).map((s) => s.label)).toEqual(["Today", "Tomorrow"]);
    expect(dateSuggestions("tod", now).map((s) => [s.label, ymd(s.date)])).toEqual([["Today", "2026-11-10"]]);
    expect(dateSuggestions("tomorrow", now).map((s) => ymd(s.date))).toEqual(["2026-11-11"]);
    expect(dateSuggestions("yest", now).map((s) => ymd(s.date))).toEqual(["2026-11-9"]);
    expect(dateSuggestions("meeting notes", now)).toEqual([]);
  });
  it("Wochentage: das nächste Vorkommen, nie heute", () => {
    expect(dateSuggestions("fri", now).map((s) => ymd(s.date))).toEqual(["2026-11-13"]);
    expect(dateSuggestions("next tuesday", now).map((s) => ymd(s.date))).toEqual(["2026-11-17"]);
  });
  it("getippte Daten", () => {
    expect(ymd(parseTypedDate("2026-12-24", now))).toBe("2026-12-24");
    expect(ymd(parseTypedDate("24.12.2026", now))).toBe("2026-12-24");
    expect(ymd(parseTypedDate("24.12.", now))).toBe("2026-12-24");
    expect(ymd(parseTypedDate("12/24/2026", now))).toBe("2026-12-24");
    expect(ymd(parseTypedDate("Dec 24", now))).toBe("2026-12-24");
    expect(ymd(parseTypedDate("jan 5", now))).toBe("2027-1-5");
    expect(ymd(parseTypedDate("24 December 2027", now))).toBe("2027-12-24");
    expect(ymd(parseTypedDate("March 3rd, 2028", now))).toBe("2028-3-3");
    expect(parseTypedDate("2026-02-30", now)).toBeUndefined();
    expect(parseTypedDate("13/45", now)).toBeUndefined();
    expect(parseTypedDate("mar", now)).toBeUndefined();
    expect(dateSuggestions("2026-12-24", now)).toHaveLength(1);
  });
  it("Wire-Wert: Mitternacht lokal, Erinnerung nur wenn gesetzt", () => {
    const v = dateMentionValue(new Date(2026, 11, 24, 9, 0));
    expect(v).toEqual({ start: v.start, includeTime: false });
    expect(ymd(dateFromSwift(v.start))).toBe("2026-12-24");
    expect(dateFromSwift(v.start).getHours()).toBe(0);
    expect(dateMentionValue(new Date(2026, 11, 24), true).remind).toBe(true);
  });
});

describe("Gliederung", () => {
  it("Überschriften in Dokumentreihenfolge, auch verschachtelt und in Synced Blocks, nicht in Unterseiten", () => {
    const s = make([
      blk("P", "w", "a0"),
      blk("h1", "b:P", "a0", "heading1", { text: "Intro" }),
      blk("t", "b:P", "a1", "toggle"),
      blk("h2", "b:t", "a0", "heading3", { text: [{ t: "Deep", m: { b: true } }, { t: " dive" }] }),
      blk("sub", "b:P", "a2", "page"),
      blk("hx", "b:sub", "a0", "heading1", { text: "Not mine" }),
      blk("copy", "b:P", "a3", "syncedBlock", { props: { syncSource: "orig" } }),
      blk("O", "w", "a1"),
      blk("orig", "b:O", "a0", "syncedBlock"),
      blk("hs", "b:orig", "a0", "heading2", { text: "Shared" }),
      blk("h3", "b:P", "a4", "heading2", { text: "" }),
      blk("gone", "b:P", "a5", "heading1", { text: "Trashed", trashedAt: 5 }),
    ]);
    expect(headingOutline(s, "P")).toEqual([
      { id: "h1", level: 1, depth: 0, title: "Intro" },
      { id: "h2", level: 3, depth: 1, title: "Deep dive" },
      { id: "hs", level: 2, depth: 1, title: "Shared" },
      { id: "h3", level: 2, depth: 1, title: "Untitled" },
    ]);
    expect(headingOutline(s, "missing")).toEqual([]);
  });
  it("Einrückung ohne Sprünge; aktive Überschrift", () => {
    const d = (levels: number[]) => withDepth(levels.map((level, i) => ({ id: String(i), level, title: "" }))).map((h) => h.depth);
    expect(d([2, 3, 3, 2, 1, 4, 2])).toEqual([0, 1, 1, 0, 0, 1, 1]);
    expect(d([3, 1, 2, 4])).toEqual([0, 0, 1, 2]);
    expect(activeHeadingIndex([], 0)).toBe(-1);
    expect(activeHeadingIndex([50, 300, 900], 0)).toBe(0);
    expect(activeHeadingIndex([-400, -10, 600], 0)).toBe(1);
    expect(activeHeadingIndex([-400, 80, 600], 100)).toBe(1);
    expect(activeHeadingIndex([-900, -500, -100], 0)).toBe(2);
  });
});

describe("Backlinks", () => {
  const records = [
    blk("A", "w", "a0", "page", { text: "Alpha" }),
    blk("a1", "b:A", "a0", "text", { text: [{ t: "see " }, { t: "Beta", mention: { page: { _0: "B" } } }] }),
    blk("B", "w", "a1", "page", { text: "Beta" }),
    blk("b1", "b:B", "a0", "text", { text: [{ t: "self", mention: { page: { _0: "B" } } }] }),
    blk("C", "w", "a2", "page", { text: "charlie" }),
    blk("c1", "b:C", "a0", "toggle"),
    blk("c2", "b:c1", "a0", "linkToPage", { props: { linkTarget: "B" } }),
    blk("D", "w", "a3", "page", { text: "Delta", trashedAt: 9 }),
    blk("d1", "b:D", "a0", "text", { text: [{ t: "x", mention: { page: { _0: "B" } } }] }),
    blk("E", "w", "a4", "page", { text: "Echo" }),
    blk("e1", "b:E", "a0", "table"),
    blk("e2", "b:e1", "a0", "tableRow", { props: { cells: ["x", [{ t: "B", mention: { page: { _0: "B" } } }]] } }),
    blk("e3", "b:E", "a1", "text", { text: [{ t: "link", m: { link: "based://page/A" } }, { t: "d", mention: { date: { _0: { start: 1, includeTime: false } } } }] }),
  ];
  it("Erwähnungen, Link-to-page, Tabellenzellen; ohne die Seite selbst und ohne Papierkorb; nach Titel", () => {
    const s = make(records);
    expect(backlinksTo(s, "B")).toEqual(["A", "C", "E"]);
    expect(backlinksTo(s, "A")).toEqual(["E"]);
    expect(backlinksTo(s, "C")).toEqual([]);
    expect([...linkedPages(s.blocks.get("e3")!)]).toEqual(["A"]);
    expect(containingPage(s, "c2")).toBe("C");
    expect(containingPage(s, "C")).toBe("C");
  });
  it("Index wird inkrementell nachgeführt", () => {
    const s = make(records);
    const idx = LinkIndex.fromStore(s);
    const changed: string[] = [];
    s.observe((c) => changed.push(...c.keys));
    s.transact("edit", (tx) => {
      tx.update("a1", (b) => { b.text = "no more"; });
      tx.put(blk("c3", "b:C", "a1", "text", { text: [{ t: "A", mention: { page: { _0: "A" } } }] }));
      tx.remove("block:e2");
    });
    idx.apply(s, changed as never);
    expect(idx.backlinks(s, "B")).toEqual(["C"]);
    expect(idx.backlinks(s, "A")).toEqual(["C", "E"]);
  });
});

describe("Synced Blocks", () => {
  const records = () => [
    blk("A", "w", "a0", "page"),
    blk("orig", "b:A", "a0", "syncedBlock"),
    blk("k1", "b:orig", "a0", "text", { text: "shared one" }),
    blk("k2", "b:orig", "a1", "bulletedList", { text: "shared two" }),
    blk("k3", "b:k2", "a0", "text", { text: "nested" }),
    blk("B", "w", "a1", "page"),
    blk("copy", "b:B", "a0", "syncedBlock", { props: { syncSource: "orig" } }),
    blk("C", "w", "a2", "page"),
    blk("ct", "b:C", "a0", "toggle"),
  ];
  it("Einfügen: unbekannt, in sich selbst, zweimal im selben Dokument", () => {
    const s = make(records());
    expect(syncedPasteProblem(s, "nope", "C")).toBe("noSource");
    expect(syncedPasteProblem(s, "k1", "C")).toBe("noSource");
    expect(syncedPasteProblem(s, "orig", "C")).toBeUndefined();
    expect(syncedPasteProblem(s, "copy", "C")).toBeUndefined();
    expect(syncedPasteProblem(s, "orig", "B")).toBe("alreadyOnPage");
    expect(syncedPasteProblem(s, "copy", "A")).toBe("alreadyOnPage");
    expect(syncedPasteProblem(s, "orig", "orig")).toBe("insideItself");
    expect(syncedPasteProblem(s, "orig", "X", ["orig"])).toBe("insideItself");
    expect(syncedInstances(s, "B", "orig")).toEqual(["copy"]);
  });
  it("Unsync: eigenes Duplikat mit neuen IDs, Original unverändert", () => {
    const s = make(records());
    expect(unsyncCopy(s, "orig")).toBe(false);
    expect(unsyncCopy(s, "copy")).toBe(true);
    expect(s.blocks.get("copy")!.props?.syncSource).toBeUndefined();
    const kids = s.children("b:copy").map((id) => s.blocks.get(id)!);
    expect(kids.map((k) => [k.type, k.text])).toEqual([["text", "shared one"], ["bulletedList", "shared two"]]);
    expect(kids.every((k) => !["k1", "k2"].includes(k.id))).toBe(true);
    expect(s.children("b:" + kids[1]!.id).map((id) => s.blocks.get(id)!.text)).toEqual(["nested"]);
    expect(s.children("b:orig")).toEqual(["k1", "k2"]);
    s.undo();
    expect(s.blocks.get("copy")!.props?.syncSource).toBe("orig");
    expect(s.children("b:copy")).toEqual([]);
  });
  it("Papierkorb und Abhängigkeiten einer Seiten-Replik", () => {
    const s = make(records());
    expect(trashedRoot(s, "orig")).toBeUndefined();
    const dep = syncedDependencies(s, "B", (id) => subtree(s, id));
    expect([...dep.roots]).toEqual(["orig"]);
    expect([...dep.ancestors]).toEqual(["A"]);
    expect(syncedDependencies(s, "A", (id) => subtree(s, id)).roots.size).toBe(0);
    s.transact("trash", (tx) => tx.update("A", (b) => { b.trashedAt = 7; }));
    expect(trashedRoot(s, "orig")).toBe("A");
  });
});
