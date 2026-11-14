// „Problem melden“ im Block-Editor (ADR 0016): Blockbaum als Zwischenstand und Endzustand, Transaktionen als
// Block-Records mit Befehlsnamen, Text im Bündel ersetzt (Struktur bleibt), Wiedergabe über Records ergibt denselben
// Baum wie beim Melden – auch nach dem Ersetzen des Texts.
import { describe, expect, it } from "vitest";
import {
  applyBlockChanges, blockCommands as cmd, blockDoc, blockDocOf, buildBugBundle, InputRecorder, isBlockDoc, loadBlockDoc, mapReplaySelection, MemoryPersistence,
  blockAtPath, blockPath, normalizeDoc, observePageChanges, pageBlocks, replayPlan, resolveReplaySelection, WorkspaceStore, type Block, type BugBundle, type RecordedEvent, type WireRecord,
} from "../src/index.js";

const STAMP = { millis: 1, counter: 0, node: "x" };
const blk = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp: STAMP, ...extra } as Block,
});
const store = (...records: WireRecord[]) => new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
const SECRET = "Gehalt von Ada 4711";

const page = () => store(
  blk("P", "page", "w", "a0", { text: "Page" }),
  blk("A", "heading1", "b:P", "a0", { text: "Plan" }),
  blk("B", "bulletedList", "b:P", "a1", { text: SECRET }),
  blk("C", "text", "b:B", "a0", { text: [{ t: "fett", m: { b: true, color: "red" } }] }),
  blk("T", "text", "b:P", "a2", { text: "weg", trashedAt: 5 }),
  blk("O", "text", "b:Q", "a0", { text: "andere Seite" }),
);

/** Wie die Web-Shell: Zwischenstand (Verweise, Baum erst beim Bündeln) und Transaktionen der Seite in den Ringpuffer. */
function recordPage(s: WorkspaceStore, root: string) {
  const rec = new InputRecorder();
  const refs = pageBlocks(s, root);
  rec.record({ kind: "checkpoint", root, doc: () => blockDoc(refs, root), sel: { type: "text", anchor: 0, head: 0, block: "A" } });
  const off = observePageChanges(s, root, (c) => rec.record({ kind: "change", root, ...c }));
  return { rec, off };
}

describe("Blockbaum", () => {
  it("enthält die Seite in Reihenfolge mit Verschachtelung, ohne Papierkorb und ohne andere Seiten", () => {
    const d = blockDocOf(page(), "P");
    expect(isBlockDoc(d)).toBe(true);
    expect(d.blocks.map((b) => [b.id, b.type])).toEqual([["A", "heading1"], ["B", "bulletedList"]]);
    expect(d.blocks[1]!.children.map((b) => b.id)).toEqual(["C"]);
    expect(JSON.stringify(d)).not.toContain("andere Seite");
    expect(JSON.stringify(d)).not.toContain("weg");
  });

  it("ändert sich nicht, wenn danach getippt wird (Verweise auf unveränderliche Records)", () => {
    const s = page();
    const refs = pageBlocks(s, "P");
    cmd.replaceText(s, { blockId: "A", from: 4, to: 4 }, "!");
    expect(refs.find((b) => b.id === "A")!.text).toBe("Plan");
    expect(plain(blockDocOf(s, "P").blocks[0]!.text)).toBe("Plan!");
  });
});

const plain = (t: unknown) => (typeof t === "string" ? t : (t as { t?: string }[]).map((r) => r.t ?? "").join(""));

describe("Transaktionen der Seite", () => {
  it("meldet Befehlsname, Herkunft und Records danach – nur für Blöcke dieser Seite, auch Löschen und Undo", () => {
    const s = page();
    const seen: { name?: string; origin: string; ids: string[]; gone: string[] }[] = [];
    const off = observePageChanges(s, "P", (c) => seen.push({ ...(c.name ? { name: c.name } : {}), origin: c.origin, ids: c.changes.map((x) => x.id), gone: c.changes.filter((x) => !x.block).map((x) => x.id) }));
    cmd.replaceText(s, { blockId: "A", from: 4, to: 4 }, "!");
    cmd.replaceText(s, { blockId: "O", from: 0, to: 0 }, "x"); // andere Seite: nichts
    const f = cmd.splitBlock(s, "A", 5)!;
    s.transact("Remove", (tx) => tx.remove(`block:${f.blockId}`));
    s.undo();
    off();
    cmd.replaceText(s, { blockId: "A", from: 0, to: 0 }, "nach dem Abmelden");
    expect(seen.map((x) => x.origin)).toEqual(["local", "local", "local", "undo"]);
    expect(seen[0]).toMatchObject({ ids: ["A"] });
    expect(seen[0]!.name).toBeTruthy();
    expect(seen[1]!.ids).toContain(f.blockId);
    expect(seen[2]).toMatchObject({ name: "Remove", ids: [f.blockId], gone: [f.blockId] });
    expect(seen[3]!.ids).toEqual([f.blockId]);
  });
});

function bundleOf(events: RecordedEvent[], s: WorkspaceStore, realText = false): BugBundle {
  return buildBugBundle({
    id: "20261114-120000-ab3f", now: 1, note: "Liste sprang", realText,
    app: { shell: "web" }, env: { width: 1280, height: 820, dpr: 1, zoom: 1, theme: "light" },
    state: { root: "P", doc: blockDocOf(s, "P"), blocks: blockDocOf(s, "P"), sel: { type: "text", anchor: 1, head: 1, block: "A" }, menus: [] },
    layout: [], events, log: [],
  });
}

describe("Bündel und Wiedergabe", () => {
  it("ersetzt Text in Zwischenstand, Records und Endzustand – Typen, IDs, Eltern, Sortierschlüssel und Farben bleiben", () => {
    const s = page();
    const { rec, off } = recordPage(s, "P");
    cmd.replaceText(s, { blockId: "B", from: 0, to: 0 }, "Neu: ");
    off();
    const b = bundleOf(rec.snapshot(), s);
    const json = JSON.stringify(b);
    for (const w of ["Gehalt", "Ada", "4711", "Plan", "fett", "Neu"]) expect(json).not.toContain(w);
    const change = b.recording.events.find((e) => (e as { kind: string }).kind === "change") as { changes: { id: string; block: Block }[] };
    expect(change.changes[0]!.id).toBe("B");
    expect(change.changes[0]!.block).toMatchObject({ id: "B", type: "bulletedList", parent: "b:P", sk: "a1" });
    expect(JSON.stringify(b.state.doc)).toContain('"color":"red"');
    expect(json).toContain('"block":"A"');
  });

  it("Modus „steps“: Baum laden, Records anwenden → gleicher Endzustand wie beim Melden (auch mit ersetztem Text)", () => {
    for (const realText of [true, false]) {
      const s = page();
      const { rec, off } = recordPage(s, "P");
      const f = cmd.splitBlock(s, "B", 3)!;
      cmd.replaceText(s, { blockId: f.blockId, from: 0, to: 0 }, "neu ");
      cmd.indentBlocks(s, [f.blockId]);
      cmd.turnInto(s, ["A"], "heading2");
      cmd.deleteBlocks(s, ["C"]);
      off();
      const bundle = bundleOf(rec.snapshot(), s, realText);
      const plan = replayPlan(bundle, { mode: "steps" });
      expect(plan.actions.length).toBeGreaterThanOrEqual(4);
      expect(isBlockDoc(plan.start.doc)).toBe(true);

      const r = store(blk("R", "page", "w", "a0", { text: "Replay" }), blk("X", "text", "b:R", "a0", { text: "vorher" }));
      let n = 0;
      const ids = loadBlockDoc(r, "R", plan.root, plan.start.doc as never, () => `N${n++}`);
      expect(normalizeDoc(blockDocOf(r, "R"))).toEqual(normalizeDoc(plan.start.doc));
      for (const a of plan.actions) if (a.kind === "steps") applyBlockChanges(r, ids, a.steps as never, () => `N${n++}`);
      expect(normalizeDoc(blockDocOf(r, "R"))).toEqual(normalizeDoc(plan.expected));
      expect(JSON.stringify(normalizeDoc(plan.expected))).toContain("heading2");
      expect(mapReplaySelection(ids, { type: "text", anchor: 0, head: 0, block: "A" }).block).toBe(ids.ids.get("A"));
    }
  });
});

describe("Wiedergabe-Plan „input“ im Block-Editor", () => {
  it("wendet per Klick ausgelöste und fremde Transaktionen als Records an, getippte nicht", () => {
    const ch = (name: string, origin = "local") => ({ kind: "change", root: "P", name, origin, changes: [{ id: "A", block: { id: "A" } }] });
    const events = [
      { kind: "checkpoint", root: "P", doc: { editor: "blocks", blocks: [] }, sel: { type: "none", anchor: 0, head: 0 } },
      { kind: "pointer", phase: "down", x: 1, y: 1, button: 0, detail: 1, target: "div.bx2-tail" },
      { kind: "pointer", phase: "up", x: 1, y: 1, button: 0, detail: 1, target: "div.bx2-tail" },
      ch("New block"),
      { kind: "select", root: "P", sel: { type: "text", anchor: 0, head: 0, block: "A" }, cause: "pointer" },
      { kind: "key", root: "P", key: "a", mods: {} },
      { kind: "input", root: "P", inputType: "insertText", data: "a" },
      ch("Typing"),
      ch("Sync", "remote"),
      { kind: "key", root: "P", key: "z", mods: { meta: true } },
      ch("Typing", "undo"),
    ];
    const bundle = { format: "based-bug-report", version: 1, id: "x", createdAt: "", note: "", realText: false, app: { shell: "web" }, env: { width: 1, height: 1, dpr: 1, zoom: 1, theme: "light" }, state: { root: "P", menus: [] }, layout: { items: [], issues: [] }, recording: { events }, log: [] } as unknown as BugBundle;
    expect(replayPlan(bundle).actions.map((a) => a.kind)).toEqual(["steps", "select", "type", "steps", "press"]);
  });
});

describe("Auswahl in der Wiedergabe", () => {
  it("findet einen Block über seine Stelle, wenn die Wiedergabe ihn mit neuer ID angelegt hat", () => {
    const s = page();
    expect(blockPath(s, "P", "C")).toEqual([1, 0]);
    expect(blockAtPath(s, "P", [1, 0])).toBe("C");
    const r = store(blk("R", "page", "w", "a0"), blk("x1", "text", "b:R", "a0"), blk("x2", "text", "b:R", "a1"), blk("x3", "text", "b:x2", "a0"));
    const m = { recordedRoot: "P", root: "R", ids: new Map([["A", "x1"]]) };
    expect(resolveReplaySelection(r, m, { type: "text", anchor: 0, head: 0, block: "A" }).block).toBe("x1");
    expect(resolveReplaySelection(r, m, { type: "text", anchor: 2, head: 2, block: "C", path: [1, 0] })).toMatchObject({ block: "x3", anchor: 2 });
  });
});
