// Freies Zeichnen für Agenten: ein SVG-Pfad (oder eine schlichte Punktliste) wird zu Strichen aus Punkten, wie sie
// der Stift erzeugt. SVG-Pfade kennen Sprachmodelle gut; sie sind kurz (eine Kurve statt hundert Punkte) und genau.
// Unterstützt: M L H V C S Q T A Z, groß (absolut) und klein (relativ). Jeder Teilpfad (neues M) wird ein Strich.

export interface PathPoint { x: number; y: number }

/** Höchstens so viele Punkte je Aufruf (Schutz vor riesigen Pfaden). */
export const PATH_POINTS_MAX = 20_000;

export class PathError extends Error {}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * Pfad in Striche zerlegen. `step`: Abstand der Punkte auf Kurven (Welt-px). Eine reine Punktliste („0,0 10,5 20,0“
 * oder „0 0 10 5“) gilt als ein Strich; Striche lassen sich dort mit „;“ trennen.
 */
export function pathToStrokes(d: string, step = 4): PathPoint[][] {
  const src = d.trim();
  if (src === "") throw new PathError("empty path");
  if (!/[a-zA-Z]/.test(src)) return pointList(src);
  const tokens = src.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const strokes: PathPoint[][] = [];
  let cur: PathPoint[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: PathPoint | undefined, lastQ: PathPoint | undefined;
  let total = 0;
  let i = 0;
  let cmd = "";
  const num = (): number => {
    const t = tokens[i];
    if (t === undefined || /[a-zA-Z]/.test(t)) throw new PathError(`command ${cmd} needs more numbers`);
    i += 1;
    return Number(t);
  };
  const flag = (): number => {
    // Bögen: Flags dürfen ohne Trenner stehen („a10 10 0 015 5“) – hier reicht die übliche Schreibweise.
    const n = num();
    if (n !== 0 && n !== 1) throw new PathError("arc flags must be 0 or 1");
    return n;
  };
  const push = (p: PathPoint) => {
    if (++total > PATH_POINTS_MAX) throw new PathError(`more than ${PATH_POINTS_MAX} points`);
    const last = cur[cur.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) cur.push(p);
  };
  const end = () => { if (cur.length > 0) strokes.push(cur); cur = []; };
  const curve = (pts: PathPoint[], at: (t: number) => PathPoint) => {
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y);
    const n = Math.max(2, Math.min(200, Math.ceil(len / step)));
    for (let k = 1; k <= n; k++) push(at(k / n));
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) { cmd = t; i += 1; }
    else if (cmd === "") throw new PathError("a path starts with M");
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case "M": {
        end();
        x = ox + num(); y = oy + num();
        sx = x; sy = y;
        push({ x, y });
        // Weitere Paare nach M sind Linien.
        cmd = rel ? "l" : "L";
        lastC = lastQ = undefined;
        continue;
      }
      case "L": { x = ox + num(); y = oy + num(); push({ x, y }); lastC = lastQ = undefined; break; }
      case "H": { x = ox + num(); push({ x, y }); lastC = lastQ = undefined; break; }
      case "V": { y = (rel ? y : 0) + num(); push({ x, y }); lastC = lastQ = undefined; break; }
      case "C": case "S": {
        const p0 = { x, y };
        const p1 = C === "C" ? { x: ox + num(), y: oy + num() } : lastC ? { x: 2 * x - lastC.x, y: 2 * y - lastC.y } : { x, y };
        const p2 = { x: ox + num(), y: oy + num() };
        const p3 = { x: ox + num(), y: oy + num() };
        if (cur.length === 0) push(p0);
        curve([p0, p1, p2, p3], (u) => {
          const a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, e = u ** 3;
          return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
        });
        x = p3.x; y = p3.y; lastC = p2; lastQ = undefined;
        break;
      }
      case "Q": case "T": {
        const p0 = { x, y };
        const p1 = C === "Q" ? { x: ox + num(), y: oy + num() } : lastQ ? { x: 2 * x - lastQ.x, y: 2 * y - lastQ.y } : { x, y };
        const p2 = { x: ox + num(), y: oy + num() };
        if (cur.length === 0) push(p0);
        curve([p0, p1, p2], (u) => ({ x: (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x, y: (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y }));
        x = p2.x; y = p2.y; lastQ = p1; lastC = undefined;
        break;
      }
      case "A": {
        const rx = Math.abs(num()), ry = Math.abs(num()), rot = num(), large = flag(), sweep = flag();
        const x2 = ox + num(), y2 = oy + num();
        if (cur.length === 0) push({ x, y });
        arc(x, y, rx, ry, rot, large === 1, sweep === 1, x2, y2, step).forEach(push);
        x = x2; y = y2; lastC = lastQ = undefined;
        break;
      }
      case "Z": {
        push({ x: sx, y: sy });
        x = sx; y = sy;
        lastC = lastQ = undefined;
        // Z hat keine Zahlen; ohne neues Kommando wäre eine folgende Zahl ein Fehler.
        if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!)) throw new PathError("numbers after Z");
        continue;
      }
      default: throw new PathError(`unknown path command ${cmd}`);
    }
  }
  end();
  if (strokes.length === 0) throw new PathError("no points");
  return strokes;
}

function pointList(src: string): PathPoint[][] {
  const out: PathPoint[][] = [];
  for (const part of src.split(";")) {
    const n = (part.match(NUM) ?? []).map(Number);
    if (n.length === 0) continue;
    if (n.length % 2 !== 0) throw new PathError("points come in x,y pairs");
    const s: PathPoint[] = [];
    for (let k = 0; k < n.length; k += 2) s.push({ x: n[k]!, y: n[k + 1]! });
    out.push(s);
  }
  if (out.length === 0) throw new PathError("no points");
  if (out.reduce((a, s) => a + s.length, 0) > PATH_POINTS_MAX) throw new PathError(`more than ${PATH_POINTS_MAX} points`);
  return out;
}

/** Elliptischer Bogen (SVG-Endpunkt-Schreibweise) als Punkte, ohne den Startpunkt. */
function arc(x1: number, y1: number, rx: number, ry: number, deg: number, large: boolean, sweep: boolean, x2: number, y2: number, step: number): PathPoint[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ x: x2, y: y2 }];
  const phi = (deg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.min(200, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / step)));
  const out: PathPoint[] = [];
  for (let j = 1; j <= n; j++) {
    const t = t1 + (dt * j) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy });
  }
  out[out.length - 1] = { x: x2, y: y2 };
  return out;
}
