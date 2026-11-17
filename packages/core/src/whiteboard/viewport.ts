// BSD-264 (Whiteboard 2): Kamera einer Board-Fläche – reine Rechnung, ohne DOM. Weltkoordinaten sind die der Objekte
// (px bei 100 %), Bildschirmkoordinaten sind CSS-px relativ zur linken oberen Ecke der Fläche.
//   bildschirm = (welt − kamera) × zoom
export interface Camera {
  /** Weltpunkt in der linken oberen Ecke der Fläche. */
  x: number;
  y: number;
  /** 1 = 100 %. */
  zoom: number;
}
export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Stufen für ⌘+ / ⌘− und die Zoom-Pille. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8] as const;
export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
/** Abstand der Rasterpunkte bei 100 % (Design „Based – Whiteboard“). */
export const GRID_STEP = 24;

export const clampZoom = (z: number) => (Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom };
}
export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}
export function worldRectToScreen(cam: Camera, r: Rect): Rect {
  return { x: (r.x - cam.x) * cam.zoom, y: (r.y - cam.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom };
}

/** Verschieben um Bildschirm-px (Ziehen mit der Hand: Inhalt folgt dem Zeiger). */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom, zoom: cam.zoom };
}

/** Auf `zoom` gehen; der Weltpunkt unter `anchor` (Bildschirm) bleibt unter dem Zeiger stehen. */
export function zoomTo(cam: Camera, zoom: number, anchor: Point): Camera {
  const z = clampZoom(zoom);
  const w = screenToWorld(cam, anchor);
  return { x: w.x - anchor.x / z, y: w.y - anchor.y / z, zoom: z };
}

/** Rad/Pinch: `delta` wie `WheelEvent.deltaY` (negativ = hinein). Exponentiell, damit hinein und hinaus sich aufheben. */
export function zoomByWheel(cam: Camera, delta: number, anchor: Point): Camera {
  const d = Math.max(-100, Math.min(100, delta));
  return zoomTo(cam, cam.zoom * Math.exp(-d * 0.01), anchor);
}

/** Nächste Stufe hinein (`dir` 1) oder hinaus (−1); die Mitte der Fläche bleibt stehen. */
export function zoomStep(cam: Camera, dir: 1 | -1, viewport: Size): Camera {
  const eps = 1e-6;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cam.zoom + eps) ?? MAX_ZOOM : [...ZOOM_STEPS].reverse().find((s) => s < cam.zoom - eps) ?? MIN_ZOOM;
  return zoomTo(cam, next, { x: viewport.w / 2, y: viewport.h / 2 });
}

/** Sichtbarer Ausschnitt in Weltkoordinaten. */
export function visibleRect(cam: Camera, viewport: Size): Rect {
  return { x: cam.x, y: cam.y, w: viewport.w / cam.zoom, h: viewport.h / cam.zoom };
}

/**
 * Kamera, die `content` ganz zeigt (⌘0 „Fit“): zentriert, mit Rand, nie über 100 % (ein einzelner Zettel soll nicht
 * die Fläche füllen). Ohne Inhalt: Ursprung in der Mitte bei 100 %.
 */
export function fitCamera(content: Rect | undefined, viewport: Size, padding = 64): Camera {
  if (!content || viewport.w <= 0 || viewport.h <= 0) return { x: -viewport.w / 2, y: -viewport.h / 2, zoom: 1 };
  const availW = Math.max(1, viewport.w - padding * 2), availH = Math.max(1, viewport.h - padding * 2);
  const zoom = clampZoom(Math.min(1, availW / Math.max(1, content.w), availH / Math.max(1, content.h)));
  const cx = content.x + content.w / 2, cy = content.y + content.h / 2;
  return { x: cx - viewport.w / 2 / zoom, y: cy - viewport.h / 2 / zoom, zoom };
}

/** Kamera so verschieben, dass der Weltpunkt in der Mitte der Fläche liegt (Klick in die Minimap). */
export function centerOn(cam: Camera, world: Point, viewport: Size): Camera {
  return { x: world.x - viewport.w / 2 / cam.zoom, y: world.y - viewport.h / 2 / cam.zoom, zoom: cam.zoom };
}

/**
 * Rasterabstand in Weltkoordinaten für einen Zoom: weit draußen wird das Raster gröber (jeder 2., 4., … Punkt),
 * damit die Punkte auf dem Bildschirm nie dichter als ~12 px stehen. Immer ein Vielfaches von GRID_STEP.
 */
export function gridStepFor(zoom: number): number {
  let step = GRID_STEP;
  while (step * zoom < 12) step *= 2;
  return step;
}

/** „100 %“ – Anzeige der Zoom-Pille. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)} %`;
}

export function unionRect(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const rectContains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
/** Rechteck aus zwei Ecken (Aufziehen in jede Richtung). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
