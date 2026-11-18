// BSD-264 (Whiteboard 2): Bedienung der Board-Fläche ohne DOM – Zeiger, Rad und Tasten gegen den Controller.
import { describe, expect, it } from "vitest";
import { boardObjectFromBlock, boardObjectToBlock, createBoardPage, MemoryPersistence, parseWBObject, WorkspaceStore, type WBObject } from "@based/core";
import { BoardController, describeObject, minimapTransform, NOTE_SIZE } from "../src/whiteboard/controller.js";
import { wrapText as wrapTextForTest } from "../src/whiteboard/render.js";
import { BoardSession } from "../src/whiteboard/session.js";

const note = (id: string, x = 0, y = 0, z = "a0", extra: Record<string, unknown> = {}): WBObject =>
  parseWBObject({ id, kind: "note", x, y, w: 100, h: 80, z, ...extra })!;

function setup(objs: WBObject[] = [], camera = { x: 0, y: 0, zoom: 1 }) {
  let t = 1000;
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => t++ });
  const page = createBoardPage(store, { title: "Board" });
  if (objs.length) store.transact("seed", (tx) => { for (const o of objs) tx.put({ kind: "block", data: boardObjectToBlock(o, page, store.now()) }); });
  const session = new BoardSession(store, page);
  let n = 0;
  const ctl = new BoardController(session, { newID: () => "new" + n++, camera });
  ctl.setViewport({ w: 800, h: 600 });
  const drag = (from: [number, number], to: [number, number], mods: { shift?: boolean; alt?: boolean } = {}) => {
    ctl.pointerDown({ x: from[0], y: from[1], button: 0, ...mods });
    ctl.pointerMove({ x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, ...mods });
    ctl.pointerMove({ x: to[0], y: to[1], ...mods });
    ctl.pointerUp({ x: to[0], y: to[1], ...mods });
  };
  const click = (x: number, y: number, mods: { shift?: boolean } = {}) => { ctl.pointerDown({ x, y, button: 0, ...mods }); ctl.pointerUp({ x, y, ...mods }); };
  const at = (id: string) => { const o = boardObjectFromBlock(store.blocks.get(id)!)!; return o.kind === "connector" ? undefined : { x: o.x, y: o.y, w: o.w, h: o.h }; };
  return { store, page, session, ctl, drag, click, at };
}

describe("Board-Bedienung", () => {
  it("Klick wählt, ⇧-Klick erweitert und nimmt wieder heraus, Klick ins Leere löst", () => {
    const { ctl, click } = setup([note("a"), note("b", 300, 0, "a1")]);
    click(50, 40);
    expect([...ctl.selection]).toEqual(["a"]);
    expect(ctl.announcement).toBe("Sticky note, 1 of 2");
    click(350, 40, { shift: true });
    expect([...ctl.selection].sort()).toEqual(["a", "b"]);
    expect(ctl.announcement).toBe("2 objects selected");
    click(350, 40, { shift: true });
    expect([...ctl.selection]).toEqual(["a"]);
    click(700, 500);
    expect(ctl.selection.size).toBe(0);
  });

  it("Ziehen verschiebt die Auswahl: Vorschau während der Geste, ein Schritt beim Loslassen", () => {
    const { ctl, session, store, at } = setup([note("a"), note("b", 300, 0, "a1")]);
    let writes = 0;
    store.observe(() => { writes += 1; });
    ctl.pointerDown({ x: 50, y: 40, button: 0 });
    ctl.pointerMove({ x: 52, y: 41 }); // unter der Schwelle: noch kein Ziehen
    expect(ctl.scene().objects.find((o) => o.id === "a")).toMatchObject({ x: 0 });
    ctl.pointerMove({ x: 150, y: 90 });
    expect(ctl.scene().objects.find((o) => o.id === "a")).toMatchObject({ x: 100, y: 50 });
    expect(ctl.scene().handles).toBe(false);
    expect(writes).toBe(0);
    expect(at("a")).toMatchObject({ x: 0, y: 0 });
    ctl.pointerUp({ x: 150, y: 90 });
    expect(writes).toBe(1);
    expect(at("a")).toMatchObject({ x: 100, y: 50 });
    expect(at("b")).toMatchObject({ x: 300 });
    session.undo();
    expect(at("a")).toMatchObject({ x: 0, y: 0 });
  });

  it("Ziehen bei anderem Zoom rechnet in Weltkoordinaten", () => {
    const { drag, at } = setup([note("a")], { x: -100, y: -100, zoom: 2 });
    // a liegt auf dem Bildschirm bei (200…400, 200…360)
    drag([250, 250], [350, 290]);
    expect(at("a")).toMatchObject({ x: 50, y: 20 });
  });

  it("Esc bricht eine Geste ab: nichts wird übernommen", () => {
    const { ctl, at } = setup([note("a")]);
    ctl.pointerDown({ x: 50, y: 40, button: 0 });
    ctl.pointerMove({ x: 250, y: 240 });
    expect(ctl.keyDown({ key: "Escape" })).toBe(true);
    expect(ctl.busy).toBe(false);
    ctl.pointerUp({ x: 250, y: 240 });
    expect(at("a")).toMatchObject({ x: 0, y: 0 });
    expect(ctl.scene().objects.find((o) => o.id === "a")).toMatchObject({ x: 0 });
  });

  it("⌥-Ziehen dupliziert: Original bleibt, Kopie ist gewählt, Undo nimmt nur die Kopie", () => {
    const { ctl, session, drag, at } = setup([note("a", 0, 0, "a0", { text: "hi" })]);
    drag([50, 40], [250, 140], { alt: true });
    expect(session.objects).toHaveLength(2);
    expect(at("a")).toMatchObject({ x: 0, y: 0 });
    const copy = [...ctl.selection][0]!;
    expect(copy).not.toBe("a");
    expect(session.get(copy)).toMatchObject({ x: 200, y: 100, text: "hi" });
    session.undo();
    expect(session.objects.map((o) => o.id)).toEqual(["a"]);
    expect(ctl.selection.size).toBe(0);
  });

  it("Aufziehen im Leeren wählt, was das Rechteck berührt; ⇧ behält die bisherige Auswahl", () => {
    const { ctl, drag, click } = setup([note("a"), note("b", 300, 0, "a1"), note("c", 0, 300, "a2")]);
    drag([450, 150], [90, 10]);
    expect([...ctl.selection].sort()).toEqual(["a", "b"]);
    expect(ctl.scene().marquee).toBeUndefined();
    click(700, 550);
    click(50, 340);
    drag([450, 150], [250, 10], { shift: true });
    expect([...ctl.selection].sort()).toEqual(["b", "c"]);
  });

  it("Griff ziehen ändert die Größe; ⇧ hält das Verhältnis; mehrere Objekte skalieren gemeinsam", () => {
    const { ctl, click, drag, at } = setup([note("a"), note("b", 100, 0, "a1")]);
    click(50, 40);
    // Griff unten rechts von a: (100, 80)
    drag([100, 80], [150, 100]);
    expect(at("a")).toEqual({ x: 0, y: 0, w: 150, h: 100 });
    drag([150, 100], [250, 100], { shift: true });
    const r = at("a")!;
    expect(r.w / r.h).toBeCloseTo(1.5, 1);
    ctl.selectAll();
    const before = [at("a")!, at("b")!];
    const sel = ctl.scene().selectionBounds!;
    drag([sel.x + sel.w, sel.y + sel.h / 2], [sel.x + sel.w * 2, sel.y + sel.h / 2]);
    expect(at("a")!.w).toBe(before[0]!.w * 2);
    expect(at("b")!.x).toBe(before[1]!.x * 2);
  });

  it("Zettel-Werkzeug: Klick legt einen Zettel in Standardgröße an, Ziehen einen in eigener Größe; danach Auswählen", () => {
    const { ctl, session, click, drag } = setup();
    expect(ctl.keyDown({ key: "n" })).toBe(true);
    expect(ctl.tool).toBe("note");
    click(400, 300);
    expect(ctl.tool).toBe("select");
    const first = session.objects[0]!;
    expect(first).toMatchObject({ kind: "note", x: 400 - NOTE_SIZE.w / 2, y: 300 - NOTE_SIZE.h / 2, ...NOTE_SIZE, style: { color: "blue" } });
    expect([...ctl.selection]).toEqual([first.id]);
    ctl.setTool("shape");
    drag([10, 10], [210, 110]);
    expect(session.objects[1]).toMatchObject({ kind: "shape", x: 10, y: 10, w: 200, h: 100 });
    expect(session.objects[1]!.z > first.z).toBe(true);
    ctl.keyDown({ key: "n" });
    expect(ctl.keyDown({ key: "Enter" })).toBe(true); // ohne Maus: in die Mitte
    expect(session.objects).toHaveLength(3);
    expect(session.objects[2]).toMatchObject({ style: { color: "pink" } });
    session.undo(); session.undo(); session.undo();
    expect(session.objects).toHaveLength(0);
  });

  it("Tasten: Pfeile schieben (⇧ = 10), Entf löscht, ⌘A/⌘D, ⌘Z/⇧⌘Z, Werkzeuge V/H/N/R", () => {
    const { ctl, session, at, click } = setup([note("a"), note("b", 300, 0, "a1")]);
    click(50, 40);
    ctl.keyDown({ key: "ArrowRight" });
    ctl.keyDown({ key: "ArrowDown", shift: true });
    expect(at("a")).toMatchObject({ x: 1, y: 10 });
    ctl.keyDown({ key: "z", mod: true });
    expect(at("a")).toMatchObject({ x: 1, y: 0 });
    ctl.keyDown({ key: "z", mod: true, shift: true });
    expect(at("a")).toMatchObject({ x: 1, y: 10 });
    ctl.keyDown({ key: "a", mod: true });
    expect(ctl.selection.size).toBe(2);
    ctl.keyDown({ key: "d", mod: true });
    expect(session.objects).toHaveLength(4);
    expect(ctl.selection.size).toBe(2);
    expect(ctl.keyDown({ key: "Backspace" })).toBe(true);
    expect(session.objects).toHaveLength(2);
    expect(ctl.keyDown({ key: "Delete" })).toBe(false); // nichts gewählt: Taste nicht verschlucken
    for (const [key, tool] of [["h", "hand"], ["r", "shape"], ["N", "note"], ["v", "select"]] as const) {
      ctl.keyDown({ key });
      expect(ctl.tool).toBe(tool);
    }
    expect(ctl.keyDown({ key: "x" })).toBe(false);
    expect(ctl.keyDown({ key: "k", mod: true })).toBe(false); // ⌘K gehört der App
    expect(ctl.keyDown({ key: "1", mod: true })).toBe(false); // ⌘1–9 wählen Tabs
  });

  it("Tab läuft in Leserichtung durch die Objekte, holt sie ins Bild und gibt den Fokus am Ende frei", () => {
    const { ctl } = setup([note("far", 5000, 0, "a0"), note("a", 0, 0, "a1"), note("below", 0, 400, "a2")]);
    expect(ctl.keyDown({ key: "Tab" })).toBe(true);
    expect([...ctl.selection]).toEqual(["a"]);
    expect(ctl.scene().focused).toBe("a");
    ctl.keyDown({ key: "Tab" });
    expect([...ctl.selection]).toEqual(["far"]);
    const v = ctl.visible();
    expect(v.x + v.w).toBeGreaterThan(5100);
    ctl.keyDown({ key: "Tab" });
    expect([...ctl.selection]).toEqual(["below"]);
    expect(ctl.keyDown({ key: "Tab" })).toBe(false);
    expect(ctl.selection.size).toBe(0);
    expect(ctl.keyDown({ key: "Tab", shift: true })).toBe(true);
    expect([...ctl.selection]).toEqual(["below"]);
    ctl.pointerDown({ x: 1, y: 1, button: 0 }); // Zeiger übernimmt: kein Fokusrahmen mehr
    expect(ctl.scene().focused).toBeUndefined();
  });

  it("Kamera: erstes Layout passt den Inhalt ein; Rad verschiebt, mit ⌘ zoomt es um den Zeiger; Hand und Leertaste ziehen", () => {
    let t = 1;
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "l", now: () => t++ });
    const page = createBoardPage(store);
    store.transact("seed", (tx) => { for (const o of [note("a", 2000, 2000), note("b", 4000, 3000, "a1")]) tx.put({ kind: "block", data: boardObjectToBlock(o, page, 1) }); });
    const ctl = new BoardController(new BoardSession(store, page));
    ctl.setViewport({ w: 800, h: 600 });
    const v = ctl.visible();
    expect(v.x).toBeLessThan(2000);
    expect(v.x + v.w).toBeGreaterThan(4100);
    expect(ctl.camera.zoom).toBeLessThan(1);
    expect(ctl.laidOut).toBe(true);
    ctl.zoomReset();
    expect(ctl.camera.zoom).toBe(1);
    const before = ctl.camera;
    ctl.wheel({ x: 400, y: 300, deltaX: 30, deltaY: 50, zoom: false });
    expect(ctl.camera).toMatchObject({ x: before.x + 30, y: before.y + 50, zoom: 1 });
    ctl.wheel({ x: 400, y: 300, deltaX: 0, deltaY: -50, zoom: true });
    expect(ctl.camera.zoom).toBeGreaterThan(1);
    ctl.keyDown({ key: "0", mod: true });
    expect(ctl.camera.zoom).toBeLessThan(1);
    ctl.keyDown({ key: "=", mod: true });
    ctl.keyDown({ key: "-", mod: true });
    const cam = ctl.camera;
    ctl.keyDown({ key: " " });
    expect(ctl.cursorAt({ x: 10, y: 10 })).toBe("grab");
    ctl.pointerDown({ x: 100, y: 100, button: 0 });
    expect(ctl.panning).toBe(true);
    ctl.pointerMove({ x: 150, y: 80 });
    ctl.pointerUp({ x: 150, y: 80 });
    ctl.keyUp({ key: " " });
    expect(ctl.camera.x).toBeCloseTo(cam.x - 50 / cam.zoom, 6);
    expect(ctl.camera.y).toBeCloseTo(cam.y + 20 / cam.zoom, 6);
    expect(ctl.selection.size).toBe(0);
    ctl.pointerDown({ x: 100, y: 100, button: 1 }); // mittlere Taste
    expect(ctl.panning).toBe(true);
    ctl.blur();
    expect(ctl.busy).toBe(false);
  });

  it("gemerkte Kamera bleibt (Tab-Wechsel), statt neu einzupassen", () => {
    const { ctl } = setup([note("a", 5000, 5000)], { x: 10, y: 20, zoom: 0.5 });
    expect(ctl.camera).toEqual({ x: 10, y: 20, zoom: 0.5 });
  });

  it("Szene: nur Sichtbares; Verbindungen folgen dem gezogenen Objekt schon in der Vorschau", () => {
    const k = parseWBObject({ id: "k", kind: "connector", from: { id: "a" }, to: { id: "b" }, z: "a5" })!;
    const { ctl } = setup([note("a"), note("b", 300, 0, "a1"), note("off", 9000, 9000, "a2"), k]);
    expect(ctl.scene().objects.map((o) => o.id)).toEqual(["a", "b", "k"]);
    ctl.pointerDown({ x: 350, y: 40, button: 0 });
    ctl.pointerMove({ x: 350, y: 440 });
    const scene = ctl.scene();
    expect(scene.byID.get("b")).toMatchObject({ y: 400 });
    expect(scene.objects.map((o) => o.id)).toEqual(["a", "b", "k"]);
    expect(scene.selectionBounds).toMatchObject({ x: 300, y: 400 });
    ctl.cancel();
    expect(ctl.scene()).toBe(ctl.scene()); // gleiche Szene, solange sich nichts ändert
  });

  it("Rechtsklick wählt das Objekt unter dem Zeiger, ohne eine Geste zu beginnen", () => {
    const { ctl } = setup([note("a"), note("b", 300, 0, "a1")]);
    ctl.pointerDown({ x: 350, y: 40, button: 2 });
    expect([...ctl.selection]).toEqual(["b"]);
    expect(ctl.busy).toBe(false);
  });

  it("was von anderswo gelöscht wird, fällt aus der Auswahl", () => {
    const { ctl, store, click } = setup([note("a")]);
    click(50, 40);
    store.applyRemote([], ["block:a"]);
    expect(ctl.selection.size).toBe(0);
  });

  it("nach vorn / nach hinten über ⌥⌘] und ⌥⌘[", () => {
    const { ctl, session, click } = setup([note("a"), note("b", 300, 0, "a1")]);
    click(50, 40);
    expect(ctl.keyDown({ key: "]", mod: true, alt: true })).toBe(true);
    expect(session.objects.map((o) => o.id)).toEqual(["b", "a"]);
    ctl.keyDown({ key: "[", mod: true, alt: true });
    expect(session.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(ctl.keyDown({ key: "]", mod: true })).toBe(false); // ⌘] bleibt „Vor“ der App
  });

  it("schreibgeschützt: wählen und bewegen der Kamera ja, ändern nein", () => {
    const { ctl, store, session, drag, click } = setup([note("a")]);
    ctl.setTool("note");
    session.setLocked(true); // Seite im Papierkorb / gesperrt
    expect(ctl.tool).toBe("select");
    expect(ctl.readOnly).toBe(true);
    session.setLocked(false);
    Object.defineProperty(store, "isReadOnly", { get: () => true }); // Speichern gescheitert
    click(50, 40);
    expect(ctl.selection.size).toBe(1);
    expect(ctl.scene().handles).toBe(false);
    drag([50, 40], [250, 240]);
    expect(session.get("a")).toMatchObject({ x: 0 });
    ctl.setTool("note");
    expect(ctl.tool).toBe("select");
    expect(ctl.keyDown({ key: "Backspace" })).toBe(false);
    expect(ctl.hint).toMatch(/^Read only/);
  });

  it("Namen für Screenreader, Minimap-Abbildung, Textumbruch", () => {
    expect(describeObject(note("a", 0, 0, "a0", { text: "Check residuals" }))).toBe("Sticky note: Check residuals");
    expect(describeObject(parseWBObject({ id: "s", kind: "shape" })!)).toBe("Shape");
    const t = minimapTransform({ x: 0, y: 0, w: 1000, h: 500 }, { x: 0, y: 0, w: 500, h: 500 }, { w: 148, h: 92 });
    expect(t.scale).toBeCloseTo(132 / 1000, 6);
    expect(1000 * t.scale + t.x).toBeLessThanOrEqual(148 - 8 + 1e-6);
    const measure = (s: string) => s.length * 10;
    expect(wrapTextForTest(measure, "one two three", 70)).toEqual(["one two", "three"]);
    expect(wrapTextForTest(measure, "abcdefghijklmno", 50)).toEqual(["abcde", "fghij", "klmno"]);
    expect(wrapTextForTest(measure, "a\n\nb", 50)).toEqual(["a", "", "b"]);
  });
});
