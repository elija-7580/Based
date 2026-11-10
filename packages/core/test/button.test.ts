// BSD-210: Button-Block, Vorlage Swift ButtonTests.swift (Store/ButtonOps.swift).
import { describe, expect, it } from "vitest";
import { createDatabase, effectiveButtonActions, MemoryPersistence, plainText, runButton, setButton, WorkspaceStore, type Block } from "../src/index.js";

const blk = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): { kind: "block"; data: Block } =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, ...extra } as Block });

const mk = (extra: { kind: "block"; data: Block }[] = []) => {
  let t = 1;
  return new WorkspaceStore({ persistence: new MemoryPersistence([blk("home", "page", "w", "a0"), ...extra]), node: "t", now: () => (t += 1) });
};

describe("Button-Schritte (Swift ButtonOps)", () => {
  it("altes Add page öffnet im Center Peek; ohne Angabe: Insert blocks", () => {
    expect(effectiveButtonActions({ buttonAction: { kind: "addPage", targetID: "db" } }).map((a) => a.kind)).toEqual(["addPage", "openAdded"]);
    expect(effectiveButtonActions({ buttonAction: { kind: "addPage", targetID: "db", openAfter: false } }).map((a) => a.kind)).toEqual(["addPage"]);
    expect(effectiveButtonActions({}).map((a) => a.kind)).toEqual(["insertBlocks"]);
    expect(effectiveButtonActions(undefined).map((a) => a.kind)).toEqual(["insertBlocks"]);
  });

  it("Schritte laufen der Reihe nach und halten bei confirm", () => {
    const s = mk();
    const c = createDatabase(s, { parent: "home", inline: true, viewType: "table", sampleRows: 0 });
    const s2 = s; // gleicher Store
    s2.transact("x", (tx) => tx.put(blk("btn", "button", "b:home", "z0", { props: {
      buttonLabel: "New project",
      buttonActions: [
        { kind: "addPage", targetID: c.databaseID, title: "Untitled project" },
        { kind: "confirm", message: "Open it?" },
        { kind: "openAdded", mode: "sidePeek", step: 0 },
      ],
    } })));
    const first = runButton(s, "btn");
    expect(first.effects).toEqual([]);
    const pause = first.pause!;
    expect(pause.message).toBe("Open it?");
    expect(pause.next).toBe(2);
    const row = pause.added[0]!;
    expect(plainText(s.blocks.get(row)?.text)).toBe("Untitled project");
    const rest = runButton(s, "btn", { from: pause.next, added: pause.added });
    expect(rest.effects).toEqual([{ kind: "open", id: row, mode: "sidePeek" }]);
    expect(rest.pause).toBeUndefined();
  });

  it("fehlendes Ziel verlangt Einrichtung; unbekannte Schritte werden übersprungen", () => {
    const s = mk([blk("b", "button", "b:home", "a1", { props: { buttonActions: [{ kind: "openPage" }, { kind: "sendMail" as "openPage" }, { kind: "openURL", url: " https://example.com " }] } })]);
    expect(runButton(s, "b").effects).toEqual([{ kind: "needsSetup" }, { kind: "openURL", url: "https://example.com" }]);
    expect(runButton(s, "b", { pageExists: () => true }).effects[0]).toEqual({ kind: "needsSetup" });
    setButton(s, "b", { actions: [{ kind: "openPage", targetID: "elsewhere", mode: "fullPage" }] });
    expect(runButton(s, "b").effects).toEqual([{ kind: "needsSetup" }]);
    expect(runButton(s, "b", { pageExists: (id) => id === "elsewhere" }).effects).toEqual([{ kind: "open", id: "elsewhere", mode: "fullPage" }]);
  });

  it("Insert blocks kopiert die Vorlage (mit Kindern, ohne Papierkorb) hinter den Button, ein Undo-Schritt", () => {
    const s = mk([
      blk("b", "button", "b:home", "a1"),
      blk("after", "text", "b:home", "a2", { text: "danach" }),
      blk("t1", "todo", "b:b", "a0", { text: "Aufgabe" }),
      blk("t1k", "text", "b:t1", "a0", { text: "Kind" }),
      blk("gone", "text", "b:b", "a1", { text: "weg", trashedAt: 5 }),
      blk("t2", "text", "b:b", "a2", { text: "Notiz" }),
    ]);
    const r = runButton(s, "b");
    const kids = s.children("b:home").map((id) => s.blocks.get(id)!);
    expect(kids.map((b) => plainText(b.text))).toEqual(["", "Aufgabe", "Notiz", "danach"]);
    const copy = kids[1]!;
    expect(copy.id).not.toBe("t1");
    expect(s.children("b:" + copy.id).map((id) => plainText(s.blocks.get(id)!.text))).toEqual(["Kind"]);
    expect(r.effects).toEqual([{ kind: "focusEnd", id: kids[2]!.id }]);
    // Vorlage bleibt
    expect(s.children("b:b")).toEqual(["t1", "gone", "t2"]);
    s.undo();
    expect(s.children("b:home")).toEqual(["b", "after"]);
  });

  it("Insert blocks ohne Vorlage verlangt Einrichtung", () => {
    const s = mk([blk("b", "button", "b:home", "a1")]);
    expect(runButton(s, "b").effects).toEqual([{ kind: "needsSetup" }]);
  });

  it("setButton: Beschriftung und Schritte; ersetzt die alte einzelne Aktion", () => {
    const s = mk([blk("b", "button", "b:home", "a1", { props: { buttonAction: { kind: "openURL", url: "x" } } })]);
    setButton(s, "b", { label: "Go", actions: [{ kind: "confirm" }] });
    expect(s.blocks.get("b")?.props).toEqual({ buttonLabel: "Go", buttonActions: [{ kind: "confirm" }] });
    expect(runButton(s, "b").pause?.message).toBe("Are you sure?");
    setButton(s, "b", { label: "" });
    expect(s.blocks.get("b")?.props?.buttonLabel).toBeUndefined();
  });
});
