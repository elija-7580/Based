// BSD-382 (ADR 0016, E1): Befehle des neuen Block-Editors auf Records. Jeder Fall läuft in beiden Datenformaten
// (Properties in der Datenbank / als eigene Records, BSD-30) und prüft: Records gültig, ein Undo-Schritt stellt den
// Stand davor exakt wieder her, Redo den danach.
import { describe, expect, it } from "vitest";
import {
  blockCommands as cmd, encodeRecord, MemoryPersistence, parseRecord, plainText, WorkspaceStore, type Block, type WireRecord,
} from "../src/index.js";

const STAMP = { millis: 1, counter: 0, node: "x" };
type Extra = Partial<Omit<Block, "id" | "type" | "parent" | "sk">>;
const blk = (id: string, type: string, parent: string, sk: string, extra: Extra = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp: STAMP, ...extra } as Block,
});
const db = (id: string, blockID: string): WireRecord => ({
  kind: "database",
  data: { id, blockID, title: "Tasks", properties: [{ id: "title", name: "Name", type: "title" }, { id: "s", name: "Status", type: "select", options: [] }], createdAt: 0, updatedAt: 0, stamp: STAMP },
});
const view = (id: string, blockID: string, databaseID: string): WireRecord => ({
  kind: "view",
  data: { id, blockID, databaseID, name: "Table", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp: STAMP } as never,
});

function make(propertyRecords: boolean, records: WireRecord[]) {
  let now = 1000;
  const s = new WorkspaceStore({ persistence: new MemoryPersistence([blk("P", "page", "w", "a0", { text: "Page" }), ...records]), node: "n", now: () => (now += 10), propertyRecords });
  return s;
}

/** Inhalt der Seite als Zeilen „  typ: text“, eingerückt nach Tiefe; Prüfling für Baum und Text. */
function outline(s: WorkspaceStore, root = "P"): string[] {
  const out: string[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of s.children("b:" + id)) {
      const b = s.blocks.get(c)!;
      if (b.trashedAt !== undefined) continue;
      const extra = [b.props?.checked ? "x" : "", b.props?.isOpen ? "open" : ""].filter(Boolean).join(",");
      out.push(`${"  ".repeat(depth)}${b.type}${extra ? `[${extra}]` : ""}: ${plainText(b.text)}`);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Zustand ohne Stempel/Zeiten, um Undo exakt zu vergleichen. */
function snapshot(s: WorkspaceStore): string[] {
  return s.allRecords().map((r) => {
    const d = { ...r.data } as Record<string, unknown>;
    delete d.stamp; delete d.updatedAt; delete d.updatedBy;
    // Auf/Zu von Toggles ist Ansichtszustand: Undo lässt ihn stehen (WorkspaceStore.keepingOpenState).
    if (r.kind === "block" && d.props) {
      const p = { ...(d.props as Record<string, unknown>) };
      delete p.isOpen;
      if (Object.keys(p).length) d.props = p;
      else delete d.props;
    }
    return encodeRecord({ kind: r.kind, data: d } as WireRecord);
  }).sort();
}

/** Befehl ausführen, Records prüfen, genau ein Undo-Schritt hin und zurück. */
function step<T>(s: WorkspaceStore, run: () => T): T {
  const before = snapshot(s);
  s.clearUndoHistory();
  const result = run();
  const after = snapshot(s);
  for (const r of s.allRecords()) expect(() => parseRecord(JSON.parse(encodeRecord(r)))).not.toThrow();
  // Geschwister haben eindeutige Sortierschlüssel (Reihenfolge stabil auf allen Geräten).
  for (const b of s.blocks.values()) {
    const keys = s.children(b.parent).map((c) => s.blocks.get(c)!.sk);
    expect(new Set(keys).size).toBe(keys.length);
  }
  if (before.join("\n") !== after.join("\n")) {
    s.undo();
    expect(s.canUndo).toBe(false);
    expect(snapshot(s)).toEqual(before);
    s.redo();
    expect(snapshot(s)).toEqual(after);
  }
  return result;
}

const bold = (t: string) => ({ t, m: { b: true } });

describe.each([false, true])("Block-Editor E1 (propertyRecords=%s)", (pr) => {
  describe("Text", () => {
    it("ersetzt einen Bereich, übernimmt die Marks davor und fasst Tippen zusammen", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [bold("Hello"), { t: " world" }] })]);
      const f = step(s, () => cmd.replaceText(s, { blockId: "a", from: 5, to: 5 }, "!"));
      expect(f).toEqual({ blockId: "a", offset: 6 });
      expect(s.blocks.get("a")!.text).toEqual([bold("Hello!"), { t: " world" }]);
      cmd.replaceText(s, { blockId: "a", from: 6, to: 12 }, "");
      cmd.replaceText(s, { blockId: "a", from: 6, to: 6 }, "?");
      expect(plainText(s.blocks.get("a")!.text)).toBe("Hello!?");
      // Die beiden Tipp-Schritte danach sind ein Undo-Schritt.
      s.undo();
      expect(plainText(s.blocks.get("a")!.text)).toBe("Hello!");
    });

    it("leerer Block: Text weg = Feld weg", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "x" })]);
      step(s, () => cmd.replaceText(s, { blockId: "a", from: 0, to: 1 }, ""));
      expect("text" in s.blocks.get("a")!).toBe(false);
      expect(cmd.replaceText(s, { blockId: "P", from: 0, to: 0 }, "x")).toBeUndefined();
    });

    it("hinter einem Link oder Code geht der Mark nicht weiter", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [{ t: "site", m: { link: "https://x.y", b: true } }] })]);
      cmd.replaceText(s, { blockId: "a", from: 4, to: 4 }, " ok");
      expect(s.blocks.get("a")!.text).toEqual([{ t: "site", m: { b: true, link: "https://x.y" } }, { t: " ok", m: { b: true } }]);
    });

    it("schneidet nie in eine Erwähnung", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [{ t: "A " }, { t: "@Page", mention: { page: { _0: "P" } } }, { t: " B" }] })]);
      expect(step(s, () => cmd.replaceText(s, { blockId: "a", from: 4, to: 4 }, "x"))).toEqual({ blockId: "a", offset: 8 });
      expect(s.blocks.get("a")!.text).toEqual([{ t: "A " }, { t: "@Page", mention: { page: { _0: "P" } } }, { t: "x B" }]);
    });

    it("formatiert über mehrere Blöcke; ⌘B schaltet um", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "abcdef" }), blk("b", "text", "b:P", "a1", { text: "ghi" })]);
      const f = step(s, () => cmd.formatText(s, [{ blockId: "a", from: 2, to: 6 }, { blockId: "b", from: 0, to: 2 }], "b"));
      expect(f).toEqual({ blockId: "b", range: { from: 0, to: 2 } });
      expect(s.blocks.get("a")!.text).toEqual([{ t: "ab" }, bold("cdef")]);
      expect(s.blocks.get("b")!.text).toEqual([bold("gh"), { t: "i" }]);
      step(s, () => cmd.formatText(s, [{ blockId: "a", from: 2, to: 6 }, { blockId: "b", from: 0, to: 2 }], "b"));
      expect(s.blocks.get("a")!.text).toBe("abcdef");
      cmd.formatText(s, [{ blockId: "a", from: 0, to: 3 }], "color", "red");
      expect(s.blocks.get("a")!.text).toEqual([{ t: "abc", m: { color: "red" } }, { t: "def" }]);
      cmd.formatText(s, [{ blockId: "a", from: 0, to: 6 }], "color", "default");
      expect(s.blocks.get("a")!.text).toBe("abcdef");
    });
  });

  describe("Teilen (Enter)", () => {
    it("teilt mitten im Text, Marks über die Teilungsstelle bleiben auf beiden Seiten", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [{ t: "ab" }, bold("cdef"), { t: "g" }], props: { color: "red" } })]);
      const f = step(s, () => cmd.splitBlock(s, "a", 4)) as { blockId: string; offset: number };
      expect(f.offset).toBe(0);
      expect(s.blocks.get("a")!.text).toEqual([{ t: "ab" }, bold("cd")]);
      expect(s.blocks.get(f.blockId)!.text).toEqual([bold("ef"), { t: "g" }]);
      expect(s.blocks.get(f.blockId)!.props).toEqual({ color: "red" });
      expect(outline(s)).toEqual(["text: abcd", "text: efg"]);
    });

    it("Listen und To-dos setzen sich fort (To-do neu ohne Haken); Überschrift am Ende → Text", () => {
      const s = make(pr, [
        blk("a", "bulletedList", "b:P", "a0", { text: "one" }),
        blk("t", "todo", "b:P", "a1", { text: "done", props: { checked: true } }),
        blk("h", "heading1", "b:P", "a2", { text: "Title" }),
      ]);
      step(s, () => cmd.splitBlock(s, "a", 3));
      step(s, () => cmd.splitBlock(s, "t", 4));
      step(s, () => cmd.splitBlock(s, "h", 5));
      expect(outline(s)).toEqual(["bulletedList: one", "bulletedList: ", "todo[x]: done", "todo: ", "heading1: Title", "text: "]);
      step(s, () => cmd.splitBlock(s, "h", 2));
      expect(outline(s).slice(4, 6)).toEqual(["heading1: Ti", "heading1: tle"]);
    });

    it("Enter am Anfang: leerer Block davor, ID und Inhalt bleiben", () => {
      const s = make(pr, [blk("a", "heading2", "b:P", "a0", { text: "Head" })]);
      const f = step(s, () => cmd.splitBlock(s, "a", 0));
      expect(f).toEqual({ blockId: "a", offset: 0 });
      expect(outline(s)).toEqual(["text: ", "heading2: Head"]);
    });

    it("leere Liste: Text; eingerückt: ausrücken", () => {
      const s = make(pr, [
        blk("a", "bulletedList", "b:P", "a0", { text: "parent" }),
        blk("b", "bulletedList", "b:a", "a0"),
        blk("c", "bulletedList", "b:P", "a1"),
      ]);
      step(s, () => cmd.splitBlock(s, "b", 0));
      expect(outline(s)).toEqual(["bulletedList: parent", "bulletedList: ", "bulletedList: "]);
      step(s, () => cmd.splitBlock(s, "c", 0));
      expect(outline(s)[2]).toBe("text: ");
    });

    it("mit Kindern: neuer Block wird erstes Kind; zugeklapptes Toggle: Geschwister", () => {
      const s = make(pr, [
        blk("t", "toggle", "b:P", "a0", { text: "open", props: { isOpen: true } }),
        blk("k", "text", "b:t", "a0", { text: "kid" }),
        blk("z", "toggle", "b:P", "a1", { text: "closed" }),
        blk("zk", "text", "b:z", "a0", { text: "hidden" }),
      ]);
      step(s, () => cmd.splitBlock(s, "t", 4));
      step(s, () => cmd.splitBlock(s, "z", 6));
      expect(outline(s)).toEqual(["toggle[open]: open", "  toggle: ", "  text: kid", "toggle: closed", "  text: hidden", "toggle: "]);
    });

    it("leerer Textblock: neuer leerer Textblock darunter", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0"), blk("q", "quote", "b:P", "a1", { text: "q" })]);
      const f = step(s, () => cmd.splitBlock(s, "a", 0)) as { blockId: string };
      expect(f.blockId).not.toBe("a");
      step(s, () => cmd.splitBlock(s, "q", 1));
      expect(outline(s)).toEqual(["text: ", "text: ", "quote: q", "text: "]);
    });

    it("ersetzt eine Auswahl, Code-Block bekommt einen Zeilenumbruch", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "abcdef" }), blk("c", "code", "b:P", "a1", { text: "x=1" })]);
      step(s, () => cmd.splitBlock(s, "a", 2, 4));
      expect(outline(s).slice(0, 2)).toEqual(["text: ab", "text: ef"]);
      expect(step(s, () => cmd.splitBlock(s, "c", 3))).toEqual({ blockId: "c", offset: 4 });
      expect(s.blocks.get("c")!.text).toBe("x=1\n");
    });
  });

  describe("Zusammenführen (⌫ am Anfang)", () => {
    it("Text an den Block darüber, Marks bleiben, Fokus an der Nahtstelle", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [bold("ab")] }), blk("b", "text", "b:P", "a1", { text: "cd" })]);
      expect(step(s, () => cmd.mergeBackward(s, "b"))).toEqual({ blockId: "a", offset: 2 });
      expect(s.blocks.get("a")!.text).toEqual([bold("ab"), { t: "cd" }]);
      expect(s.blocks.has("b")).toBe(false);
    });

    it("Nicht-Text wird erst Text (Kinder bleiben)", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "a" }), blk("b", "bulletedList", "b:P", "a1", { text: "b" }), blk("k", "text", "b:b", "a0", { text: "k" })]);
      expect(step(s, () => cmd.mergeBackward(s, "b"))).toEqual({ blockId: "b", offset: 1 });
      expect(outline(s)).toEqual(["text: a", "text: b", "  text: k"]);
    });

    it("Kinder werden übernommen", () => {
      const s = make(pr, [
        blk("a", "bulletedList", "b:P", "a0", { text: "a" }),
        blk("ak", "bulletedList", "b:a", "a0", { text: "a1" }),
        blk("b", "text", "b:P", "a1", { text: "b" }),
        blk("bk", "text", "b:b", "a0", { text: "b1" }),
      ]);
      // Der Block über „b“ ist das letzte Kind von „a“.
      expect(step(s, () => cmd.mergeBackward(s, "b"))).toEqual({ blockId: "ak", offset: 2 });
      expect(outline(s)).toEqual(["bulletedList: a", "  bulletedList: a1b", "    text: b1"]);
    });

    it("erstes Kind in sein Elternteil: die Geschwister bleiben in Reihenfolge", () => {
      const s = make(pr, [
        blk("a", "toggle", "b:P", "a0", { text: "T", props: { isOpen: true } }),
        blk("c1", "text", "b:a", "a0", { text: "1" }),
        blk("c1k", "text", "b:c1", "a0", { text: "1k" }),
        blk("c2", "text", "b:a", "a1", { text: "2" }),
      ]);
      step(s, () => cmd.mergeBackward(s, "c1"));
      expect(outline(s)).toEqual(["toggle[open]: T1", "  text: 1k", "  text: 2"]);
    });

    it("zugeklapptes Toggle darüber: Ziel ist das Toggle selbst", () => {
      const s = make(pr, [blk("t", "toggle", "b:P", "a0", { text: "T" }), blk("k", "text", "b:t", "a0", { text: "k" }), blk("b", "text", "b:P", "a1", { text: "x" })]);
      expect(step(s, () => cmd.mergeBackward(s, "b"))).toEqual({ blockId: "t", offset: 1 });
      expect(outline(s)).toEqual(["toggle: Tx", "  text: k"]);
    });

    it("über einem Trenner: leerer Block weg, voller bleibt; Anfang der Seite: nichts", () => {
      const s = make(pr, [blk("d", "divider", "b:P", "a0"), blk("e", "text", "b:P", "a1"), blk("f", "text", "b:P", "a2", { text: "f" })]);
      expect(cmd.mergeBackward(s, "d")).toBeUndefined();
      expect(step(s, () => cmd.mergeBackward(s, "e"))).toEqual({ blockId: "d", selected: true });
      expect(s.blocks.has("e")).toBe(false);
      expect(step(s, () => cmd.mergeBackward(s, "f"))).toEqual({ blockId: "d", selected: true });
      expect(s.blocks.has("f")).toBe(true);
    });

    it("Entf am Ende holt den Block darunter heran", () => {
      const s = make(pr, [blk("a", "heading1", "b:P", "a0", { text: "H" }), blk("b", "todo", "b:P", "a1", { text: "t", props: { checked: true } })]);
      expect(step(s, () => cmd.mergeForward(s, "a"))).toEqual({ blockId: "a", offset: 1 });
      expect(outline(s)).toEqual(["heading1: Ht"]);
    });

    it("leerer Block am Anfang einer Spalte: nichts", () => {
      const s = make(pr, [blk("L", "columnList", "b:P", "a0"), blk("c1", "column", "b:L", "a0"), blk("x", "text", "b:c1", "a0", { text: "x" })]);
      expect(cmd.mergeBackward(s, "x")).toBeUndefined();
    });
  });

  describe("Einrücken / Ausrücken", () => {
    it("Tab unter den Block davor, zugeklapptes Toggle geht auf; ⇧Tab zurück", () => {
      const s = make(pr, [blk("t", "toggle", "b:P", "a0", { text: "T" }), blk("a", "text", "b:P", "a1", { text: "a" }), blk("b", "text", "b:P", "a2", { text: "b" })]);
      expect(step(s, () => cmd.indentBlocks(s, ["a", "b"], 1))).toEqual({ blockId: "a", offset: 1 });
      expect(outline(s)).toEqual(["toggle[open]: T", "  text: a", "  text: b"]);
      expect(cmd.indentBlocks(s, ["a"])).toBeUndefined();
      step(s, () => cmd.outdentBlocks(s, ["a"]));
      expect(outline(s)).toEqual(["toggle[open]: T", "text: a", "  text: b"]);
      expect(cmd.outdentBlocks(s, ["t"])).toBeUndefined();
    });

    it("nicht unter Überschrift, Trenner oder in Spalten hinaus", () => {
      const s = make(pr, [
        blk("h", "heading1", "b:P", "a0", { text: "H" }), blk("a", "text", "b:P", "a1"),
        blk("L", "columnList", "b:P", "a2"), blk("c1", "column", "b:L", "a0"), blk("x", "text", "b:c1", "a0"),
      ]);
      expect(cmd.indentBlocks(s, ["a"])).toBeUndefined();
      expect(cmd.outdentBlocks(s, ["x"])).toBeUndefined();
    });

    it("⇧Tab mehrerer Geschwister behält die Reihenfolge", () => {
      const s = make(pr, [
        blk("p", "bulletedList", "b:P", "a0", { text: "p" }),
        blk("x", "bulletedList", "b:p", "a0", { text: "x" }), blk("y", "bulletedList", "b:p", "a1", { text: "y" }), blk("z", "bulletedList", "b:p", "a2", { text: "z" }),
      ]);
      step(s, () => cmd.outdentBlocks(s, ["x", "y"]));
      expect(outline(s)).toEqual(["bulletedList: p", "bulletedList: x", "bulletedList: y", "  bulletedList: z"]);
    });
  });

  describe("Turn into und Markdown-Kürzel", () => {
    it("wechselt den Typ, alte Props fallen weg, Code verliert Formatierung, Kinder bleiben wo möglich", () => {
      const s = make(pr, [
        blk("a", "todo", "b:P", "a0", { text: [bold("x")], props: { checked: true, color: "blue" } }),
        blk("k", "text", "b:a", "a0", { text: "k" }),
      ]);
      step(s, () => cmd.turnInto(s, ["a"], "bulletedList"));
      expect(s.blocks.get("a")!.props).toEqual({ color: "blue" });
      expect(outline(s)).toEqual(["bulletedList: x", "  text: k"]);
      step(s, () => cmd.turnInto(s, ["a"], "code"));
      expect(s.blocks.get("a")!.text).toBe("x");
      expect(outline(s)).toEqual(["code: x", "text: k"]);
      expect(cmd.turnInto(s, ["a"], "divider")).toBeUndefined();
    });

    it("Kürzel am Blockanfang", () => {
      expect(cmd.markdownShortcut("# ")).toEqual({ type: "heading1" });
      expect(cmd.markdownShortcut("1. ")).toEqual({ type: "numberedList" });
      expect(cmd.markdownShortcut("a. ")).toEqual({ type: "numberedList" });
      expect(cmd.markdownShortcut("[x] ")).toEqual({ type: "todo", props: { checked: true } });
      expect(cmd.markdownShortcut("> ")).toEqual({ type: "toggle" });
      expect(cmd.markdownShortcut("\" ")).toEqual({ type: "quote" });
      expect(cmd.markdownShortcut("#")).toBeUndefined();
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: [{ t: "## " }, bold("Hi")] }), blk("d", "text", "b:P", "a1", { text: "---" })]);
      expect(step(s, () => cmd.applyMarkdownShortcut(s, "a", 3))).toEqual({ blockId: "a", offset: 0 });
      expect(s.blocks.get("a")!.type).toBe("heading2");
      expect(s.blocks.get("a")!.text).toEqual([bold("Hi")]);
      // ⌘Z macht Kürzel und Typ in einem Schritt rückgängig.
      s.undo();
      expect(s.blocks.get("a")!.type).toBe("text");
      expect(plainText(s.blocks.get("a")!.text)).toBe("## Hi");
      const f = step(s, () => cmd.applyMarkdownShortcut(s, "d", 3)) as { blockId: string };
      expect(outline(s)).toEqual(["text: ## Hi", "divider: ", "text: "]);
      expect(f.blockId).not.toBe("d");
      expect(cmd.applyMarkdownShortcut(s, "a", 1)).toBeUndefined();
    });
  });

  describe("Verschieben und Spalten", () => {
    const base = () => make(pr, [
      blk("a", "text", "b:P", "a0", { text: "a" }), blk("b", "text", "b:P", "a1", { text: "b" }),
      blk("c", "bulletedList", "b:P", "a2", { text: "c" }), blk("ck", "text", "b:c", "a0", { text: "ck" }),
    ]);

    it("vor/nach/hinein, mit Kindern, nicht in sich selbst", () => {
      const s = base();
      step(s, () => cmd.moveBlocks(s, ["c"], "a", "before"));
      expect(outline(s)).toEqual(["bulletedList: c", "  text: ck", "text: a", "text: b"]);
      step(s, () => cmd.moveBlocks(s, ["a"], "b", "after"));
      expect(outline(s)).toEqual(["bulletedList: c", "  text: ck", "text: b", "text: a"]);
      step(s, () => cmd.moveBlocks(s, ["b", "a"], "c", "inside"));
      expect(outline(s)).toEqual(["bulletedList: c", "  text: b", "  text: a", "  text: ck"]);
      expect(cmd.moveBlocks(s, ["c"], "ck", "after")).toBeUndefined();
      step(s, () => cmd.moveBlocksBy(s, ["a"], "down"));
      expect(outline(s)).toEqual(["bulletedList: c", "  text: b", "  text: ck", "  text: a"]);
      expect(cmd.moveBlocksBy(s, ["a"], "down")).toBeUndefined();
    });

    it("Spalte rechts: neue Spaltenliste; zurückziehen löst sie auf", () => {
      const s = base();
      step(s, () => cmd.moveBlocks(s, ["b"], "a", "right"));
      expect(outline(s)).toEqual(["columnList: ", "  column: ", "    text: a", "  column: ", "    text: b", "bulletedList: c", "  text: ck"]);
      step(s, () => cmd.moveBlocks(s, ["c"], "b", "left"));
      expect(outline(s)).toEqual(["columnList: ", "  column: ", "    text: a", "  column: ", "    bulletedList: c", "      text: ck", "  column: ", "    text: b"]);
      // b raus: seine Spalte verschwindet; dann c raus: nur noch eine Spalte → aufgelöst.
      step(s, () => cmd.moveBlocks(s, ["b"], "a", "before"));
      expect(outline(s)).toEqual(["columnList: ", "  column: ", "    text: b", "    text: a", "  column: ", "    bulletedList: c", "      text: ck"]);
      step(s, () => cmd.moveBlocks(s, ["c"], "a", "after"));
      expect(outline(s)).toEqual(["text: b", "text: a", "bulletedList: c", "  text: ck"]);
      expect([...s.blocks.values()].filter((b) => b.type === "column" || b.type === "columnList")).toEqual([]);
    });

    it("Spalten auflösen behält die Lesereihenfolge; Breiten weg, wenn eine Spalte fällt", () => {
      const s = make(pr, [
        blk("L", "columnList", "b:P", "a0"),
        blk("c1", "column", "b:L", "a0", { props: { ratio: 0.25 } }), blk("x", "text", "b:c1", "a0", { text: "x" }),
        blk("c2", "column", "b:L", "a1", { props: { ratio: 0.25 } }), blk("y", "text", "b:c2", "a0", { text: "y" }),
        blk("c3", "column", "b:L", "a2", { props: { ratio: 0.5 } }), blk("z", "text", "b:c3", "a0", { text: "z" }),
        blk("after", "text", "b:P", "a1", { text: "after" }),
      ]);
      step(s, () => cmd.deleteBlocks(s, ["z"]));
      expect(s.blocks.has("c3")).toBe(false);
      expect(s.blocks.get("c1")!.props).toBeUndefined();
      step(s, () => cmd.dissolveColumns(s, "L"));
      expect(outline(s)).toEqual(["text: x", "text: y", "text: after"]);
    });

    it("Inline-Datenbank in eine Spalte und zurück: Datenbank, Ansicht und Zeilen bleiben", () => {
      const s = make(pr, [
        blk("a", "text", "b:P", "a0", { text: "a" }),
        blk("D", "databaseInline", "b:P", "a1", { props: { databaseID: "db1", viewIDs: ["v1"] } }), db("db1", "D"), view("v1", "D", "db1"),
        blk("r1", "page", "d:db1", "a0", { text: "row", values: { s: { select: { _0: "x" } } } }),
      ]);
      step(s, () => cmd.moveBlocks(s, ["D"], "a", "right"));
      expect(s.blocks.get("D")!.type).toBe("databaseInline");
      step(s, () => cmd.moveBlocks(s, ["D"], "a", "after"));
      expect(outline(s)).toEqual(["text: a", "databaseInline: "]);
      expect(s.databases.get("db1")!.properties.map((p) => p.id)).toEqual(["title", "s"]);
      expect(s.views.has("v1")).toBe(true);
      expect(s.children("d:db1")).toEqual(["r1"]);
    });
  });

  describe("Löschen und Duplizieren", () => {
    it("löscht Blöcke mit Kindern, rettet Unterseiten in den Papierkorb, Fokus auf den Block darüber", () => {
      const s = make(pr, [
        blk("a", "text", "b:P", "a0", { text: "abc" }),
        blk("b", "toggle", "b:P", "a1", { text: "b" }), blk("sub", "page", "b:b", "a0", { text: "Sub" }),
        blk("c", "text", "b:P", "a2", { text: "c" }),
      ]);
      expect(step(s, () => cmd.deleteBlocks(s, ["b", "sub"]))).toEqual({ blockId: "a", offset: 3 });
      expect(outline(s)).toEqual(["text: a" + "bc", "text: c"]);
      expect(s.blocks.get("sub")!.trashedAt).toBeDefined();
      expect(step(s, () => cmd.deleteBlocks(s, ["a"]))).toEqual({ blockId: "c", offset: 0 });
      expect(step(s, () => cmd.deleteBlocks(s, ["c"]))).toEqual({ blockId: "P", offset: 0 });
    });

    it("Inline-Datenbank löschen: in den Papierkorb, Undo bringt alles zurück", () => {
      const s = make(pr, [blk("D", "databaseInline", "b:P", "a0", { props: { databaseID: "db1" } }), db("db1", "D"), blk("r1", "page", "d:db1", "a0", { text: "row" })]);
      step(s, () => cmd.deleteBlocks(s, ["D"]));
      expect(s.blocks.get("D")!.trashedAt).toBeDefined();
      expect(s.databases.has("db1")).toBe(true);
    });

    it("dupliziert als Gruppe hinter den letzten, mit Kindern und eigener Datenbank", () => {
      const s = make(pr, [
        blk("a", "bulletedList", "b:P", "a0", { text: "a" }), blk("ak", "text", "b:a", "a0", { text: "ak" }),
        blk("D", "databaseInline", "b:P", "a1", { props: { databaseID: "db1", viewIDs: ["v1"] } }), db("db1", "D"), view("v1", "D", "db1"),
        blk("r1", "page", "d:db1", "a0", { text: "row" }),
        blk("z", "text", "b:P", "a2", { text: "z" }),
      ]);
      const f = step(s, () => cmd.duplicateBlocks(s, ["D", "a", "ak"])) as { blockId: string; offset: number };
      expect(outline(s)).toEqual(["bulletedList: a", "  text: ak", "databaseInline: ", "bulletedList: a", "  text: ak", "databaseInline: ", "text: z"]);
      expect(f.offset).toBe(1);
      const copy = s.blocks.get(s.children("b:P")[3]!)!;
      const newDB = copy.props!.databaseID!;
      expect(newDB).not.toBe("db1");
      expect(s.databases.get(newDB)!.properties.map((p) => p.id)).toEqual(["title", "s"]);
      expect(s.children("d:" + newDB).map((r) => plainText(s.blocks.get(r)!.text))).toEqual(["row"]);
      expect(copy.props!.viewIDs).toHaveLength(1);
      expect(copy.props!.viewIDs![0]).not.toBe("v1");
    });

    it("To-do abhaken", () => {
      const s = make(pr, [blk("t", "todo", "b:P", "a0", { text: "t" })]);
      step(s, () => cmd.setChecked(s, "t", true));
      expect(s.blocks.get("t")!.props).toEqual({ checked: true });
      expect(cmd.setChecked(s, "t", true)).toBeUndefined();
    });
  });

  describe("Einfügen", () => {
    it("eine Zeile Markdown: formatiert an der Schreibmarke", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "ab" })]);
      expect(step(s, () => cmd.insertContent(s, { blockId: "a", from: 1, to: 1 }, { text: "**x**" }))).toEqual({ blockId: "a", offset: 2 });
      expect(s.blocks.get("a")!.text).toEqual([{ t: "a" }, bold("x"), { t: "b" }]);
    });

    it("mehrere Blöcke: teilen, erster Absatz an den Text davor, Rest an den letzten", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0", { text: "startEND" })]);
      const f = step(s, () => cmd.insertContent(s, { blockId: "a", from: 5, to: 5 }, { text: "one\n# Two\n- three" }));
      expect(outline(s)).toEqual(["text: startone", "heading1: Two", "bulletedList: threeEND"]);
      expect(f).toMatchObject({ offset: 5 });
    });

    it("in einen leeren Textblock: der wird ersetzt", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0"), blk("z", "text", "b:P", "a1", { text: "z" })]);
      step(s, () => cmd.insertContent(s, { blockId: "a", from: 0, to: 0 }, { text: "- x\n- y" }));
      expect(outline(s)).toEqual(["bulletedList: x", "bulletedList: y", "text: z"]);
      expect(s.blocks.has("a")).toBe(false);
    });

    it("Notion-HTML: Überschrift, To-do, Toggle mit Kind, Farbe, Code mit Sprache, Seitenlink als Erwähnung", () => {
      const s = make(pr, [blk("a", "text", "b:P", "a0")]);
      const html = `<meta charset="utf-8"><h2>Plan</h2>
        <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div><span class="to-do-children-checked">Done</span></li></ul>
        <details><summary>More</summary><p>inside</p></details>
        <p class="block-color-red_background">Red</p>
        <pre><code class="language-swift">let x = 1</code></pre>
        <p>See <a href="https://www.notion.so/Page-0123456789abcdef0123456789abcdef">Page</a></p>`;
      const target = "01234567-89ab-cdef-0123-456789abcdef";
      step(s, () => cmd.insertContent(s, { blockId: "a", from: 0, to: 0 }, { html, text: "Plan" }, { pageExists: (id) => id === target }));
      const out = outline(s);
      expect(out[0]).toBe("heading2: Plan");
      expect(out.some((l) => l.startsWith("todo"))).toBe(true);
      expect(out).toContain("toggle: More");
      expect(out).toContain("  text: inside");
      const code = [...s.blocks.values()].find((b) => b.type === "code")!;
      expect(code.props?.language).toBe("swift");
      expect(code.text).toBe("let x = 1");
      const red = [...s.blocks.values()].find((b) => plainText(b.text) === "Red")!;
      expect(red.props?.color).toBe("redBackground");
      const see = [...s.blocks.values()].find((b) => plainText(b.text).startsWith("See"))!;
      expect(JSON.stringify(see.text)).toContain(target);
    });

    it("im Code-Block nur Klartext; ⇧⌘V mehrzeilig: ein Absatz je Zeile", () => {
      const s = make(pr, [blk("c", "code", "b:P", "a0", { text: "x" }), blk("a", "text", "b:P", "a1", { text: "ab" })]);
      step(s, () => cmd.insertContent(s, { blockId: "c", from: 1, to: 1 }, { html: "<b>y</b>", text: "**y**" }));
      expect(s.blocks.get("c")!.text).toBe("x**y**");
      step(s, () => cmd.insertContent(s, { blockId: "a", from: 1, to: 1 }, { text: "# 1\n2", plainOnly: true }));
      expect(outline(s).slice(1)).toEqual(["text: a# 1", "text: 2b"]);
    });

    it("Based-intern: Kopieren und Einfügen mit Datenbank, auch nach dem Löschen des Originals", () => {
      const s = make(pr, [
        blk("a", "toggle", "b:P", "a0", { text: "T", props: { isOpen: true } }), blk("ak", "text", "b:a", "a0", { text: [bold("k")] }),
        blk("D", "databaseInline", "b:P", "a1", { props: { databaseID: "db1", viewIDs: ["v1"] } }), db("db1", "D"), view("v1", "D", "db1"),
        blk("r1", "page", "d:db1", "a0", { text: "row" }),
        blk("x", "text", "b:P", "a2"),
      ]);
      const clip = cmd.copyBlocks(s, ["ak", "a", "D"]);
      expect(clip.roots).toEqual(["a", "D"]);
      expect(cmd.isBasedClipboard(JSON.parse(JSON.stringify(clip)))).toBe(true);
      step(s, () => cmd.insertContent(s, { blockId: "x", from: 0, to: 0 }, { based: clip, text: "T" }));
      expect(outline(s)).toEqual(["toggle[open]: T", "  text: k", "databaseInline: ", "toggle[open]: T", "  text: k", "databaseInline: "]);
      // Original weg (z. B. anderer Workspace): aus den Records der Zwischenablage.
      cmd.deleteBlocks(s, ["a", "D"]);
      const s2 = make(pr, [blk("y", "text", "b:P", "a0", { text: "y" })]);
      step(s2, () => cmd.insertContent(s2, { blockId: "y", from: 1, to: 1 }, { based: JSON.parse(JSON.stringify(clip)) }));
      expect(outline(s2)).toEqual(["text: y", "toggle[open]: T", "  text: k", "databaseInline: "]);
      const D2 = s2.blocks.get(s2.children("b:P")[2]!)!;
      expect(D2.id).not.toBe("D");
      const db2 = s2.databases.get(D2.props!.databaseID!)!;
      expect(db2.blockID).toBe(D2.id);
      expect(db2.properties.map((p) => p.name)).toEqual(["Name", "Status"]);
      expect(s2.children("d:" + db2.id)).toHaveLength(1);
      expect([...s2.views.values()].filter((v) => v.blockID === D2.id)).toHaveLength(1);
    });
  });

  it("sichtbare Reihenfolge und Nachbarn (Pfeiltasten)", () => {
    const s = make(pr, [
      blk("a", "text", "b:P", "a0"), blk("t", "toggle", "b:P", "a1"), blk("tk", "text", "b:t", "a0"),
      blk("L", "columnList", "b:P", "a2"), blk("c1", "column", "b:L", "a0"), blk("x", "text", "b:c1", "a0"), blk("c2", "column", "b:L", "a1"), blk("y", "text", "b:c2", "a0"),
      blk("z", "text", "b:P", "a3"),
    ]);
    expect(cmd.visibleOrder(s, "P")).toEqual(["a", "t", "L", "c1", "x", "c2", "y", "z"]);
    expect(cmd.nextVisible(s, "t")).toBe("L");
    expect(cmd.previousVisible(s, "z")).toBe("y");
    expect(cmd.nextVisible(s, "x")).toBeUndefined();
  });
});
