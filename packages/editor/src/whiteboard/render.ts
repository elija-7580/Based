// BSD-264 (Whiteboard 2): die Board-Fläche zeichnen (Canvas 2D). Gezeichnet wird nur, was die Szene als sichtbar
// liefert (Raumindex im Controller). Farben und Schrift kommen zur Laufzeit aus den Design-Tokens (`readBoardTheme`),
// hier steht kein Farbwert. Maße in Welt-px (bei 100 % = CSS-px), Linienstärken in Bildschirm-px.
import {
  connectorPoints, decodeInk, GRID_STEP, gridStepFor, HANDLES, handlePoint, isConnector, worldRectToScreen,
  type BoardRect as Rect, type BoardSize as Size, type InkPoint, type WBConnector, type WBObject, type WBShape,
} from "@based/core";
import { minimapTransform, type BoardScene } from "./controller.js";

/** Farben und Schrift der Fläche, aus den Tokens gelesen. */
export interface BoardTheme {
  bg: string;
  dot: string;
  ink: string;
  muted: string;
  card: string;
  raised: string;
  line: string;
  border: string;
  /** Auswahlrahmen, Griffe, Fokus (neutral, Entscheidung 13.11.). */
  select: string;
  selectFill: string;
  peer: string;
  font: string;
  notes: Record<string, string>;
}

/** Token je Zettelfarbe (kein Gelb: die Marker-Farbe gehört den Agenten). */
const NOTE_TOKENS: Record<string, string> = {
  blue: "--status-ready", pink: "--status-review", orange: "--status-blocked", gray: "--status-neutral", green: "--block-green", purple: "--block-purple",
};

export function readBoardTheme(el: Element): BoardTheme {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v("--bg"), dot: v("--selection-bg"), ink: v("--ink"), muted: v("--muted"), card: v("--surface-card"), raised: v("--surface-raised"), line: v("--line"),
    border: v("--control-border"), select: v("--focus-ring"), selectFill: v("--selected"), peer: v("--synced"),
    font: cs.fontFamily || "system-ui, sans-serif",
    notes: Object.fromEntries(Object.entries(NOTE_TOKENS).map(([k, token]) => [k, v(token)])),
  };
}

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Umbruch je (Text, Breite, Schrift) merken: Messen ist das Teuerste am Zeichnen von Text.
const wrapCache = new Map<string, string[]>();
const WRAP_CACHE_MAX = 2000;

/** Text auf `width` umbrechen (Wörter; ein überlanges Wort wird hart geteilt). Exportiert für Tests. */
export function wrapText(measure: (s: string) => number, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (word === "") continue;
      if (measure(line + word) <= width || line === "") {
        if (measure(word) > width && line === "") {
          let rest = word;
          while (rest.length > 1 && measure(rest) > width) {
            let n = rest.length - 1;
            while (n > 1 && measure(rest.slice(0, n)) > width) n -= 1;
            out.push(rest.slice(0, n));
            rest = rest.slice(n);
          }
          line = rest;
        } else line += word;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? "" : word;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawText(ctx: Ctx, theme: BoardTheme, text: string, box: Rect, opts: { size: number; weight: number; color: string; lineHeight: number; align?: "left" | "center"; middle?: boolean }) {
  if (!text || box.w <= 4 || box.h <= 4) return;
  ctx.font = `${opts.weight} ${opts.size}px ${theme.font}`;
  const key = `${ctx.font}|${Math.round(box.w)}|${text}`;
  let lines = wrapCache.get(key);
  if (!lines) {
    lines = wrapText((s) => ctx.measureText(s).width, text, box.w);
    if (wrapCache.size >= WRAP_CACHE_MAX) wrapCache.clear();
    wrapCache.set(key, lines);
  }
  const lh = opts.size * opts.lineHeight;
  const max = Math.max(1, Math.floor(box.h / lh));
  const shown = lines.length > max ? [...lines.slice(0, max - 1), lines[max - 1]!.replace(/.{0,2}$/, "…")] : lines;
  ctx.fillStyle = opts.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = opts.align ?? "left";
  const x = opts.align === "center" ? box.x + box.w / 2 : box.x;
  let y = (opts.middle ? box.y + (box.h - shown.length * lh) / 2 : box.y) + lh / 2;
  for (const l of shown) {
    ctx.fillText(l, x, y);
    y += lh;
  }
}

const inkCache = new WeakMap<Uint8Array, InkPoint[]>();
function inkPoints(bytes: Uint8Array): InkPoint[] {
  let pts = inkCache.get(bytes);
  if (!pts) {
    try { pts = decodeInk(bytes); } catch { pts = []; }
    inkCache.set(bytes, pts);
  }
  return pts;
}

/** Füllfarbe eines Objekts in der Fernsicht (ohne Rundung, Rand und Text). */
function farFill(theme: BoardTheme, o: WBShape): string {
  if (o.kind === "note") return theme.notes[String(o.style?.color ?? "blue")] || theme.raised;
  if (o.kind === "frame") return theme.raised;
  return o.kind === "ink" || o.kind === "text" ? theme.muted : theme.border;
}

function drawShape(ctx: Ctx, theme: BoardTheme, o: WBShape, zoom: number) {
  // Fernsicht: ein Objekt, das auf dem Bildschirm nur wenige px groß ist, wird ein Rechteck – bei Tausenden
  // sichtbaren Objekten (weit herausgezoomt) kostet sonst jeder Pfad mit Rundung und Rand.
  if (Math.max(o.w, o.h) * zoom < 8 || (zoom < 0.2 && !o.rot && o.kind !== "ink" && o.kind !== "text" && !(o.kind === "shape" && o.style?.shape && o.style.shape !== "rect"))) {
    ctx.fillStyle = farFill(theme, o);
    ctx.fillRect(o.x, o.y, Math.max(o.w, 1 / zoom), Math.max(o.h, 1 / zoom));
    return;
  }
  if (o.rot) {
    ctx.save();
    ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
    ctx.rotate((o.rot * Math.PI) / 180);
    ctx.translate(-(o.x + o.w / 2), -(o.y + o.h / 2));
  }
  const hair = 1 / zoom;
  // Text erst zeichnen, wenn er auf dem Bildschirm lesbar wäre.
  const legible = (size: number) => size * zoom >= 5;
  switch (o.kind) {
    case "note": {
      roundRect(ctx, o.x, o.y, o.w, o.h, 10);
      ctx.fillStyle = theme.notes[String(o.style?.color ?? "blue")] || theme.notes.blue || theme.raised;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      if (o.text && legible(15)) drawText(ctx, theme, o.text, { x: o.x + 14, y: o.y + 14, w: o.w - 28, h: o.h - 28 }, { size: 15, weight: 500, color: theme.ink, lineHeight: 1.4 });
      break;
    }
    case "shape": {
      const kind = o.style?.shape;
      ctx.beginPath();
      if (kind === "oval") ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
      else if (kind === "diamond") {
        ctx.moveTo(o.x + o.w / 2, o.y); ctx.lineTo(o.x + o.w, o.y + o.h / 2); ctx.lineTo(o.x + o.w / 2, o.y + o.h); ctx.lineTo(o.x, o.y + o.h / 2); ctx.closePath();
      } else roundRect(ctx, o.x, o.y, o.w, o.h, 10);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = Math.max(hair, 1.5);
      ctx.strokeStyle = theme.border;
      ctx.stroke();
      if (o.text && legible(14)) drawText(ctx, theme, o.text, { x: o.x + 12, y: o.y + 8, w: o.w - 24, h: o.h - 16 }, { size: 14, weight: 500, color: theme.ink, lineHeight: 1.4, align: "center", middle: true });
      break;
    }
    case "frame": {
      roundRect(ctx, o.x, o.y, o.w, o.h, 18);
      ctx.fillStyle = theme.raised;
      ctx.fill();
      if (o.text && legible(13)) drawText(ctx, theme, o.text, { x: o.x + 14, y: o.y + 12, w: o.w - 28, h: 20 }, { size: 13, weight: 600, color: theme.ink, lineHeight: 1.4 });
      break;
    }
    case "text":
      if (o.text && legible(17)) drawText(ctx, theme, o.text, { x: o.x, y: o.y, w: o.w, h: Math.max(o.h, 26) }, { size: 17, weight: 400, color: theme.ink, lineHeight: 1.5 });
      break;
    case "ink": {
      const pts = o.ink ? inkPoints(o.ink) : [];
      if (pts.length === 0) break;
      ctx.beginPath();
      ctx.moveTo(o.x + pts[0]!.x, o.y + pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(o.x + pts[i]!.x, o.y + pts[i]!.y);
      ctx.lineWidth = Math.max(hair, Number(o.style?.width ?? 2.6));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = theme.ink;
      ctx.stroke();
      break;
    }
    default: {
      // Seitenkarte, Bild: kommen in Whiteboard 4 (BSD-266); bis dahin eine Karte mit Namen, damit nichts unsichtbar ist.
      roundRect(ctx, o.x, o.y, o.w, o.h, 14);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      if (legible(12)) drawText(ctx, theme, o.text || (o.kind === "page" ? "Page" : "Image"), { x: o.x + 14, y: o.y + 12, w: o.w - 28, h: o.h - 24 }, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.35 });
    }
  }
  if (o.rot) ctx.restore();
}

function drawConnector(ctx: Ctx, theme: BoardTheme, c: WBConnector, byID: ReadonlyMap<string, WBObject>, zoom: number) {
  const p = connectorPoints(c, byID);
  if (!p) return;
  const { from, to } = p;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  let angle: number;
  if (c.shape === "straight") {
    ctx.lineTo(to.x, to.y);
    angle = Math.atan2(to.y - from.y, to.x - from.x);
  } else if (c.shape === "elbow") {
    const mx = (from.x + to.x) / 2;
    ctx.lineTo(mx, from.y); ctx.lineTo(mx, to.y); ctx.lineTo(to.x, to.y);
    angle = Math.atan2(0, to.x - mx || 1);
  } else {
    const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
    const c1 = horizontal ? { x: (from.x + to.x) / 2, y: from.y } : { x: from.x, y: (from.y + to.y) / 2 };
    const c2 = horizontal ? { x: (from.x + to.x) / 2, y: to.y } : { x: to.x, y: (from.y + to.y) / 2 };
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
    angle = Math.atan2(to.y - c2.y, to.x - c2.x || 1e-6);
  }
  ctx.lineWidth = Math.max(1 / zoom, 1.8);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = theme.border;
  ctx.stroke();
  const a = 8;
  ctx.beginPath();
  ctx.moveTo(to.x - a * Math.cos(angle - 0.45), to.y - a * Math.sin(angle - 0.45));
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(to.x - a * Math.cos(angle + 0.45), to.y - a * Math.sin(angle + 0.45));
  ctx.stroke();
  if (c.label && 12 * zoom >= 5) {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    ctx.font = `500 12px ${theme.font}`;
    const w = ctx.measureText(c.label).width + 18;
    roundRect(ctx, mid.x - w / 2, mid.y - 12, w, 24, 12);
    ctx.fillStyle = theme.raised;
    ctx.fill();
    ctx.fillStyle = theme.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.label, mid.x, mid.y);
  }
}

function drawGrid(ctx: Ctx, theme: BoardTheme, scene: BoardScene, size: Size) {
  const { camera } = scene;
  const step = gridStepFor(camera.zoom);
  const stepPx = step * camera.zoom;
  // Erster Punkt links oben; Versatz wie im Entwurf (halber Schritt), damit bei 100 % kein Punkt in der Ecke klebt.
  const off = GRID_STEP / 2;
  const x0 = (Math.ceil((camera.x - off) / step) * step + off - camera.x) * camera.zoom;
  const y0 = (Math.ceil((camera.y - off) / step) * step + off - camera.y) * camera.zoom;
  const r = Math.max(0.8, Math.min(1.4, 1.1 * Math.sqrt(camera.zoom)));
  ctx.fillStyle = theme.dot;
  ctx.beginPath();
  for (let y = y0; y < size.h + r; y += stepPx) {
    for (let x = x0; x < size.w + r; x += stepPx) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

/** Die ganze Fläche zeichnen. `size` in CSS-px, `dpr` = Gerätepixel je CSS-px. */
export function drawBoard(ctx: Ctx, scene: BoardScene, theme: BoardTheme, size: Size, dpr: number, peers: readonly { x: number; y: number; name?: string }[] = []) {
  const { camera } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, size.w, size.h);
  drawGrid(ctx, theme, scene, size);

  // Welt
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
  for (const o of scene.objects) {
    if (isConnector(o)) drawConnector(ctx, theme, o, scene.byID, camera.zoom);
    else drawShape(ctx, theme, o, camera.zoom);
  }

  // Bildschirm: Auswahl, Griffe, Aufziehen, fremde Zeiger – immer gleich groß, egal wie weit gezoomt ist.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (scene.marquee) {
    const m = worldRectToScreen(camera, scene.marquee);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = theme.selectFill;
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.select;
    ctx.strokeRect(Math.round(m.x) + 0.5, Math.round(m.y) + 0.5, Math.round(m.w), Math.round(m.h));
  }
  if (scene.selectionBounds) {
    const b = worldRectToScreen(camera, scene.selectionBounds);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.select;
    roundRect(ctx, b.x - 2, b.y - 2, b.w + 4, b.h + 4, 6);
    ctx.stroke();
    if (scene.focused !== undefined) {
      // Tastatur-Fokus: zweiter Ring mit Abstand (wie der Fokusrahmen der App).
      ctx.lineWidth = 2;
      roundRect(ctx, b.x - 6, b.y - 6, b.w + 12, b.h + 12, 9);
      ctx.stroke();
    }
    if (scene.handles) {
      const outer = { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 };
      // Kleine Auswahl: nur die Ecken, sonst liegen die Griffe übereinander.
      const small = Math.min(outer.w, outer.h) < 36;
      for (const h of HANDLES) {
        if (small && h.length === 1) continue;
        const p = handlePoint(outer, h);
        roundRect(ctx, p.x - 4.5, p.y - 4.5, 9, 9, 2);
        ctx.fillStyle = theme.bg;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.select;
        ctx.stroke();
      }
    }
  }
  for (const peer of peers) {
    const x = (peer.x - camera.x) * camera.zoom, y = (peer.y - camera.y) * camera.zoom;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + 12, y + 7); ctx.lineTo(x + 6.5, y + 8.5); ctx.lineTo(x + 5, y + 14); ctx.closePath();
    ctx.fillStyle = theme.peer;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.bg;
    ctx.stroke();
    if (peer.name) {
      ctx.font = `600 12px ${theme.font}`;
      const w = ctx.measureText(peer.name).width + 16;
      roundRect(ctx, x + 12, y + 14, w, 20, 10);
      ctx.fillStyle = theme.peer;
      ctx.fill();
      ctx.fillStyle = theme.bg;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(peer.name, x + 20, y + 24);
    }
  }
}

/** Minimap: alle Objekte als Flächen, der sichtbare Ausschnitt als Rahmen. */
export function drawMinimap(ctx: Ctx, objects: readonly WBObject[], extent: Rect | undefined, visible: Rect, theme: BoardTheme, size: Size, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  const t = minimapTransform(extent, visible, size);
  // Ein Pfad für alle Objekte (ein Füllen): bei Tausenden Objekten zählt jeder einzelne Aufruf.
  ctx.fillStyle = theme.muted;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  for (const o of objects) {
    if (isConnector(o)) continue;
    ctx.rect(o.x * t.scale + t.x, o.y * t.scale + t.y, Math.max(2, o.w * t.scale), Math.max(2, o.h * t.scale));
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.ink;
  roundRect(ctx, visible.x * t.scale + t.x, visible.y * t.scale + t.y, Math.max(4, visible.w * t.scale), Math.max(4, visible.h * t.scale), 4);
  ctx.stroke();
}
