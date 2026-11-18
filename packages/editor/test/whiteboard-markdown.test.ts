// Markdown auf dem Board: Setzen (ohne Canvas, feste Zeichenbreite), Aufgaben per Klick abhaken.
import { describe, expect, it } from "vitest";
import { boardObjectFromBlock, boardObjectToBlock, createBoardPage, MemoryPersistence, parseWBObject, WorkspaceStore, type WBObject, type WBShape } from "@based/core";
import { BoardController } from "../src/whiteboard/controller.js";
import { boardTaskAt, layoutMarkdown, textFieldOf, type MdBase } from "../src/whiteboard/markdown.js";
import { BoardSession } from "../src/whiteboard/session.js";

// Jedes Zeichen ist halb so breit wie die Schrift hoch (Größe aus dem Font-String).
const measure = (font: string, s: string) => s.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]) * 0.5;
const base: MdBase = { size: 10, weight: 400, lineHeight: 1.5, font: "sans", mono: "mono" };

describe("layoutMarkdown", () => {
  it("schlichter Text: eine Zeile, Höhe = Größe × Zeilenhöhe", () => {
    const l = layoutMarkdown(measure, "hallo", 200, base);
    expect(l.lines).toHaveLength(1);
    expect(l.height).toBe(15);
    expect(l.lines[0]!.frags).toMatchObject([{ x: 0, text: "hallo", w: 25 }]);
  });
  it("fett und kursiv bekommen eigene Schriften, Code die Mono-Schrift", () => {
    const [line] = layoutMarkdown(measure, "a **b** *c* `d`", 400, base).lines;
    expect(line!.frags.map((f) => [f.text, f.font])).toEqual([
      ["a ", "400 10px sans"], ["b", "700 10px sans"], [" ", "400 10px sans"], ["c", "italic 400 10px sans"], [" ", "400 10px sans"], ["d", "400 8.8px mono"],
    ]);
  });
  it("bricht um und rückt Folgezeilen eines Listenpunkts ein", () => {
    const l = layoutMarkdown(measure, "- eins zwei drei vier", 60, base);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines[0]!.deco).toMatchObject({ kind: "bullet" });
    expect(l.lines[1]!.deco).toBeUndefined();
    expect(l.lines.every((x) => x.frags[0]!.x === 12.5)).toBe(true);
  });
  it("Überschriften sind größer, Aufgaben haben ein Kästchen, erledigte sind gedämpft", () => {
    const l = layoutMarkdown(measure, "# Titel\n- [ ] offen\n- [x] fertig", 400, base);
    expect(l.lines[0]!.frags[0]!.size).toBe(15);
    expect(l.lines[1]!.deco).toMatchObject({ kind: "check", checked: false });
    expect(l.lines[2]).toMatchObject({ muted: true, source: 2, deco: { kind: "check", checked: true } });
    expect(l.lines[2]!.frags[0]!.run.strike).toBe(true);
  });
  it("Codeblock: eine Zeile je Quellzeile, Auszeichnung bleibt Text", () => {
    const l = layoutMarkdown(measure, "```\n**x**\ny\n```", 400, base);
    expect(l.lines.map((x) => x.frags[0]?.text)).toEqual(["**x**", "y"]);
    expect(l.lines.map((x) => x.deco)).toEqual([{ kind: "code", first: true, last: false }, { kind: "code", first: false, last: true }]);
  });
});

function setup(objs: WBObject[]) {
  let t = 1000;
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => t++ });
  const page = createBoardPage(store, { title: "Board" });
  store.transact("seed", (tx) => { for (const o of objs) tx.put({ kind: "block", data: boardObjectToBlock(o, page, store.now()) }); });
  const session = new BoardSession(store, page);
  const ctl = new BoardController(session, { newID: () => "n", camera: { x: 0, y: 0, zoom: 1 }, taskAt: boardTaskAt });
  ctl.setViewport({ w: 800, h: 600 });
  const text = (id: string) => (boardObjectFromBlock(store.blocks.get(id)!) as WBShape).text;
  return { ctl, text };
}

describe("Aufgaben auf dem Board", () => {
  it("Klick auf das Kästchen hakt ab und wieder auf, Klick auf den Text wählt nur", () => {
    const n = parseWBObject({ id: "a", kind: "note", x: 0, y: 0, w: 220, h: 160, z: "a0", text: "- [ ] Milch\n- [ ] Brot" })!;
    const { ctl, text } = setup([n]);
    const f = textFieldOf(n as WBShape)!;
    // erstes Kästchen: links im Textfeld, Mitte der ersten Zeile (15 × 1.4 hoch)
    const box = { x: f.box.x + 6, y: f.box.y + 10.5 };
    ctl.pointerDown({ x: box.x, y: box.y, button: 0 }); ctl.pointerUp({ x: box.x, y: box.y });
    expect(text("a")).toBe("- [x] Milch\n- [ ] Brot");
    expect(ctl.cursorAt(box)).toBe("pointer");
    ctl.pointerDown({ x: box.x, y: box.y, button: 0 }); ctl.pointerUp({ x: box.x, y: box.y });
    expect(text("a")).toBe("- [ ] Milch\n- [ ] Brot");
    // zweite Zeile
    ctl.pointerDown({ x: box.x, y: box.y + 21, button: 0 }); ctl.pointerUp({ x: box.x, y: box.y + 21 });
    expect(text("a")).toBe("- [ ] Milch\n- [x] Brot");
    // Text daneben: wählt, ändert nichts
    ctl.pointerDown({ x: f.box.x + 120, y: box.y, button: 0 }); ctl.pointerUp({ x: f.box.x + 120, y: box.y });
    expect(text("a")).toBe("- [ ] Milch\n- [x] Brot");
    expect([...ctl.selection]).toEqual(["a"]);
  });
  it("festgesteckte Objekte bleiben unverändert", () => {
    const n = parseWBObject({ id: "a", kind: "note", x: 0, y: 0, w: 220, h: 160, z: "a0", text: "- [ ] x", style: { pin: true } })!;
    const { ctl, text } = setup([n]);
    const f = textFieldOf(n as WBShape)!;
    ctl.pointerDown({ x: f.box.x + 6, y: f.box.y + 10.5, button: 0 }); ctl.pointerUp({ x: f.box.x + 6, y: f.box.y + 10.5 });
    expect(text("a")).toBe("- [ ] x");
  });
});
