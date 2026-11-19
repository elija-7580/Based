// BSD-264 (Whiteboard 2): die Board-Fläche zeichnen (Canvas 2D). Gezeichnet wird nur, was die Szene als sichtbar
// liefert (Raumindex im Controller). Farben und Schrift kommen zur Laufzeit aus den Design-Tokens (`readBoardTheme`),
// hier steht kein Farbwert. Maße in Welt-px (bei 100 % = CSS-px), Linienstärken in Bildschirm-px.
import { getStroke } from "perfect-freehand";
import {
  connectorPoints, GRID_STEP, hasMarkdown, gridStepFor, HANDLES, handlePoint, inkPointsOf, isConnector, worldRectToScreen,
  type BoardRect as Rect, type BoardSize as Size, type InkPoint, type TextPreview, type WBConnector, type WBObject, type WBShape,
} from "@based/core";
import { minimapTransform, type BoardScene, type LiveInk } from "./controller.js";
import { BOARD_MONO_FALLBACK, drawMarkdown, setBoardFonts, textFieldOf } from "./markdown.js";

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
  /** Schrift für `Code` in Markdown (Token --font-mono). */
  mono?: string;
  notes: Record<string, string>;
  /** Stiftfarben und Textmarker-Tönungen nach Namen (PEN_COLORS, HIGHLIGHT_COLORS). */
  pens: Record<string, string>;
  highlights: Record<string, string>;
  fills: Record<string, string>;
  /** Dunkles Thema: der Textmarker hellt auf statt abzudunkeln. */
  dark: boolean;
  /** Marker-Farbe: kennzeichnet, was ein Agent angelegt hat (und nur das). */
  marker: string;
  /** Schrift auf Zetteln: dunkel in beiden Themen (der Zettel ist Papier). */
  noteInk: string;
}

/** Token je Stiftfarbe bzw. Textmarker-Tönung (kein Gelb: die Marker-Farbe gehört den Agenten). */
// Farben des freigegebenen Entwurfs „Based – Whiteboard“ (eigene Tokens board-*, hell und dunkel).
// Elija 17.11.: die Farben von Based – Textfarben des Editors (Striche, Text), Marker-Familie (Textmarker),
// Hintergründe des Editors (Zettel, Flächen). Frühere Namen (lilac, board-note) bleiben lesbar.
const PEN_TOKENS: Record<string, string> = {
  ink: "--ink", gray: "--muted", brown: "--block-brown-text", orange: "--block-orange-text", green: "--block-green-text", blue: "--block-blue-text",
  purple: "--block-purple-text", pink: "--block-pink-text", red: "--block-red-text",
};
const HIGHLIGHT_TOKENS: Record<string, string> = { mint: "--marker-mint", sky: "--marker-sky", rose: "--marker-rose", calm: "--marker-calm", lilac: "--block-purple" };
const FILL_TOKENS: Record<string, string> = {
  gray: "--status-neutral", brown: "--block-brown", orange: "--block-orange", green: "--block-green", blue: "--block-blue", purple: "--block-purple",
  pink: "--block-pink", red: "--block-red",
};
export const fillToken = (name: string) => FILL_TOKENS[name] ?? FILL_TOKENS.gray!;
export const penToken = (name: string) => PEN_TOKENS[name] ?? PEN_TOKENS.ink!;
export const highlightToken = (name: string) => HIGHLIGHT_TOKENS[name] ?? HIGHLIGHT_TOKENS.sky!;

/** Ist die Farbe (Hex-Wert oder Dezimal-Tripel) dunkel? */
function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = hex ? [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) : (/(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)?.slice(1, 4).map(Number) ?? [255, 255, 255]);
  return (rgb[0]! * 299 + rgb[1]! * 587 + rgb[2]! * 114) / 1000 < 128;
}
const tokensOf = (v: (name: string) => string, map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, token]) => [k, v(token)]));


/** Token je Zettelfarbe (kein Gelb: die Marker-Farbe gehört den Agenten). */
const NOTE_TOKENS: Record<string, string> = {
  ...FILL_TOKENS,
};

export function readBoardTheme(el: Element): BoardTheme {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  setBoardFonts(cs.fontFamily || "system-ui, sans-serif", v("--font-mono") || BOARD_MONO_FALLBACK);
  return {
    bg: v("--bg"), dot: v("--selection-bg"), ink: v("--ink"), muted: v("--muted"), card: v("--surface-card"), raised: v("--surface-raised"), line: v("--line"),
    border: v("--control-border"), select: v("--focus-ring"), selectFill: v("--selected"), peer: v("--synced"),
    font: cs.fontFamily || "system-ui, sans-serif", mono: v("--font-mono") || BOARD_MONO_FALLBACK,
    notes: tokensOf(v, NOTE_TOKENS), pens: tokensOf(v, PEN_TOKENS), highlights: tokensOf(v, HIGHLIGHT_TOKENS), fills: tokensOf(v, FILL_TOKENS), dark: isDark(v("--bg")), marker: v("--marker-strong"), noteInk: v("--board-note-ink"),
  };
}

type Ctx = CanvasRenderingContext2D;

/**
 * Was die Fläche aus Dateien braucht, nach Adresse; `undefined`: (noch) nicht da – dann zeigt sie einen Platzhalter
 * und die Ansicht meldet sich, sobald es geladen ist. Gefragt wird nur für Objekte, die zu sehen sind.
 */
export interface BoardResources {
  image(ref: string): CanvasImageSource | undefined;
  text?(ref: string, name: string): TextPreview | undefined;
  /** Heutiger Titel einer Seite (Seitenkarten zeigen ihn live); ohne: der Titel vom Anlegen. */
  title?(pageID: string): string | undefined;
  /** PDF-Seite, mindestens `pxWidth` Gerätepixel breit. */
  pdf?(ref: string, page: number, pxWidth: number): CanvasImageSource | undefined;
}
export type BoardImages = BoardResources | ((ref: string) => CanvasImageSource | undefined);
const resourcesOf = (r: BoardImages | undefined): BoardResources | undefined => (typeof r === "function" ? { image: r } : r);
/** Höhe der Kopfzeile einer Vorschau-Karte (Welt-px) – die Ansicht legt eingebettete Inhalte darunter. */
export const PREVIEW_HEADER = 40;

/** Dateigröße für Menschen. */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
/** Kurze Art einer Datei für die Kachel der Karte („PDF“, „HTML“). */
export function fileKindLabel(name: string, mime: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1];
  return (ext ?? mime.split("/")[1] ?? "file").slice(0, 4).toUpperCase();
}

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

/**
 * Text von Zettel, Form und Text-Objekt: als Markdown gesetzt (Elija 18.11.), schlichter Text bleibt auf dem
 * schnellen Weg. Feld und Schrift kommen aus `textFieldOf` – dieselbe Stelle rechnet Treffer auf Aufgaben.
 */
function drawBodyText(ctx: Ctx, theme: BoardTheme, o: WBShape, color: string) {
  const f = textFieldOf(o);
  if (!f || !o.text) return;
  if (!hasMarkdown(o.text)) { drawText(ctx, theme, o.text, f.box, { size: f.size, weight: f.weight, color, lineHeight: f.lineHeight, ...(f.align ? { align: f.align } : {}), ...(f.middle ? { middle: true } : {}) }); return; }
  drawMarkdown(ctx, o.text, f.box, { size: f.size, weight: f.weight, lineHeight: f.lineHeight, font: theme.font, mono: theme.mono ?? BOARD_MONO_FALLBACK, ...(f.align ? { align: f.align } : {}), ...(f.middle ? { middle: true } : {}) },
    { ink: color, muted: theme.muted, link: theme.pens.blue || theme.ink, mark: theme.highlights.sky || theme.selectFill, line: theme.border, on: theme.bg, dark: theme.dark });
}

// MARK: Tinte

/** Umriss eines Stiftstrichs (Vieleck um die Punkte, Breite folgt dem Druck). Exportiert für Tests. */
export function inkOutline(points: readonly InkPoint[], width: number, sim: boolean, done = true): number[] {
  const outline = getStroke(points.map((p) => [p.x, p.y, p.p]), {
    // Bei mittlerem Druck (0.5) ergibt das genau `width`.
    size: width * 1.2, thinning: 0.55, smoothing: 0.5, streamline: 0.32, simulatePressure: sim, last: done,
  });
  const flat: number[] = new Array(outline.length * 2);
  for (let i = 0; i < outline.length; i++) { flat[i * 2] = outline[i]![0]!; flat[i * 2 + 1] = outline[i]![1]!; }
  return flat;
}

// Umriss je Strich einmal rechnen: die Bytes eines Strichs ändern sich nie (ein geänderter Strich hat neue Bytes).
const outlineCache = new WeakMap<Uint8Array, Map<string, number[]>>();
function cachedOutline(bytes: Uint8Array, width: number, sim: boolean): number[] {
  let per = outlineCache.get(bytes);
  if (!per) outlineCache.set(bytes, (per = new Map()));
  const key = `${width}|${sim ? 1 : 0}`;
  let o = per.get(key);
  if (!o) per.set(key, (o = inkOutline(inkPointsOf(bytes), width, sim)));
  return o;
}

function fillOutline(ctx: Ctx, o: readonly number[]) {
  const n = o.length / 2;
  if (n < 3) return;
  // Glatte Kante: quadratische Bögen durch die Mittelpunkte.
  ctx.beginPath();
  ctx.moveTo((o[0]! + o[2]!) / 2, (o[1]! + o[3]!) / 2);
  for (let i = 1; i < n; i++) {
    const j = (i + 1) % n;
    ctx.quadraticCurveTo(o[i * 2]!, o[i * 2 + 1]!, (o[i * 2]! + o[j * 2]!) / 2, (o[i * 2 + 1]! + o[j * 2 + 1]!) / 2);
  }
  ctx.closePath();
  ctx.fill();
}

function strokeLine(ctx: Ctx, pts: readonly InkPoint[], width: number) {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  if (pts.length === 1) ctx.lineTo(pts[0]!.x + 0.01, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

/**
 * Einen Strich im eigenen Koordinatensystem zeichnen. Stift: gefüllter Umriss (Druck); Textmarker: breite Linie, die
 * durchscheint (hell: abdunkeln, dunkel: aufhellen). Weit herausgezoomt reicht eine einfache Linie.
 */
function paintInk(ctx: Ctx, theme: BoardTheme, pts: readonly InkPoint[], style: { tool: "pen" | "highlighter"; color: string; width: number; sim: boolean }, zoom: number, outline: () => number[]) {
  if (pts.length === 0) return;
  if (style.tool === "highlighter") {
    const before = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = theme.dark ? "screen" : "multiply";
    ctx.strokeStyle = theme.highlights[style.color] || theme.highlights.sky || theme.muted;
    strokeLine(ctx, pts, style.width);
    ctx.globalCompositeOperation = before;
    return;
  }
  const color = theme.pens[style.color] || theme.ink;
  if (style.width * zoom < 1.3) {
    ctx.strokeStyle = color;
    strokeLine(ctx, pts, Math.max(1 / zoom, style.width));
    return;
  }
  ctx.fillStyle = color;
  fillOutline(ctx, outline());
}

/** Den Strich zeichnen, der gerade entsteht (über der fertigen Fläche). */
export function drawLiveInk(ctx: Ctx, live: LiveInk, theme: BoardTheme, camera: { x: number; y: number; zoom: number }, dpr: number) {
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
  paintInk(ctx, theme, live.points, live, camera.zoom, () => inkOutline(live.points, live.width, live.sim, false));
}

/** Füllfarbe eines Objekts in der Fernsicht (ohne Rundung, Rand und Text). */
function farFill(theme: BoardTheme, o: WBShape): string {
  if (o.kind === "note") return theme.notes[String(o.style?.color ?? "blue")] || theme.raised;
  if (o.kind === "frame") return theme.raised;
  if (o.kind === "file" && o.style?.view === "pdf") return "white";
  return o.kind === "ink" || o.kind === "text" ? theme.muted : theme.border;
}

/** Kopfzeile einer Vorschau-Karte: Kachel mit der Art, Name, Angaben. */
function drawPreviewFrame(ctx: Ctx, theme: BoardTheme, o: WBShape, zoom: number, legible: (size: number) => boolean) {
  roundRect(ctx, o.x, o.y, o.w, o.h, 14);
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = theme.line;
  ctx.stroke();
  const name = String(o.style?.name ?? "File"), mime = String(o.style?.mime ?? "");
  roundRect(ctx, o.x + 10, o.y + 9, 40, 22, 7);
  ctx.fillStyle = theme.raised;
  ctx.fill();
  if (legible(10.5)) drawText(ctx, theme, fileKindLabel(name, mime), { x: o.x + 10, y: o.y + 9, w: 40, h: 22 }, { size: 10.5, weight: 600, color: theme.muted, lineHeight: 1.3, align: "center", middle: true });
  const size = fileSizeLabel(Number(o.style?.size ?? 0));
  if (legible(13)) drawText(ctx, theme, name, { x: o.x + 60, y: o.y + 10, w: o.w - 72 - (size ? 64 : 0), h: 20 }, { size: 13, weight: 600, color: theme.ink, lineHeight: 1.5 });
  if (size && legible(12)) {
    ctx.font = `500 12px ${theme.font}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(size, o.x + o.w - 12, o.y + 20);
  }
}

/** Textvorschau: Zeilen in fester Breite; ein Chat-/Agent-Log als Gespräch (wer in gedämpfter Zeile, darunter was). */
function drawTextPreview(ctx: Ctx, theme: BoardTheme, o: WBShape, preview: TextPreview | undefined, legible: (size: number) => boolean, scroll = 0) {
  const body = { x: o.x + 14, y: o.y + PREVIEW_HEADER + 4, w: o.w - 28, h: o.h - PREVIEW_HEADER - 14 };
  if (body.h < 16 || !legible(12)) return;
  if (!preview) { drawText(ctx, theme, "Loading…", body, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.5 }); return; }
  if (preview.lines.length === 0) { drawText(ctx, theme, "Empty file", body, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.5 }); return; }
  ctx.save();
  ctx.beginPath();
  ctx.rect(body.x, body.y, body.w, body.h);
  ctx.clip();
  const font = theme.font;
  const mono = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  // Höhe des Ganzen, damit das Rollen am Ende anhält.
  ctx.font = `400 13px ${font}`;
  let total = preview.more ? 26 : 0;
  for (const line of preview.lines) total += preview.chat ? 24 + Math.min(6, Math.max(1, wrapText((s) => ctx.measureText(s).width, line.text, body.w).length)) * 19 : 18;
  let y = body.y - Math.max(0, Math.min(scroll, total - body.h));
  for (const line of preview.lines) {
    if (y >= body.y + body.h) break;
    if (y < body.y - 160) { y += preview.chat ? 24 + Math.min(6, Math.max(1, wrapText((s) => ctx.measureText(s).width, line.text, body.w).length)) * 19 : 18; ctx.font = `400 13px ${font}`; continue; }
    if (preview.chat) {
      drawText(ctx, theme, line.role ?? "", { x: body.x, y, w: body.w, h: 16 }, { size: 11, weight: 600, color: theme.muted, lineHeight: 1.45 });
      y += 16;
      ctx.font = `400 13px ${font}`;
      const rows = Math.min(6, Math.max(1, wrapText((s) => ctx.measureText(s).width, line.text, body.w).length));
      drawText(ctx, theme, line.text, { x: body.x, y, w: body.w, h: rows * 19 }, { size: 13, weight: 400, color: theme.ink, lineHeight: 19 / 13 });
      y += rows * 19 + 8;
    } else {
      // Ohne Umbruch (wie in einem Editor): eine Zeile der Datei ist eine Zeile der Vorschau.
      ctx.font = `400 12px ${mono}`;
      ctx.fillStyle = theme.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      if (line.text) ctx.fillText(line.text.length > 160 ? line.text.slice(0, 160) : line.text, body.x, y + 9);
      y += 18;
    }
    ctx.font = `400 13px ${font}`;
  }
  if (preview.more && y < body.y + body.h) drawText(ctx, theme, "… the preview ends here. Double-click to save the whole file.", { x: body.x, y: y + 4, w: body.w, h: 18 }, { size: 11, weight: 500, color: theme.muted, lineHeight: 1.5 });
  ctx.restore();
}

function drawShape(ctx: Ctx, theme: BoardTheme, o: WBShape, zoom: number, editing = false, images?: BoardImages, dpr = 1, scroll = 0) {
  const res = resourcesOf(images);
  // Fernsicht: ein Objekt, das auf dem Bildschirm nur wenige px groß ist, wird ein Rechteck – bei Tausenden
  // sichtbaren Objekten (weit herausgezoomt) kostet sonst jeder Pfad mit Rundung und Rand.
  // Bilder und PDF-Seiten bleiben auch weit draußen sichtbar (Elija 17.11.: „Inhalt soll angezeigt bleiben“).
  const media = o.kind === "image" || (o.kind === "file" && o.style?.view === "pdf");
  if (Math.max(o.w, o.h) * zoom < (media ? 3 : 8) || (!media && zoom < 0.2 && !o.rot && o.kind !== "ink" && o.kind !== "text" && !(o.kind === "shape" && o.style?.shape && o.style.shape !== "rect"))) {
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
  // Text erst zeichnen, wenn er auf dem Bildschirm lesbar wäre – und nicht, solange er im Eingabefeld steht.
  const legible = (size: number) => !editing && size * zoom >= 5;
  switch (o.kind) {
    case "note": {
      roundRect(ctx, o.x, o.y, o.w, o.h, 10);
      ctx.fillStyle = theme.notes[String(o.style?.color ?? "blue")] || theme.notes.blue || theme.raised;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      if (o.text && legible(15)) drawBodyText(ctx, theme, o, theme.ink);
      break;
    }
    case "shape": {
      const kind = o.style?.shape;
      ctx.beginPath();
      if (kind === "oval") ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
      else if (kind === "diamond") {
        ctx.moveTo(o.x + o.w / 2, o.y); ctx.lineTo(o.x + o.w, o.y + o.h / 2); ctx.lineTo(o.x + o.w / 2, o.y + o.h); ctx.lineTo(o.x, o.y + o.h / 2); ctx.closePath();
      } else roundRect(ctx, o.x, o.y, o.w, o.h, 10);
      ctx.fillStyle = (o.style?.fill && theme.fills[String(o.style.fill)]) || theme.card;
      ctx.fill();
      ctx.lineWidth = Math.max(hair, 1.5);
      ctx.strokeStyle = (o.style?.color && theme.pens[String(o.style.color)]) || theme.border;
      ctx.stroke();
      if (o.text && legible(14)) drawBodyText(ctx, theme, o, (o.style?.color && theme.pens[String(o.style.color)]) || theme.ink);
      break;
    }
    case "frame": {
      roundRect(ctx, o.x, o.y, o.w, o.h, 18);
      ctx.fillStyle = (o.style?.color && theme.fills[String(o.style.color)]) || theme.raised;
      ctx.fill();
      if (o.text && legible(13)) drawText(ctx, theme, o.text, { x: o.x + 14, y: o.y + 11, w: o.w - 28, h: 20 }, { size: 13, weight: 600, color: theme.ink, lineHeight: 1.4 });
      break;
    }
    case "text":
      if (o.text && legible(17)) drawBodyText(ctx, theme, o, (o.style?.color && theme.pens[String(o.style.color)]) || theme.ink);
      break;
    case "ink": {
      const bytes = o.ink;
      const pts = bytes ? inkPointsOf(bytes) : [];
      if (!bytes || pts.length === 0) break;
      const width = Number(o.style?.width ?? 2.6), sim = o.style?.sim === true;
      // Punkte liegen relativ zur Grundgröße (bw × bh); ein skalierter Strich wird gestreckt gezeichnet.
      const sx = o.w / (Number(o.style?.bw) || o.w || 1), sy = o.h / (Number(o.style?.bh) || o.h || 1);
      ctx.save();
      ctx.translate(o.x, o.y);
      if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
      paintInk(ctx, theme, pts, { tool: o.style?.tool === "hl" ? "highlighter" : "pen", color: String(o.style?.color ?? "ink"), width, sim }, zoom * Math.min(sx, sy), () => cachedOutline(bytes, width, sim));
      ctx.restore();
      break;
    }
    case "image": {
      const img = o.ref ? res?.image(o.ref) : undefined;
      if (img) {
        ctx.drawImage(img, o.x, o.y, o.w, o.h);
        break;
      }
      // Noch nicht geladen (oder auf diesem Gerät nicht vorhanden): ruhige Fläche mit dem Namen.
      roundRect(ctx, o.x, o.y, o.w, o.h, 12);
      ctx.fillStyle = theme.raised;
      ctx.fill();
      if (legible(12)) drawText(ctx, theme, String(o.style?.name ?? "Image"), { x: o.x + 12, y: o.y + 8, w: o.w - 24, h: o.h - 16 }, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.35, align: "center", middle: true });
      break;
    }
    case "file": {
      const view = o.style?.view;
      if (view === "pdf") {
        // Eine Seite des Ausdrucks: weißes Blatt (auch im dunklen Thema – es ist ein Dokument), darauf die Seite.
        ctx.fillStyle = "white";
        ctx.fillRect(o.x, o.y, o.w, o.h);
        const page = Number(o.style?.page ?? 1);
        const img = o.ref ? res?.pdf?.(o.ref, page, o.w * zoom * dpr) : undefined;
        if (img) ctx.drawImage(img, o.x, o.y, o.w, o.h);
        else if (legible(12)) drawText(ctx, theme, `${String(o.style?.name ?? "PDF")} · page ${page}`, { x: o.x + 16, y: o.y + 12, w: o.w - 32, h: 20 }, { size: 12, weight: 500, color: "gray", lineHeight: 1.4 });
        ctx.lineWidth = hair;
        ctx.strokeStyle = theme.line;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        break;
      }
      if (view === "text" || view === "html" || view === "video" || view === "audio") {
        drawPreviewFrame(ctx, theme, o, zoom, legible);
        if (view === "text") drawTextPreview(ctx, theme, o, o.ref ? res?.text?.(o.ref, String(o.style?.name ?? "")) : undefined, legible, scroll);
        break;
      }
      roundRect(ctx, o.x, o.y, o.w, o.h, 14);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      const name = String(o.style?.name ?? "File"), mime = String(o.style?.mime ?? "");
      const tile = Math.min(48, o.h - 24);
      roundRect(ctx, o.x + 12, o.y + (o.h - tile) / 2, tile, tile, 10);
      ctx.fillStyle = theme.raised;
      ctx.fill();
      if (legible(11)) drawText(ctx, theme, fileKindLabel(name, mime), { x: o.x + 12, y: o.y + (o.h - tile) / 2, w: tile, h: tile }, { size: 11, weight: 600, color: theme.muted, lineHeight: 1.3, align: "center", middle: true });
      const left = o.x + 12 + tile + 12, width = o.w - tile - 36;
      if (legible(13.5)) drawText(ctx, theme, name, { x: left, y: o.y + o.h / 2 - 20, w: width, h: 20 }, { size: 13.5, weight: 600, color: theme.ink, lineHeight: 1.4 });
      if (legible(12)) drawText(ctx, theme, [mime || "File", fileSizeLabel(Number(o.style?.size ?? 0))].filter(Boolean).join(" · "), { x: left, y: o.y + o.h / 2 + 1, w: width, h: 18 }, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.4 });
      break;
    }
    case "page": {
      if (o.style?.full === true) {
        // Ganze Seite: Kopf wie bei Vorschauen, darunter legt die Ansicht den Editor der Seite (BoardEmbed).
        roundRect(ctx, o.x, o.y, o.w, o.h, 14);
        ctx.fillStyle = theme.bg;
        ctx.fill();
        ctx.lineWidth = hair;
        ctx.strokeStyle = theme.line;
        ctx.stroke();
        roundRect(ctx, o.x + 10, o.y + 9, 40, 22, 7);
        ctx.fillStyle = theme.raised;
        ctx.fill();
        if (legible(10.5)) drawText(ctx, theme, "PAGE", { x: o.x + 10, y: o.y + 9, w: 40, h: 22 }, { size: 10, weight: 600, color: theme.muted, lineHeight: 1.3, align: "center", middle: true });
        if (legible(13)) drawText(ctx, theme, (o.ref ? res?.title?.(o.ref) : undefined) || o.text || "Untitled", { x: o.x + 60, y: o.y + 10, w: o.w - 72, h: 20 }, { size: 13, weight: 600, color: theme.ink, lineHeight: 1.5 });
        break;
      }
      // Seitenkarte: eine echte Seite auf dem Board (Doppelklick öffnet sie).
      roundRect(ctx, o.x, o.y, o.w, o.h, 14);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      const tile = Math.min(40, o.h - 24);
      roundRect(ctx, o.x + 14, o.y + (o.h - tile) / 2, tile, tile, 9);
      ctx.fillStyle = theme.raised;
      ctx.fill();
      if (legible(10.5)) drawText(ctx, theme, "PAGE", { x: o.x + 14, y: o.y + (o.h - tile) / 2, w: tile, h: tile }, { size: 10, weight: 600, color: theme.muted, lineHeight: 1.3, align: "center", middle: true });
      if (legible(13.5)) drawText(ctx, theme, (o.ref ? res?.title?.(o.ref) : undefined) || o.text || "Untitled", { x: o.x + 26 + tile, y: o.y + 12, w: o.w - tile - 40, h: o.h - 24 }, { size: 13.5, weight: 600, color: theme.ink, lineHeight: 1.4, middle: true });
      break;
    }
    default: {
      // Unbekannte Art: eine Karte mit Namen, damit nichts unsichtbar ist.
      roundRect(ctx, o.x, o.y, o.w, o.h, 14);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = theme.line;
      ctx.stroke();
      if (legible(12)) drawText(ctx, theme, o.text || (o.kind === "page" ? "Page" : "Image"), { x: o.x + 14, y: o.y + 12, w: o.w - 28, h: o.h - 24 }, { size: 12, weight: 500, color: theme.muted, lineHeight: 1.35 });
    }
  }
  // Von einem Agenten angelegt: der Marker-Strich an der linken Kante (wie überall in Based).
  if (o.style?.agent === true && o.kind !== "ink" && Math.min(o.w, o.h) * zoom >= 24) {
    roundRect(ctx, o.x + 6, o.y + 12, 3, Math.max(4, o.h - 24), 1.5);
    ctx.fillStyle = theme.marker;
    ctx.fill();
  }
  if (o.rot) ctx.restore();
}

function drawConnector(ctx: Ctx, theme: BoardTheme, c: WBConnector, byID: ReadonlyMap<string, WBObject>, zoom: number, editing = false) {
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
  // Verbindung eines Agenten: gestrichelt in der Marker-Farbe.
  const agent = c.style?.agent === true;
  ctx.strokeStyle = agent ? theme.marker : (c.style?.color && theme.pens[String(c.style.color)]) || theme.border;
  if (agent) ctx.setLineDash([4, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = 8;
  ctx.beginPath();
  ctx.moveTo(to.x - a * Math.cos(angle - 0.45), to.y - a * Math.sin(angle - 0.45));
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(to.x - a * Math.cos(angle + 0.45), to.y - a * Math.sin(angle + 0.45));
  ctx.stroke();
  if (c.label && !editing && 12 * zoom >= 5) {
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
  if (scene.background === "plain") return;
  if (scene.background === "lines" || scene.background === "grid") {
    // Liniert (Zeilenabstand 32, wie ein Schreibblock) bzw. kariert (24); weit herausgezoomt wird ausgedünnt.
    const base = scene.background === "lines" ? 32 : GRID_STEP;
    let step = base;
    while (step * camera.zoom < 12) step *= 2;
    ctx.strokeStyle = theme.dot;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = (Math.ceil(camera.y / step) * step - camera.y) * camera.zoom; y < size.h; y += step * camera.zoom) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(size.w, Math.round(y) + 0.5); }
    if (scene.background === "grid") for (let x = (Math.ceil(camera.x / step) * step - camera.x) * camera.zoom; x < size.w; x += step * camera.zoom) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, size.h); }
    ctx.stroke();
    return;
  }
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
export function drawBoard(ctx: Ctx, scene: BoardScene, theme: BoardTheme, size: Size, dpr: number, peers: readonly { x: number; y: number; name?: string }[] = [], images?: BoardImages) {
  drawBoardObjects(ctx, scene, theme, size, dpr, images);
  drawBoardOverlay(ctx, scene, theme, dpr, peers);
}

/**
 * Untergrund und Objekte – alles, was sich während eines Strichs nicht ändert. Die Ansicht zeichnet das in eine
 * eigene Ebene und legt beim Schreiben nur noch den laufenden Strich darüber (ein Bild kopieren statt alles neu).
 */
export function drawBoardObjects(ctx: Ctx, scene: BoardScene, theme: BoardTheme, size: Size, dpr: number, images?: BoardImages) {
  // images: Bilder, Textvorschauen und PDF-Seiten (BoardResources)
  const { camera } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, size.w, size.h);
  drawGrid(ctx, theme, scene, size);

  // Welt
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
  for (const o of scene.objects) {
    if (isConnector(o)) drawConnector(ctx, theme, o, scene.byID, camera.zoom, scene.editing === o.id);
    else drawShape(ctx, theme, o, camera.zoom, scene.editing === o.id, images, dpr, scene.previewScroll.get(o.id) ?? 0);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Auswahl, Griffe, Aufziehen, Lasso, Verbindung in Arbeit, fremde Zeiger – in Bildschirm-px, immer gleich groß. */
export function drawBoardOverlay(ctx: Ctx, scene: BoardScene, theme: BoardTheme, dpr: number, peers: readonly { x: number; y: number; name?: string }[] = []) {
  const { camera } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (scene.lasso && scene.lasso.length > 1) {
    ctx.beginPath();
    scene.lasso.forEach((p, i) => {
      const x = (p.x - camera.x) * camera.zoom, y = (p.y - camera.y) * camera.zoom;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = theme.selectFill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.strokeStyle = theme.muted;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (scene.snap) {
    // Vorschau der Form, zu der der gehaltene Strich wird: gestrichelt in der Auswahlfarbe.
    const sn = scene.snap;
    const r = worldRectToScreen(camera, sn.bounds);
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.select;
    ctx.beginPath();
    if (sn.kind === "line") { ctx.moveTo((sn.from.x - camera.x) * camera.zoom, (sn.from.y - camera.y) * camera.zoom); ctx.lineTo((sn.to.x - camera.x) * camera.zoom, (sn.to.y - camera.y) * camera.zoom); }
    else if (sn.kind === "oval") ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else roundRect(ctx, r.x, r.y, r.w, r.h, 10 * camera.zoom);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (scene.connecting) {
    const c = scene.connecting;
    const a = worldRectToScreen(camera, c.from);
    const to = c.target ? worldRectToScreen(camera, c.target) : undefined;
    const end = to ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : { x: (c.to.x - camera.x) * camera.zoom, y: (c.to.y - camera.y) * camera.zoom };
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    for (const r of to ? [a, to] : [a]) {
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1.5;
      roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 8);
      ctx.stroke();
    }
  }
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
