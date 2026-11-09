// @vitest-environment jsdom
// BSD-10: Gleichungen im Text – Einfügen an der Schreibmarke (Slash-Eintrag „Inline equation“) und Ändern des
// Ausdrucks landen als Lauf mit `eq` im Store; ein Block `equation` speichert `expression`.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { MemoryPersistence, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { insertInlineEquation } from "../src/index.js";
import { INLINE } from "../src/mapping/bn.js";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { DocSession } from "../src/yjs/session.js";

const T = 800_000_000;
const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: T, updatedAt: T, ...extra } as Block });

const mounted: BasedEditor[] = [];
afterEach(() => {
  for (const e of mounted.splice(0)) e.unmount();
});

function setup() {
  let t = T;
  const store = new WorkspaceStore({
    persistence: new MemoryPersistence([blk("p", "page", "w", "a0", { text: "Seite" }), blk("a", "text", "b:p", "a0", { text: "Fläche " }),
      blk("e", "equation", "b:p", "a1", { props: { expression: "a^2" } })]),
    node: "t",
    now: () => (t += 1),
  });
  const session = new DocSession(store, "p", { converter: createConverter(), debounceMs: 0 });
  const editor = BlockNoteEditor.create(withCollaboration({
    schema: basedSchema(),
    collaboration: { fragment: session.fragment, user: { name: "t", color: "var(--muted)" } },
  })) as unknown as BasedEditor;
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  mounted.push(editor);
  return { store, session, editor };
}

describe("Gleichungen", () => {
  it("Inline-Gleichung an der Schreibmarke einfügen und ändern", () => {
    const { store, session, editor } = setup();
    editor.setTextCursorPosition("a", "end");
    insertInlineEquation(editor, "\\pi r^2");
    session.flush();
    expect(store.blocks.get("a")?.text).toEqual([{ t: "Fläche " }, { eq: "\\pi r^2" }]);

    // wie updateInlineContent im Eingabefeld: Ausdruck ersetzen
    const block = editor.getBlock("a")!;
    const content = (block.content as { type: string; props?: Record<string, string> }[]).map((c) =>
      c.type === INLINE.equation ? { ...c, props: { ...c.props, expression: "\\pi r^2 h" } } : c);
    editor.updateBlock("a", { content } as never);
    session.flush();
    expect(store.blocks.get("a")?.text).toEqual([{ t: "Fläche " }, { eq: "\\pi r^2 h" }]);
    session.close();
  });

  it("leere Inline-Gleichung (Slash-Eintrag) wird als leerer Ausdruck gespeichert", () => {
    const { store, session, editor } = setup();
    editor.setTextCursorPosition("a", "end");
    insertInlineEquation(editor);
    session.flush();
    expect(store.blocks.get("a")?.text).toEqual([{ t: "Fläche " }, { eq: "" }]);
    session.close();
  });

  it("Block-Gleichung: Ausdruck ändern", () => {
    const { store, session, editor } = setup();
    editor.updateBlock("e", { props: { expression: "\\sqrt{x}" } } as never);
    session.flush();
    expect(store.blocks.get("e")?.props?.expression).toBe("\\sqrt{x}");
    session.close();
  });
});
