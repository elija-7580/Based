// @vitest-environment jsdom
// BSD-265–267 (Whiteboard 3–5): Stift, Textmarker, Radierer, Lasso, Text, Frame, Verbindung – über den Controller,
// ohne DOM-Fläche. Geprüft wird, was in der Sitzung (und damit in den Records) ankommt.
import { describe, expect, it } from "vitest";
import { createBoardPage, inkPointsOf, MemoryPersistence, WorkspaceStore, type WBConnector, type WBShape } from "@based/core";
import { BoardController } from "../src/whiteboard/controller.js";
import { inkOutline } from "../src/whiteboard/render.js";
import { BoardSession } from "../src/whiteboard/session.js";

function setup() {
  let clock = 1;
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => clock++ });
  const page = createBoardPage(store);
  const session = new BoardSession(store, page);
  let n = 0, t = 0;
  const ctl = new BoardController(session, { newID: () => `o${++n}`, camera: { x: 0, y: 0, zoom: 1 }, now: () => t });
  ctl.setViewport({ w: 1000, h: 700 });
  return { store, page, session, ctl, tick: (ms: number) => { t += ms; } };
}
type C = ReturnType<typeof setup>["ctl"];
function drag(ctl: C, pts: [number, number][], extra: Record<string, unknown> = {}) {
  ctl.pointerDown({ x: pts[0]![0], y: pts[0]![1], button: 0, ...extra });
  for (const [x, y] of pts.slice(1)) ctl.pointerMove({ x, y, ...extra });
  const last = pts[pts.length - 1]!;
  ctl.pointerUp({ x: last[0], y: last[1], ...extra });
}
const click = (ctl: C, x: number, y: number) => drag(ctl, [[x, y]]);
const wave = (x0: number, y: number, n = 60): [number, number][] => Array.from({ length: n }, (_, i) => [x0 + i * 4, y + Math.sin(i / 5) * 20]);
const shapes = (s: BoardSession) => s.objects as WBShape[];

describe("Stift", () => {
  it("ein Strich wird ein Tinten-Objekt: ausgedünnt, relativ zum Rahmen, ein Undo-Schritt", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    drag(ctl, wave(100, 300));
    expect(session.objects).toHaveLength(1);
    const ink = shapes(session)[0]!;
    expect(ink.kind).toBe("ink");
    expect(ink.style).toMatchObject({ color: "ink", width: 2.6, sim: true });
    const pts = inkPointsOf(ink.ink!);
    expect(pts.length).toBeGreaterThan(5);
    expect(pts.length).toBeLessThan(60);
    expect(ink.x).toBeLessThanOrEqual(100);
    expect(ink.x + ink.w).toBeGreaterThanOrEqual(336);
    expect(ctl.tool).toBe("pen"); // weiterzeichnen ohne neu zu wählen
    ctl.undo();
    expect(session.objects).toHaveLength(0);
  });
  it("Stiftdruck kommt an, der Strich gilt dann nicht als simuliert", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    ctl.pointerDown({ x: 100, y: 100, button: 0, pressure: 0.2 });
    ctl.pointerMove({ x: 150, y: 100, pressure: 0.9 });
    ctl.pointerMove({ x: 200, y: 140, pressure: 0.4 });
    ctl.pointerUp({ x: 200, y: 140, pressure: 0.4 });
    const ink = shapes(session)[0]!;
    expect(ink.style?.sim).toBeUndefined();
    expect(Math.max(...inkPointsOf(ink.ink!).map((p) => p.p))).toBeCloseTo(0.9, 1);
  });
  it("der laufende Strich ist sichtbar, ohne dass die fertige Fläche neu gezeichnet werden muss", () => {
    const { ctl } = setup();
    ctl.setTool("pen");
    ctl.pointerDown({ x: 10, y: 10, button: 0 });
    const v = ctl.version, iv = ctl.inkVersion;
    ctl.pointerMove({ x: 40, y: 30 });
    expect(ctl.liveInk?.points).toHaveLength(2);
    expect(ctl.version).toBe(v);
    expect(ctl.inkVersion).toBeGreaterThan(iv);
    ctl.cancel();
    expect(ctl.liveInk).toBeUndefined();
  });
  it("Farbe und Stärke gelten je Werkzeug; der Textmarker merkt sich seine eigenen", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    ctl.setInkStyle({ color: "red", width: 2 });
    ctl.setTool("highlighter");
    ctl.setInkStyle({ color: "mint" });
    drag(ctl, wave(100, 200));
    ctl.setTool("pen");
    drag(ctl, wave(100, 400));
    const [hl, pen] = shapes(session);
    expect(hl!.style).toMatchObject({ tool: "hl", color: "mint", width: 16 });
    expect(pen!.style).toMatchObject({ color: "red", width: 4.4 });
  });
  it("Umriss: mittlerer Druck ergibt ungefähr die gewählte Stärke", () => {
    const o = inkOutline(Array.from({ length: 40 }, (_, i) => ({ x: i * 5, y: 0, p: 0.5 })), 4, false);
    const ys = o.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
  });
  it("nur lesen: kein Strich", () => {
    const { ctl, session } = setup();
    session.setLocked(true);
    ctl.setTool("pen");
    expect(ctl.tool).toBe("select");
  });
});

describe("Radierer und Lasso", () => {
  it("Radierer nimmt nur die Linien, über die gerieben wird – ein Undo holt sie zurück", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    drag(ctl, wave(100, 200));
    drag(ctl, wave(100, 500));
    ctl.setTool("eraser");
    drag(ctl, [[180, 150], [180, 200], [180, 250]]);
    expect(session.objects).toHaveLength(1);
    expect(shapes(session)[0]!.y).toBeGreaterThan(400);
    ctl.undo();
    expect(session.objects).toHaveLength(2);
  });
  it("umgedrehter Stift radiert, auch wenn der Stift gewählt ist", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    drag(ctl, wave(100, 200));
    drag(ctl, [[180, 150], [180, 200], [180, 250]], { eraser: true, pressure: 0.5 });
    expect(session.objects).toHaveLength(0);
  });
  it("Lasso wählt, was es umschließt, und übergibt an das Auswahl-Werkzeug", () => {
    const { ctl, session } = setup();
    ctl.setTool("pen");
    drag(ctl, wave(100, 200, 20));
    drag(ctl, wave(600, 500, 20));
    ctl.setTool("lasso");
    drag(ctl, [[60, 140], [240, 140], [240, 260], [60, 260], [60, 140]]);
    expect(ctl.selection.size).toBe(1);
    expect(ctl.tool).toBe("select");
    expect(session.get([...ctl.selection][0]!)).toMatchObject({ kind: "ink" });
  });
});

describe("Text", () => {
  it("Text-Werkzeug: das Objekt entsteht erst mit dem Text; leer bleibt die Fläche leer", () => {
    const { ctl, session } = setup();
    ctl.setTool("text");
    click(ctl, 300, 300);
    expect(ctl.editing).toMatchObject({ id: undefined, kind: "text" });
    ctl.commitEdit("   ");
    expect(session.objects).toHaveLength(0);
    ctl.setTool("text");
    click(ctl, 300, 300);
    ctl.commitEdit("Least squares", { height: 52 });
    expect(shapes(session)[0]).toMatchObject({ kind: "text", text: "Least squares", h: 52, x: 300 });
    ctl.undo();
    expect(session.objects).toHaveLength(0);
  });
  it("Doppelklick ins Leere tippt los, ohne das Text-Werkzeug zu wählen", () => {
    const { ctl, tick } = setup();
    click(ctl, 400, 200);
    expect(ctl.editing).toBeUndefined();
    tick(200);
    click(ctl, 401, 201);
    expect(ctl.editing).toMatchObject({ kind: "text" });
  });
  it("zwei langsame Klicks sind kein Doppelklick", () => {
    const { ctl, tick } = setup();
    click(ctl, 400, 200);
    tick(900);
    click(ctl, 400, 200);
    expect(ctl.editing).toBeUndefined();
  });
  it("neuer Zettel nimmt sofort Text; Tab legt den nächsten daneben an", () => {
    const { ctl, session } = setup();
    ctl.setTool("note");
    click(ctl, 300, 300);
    expect(ctl.editing).toMatchObject({ kind: "note" });
    ctl.commitEdit("first", { next: true });
    expect(session.objects).toHaveLength(2);
    const [a, b] = shapes(session);
    expect(a!.text).toBe("first");
    expect(b!.x).toBe(a!.x + a!.w + 16);
    expect(ctl.editing?.id).toBe(b!.id);
  });
  it("Enter auf einem gewählten Zettel bearbeitet; ein geleertes Text-Objekt verschwindet", () => {
    const { ctl, session } = setup();
    ctl.setTool("text");
    click(ctl, 100, 100);
    const id = ctl.commitEdit("hello")!;
    expect(ctl.keyDown({ key: "Enter" })).toBe(true);
    expect(ctl.editing?.id).toBe(id);
    ctl.commitEdit("");
    expect(session.objects).toHaveLength(0);
  });
});

describe("Formen, Frame, Verbindung", () => {
  it("O und D wählen Oval und Raute", () => {
    const { ctl, session } = setup();
    ctl.keyDown({ key: "o" });
    click(ctl, 200, 200);
    ctl.keyDown({ key: "d" });
    click(ctl, 500, 200);
    expect(shapes(session).map((o) => o.style?.shape)).toEqual(["oval", "diamond"]);
  });
  it("⇧P wählt den Textmarker, P den Stift", () => {
    const { ctl } = setup();
    ctl.keyDown({ key: "P", shift: true });
    expect(ctl.tool).toBe("highlighter");
    ctl.keyDown({ key: "p" });
    expect(ctl.tool).toBe("pen");
  });
  it("ein Frame liegt hinten und nimmt beim Verschieben mit, was ganz in ihm liegt", () => {
    const { ctl, session } = setup();
    ctl.setTool("note");
    click(ctl, 300, 300);
    ctl.commitEdit("in");
    ctl.setTool("note");
    click(ctl, 850, 300);
    ctl.commitEdit("out");
    ctl.setTool("frame");
    drag(ctl, [[150, 150], [300, 300], [500, 480]]);
    const frame = shapes(session).find((o) => o.kind === "frame")!;
    expect(session.objects[0]!.id).toBe(frame.id);
    // Am Titel greifen und 100 nach rechts ziehen
    drag(ctl, [[200, 165], [250, 165], [300, 165]]);
    const byText = (t: string) => shapes(session).find((o) => o.text === t)!;
    expect(shapes(session).find((o) => o.kind === "frame")!.x).toBe(frame.x + 100);
    expect(byText("in").x).toBe(300 - 84 + 100);
    expect(byText("out").x).toBe(850 - 84);
  });
  it("Verbindung von Objekt zu Objekt; ins Leere gezogen entsteht nichts; mit dem Ziel verschwindet sie", () => {
    const { ctl, session } = setup();
    ctl.setTool("note");
    click(ctl, 200, 300);
    ctl.commitEdit("a");
    ctl.setTool("note");
    click(ctl, 600, 300);
    ctl.commitEdit("b");
    ctl.setTool("connector");
    drag(ctl, [[200, 300], [400, 320], [420, 600]]);
    expect(session.objects).toHaveLength(2);
    drag(ctl, [[200, 300], [400, 320], [600, 300]]);
    const c = session.objects.find((o) => o.kind === "connector") as WBConnector;
    expect(c.from.id).not.toBe(c.to.id);
    ctl.setTool("select");
    click(ctl, 600, 300);
    ctl.deleteSelection();
    expect(session.objects.map((o) => o.kind)).toEqual(["note"]);
  });
});

describe("Dateien", () => {
  it("Bild in seiner Form (auf 480 begrenzt), andere Datei als Karte; nur Adresse und Angaben im Objekt; ein Undo", () => {
    const { ctl, session } = setup();
    const ids = ctl.addFiles([
      { ref: "based-asset:aaa", name: "board.jpg", mime: "image/jpeg", size: 2_400_000, width: 4000, height: 3000 },
      { ref: "based-asset:bbb", name: "data.bin", mime: "application/octet-stream", size: 5120 },
    ], { x: 500, y: 300 });
    expect(ids).toHaveLength(2);
    const [img, file] = shapes(session);
    expect(img).toMatchObject({ kind: "image", w: 480, h: 360, ref: "based-asset:aaa", x: 260, y: 120 });
    expect(file).toMatchObject({ kind: "file", w: 264, h: 72, ref: "based-asset:bbb", style: { name: "data.bin", mime: "application/octet-stream", size: 5120 } });
    expect(file!.y).toBe(img!.y + img!.h + 16);
    expect(ctl.selection.size).toBe(2);
    ctl.undo();
    expect(session.objects).toHaveLength(0);
  });
  it("Bild ohne lesbare Maße wird eine Dateikarte; nur lesen legt nichts ab", () => {
    const { ctl, session } = setup();
    ctl.addFiles([{ ref: "based-asset:ccc", name: "logo.svg", mime: "image/svg+xml", size: 900 }]);
    expect(shapes(session)[0]!.kind).toBe("file");
    session.setLocked(true);
    expect(ctl.addFiles([{ ref: "based-asset:ddd", name: "x.pdf", mime: "application/pdf", size: 1 }])).toEqual([]);
  });
  it("Doppelklick auf eine Datei öffnet sie (statt Text zu bearbeiten)", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => 1 });
    const session = new BoardSession(store, createBoardPage(store));
    let t = 0, n = 0;
    const opened: string[] = [];
    const ctl = new BoardController(session, { newID: () => `f${++n}`, camera: { x: 0, y: 0, zoom: 1 }, now: () => t, onOpenFile: (o) => opened.push(o.ref ?? "") });
    ctl.setViewport({ w: 1000, h: 700 });
    ctl.addFiles([{ ref: "based-asset:eee", name: "notes.pdf", mime: "application/pdf", size: 10 }], { x: 300, y: 300 });
    click(ctl, 300, 300);
    t += 150;
    click(ctl, 300, 300);
    expect(opened).toEqual(["based-asset:eee"]);
    expect(ctl.editing).toBeUndefined();
  });
});

describe("Dateien in drei Stufen", () => {
  it("PDF wird ein Ausdruck: je Seite ein Objekt in ihrer Form, untereinander; ein Undo nimmt alle", () => {
    const { ctl, session } = setup();
    ctl.addFiles([{ ref: "based-asset:pdf", name: "slides.pdf", mime: "application/pdf", size: 90_000, pages: [{ width: 595, height: 842 }, { width: 842, height: 595 }] }], { x: 500, y: 300 });
    const [a, b] = shapes(session);
    expect(a).toMatchObject({ kind: "file", w: 560, h: 792, style: { view: "pdf", page: 1, pages: 2 } });
    expect(b).toMatchObject({ w: 560, h: 396, style: { page: 2 } });
    expect(b!.y).toBe(a!.y + a!.h + 16);
    ctl.undo();
    expect(session.objects).toHaveLength(0);
  });
  it("PDF ohne lesbare Seiten bleibt eine Dateikarte", () => {
    const { ctl, session } = setup();
    ctl.addFiles([{ ref: "based-asset:x", name: "locked.pdf", mime: "application/pdf", size: 1 }]);
    expect(shapes(session)[0]).toMatchObject({ w: 264, h: 72 });
    expect(shapes(session)[0]!.style?.view).toBeUndefined();
  });
  it("Agent-Log, HTML, Video und Audio bekommen eine Vorschau; Unbekanntes eine Karte", () => {
    const { ctl, session } = setup();
    ctl.addFiles([
      { ref: "r1", name: "session.jsonl", mime: "", size: 10 }, { ref: "r2", name: "report.html", mime: "text/html", size: 10 },
      { ref: "r3", name: "clip.mp4", mime: "video/mp4", size: 10 }, { ref: "r4", name: "memo.m4a", mime: "audio/mp4", size: 10 }, { ref: "r5", name: "data.xlsx", mime: "application/zip", size: 10 },
    ]);
    expect(shapes(session).map((o) => o.style?.view)).toEqual(["text", "html", "video", "audio", undefined]);
    expect(shapes(session)[0]).toMatchObject({ w: 440, h: 320 });
  });
  it("Lasso um Handschrift auf einer PDF-Seite nimmt die Seite nicht mit", () => {
    const { ctl } = setup();
    ctl.addFiles([{ ref: "p", name: "a.pdf", mime: "application/pdf", size: 1, pages: [{ width: 200, height: 200 }] }], { x: 500, y: 350 });
    ctl.setTool("pen");
    drag(ctl, wave(420, 350, 30));
    ctl.setTool("lasso");
    drag(ctl, [[150, 20], [850, 20], [850, 680], [150, 680], [150, 20]]);
    expect(ctl.selection.size).toBe(1);
  });
  it("eingefügter Text wird ein Text-Objekt in der Mitte", () => {
    const { ctl, session } = setup();
    ctl.addText("line one\r\nline two  \n");
    expect(shapes(session)[0]).toMatchObject({ kind: "text", text: "line one\nline two", h: 52, x: 340 });
  });
});

describe("Sperren, Untergrund, Seitenkarte", () => {
  it("PDF-Seiten liegen fest: Klick und Aufziehen greifen hindurch; ⌘A wählt sie, Entsperren macht sie greifbar", () => {
    const { ctl, session } = setup();
    ctl.addFiles([{ ref: "p", name: "a.pdf", mime: "application/pdf", size: 1, pages: [{ width: 300, height: 300 }] }], { x: 500, y: 350 });
    ctl.clearSelection();
    click(ctl, 500, 350);
    expect(ctl.selection.size).toBe(0);
    drag(ctl, [[100, 20], [600, 300], [900, 680]]);
    expect(ctl.selection.size).toBe(0);
    ctl.selectAll();
    expect(ctl.selectionLocked).toBe(true);
    expect(ctl.setLocked(false)).toBe(true);
    ctl.clearSelection();
    click(ctl, 500, 350);
    expect(ctl.selection.size).toBe(1);
    expect(shapes(session)[0]!.style?.locked).toBe(false);
  });
  it("Untergrund steht an der Seite und überlebt eine neue Sitzung", () => {
    const { store, page, session, ctl } = setup();
    expect(ctl.scene().background).toBe("dots");
    expect(session.setBackground("lines")).toBe(true);
    expect(ctl.scene().background).toBe("lines");
    expect(new BoardSession(store, page).background).toBe("lines");
    session.setLocked(true);
    expect(session.setBackground("grid")).toBe(false);
  });
  it("Seitenkarte trägt die Seite und ihren Titel", () => {
    const { ctl, session } = setup();
    const id = ctl.addPage("page-1", "Lecture 5")!;
    expect(session.get(id)).toMatchObject({ kind: "page", ref: "page-1", text: "Lecture 5", w: 240 });
  });
});
