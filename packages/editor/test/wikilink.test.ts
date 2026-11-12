// @vitest-environment jsdom
// BSD-90 Teil 2: „[[Titel]]“ beim Tippen erkennen (das zweite „]“ löst aus).
import { describe, expect, it } from "vitest";
import { wikilinkBefore } from "../src/ui/mentions.js";

describe("[[Wikilinks]] beim Tippen", () => {
  it("erkennt [[Titel] am Ende, nicht ohne Titel, nicht über Klammern hinweg", () => {
    expect(wikilinkBefore("See [[Launch plan]")).toBe("Launch plan");
    expect(wikilinkBefore("[[ Spaces ]")).toBe("Spaces");
    expect(wikilinkBefore("[[]")).toBeUndefined();
    expect(wikilinkBefore("[[a]b]")).toBeUndefined();
    expect(wikilinkBefore("plain text]")).toBeUndefined();
    expect(wikilinkBefore("[[Done]] and more]")).toBeUndefined();
  });
});

// BSD-321: Suche/Anlegen sind asynchron. Wer weitertippt, bekommt die Erwähnung trotzdem dorthin, wo „[[Titel]]“ stand.
describe("[[Wikilinks]] asynchron aufgelöst", () => {
  it("Erwähnung landet an der gemerkten Stelle, nicht an der inzwischen gewanderten Schreibmarke", async () => {
    const { BlockNoteEditor } = await import("@blocknote/core");
    const { basedSchema } = await import("../src/schema/schema.js");
    const { resolveWikilink } = await import("../src/ui/mentions.js");
    const editor = BlockNoteEditor.create({ schema: basedSchema(), initialContent: [{ id: "a", type: "paragraph", content: "Today: " }] } as never) as never as import("../src/schema/schema.js").BasedEditor;
    const div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    try {
      editor.setTextCursorPosition("a", "end");
      const at = editor.prosemirrorState.selection.from;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const pages = {
        get: () => undefined, subscribe: () => () => {},
        search: async () => { await gate; return [{ id: "p1", title: "Launch plan" }]; },
      };
      const done = resolveWikilink(editor, "Launch plan", { pages: pages as never, selfID: "self" }, at);
      // weitergetippt, während die Suche läuft
      editor.insertInlineContent([" and [[Brand"] as never, { updateSelection: true });
      release();
      expect(await done).toBe("linked");
      const content = editor.getBlock("a")!.content as Array<{ type: string; text?: string; props?: Record<string, string> }>;
      const flat = content.map((c) => (c.type === "text" ? c.text : `<${c.props?.value}>`)).join("");
      expect(flat).toBe("Today: <p1> and [[Brand");
    } finally {
      editor.unmount();
    }
  });
});
