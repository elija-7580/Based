// BSD-264 (Whiteboard 2): Bedienung der Board-Fläche als Zustandsmaschine ohne DOM. Die Ansicht (BoardView) reicht
// Zeiger, Rad und Tasten herein und zeichnet, was `scene()` liefert. Eine Geste (Ziehen, Größe ändern, Aufziehen)
// lebt bis zum Loslassen nur hier als Vorschau; erst dann geht sie als ein Schritt in die Sitzung (ein Undo-Schritt,
// ein Schreiben in den Store).
import {
  backZ, BoardIndex, boardFileView, centerOn, DEFAULT_CAMERA, duplicateObjects, encodeInk, fitCamera, frontZs, hitHandle, inkObjectGeometry, inkPointsOf, isConnector, isShape, nudgeDelta, objectBounds,
  objectsInRect, panBy, pointInPolygon, readingOrder, recognizeShape, rectContains, rectFromPoints, resizeRect, scaleInto, screenToWorld, selectionBounds, shareInside, simplifyInk, unionRect,
  toggleTask, visibleRect, worldRectToScreen, zoomByWheel, zoomStep, zoomTo,
  type BoardPoint as Point, type BoardRect as Rect, type BoardSize as Size, type Camera, type Handle, type InkPoint, type WBObject, type WBShape,
} from "@based/core";
import type { BoardBackground, BoardSession } from "./session.js";

// BSD-265–267 (Whiteboard 3–5): Werkzeuge in der Reihenfolge des Entwurfs „Based – Whiteboard“ (Board „Mac“).
// `group`: vor diesem Werkzeug steht in der Leiste ein Trenner.
export type BoardTool = "select" | "hand" | "pen" | "highlighter" | "eraser" | "lasso" | "text" | "note" | "shape" | "connector" | "frame";
export const BOARD_TOOLS: readonly { id: BoardTool; label: string; key: string; hint: string; group?: boolean }[] = [
  { id: "select", label: "Select", key: "V", hint: "Select · drag to move, ⌥-drag to duplicate, double-click to type" },
  { id: "hand", label: "Hand", key: "H", hint: "Hand · or hold Space and drag · pinch to zoom" },
  { id: "pen", label: "Pen", key: "P", group: true, hint: "Pen · hold still at the end of a stroke to snap a shape · with a Pencil, your finger moves the board" },
  { id: "highlighter", label: "Highlighter", key: "⇧P", hint: "Highlighter · shows through what is underneath · no yellow: yellow means an agent wrote it" },
  { id: "eraser", label: "Eraser", key: "E", hint: "Eraser · rub over a line to remove it" },
  { id: "lasso", label: "Lasso", key: "L", hint: "Lasso · circle ink and objects to select them" },
  { id: "text", label: "Text", key: "T", group: true, hint: "Text · click anywhere and type · Markdown works: # heading, **bold**, - list, - [ ] task" },
  { id: "note", label: "Sticky note", key: "N", hint: "Sticky note · N, then type · Tab adds the next one beside it" },
  { id: "shape", label: "Shape", key: "R", hint: "Shape · R rectangle, O oval, D diamond · click to place or drag for a custom size" },
  { id: "connector", label: "Connector", key: "A", hint: "Connector · drag from one object to another" },
  { id: "frame", label: "Frame", key: "F", hint: "Frame · drag to group objects · moving a frame moves what is inside" },
];

/** Werkzeuge, die etwas anlegen oder ändern (in „nur lesen“ gesperrt). */
const EDIT_TOOLS: ReadonlySet<BoardTool> = new Set(["pen", "highlighter", "eraser", "text", "note", "shape", "connector", "frame"]);
export const isEditTool = (t: BoardTool) => EDIT_TOOLS.has(t);
type BoxTool = "note" | "shape" | "frame";
const isBoxTool = (t: BoardTool): t is BoxTool => t === "note" || t === "shape" || t === "frame";

/** Stiftfarben (Token-Namen in render.ts; kein Gelb) und Strichstärken in Welt-px: fein, mittel, kräftig. */
// Elija 17.11.: Farben von Based – die Textfarben des Editors für Striche und Text, die Marker-Familie für den
// Textmarker (die eigene Marker-Farbe fällt in der Ansicht heraus: sie gehört den Agenten), die Hintergründe des
// Editors für Zettel und Flächen. Namen statt Werte: hell/dunkel und spätere Themen kommen aus den Tokens.
export const STROKE_COLORS = ["ink", "gray", "brown", "orange", "green", "blue", "purple", "pink", "red"] as const;
export const PEN_COLORS = STROKE_COLORS;
export const HIGHLIGHT_COLORS = ["mint", "sky", "rose", "calm"] as const;
export const FILL_COLORS = ["gray", "brown", "orange", "green", "blue", "purple", "pink", "red"] as const;
/** Welche Farbreihen für eine Auswahl gelten. */
export type ColorRow = "stroke" | "fill" | "highlight";
export const PEN_WIDTHS = [1.6, 2.6, 4.4] as const;
export const HIGHLIGHT_WIDTHS = [10, 16, 24] as const;
export const SHAPE_KINDS = ["rect", "oval", "diamond"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
/** Radius des Radierers und Fangweite der Verbindung (Bildschirm-px). */
export const ERASER_REACH = 9;
/** So lange am Ende eines Strichs halten, damit er zur Form wird. */
export const SNAP_HOLD_MS = 450;
/** Zwei Klicks an derselben Stelle innerhalb dieser Zeit sind ein Doppelklick. */
export const DOUBLE_CLICK_MS = 420;
export const TEXT_WIDTH = 320;
export const TEXT_LINE = 26;
export const FRAME_SIZE: Size = { w: 480, h: 320 };

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
  /** Stiftdruck 0…1; ohne Stift (Maus, Finger) weglassen. */
  pressure?: number;
  /** Der Stift ist umgedreht bzw. hält die Radier-Taste. */
  eraser?: boolean;
  /** Die Ansicht will verschieben (Finger, während der Stift zeichnet). */
  pan?: boolean;
}
export interface KeyInput { key: string; code?: string; shift?: boolean; alt?: boolean; mod?: boolean; repeat?: boolean }

type Gesture =
  | { kind: "pan"; last: Point }
  | { kind: "press"; start: Point; world: Point; hit: string | undefined; wasSelected: boolean; shift: boolean; alt: boolean }
  | { kind: "move"; world: Point; ids: string[]; start: Map<string, Rect>; duplicate: boolean; copies?: WBObject[] }
  | { kind: "resize"; world: Point; handle: Handle; from: Rect; start: Map<string, Rect> }
  | { kind: "marquee"; start: Point; world: Point; base: Set<string> }
  | { kind: "create"; tool: BoxTool; start: Point; world: Point }
  | { kind: "ink"; tool: "pen" | "highlighter"; points: InkPoint[]; pen: boolean; rest: Point; restAt: number; snap?: { kind: "line" | "rect" | "oval"; bounds: Rect } | undefined }
  | { kind: "erase"; hit: Set<string>; last: Point }
  | { kind: "lasso"; points: Point[] }
  | { kind: "connect"; from: string; to: Point; target: string | undefined };

/** Strich, der gerade entsteht (Weltkoordinaten) – die Ansicht zeichnet ihn über die fertige Fläche. */
export interface LiveInk { points: readonly InkPoint[]; tool: "pen" | "highlighter"; color: string; width: number; sim: boolean }
/** Text, der gerade bearbeitet wird: ein vorhandenes Objekt oder ein neuer Text an einer Stelle. */
export interface BoardEdit { id: string | undefined; kind: "text" | "note" | "shape" | "frame" | "connector"; rect: Rect; text: string }

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
  /** Lasso, das gerade gezogen wird (Welt). */
  lasso: readonly Point[] | undefined;
  /** Verbindung, die gerade gezogen wird (Welt). */
  connecting: { from: Rect; to: Point; target: Rect | undefined } | undefined;
  /** Objekt, dessen Text gerade im Eingabefeld steht (die Fläche zeichnet ihn dann nicht). */
  editing: string | undefined;
  /** Snap shapes: die Form, zu der der gehaltene Strich beim Loslassen wird (Vorschau). */
  snap: { kind: "line" | "rect" | "oval"; from: Point; to: Point; bounds: Rect } | undefined;
  background: BoardBackground;
  previewScroll: ReadonlyMap<string, number>;
}

const sizeOf = (tool: BoxTool) => (tool === "note" ? NOTE_SIZE : tool === "frame" ? FRAME_SIZE : SHAPE_SIZE);
const hasText = (o: WBObject) => o.kind === "text" || o.kind === "note" || o.kind === "shape" || o.kind === "frame" || o.kind === "connector";
const rectOf = (o: WBShape): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h });
const KIND_NAMES: Record<string, string> = { note: "Sticky note", shape: "Shape", text: "Text", image: "Image", file: "File", ink: "Drawing", frame: "Frame", page: "Page", connector: "Connector" };

/** Name eines Objekts für Screenreader. */
export function describeObject(o: WBObject): string {
  const name = KIND_NAMES[o.kind] ?? "Object";
  const text = (o.kind === "connector" ? o.label : o.kind === "image" || o.kind === "file" ? String(o.style?.name ?? "") : o.text)?.trim();
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
  /** Uhr für den Doppelklick (Tests). */
  now?: () => number;
  /** Doppelklick auf ein Bild oder eine Datei: öffnen bzw. sichern (macht die Ansicht). */
  onOpenFile?: (obj: WBShape) => void;
  /** Doppelklick auf eine Seitenkarte: die Seite öffnen. */
  onOpenPage?: (pageID: string) => void;
  /** Markdown-Aufgabe (`- [ ]`) unter dem Punkt (Welt): ihre Zeile im Text. Ein Klick darauf hakt sie ab. */
  taskAt?: (obj: WBShape, world: Point) => number | undefined;
}

/** Eine abgelegte Datei: `ref` ist die Adresse im Dateispeicher (`based-asset:<sha256>`), nie der Inhalt. */
export interface BoardFile {
  ref: string; name: string; mime: string; size: number;
  /** Bildmaße in px, wenn es ein Bild ist. */
  width?: number; height?: number;
  /** Seitenmaße (Punkt), wenn es ein PDF ist: jede Seite wird ein Objekt. */
  pages?: readonly { width: number; height: number }[];
}
export const FILE_CARD: Size = { w: 264, h: 72 };
export const PAGE_CARD: Size = { w: 240, h: 72 };
/** Ganze Seite auf dem Board (Elija 17.11.: Seiten als ganze zeigen und dort bearbeiten). */
export const PAGE_FULL: Size = { w: 520, h: 620 };
// Feststecken: nur was jemand selbst festgesteckt hat („Lock in place“). Ein früheres `locked` auf PDF-Seiten gilt
// nicht mehr – PDF-Seiten lassen sich wählen und verschieben (Elija 17.11.).
const isLocked = (o: WBObject) => o.style?.pin === true;
/** Größe der Vorschau je Stufe-2-Art und Breite einer PDF-Seite (Welt-px). */
export const PREVIEW_SIZE: Record<"text" | "html" | "video" | "audio", Size> = { text: { w: 440, h: 320 }, html: { w: 560, h: 400 }, video: { w: 480, h: 310 }, audio: { w: 360, h: 104 } };
export const PDF_WIDTH = 560;
/** Längerer eingefügter Text wird eine Datei mit Vorschau statt eines Text-Objekts. */
export const PASTE_TEXT_MAX = 400;
/** Größte Kante eines frisch abgelegten Bildes (Welt-px). */
export const IMAGE_MAX = 480;

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

  /** Stift und Textmarker merken sich Farbe und Stärke getrennt. */
  pen: { color: string; width: number } = { color: "ink", width: 1 };
  highlighter: { color: string; width: number } = { color: "sky", width: 1 };
  shapeKind: ShapeKind = "rect";
  snapShapes = true;
  /** Present: Nummer des gezeigten Frames (Frames sind die Folien), sonst `undefined`. */
  presenting: number | undefined;
  /** Wie weit die Textvorschau einer Datei gerollt ist (Welt-px, nur für diese Sitzung). */
  readonly previewScroll = new Map<string, number>();
  /** Text im Eingabefeld (die Ansicht zeigt es an der Stelle des Objekts). */
  editing: BoardEdit | undefined;
  /** Zählt bei jedem neuen Punkt des laufenden Strichs hoch (die Fläche darunter bleibt, wie sie ist). */
  inkVersion = 0;

  private gesture: Gesture | undefined;
  /** Letzte Zeigerstelle über der Fläche (Welt) – dort beginnt getippter Text. */
  hover: Point | undefined;
  private lastClick: { at: number; p: Point; hit: string | undefined } | undefined;
  private readonly now: () => number;
  private readonly onOpenFile: ((obj: WBShape) => void) | undefined;
  private readonly onOpenPage: ((pageID: string) => void) | undefined;
  private readonly taskAt: ((obj: WBShape, world: Point) => number | undefined) | undefined;
  private space = false;
  private fitted: boolean;
  /** Die Fläche hatte schon eine Größe (erst dann lohnt es, die Kamera zu merken). */
  get laidOut(): boolean { return this.fitted; }
  private readonly index = new BoardIndex();
  private indexVersion = -1;
  private readonly listeners = new Set<() => void>();
  private readonly newID: () => string;
  private readonly stopSession: () => void;
  private noteCount = 0;
  private sceneCache: { key: string; scene: BoardScene } | undefined;

  constructor(readonly session: BoardSession, opts: BoardControllerOptions = {}) {
    this.newID = opts.newID ?? (() => globalThis.crypto.randomUUID().toLowerCase());
    this.now = opts.now ?? (() => Date.now());
    this.onOpenFile = opts.onOpenFile;
    this.onOpenPage = opts.onOpenPage;
    this.taskAt = opts.taskAt;
    this.camera = opts.camera ?? DEFAULT_CAMERA;
    this.fitted = opts.camera !== undefined;
    this.stopSession = session.subscribe(() => {
      // Was es nicht mehr gibt (gelöscht, auch von anderswo), fällt aus der Auswahl.
      const kept = [...this.selection].filter((id) => session.byID.has(id));
      if (kept.length !== this.selection.size) this.selection = new Set(kept);
      if (this.focused && !session.byID.has(this.focused)) this.focused = undefined;
      // Nur lesbar geworden (Papierkorb, Sperre): laufende Geste und Anlege-Werkzeug enden.
      if (session.readOnly && (isEditTool(this.tool) || this.editing || (this.gesture && this.gesture.kind !== "pan"))) {
        this.gesture = undefined; this.preview = undefined; this.marquee = undefined; this.editing = undefined; this.tool = "select";
      }
      if (this.editing?.id && !session.byID.has(this.editing.id)) this.editing = undefined;
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
  /** Nur der laufende Strich hat sich geändert: Zuhörer wecken, die fertige Fläche bleibt gültig. */
  private pulse() {
    this.inkVersion += 1;
    for (const fn of [...this.listeners]) fn();
  }
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
  /** Der Strich, der gerade gezogen wird. */
  get liveInk(): LiveInk | undefined {
    const g = this.gesture;
    if (g?.kind !== "ink") return undefined;
    const s = g.tool === "pen" ? this.pen : this.highlighter;
    return { points: g.points, tool: g.tool, color: s.color, width: (g.tool === "pen" ? PEN_WIDTHS : HIGHLIGHT_WIDTHS)[s.width] ?? 2.6, sim: !g.pen };
  }
  get inking(): boolean {
    return this.gesture?.kind === "ink" || this.gesture?.kind === "erase" || this.gesture?.kind === "lasso";
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
    if (this.presenting !== undefined) { const s = this.slides()[this.presenting]; if (s) this.camera = fitCamera(s, size, 32); }
    if (!this.fitted && size.w > 0 && size.h > 0) {
      this.fitted = true;
      this.camera = fitCamera(this.spatial.extent(), size);
    }
    this.changed();
  }
  /** Ausschnitt setzen (gesperrter Ausschnitt eines eingebetteten Boards). */
  showCamera(c: Camera) { this.fitted = true; this.setCamera(c); }
  private setCamera(c: Camera) {
    if (c.x === this.camera.x && c.y === this.camera.y && c.zoom === this.camera.zoom) return;
    this.camera = c;
    this.changed();
  }
  /** Rad: mit ⌘/Strg (Pinch auf dem Trackpad) zoomen, sonst verschieben. */
  wheel(e: { x: number; y: number; deltaX: number; deltaY: number; zoom: boolean }) {
    if (this.presenting !== undefined) return;
    // Über einer gewählten Textvorschau rollt das Rad ihren Inhalt, nicht die Fläche.
    if (!e.zoom && this.selection.size === 1) {
      const o = this.session.get([...this.selection][0]!);
      const w = screenToWorld(this.camera, e);
      if (o && isShape(o) && o.kind === "file" && o.style?.view === "text" && w.x >= o.x && w.x <= o.x + o.w && w.y >= o.y && w.y <= o.y + o.h) {
        this.previewScroll.set(o.id, Math.max(0, Math.min(6000, (this.previewScroll.get(o.id) ?? 0) + e.deltaY / this.camera.zoom)));
        this.changed();
        return;
      }
    }
    this.setCamera(e.zoom ? zoomByWheel(this.camera, e.deltaY, e) : panBy(this.camera, -e.deltaX, -e.deltaY));
  }
  /** Pinch (Safari-Gesten): `factor` relativ zum letzten Ereignis. */
  pinch(factor: number, anchor: Point) {
    this.setCamera(zoomTo(this.camera, this.camera.zoom * factor, anchor));
  }
  /** Fläche um Bildschirm-px verschieben (zwei Finger). */
  panScreen(dx: number, dy: number) { this.setCamera(panBy(this.camera, dx, dy)); }
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

  // MARK: Present

  /** Frames in Leserichtung – die Folien. */
  slides(): WBShape[] {
    const frames = this.session.objects.filter((o): o is WBShape => isShape(o) && o.kind === "frame");
    const order = readingOrder(frames);
    return order.map((id) => frames.find((f) => f.id === id)!);
  }
  /** Folie zeigen (`undefined` beendet); die Kamera passt den Frame ein. */
  present(index: number | undefined) {
    const slides = this.slides();
    if (index === undefined || slides.length === 0) {
      if (this.presenting === undefined) return;
      this.presenting = undefined;
      this.camera = this.beforePresent ?? this.camera;
      this.changed();
      return;
    }
    if (this.presenting === undefined) { this.beforePresent = this.camera; this.cancel(); this.cancelEdit(); this.select([], { quiet: true }); }
    const i = Math.max(0, Math.min(slides.length - 1, index));
    this.presenting = i;
    this.camera = fitCamera(slides[i]!, this.viewport, 32);
    this.announcement = `Slide ${i + 1} of ${slides.length}: ${slides[i]!.text ?? "Frame"}`;
    this.changed();
  }
  private beforePresent: Camera | undefined;

  // MARK: Werkzeug und Auswahl

  setTool(tool: BoardTool) {
    if (this.readOnly && isEditTool(tool)) return;
    if (tool === this.tool) return;
    this.cancel();
    this.tool = tool;
    this.changed();
  }
  setShapeKind(kind: ShapeKind) {
    this.shapeKind = kind;
    if (this.tool !== "shape") this.setTool("shape");
    else this.changed();
  }
  /** Farbe bzw. Stärke des gewählten Zeichenwerkzeugs. */
  /** Etwas außerhalb hat sich geändert (Seitentitel): die Fläche neu zeichnen. */
  refresh() { this.changed(); }
  /** Gemerkte Stifte (Werkzeug, Farbe, Stärke) – die Ansicht hält sie je Gerät fest. */
  useInk(preset: { tool: "pen" | "highlighter"; color: string; width: number }) {
    if (this.readOnly) return;
    if (preset.tool === "pen") this.pen = { color: preset.color, width: preset.width }; else this.highlighter = { color: preset.color, width: preset.width };
    if (this.tool !== preset.tool) this.setTool(preset.tool); else this.changed();
  }
  setInkStyle(patch: { color?: string; width?: number }) {
    if (this.tool === "highlighter") this.highlighter = { ...this.highlighter, ...patch };
    else this.pen = { ...this.pen, ...patch };
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
  createAtCenter(tool: BoxTool): string | undefined {
    const c = screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
    const s = sizeOf(tool);
    return this.create(tool, { x: c.x - s.w / 2, y: c.y - s.h / 2, ...s });
  }

  private create(tool: BoxTool, r: Rect, opts: { edit?: boolean } = {}): string | undefined {
    const id = this.newID();
    // Frames liegen hinter allem (sie sind die Unterlage ihrer Objekte), alles andere kommt nach vorn.
    const z = tool === "frame" ? backZ(this.session.objects) : frontZs(this.session.objects, 1)[0]!;
    const base = { id, z, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), rot: 0 };
    const obj: WBObject = tool === "note"
      ? { ...base, kind: "note", style: { color: NOTE_COLORS[this.noteCount++ % NOTE_COLORS.length]! } }
      : tool === "frame" ? { ...base, kind: "frame", text: "Frame" }
        : { ...base, kind: "shape", style: { shape: this.shapeKind } };
    if (!this.session.add([obj])) return undefined;
    this.tool = "select";
    this.select([id]);
    // „N, dann tippen“: der neue Zettel nimmt sofort Text an.
    if (opts.edit && tool === "note") this.startEdit(id);
    return id;
  }

  // MARK: Farben der Auswahl

  /** Farbreihen, die für die Auswahl gelten (Strich/Text, Fläche, Textmarker). */
  colorRows(): ColorRow[] {
    const rows = new Set<ColorRow>();
    for (const id of this.selection) {
      const o = this.session.get(id);
      if (!o) continue;
      if (o.kind === "ink") rows.add(o.style?.tool === "hl" ? "highlight" : "stroke");
      else if (o.kind === "text" || o.kind === "connector") rows.add("stroke");
      else if (o.kind === "note" || o.kind === "frame") rows.add("fill");
      else if (o.kind === "shape") { rows.add("stroke"); rows.add("fill"); }
    }
    return (["stroke", "fill", "highlight"] as const).filter((r) => rows.has(r));
  }
  /** Gemeinsame Farbe der Auswahl in einer Reihe (für den gedrückten Zustand), sonst `undefined`. */
  selectionColor(row: ColorRow): string | undefined {
    let found: string | undefined;
    for (const id of this.selection) {
      const o = this.session.get(id);
      if (!o) continue;
      const v = row === "fill" ? (o.kind === "shape" ? o.style?.fill : o.kind === "note" || o.kind === "frame" ? o.style?.color : undefined)
        : row === "highlight" ? (o.kind === "ink" && o.style?.tool === "hl" ? o.style?.color : undefined)
          : (o.kind === "ink" && o.style?.tool !== "hl") || o.kind === "text" || o.kind === "connector" || o.kind === "shape" ? (o.style?.color ?? "ink") : undefined;
      if (v === undefined) continue;
      if (found !== undefined && found !== String(v)) return undefined;
      found = String(v);
    }
    return found;
  }
  /** Auswahl umfärben – ein Undo-Schritt. */
  setColor(row: ColorRow, color: string): boolean {
    const patches = new Map<string, Record<string, unknown>>();
    for (const id of this.selection) {
      const o = this.session.get(id);
      if (!o || isLocked(o)) continue;
      const style = { ...(o.style ?? {}) };
      if (row === "fill" && o.kind === "shape") style.fill = color;
      else if (row === "fill" && (o.kind === "note" || o.kind === "frame")) style.color = color;
      else if (row === "highlight" && o.kind === "ink" && o.style?.tool === "hl") style.color = color;
      else if (row === "stroke" && ((o.kind === "ink" && o.style?.tool !== "hl") || o.kind === "text" || o.kind === "connector" || o.kind === "shape")) style.color = color;
      else continue;
      patches.set(id, { style });
    }
    return patches.size > 0 && this.session.patch(patches);
  }

  // MARK: Sperren und Seitenkarten

  /** Gesperrte Objekte bleiben liegen: nur Rechtsklick und ⌘A wählen sie. */
  private pick(world: Point, tolerance: number): string | undefined {
    return this.spatial.hit(world, tolerance, isLocked);
  }
  /** Ist eine Seitenkarte gewählt, und zeigt sie die ganze Seite? (für das Menü) */
  get selectedPage(): { full: boolean } | undefined {
    if (this.selection.size !== 1) return undefined;
    const o = this.session.get([...this.selection][0]!);
    return o && o.kind === "page" ? { full: o.style?.full === true } : undefined;
  }
  /** Seitenkarte zwischen „ganze Seite“ und „kleine Karte“ umschalten (Größe passt sich an). */
  togglePageFull(): boolean {
    const id = [...this.selection][0];
    const o = id ? this.session.get(id) : undefined;
    if (!o || !isShape(o) || o.kind !== "page") return false;
    const full = o.style?.full !== true;
    const size = full ? PAGE_FULL : PAGE_CARD;
    return this.session.patch(new Map([[o.id, { w: size.w, h: size.h, style: { ...(o.style ?? {}), full } }]]));
  }
  /** Ist in der Auswahl etwas gesperrt (für das Menü)? */
  get selectionLocked(): boolean {
    return [...this.selection].some((id) => { const o = this.session.get(id); return o !== undefined && isLocked(o); });
  }
  setLocked(locked: boolean): boolean {
    const patches = new Map<string, Record<string, unknown>>();
    for (const id of this.selection) {
      const o = this.session.get(id);
      if (o && isShape(o) && isLocked(o) !== locked) patches.set(id, { style: { ...(o.style ?? {}), pin: locked } });
    }
    if (patches.size === 0 || !this.session.patch(patches)) return false;
    if (locked) this.select([]);
    return true;
  }
  /** Seitenkarte ablegen (Auswahl über die Werkzeugleiste). `title`: Stand jetzt, für Suche und Geräte ohne Titel-Liste. */
  addPage(pageID: string, title: string, at?: Point): string | undefined {
    if (this.readOnly) return undefined;
    const c = at ?? screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
    const id = this.newID();
    if (!this.session.add([{ id, kind: "page", z: frontZs(this.session.objects, 1)[0]!, x: Math.round(c.x - PAGE_FULL.w / 2), y: Math.round(c.y - PAGE_FULL.h / 2), ...PAGE_FULL, rot: 0, ref: pageID, text: title || "Untitled", style: { full: true } }])) return undefined;
    this.tool = "select";
    this.select([id]);
    return id;
  }

  // MARK: Dateien

  /**
   * Dateien ablegen (Ziehen, Einfügen, Auswahl): Bilder als Bild in ihrer Form, alles andere als Dateikarte. Die
   * Bytes liegen im Dateispeicher; das Objekt trägt nur Adresse, Name, Art und Größe. Ein Undo-Schritt für alle.
   */
  addFiles(files: readonly BoardFile[], at?: Point): string[] {
    if (this.readOnly || files.length === 0) return [];
    const c = at ?? screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
    // Je Datei ein Objekt – bei einem PDF eines je Seite (der „Ausdruck“: Seiten untereinander, zum Draufschreiben).
    const parts: { f: BoardFile; kind: "image" | "file"; size: Size; style: Record<string, string | number | boolean> }[] = [];
    for (const f of files) {
      const view = boardFileView(f.name, f.mime);
      const base = { name: f.name, mime: f.mime, size: f.size };
      if (view === "image" && (f.width ?? 0) > 0 && (f.height ?? 0) > 0) {
        const k = Math.min(1, IMAGE_MAX / Math.max(f.width!, f.height!));
        parts.push({ f, kind: "image", size: { w: Math.max(8, Math.round(f.width! * k)), h: Math.max(8, Math.round(f.height! * k)) }, style: base });
      } else if (view === "pdf" && f.pages?.length) {
                f.pages.forEach((p, i) => parts.push({ f, kind: "file", size: { w: PDF_WIDTH, h: Math.max(8, Math.round((PDF_WIDTH * p.height) / Math.max(1, p.width))) }, style: { ...base, view: "pdf", page: i + 1, pages: f.pages!.length } }));
      } else if (view === "text" || view === "html" || view === "video" || view === "audio") parts.push({ f, kind: "file", size: PREVIEW_SIZE[view], style: { ...base, view } });
      else parts.push({ f, kind: "file", size: FILE_CARD, style: base });
    }
    // Ohne feste Stelle (Auswahl, Einfügen): liegt in der Mitte schon etwas, kommt das Neue rechts neben den Inhalt –
    // sonst stapeln sich nacheinander hinzugefügte Dateien übereinander.
    if (!at && parts.length) {
      const w = Math.max(...parts.map((p) => p.size.w)), h = parts.reduce((n, p) => n + p.size.h + 16, -16);
      const extent = this.spatial.extent();
      if (extent && this.spatial.search({ x: c.x - w / 2, y: c.y - parts[0]!.size.h / 2, w, h }).length > 0) {
        c.x = extent.x + extent.w + 48 + w / 2;
        c.y = extent.y + Math.min(parts[0]!.size.h, this.viewport.h / this.camera.zoom - 96) / 2;
      }
    }
    const zs = frontZs(this.session.objects, parts.length);
    let y = c.y;
    const objs: WBObject[] = parts.map((p, i) => {
      // Das erste Objekt sitzt mittig auf der Stelle (eine lange Seite mit der Oberkante im Blick), weitere untereinander.
      const top = i === 0 ? c.y - Math.min(p.size.h, this.viewport.h / this.camera.zoom - 96) / 2 : y;
      y = top + p.size.h + 16;
      return { id: this.newID(), kind: p.kind, z: zs[i]!, x: Math.round(c.x - p.size.w / 2), y: Math.round(top), ...p.size, rot: 0, ref: p.f.ref, style: p.style };
    });
    if (!this.session.add(objs)) return [];
    this.tool = "select";
    this.select(objs.map((o) => o.id));
    const first = objs[0];
    if (first && isShape(first)) this.reveal({ x: first.x, y: first.y, w: first.w, h: Math.min(first.h, 200) });
    return objs.map((o) => o.id);
  }

  /** Kurzen Text einfügen (Zwischenablage): ein Text-Objekt an der Stelle bzw. in der Mitte. */
  addText(text: string, at?: Point): string | undefined {
    const value = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (this.readOnly || value === "") return undefined;
    const c = at ?? screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
    // Höhe geschätzt (rund 38 Zeichen je Zeile bei dieser Breite); beim nächsten Bearbeiten wird sie genau.
    const rows = value.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 38)), 0);
    const id = this.newID();
    const h = rows * TEXT_LINE;
    if (!this.session.add([{ id, kind: "text", z: frontZs(this.session.objects, 1)[0]!, x: Math.round(c.x - TEXT_WIDTH / 2), y: Math.round(c.y - h / 2), w: TEXT_WIDTH, h, rot: 0, text: value }])) return undefined;
    this.tool = "select";
    this.select([id]);
    return id;
  }

  // MARK: Text

  /** Text eines Objekts bearbeiten (Doppelklick, Enter). */
  startEdit(id: string): boolean {
    const o = this.session.get(id);
    if (!o || this.readOnly || !hasText(o)) return false;
    const r = objectBounds(o, this.session.byID);
    if (!r) return false;
    const text = (isConnector(o) ? o.label : o.text) ?? "";
    const rect = isConnector(o) ? { x: r.x + r.w / 2 - 80, y: r.y + r.h / 2 - 14, w: 160, h: 28 } : { x: o.x, y: o.y, w: o.w, h: o.kind === "frame" ? 42 : o.h };
    this.editing = { id, kind: o.kind as BoardEdit["kind"], rect, text };
    this.select([id], { quiet: true });
    return true;
  }
  /** Neuer Text an einer Stelle (Text-Werkzeug, Doppelklick ins Leere). Das Objekt entsteht erst mit dem ersten Zeichen. */
  startText(world: Point, initial = ""): boolean {
    if (this.readOnly) return false;
    this.editing = { id: undefined, kind: "text", rect: { x: Math.round(world.x), y: Math.round(world.y - TEXT_LINE / 2), w: TEXT_WIDTH, h: TEXT_LINE }, text: initial };
    this.tool = "select";
    this.select([], { quiet: true });
    return true;
  }
  /**
   * Eingabe übernehmen. `height`: gemessene Höhe des Textes (Welt-px) – Text-Objekte wachsen mit. `next`: danach
   * gleich den nächsten Zettel daneben anlegen (Tab). Leerer neuer Text legt nichts an, ein geleerter Text verschwindet.
   */
  commitEdit(text: string, opts: { height?: number; next?: boolean } = {}): string | undefined {
    const e = this.editing;
    if (!e) return undefined;
    this.editing = undefined;
    const value = text.replace(/\s+$/, "");
    let id = e.id;
    if (!id) {
      if (value !== "") {
        id = this.newID();
        const h = Math.max(TEXT_LINE, Math.ceil(opts.height ?? TEXT_LINE));
        if (this.session.add([{ id, kind: "text", z: frontZs(this.session.objects, 1)[0]!, x: e.rect.x, y: e.rect.y, w: e.rect.w, h, rot: 0, text: value }])) this.select([id]);
      }
    } else {
      const o = this.session.get(id);
      if (o && o.kind === "text" && value === "") this.session.remove([id]);
      else if (o && isConnector(o)) this.session.patch(new Map([[id, { label: value === "" ? undefined : value }]]));
      else if (o) this.session.patch(new Map([[id, { text: value === "" ? undefined : value, ...(o.kind === "text" && opts.height ? { h: Math.max(TEXT_LINE, Math.ceil(opts.height)) } : {}) }]]));
    }
    if (opts.next && e.kind === "note" && id) {
      const o = this.session.get(id);
      if (o && isShape(o)) this.create("note", { x: o.x + o.w + 16, y: o.y, w: o.w, h: o.h }, { edit: true });
    }
    this.changed();
    return id;
  }
  /** Klick auf ein Aufgaben-Kästchen in Markdown: abhaken bzw. wieder öffnen (wie in Notion, ohne Bearbeiten). */
  private toggleTaskAt(id: string, world: Point): boolean {
    if (this.readOnly || !this.taskAt) return false;
    const o = this.session.get(id);
    if (!o || !isShape(o) || isLocked(o) || !o.text || (o.kind !== "note" && o.kind !== "text" && o.kind !== "shape")) return false;
    const line = this.taskAt(o, world);
    if (line === undefined) return false;
    const next = toggleTask(o.text, line);
    if (next === o.text) return false;
    this.session.patch(new Map([[id, { text: next }]]));
    this.changed();
    return true;
  }
  cancelEdit() {
    if (!this.editing) return;
    this.editing = undefined;
    this.changed();
  }

  // MARK: Zeiger

  /** Mauszeiger (CSS `cursor`) für die Stelle. */
  cursorAt(p: Point): string {
    if (this.gesture?.kind === "pan") return "grabbing";
    if (this.tool === "hand" || this.space) return "grab";
    if (this.tool === "text") return "text";
    if (this.tool !== "select") return "crosshair";
    if (this.gesture?.kind === "resize") return HANDLE_CURSORS[this.gesture.handle];
    if (this.gesture?.kind === "move") return "move";
    const h = this.handleAt(p);
    if (h) return HANDLE_CURSORS[h];
    const world = screenToWorld(this.camera, p);
    const hit = this.pick(world, 2 / this.camera.zoom);
    if (!hit) return "default";
    const o = this.session.get(hit);
    if (!this.readOnly && this.taskAt && o && isShape(o) && !isLocked(o) && o.text && this.taskAt(o, world) !== undefined) return "pointer";
    return "move";
  }

  private handleAt(p: Point): Handle | undefined {
    if (this.readOnly || this.selection.size === 0) return undefined;
    const b = selectionBounds(this.session.objects, this.selection);
    if (!b || ![...this.selection].some((id) => { const o = this.session.get(id); return o && isShape(o); })) return undefined;
    return hitHandle(worldRectToScreen(this.camera, b), p, HANDLE_REACH);
  }

  private inkPoint(e: PointerInput): InkPoint {
    const w = screenToWorld(this.camera, { x: e.x, y: e.y });
    return { x: w.x, y: w.y, p: e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5 };
  }
  /** Tinte unter dem Radierer (Bildschirm-Punkt) einsammeln. */
  private eraseAt(p: Point, hit: Set<string>): boolean {
    const world = screenToWorld(this.camera, p);
    const reach = ERASER_REACH / this.camera.zoom;
    let found = false;
    for (const o of this.spatial.search({ x: world.x - reach, y: world.y - reach, w: reach * 2, h: reach * 2 })) {
      if (o.kind !== "ink" || hit.has(o.id) || !o.ink) continue;
      const bw = Number(o.style?.bw) || o.w || 1, bh = Number(o.style?.bh) || o.h || 1;
      const local = { x: ((world.x - o.x) * bw) / (o.w || 1), y: ((world.y - o.y) * bh) / (o.h || 1) };
      const pts = inkPointsOf(o.ink);
      let near = false;
      for (let i = 0; i < pts.length && !near; i++) {
        const a = pts[Math.max(0, i - 1)]!, b = pts[i]!;
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((local.x - a.x) * dx + (local.y - a.y) * dy) / len2));
        near = Math.hypot(a.x + t * dx - local.x, a.y + t * dy - local.y) <= reach + Number(o.style?.width ?? 2.6) / 2;
      }
      if (near) { hit.add(o.id); found = true; }
    }
    return found;
  }

  pointerDown(e: PointerInput) {
    // Present: ein Klick blättert weiter (am Ende zurück zur Fläche).
    if (this.presenting !== undefined) {
      if (e.button === 0 || e.button === undefined) this.present(this.presenting + 1 < this.slides().length ? this.presenting + 1 : undefined);
      return;
    }
    if (this.gesture) this.cancel();
    const p = { x: e.x, y: e.y };
    const world = screenToWorld(this.camera, p);
    if (e.button === 1 || e.pan || this.tool === "hand" || this.space) {
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
    if (isBoxTool(this.tool)) {
      if (!this.readOnly) this.gesture = { kind: "create", tool: this.tool, start: p, world };
      return;
    }
    // Umgedrehter Stift radiert, egal welches Werkzeug gewählt ist.
    if (!this.readOnly && (this.tool === "eraser" || (e.eraser && this.tool !== "lasso"))) {
      const hit = new Set<string>();
      this.gesture = { kind: "erase", hit, last: p };
      if (this.eraseAt(p, hit)) this.changed();
      return;
    }
    if (this.tool === "pen" || this.tool === "highlighter") {
      if (this.readOnly) return;
      this.gesture = { kind: "ink", tool: this.tool, points: [this.inkPoint(e)], pen: e.pressure !== undefined, rest: p, restAt: this.now() };
      this.pulse();
      return;
    }
    if (this.tool === "lasso") {
      this.gesture = { kind: "lasso", points: [world] };
      this.changed();
      return;
    }
    if (this.tool === "text") {
      const hit = this.spatial.hit(world, 2 / this.camera.zoom);
      const o = hit ? this.session.get(hit) : undefined;
      if (o && (o.kind === "text" || o.kind === "note")) this.startEdit(o.id); else this.startText(world);
      this.changed();
      return;
    }
    if (this.tool === "connector") {
      const hit = this.spatial.hit(world, 6 / this.camera.zoom);
      const o = hit ? this.session.get(hit) : undefined;
      if (o && isShape(o) && !this.readOnly) { this.gesture = { kind: "connect", from: o.id, to: world, target: undefined }; this.changed(); }
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
    const hit = this.pick(world, 2 / this.camera.zoom);
    if (hit && !e.shift && !e.alt && this.toggleTaskAt(hit, world)) return;
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
          // Ein Frame nimmt mit, was ganz in ihm liegt.
          const chosen = new Set(ids);
          for (const id of ids) {
            const f = this.session.get(id);
            if (!f || f.kind !== "frame") continue;
            for (const o of this.spatial.search(f)) if (isShape(o) && !chosen.has(o.id) && o.kind !== "frame" && !isLocked(o) && rectContains(f, objectBounds(o, this.session.byID)!)) { chosen.add(o.id); ids.push(o.id); }
          }
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
        this.selection = new Set([...g.base, ...objectsInRect(this.session.objects, rect, this.session.byID).filter((id) => !isLocked(this.session.get(id)!))]);
        break;
      }
      case "create":
        this.marquee = Math.hypot(p.x - g.start.x, p.y - g.start.y) < DRAG_THRESHOLD ? undefined : rectFromPoints(g.world, world);
        break;
      case "ink": {
        const pt = this.inkPoint(e);
        const last = g.points[g.points.length - 1]!;
        // Punkte, die auf dem Bildschirm unter einem halben px auseinanderliegen, bringen nichts.
        // „Ruhen“ am Ende eines Strichs: solange der Zeiger keine 4 px mehr wandert, läuft die Zeit.
        if (Math.hypot(p.x - g.rest.x, p.y - g.rest.y) > 4) {
          g.rest = p; g.restAt = this.now();
          // Weiterzeichnen hebt die Vorschau auf.
          if (g.snap) { g.snap = undefined; this.changed(); }
        }
        if (Math.hypot(pt.x - last.x, pt.y - last.y) * this.camera.zoom < 0.5) return;
        g.points.push(pt);
        this.pulse();
        return;
      }
      case "erase": {
        // Schnelle Bewegung: den Weg seit dem letzten Ereignis in Schritten abgehen, damit keine Linie übersprungen wird.
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - g.last.x, p.y - g.last.y) / ERASER_REACH));
        let found = false;
        for (let i = 1; i <= steps; i++) found = this.eraseAt({ x: g.last.x + ((p.x - g.last.x) * i) / steps, y: g.last.y + ((p.y - g.last.y) * i) / steps }, g.hit) || found;
        g.last = p;
        if (!found) return;
        break;
      }
      case "lasso":
        g.points.push(world);
        break;
      case "connect": {
        const hit = this.spatial.hit(world, 6 / this.camera.zoom);
        const o = hit ? this.session.get(hit) : undefined;
        g.to = world;
        g.target = o && isShape(o) && o.id !== g.from ? o.id : undefined;
        break;
      }
    }
    this.changed();
  }

  /** Den fertigen Strich als Objekt ablegen: ausgedünnt, relativ zu seinem Rahmen, kompakt kodiert. */
  /**
   * Snap shapes: die Ansicht ruft das kurz nach der letzten Bewegung. Liegt der Stift lange genug still und ähnelt der
   * Strich einer Form, erscheint die Form als Vorschau; beim Loslassen wird sie übernommen.
   */
  tick(): boolean {
    const g = this.gesture;
    if (g?.kind !== "ink" || g.tool !== "pen" || !this.snapShapes || g.snap || this.now() - g.restAt < SNAP_HOLD_MS) return false;
    const shape = recognizeShape(g.points);
    if (!shape) return false;
    g.snap = shape;
    this.announcement = shape.kind === "line" ? "Release to make a straight line" : `Release to make ${shape.kind === "oval" ? "an oval" : "a rectangle"}`;
    this.changed();
    return true;
  }

  private finishInk(g: Extract<Gesture, { kind: "ink" }>) {
    const s = g.tool === "pen" ? this.pen : this.highlighter;
    const width = (g.tool === "pen" ? PEN_WIDTHS : HIGHLIGHT_WIDTHS)[s.width] ?? 2.6;
    // Toleranz in Bildschirm-px: wer hineinzoomt und fein zeichnet, behält die Feinheit.
    // Snap shapes: am Ende kurz halten macht aus dem Strich eine gerade Linie, ein Rechteck oder ein Oval.
    const shape = g.snap ?? (g.tool === "pen" && this.snapShapes && this.now() - g.restAt >= SNAP_HOLD_MS ? recognizeShape(g.points) : undefined);
    if (shape && shape.kind !== "line") {
      const id = this.newID();
      const r = shape.bounds;
      this.session.add([{ id, kind: "shape", z: frontZs(this.session.objects, 1)[0]!, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), rot: 0, style: { shape: shape.kind } }]);
      this.announcement = shape.kind === "oval" ? "Snapped to an oval" : "Snapped to a rectangle";
      return;
    }
    if (shape) g.points = [g.points[0]!, g.points[g.points.length - 1]!].map((q) => ({ ...q, p: 0.5 }));
    const tol = Math.min(1.5, Math.max(0.05, 0.35 / this.camera.zoom));
    const geo = inkObjectGeometry(simplifyInk(g.points, tol), width);
    if (!geo) return;
    const id = this.newID();
    this.session.add([{
      id, kind: "ink", z: frontZs(this.session.objects, 1)[0]!, x: geo.x, y: geo.y, w: geo.w, h: geo.h, rot: 0, ink: encodeInk(geo.points),
      style: { color: s.color, width, bw: geo.w, bh: geo.h, ...(g.tool === "highlighter" ? { tool: "hl" } : {}), ...(g.pen ? {} : { sim: true }) },
    }]);
  }

  pointerUp(e: PointerInput) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = undefined;
    const world = screenToWorld(this.camera, { x: e.x, y: e.y });
    switch (g.kind) {
      case "ink":
        this.finishInk(g);
        break;
      case "erase":
        if (g.hit.size) {
          const n = this.session.remove([...g.hit]).length;
          if (n) this.announcement = n === 1 ? "Erased 1 line" : `Erased ${n} lines`;
        }
        break;
      case "lasso": {
        const poly = g.points;
        const ids: string[] = [];
        const box = unionRect(poly.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 })));
        if (box && poly.length >= 3) {
          for (const o of this.spatial.search(box)) {
            if (!isShape(o)) continue;
            if (o.kind === "ink" && o.ink) {
              const bw = Number(o.style?.bw) || o.w || 1, bh = Number(o.style?.bh) || o.h || 1;
              const pts = inkPointsOf(o.ink).map((q) => ({ x: o.x + (q.x * o.w) / bw, y: o.y + (q.y * o.h) / bh }));
              if (shareInside(pts, poly) >= 0.6) ids.push(o.id);
            } else if (o.kind !== "frame" && !isLocked(o) && pointInPolygon({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, poly)) ids.push(o.id);
          }
        }
        // Mit der Auswahl geht es beim Auswahl-Werkzeug weiter: verschieben, duplizieren, löschen.
        if (ids.length) { this.tool = "select"; this.select(ids); } else this.clearSelection();
        break;
      }
      case "connect":
        if (g.target) {
          const id = this.newID();
          if (this.session.add([{ id, kind: "connector", z: frontZs(this.session.objects, 1)[0]!, from: { id: g.from, side: "auto" }, to: { id: g.target, side: "auto" }, shape: "curved" }])) this.select([id]);
        }
        break;
      case "press": {
        // Doppelklick: Text des Objekts bearbeiten bzw. an einer leeren Stelle lostippen.
        const at = this.now();
        const twice = this.lastClick !== undefined && at - this.lastClick.at <= DOUBLE_CLICK_MS && this.lastClick.hit === g.hit && Math.hypot(e.x - this.lastClick.p.x, e.y - this.lastClick.p.y) <= 6;
        this.lastClick = twice ? undefined : { at, p: { x: e.x, y: e.y }, hit: g.hit };
        const target = g.hit ? this.session.get(g.hit) : undefined;
        if (twice && target && isShape(target) && (target.kind === "file" || target.kind === "image")) { this.onOpenFile?.(target); break; }
        if (twice && target && isShape(target) && target.kind === "page" && target.ref && target.style?.full !== true) { this.onOpenPage?.(target.ref); break; }
        if (twice && !this.readOnly && !g.shift) {
          if (g.hit ? this.startEdit(g.hit) : this.startText(g.world)) break;
        }
        // Klick ohne Ziehen: ⇧ auf ein schon gewähltes Objekt nimmt es heraus, Klick ins Leere löst die Auswahl.
        if (g.hit && g.shift && g.wasSelected) this.select([...this.selection].filter((id) => id !== g.hit));
        else if (g.hit && !g.shift && this.selection.size > 1) this.select([g.hit]);
        else if (!g.hit && !g.shift) this.clearSelection();
        break;
      }
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
        this.create(g.tool, drawn && drawn.w >= 8 && drawn.h >= 8 ? drawn : { x: g.world.x - s.w / 2, y: g.world.y - s.h / 2, ...s }, { edit: true });
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
    if (this.gesture?.kind === "ink") this.inkVersion += 1;
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
    if (this.presenting !== undefined) {
      if (k === "Escape") this.present(undefined);
      else if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "Enter" || k === "PageDown") this.present(this.presenting + 1);
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") this.present(this.presenting - 1);
      else if (k === "Home") this.present(0);
      else if (k === "End") this.present(this.slides().length - 1);
      return true;
    }
    if (e.mod) {
      if (k === "z") { if (e.shift) this.redo(); else this.undo(); return true; }
      if (k === "y") { this.redo(); return true; }
      if (k === "a") { this.selectAll(); return true; }
      if (k === "d") { this.duplicateSelection(); return true; }
      if (k === "=" || k === "+") { this.zoomIn(); return true; }
      if (k === "-") { this.zoomOut(); return true; }
      if (k === "0") { this.fit(); return true; }
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
    if (k === "Enter" && isBoxTool(this.tool)) return this.createAtCenter(this.tool) !== undefined;
    if (k === "Enter" && this.selection.size === 1) {
      const only = this.session.get([...this.selection][0]!);
      if (only && isShape(only) && only.kind === "page" && only.ref) { this.onOpenPage?.(only.ref); return true; }
    }
    if (k === "Enter" && this.selection.size === 1) return this.startEdit([...this.selection][0]!) ? (this.changed(), true) : false;
    const d = nudgeDelta(e.key, e.shift === true);
    if (d) return this.selection.size > 0 ? this.nudge(d) : (this.setCamera(panBy(this.camera, -d.x * 40, -d.y * 40)), true);
    // Text-Werkzeug gewählt und einfach losgetippt: der Text beginnt dort, wo der Zeiger ist (sonst in der Mitte).
    if (this.tool === "text" && !this.readOnly && e.key.length === 1 && e.key !== " ") {
      const at = this.hover ?? screenToWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 });
      this.startText(at, e.key);
      this.changed();
      return true;
    }
    if (e.repeat) return false;
    if (!e.shift && (k === "o" || k === "d")) { this.setShapeKind(k === "o" ? "oval" : "diamond"); return !this.readOnly; }
    if (!e.shift && k === "r") this.shapeKind = "rect";
    const tool = BOARD_TOOLS.find((t) => t.key.toLowerCase() === (e.shift ? "⇧" + k : k));
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
    const erased = g?.kind === "erase" && g.hit.size ? g.hit : undefined;
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
    if (erased) objects = objects.filter((o) => !erased.has(o.id));
    const fromObj = g?.kind === "connect" ? base.get(g.from) : undefined;
    const targetObj = g?.kind === "connect" && g.target ? base.get(g.target) : undefined;
    const selection = ghosts.length ? new Set(ghosts.map((c) => c.id)) : this.selection;
    const all = overrides.size === 0 ? this.session.objects : [...byID.values()];
    const scene: BoardScene = {
      camera: this.camera, objects, byID, selection,
      selectionBounds: selection.size ? selectionBounds(all, selection) : undefined,
      handles: !this.readOnly && g?.kind !== "marquee" && g?.kind !== "move" && [...selection].some((id) => { const o = byID.get(id); return o !== undefined && isShape(o); }),
      marquee: this.marquee,
      focused: this.focused,
      lasso: g?.kind === "lasso" ? g.points : undefined,
      connecting: g?.kind === "connect" && fromObj && isShape(fromObj) ? { from: fromObj, to: g.to, target: targetObj && isShape(targetObj) ? targetObj : undefined } : undefined,
      editing: this.editing?.id,
      background: this.session.background,
      previewScroll: this.previewScroll,
      snap: g?.kind === "ink" && g.snap ? { ...g.snap, from: g.points[0]!, to: g.points[g.points.length - 1]! } : undefined,
    };
    this.sceneCache = { key, scene };
    return scene;
  }
}

const HANDLE_CURSORS: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
