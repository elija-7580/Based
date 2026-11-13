// ADR 0016 (E1): Befehle des Block-Editors auf Records – Tippen, Enter, ⌫, Ein-/Ausrücken, Turn into, Verschieben,
// Spalten, Markdown-Kürzel, Undo. Jeder Befehl ist ein Undo-Schritt.
import { describe, expect, it } from "vitest";
import { MemoryPersistence, WorkspaceStore, blockCmd as cmd, rich, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const blk = (id: string, parent: string, sk: string, type = "text", text?: unknown, props?: Record<string, unknown>): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, ...(text !== undefined ? { text } : {}), ...(props ? { props } : {}), createdAt: 0, updatedAt: 0, stamp } as never,
});

function page(...children: WireRecord[]) {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence([blk("P", "w", "a0", "page", "Page"), ...children]), node: "n", now: () => 100 });
  return s;
}
const text = (s: WorkspaceStore, id: string) => rich.richPlain(s.blocks.get(id)?.text);
const kids = (s: WorkspaceStore, id: string) => s.children("b:" + id);
const types = (s: WorkspaceStore, id: string) => kids(s, id).map((k) => s.blocks.get(k)!.type);

describe("RichText-Operationen", () => {
  it("Einfügen übernimmt die Marks links, Links wachsen am Ende nicht weiter", () => {
    const bold = [{ t: "ab", m: { b: true } }, { t: "c" }];
    expect(rich.richInsertText(bold, 2, 2, "X")).toEqual([{ t: "abX", m: { b: true } }, { t: "c" }]);
    const link = [{ t: "go", m: { link: "https://x" } }];
    expect(rich.richInsertText(link, 2, 2, "!")).toEqual([{ t: "go", m: { link: "https://x" } }, { t: "!" }]);
  });
  it("Mark umschalten über einen Teilbereich und zurück", () => {
    const t = rich.richToggleMark("hello", 1, 3, "b");
    expect(t).toEqual([{ t: "h" }, { t: "el", m: { b: true } }, { t: "lo" }]);
    expect(rich.richToggleMark(t, 1, 3, "b")).toBe("hello");
  });
  it("Erwähnungen zählen als ein Zeichen", () => {
    const t = [{ t: "a" }, { mention: { page: "X" } }, { t: "b" }] as never;
    expect(rich.richLength(t)).toBe(3);
    expect(rich.richReplace(t, 1, 2, "")).toBe("ab");
  });
});

describe("Block-Editor: Befehle", () => {
  it("Tippen: mehrere Zeichen sind ein Undo-Schritt", () => {
    const s = page(blk("a", "b:P", "a0", "text", "Hi"));
    let c = { id: "a", from: 2, to: 2 };
    for (const ch of " there") c = cmd.insertText(s, c, ch).caret!;
    expect(text(s, "a")).toBe("Hi there");
    s.undo();
    expect(text(s, "a")).toBe("Hi");
  });

  it("Enter teilt den Block, Listen setzen sich fort, Text danach wandert mit", () => {
    const s = page(blk("a", "b:P", "a0", "bulletedList", "onetwo"));
    const r = cmd.splitBlock(s, "P", { id: "a", from: 3, to: 3 });
    expect(text(s, "a")).toBe("one");
    expect(text(s, r.caret!.id)).toBe("two");
    expect(types(s, "P")).toEqual(["bulletedList", "bulletedList"]);
    // leerer Listenpunkt + Enter → Text
    const empty = cmd.splitBlock(s, "P", { id: r.caret!.id, from: 3, to: 3 }).caret!;
    cmd.splitBlock(s, "P", empty);
    expect(s.blocks.get(empty.id)!.type).toBe("text");
  });

  it("Enter am Anfang fügt einen leeren Block davor ein, der Inhalt bleibt", () => {
    const s = page(blk("a", "b:P", "a0", "heading1", "Title"));
    const r = cmd.splitBlock(s, "P", { id: "a", from: 0, to: 0 });
    expect(r.caret).toEqual({ id: "a", from: 0, to: 0 });
    expect(kids(s, "P").length).toBe(2);
    expect(kids(s, "P")[1]).toBe("a");
    expect(s.blocks.get(kids(s, "P")[0]!)!.type).toBe("text");
  });

  it("Enter im offenen Toggle mit Kindern legt den neuen Block als erstes Kind an", () => {
    const s = page(blk("t", "b:P", "a0", "toggle", "Tog", { isOpen: true }), blk("c", "b:t", "a0", "text", "child"));
    const r = cmd.splitBlock(s, "P", { id: "t", from: 3, to: 3 });
    expect(kids(s, "t")[0]).toBe(r.caret!.id);
  });

  it("⌫ am Anfang: erst zu Text, dann ausrücken, dann zusammenführen (Kinder bleiben erhalten)", () => {
    const s = page(blk("a", "b:P", "a0", "text", "Hello"), blk("b", "b:a", "a0", "todo", "World"), blk("c", "b:b", "a0", "text", "kid"));
    cmd.deleteBackward(s, "P", { id: "b", from: 0, to: 0 });
    expect(s.blocks.get("b")!.type).toBe("text");
    cmd.deleteBackward(s, "P", { id: "b", from: 0, to: 0 });
    expect(s.blocks.get("b")!.parent).toBe("b:P");
    const r = cmd.deleteBackward(s, "P", { id: "b", from: 0, to: 0 });
    expect(r.caret).toEqual({ id: "a", from: 5, to: 5 });
    expect(text(s, "a")).toBe("HelloWorld");
    expect(s.blocks.get("b")).toBeUndefined();
    expect(s.blocks.get("c")!.parent).toBe("b:P");
  });

  it("⌫ hinter einem Bild wählt das Bild, ein leerer Block verschwindet", () => {
    const s = page(blk("img", "b:P", "a0", "image"), blk("a", "b:P", "a1", "text"));
    const r = cmd.deleteBackward(s, "P", { id: "a", from: 0, to: 0 });
    expect(r.select).toEqual(["img"]);
    expect(s.blocks.get("a")).toBeUndefined();
  });

  it("⌫ löscht ganze Emojis (Grapheme)", () => {
    const s = page(blk("a", "b:P", "a0", "text", "ok👍🏽"));
    const r = cmd.deleteBackward(s, "P", { id: "a", from: 6, to: 6 });
    expect(text(s, "a")).toBe("ok");
    expect(r.caret!.from).toBe(2);
  });

  it("Tab/⇧Tab rücken ein und aus, ein Undo-Schritt je Befehl", () => {
    const s = page(blk("a", "b:P", "a0", "text", "A"), blk("b", "b:P", "a1", "text", "B"), blk("c", "b:P", "a2", "text", "C"));
    cmd.indent(s, ["b", "c"], "P");
    expect(kids(s, "a")).toEqual(["b", "c"]);
    cmd.outdent(s, ["b", "c"]);
    expect(kids(s, "P")).toEqual(["a", "b", "c"]);
    s.undo();
    expect(kids(s, "a")).toEqual(["b", "c"]);
  });

  it("Einrücken unter eine Überschrift ohne Toggle geht nicht", () => {
    const s = page(blk("h", "b:P", "a0", "heading2", "H"), blk("b", "b:P", "a1", "text", "B"));
    cmd.indent(s, ["b"], "P");
    expect(s.blocks.get("b")!.parent).toBe("b:P");
  });

  it("Markdown-Kürzel: „## “ wird Überschrift, „[] “ To-do, „---“ Trenner", () => {
    const s = page(blk("a", "b:P", "a0", "text", "## Plan"));
    cmd.applyMarkdownShortcut(s, { id: "a", from: 3, to: 3 });
    expect(s.blocks.get("a")!.type).toBe("heading2");
    expect(text(s, "a")).toBe("Plan");
    const t = page(blk("a", "b:P", "a0", "text", "[] buy"));
    cmd.applyMarkdownShortcut(t, { id: "a", from: 3, to: 3 });
    expect(t.blocks.get("a")!.type).toBe("todo");
    const d = page(blk("a", "b:P", "a0", "text", "---"));
    const r = cmd.applyMarkdownShortcut(d, { id: "a", from: 3, to: 3 })!;
    expect(d.blocks.get("a")!.type).toBe("divider");
    expect(d.blocks.get(r.caret!.id)!.type).toBe("text");
  });

  it("Verschieben davor/danach/hinein und in Spalten; leere Spalten werden aufgelöst", () => {
    const s = page(blk("a", "b:P", "a0", "text", "A"), blk("b", "b:P", "a1", "text", "B"), blk("c", "b:P", "a2", "text", "C"));
    cmd.moveBlocks(s, ["c"], "a", "before");
    expect(kids(s, "P")).toEqual(["c", "a", "b"]);
    cmd.moveBlocks(s, ["b"], "a", "right");
    const list = kids(s, "P").find((k) => s.blocks.get(k)!.type === "columnList")!;
    const cols = kids(s, list);
    expect(cols.map((c) => kids(s, c))).toEqual([["a"], ["b"]]);
    // dritte Spalte neben einem Block in einer Spalte
    cmd.moveBlocks(s, ["c"], "b", "right");
    expect(kids(s, list).map((c) => kids(s, c))).toEqual([["a"], ["b"], ["c"]]);
    // Block aus Spalte heraus: leere Spalte verschwindet, eine Spalte allein löst die Liste auf
    cmd.moveBlocks(s, ["b"], list, "after");
    cmd.moveBlocks(s, ["c"], list, "after");
    expect(s.blocks.get(list)).toBeUndefined();
    expect(kids(s, "P")).toEqual(["a", "c", "b"]);
  });

  it("Verschieben in sich selbst wird abgelehnt", () => {
    const s = page(blk("a", "b:P", "a0", "text", "A"), blk("b", "b:a", "a0", "text", "B"));
    expect(cmd.moveBlocks(s, ["a"], "b", "inside")).toBe(false);
  });

  it("Turn into Code entfernt Formatierung; Duplizieren kopiert Kinder", () => {
    const s = page(blk("a", "b:P", "a0", "text", [{ t: "x", m: { b: true } }]), blk("k", "b:a", "a0", "text", "kid"));
    const [copy] = cmd.duplicateBlocks(s, ["a"]);
    expect(kids(s, copy!).map((k) => text(s, k))).toEqual(["kid"]);
    cmd.turnInto(s, ["a"], "code");
    expect(s.blocks.get("a")!.text).toBe("x");
  });

  it("Sichtbare Reihenfolge: geschlossene Toggles verstecken Kinder, Spalten von links nach rechts", () => {
    const s = page(
      blk("t", "b:P", "a0", "toggle", "T", { isOpen: false }), blk("tk", "b:t", "a0", "text", "hidden"),
      blk("L", "b:P", "a1", "columnList"), blk("c1", "b:L", "a0", "column"), blk("c2", "b:L", "a1", "column"),
      blk("x", "b:c1", "a0", "text", "X"), blk("y", "b:c2", "a0", "text", "Y"),
    );
    expect(cmd.visibleOrder(s, "P")).toEqual(["t", "x", "y"]);
    expect(cmd.neighbourText(s, "P", "x", 1)).toBe("y");
  });

  it("Inline-Markdown: **fett**, *kursiv*, `Code`, ~~durch~~ beim schließenden Zeichen", () => {
    const s = page(blk("a", "b:P", "a0", "text", "say **hi**"));
    const r = cmd.applyInlineMarkdown(s, { id: "a", from: 10, to: 10 })!;
    expect(s.blocks.get("a")!.text).toEqual([{ t: "say " }, { t: "hi", m: { b: true } }]);
    expect(r.caret).toEqual({ id: "a", from: 6, to: 6 });
    const t = page(blk("a", "b:P", "a0", "text", "a `x` and *y*"));
    cmd.applyInlineMarkdown(t, { id: "a", from: 5, to: 5 });
    expect(t.blocks.get("a")!.text).toEqual([{ t: "a " }, { t: "x", m: { c: true } }, { t: " and *y*" }]);
    expect(cmd.applyInlineMarkdown(t, { id: "a", from: 3, to: 3 })).toBeUndefined();
  });

  it("Markdown-Kürzel auch in Listen: „1. “ macht aus einem Aufzählungspunkt eine Nummer", () => {
    const s = page(blk("a", "b:P", "a0", "bulletedList", "1. x"));
    cmd.applyMarkdownShortcut(s, { id: "a", from: 3, to: 3 });
    expect(s.blocks.get("a")!.type).toBe("numberedList");
    expect(text(s, "a")).toBe("x");
  });
});
