// BSD-264 (Whiteboard 2): Bedienung der Board-Fläche als Zustandsmaschine ohne DOM. Die Ansicht (BoardView) reicht
// Zeiger, Rad und Tasten herein und zeichnet, was `scene()` liefert. Eine Geste (Ziehen, Größe ändern, Aufziehen)
// lebt bis zum Loslassen nur hier als Vorschau; erst dann geht sie als ein Schritt in die Sitzung (ein Undo-Schritt,
// ein Schreiben in den Store).
import {
  BoardIndex, centerOn, DEFAULT_CAMERA, duplicateObjects, fitCamera, frontZs, hitHandle, isShape, nudgeDelta, objectBounds, objectsInRect, panBy, readingOrder, rectFromPoints,
  resizeRect, scaleInto, screenToWorld, selectionBounds, unionRect, visibleRect, worldRectToScreen, zoomByWheel, zoomStep, zoomTo,
  type BoardPoint as Point, type BoardRect as Rect, type BoardSize as Size, type Camera, type Handle, type WBObject, type WBShape,
} from "@based/core";
import type { BoardSession } from "./session.js";

export type BoardTool = "select" | "hand" | "note" | "shape";
export const BOARD_TOOLS: readonly { id: BoardTool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Select · drag to move, ⌥-drag to duplicate, drag a handle to resize" },
  { id: "hand", label: "Hand", key: "H", hint: "Hand · or hold Space and drag · pinch to zoom" },
  { id: "note", label: "Sticky note", key: "N", hint: "Sticky note · click to place, or drag for a custom size" },
  { id: "shape", label: "Shape", key: "R", hint: "Shape · click to place, or drag for a custom size" },
];

/** Standardgrößen neuer Objekte (Design „Based – Whiteboard“: Zettel 168 × 150). */
export const NOTE_SIZE: Size = { w: 168, h: 150 };
export const SHAPE_SIZE: Size = { w: 160, h: 100 };
/** Farben der Zettel der Reihe nach (kein Gelb: Gelb heißt „von einem Agenten“). */
export const NOTE_COLORS = ["blue", "pink", "green", "purple", "orange", "gray"] as const;
/** Ab diesem Weg (Bildschirm-px) ist ein Druck ein Ziehen. */
export const DRAG_THRESHOLD = 4;
/** Halbe Trefferbreite eines Griffs (Bildschirm-px). */
export const HANDLE_REACH = 7;

export interface PointerInput {
  /** Relativ zur linken oberen Ecke der Fläche (CSS-px). */
  x: number;
  y: number;
  /** 0 links, 1 Mitte, 2 rechts. */
  button?: number;
  shift?: boolean;
  alt?: boolean;
  /** ⌘ bzw. Strg. */
  mod?: boolean;
}
export interface KeyInput { key: string; code?: string; shift?: boolean; alt?: boolean; mod?: boolean; repeat?: boolean }

type Gesture =
  | { kind: "pan"; last: Point }
  | { kind: "press"; start: Point; world: Point; hit: string | undefined; wasSelected: boolean; shift: boolean; alt: boolean }
  | { kind: "move"; world: Point; ids: string[]; start: Map<string, Rect>; duplicate: boolean; copies?: WBObject[] }
  | { kind: "resize"; world: Point; handle: Handle; from: Rect; start: Map<string, Rect> }
  | { kind: "marquee"; start: Point; world: Point; base: Set<string> }
  | { kind: "create"; tool: "note" | "shape"; start: Point; world: Point };

/** Was die Ansicht zeichnet. */
export interface BoardScene {
  camera: Camera;
  /** Sichtbare Objekte von hinten nach vorn, Vorschau der laufenden Geste schon eingerechnet. */
  objects: WBObject[];
  /** Alle Objekte nach ID (mit Vorschau) – für die Enden von Verbindungen. */
  byID: ReadonlyMap<string, WBObject>;
  selection: ReadonlySet<string>;
  /** Rahmen um die Auswahl (Welt), mit Griffen wenn `handles`. */
  selectionBounds: Rect | undefined;
  handles: boolean;
  /** Aufzieh-Rechteck (Welt): Auswahl oder neues Objekt. */
  marquee: Rect | undefined;
  /** Per Tastatur angesteuertes Objekt (Fokusrahmen). */
  focused: string | undefined;
}

const sizeOf = (tool: "note" | "shape") => (tool === "note" ? NOTE_SIZE : SHAPE_SIZE);
const rectOf = (o: WBShape): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h });
const KIND_NAMES: Record<string, string> = { note: "Sticky note", shape: "Shape", text: "Text", image: "Image", ink: "Drawing", frame: "Frame", page: "Page", connector: "Connector" };

/** Name eines Objekts für Screenreader. */
export function describeObject(o: WBObject): string {
  const name = KIND_NAMES[o.kind] ?? "Object";
  const text = (o.kind === "connector" ? o.label : o.text)?.trim();
  return text ? `${name}: ${text.length > 80 ? text.slice(0, 79) + "…" : text}` : name;
}

/** Lage der Minimap: Welt → Minimap-px. Zeigt alles (Inhalt und sichtbaren Ausschnitt) mit Rand. */
export function minimapTransform(extent: Rect | undefined, visible: Rect, size: Size, pad = 8): { scale: number; x: number; y: number } {
  const all = unionRect(extent ? [extent, visible] : [visible])!;
  const scale = Math.min((size.w - pad * 2) / Math.max(1, all.w), (size.h - pad * 2) / Math.max(1, all.h));
  return { scale, x: (size.w - all.w * scale) / 2 - all.x * scale, y: (size.h - all.h * scale) / 2 - all.y * scale };
}

export interface BoardControllerOptions {
  newID?: () => string;
  /** Gemerkte Kamera (Tab-Wechsel). Ohne: beim ersten Layout auf den Inhalt einpassen. */
  camera?: Camera | undefined;
}

export class BoardController {
  camera: Camera;
  tool: BoardTool = "select";
  selection: ReadonlySet<string> = new Set();
  /** Per Tab angesteuert (zeigt den Fokusrahmen, bis der Zeiger wieder übernimmt). */
  focused: string | undefined;
  /** Letzte Ansage für Screenreader (aria-live). */
  announcement = "";
  viewport: Size = { w: 0, h: 0 };
  /** Zählt bei jeder sichtbaren Änderung hoch. */
  version = 0;

  private gesture: Gesture | undefined;
  private space = false;
  private fitted: boolean;
  private readonly index = new BoardIndex();
  private indexVersion = -1;
  private readonly listeners = new Set<() => void>();
  private readonly newID: () => string;
  private readonly stopSession: () => void;
  private noteCount = 0;
  private sceneCache: { key: string; scene: BoardScene } | undefined;

  constructor(readonly session: BoardSession, opts: BoardControllerOptions = {}) {
    this.newID = opts.newID ?? (() => globalThis.crypto.randomUUID().toLowerCase());
    this.camera = opts.camera ?? DEFAULT_CAMERA;
    this.fitted = opts.camera !== undefined;
    this.stopSession = session.subscribe(() => {
      // Was es nicht mehr gibt (gelöscht, auch von anderswo), fällt aus der Auswahl.
      const kept = [...this.selection].filter((id) => session.byID.has(id));
      if (kept.length !== this.selection.size) this.selection = new Set(kept);
      if (this.focused && !session.byID.has(this.focused)) this.focused = undefined;
      // Nur lesbar geworden (Papierkorb, Sperre): laufende Geste und Anlege-Werkzeug enden.
      if (session.readOnly && (this.tool === "note" || this.tool === "shape" || (this.gesture && this.gesture.kind !== "pan"))) {
        this.gesture = undefined; this.preview = undefined; this.marquee = undefined; this.tool = "select";
      }
      this.changed();
    });
  }

  destroy() {
    this.stopSession();
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private changed() {
    this.version += 1;
    this.sceneCache = undefined;
    for (const fn of [...this.listeners]) fn();
  }

  private get spatial(): BoardIndex {
    if (this.indexVersion !== this.session.version) {
      this.index.load(this.session.objects);
      this.indexVersion = this.session.version;
    }
    return this.index;
  }

  get readOnly(): boolean {
    return this.session.readOnly;
  }
  /** Läuft gerade eine Geste (die Ansicht hält dann den Zeiger fest)? */
  get busy(): boolean {
    return this.gesture !== undefined;
  }
  get panning(): boolean {
    return this.gesture?.kind === "pan";
  }
  get hint(): string {
    if (this.readOnly) return "Read only · drag with the Hand or hold Space to move around";
    return BOARD_TOOLS.find((t) => t.id === this.tool)!.hint;
  }

  // MARK: Kamera

  /** Größe der Fläche; beim ersten Mal auf den Inhalt einpassen. */
  setViewport(size: Size) {
    if (size.w === this.viewport.w && size.h === this.viewport.h) return;
    this.viewport = size;
    if (!this.fitted && size.w > 0 && size.h > 0) {
      this.fitted = true;
      this.camera = fitCamera(this.spatial.extent(), size);
    }
    this.changed();
  }
  private setCamera(c: Camera) {
    if (c.x === this.camera.x && c.y === this.camera.y && c.zoom === this.camera.zoom) return;
    this.camera = c;
    this.changed();
  }
  /** Rad: mit ⌘/Strg (Pinch auf dem Trackpad) zoomen, sonst verschieben. */
  wheel(e: { x: number; y: number; deltaX: number; deltaY: number; zoom: boolean }) {
    this.setCamera(e.zoom ? zoomByWheel(this.camera, e.deltaY, e) : panBy(this.camera, -e.deltaX, -e.deltaY));
  }
  /** Pinch (Safari-Gesten): `factor` relativ zum letzten Ereignis. */
  pinch(factor: number, anchor: Point) {
    this.setCamera(zoomTo(this.camera, this.camera.zoom * factor, anchor));
  }
  zoomIn() { this.setCamera(zoomStep(this.camera, 1, this.viewport)); }
  zoomOut() { this.setCamera(zoomStep(this.camera, -1, this.viewport)); }
  zoomReset() { this.setCamera(zoomTo(this.camera, 1, { x: this.viewport.w / 2, y: this.viewport.h / 2 })); }
  fit() { this.setCamera(fitCamera(this.spatial.extent(), this.viewport)); }
  /** Klick in die Minimap: diesen Weltpunkt in die Mitte. */
  centerOn(world: Point) { this.setCamera(centerOn(this.camera, world, this.viewport)); }
  extent(): Rect | undefined { return this.spatial.extent(); }
  visible(): Rect { return visibleRect(this.camera, this.viewport); }

  /** Kamera nur so weit verschieben, dass `r` (Welt) mit Rand zu sehen ist (Tab, Pfeiltasten). */
  private reveal(r: Rect, margin = 48) {
    const v = this.visible();
    const m = margin / this.camera.zoom;
    let { x, y } = this.camera;
    if (r.x - m < v.x) x = r.x - m;
    else if (r.x + r.w + m > v.x + v.w) x = r.x + r.w + m - v.w;
    if (r.y - m < v.y) y = r.y - m;
    else if (r.y + r.h + m > v.y + v.h) y = r.y + r.h + m - v.h;
    this.setCamera({ x, y, zoom: this.camera.zoom });
  }

  // MARK: Werkzeug und Auswahl

  setTool(tool: BoardTool) {
    if (this.readOnly && (tool === "note" || tool === "shape")) return;
    if (tool === this.tool) return;
    this.cancel();
    this.tool = tool;
    this.changed();
  }

  private select(ids: Iterable<string>, opts: { focus?: string | undefined; quiet?: boolean } = {}) {
    this.selection = new Set(ids);
    this.focused = opts.focus;
    if (!opts.quiet) this.announce();
    this.changed();
  }
  private announce() {
    const n = this.selection.size;
    if (n === 0) this.announcement = "Nothing selected";
    else if (n === 1) {
      const o = this.session.get([...this.selection][0]!);
      const order = readingOrder(this.session.objects);
      this.announcement = o ? `${describeObject(o)}, ${order.indexOf(o.id) + 1} of ${order.length}` : "";
    } else this.announcement = `${n} objects selected`;
  }
  selectAll() {
    this.select(this.session.objects.map((o) => o.id));
  }
  clearSelection() {
    if (this.selection.size || this.focused) this.select([]);
  }

  /** Tab / ⇧Tab: nächstes Objekt in Leserichtung. */
  focusNext(dir: 1 | -1): boolean {
    const order = readingOrder(this.session.objects);
    if (order.length === 0) return false;
    const cur = this.selection.size === 1 ? order.indexOf([...this.selection][0]!) : -1;
    const next = cur < 0 ? (dir > 0 ? 0 : order.length - 1) : cur + dir;
    if (next < 0 || next >= order.length) {
      // Am Ende: Auswahl lösen und den Fokus weiterziehen lassen (keine Tastaturfalle).
      this.select([], { quiet: true });
      return false;
    }
    const id = order[next]!;
    this.select([id], { focus: id });
    const r = objectBounds(this.session.get(id)!, this.session.byID);
    if (r) this.reveal(r);
    return true;
  }

  // MARK: Befehle

  deleteSelection(): boolean {
    if (this.selection.size === 0) return false;
    const removed = this.session.remove([...this.selection]);
    if (removed.length) this.announcement = removed.length === 1 ? "Deleted" : `Deleted ${removed.length} objects`;
    return removed.length > 0;
  }

  duplicateSelection(offset: Point = { x: 16, y: 16 }): boolean {
    if (this.selection.size === 0) return false;
    const copies = duplicateObjects(this.session.objects, this.selection, this.newID, offset);
    if (copies.length === 0 || !this.session.add(copies)) return false;
    this.select(copies.map((o) => o.id));
    return true;
  }

  reorder(where: "front" | "back"): boolean {
    return this.selection.size > 0 && this.session.reorder([...this.selection], where);
  }

  nudge(d: Point): boolean {
    const patches = new Map<string, Record<string, unknown>>();
    for (const id of this.selection) {
      const o = this.session.get(id);
      if (o && isShape(o)) patches.set(id, { x: o.x + d.x, y: o.y + d.y });
    }
    if (patches.size === 0 || !this.session.patch(patches)) return false;
    const r = selectionBounds(this.session.objects, this.selection);
    if (r) this.reveal(r);
    return true;
  }

  undo() { if (this.session.undo()) this.announcement = "Undone"; this.changed(); }
  redo() { if (this.session.redo()) this.announcement = "Redone"; this.changed(); }

  /** Neues Objekt in der Mitte der Fläche (Werkzeug per Tastatur: N bzw. R, dann Enter). */
  createAtCenter(tool: "note" | "shape"): string | undefined {
    const c = screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
    const s = sizeOf(tool);
    return this.create(tool, { x: c.x - s.w / 2, y: c.y - s.h / 2, ...s });
  }

  private create(tool: "note" | "shape", r: Rect): string | undefined {
    const id = this.newID();
    const z = frontZs(this.session.objects, 1)[0]!;
    const base = { id, z, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), rot: 0 };
    const obj: WBObject = tool === "note"
      ? { ...base, kind: "note", style: { color: NOTE_COLORS[this.noteCount++ % NOTE_COLORS.length]! } }
      : { ...base, kind: "shape", style: { shape: "rect" } };
    if (!this.session.add([obj])) return undefined;
    this.tool = "select";
    this.select([id]);
    return id;
  }

  // MARK: Zeiger

  /** Mauszeiger (CSS `cursor`) für die Stelle. */
  cursorAt(p: Point): string {
    if (this.gesture?.kind === "pan") return "grabbing";
    if (this.tool === "hand" || this.space) return "grab";
    if (this.tool === "note" || this.tool === "shape") return "crosshair";
    if (this.gesture?.kind === "resize") return HANDLE_CURSORS[this.gesture.handle];
    if (this.gesture?.kind === "move") return "move";
    const h = this.handleAt(p);
    if (h) return HANDLE_CURSORS[h];
    return this.spatial.hit(screenToWorld(this.camera, p), 2 / this.camera.zoom) ? "move" : "default";
  }

  private handleAt(p: Point): Handle | undefined {
    if (this.readOnly || this.selection.size === 0) return undefined;
    const b = selectionBounds(this.session.objects, this.selection);
    if (!b || ![...this.selection].some((id) => { const o = this.session.get(id); return o && isShape(o); })) return undefined;
    return hitHandle(worldRectToScreen(this.camera, b), p, HANDLE_REACH);
  }

  pointerDown(e: PointerInput) {
    if (this.gesture) this.cancel();
    const p = { x: e.x, y: e.y };
    const world = screenToWorld(this.camera, p);
    if (e.button === 1 || this.tool === "hand" || this.space) {
      this.gesture = { kind: "pan", last: p };
      this.changed();
      return;
    }
    if (e.button === 2) {
      // Rechtsklick: das Objekt unter dem Zeiger wählen (das Menü gilt der Auswahl), sonst nichts anfassen.
      const hit = this.spatial.hit(world, 2 / this.camera.zoom);
      if (hit && !this.selection.has(hit)) this.select([hit]);
      return;
    }
    if (this.tool === "note" || this.tool === "shape") {
      if (!this.readOnly) this.gesture = { kind: "create", tool: this.tool, start: p, world };
      return;
    }
    const handle = this.handleAt(p);
    if (handle) {
      const from = selectionBounds(this.session.objects, this.selection)!;
      const start = new Map<string, Rect>();
      for (const id of this.selection) { const o = this.session.get(id); if (o && isShape(o)) start.set(id, rectOf(o)); }
      this.gesture = { kind: "resize", world, handle, from, start };
      return;
    }
    const hit = this.spatial.hit(world, 2 / this.camera.zoom);
    this.gesture = { kind: "press", start: p, world, hit, wasSelected: hit !== undefined && this.selection.has(hit), shift: e.shift === true, alt: e.alt === true };
    if (hit && !this.selection.has(hit)) this.select(e.shift ? [...this.selection, hit] : [hit]);
    else if (this.focused) { this.focused = undefined; this.changed(); }
  }

  pointerMove(e: PointerInput) {
    const g = this.gesture;
    if (!g) return;
    const p = { x: e.x, y: e.y };
    const world = screenToWorld(this.camera, p);
    switch (g.kind) {
      case "pan":
        this.camera = panBy(this.camera, p.x - g.last.x, p.y - g.last.y);
        g.last = p;
        break;
      case "press": {
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < DRAG_THRESHOLD) return;
        if (g.hit && !this.readOnly) {
          const ids = [...this.selection].filter((id) => { const o = this.session.get(id); return o !== undefined && isShape(o); });
          const start = new Map(ids.map((id) => [id, rectOf(this.session.get(id) as WBShape)]));
          this.gesture = { kind: "move", world: g.world, ids, start, duplicate: g.alt };
        } else if (!g.hit) {
          this.gesture = { kind: "marquee", start: g.start, world: g.world, base: new Set(g.shift ? this.selection : []) };
        } else return;
        this.pointerMove(e);
        return;
      }
      case "move": {
        const d = { x: world.x - g.world.x, y: world.y - g.world.y };
        if (g.duplicate) g.copies = duplicateObjects(this.session.objects, new Set(this.selection), this.newIDStable(g), d);
        else this.preview = new Map([...g.start].map(([id, r]) => [id, { ...r, x: r.x + d.x, y: r.y + d.y }]));
        break;
      }
      case "resize": {
        const to = resizeRect(g.from, g.handle, { x: world.x - g.world.x, y: world.y - g.world.y }, { keepAspect: e.shift === true });
        this.preview = new Map([...g.start].map(([id, r]) => [id, scaleInto(r, g.from, to)]));
        break;
      }
      case "marquee": {
        const rect = rectFromPoints(g.world, world);
        this.marquee = rect;
        this.selection = new Set([...g.base, ...objectsInRect(this.session.objects, rect, this.session.byID)]);
        break;
      }
      case "create":
        this.marquee = Math.hypot(p.x - g.start.x, p.y - g.start.y) < DRAG_THRESHOLD ? undefined : rectFromPoints(g.world, world);
        break;
    }
    this.changed();
  }

  pointerUp(e: PointerInput) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = undefined;
    const world = screenToWorld(this.camera, { x: e.x, y: e.y });
    switch (g.kind) {
      case "press":
        // Klick ohne Ziehen: ⇧ auf ein schon gewähltes Objekt nimmt es heraus, Klick ins Leere löst die Auswahl.
        if (g.hit && g.shift && g.wasSelected) this.select([...this.selection].filter((id) => id !== g.hit));
        else if (g.hit && !g.shift && this.selection.size > 1) this.select([g.hit]);
        else if (!g.hit && !g.shift) this.clearSelection();
        break;
      case "move": {
        const d = { x: Math.round(world.x - g.world.x), y: Math.round(world.y - g.world.y) };
        this.preview = undefined;
        if (g.duplicate) {
          const copies = duplicateObjects(this.session.objects, new Set(this.selection), this.newIDStable(g), d);
          if (copies.length && this.session.add(copies)) this.select(copies.map((o) => o.id));
        } else if (d.x !== 0 || d.y !== 0) {
          this.session.patch(new Map([...g.start].map(([id, r]) => [id, { x: r.x + d.x, y: r.y + d.y }])));
        }
        break;
      }
      case "resize": {
        const to = resizeRect(g.from, g.handle, { x: world.x - g.world.x, y: world.y - g.world.y }, { keepAspect: e.shift === true });
        this.preview = undefined;
        this.session.patch(new Map([...g.start].map(([id, r]) => {
          const n = scaleInto(r, g.from, to);
          return [id, { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) }];
        })));
        break;
      }
      case "marquee":
        this.marquee = undefined;
        this.announce();
        break;
      case "create": {
        const drawn = this.marquee;
        this.marquee = undefined;
        const s = sizeOf(g.tool);
        this.create(g.tool, drawn && drawn.w >= 8 && drawn.h >= 8 ? drawn : { x: g.world.x - s.w / 2, y: g.world.y - s.h / 2, ...s });
        break;
      }
      case "pan":
        break;
    }
    this.changed();
  }

  /** Geste abbrechen (Esc, Zeiger verloren): nichts wird übernommen. */
  cancel() {
    if (!this.gesture && !this.preview && !this.marquee) return;
    if (this.gesture?.kind === "marquee") this.selection = this.gesture.base;
    this.gesture = undefined;
    this.preview = undefined;
    this.marquee = undefined;
    this.changed();
  }

  private preview: Map<string, Rect> | undefined;
  private marquee: Rect | undefined;
  private readonly dupIDs = new WeakMap<object, string[]>();
  /** IDs der Kopien bleiben über die ganze Geste gleich (Vorschau und Ergebnis sind dieselben Objekte). */
  private newIDStable(g: object): () => string {
    let ids = this.dupIDs.get(g);
    if (!ids) this.dupIDs.set(g, (ids = []));
    let i = 0;
    return () => (ids[i++] ??= this.newID());
  }

  // MARK: Tasten

  /** `true`: verarbeitet (die Ansicht ruft preventDefault). */
  keyDown(e: KeyInput): boolean {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.mod) {
      if (k === "z") { if (e.shift) this.redo(); else this.undo(); return true; }
      if (k === "y") { this.redo(); return true; }
      if (k === "a") { this.selectAll(); return true; }
      if (k === "d") { this.duplicateSelection(); return true; }
      if (k === "=" || k === "+") { this.zoomIn(); return true; }
      if (k === "-") { this.zoomOut(); return true; }
      if (k === "0") { this.fit(); return true; }
      if (k === "1") { this.zoomReset(); return true; }
      if (k === "]") { return e.alt ? this.reorder("front") : false; }
      if (k === "[") { return e.alt ? this.reorder("back") : false; }
      return false;
    }
    if (e.alt) return false;
    if (k === " ") {
      if (!this.space) { this.space = true; this.changed(); }
      return true;
    }
    if (k === "Escape") {
      if (this.gesture || this.preview || this.marquee) { this.cancel(); return true; }
      if (this.tool !== "select") { this.setTool("select"); return true; }
      if (this.selection.size || this.focused) { this.clearSelection(); return true; }
      return false;
    }
    if (k === "Tab") return this.focusNext(e.shift ? -1 : 1);
    if (k === "Delete" || k === "Backspace") return this.deleteSelection();
    if (k === "Enter" && (this.tool === "note" || this.tool === "shape")) return this.createAtCenter(this.tool) !== undefined;
    const d = nudgeDelta(e.key, e.shift === true);
    if (d) return this.selection.size > 0 ? this.nudge(d) : (this.setCamera(panBy(this.camera, -d.x * 40, -d.y * 40)), true);
    if (e.repeat) return false;
    const tool = BOARD_TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) { this.setTool(tool.id); return true; }
    return false;
  }

  keyUp(e: KeyInput) {
    if (e.key === " " && this.space) {
      this.space = false;
      this.changed();
    }
  }

  /** Fokus verloren: gehaltene Leertaste und laufende Geste enden. */
  blur() {
    this.space = false;
    this.cancel();
  }

  // MARK: Szene

  scene(): BoardScene {
    const key = `${this.version}:${this.session.version}`;
    if (this.sceneCache?.key === key) return this.sceneCache.scene;
    const g = this.gesture;
    const overrides = new Map<string, WBObject>();
    if (this.preview) {
      for (const [id, r] of this.preview) {
        const o = this.session.get(id);
        if (o && isShape(o)) overrides.set(id, { ...o, ...r });
      }
    }
    const ghosts = g?.kind === "move" && g.duplicate ? g.copies ?? [] : [];
    for (const c of ghosts) overrides.set(c.id, c);
    const base = this.session.byID;
    const byID: ReadonlyMap<string, WBObject> = overrides.size === 0 ? base : new Map([...base, ...overrides]);
    const view = this.visible();
    let objects: WBObject[];
    if (overrides.size === 0) objects = this.spatial.search(view);
    else {
      // Während einer Geste: Reihenfolge der Sitzung, Vorschau eingesetzt, Kopien vorn; Sichtbarkeit neu geprüft.
      objects = [];
      const pad = { x: view.x - 1, y: view.y - 1, w: view.w + 2, h: view.h + 2 };
      for (const o of [...this.session.objects, ...ghosts]) {
        const cur = byID.get(o.id)!;
        const r = objectBounds(cur, byID);
        if (r && r.x <= pad.x + pad.w && pad.x <= r.x + r.w && r.y <= pad.y + pad.h && pad.y <= r.y + r.h) objects.push(cur);
      }
    }
    const selection = ghosts.length ? new Set(ghosts.map((c) => c.id)) : this.selection;
    const all = overrides.size === 0 ? this.session.objects : [...byID.values()];
    const scene: BoardScene = {
      camera: this.camera, objects, byID, selection,
      selectionBounds: selection.size ? selectionBounds(all, selection) : undefined,
      handles: !this.readOnly && g?.kind !== "marquee" && g?.kind !== "move" && [...selection].some((id) => { const o = byID.get(id); return o !== undefined && isShape(o); }),
      marquee: this.marquee,
      focused: this.focused,
    };
    this.sceneCache = { key, scene };
    return scene;
  }
}

const HANDLE_CURSORS: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
