// BSD-264 (Whiteboard 2): Geometrie der Board-Fläche – Treffer, Auswahlrahmen, Griffe, Größe ändern, Raumindex.
// Alles in Weltkoordinaten und ohne DOM, damit Auswahl und Ziehen als reine Funktionen getestet werden können.
import RBush from "rbush";
import { keyBetween } from "../sortkeys.js";
import { bounds, sortByZ, type ConnectorSide, type WBConnector, type WBObject, type WBShape } from "./model.js";
import { rectsIntersect, unionRect, type Point, type Rect } from "./viewport.js";
import { distanceToInk, inkPointsOf } from "./stroke.js";

/** Höhe der Titelzeile eines Frames und Breite seines greifbaren Rands (Welt-px). */
export const FRAME_TITLE_HEIGHT = 40;
export const FRAME_EDGE = 10;

export const isConnector = (o: WBObject): o is WBConnector => o.kind === "connector";
export const isShape = (o: WBObject): o is WBShape => o.kind !== "connector";

/** Kleinste Kantenlänge beim Aufziehen und Verkleinern (Welt-px). */
export const MIN_OBJECT_SIZE = 8;

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function sidePoint(r: Rect, side: Exclude<ConnectorSide, "auto">): Point {
  switch (side) {
    case "top": return { x: r.x + r.w / 2, y: r.y };
    case "bottom": return { x: r.x + r.w / 2, y: r.y + r.h };
    case "left": return { x: r.x, y: r.y + r.h / 2 };
    case "right": return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

/** Seite von `r`, die zu `toward` zeigt (für Ankerseite „auto“). */
export function facingSide(r: Rect, toward: Point): Exclude<ConnectorSide, "auto"> {
  const c = center(r);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  // Mit dem Seitenverhältnis gewichten: bei einem breiten Kasten zählt „links/rechts“ erst weiter draußen.
  if (Math.abs(dx) * Math.max(1, r.h) >= Math.abs(dy) * Math.max(1, r.w)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** Endpunkte einer Verbindung; `undefined`, wenn ein Ende fehlt oder selbst eine Verbindung ist. */
export function connectorPoints(c: WBConnector, byID: ReadonlyMap<string, WBObject>): { from: Point; to: Point } | undefined {
  const a = byID.get(c.from.id), b = byID.get(c.to.id);
  if (!a || !b || !isShape(a) || !isShape(b)) return undefined;
  const ra = bounds(a), rb = bounds(b);
  const sa = c.from.side === "auto" ? facingSide(ra, center(rb)) : c.from.side;
  const sb = c.to.side === "auto" ? facingSide(rb, center(ra)) : c.to.side;
  return { from: sidePoint(ra, sa), to: sidePoint(rb, sb) };
}

/** Achsenparalleles Rechteck um ein Objekt (Sichtbarkeit, Auswahlrahmen, Raumindex). */
export function objectBounds(o: WBObject, byID: ReadonlyMap<string, WBObject>): Rect | undefined {
  if (isShape(o)) return bounds(o);
  const p = connectorPoints(o, byID);
  return p ? { x: Math.min(p.from.x, p.to.x), y: Math.min(p.from.y, p.to.y), w: Math.abs(p.from.x - p.to.x), h: Math.abs(p.from.y - p.to.y) } : undefined;
}

export function indexByID(objs: readonly WBObject[]): Map<string, WBObject> {
  return new Map(objs.map((o) => [o.id, o]));
}

/** Rahmen um mehrere Objekte (die Auswahl). */
export function selectionBounds(objs: readonly WBObject[], ids: ReadonlySet<string>): Rect | undefined {
  const byID = indexByID(objs);
  const rects: Rect[] = [];
  for (const id of ids) {
    const o = byID.get(id);
    const r = o ? objectBounds(o, byID) : undefined;
    if (r) rects.push(r);
  }
  return unionRect(rects);
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Liegt der Weltpunkt auf dem Objekt? `tolerance` in Welt-px (Finger/Zeiger, dünne Linien). */
export function hitsObject(o: WBObject, p: Point, byID: ReadonlyMap<string, WBObject>, tolerance = 0): boolean {
  if (isConnector(o)) {
    const pts = connectorPoints(o, byID);
    return pts ? distToSegment(p, pts.from, pts.to) <= Math.max(4, tolerance) : false;
  }
  // In das ungedrehte Koordinatensystem des Objekts drehen.
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const r = (-o.rot * Math.PI) / 180;
  const dx = p.x - cx, dy = p.y - cy;
  const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
  const hw = o.w / 2 + tolerance, hh = o.h / 2 + tolerance;
  if (Math.abs(lx) > hw || Math.abs(ly) > hh) return false;
  if (o.kind === "ink" && o.ink) {
    // Tinte: nur der Strich selbst zählt, nicht sein Rahmen – sonst verdeckt eine große Skizze alles darunter.
    const bw = Number(o.style?.bw) || o.w || 1, bh = Number(o.style?.bh) || o.h || 1;
    const sx = o.w > 0 ? bw / o.w : 1, sy = o.h > 0 ? bh / o.h : 1;
    const reach = Number(o.style?.width ?? 2.6) / 2 + Math.max(4, tolerance);
    return distanceToInk(inkPointsOf(o.ink), { x: (lx + o.w / 2) * sx, y: (ly + o.h / 2) * sy }) <= reach * Math.max(sx, sy);
  }
  if (o.kind === "frame") {
    // Frame: greifbar an Titelzeile und Rand; die Fläche innen gehört den Objekten darin (Aufziehen, Zeichnen).
    return ly + o.h / 2 <= FRAME_TITLE_HEIGHT || Math.abs(lx) >= o.w / 2 - FRAME_EDGE || ly >= o.h / 2 - FRAME_EDGE;
  }
  if (o.kind === "shape" && o.style?.shape === "oval") return hw > 0 && hh > 0 && (lx * lx) / (hw * hw) + (ly * ly) / (hh * hh) <= 1;
  if (o.kind === "shape" && o.style?.shape === "diamond") return hw > 0 && hh > 0 && Math.abs(lx) / hw + Math.abs(ly) / hh <= 1;
  return true;
}

/** Vorderstes Objekt unter dem Punkt. `objs` in beliebiger Reihenfolge (wird nach z sortiert, wenn `sorted` fehlt). */
export function hitTest(objs: readonly WBObject[], p: Point, opts: { tolerance?: number; sorted?: boolean; byID?: ReadonlyMap<string, WBObject> } = {}): string | undefined {
  const list = opts.sorted ? objs : sortByZ(objs);
  const byID = opts.byID ?? indexByID(objs);
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i]!;
    if (hitsObject(o, p, byID, opts.tolerance ?? 0)) return o.id;
  }
  return undefined;
}

/** Objekte, die das Aufzieh-Rechteck berührt (Verbindungen nur, wenn sie ganz darin liegen). */
export function objectsInRect(objs: readonly WBObject[], rect: Rect, byID: ReadonlyMap<string, WBObject> = indexByID(objs)): string[] {
  const out: string[] = [];
  for (const o of objs) {
    const r = objectBounds(o, byID);
    if (!r) continue;
    if (isConnector(o) ? r.x >= rect.x && r.y >= rect.y && r.x + r.w <= rect.x + rect.w && r.y + r.h <= rect.y + rect.h : rectsIntersect(r, rect)) out.push(o.id);
  }
  return out;
}

// MARK: Griffe

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type Handle = (typeof HANDLES)[number];

/** Mittelpunkt eines Griffs am Rahmen. */
export function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : r.x + r.w / 2;
  const y = h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

/** Griff unter dem Punkt (Ecken zuerst); `reach` = halbe Trefferbreite in denselben Einheiten wie `r`. */
export function hitHandle(r: Rect, p: Point, reach: number): Handle | undefined {
  const order: Handle[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
  for (const h of order) {
    const c = handlePoint(r, h);
    if (Math.abs(p.x - c.x) <= reach && Math.abs(p.y - c.y) <= reach) return h;
  }
  return undefined;
}

/**
 * Rahmen nach dem Ziehen eines Griffs um `d`. Die gegenüberliegende Kante bleibt stehen; unter die Mindestgröße
 * geht es nicht (kein Umklappen). `keepAspect` (⇧, nur an Ecken wirksam): Seitenverhältnis des Startrahmens halten.
 */
export function resizeRect(start: Rect, h: Handle, d: Point, opts: { keepAspect?: boolean; min?: number } = {}): Rect {
  const min = opts.min ?? MIN_OBJECT_SIZE;
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
  if (h.includes("w")) x0 = Math.min(x0 + d.x, x1 - min);
  if (h.includes("e")) x1 = Math.max(x1 + d.x, x0 + min);
  if (h.includes("n")) y0 = Math.min(y0 + d.y, y1 - min);
  if (h.includes("s")) y1 = Math.max(y1 + d.y, y0 + min);
  if (opts.keepAspect && h.length === 2 && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    let w = x1 - x0, hgt = y1 - y0;
    if (w / hgt > ratio) hgt = w / ratio; else w = hgt * ratio;
    if (h.includes("w")) x0 = x1 - w; else x1 = x0 + w;
    if (h.includes("n")) y0 = y1 - hgt; else y1 = y0 + hgt;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Lage eines Objekts, wenn der Auswahlrahmen von `from` nach `to` skaliert wird (mehrere Objekte gemeinsam). */
export function scaleInto(obj: Rect, from: Rect, to: Rect, min = MIN_OBJECT_SIZE): Rect {
  const sx = from.w > 0 ? to.w / from.w : 1, sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (obj.x - from.x) * sx, y: to.y + (obj.y - from.y) * sy, w: Math.max(min, obj.w * sx), h: Math.max(min, obj.h * sy) };
}

// MARK: Tastatur

/** Pfeiltaste → Versatz: 1 px, mit ⇧ 10 px. */
export function nudgeDelta(key: string, shift: boolean): Point | undefined {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft": return { x: -step, y: 0 };
    case "ArrowRight": return { x: step, y: 0 };
    case "ArrowUp": return { x: 0, y: -step };
    case "ArrowDown": return { x: 0, y: step };
    default: return undefined;
  }
}

/** Tab-Reihenfolge: in Leserichtung (Zeilen von oben nach unten, darin von links nach rechts). Verbindungen zuletzt. */
export function readingOrder(objs: readonly WBObject[]): string[] {
  const byID = indexByID(objs);
  const rows = objs.map((o) => ({ o, r: objectBounds(o, byID) })).filter((x): x is { o: WBObject; r: Rect } => x.r !== undefined);
  const ROW = 40;
  return rows.sort((a, b) => {
    const ca = isConnector(a.o) ? 1 : 0, cb = isConnector(b.o) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const ra = Math.floor(a.r.y / ROW), rb = Math.floor(b.r.y / ROW);
    if (ra !== rb) return ra - rb;
    if (a.r.x !== b.r.x) return a.r.x - b.r.x;
    return a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0;
  }).map((x) => x.o.id);
}

// MARK: Duplizieren

/**
 * Kopien der gewählten Objekte, um `offset` versetzt und ganz vorn. Verbindungen kommen nur mit, wenn beide Enden
 * mitkopiert werden; ihre Enden zeigen dann auf die Kopien. Reihenfolge der Kopien untereinander bleibt.
 */
export function duplicateObjects(objs: readonly WBObject[], ids: ReadonlySet<string>, newID: () => string, offset: Point): WBObject[] {
  const picked = sortByZ(objs.filter((o) => ids.has(o.id)));
  const idMap = new Map<string, string>();
  for (const o of picked) if (isShape(o)) idMap.set(o.id, newID());
  let z = objs.reduce<string | undefined>((m, o) => (m === undefined || o.z > m ? o.z : m), undefined);
  const out: WBObject[] = [];
  for (const o of picked) {
    if (isConnector(o)) {
      const from = idMap.get(o.from.id), to = idMap.get(o.to.id);
      if (!from || !to) continue;
      z = keyBetween(z, undefined);
      out.push({ ...structuredClone(o), id: newID(), z, from: { ...o.from, id: from }, to: { ...o.to, id: to } });
    } else {
      z = keyBetween(z, undefined);
      out.push({ ...structuredClone(o), id: idMap.get(o.id)!, z, x: o.x + offset.x, y: o.y + offset.y });
    }
  }
  return out;
}

/** `n` aufeinanderfolgende z-Werte vor allem Vorhandenen (neue Objekte, „nach vorn“ für mehrere). */
export function frontZs(objs: readonly { z: string }[], n: number): string[] {
  let z = objs.reduce<string | undefined>((m, o) => (m === undefined || o.z > m ? o.z : m), undefined);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    z = keyBetween(z, undefined);
    out.push(z);
  }
  return out;
}

// MARK: Raumindex

interface IndexItem { minX: number; minY: number; maxX: number; maxY: number; id: string }

/**
 * Raumindex (R-Baum, rbush) über die Rahmen der Objekte: „was ist sichtbar“ und „was liegt unter dem Zeiger“ in
 * O(log n) statt über alle Objekte. Wird bei Änderungen neu aufgebaut (Bulk-Load, auch bei 10 000 Objekten wenige ms).
 */
export class BoardIndex {
  private tree = new RBush<IndexItem>();
  private byID: ReadonlyMap<string, WBObject> = new Map();
  /** Von hinten nach vorn. */
  private order = new Map<string, number>();
  size = 0;

  /** `sorted`: Objekte von hinten nach vorn (sortByZ). */
  load(sorted: readonly WBObject[]) {
    this.byID = indexByID(sorted);
    this.order = new Map(sorted.map((o, i) => [o.id, i]));
    const items: IndexItem[] = [];
    for (const o of sorted) {
      const r = objectBounds(o, this.byID);
      if (r) items.push({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h, id: o.id });
    }
    this.tree = new RBush<IndexItem>();
    this.tree.load(items);
    this.size = items.length;
  }

  get objects(): ReadonlyMap<string, WBObject> {
    return this.byID;
  }

  /** Objekte, deren Rahmen `rect` berührt, von hinten nach vorn. */
  search(rect: Rect): WBObject[] {
    const hits = this.tree.search({ minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h });
    return hits.map((h) => this.byID.get(h.id)!).sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }

  /** Vorderstes Objekt unter dem Punkt. */
  hit(p: Point, tolerance = 0, skip?: (o: WBObject) => boolean): string | undefined {
    const near = this.search({ x: p.x - tolerance - 4, y: p.y - tolerance - 4, w: tolerance * 2 + 8, h: tolerance * 2 + 8 });
    for (let i = near.length - 1; i >= 0; i--) if (!skip?.(near[i]!) && hitsObject(near[i]!, p, this.byID, tolerance)) return near[i]!.id;
    return undefined;
  }

  /** Rahmen um alles (Fit, Minimap). */
  extent(): Rect | undefined {
    if (this.size === 0) return undefined;
    const d = this.tree.toJSON() as { minX: number; minY: number; maxX: number; maxY: number };
    return { x: d.minX, y: d.minY, w: d.maxX - d.minX, h: d.maxY - d.minY };
  }
}
