// @vitest-environment jsdom
// BSD-249: Ziehen zum Verschachteln, Ausrücken und für Spalten – auf einem echten Editor mit Store dahinter.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { applyDrop, dropZone, type DropEditor, type DropTarget } from "../src/ui/dragDrop.js";
import { DocSession } from "../src/yjs/session.js";

const converter = createConverter();
const T = 800_000_000;
const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: T, updatedAt: T, ...extra } as Block });

function store() {
  let t = T;
  return new WorkspaceStore({
    persistence: new MemoryPersistence([
      blk("p", "page", "w", "a0", { text: "Seite" }),
      blk("a", "text", "b:p", "a0", { text: "Eins" }),
      blk("b", "bulletedList", "b:p", "a1", { text: "Zwei" }),
      blk("c", "text", "b:b", "a0", { text: "Kind" }),
      blk("sub", "page", "b:p", "a2", { text: "Unterseite" }),
      blk("d", "todo", "b:p", "a3", { text: "Vier" }),
    ]),
    node: "t", now: () => (t += 1),
  });
}

const mounted: BasedEditor[] = [];
function mount(session: DocSession): BasedEditor {
  const editor = BlockNoteEditor.create(withCollaboration({
    schema: basedSchema(),
    collaboration: { fragment: session.fragment, user: { name: "t", color: "var(--muted)" } },
  })) as unknown as BasedEditor;
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  mounted.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of mounted.splice(0)) e.unmount();
});
const tick = () => new Promise((r) => setTimeout(r, 20));


const kids = (s: WorkspaceStore, parent: string) => s.children(parent).filter((id) => !s.blocks.get(id)?.trashedAt);
const text = (s: WorkspaceStore, id: string) => plainText(s.blocks.get(id)?.text);

describe("Zone beim Ziehen", () => {
  const t = (levels: DropTarget["levels"], extra: Partial<DropTarget> = {}): DropTarget =>
    ({ id: levels[0]!.id, rect: { left: levels[0]!.left, right: 700, top: 100, bottom: 130 }, levels, inColumn: false, noChildren: false, ...extra });
  it("rechter Rand und links daneben: Spalte; untere Hälfte weiter rechts: hinein; obere Hälfte: davor", () => {
    const x = t([{ id: "a", left: 100, isLast: false }]);
    expect(dropZone(690, 115, x)).toEqual({ kind: "column", side: "right", id: "a" });
    // links: Spalte erst links vom Griff; direkt neben dem Inhalt (Griff-Streifen) wird umsortiert
    expect(dropZone(50, 115, x)).toEqual({ kind: "column", side: "left", id: "a" });
    expect(dropZone(50, 102, x)).toEqual({ kind: "column", side: "left", id: "a" });
    expect(dropZone(50, 128, x)).toEqual({ kind: "column", side: "left", id: "a" });
    expect(dropZone(80, 104, x)).toEqual({ kind: "before", id: "a" });
    expect(dropZone(80, 115, x)).toEqual({ kind: "after", id: "a" });
    expect(dropZone(80, 126, x)).toEqual({ kind: "after", id: "a" });
    // rechts: über die ganze Höhe, auch im Rand neben dem Block
    expect(dropZone(690, 101, x)).toEqual({ kind: "column", side: "right", id: "a" });
    expect(dropZone(690, 129, x)).toEqual({ kind: "column", side: "right", id: "a" });
    expect(dropZone(740, 115, x)).toEqual({ kind: "column", side: "right", id: "a" });
    // in einer Spalte: links direkt neben dem Inhalt, nur in der Mitte der Höhe
    expect(dropZone(90, 115, { ...x, inColumn: true })).toEqual({ kind: "column", side: "left", id: "a" });
    expect(dropZone(90, 102, { ...x, inColumn: true })).toEqual({ kind: "before", id: "a" });
    expect(dropZone(160, 126, x)).toEqual({ kind: "nest", id: "a" });
    expect(dropZone(110, 126, x)).toEqual({ kind: "after", id: "a" });
    expect(dropZone(300, 104, x)).toEqual({ kind: "before", id: "a" });
    expect(dropZone(160, 126, { ...x, noChildren: true })).toEqual({ kind: "after", id: "a" });
  });
  it("Ausrücken nur vom letzten Kind aus, so weit der Zeiger links steht", () => {
    const deep = t([{ id: "c", left: 148, isLast: true }, { id: "b", left: 124, isLast: true }, { id: "a", left: 100, isLast: false }]);
    expect(dropZone(126, 126, deep)).toEqual({ kind: "after", id: "b" });
    expect(dropZone(90, 126, deep)).toEqual({ kind: "after", id: "a" });
    const notLast = t([{ id: "c", left: 148, isLast: false }, { id: "b", left: 124, isLast: true }]);
    expect(dropZone(120, 126, notLast)).toEqual({ kind: "after", id: "c" });
    // verschachtelt: keine Spalte
    expect(dropZone(690, 110, deep)).toEqual({ kind: "before", id: "c" });
  });
});

describe("Ablegen", () => {
  it("rechts neben einen Block: Spaltenliste mit zwei Spalten; weitere Spalte; zurückziehen löst sie auf (je ein Undo-Schritt)", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const e = ed as unknown as DropEditor;
    expect(applyDrop(e, ["d"], { kind: "column", side: "right", id: "a" })).toBe(true);
    session.flush();
    const list = kids(s, "b:p")[0]!;
    expect(s.blocks.get(list)?.type).toBe("columnList");
    const cols = kids(s, "b:" + list);
    expect(cols.map((c) => kids(s, "b:" + c))).toEqual([["a"], ["d"]]);
    expect(kids(s, "b:p").slice(1)).toEqual(["b", "sub"]);
    // b (mit Kind) links neben d in dieselbe Liste
    applyDrop(e, ["b"], { kind: "column", side: "left", id: "d" });
    session.flush();
    const cols3 = kids(s, "b:" + list);
    expect(cols3.map((c) => kids(s, "b:" + c))).toEqual([["a"], ["b"], ["d"]]);
    expect(kids(s, "b:b").map((id) => text(s, id))).toEqual(["Kind"]);
    // b und d wieder heraus: die Liste löst sich auf, a steht wieder oben
    applyDrop(e, ["b"], { kind: "after", id: "sub" });
    applyDrop(e, ["d"], { kind: "after", id: "b" });
    session.flush();
    expect(kids(s, "b:p")).toEqual(["a", "sub", "b", "d"]);
    expect(s.blocks.has(list) && !s.blocks.get(list)?.trashedAt).toBe(false);
  });

  it("hinein (als erstes Kind) und Ausrücken hinter den Elternblock; mehrere Blöcke zusammen", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const e = ed as unknown as DropEditor;
    applyDrop(e, ["d"], { kind: "nest", id: "b" });
    session.flush();
    expect(kids(s, "b:b")).toEqual(["d", "c"]);
    applyDrop(e, ["c"], { kind: "after", id: "b" });
    session.flush();
    expect(kids(s, "b:b")).toEqual(["d"]);
    expect(kids(s, "b:p")).toEqual(["a", "b", "c", "sub"]);
    applyDrop(e, ["a", "c"], { kind: "nest", id: "b" });
    session.flush();
    expect(kids(s, "b:b")).toEqual(["a", "c", "d"]);
    // nicht in sich selbst
    expect(applyDrop(e, ["b"], { kind: "nest", id: "a" })).toBe(false);
  });

  it("ein Undo-Schritt macht das Ablegen rückgängig", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    applyDrop(ed as unknown as DropEditor, ["d"], { kind: "column", side: "right", id: "a" });
    session.flush();
    ed.undo();
    session.flush();
    expect(kids(s, "b:p")).toEqual(["a", "b", "sub", "d"]);
  });
});

describe("Auto-Scroll beim Ziehen (BSD-249 Teil 2)", () => {
  it("scrollt nur am Rand, schneller je näher, höchstens 28 px je Schritt", async () => {
    const { edgeScrollStep, EDGE_ZONE } = await import("../src/ui/dragDrop.js");
    expect(edgeScrollStep(400, 0, 800)).toBe(0);
    expect(edgeScrollStep(EDGE_ZONE + 1, 0, 800)).toBe(0);
    expect(edgeScrollStep(EDGE_ZONE - 10, 0, 800)).toBe(-9);
    expect(edgeScrollStep(0, 0, 800)).toBe(-28);
    expect(edgeScrollStep(800 - EDGE_ZONE + 10, 0, 800)).toBe(9);
    expect(edgeScrollStep(900, 0, 800)).toBe(28);
    expect(edgeScrollStep(110, 100, 900)).toBeLessThan(0);
  });
});
