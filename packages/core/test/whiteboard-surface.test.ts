// BSD-264 (Whiteboard 2): Kamera, Geometrie, Raumindex und Board-Objekte als Records.
import { describe, expect, it } from "vitest";
import {
  applyImported, attachSearchIndex, blocksToMarkdown, BOARD_OBJECT_TYPE, BoardIndex, boardObjectFromBlock, boardObjectsOf, boardObjectToBlock, centerOn, createBoardPage, duplicateObjects, duplicatePages,
  encodeInk, exportPageHTML, fitCamera, frontZs, gridStepFor, hitHandle, hitTest, isBoardPage, MemoryPersistence, nudgeDelta, objectsInRect, panBy, parseWBObject, readArchive,
  readingOrder, resizeRect, restorePages, sameBoardObject, scaleInto, screenToWorld, selectionBounds, trashPages, visibleRect, WorkspaceStore, worldToScreen,
  writeArchive, zoomByWheel, zoomStep, zoomTo, type Camera, type WBObject,
} from "../src/index.js";

const note = (id: string, x: number, y: number, z = "a0", extra: Record<string, unknown> = {}): WBObject =>
  parseWBObject({ id, kind: "note", x, y, w: 100, h: 80, z, ...extra })!;
const newStore = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => 1000 });
const put = (store: WorkspaceStore, pageID: string, objs: WBObject[]) =>
  store.transact("t", (tx) => { for (const o of objs) tx.put({ kind: "block", data: boardObjectToBlock(o, pageID, store.now()) }); });

describe("Kamera", () => {
  const cam: Camera = { x: 100, y: 50, zoom: 2 };

  it("Bildschirm ↔ Welt ist umkehrbar", () => {
    const w = screenToWorld(cam, { x: 40, y: 20 });
    expect(w).toEqual({ x: 120, y: 60 });
    expect(worldToScreen(cam, w)).toEqual({ x: 40, y: 20 });
  });

  it("Zoomen hält den Punkt unter dem Zeiger fest und bleibt in den Grenzen", () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(cam, anchor);
    const z = zoomTo(cam, 3, anchor);
    const after = screenToWorld(z, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomTo(cam, 100, anchor).zoom).toBe(8);
    expect(zoomTo(cam, 0, anchor).zoom).toBe(0.1);
    expect(zoomTo(cam, Number.NaN, anchor).zoom).toBe(1);
  });

  it("Rad hinein und wieder hinaus landet am Ausgangspunkt", () => {
    const a = { x: 10, y: 10 };
    const back = zoomByWheel(zoomByWheel(cam, -30, a), 30, a);
    expect(back.zoom).toBeCloseTo(cam.zoom, 9);
    expect(back.x).toBeCloseTo(cam.x, 9);
  });

  it("Stufen: ⌘+ / ⌘− gehen zur nächsten festen Stufe, die Mitte bleibt stehen", () => {
    const vp = { w: 800, h: 600 };
    const mid = screenToWorld({ x: 0, y: 0, zoom: 1 }, { x: 400, y: 300 });
    const inn = zoomStep({ x: 0, y: 0, zoom: 1 }, 1, vp);
    expect(inn.zoom).toBe(1.5);
    expect(screenToWorld(inn, { x: 400, y: 300 }).x).toBeCloseTo(mid.x, 9);
    expect(zoomStep({ x: 0, y: 0, zoom: 1.2 }, -1, vp).zoom).toBe(1);
    expect(zoomStep({ x: 0, y: 0, zoom: 8 }, 1, vp).zoom).toBe(8);
    expect(zoomStep({ x: 0, y: 0, zoom: 0.1 }, -1, vp).zoom).toBe(0.1);
  });

  it("Ziehen mit der Hand: der Inhalt folgt dem Zeiger", () => {
    const p = panBy(cam, 20, -10);
    expect(worldToScreen(p, screenToWorld(cam, { x: 0, y: 0 }))).toEqual({ x: 20, y: -10 });
  });

  it("Fit zeigt alles mit Rand, vergrößert nie über 100 %, leer = Ursprung in der Mitte", () => {
    const vp = { w: 1000, h: 600 };
    const big = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, vp, 50);
    expect(big.zoom).toBeCloseTo(900 / 4000, 9);
    const vis = visibleRect(big, vp);
    expect(vis.x).toBeLessThanOrEqual(0);
    expect(vis.x + vis.w).toBeGreaterThanOrEqual(4000);
    expect(fitCamera({ x: 10, y: 10, w: 100, h: 80 }, vp).zoom).toBe(1);
    expect(fitCamera(undefined, vp)).toEqual({ x: -500, y: -300, zoom: 1 });
    expect(visibleRect(centerOn({ x: 0, y: 0, zoom: 2 }, { x: 50, y: 50 }, vp), vp)).toEqual({ x: -200, y: -100, w: 500, h: 300 });
  });

  it("Raster wird weit draußen gröber, nie dichter als 12 px auf dem Bildschirm", () => {
    expect(gridStepFor(1)).toBe(24);
    expect(gridStepFor(2)).toBe(24);
    expect(gridStepFor(0.5)).toBe(24);
    expect(gridStepFor(0.25)).toBe(48);
    expect(gridStepFor(0.1) * 0.1).toBeGreaterThanOrEqual(12);
  });
});

describe("Treffer und Auswahl", () => {
  const objs: WBObject[] = [
    note("back", 0, 0, "a0"),
    note("front", 50, 40, "a1"),
    parseWBObject({ id: "oval", kind: "shape", x: 300, y: 0, w: 100, h: 100, z: "a2", style: { shape: "oval" } })!,
    parseWBObject({ id: "rot", kind: "shape", x: 500, y: 0, w: 200, h: 20, rot: 90, z: "a3" })!,
    parseWBObject({ id: "line", kind: "connector", from: { id: "back" }, to: { id: "oval" }, z: "a4" })!,
  ];

  it("das vorderste Objekt gewinnt; Oval und Drehung werden beachtet", () => {
    expect(hitTest(objs, { x: 60, y: 50 })).toBe("front");
    expect(hitTest(objs, { x: 10, y: 10 })).toBe("back");
    expect(hitTest(objs, { x: 302, y: 2 })).toBeUndefined(); // Ecke des Ovals
    expect(hitTest(objs, { x: 350, y: 50 })).toBe("oval");
    expect(hitTest(objs, { x: 600, y: 90 })).toBe("rot"); // nur gedreht getroffen
    expect(hitTest(objs, { x: 520, y: 10 })).toBeUndefined(); // ungedreht läge es hier
    expect(hitTest(objs, { x: 900, y: 900 })).toBeUndefined();
  });

  it("Verbindung: Enden an den zugewandten Seiten, Treffer nahe der Linie", () => {
    // back (0…100) → oval (300…400): rechts von back, links vom Oval, y = 40 … 50
    expect(hitTest(objs, { x: 200, y: 45 })).toBe("line");
    expect(hitTest(objs, { x: 200, y: 70 })).toBeUndefined();
  });

  it("Aufziehen wählt, was das Rechteck berührt; Verbindungen nur ganz darin", () => {
    expect(objectsInRect(objs, { x: -10, y: -10, w: 80, h: 60 }).sort()).toEqual(["back", "front"]);
    expect(objectsInRect(objs, { x: -10, y: -10, w: 500, h: 200 })).toContain("line");
    expect(objectsInRect(objs, { x: 160, y: 0, w: 60, h: 100 })).toEqual([]);
  });

  it("Auswahlrahmen umfasst alle gewählten Objekte", () => {
    expect(selectionBounds(objs, new Set(["back", "front"]))).toEqual({ x: 0, y: 0, w: 150, h: 120 });
    expect(selectionBounds(objs, new Set(["nope"]))).toBeUndefined();
  });

  it("Raumindex: nur Sichtbares, von hinten nach vorn; Treffer wie hitTest", () => {
    const many = Array.from({ length: 2000 }, (_, i) => note("n" + i, (i % 50) * 200, Math.floor(i / 50) * 200, "a" + String(i).padStart(5, "0")));
    const idx = new BoardIndex();
    idx.load(many);
    const seen = idx.search({ x: 0, y: 0, w: 390, h: 390 });
    expect(seen.map((o) => o.id)).toEqual(["n0", "n1", "n50", "n51"]);
    expect(idx.hit({ x: 210, y: 10 })).toBe("n1");
    expect(idx.hit({ x: 150, y: 150 })).toBeUndefined();
    expect(idx.extent()).toEqual({ x: 0, y: 0, w: 49 * 200 + 100, h: 39 * 200 + 80 });
    idx.load([]);
    expect(idx.extent()).toBeUndefined();
    expect(idx.search({ x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe("Griffe und Größe", () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };

  it("Griff unter dem Zeiger, Ecken vor Kanten", () => {
    expect(hitHandle(r, { x: 101, y: 99 }, 6)).toBe("nw");
    expect(hitHandle(r, { x: 200, y: 203 }, 6)).toBe("s");
    expect(hitHandle(r, { x: 200, y: 150 }, 6)).toBeUndefined();
  });

  it("Ziehen eines Griffs: gegenüberliegende Kante bleibt, kein Umklappen", () => {
    expect(resizeRect(r, "se", { x: 50, y: 20 })).toEqual({ x: 100, y: 100, w: 250, h: 120 });
    expect(resizeRect(r, "nw", { x: 50, y: 20 })).toEqual({ x: 150, y: 120, w: 150, h: 80 });
    expect(resizeRect(r, "e", { x: -1000, y: 0 })).toEqual({ x: 100, y: 100, w: 8, h: 100 });
    expect(resizeRect(r, "n", { x: 0, y: 1000 })).toEqual({ x: 100, y: 192, w: 200, h: 8 });
  });

  it("⇧ hält das Seitenverhältnis an den Ecken", () => {
    const k = resizeRect(r, "se", { x: 100, y: 0 }, { keepAspect: true });
    expect(k.w / k.h).toBeCloseTo(2, 9);
    expect(k).toMatchObject({ x: 100, y: 100, w: 300 });
    const n = resizeRect(r, "nw", { x: -100, y: 0 }, { keepAspect: true });
    expect(n.x + n.w).toBe(300);
    expect(n.y + n.h).toBe(200);
    expect(n.w / n.h).toBeCloseTo(2, 9);
  });

  it("mehrere Objekte skalieren gemeinsam mit dem Rahmen", () => {
    expect(scaleInto({ x: 150, y: 100, w: 50, h: 50 }, r, { x: 100, y: 100, w: 400, h: 100 })).toEqual({ x: 200, y: 100, w: 100, h: 50 });
  });

  it("Pfeiltasten: 1 px, mit ⇧ 10 px", () => {
    expect(nudgeDelta("ArrowLeft", false)).toEqual({ x: -1, y: 0 });
    expect(nudgeDelta("ArrowDown", true)).toEqual({ x: 0, y: 10 });
    expect(nudgeDelta("a", false)).toBeUndefined();
  });

  it("Tab läuft in Leserichtung", () => {
    const objs = [note("c", 0, 200), note("b", 300, 10), note("a", 0, 0), parseWBObject({ id: "k", kind: "connector", from: { id: "a" }, to: { id: "b" } })!];
    expect(readingOrder(objs)).toEqual(["a", "b", "c", "k"]);
  });

  it("Duplizieren: versetzt, ganz vorn, Verbindungen nur mit beiden Enden", () => {
    const objs = [note("a", 0, 0, "a0"), note("b", 200, 0, "a1"), parseWBObject({ id: "k", kind: "connector", from: { id: "a" }, to: { id: "b" }, z: "a2" })!];
    let n = 0;
    const all = duplicateObjects(objs, new Set(["a", "b", "k"]), () => "new" + n++, { x: 16, y: 16 });
    expect(all.map((o) => o.kind)).toEqual(["note", "note", "connector"]);
    expect(all[0]).toMatchObject({ x: 16, y: 16 });
    expect(all.every((o) => o.z > "a2")).toBe(true);
    const k = all[2]!;
    expect(k.kind === "connector" && [k.from.id, k.to.id]).toEqual([all[0]!.id, all[1]!.id]);
    n = 0;
    expect(duplicateObjects(objs, new Set(["a", "k"]), () => "x" + n++, { x: 0, y: 0 }).map((o) => o.kind)).toEqual(["note"]);
    const zs = frontZs(objs, 3);
    expect([...zs].sort()).toEqual(zs);
    expect(zs[0]! > "a2").toBe(true);
  });
});

describe("Board-Objekte als Records", () => {
  it("Objekt → Record → Objekt: alle Felder, Tinte, Text, unbekannte Felder", () => {
    const ink = encodeInk([{ x: 0, y: 0, p: 0.5 }, { x: 12.5, y: -3, p: 1 }]);
    const stroke = parseWBObject({ id: "i", kind: "ink", x: 5, y: 6, w: 20, h: 10, z: "a3", ink, style: { color: "blue", width: 2 }, future: { a: [1, 2] } })!;
    const b = boardObjectToBlock(stroke, "page", 1000);
    expect(b).toMatchObject({ id: "i", type: BOARD_OBJECT_TYPE, parent: "b:page", sk: "a3", createdAt: 1000 });
    expect(typeof (b.props as { wb: { ink: unknown } }).wb.ink).toBe("string");
    expect((b.props as { wb: Record<string, unknown> }).wb.z).toBeUndefined(); // sk ist die einzige Reihenfolge
    const back = boardObjectFromBlock(JSON.parse(JSON.stringify(b)))!;
    expect(sameBoardObject(back, stroke)).toBe(true);
    expect(back.kind !== "connector" && [...back.ink!]).toEqual([...ink]);
    expect(back.extra).toEqual({ future: { a: [1, 2] } });

    const sticky = note("n", 1, 2, "a1", { text: "Residuals normal?" });
    const nb = boardObjectToBlock(sticky, "page", 1000);
    expect(nb.text).toBe("Residuals normal?");
    expect(boardObjectFromBlock(nb)).toMatchObject({ text: "Residuals normal?" });

    const conn = parseWBObject({ id: "k", kind: "connector", from: { id: "a", side: "left" }, to: { id: "b" }, shape: "elbow", label: "explains", z: "a2" })!;
    const kb = boardObjectToBlock(conn, "page", 1000);
    expect(kb.text).toBe("explains");
    expect(sameBoardObject(boardObjectFromBlock(kb), conn)).toBe(true);
  });

  it("Ändern behält Anlegedaten und fremde Felder des Records", () => {
    const first = boardObjectToBlock(note("n", 0, 0), "page", 1000);
    const existing = { ...first, createdBy: "u1", props: { ...first.props, later: true } } as typeof first;
    const next = boardObjectToBlock(note("n", 40, 0, "a5"), "page", 2000, existing);
    expect(next).toMatchObject({ createdAt: 1000, createdBy: "u1", updatedAt: 2000, sk: "a5" });
    expect((next.props as Record<string, unknown>).later).toBe(true);
    expect(boardObjectFromBlock(next)).toMatchObject({ x: 40 });
  });

  it("kein Board-Objekt: anderer Typ, fehlende oder kaputte Felder", () => {
    const b = boardObjectToBlock(note("n", 0, 0), "page", 1);
    expect(boardObjectFromBlock({ ...b, type: "text" })).toBeUndefined();
    expect(boardObjectFromBlock({ ...b, props: {} })).toBeUndefined();
    expect(boardObjectFromBlock({ ...b, props: { wb: { kind: "hologram" } } as never })).toBeUndefined();
  });

  it("Board-Seite: normale Seite mit Marke; Objekte hängen als Kinder daran", () => {
    const store = newStore();
    const page = createBoardPage(store, { title: "Regression map" });
    expect(isBoardPage(store.blocks.get(page))).toBe(true);
    expect(store.blocks.get(page)).toMatchObject({ type: "page", text: "Regression map" });
    put(store, page, [note("b", 0, 0, "a1"), note("a", 10, 0, "a0")]);
    expect(boardObjectsOf(store, page).map((o) => o.id)).toEqual(["a", "b"]);
    // ein kaputter Record stört die anderen nicht
    store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "junk", type: BOARD_OBJECT_TYPE, parent: "b:" + page, sk: "a2", createdAt: 1, updatedAt: 1 } }));
    expect(boardObjectsOf(store, page)).toHaveLength(2);
    store.undo();
    store.undo();
    store.undo();
    expect(store.blocks.has(page)).toBe(false);
  });

  it("Papierkorb und Wiederherstellen: die Objekte bleiben an der Seite", () => {
    const store = newStore();
    const page = createBoardPage(store, { title: "Board" });
    put(store, page, [note("a", 0, 0), note("b", 200, 0, "a1")]);
    trashPages(store, [page]);
    expect(store.blocks.get(page)?.trashedAt).toBeDefined();
    expect(store.blocks.has("a")).toBe(true);
    restorePages(store, [page]);
    expect(store.blocks.get(page)?.trashedAt).toBeUndefined();
    expect(boardObjectsOf(store, page).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("Duplizieren der Seite kopiert die Objekte mit neuen IDs", () => {
    const store = newStore();
    const page = createBoardPage(store, { title: "Board" });
    put(store, page, [note("a", 0, 0, "a0", { text: "one" }), note("b", 200, 0, "a1", { text: "two" })]);
    const [copy] = duplicatePages(store, [page]);
    expect(isBoardPage(store.blocks.get(copy!))).toBe(true);
    const copied = boardObjectsOf(store, copy!);
    expect(copied.map((o) => (o.kind === "connector" ? "" : o.text))).toEqual(["one", "two"]);
    expect(copied.some((o) => o.id === "a" || o.id === "b")).toBe(false);
    expect(boardObjectsOf(store, page)).toHaveLength(2);
  });

  it("Based-Archiv: Export und Import in einen leeren Workspace bringen das Board vollständig zurück", () => {
    const store = newStore();
    const page = createBoardPage(store, { title: "Board" });
    const ink = encodeInk([{ x: 0, y: 0, p: 0.5 }, { x: 3, y: 4, p: 0.5 }]);
    const objs = [note("a", 0, 0, "a0", { text: "one" }), parseWBObject({ id: "i", kind: "ink", x: 0, y: 0, w: 3, h: 4, z: "a1", ink })!];
    put(store, page, objs);
    const read = readArchive(writeArchive(store));
    const other = newStore();
    applyImported(other, read.records);
    expect(isBoardPage(other.blocks.get(page))).toBe(true);
    const back = boardObjectsOf(other, page);
    expect(back).toHaveLength(2);
    expect(sameBoardObject(back[0], objs[0])).toBe(true);
    expect(sameBoardObject(back[1], objs[1])).toBe(true);
  });

  it("Suche findet den Text eines Zettels auf der Board-Seite; Markdown- und HTML-Export brechen nicht", () => {
    const store = newStore();
    const { index, dispose } = attachSearchIndex(store);
    const page = createBoardPage(store, { title: "Board" });
    put(store, page, [note("a", 0, 0, "a0", { text: "heteroskedasticity check" })]);
    expect(index.search("heteroskedasticity").some((h) => h.pageID === page)).toBe(true);
    dispose();
    expect(typeof blocksToMarkdown(store, store.children("b:" + page))).toBe("string");
    expect(new TextDecoder().decode(exportPageHTML(store, page).data)).toContain("Board");
  });
});
