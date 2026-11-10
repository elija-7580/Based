// @vitest-environment jsdom
// BSD-207: Duplicate und Turn into im Blockmenü – auf einem echten Editor mit Store dahinter.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { CUSTOM } from "../src/mapping/bn.js";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { canTurnInto, duplicateBlocks, isDuplicable, TURN_INTO, turnInto, type ActionEditor } from "../src/ui/blockActions.js";
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

describe("Blockaktionen", () => {
  it("Duplicate kopiert Text und Kinder direkt dahinter, mit neuen IDs, und landet im Store", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const r = duplicateBlocks(a, [a.getBlock("b")!]);
    expect(r.inserted).toHaveLength(1);
    expect(r.skipped).toBe(0);
    session.flush();
    const copyID = r.inserted[0]!;
    expect(copyID).not.toBe("b");
    const copy = s.blocks.get(copyID)!;
    expect(copy.type).toBe("bulletedList");
    expect(plainText(copy.text)).toBe("Zwei");
    const kids = s.children("b:" + copyID).map((id) => plainText(s.blocks.get(id)?.text));
    expect(kids).toEqual(["Kind"]);
    // Reihenfolge: a, b, Kopie, Unterseite
    expect(s.children("b:p").filter((id) => !s.blocks.get(id)?.trashedAt)).toEqual(["a", "b", copyID, "sub"]);
    expect(plainText(s.blocks.get("b")?.text)).toBe("Zwei");
  });

  it("Unterseiten (eigene Records) werden nicht flach kopiert", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const sub = a.getBlock("sub")!;
    expect(sub.type).toBe(CUSTOM.page);
    expect(isDuplicable(sub)).toBe(false);
    const r = duplicateBlocks(a, [a.getBlock("a")!, sub]);
    expect(r).toMatchObject({ skipped: 1 });
    expect(r.inserted).toHaveLength(1);
  });

  it("Turn into wandelt Textblöcke um und behält den Text", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const h2 = TURN_INTO.find((o) => o.key === "h2")!;
    expect(turnInto(a, [a.getBlock("a")!, a.getBlock("sub")!], h2)).toBe(1);
    const callout = TURN_INTO.find((o) => o.key === "callout")!;
    expect(turnInto(a, [a.getBlock("b")!], callout)).toBe(1);
    session.flush();
    expect(s.blocks.get("a")?.type).toBe("heading2");
    expect(plainText(s.blocks.get("a")?.text)).toBe("Eins");
    expect(s.blocks.get("b")?.type).toBe("callout");
    expect(plainText(s.blocks.get("b")?.text)).toBe("Zwei");
    expect(canTurnInto(a.getBlock("sub")!)).toBe(false);
  });
});
