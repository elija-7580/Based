// Markdown auf dem Board zeichnen (Elija 18.11.). Gelesen wird in @based/core (parseMarkdown), hier wird gesetzt
// (Zeilen umbrechen, Listen einrücken, Aufgaben-Kästchen) und gezeichnet. Das Setzen ist rein (Messfunktion von außen,
// testbar) und wird je (Text, Breite, Schrift) gemerkt: Messen ist das Teuerste am Zeichnen von Text.
import { hasMarkdown, parseMarkdown, type MdBlock, type MdRun, type WBShape } from "@based/core";

type Ctx = CanvasRenderingContext2D;
type Box = { x: number; y: number; w: number; h: number };

/** Grundschrift eines Textfelds (Welt-px). */
export interface MdBase { size: number; weight: number; lineHeight: number; font: string; mono: string; align?: "left" | "center" }

/** Ein gesetztes Stück Text; x relativ zur Zeile. */
export interface MdFrag { x: number; w: number; text: string; font: string; size: number; run: MdRun }
export type MdDeco =
  | { kind: "bullet"; x: number; r: number }
  | { kind: "number"; x: number; text: string; font: string }
  | { kind: "check"; x: number; s: number; checked: boolean }
  | { kind: "quote"; x: number }
  | { kind: "hr" }
  | { kind: "code"; first: boolean; last: boolean };
export interface MdLine {
  y: number; h: number; w: number; frags: MdFrag[]; deco?: MdDeco; muted?: boolean;
  /** Zeile im Quelltext (Aufgaben abhaken). */
  source: number;
  /** Abstand über dem Text (erste Zeile eines Codeblocks). */
  pad?: number;
}
export interface MdLayout { lines: MdLine[]; height: number }

const fontOf = (base: MdBase, size: number, weight: number, run: MdRun) =>
  run.code ? `${weight >= 600 ? 600 : 400} ${size * 0.88}px ${base.mono}` : `${run.italic ? "italic " : ""}${run.bold ? Math.max(700, weight) : weight} ${size}px ${base.font}`;

/** Text als Markdown setzen: Zeilen mit Stücken und Verzierungen, Gesamthöhe. Exportiert für Tests. */
export function layoutMarkdown(measure: (font: string, s: string) => number, text: string, width: number, base: MdBase): MdLayout {
  const S = base.size, L = base.lineHeight;
  const lines: MdLine[] = [];
  let y = 0;
  const blocks = parseMarkdown(text);
  blocks.forEach((b, bi) => {
    const prev = blocks[bi - 1];
    switch (b.type) {
      case "blank": y += S * L * 0.6; return;
      case "hr": lines.push({ y, h: S * L * 0.8, w: width, frags: [], deco: { kind: "hr" }, source: b.line }); y += S * L * 0.8; return;
      case "code": {
        const size = S, lh = S * 0.88 * 1.5;
        const pad = S * 0.6;
        const top = b.first ? S * 0.35 : 0, bottom = b.last ? S * 0.35 : 0;
        const rows = wrapRuns(measure, [{ text: b.text || " ", code: true }], width - pad * 2, (r) => fontOf(base, size, base.weight, r), size);
        rows.forEach((frags, i) => {
          const first = b.first && i === 0, last = b.last && i === rows.length - 1;
          const h = lh + (first ? top : 0) + (last ? bottom : 0);
          lines.push({ y, h, w: width, frags: frags.map((f) => ({ ...f, x: f.x + pad })), deco: { kind: "code", first, last }, source: b.line, ...(first ? { pad: top } : {}) });
          y += h;
        });
        return;
      }
    }
    let size = S, weight = base.weight, lh = L, indent = 0, deco: MdDeco | undefined, muted = false, gap = 0;
    if (b.type === "h") {
      size = S * ([1.5, 1.25, 1.1] as const)[b.level - 1]!;
      weight = Math.max(650, base.weight + 150);
      lh = 1.25;
      if (prev && prev.type !== "blank") gap = S * 0.35;
    } else if (b.type === "li") {
      const step = S * 1.25;
      const at = b.depth * step;
      if (b.checked !== undefined) {
        const s = S * 0.82;
        deco = { kind: "check", x: at + 1, s, checked: b.checked };
        indent = at + s + S * 0.5;
        muted = b.checked;
      } else if (b.ordered) {
        const font = `${base.weight} ${S}px ${base.font}`;
        const w = measure(font, b.marker);
        deco = { kind: "number", x: at, text: b.marker, font };
        indent = at + Math.max(step, w + S * 0.4);
      } else {
        deco = { kind: "bullet", x: at + S * 0.35, r: Math.max(1.5, S * 0.14) };
        indent = at + step;
      }
    } else if (b.type === "quote") {
      deco = { kind: "quote", x: S * 0.1 };
      indent = S * 0.85;
      muted = true;
    }
    y += gap;
    const runs: MdRun[] = muted && b.type === "li" ? b.runs.map((r) => ({ ...r, strike: true })) : b.runs;
    const rows = wrapRuns(measure, runs.length ? runs : [{ text: "" }], Math.max(8, width - indent), (r) => fontOf(base, size, weight, r), size);
    rows.forEach((frags, i) => {
      const h = size * lh;
      const w = frags.length ? frags[frags.length - 1]!.x + frags[frags.length - 1]!.w : 0;
      lines.push({ y, h, w: indent + w, frags: frags.map((f) => ({ ...f, x: f.x + indent })), ...(i === 0 && deco ? { deco } : {}), ...(muted ? { muted } : {}), source: b.line });
      y += h;
    });
  });
  return { lines, height: y };
}

type Piece = Omit<MdFrag, "x">;

/** Stücke greedy auf Zeilen verteilen (Wörter; ein überlanges Wort wird hart geteilt). */
function wrapRuns(measure: (font: string, s: string) => number, runs: readonly MdRun[], width: number, font: (r: MdRun) => string, size: number): MdFrag[][] {
  const rows: MdFrag[][] = [];
  let row: MdFrag[] = [];
  let x = 0;
  const put = (p: Piece) => {
    const last = row[row.length - 1];
    if (last && last.run === p.run && last.font === p.font) { last.text += p.text; last.w += p.w; } else row.push({ ...p, x });
    x += p.w;
  };
  const breakLine = () => {
    // Leerraum am Zeilenende zählt nicht.
    const last = row[row.length - 1];
    if (last && /\s$/.test(last.text)) {
      const t = last.text.replace(/\s+$/, "");
      last.w = t ? measure(last.font, t) : 0;
      last.text = t;
      if (!t) row.pop();
    }
    rows.push(row);
    row = [];
    x = 0;
  };
  for (const run of runs) {
    const f = font(run);
    for (const word of run.text.split(/(\s+)/)) {
      if (word === "") continue;
      const space = /^\s+$/.test(word);
      if (space && x === 0 && rows.length > 0) continue; // kein Leerraum am Anfang einer umbrochenen Zeile
      const w = measure(f, word);
      if (x + w <= width || space) { put({ text: word, w, font: f, size, run }); continue; }
      if (x > 0) breakLine();
      if (w <= width) { put({ text: word, w, font: f, size, run }); continue; }
      let rest = word;
      while (rest.length > 1 && measure(f, rest) > width - x) {
        let n = rest.length - 1;
        while (n > 1 && measure(f, rest.slice(0, n)) > width - x) n -= 1;
        put({ text: rest.slice(0, n), w: measure(f, rest.slice(0, n)), font: f, size, run });
        breakLine();
        rest = rest.slice(n);
      }
      put({ text: rest, w: measure(f, rest), font: f, size, run });
    }
  }
  if (row.length || rows.length === 0) breakLine();
  return rows;
}

// MARK: Merken und Messen

const cache = new Map<string, MdLayout>();
const CACHE_MAX = 1500;
let measureCtx: Ctx | undefined;

/** Gemerktes Setzen; `ctx` misst (ohne: eine eigene, unsichtbare Fläche – Treffer und Höhe ohne Zeichnen). */
export function markdownLayout(text: string, width: number, base: MdBase, ctx?: Ctx): MdLayout {
  const key = `${base.font}|${base.mono}|${base.size}|${base.weight}|${base.lineHeight}|${Math.round(width)}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = ctx ?? measurer();
  let current = "";
  const layout = layoutMarkdown((font, s) => {
    if (!c) return s.length * base.size * 0.55;
    if (font !== current) { c.font = font; current = font; }
    return c.measureText(s).width;
  }, text, width, base);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, layout);
  return layout;
}

function measurer(): Ctx | undefined {
  if (measureCtx) return measureCtx;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : undefined;
    measureCtx = (canvas?.getContext("2d") ?? undefined) as Ctx | undefined;
  } catch { measureCtx = undefined; }
  return measureCtx;
}

// MARK: Zeichnen

/** `on`: Farbe des Hakens auf dem gefüllten Kästchen (Untergrund der Fläche). */
export interface MdColors { ink: string; muted: string; link: string; mark: string; line: string; on: string; dark: boolean }

/** Gesetzten Markdown-Text in `box` zeichnen (Welt-Koordinaten); was nicht passt, endet mit „…“. */
export function drawMarkdown(ctx: Ctx, text: string, box: Box, base: MdBase & { middle?: boolean }, colors: MdColors) {
  if (!text || box.w <= 4 || box.h <= 4) return;
  const layout = markdownLayout(text, box.w, base, ctx);
  const top = base.middle && layout.height < box.h ? box.y + (box.h - layout.height) / 2 : box.y;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let cut = false;
  let lastShown: MdLine | undefined;
  for (const line of layout.lines) {
    if (line.y + line.h > box.h + 0.5 && lastShown) { cut = true; break; }
    lastShown = line;
    const dx = base.align === "center" && line.deco?.kind !== "code" && line.deco?.kind !== "hr" ? Math.max(0, (box.w - line.w) / 2) : 0;
    const lx = box.x + dx, ly = top + line.y;
    const pad = line.pad ?? 0;
    const cy = line.deco?.kind === "code" ? ly + pad + (base.size * 0.88 * 1.5) / 2 : ly + line.h / 2;
    if (line.deco) drawDeco(ctx, line.deco, box, lx, ly, line, cy, base, colors);
    const inBlock = line.deco?.kind === "code";
    for (const f of line.frags) drawFrag(ctx, f, lx + f.x, cy, line.muted ? colors.muted : colors.ink, colors, inBlock);
  }
  if (cut && lastShown) {
    const ly = top + lastShown.y;
    const dx = base.align === "center" ? Math.max(0, (box.w - lastShown.w) / 2) : 0;
    ctx.font = `${base.weight} ${base.size}px ${base.font}`;
    ctx.fillStyle = colors.muted;
    ctx.fillText("…", Math.min(box.x + dx + lastShown.w + 2, box.x + box.w - base.size * 0.6), ly + lastShown.h / 2);
  }
}

function drawFrag(ctx: Ctx, f: MdFrag, x: number, cy: number, color: string, colors: MdColors, inBlock = false) {
  const r = f.run;
  const h = f.size * 1.3;
  if (r.mark) {
    ctx.fillStyle = colors.mark;
    ctx.fillRect(x - 1, cy - h / 2, f.w + 2, h);
  }
  if (r.code && !inBlock) {
    ctx.save();
    ctx.globalAlpha = colors.dark ? 0.16 : 0.08;
    ctx.fillStyle = colors.ink;
    const pad = f.size * 0.18;
    rounded(ctx, x - pad, cy - (f.size * 1.2) / 2, f.w + pad * 2, f.size * 1.2, f.size * 0.25);
    ctx.fill();
    ctx.restore();
  }
  const c = r.link ? colors.link : color;
  ctx.font = f.font;
  ctx.fillStyle = c;
  ctx.fillText(f.text, x, cy);
  if (r.strike || r.link) {
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(0.75, f.size / 16);
    ctx.beginPath();
    const ly = r.strike ? cy : cy + f.size * 0.5;
    ctx.moveTo(x, ly);
    ctx.lineTo(x + f.w, ly);
    ctx.stroke();
  }
}

function drawDeco(ctx: Ctx, d: MdDeco, box: Box, lx: number, ly: number, line: MdLine, cy: number, base: MdBase, colors: MdColors) {
  switch (d.kind) {
    case "bullet":
      ctx.fillStyle = colors.ink;
      ctx.beginPath();
      ctx.arc(lx + d.x, cy, d.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "number":
      ctx.font = d.font;
      ctx.fillStyle = colors.muted;
      ctx.fillText(d.text, lx + d.x, cy);
      break;
    case "check": {
      const s = d.s, x = lx + d.x, y = cy - s / 2;
      rounded(ctx, x, y, s, s, s * 0.22);
      if (d.checked) {
        ctx.fillStyle = colors.link;
        ctx.fill();
        ctx.strokeStyle = colors.on;
        ctx.lineWidth = Math.max(1, s / 8);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(x + s * 0.24, y + s * 0.52);
        ctx.lineTo(x + s * 0.43, y + s * 0.7);
        ctx.lineTo(x + s * 0.77, y + s * 0.3);
        ctx.stroke();
      } else {
        ctx.strokeStyle = colors.muted;
        ctx.lineWidth = Math.max(1, s / 12);
        ctx.stroke();
      }
      break;
    }
    case "quote":
      ctx.fillStyle = colors.line;
      ctx.fillRect(lx + d.x, ly + 2, Math.max(2, base.size * 0.16), line.h - 4);
      break;
    case "hr":
      ctx.fillStyle = colors.line;
      ctx.fillRect(box.x, ly + line.h / 2 - 0.5, box.w, 1);
      break;
    case "code": {
      ctx.save();
      ctx.globalAlpha = colors.dark ? 0.14 : 0.06;
      ctx.fillStyle = colors.ink;
      const r = base.size * 0.4;
      const top = d.first ? 0 : r, bottom = d.last ? 0 : r;
      // Zeilen eines Codeblocks ergeben zusammen eine Fläche mit runden Ecken oben und unten.
      ctx.beginPath();
      ctx.rect(box.x, ly, box.w, line.h);
      ctx.clip();
      rounded(ctx, box.x, ly - top, box.w, line.h + top + bottom, r);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// MARK: Textfelder der Objekte

/** Wo und wie ein Objekt seinen Text zeigt (eine Stelle für Zeichnen, Treffer und Höhe). */
export function textFieldOf(o: Pick<WBShape, "kind" | "x" | "y" | "w" | "h">): { box: Box; size: number; weight: number; lineHeight: number; align?: "center"; middle?: boolean } | undefined {
  switch (o.kind) {
    case "note": return { box: { x: o.x + 14, y: o.y + 14, w: o.w - 28, h: o.h - 28 }, size: 15, weight: 500, lineHeight: 1.4 };
    case "shape": return { box: { x: o.x + 12, y: o.y + 8, w: o.w - 24, h: o.h - 16 }, size: 14, weight: 500, lineHeight: 1.4, align: "center", middle: true };
    case "text": return { box: { x: o.x, y: o.y, w: o.w, h: Math.max(o.h, 26) }, size: 17, weight: 400, lineHeight: 1.5 };
    default: return undefined;
  }
}

/** Fallback-Schriften, solange die Fläche noch keine Tokens gelesen hat. */
export const BOARD_MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
let fonts = { font: "system-ui, sans-serif", mono: BOARD_MONO_FALLBACK };
/** Die Fläche meldet ihre Schriften (aus den Tokens), damit Treffer und Höhe genauso setzen wie das Zeichnen. */
export function setBoardFonts(font: string, mono: string) { fonts = { font, mono }; }

/** Aufgaben-Kästchen unter dem Punkt (Welt): Zeile im Quelltext, sonst `undefined`. */
export function boardTaskAt(o: WBShape, p: { x: number; y: number }): number | undefined {
  if (o.rot || !o.text || !o.text.includes("[")) return undefined;
  const f = textFieldOf(o);
  if (!f) return undefined;
  const base = { ...fonts, size: f.size, weight: f.weight, lineHeight: f.lineHeight, ...(f.align ? { align: f.align } : {}) };
  const layout = markdownLayout(o.text, f.box.w, base);
  const top = f.middle && layout.height < f.box.h ? f.box.y + (f.box.h - layout.height) / 2 : f.box.y;
  for (const line of layout.lines) {
    if (line.y + line.h > f.box.h + 0.5) break;
    if (line.deco?.kind !== "check") continue;
    const dx = f.align === "center" ? Math.max(0, (f.box.w - line.w) / 2) : 0;
    const x = f.box.x + dx + line.deco.x, cy = top + line.y + line.h / 2, s = line.deco.s, slack = Math.max(4, s * 0.35);
    if (p.x >= x - slack && p.x <= x + s + slack && p.y >= cy - s / 2 - slack && p.y <= cy + s / 2 + slack) return line.source;
  }
  return undefined;
}

/** Höhe, die ein Text-Objekt für seinen gesetzten Markdown-Text braucht (Welt-px); ohne Markdown: `undefined`. */
export function boardTextHeight(text: string, width: number): number | undefined {
  if (!hasMarkdown(text)) return undefined;
  const f = textFieldOf({ kind: "text", x: 0, y: 0, w: width, h: 0 })!;
  return markdownLayout(text, width, { ...fonts, size: f.size, weight: f.weight, lineHeight: f.lineHeight }).height;
}

export type { MdBlock };
