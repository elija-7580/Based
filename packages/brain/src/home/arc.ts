// BSD-162 (Mockup v10): Geometrie des Zeitbogens auf der Startseite. Rein, ohne DOM: der Bogen liegt in einem festen
// Koordinatenraum (1000 Einheiten breit), die Ansicht rechnet Kartengrößen aus Pixeln in Einheiten um und setzt die
// Karten über Prozentwerte. Links vom Scheitel liegt Erledigtes (nach Zeit), am Scheitel „now“ (Needs you), rechts
// Geplantes; der innere Ring trägt die laufenden Läufe. Kollisionen löst `placeSide` auf: vom Scheitel nach außen,
// jede Karte so nah an ihrer Zeit wie möglich, ohne eine schon gesetzte zu überdecken; was nicht passt, wird gezählt.

export type Frame = "today" | "week" | "month";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Halbe Breite des Bogens je Zeitrahmen (links −span … now … +span). */
export const FRAME_SPAN_MS: Record<Frame, number> = { today: 6 * HOUR, week: 3.5 * DAY, month: 15 * DAY };

export interface ArcGeometry {
  /** Breite des Koordinatenraums. */
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** Radius des Zeitbogens. */
  r: number;
  /** Radius des inneren Rings (läuft gerade). */
  innerR: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Rechteck um seinen Mittelpunkt. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Bogen passend zu den Kartengrößen (Einheiten): oben Platz für die Needs-you-Karte am Scheitel, zwischen ihr und dem
 * inneren Ring Luft, unten Platz für die halbe Karte an den Enden und die Zeitmarken.
 */
export function arcGeometry(card: Size, apex: Size, ring: Size, width = 1000): ArcGeometry {
  const gap = 16;
  const r = Math.min(width / 2 - card.w / 2 - gap, 420);
  const top = apex.h / 2 + gap;
  const cy = top + r;
  // innerer Ring: unter der Scheitel-Karte, aber nicht kleiner als nötig für drei Karten nebeneinander
  const innerR = Math.max(ring.w * 0.9, Math.min(r - apex.h / 2 - ring.h / 2 - gap * 2, r * 0.62));
  const height = cy + Math.max(card.h, ring.h) / 2 + gap * 2 + 14;
  return { width, height, cx: width / 2, cy, r, innerR };
}

/** Zeit → Lage auf dem Bogen (0 = linkes Ende, 0.5 = now, 1 = rechtes Ende); außerhalb < 0 bzw. > 1. */
export function timeToT(atMs: number, nowMs: number, frame: Frame): number {
  return 0.5 + (atMs - nowMs) / (2 * FRAME_SPAN_MS[frame]);
}

/** Punkt auf einem Halbkreis (obere Hälfte) mit Radius `radius`; t = 0 links, 0.5 oben, 1 rechts. */
export function arcPoint(g: ArcGeometry, t: number, radius = g.r): Point {
  const theta = Math.PI * (1 - t);
  return { x: g.cx + radius * Math.cos(theta), y: g.cy - radius * Math.sin(theta) };
}

export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2;
}

export interface ArcItem {
  id: string;
  /** Wunschlage (aus der Zeit). */
  t: number;
}

export interface Placed {
  id: string;
  t: number;
  box: Box;
}

export interface SideResult {
  placed: Placed[];
  /** Passt nicht (oder liegt außerhalb des Zeitrahmens). */
  overflow: string[];
}

/**
 * Karten einer Seite setzen. `side` = "done" (links, t < 0.5) oder "planned" (rechts, t > 0.5). Reihenfolge: vom
 * Scheitel nach außen (jüngstes Erledigtes / nächstes Geplantes zuerst). Jede Karte rückt nur nach außen, nie über
 * eine gesetzte hinweg, damit die Zeitfolge erhalten bleibt.
 */
export function placeSide(items: readonly ArcItem[], side: "done" | "planned", g: ArcGeometry, size: Size, blocked: readonly Box[] = [], opts: { gap?: number; step?: number; minT?: number } = {}): SideResult {
  const gap = opts.gap ?? 8;
  const step = opts.step ?? 0.004;
  const dir = side === "done" ? -1 : 1;
  // Grenzen: nicht über das Bogenende hinaus, und von der Mitte etwas Abstand (Scheitel gehört „now“)
  const edge = opts.minT ?? 0;
  const outward = [...items].sort((a, b) => (side === "done" ? b.t - a.t : a.t - b.t));
  const placed: Placed[] = [];
  const overflow: string[] = [];
  let last = 0.5;
  for (const it of outward) {
    const inWindow = side === "done" ? it.t >= 0 && it.t <= 0.5 : it.t >= 0.5 && it.t <= 1;
    if (!inWindow) {
      overflow.push(it.id);
      continue;
    }
    // nie näher am Scheitel als die vorige Karte
    let t = side === "done" ? Math.min(it.t, last) : Math.max(it.t, last);
    let box: Box | undefined;
    for (; side === "done" ? t >= edge : t <= 1 - edge; t += dir * step) {
      const p = arcPoint(g, t);
      const b = { x: p.x, y: p.y, w: size.w, h: size.h };
      if (b.x - b.w / 2 < 0 || b.x + b.w / 2 > g.width) continue;
      if (blocked.some((o) => overlaps(o, b, gap)) || placed.some((o) => overlaps(o.box, b, gap))) continue;
      box = b;
      break;
    }
    if (!box) {
      overflow.push(it.id);
      continue;
    }
    placed.push({ id: it.id, t, box });
    last = t;
  }
  return { placed, overflow };
}

export interface RingResult {
  placed: Placed[];
  overflow: string[];
}

/**
 * Belegung des inneren Rings: Karten symmetrisch um den Scheitel des Rings, so eng wie möglich (stabil in der
 * gegebenen Reihenfolge), höchstens so viele, wie ohne Überdeckung passen; der Rest wird gezählt.
 */
export function ringLayout(ids: readonly string[], g: ArcGeometry, size: Size, blocked: readonly Box[] = [], gap = 8): RingResult {
  for (let n = Math.min(ids.length, 8); n > 0; n--) {
    for (let half = n === 1 ? 0 : 0.04; half <= 0.4001; half += 0.02) {
      const placed = ringSlots(n, g, size, half).map((p, i) => ({ id: ids[i]!, t: p.t, box: p.box }));
      const fits = placed.every((p, i) =>
        p.box.x - p.box.w / 2 >= 0 && p.box.x + p.box.w / 2 <= g.width &&
        !blocked.some((o) => overlaps(o, p.box, gap)) &&
        placed.every((q, j) => j === i || !overlaps(p.box, q.box, gap)));
      if (fits) return { placed, overflow: ids.slice(n) };
    }
  }
  return { placed: [], overflow: [...ids] };
}

/** `n` Plätze auf dem inneren Ring, gleichmäßig zwischen 0.5 − half und 0.5 + half (eine Karte: bei 0.5 − half). */
export function ringSlots(n: number, g: ArcGeometry, size: Size, half = 0): { t: number; box: Box }[] {
  // eine Karte: oben; ist dort kein Platz, etwas nach links
  const ts = n === 1 ? [0.5 - half] : Array.from({ length: n }, (_, i) => 0.5 - half + (2 * half * i) / (n - 1));
  return ts.map((t) => {
    const p = arcPoint(g, t, g.innerR);
    return { t, box: { x: p.x, y: p.y, w: size.w, h: size.h } };
  });
}

export interface Tick {
  t: number;
  label: string;
  /** Lage der Beschriftung (außerhalb des Bogens). */
  at: Point;
  now: boolean;
}

/** Zeitmarken: Enden, Viertel und „now“ („−6 h … now … +6 h“, „−3 d“, „−15 d“). */
export function arcTicks(g: ArcGeometry, frame: Frame, endOffset = 30): Tick[] {
  const span = FRAME_SPAN_MS[frame];
  const unit = frame === "today" ? HOUR : DAY;
  const suffix = frame === "today" ? " h" : " d";
  const fmt = (ms: number) => {
    const v = Math.round((ms / unit) * 10) / 10;
    return (v < 0 ? "−" : "+") + String(Math.abs(v)) + suffix;
  };
  return [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const ms = (t - 0.5) * 2 * span;
    const at = arcPoint(g, t, g.r + 22);
    // Enden: Beschriftung unter dem Bogenende statt daneben
    const end = t === 0 || t === 1 ? { x: arcPoint(g, t).x, y: g.cy + endOffset } : at;
    return { t, label: t === 0.5 ? "now" : fmt(ms), at: end, now: t === 0.5 };
  });
}

/** Zeitmarken, die keine Karte überdecken (Beschriftung als Kästchen geschätzt). */
export function visibleTicks(ticks: readonly Tick[], boxes: readonly Box[], label: Size = { w: 48, h: 16 }): Tick[] {
  return ticks.filter((tk) => !boxes.some((b) => overlaps(b, { x: tk.at.x, y: tk.at.y, w: label.w, h: label.h }, 2)));
}

/** SVG-Pfad eines oberen Halbkreises. */
export function arcPath(g: ArcGeometry, radius = g.r): string {
  const l = arcPoint(g, 0, radius), r = arcPoint(g, 1, radius);
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M ${f(l.x)} ${f(l.y)} A ${f(radius)} ${f(radius)} 0 0 1 ${f(r.x)} ${f(r.y)}`;
}
