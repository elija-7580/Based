// @vitest-environment jsdom
// BSD-207: Duplicate und Turn into im Blockmenü – auf einem echten Editor mit Store dahinter.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { CUSTOM } from "../src/mapping/bn.js";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { singleURL } from "../src/ui/paste.js";
import { applyURLChoice, blocksAsMarkdown, canTurnInto, duplicateBlocks, isDuplicable, moveBlocksToPage, moveTargetAllowed, rangeIDs, stepRange, toggleAll, type SelectionEditor, TURN_INTO, turnInto, turnIntoPage, type ActionEditor } from "../src/ui/blockActions.js";
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
      blk("q", "page", "w", "a1", { text: "Ziel" }),
      blk("q1", "text", "b:q", "a5", { text: "Schon da" }),
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

  it("Unterseiten (eigene Records) werden nicht flach kopiert, sondern dem Store zum tiefen Kopieren gemeldet", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const sub = a.getBlock("sub")!;
    expect(sub.type).toBe(CUSTOM.page);
    expect(isDuplicable(sub)).toBe(false);
    const r = duplicateBlocks(a, [a.getBlock("a")!, sub]);
    expect(r).toMatchObject({ skipped: 0, records: ["sub"] });
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

  it("Turn into → Page: Text wird Titel, Kinder werden Inhalt der Unterseite, an derselben Stelle", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const pageID = turnIntoPage(a, session, "b")!;
    expect(pageID).toBeTruthy();
    session.flush();
    const page = s.blocks.get(pageID)!;
    expect(page.type).toBe("page");
    expect(page.text).toBe("Zwei");
    expect(page.parent).toBe("b:p");
    expect(s.children("b:" + pageID)).toEqual(["c"]);
    expect(s.blocks.get("b")).toBeUndefined();
    expect(s.children("b:p").filter((id) => !s.blocks.get(id)?.trashedAt)).toEqual(["a", pageID, "sub"]);
    expect(a.getBlock(pageID)?.type).toBe(CUSTOM.page);
    // Keine Seite aus einer Unterseite oder Nicht-Text
    expect(turnIntoPage(a, session, "sub")).toBeUndefined();
  });

  it("Move to: Block mit Kindern ans Ende der Zielseite; Undo im Editor holt ihn zurück", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const target = new DocSession(s, "q", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    expect(moveBlocksToPage(a, session, ["b"], "q")).toBe(1);
    session.flush();
    expect(s.blocks.get("b")?.parent).toBe("b:q");
    expect(s.children("b:q")).toEqual(["q1", "b"]);
    expect(s.blocks.get("c")?.parent).toBe("b:b");
    expect(a.getBlock("b")).toBeUndefined();
    // Die offene Sitzung der Zielseite zieht nach
    expect(target.blocks().map((b) => b.id)).toEqual(["q1", "b"]);
    // Sortierschlüssel von außen (Replik kennt die Zielseite nicht): landet dahinter
    expect(moveBlocksToPage(a, session, ["a"], "q", "a9")).toBe(1);
    expect(s.blocks.get("a")!.sk > "a9").toBe(true);
    (ed as unknown as { undo(): void }).undo();
    await tick();
    session.flush();
    expect(s.blocks.get("a")?.parent).toBe("b:p");
    expect(a.getBlock("a")).toBeDefined();
    target.close();
  });

  it("Move to lehnt die eigene Seite und eine bewegte Unterseite als Ziel ab", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    expect(moveBlocksToPage(a, session, ["a"], "p")).toBe(0);
    expect(moveBlocksToPage(a, session, ["sub"], "sub")).toBe(0);
    expect(moveTargetAllowed("database", "x", "p", [])).toBe(false);
    expect(moveTargetAllowed("page", "p", "p", [])).toBe(false);
    expect(moveTargetAllowed("page", "sub", "p", ["sub"])).toBe(false);
    expect(moveTargetAllowed("row", "r", "p", ["a"])).toBe(true);
  });

  it("toggleAll: ist einer zu, gehen alle auf; sonst alle zu", () => {
    const root = document.createElement("div");
    const states = [true, false, true];
    for (const open of states) {
      const b = document.createElement("button");
      b.className = "bn-toggle-button";
      b.setAttribute("aria-expanded", String(open));
      b.addEventListener("click", () => b.setAttribute("aria-expanded", String(b.getAttribute("aria-expanded") !== "true")));
      root.appendChild(b);
    }
    const all = () => [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-expanded"));
    expect(toggleAll(root)).toBe("opened");
    expect(all()).toEqual(["true", "true", "true"]);
    expect(toggleAll(root)).toBe("closed");
    expect(all()).toEqual(["false", "false", "false"]);
    expect(toggleAll(document.createElement("div"))).toBe("none");
  });

  it("Blockauswahl: ↑/↓ in Lese-Reihenfolge, ⇧ erweitert unter Geschwistern", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const e = ed as unknown as SelectionEditor;
    let r = { anchor: "a", head: "a" };
    r = stepRange(e, r, 1, false);
    expect(r).toEqual({ anchor: "b", head: "b" });
    r = stepRange(e, r, 1, false); // ins Kind hinein
    expect(r).toEqual({ anchor: "c", head: "c" });
    r = stepRange(e, r, -1, false);
    expect(r.head).toBe("b");
    r = stepRange(e, r, 1, true); // ⇧↓: nächstes Geschwister (Unterseite), nicht das Kind
    expect(rangeIDs(e, r)).toEqual(["b", "sub"]);
    r = stepRange(e, r, 1, true); // am Rand bleibt es
    expect(rangeIDs(e, r)).toEqual(["b", "sub"]);
    r = stepRange(e, { anchor: "sub", head: "sub" }, -1, true);
    r = stepRange(e, r, -1, true);
    expect(rangeIDs(e, r)).toEqual(["a", "b", "sub"]);
    expect(rangeIDs(e, { anchor: "weg", head: "a" })).toEqual([]);
  });

  it("Copy as Markdown nutzt den Exporter des Kerns, mit Kindern", async () => {
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    mount(session);
    await tick();
    expect(blocksAsMarkdown(session, ["a", "b"])).toBe("Eins\n\n- Zwei\n    Kind");
  });

  it("URL einfügen: nur nackte http(s)-Adressen; Bookmark ersetzt den Absatz", async () => {
    expect(singleURL(" https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(singleURL("see https://example.com")).toBeUndefined();
    expect(singleURL("javascript:alert(1)")).toBeUndefined();
    expect(singleURL("ftp://x")).toBeUndefined();
    const s = store();
    const session = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(session);
    await tick();
    const a = ed as unknown as ActionEditor;
    const [p] = (ed as unknown as { insertBlocks(b: unknown[], r: string, w: string): { id: string }[] }).insertBlocks(
      [{ type: "paragraph", content: [{ type: "link", href: "https://example.com", content: "https://example.com" }] }], "a", "after");
    expect(applyURLChoice(a, p!.id, "https://example.com", "link")).toBe(false);
    expect(applyURLChoice(a, "a", "https://example.com", "bookmark")).toBe(false); // anderer Text
    expect(applyURLChoice(a, p!.id, "https://example.com", "bookmark")).toBe(true);
    session.flush();
    const rec = [...s.blocks.values()].find((b) => b.type === "bookmark" || b.type === "embed");
    expect(rec).toBeDefined();
  });
});
