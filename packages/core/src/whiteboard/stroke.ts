// BSD-265 (Whiteboard 3): Geometrie der Tinte, ohne DOM. Ein Strich ist eine Punktfolge (x, y, Druck) relativ zur
// linken oberen Ecke seines Objekts. Hier: Punkte ausdünnen (weniger Daten bei gleichem Bild), Rahmen, Treffer für
// Auswahl und Radierer, Lasso (Punkt im Vieleck).
import { decodeInk, type InkPoint } from "./ink.js";
import type { Point, Rect } from "./viewport.js";

const cache = new WeakMap<Uint8Array, InkPoint[]>();
/** Punkte eines Strichs, je Byte-Folge einmal entpackt. Unlesbares (neueres Format) ergibt eine leere Liste. */
export function inkPointsOf(bytes: Uint8Array): InkPoint[] {
  let pts = cache.get(bytes);
  if (!pts) {
    try { pts = decodeInk(bytes); } catch { pts = []; }
    cache.set(bytes, pts);
  }
  return pts;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * Punkte ausdünnen (Ramer–Douglas–Peucker, ohne Rekursion): alles, was näher als `tolerance` an der Linie zwischen
 * zwei behaltenen Punkten liegt, fällt weg. Ein Punkt bleibt auch, wenn sich der Druck dort deutlich ändert – sonst
 * verliert ein Strich mit dem Stift seine An- und Abschwellung. Erster und letzter Punkt bleiben immer.
 */
export function simplifyInk(points: readonly InkPoint[], tolerance = 0.35, pressureStep = 0.12): InkPoint[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const hi = stack.pop()!, lo = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!, b = points[hi]!;
    let worst = -1, at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const d = segDist2(p.x, p.y, a.x, a.y, b.x, b.y);
      // Druck entlang der Strecke linear angenommen; Abweichung zählt wie Abstand.
      const t = (i - lo) / (hi - lo);
      const dp = Math.abs(p.p - (a.p + (b.p - a.p) * t));
      const score = Math.max(d / tol2, dp / pressureStep);
      if (score > worst) { worst = score; at = i; }
    }
    if (worst > 1 && at > 0) {
      keep[at] = 1;
      stack.push(lo, at, at, hi);
    }
  }
  const out: InkPoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Rahmen um die Punkte (ohne Strichbreite). */
export function inkBounds(points: readonly Point[]): Rect | undefined {
  if (points.length === 0) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Welt-Punkte eines fertigen Strichs in ein Objekt umrechnen: Rahmen mit `pad` (halbe Strichbreite) als x/y/w/h,
 * Punkte relativ dazu. Die Grundgröße (`bw`/`bh`) merkt sich das Objekt, damit späteres Skalieren die Punkte streckt.
 */
export function inkObjectGeometry(world: readonly InkPoint[], pad: number): { x: number; y: number; w: number; h: number; points: InkPoint[] } | undefined {
  const b = inkBounds(world);
  if (!b) return undefined;
  const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad);
  const w = Math.max(1, Math.ceil(b.x + b.w + pad) - x), h = Math.max(1, Math.ceil(b.y + b.h + pad) - y);
  return { x, y, w, h, points: world.map((p) => ({ x: p.x - x, y: p.y - y, p: p.p })) };
}

/** Kleinster Abstand eines Punkts zur Punktfolge (ein einzelner Punkt zählt als Punkt). */
export function distanceToInk(points: readonly Point[], p: Point): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(points[0]!.x - p.x, points[0]!.y - p.y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const d = segDist2(p.x, p.y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Liegt der Punkt im (automatisch geschlossenen) Vieleck? Gerade-ungerade-Regel. */
export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Anteil der Punkte, die im Lasso liegen (0…1). */
export function shareInside(points: readonly Point[], poly: readonly Point[]): number {
  if (points.length === 0 || poly.length < 3) return 0;
  let n = 0;
  for (const p of points) if (pointInPolygon(p, poly)) n += 1;
  return n / points.length;
}

/**
 * BSD-265 „Snap shapes“: erkennt in einem Strich eine gerade Linie, ein Rechteck oder ein Oval. `undefined`, wenn
 * er keiner Form klar ähnelt (dann bleibt er Handschrift). Geschlossen heißt: Anfang und Ende liegen nah beieinander.
 */
export function recognizeShape(points: readonly Point[]): { kind: "line" | "rect" | "oval"; bounds: Rect } | undefined {
  const b = inkBounds(points);
  if (!b || points.length < 2) return undefined;
  const a = points[0]!, z = points[points.length - 1]!;
  const chord = Math.hypot(z.x - a.x, z.y - a.y), diag = Math.hypot(b.w, b.h);
  if (diag < 24) return undefined;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  if (chord > 0.2 * diag) {
    // Offen: gerade, wenn kein Punkt weit von der Sehne abweicht und der Weg kaum länger ist als sie.
    let worst = 0;
    for (const p of points) worst = Math.max(worst, Math.sqrt(segDist2(p.x, p.y, a.x, a.y, z.x, z.y)));
    return worst <= Math.max(3, 0.06 * chord) && length <= chord * 1.15 ? { kind: "line", bounds: b } : undefined;
  }
  if (b.w < 16 || b.h < 16 || length < diag * 1.6) return undefined;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  let oval = 0, rect = 0;
  for (const p of points) {
    const u = (p.x - cx) / (b.w / 2), v = (p.y - cy) / (b.h / 2);
    oval += Math.abs(Math.hypot(u, v) - 1);
    rect += 1 - Math.max(Math.abs(u), Math.abs(v));
  }
  oval /= points.length; rect /= points.length;
  if (Math.min(oval, rect) > 0.16) return undefined;
  return { kind: oval < rect ? "oval" : "rect", bounds: b };
}
