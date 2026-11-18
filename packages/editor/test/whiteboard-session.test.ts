// BSD-264 (Whiteboard 2): Board-Sitzung – Records sind die Quelle, das Y.Doc das lebende Modell. Geprüft: kein Echo,
// ein Undo-Stapel, Änderungen von anderswo (Sync) kommen an und werden von Undo nicht überschrieben, Tinte und
// unbekannte Felder überstehen den Weg Y.Doc → Record → Y.Doc.
import { describe, expect, it } from "vitest";
import {
  BOARD_OBJECT_TYPE, boardObjectFromBlock, boardObjectsOf, boardObjectToBlock, createBoardPage, encodeInk, MemoryPersistence, parseWBObject, sameBoardObject, WorkspaceStore,
  type StoreChange, type WBObject, type WireRecord,
} from "@based/core";
import { BoardSession } from "../src/whiteboard/session.js";
import type { PresenceChannel } from "../src/yjs/collab.js";

const note = (id: string, x = 0, y = 0, z = "a0", extra: Record<string, unknown> = {}): WBObject =>
  parseWBObject({ id, kind: "note", x, y, w: 100, h: 80, z, ...extra })!;

function setup(objs: WBObject[] = []) {
  let t = 1000;
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => t++ });
  const page = createBoardPage(store, { title: "Board" });
  if (objs.length) store.transact("seed", (tx) => { for (const o of objs) tx.put({ kind: "block", data: boardObjectToBlock(o, page, store.now()) }); });
  store.clearUndoHistory();
  const changes: StoreChange[] = [];
  store.observe((c) => changes.push(c));
  const session = new BoardSession(store, page);
  return { store, page, session, changes };
}

/** Record eines anderen Geräts mit neuerem Stempel (wie er über Sync v2 ankommt). */
function remote(store: WorkspaceStore, page: string, o: WBObject): WireRecord {
  const existing = store.blocks.get(o.id);
  const data = boardObjectToBlock(o, page, 5000, existing);
  data.stamp = { millis: 9_000_000_000_000, counter: 0, node: "other" };
  return { kind: "block", data };
}

describe("Board-Sitzung", () => {
  it("lädt die Objekte der Seite, von hinten nach vorn; Laden schreibt nichts", () => {
    const { session, changes, store } = setup([note("b", 0, 0, "a1"), note("a", 0, 0, "a0")]);
    expect(session.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(changes).toEqual([]);
    expect(session.canUndo).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it("eigene Änderung: ein Schreiben in den Store, kein Echo, nicht im Undo-Stapel des Stores", () => {
    const { session, changes, store, page } = setup();
    session.add([note("n1", 10, 20)]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ origin: "local", keys: ["block:n1"] });
    expect(store.blocks.get("n1")).toMatchObject({ type: BOARD_OBJECT_TYPE, parent: "b:" + page });
    expect(store.canUndo).toBe(false);
    expect(session.canUndo).toBe(true);
    const v = session.version;
    session.patch(new Map([["n1", { x: 10 }]])); // gleicher Wert: nichts passiert
    expect(session.version).toBe(v);
    expect(changes).toHaveLength(1);
    session.patch(new Map([["n1", { x: 300, y: 40 }]]));
    expect(changes).toHaveLength(2);
    expect(boardObjectFromBlock(store.blocks.get("n1")!)).toMatchObject({ x: 300, y: 40 });
  });

  it("eine Geste = ein Schritt: Undo und Redo gehen durch bis in die Records", () => {
    const { session, store } = setup([note("a"), note("b", 200)]);
    session.patch(new Map([["a", { x: 50 }], ["b", { x: 250 }]]));
    session.remove(["b"]);
    expect(store.blocks.has("b")).toBe(false);
    expect(session.undo()).toBe(true);
    expect(store.blocks.has("b")).toBe(true);
    expect(session.get("b")).toMatchObject({ x: 250 });
    session.undo();
    expect(boardObjectFromBlock(store.blocks.get("a")!)).toMatchObject({ x: 0 });
    expect(boardObjectFromBlock(store.blocks.get("b")!)).toMatchObject({ x: 200 });
    expect(session.canUndo).toBe(false);
    session.redo();
    session.redo();
    expect(store.blocks.has("b")).toBe(false);
    expect(session.get("a")).toMatchObject({ x: 50 });
    expect(session.canRedo).toBe(false);
  });

  it("Löschen nimmt Verbindungen mit; Undo bringt beides zurück", () => {
    const k = parseWBObject({ id: "k", kind: "connector", from: { id: "a" }, to: { id: "b" }, z: "a2", label: "explains" })!;
    const { session, store } = setup([note("a"), note("b", 200, 0, "a1"), k]);
    expect(session.remove(["b"]).sort()).toEqual(["b", "k"]);
    expect(store.blocks.has("k")).toBe(false);
    session.undo();
    expect(session.objects.map((o) => o.id)).toEqual(["a", "b", "k"]);
    expect(store.blocks.get("k")?.text).toBe("explains");
  });

  it("Änderung von anderswo (Sync) kommt an, ohne zurückgeschrieben oder rückgängig gemacht zu werden", () => {
    const { session, store, page, changes } = setup([note("a")]);
    store.applyRemote([remote(store, page, note("a", 500, 0)), remote(store, page, note("r", 1, 2, "a5"))]);
    expect(session.get("a")).toMatchObject({ x: 500 });
    expect(session.objects.map((o) => o.id)).toEqual(["a", "r"]);
    expect(changes.filter((c) => c.origin === "local")).toEqual([]); // kein Echo
    expect(session.canUndo).toBe(false);
    store.applyRemote([], ["block:r"]);
    expect(session.get("r")).toBeUndefined();
  });

  it("Undo nach einer fremden Änderung am selben Objekt: das fremde Feld bleibt", () => {
    const { session, store, page } = setup([note("a")]);
    session.patch(new Map([["a", { x: 50 }]]));
    // anderes Gerät: Farbe (anderes Feld) – der Record trägt x = 50 weiter
    const colored = { ...session.get("a")!, style: { color: "blue" } } as WBObject;
    store.applyRemote([remote(store, page, colored)]);
    expect(session.get("a")).toMatchObject({ x: 50, style: { color: "blue" } });
    session.undo();
    expect(session.get("a")).toMatchObject({ x: 0, style: { color: "blue" } });
    expect(boardObjectFromBlock(store.blocks.get("a")!)).toMatchObject({ x: 0, style: { color: "blue" } });
  });

  it("Undo des Stores (z. B. Seite wiederhergestellt) wirkt wie eine Änderung von anderswo", () => {
    const { session, store, page } = setup([note("a")]);
    store.transact("elsewhere", (tx) => tx.put({ kind: "block", data: boardObjectToBlock(note("a", 77), page, store.now(), store.blocks.get("a")) }));
    expect(session.get("a")).toMatchObject({ x: 77 });
    store.undo();
    expect(session.get("a")).toMatchObject({ x: 0 });
    expect(session.canUndo).toBe(false);
  });

  it("Tinte und unbekannte Felder: Y.Doc → Record → neue Sitzung, unverändert", () => {
    const ink = encodeInk([{ x: 0, y: 0, p: 0.5 }, { x: 40.5, y: -12, p: 0.9 }, { x: 80, y: 3, p: 0.2 }]);
    const stroke = parseWBObject({ id: "i", kind: "ink", x: 5, y: 6, w: 80, h: 15, z: "a3", ink, style: { color: "blue", width: 2 }, future: { v: 2 } })!;
    const { session, store, page } = setup();
    session.add([stroke]);
    const again = new BoardSession(store, page);
    expect(sameBoardObject(again.get("i"), stroke)).toBe(true);
    expect(again.get("i")?.extra).toEqual({ future: { v: 2 } });
    again.patch(new Map([["i", { x: 9 }]]));
    expect(sameBoardObject(session.get("i"), { ...stroke, x: 9 } as WBObject)).toBe(true); // zweites Fenster derselben Seite
    expect((store.blocks.get("i")!.props as { wb: Record<string, unknown> }).wb.future).toEqual({ v: 2 });
    again.destroy();
  });

  it("nach vorn / nach hinten: Reihenfolge der gewählten untereinander bleibt, sk ist die Reihenfolge", () => {
    const { session, store, page } = setup([note("a", 0, 0, "a0"), note("b", 0, 0, "a1"), note("c", 0, 0, "a2")]);
    session.reorder(["a", "b"], "front");
    expect(session.objects.map((o) => o.id)).toEqual(["c", "a", "b"]);
    expect(boardObjectsOf(store, page).map((o) => o.id)).toEqual(["c", "a", "b"]);
    session.reorder(["a", "b"], "back");
    expect(session.objects.map((o) => o.id)).toEqual(["a", "b", "c"]);
    session.undo();
    expect(session.objects.map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("fasst fremde Blöcke nie an und lässt unlesbare Board-Records stehen", () => {
    const { session, store, page } = setup([note("a")]);
    const other = store.transact("page", (tx) => { tx.put({ kind: "block", data: { id: "txt", type: "text", parent: "b:" + page, sk: "a9", text: "hello", createdAt: 1, updatedAt: 1 } }); return "txt"; });
    expect(session.objects.map((o) => o.id)).toEqual(["a"]);
    session.add([note(other, 5, 5)]); // gleiche ID wie ein fremder Block: wird nicht überschrieben
    expect(store.blocks.get("txt")).toMatchObject({ type: "text", text: "hello" });
    // Record einer neueren Version (unbekannte Art): bleibt im Store, stört das Board nicht
    store.applyRemote([{ kind: "block", data: { id: "future", type: BOARD_OBJECT_TYPE, parent: "b:" + page, sk: "b0", props: { wb: { kind: "hologram" } } as never, createdAt: 1, updatedAt: 1, stamp: { millis: 9_000_000_000_000, counter: 0, node: "o" } } }]);
    expect(store.blocks.has("future")).toBe(true);
    expect(session.get("future")).toBeUndefined();
  });

  it("schreibgeschützt: nichts ändert sich", () => {
    const { session, store } = setup([note("a")]);
    Object.defineProperty(store, "isReadOnly", { get: () => true });
    expect(session.add([note("x")])).toBe(false);
    expect(session.remove(["a"])).toEqual([]);
    expect(session.get("a")).toBeDefined();
    expect(session.undo()).toBe(false);
  });

  it("benachrichtigt bei jeder Änderung genau einmal und nach destroy gar nicht mehr", () => {
    const { session, store, page } = setup([note("a")]);
    let n = 0;
    const off = session.subscribe(() => { n += 1; });
    session.patch(new Map([["a", { x: 1 }]]));
    expect(n).toBe(1);
    store.applyRemote([remote(store, page, note("a", 2))]);
    expect(n).toBe(2);
    off();
    session.patch(new Map([["a", { x: 3 }]]));
    expect(n).toBe(2);
    session.destroy();
    store.applyRemote([remote(store, page, note("zz", 2))]);
    expect(session.apply(() => undefined)).toBe(false);
  });

  it("Präsenz: eigener Zeiger wird gemeldet, fremde Zeiger dieses Boards kommen zurück", () => {
    let t = 1;
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "l", now: () => t++ });
    const page = createBoardPage(store);
    const states = new Map<number, Record<string, unknown>>([[1, {}], [2, { user: { name: "Lena", color: "green" }, board: { page, x: 10, y: 20 } }], [3, { board: { page: "other", x: 1, y: 1 } }]]);
    const presence: PresenceChannel = {
      clientID: 1, getStates: () => states,
      setLocalStateField: (f, v) => { states.set(1, { ...states.get(1), [f]: v }); },
      on: () => undefined, off: () => undefined,
    };
    const session = new BoardSession(store, page, { presence });
    session.setCursor({ x: 5, y: 6 });
    expect(states.get(1)).toEqual({ board: { page, x: 5, y: 6 } });
    expect(session.peers()).toEqual([{ clientID: 2, x: 10, y: 20, name: "Lena", color: "green" }]);
    session.destroy();
    expect(states.get(1)).toEqual({ board: null });
  });
});
