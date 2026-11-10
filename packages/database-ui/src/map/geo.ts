// Karte ohne fremde Server: Web-Mercator-Projektion, Ausschnitt (Mitte + Zoom), Zoomen um einen Punkt, Bounds-Fit,
// Clustering und Gradnetz – reine Funktionen. Weltkoordinaten: x, y in [0, 1] (0/0 = 180° W, 85,05° N).

export const MAX_LAT = 85.05112878;
export const TILE = 256;
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 18;

export interface LonLat { lon: number; lat: number }
export interface Pt { x: number; y: number }
/** Ausschnitt: Mitte in Weltkoordinaten, Zoom (Weltbreite = TILE · 2^zoom Pixel). */
export interface Viewport { cx: number; cy: number; zoom: number }
export interface Size { width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function project({ lon, lat }: LonLat): Pt {
  const φ = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  return { x: (lon + 180) / 360, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + φ / 2)) / (2 * Math.PI) };
}

export function unproject({ x, y }: Pt): LonLat {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return { lon: x * 360 - 180, lat };
}

export const worldSize = (zoom: number) => TILE * 2 ** zoom;

/** Ausschnitt gültig halten: Zoom begrenzt, senkrecht nicht über die Welt hinaus, waagrecht umlaufend. */
export function clampViewport(vp: Viewport, size: Size, minZoom = MIN_ZOOM, maxZoom = MAX_ZOOM): Viewport {
  const fitZoom = Math.log2(Math.max(1, size.height) / TILE);
  const zoom = clamp(vp.zoom, Math.max(minZoom, Math.min(fitZoom, maxZoom)), maxZoom);
  const half = size.height / 2 / worldSize(zoom);
  const cy = half >= 0.5 ? 0.5 : clamp(vp.cy, half, 1 - half);
  const cx = ((vp.cx % 1) + 1) % 1;
  return { cx, cy, zoom };
}

export function toScreen(p: Pt, vp: Viewport, size: Size): Pt {
  const w = worldSize(vp.zoom);
  // kürzester Weg um die Welt (Pins nahe der Datumsgrenze)
  let dx = p.x - vp.cx;
  if (dx > 0.5) dx -= 1;
  else if (dx < -0.5) dx += 1;
  return { x: size.width / 2 + dx * w, y: size.height / 2 + (p.y - vp.cy) * w };
}

export function fromScreen(s: Pt, vp: Viewport, size: Size): Pt {
  const w = worldSize(vp.zoom);
  return { x: vp.cx + (s.x - size.width / 2) / w, y: vp.cy + (s.y - size.height / 2) / w };
}

export function pan(vp: Viewport, dx: number, dy: number, size: Size): Viewport {
  const w = worldSize(vp.zoom);
  return clampViewport({ cx: vp.cx - dx / w, cy: vp.cy - dy / w, zoom: vp.zoom }, size);
}

/** Zoomen um einen Bildschirmpunkt: der Ort unter dem Zeiger bleibt, wo er ist. */
export function zoomAt(vp: Viewport, delta: number, at: Pt, size: Size): Viewport {
  const before = fromScreen(at, vp, size);
  const next = clampViewport({ ...vp, zoom: vp.zoom + delta }, size);
  const w = worldSize(next.zoom);
  return clampViewport({ cx: before.x - (at.x - size.width / 2) / w, cy: before.y - (at.y - size.height / 2) / w, zoom: next.zoom }, size);
}

/**
 * Ausschnitt, der alle Punkte mit Rand zeigt. Leer: ganze Welt; ein Punkt (oder alle am selben Ort): `singleZoom`.
 * Liegen die Punkte über die Datumsgrenze verteilt, wird die kürzere Seite um die Welt gewählt.
 */
export function fitBounds(points: readonly LonLat[], size: Size, opts: { padding?: number; singleZoom?: number; maxZoom?: number } = {}): Viewport {
  const padding = opts.padding ?? 48, maxZoom = opts.maxZoom ?? 16;
  if (points.length === 0) return clampViewport({ cx: 0.5, cy: 0.5, zoom: 0 }, size);
  const ps = points.map(project);
  const ys = ps.map((p) => p.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Größte Lücke zwischen den x-Werten (zyklisch) bestimmt, wo die Box „aufgeschnitten“ wird.
  const xs = ps.map((p) => p.x).sort((a, b) => a - b);
  let gap = xs[0]! + 1 - xs[xs.length - 1]!, start = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! - xs[i - 1]! > gap) { gap = xs[i]! - xs[i - 1]!; start = xs[i]!; }
  const spanX = 1 - gap, spanY = maxY - minY;
  const cx = start + spanX / 2, cy = (minY + maxY) / 2;
  if (spanX < 1e-9 && spanY < 1e-9) return clampViewport({ cx, cy, zoom: opts.singleZoom ?? 12 }, size);
  const availW = Math.max(1, size.width - 2 * padding), availH = Math.max(1, size.height - 2 * padding);
  const zx = spanX > 0 ? Math.log2(availW / (spanX * TILE)) : Infinity;
  const zy = spanY > 0 ? Math.log2(availH / (spanY * TILE)) : Infinity;
  return clampViewport({ cx, cy, zoom: Math.min(zx, zy, maxZoom) }, size);
}

export interface Cluster<T> {
  /** Bildschirmposition (Mittel der Mitglieder). */
  x: number;
  y: number;
  items: T[];
}

/**
 * Pins zusammenfassen, die näher als `radius` Pixel beieinander liegen (Gitter mit Zellgröße `radius`, Nachbarzellen
 * werden zusammengeführt) – O(n), auch für Tausende Zeilen. Reihenfolge stabil (nach erstem Mitglied).
 */
export function cluster<T>(items: readonly { item: T; x: number; y: number }[], radius: number): Cluster<T>[] {
  const cells = new Map<string, { sx: number; sy: number; items: T[]; first: number }>();
  items.forEach((p, i) => {
    const key = Math.floor(p.x / radius) + ":" + Math.floor(p.y / radius);
    const c = cells.get(key);
    if (c) { c.sx += p.x; c.sy += p.y; c.items.push(p.item); }
    else cells.set(key, { sx: p.x, sy: p.y, items: [p.item], first: i });
  });
  // Zellen, deren Mittelpunkte zu nah sind, zusammenlegen (ein Durchgang über Nachbarzellen).
  const list = [...cells.entries()].map(([key, c]) => ({ key, ...c, x: c.sx / c.items.length, y: c.sy / c.items.length, merged: false }));
  const byKey = new Map(list.map((c) => [c.key, c]));
  for (const c of list) {
    if (c.merged) continue;
    const [gx, gy] = c.key.split(":").map(Number) as [number, number];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const o = byKey.get(`${gx + dx}:${gy + dy}`);
      if (!o || o.merged || o === c || Math.hypot(o.x - c.x, o.y - c.y) >= radius) continue;
      c.sx += o.sx; c.sy += o.sy; c.items.push(...o.items); c.first = Math.min(c.first, o.first);
      c.x = c.sx / c.items.length; c.y = c.sy / c.items.length;
      o.merged = true;
    }
  }
  return list.filter((c) => !c.merged).sort((a, b) => a.first - b.first).map((c) => ({ x: c.x, y: c.y, items: c.items }));
}

/** Abstand der Gradnetzlinien (Grad) für einen Zoom: etwa alle 2–4 Linien pro 512 px. */
export function graticuleStep(zoom: number): number {
  const steps = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1];
  const degPer512 = (512 / worldSize(zoom)) * 360;
  return steps.find((s) => s <= degPer512 / 2) ?? 0.1;
}

/** Ringe [lon, lat, …] → SVG-Pfad in Weltkoordinaten (für eine Skalierung per transform). */
export function ringsToPath(rings: readonly (readonly number[])[]): string {
  const out: string[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      const p = project({ lon: r[i]!, lat: r[i + 1]! });
      out.push((i === 0 ? "M" : "L") + p.x.toFixed(5) + " " + p.y.toFixed(5));
    }
    out.push("Z");
  }
  return out.join("");
}

/** Höhe der Karte je `mapHeight` (Notion: small/medium/large/extraLarge) als Vielfache von --space-8. */
export const MAP_HEIGHTS: Record<string, number> = { small: 5, medium: 7, large: 9, extraLarge: 12 };
export const mapHeightUnits = (h: string | undefined) => MAP_HEIGHTS[h ?? "medium"] ?? MAP_HEIGHTS.medium!;
