// Elija 18.11.: eine Unterseite eines Boards liegt als Karte auf dem Board.
import { describe, expect, it } from "vitest";
import { boardObjectsOf, boardObjectToBlock, boardPageCardID, boardPagesWithoutCard, createBoardPage, createPage, insertBoardPageCards, insertPage, MemoryPersistence, WorkspaceStore } from "../src/index.js";

const newStore = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => 1000 });

describe("Unterseiten auf dem Board", () => {
  it("legt neue Unterseiten im selben Schritt als Karte rechts neben den Inhalt", () => {
    const store = newStore();
    const board = createBoardPage(store, { title: "Board" });
    store.transact("note", (tx) => tx.put({ kind: "block", data: boardObjectToBlock({ id: "n1", kind: "note", z: "a0", x: 0, y: 50, w: 200, h: 100, rot: 0 }, board, 1000) }));
    const page = store.transact("New page", (tx) => { const id = insertPage(store, tx, { parent: board, title: "Plan" }); insertBoardPageCards(store, tx, board, [id]); return id; });
    const card = boardObjectsOf(store, board).find((o) => o.kind === "page");
    expect(card).toMatchObject({ id: boardPageCardID(page), ref: page, text: "Plan", x: 240, y: 50 });
    expect(card!.z > "a0").toBe(true);
    expect(boardPagesWithoutCard(store, board)).toEqual([]);
  });

  it("findet ältere Unterseiten ohne Karte, aber keine gelöschte Karte wieder", () => {
    const store = newStore();
    const board = createBoardPage(store, { title: "Board" });
    const a = createPage(store, { parent: board, title: "A" });
    expect(boardPagesWithoutCard(store, board)).toEqual([a]);
    store.transact("cards", (tx) => insertBoardPageCards(store, tx, board, [a]));
    expect(boardPagesWithoutCard(store, board)).toEqual([]);
    store.transact("delete card", (tx) => tx.update(boardPageCardID(a), (b) => { b.trashedAt = 2000; }));
    expect(boardObjectsOf(store, board)).toHaveLength(0);
    expect(boardPagesWithoutCard(store, board)).toEqual([]);
  });

  it("macht nichts auf normalen Seiten", () => {
    const store = newStore();
    const page = createPage(store, { title: "Page" });
    const child = createPage(store, { parent: page });
    expect(store.transact("x", (tx) => insertBoardPageCards(store, tx, page, [child]))).toBe(0);
  });
});

describe("Gesperrter Ausschnitt eines eingebetteten Boards", () => {
  it("speichert und löst den Ausschnitt, ohne andere Board-Felder zu verlieren", async () => {
    const { boardEmbedView, setBoardEmbedView, setBoardBackground } = await import("../src/index.js");
    const store = newStore();
    const board = createBoardPage(store, { title: "Board" });
    setBoardBackground(store, board, "grid");
    setBoardEmbedView(store, board, { x: 10, y: -20, zoom: 0.5 });
    expect(boardEmbedView(store.blocks.get(board))).toEqual({ x: 10, y: -20, zoom: 0.5 });
    expect((store.blocks.get(board)!.props as { board: { bg: string; v: number } }).board).toMatchObject({ bg: "grid", v: 1 });
    setBoardEmbedView(store, board, undefined);
    expect(boardEmbedView(store.blocks.get(board))).toBeUndefined();
    expect((store.blocks.get(board)!.props as { board: { bg: string } }).board.bg).toBe("grid");
  });
});
