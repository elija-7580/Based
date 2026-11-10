// @vitest-environment jsdom
// BSD-154: DocSession – Migration, Editor → Store, Store → Editor, lokales Undo über den Yjs-UndoManager.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { projectDoc } from "../src/mapping/blocks.js";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { DocSession, MemoryYDocStore } from "../src/yjs/session.js";
import { corpusStore } from "./helpers.js";

const converter = createConverter();
const T = 800_000_000;
const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: T, updatedAt: T, ...extra } as Block });

function smallStore(extra: WireRecord[] = []) {
  let t = T;
  return new WorkspaceStore({
    persistence: new MemoryPersistence([
      blk("p", "page", "w", "a0", { text: "Seite" }),
      blk("a", "text", "b:p", "a0", { text: "Alpha", future: { kept: true }, props: { glow: 1 } }),
      blk("b", "text", "b:p", "a1", { text: "Beta" }),
      blk("c", "toggle", "b:p", "a2", { text: "Toggle" }),
      blk("sub", "page", "b:c", "a0", { text: "Unterseite" }),
      blk("sub-kid", "text", "b:sub", "a0", { text: "in der Unterseite" }),
      ...extra,
    ]),
    node: "t",
    now: () => (t += 1),
  });
}

const mounted: BlockNoteEditor<never, never, never>[] = [];
function mount(session: DocSession): BasedEditor {
  const editor = BlockNoteEditor.create(withCollaboration({
    schema: basedSchema(),
    collaboration: { fragment: session.fragment, user: { name: "t", color: "var(--muted)" } },
  })) as unknown as BasedEditor;
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  mounted.push(editor as never);
  return editor;
}
afterEach(() => {
  for (const e of mounted.splice(0)) e.unmount();
});

const text = (store: WorkspaceStore, id: string) => plainText(store.blocks.get(id)?.text);

describe("DocSession", () => {
  it("leere Seiten: der erste Absatz hat je Seite eine eigene ID (nie BlockNotes feste `initialBlockId`)", async () => {
    const store = smallStore([blk("e1", "page", "w", "a5", { text: "Leer 1" }), blk("e2", "page", "w", "a6", { text: "Leer 2" })]);
    const rev = store.revision;
    const s1 = new DocSession(store, "e1", { converter, debounceMs: 0 });
    const s2 = new DocSession(store, "e2", { converter, debounceMs: 0 });
    const ed1 = mount(s1);
    const ed2 = mount(s2);
    await new Promise((r) => setTimeout(r, 20)); // y-prosemirror übernimmt den Y-Stand nach dem Einhängen
    const id1 = ed1.document[0]!.id;
    const id2 = ed2.document[0]!.id;
    expect(ed1.document).toHaveLength(1);
    expect(id1).not.toBe("initialBlockId");
    expect(id2).not.toBe("initialBlockId");
    expect(id1).not.toBe(id2);
    expect(store.revision).toBe(rev); // der leere Absatz ist noch kein Record
    ed1.updateBlock(id1, { content: "erste Seite" });
    ed2.updateBlock(id2, { content: "zweite Seite" });
    s1.flush();
    s2.flush();
    expect(store.children("b:e1").map((id) => text(store, id))).toEqual(["erste Seite"]);
    expect(store.children("b:e2").map((id) => text(store, id))).toEqual(["zweite Seite"]);
    s1.close();
    s2.close();
  });


  it("Migration: erstes Öffnen übernimmt die Records, ohne zu schreiben", () => {
    const store = corpusStore();
    const rev = store.revision;
    const docs = new MemoryYDocStore();
    const s = new DocSession(store, "p-root", { converter, docStore: docs, debounceMs: 0 });
    expect(converter.fromFragment(s.fragment).map((b) => b.id)).toEqual(projectDoc(store, "p-root").map((b) => b.id));
    expect(store.revision).toBe(rev);
    expect(docs.load("p-root")).toBeDefined();
    s.close();
    expect(store.revision).toBe(rev);
  });

  it("Editor → Store: Text ändern, unbekannte Felder bleiben", () => {
    const store = smallStore();
    const s = new DocSession(store, "p", { converter, debounceMs: 0 });
    const ed = mount(s);
    ed.updateBlock("a", { content: [{ type: "text", text: "Alpha fett", styles: { bold: true } }] } as never);
    const a = store.blocks.get("a")! as Block & { future?: unknown };
    expect(a.text).toEqual([{ t: "Alpha fett", m: { b: true } }]);
    expect(a.future).toEqual({ kept: true });
    expect(a.props).toEqual({ glow: 1 });
    // Typwechsel behält fremde Props
    ed.updateBlock("a", { type: "heading", props: { level: 2 } } as never);
    expect(store.blocks.get("a")!.type).toBe("heading2");
    expect(store.blocks.get("a")!.props).toEqual({ glow: 1 });
    s.close();
  });

  it("Editor → Store: neue Blöcke, Reihenfolge, Löschen; Unterseiten kommen in den Papierkorb", () => {
    const store = smallStore();
    const s = new DocSession(store, "p", { converter, debounceMs: 0 });
    const ed = mount(s);
    ed.insertBlocks([{ id: "n", type: "paragraph", content: "Neu" } as never], "a", "after");
    const n = store.blocks.get("n")!;
    expect(n.parent).toBe("b:p");
    expect(n.sk > "a0" && n.sk < "a1").toBe(true);
    expect(store.blocks.get("a")!.sk).toBe("a0");
    // Toggle mit Unterseite löschen: Toggle weg, Unterseite im Papierkorb, deren Inhalt bleibt
    ed.removeBlocks(["c"]);
    expect(store.blocks.has("c")).toBe(false);
    expect(store.blocks.get("sub")!.trashedAt).toBeDefined();
    expect(store.blocks.get("sub")!.parent).toBe("b:p");
    expect(text(store, "sub-kid")).toBe("in der Unterseite");
    s.close();
  });

  it("Store → Editor: Änderungen von außen landen im Y.Doc", () => {
    const store = smallStore();
    const s = new DocSession(store, "p", { converter, debounceMs: 0 });
    const ed = mount(s);
    store.setText("b", "Beta von außen");
    expect(ed.getBlock("b")!.content).toEqual([{ type: "text", text: "Beta von außen", styles: {} }]);
    store.transact("neu", (tx) => tx.put(blk("x", "todo", "b:p", "a3", { text: "Remote", props: { checked: true } })));
    const x = ed.getBlock("x")!;
    expect(x.type).toBe("checkListItem");
    expect((x.props as { checked: boolean }).checked).toBe(true);
    store.deleteBlocks(["a"]);
    expect(ed.getBlock("a")).toBeUndefined();
    s.close();
  });

  it("Undo nimmt nur lokale Änderungen zurück, nie Änderungen von außen", () => {
    const store = smallStore();
    const s = new DocSession(store, "p", { converter, debounceMs: 0 });
    const ed = mount(s);
    ed.updateBlock("a", { content: "Alpha lokal" } as never);
    store.setText("b", "Beta remote");
    expect(text(store, "a")).toBe("Alpha lokal");
    ed.undo();
    expect(text(store, "a")).toBe("Alpha");
    expect(text(store, "b")).toBe("Beta remote");
    expect(plainText((ed.getBlock("b")!.content as { text: string }[]).map((c) => ({ t: c.text })))).toBe("Beta remote");
    ed.redo();
    expect(text(store, "a")).toBe("Alpha lokal");
    // Undo eines Remote-Blocks gibt es nicht: nur der eigene Schritt
    ed.undo();
    ed.undo();
    expect(text(store, "b")).toBe("Beta remote");
    s.close();
  });

  it("ausstehende lokale Änderungen und eine Änderung von außen überleben beide", () => {
    const store = smallStore();
    const s = new DocSession(store, "p", { converter, debounceMs: 10_000 });
    const ed = mount(s);
    ed.updateBlock("a", { content: "Alpha lokal" } as never);
    expect(text(store, "a")).toBe("Alpha"); // noch gesammelt
    store.transact("remote", (tx) => tx.put(blk("r", "text", "b:p", "a5", { text: "Remote neu" })));
    store.setText("b", "Beta remote");
    expect(text(store, "a")).toBe("Alpha lokal");
    expect(text(store, "b")).toBe("Beta remote");
    expect(ed.getBlock("r")).toBeDefined();
    expect(ed.document.map((b) => b.id).slice(0, 4)).toEqual(["a", "b", "c", "r"]);
    s.close();
  });

  it("gespeicherter Y-Zustand + Änderungen ohne offenen Editor", () => {
    const store = smallStore();
    const docs = new MemoryYDocStore();
    const s1 = new DocSession(store, "p", { converter, docStore: docs, debounceMs: 0 });
    const ed = mount(s1);
    ed.updateBlock("b", { content: "Beta 2" } as never);
    s1.close();
    store.setText("a", "Alpha geschlossen");
    const s2 = new DocSession(store, "p", { converter, docStore: docs, debounceMs: 0 });
    const blocks = converter.fromFragment(s2.fragment);
    expect(blocks.map((b) => (b.content as { text: string }[] | undefined)?.[0]?.text)).toEqual(["Alpha geschlossen", "Beta 2", "Toggle"]);
    s2.close();
  });

  it("der leere Absatz am Ende wird kein Record", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence([blk("e", "page", "w", "a0")]), node: "t" });
    const s = new DocSession(store, "e", { converter, debounceMs: 0 });
    const ed = mount(s);
    expect(ed.document.length).toBeGreaterThan(0);
    expect(store.children("b:e")).toEqual([]);
    ed.updateBlock(ed.document[0]!.id, { content: "Jetzt" } as never);
    expect(store.children("b:e").map((id) => text(store, id))).toEqual(["Jetzt"]);
    s.close();
  });
});
