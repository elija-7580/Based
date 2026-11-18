// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-566: Obsidian Canvas (.canvas, JSON Canvas 1.0) und Excalidraw-Zeichnungen (Obsidian-Plugin „….excalidraw.md“
// oder eine .excalidraw-Datei) als Board. Rein, ohne DOM; die Auflösung von Notizen und Dateien kommt vom Importer.
// Clean-Room: nur die offen beschriebenen Dateiformate (JSON Canvas Spec; Excalidraw-Szene als JSON, im Plugin mit
// LZ-String-Base64 gepackt). Was ein Board nicht kennt (Einbettungen, Webseiten-Rahmen), wird als Hinweis gemeldet.
import { keysBetween } from "../sortkeys.js";
import type { ConnectorSide, WBObject, WBShape, WBStyleValue } from "../whiteboard/model.js";
import { encodeInk, type InkPoint } from "../whiteboard/ink.js";
import { inkObjectGeometry } from "../whiteboard/stroke.js";
import { BOARD_PEN_WIDTHS } from "../whiteboard/style.js";

/** Was der Importer für ein Board auflöst. */
export interface BoardImportContext {
  /** Notiz oder andere Board-Datei im Vault → Seiten-ID und Titel. */
  page(target: string): { id: string; title: string } | undefined;
  /** Datei (Bild, PDF …) → Verweis im Dateispeicher. */
  file(target: string): { ref: string; name: string; mime: string; size: number } | undefined;
  newID(): string;
  warn(message: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Farben: Namen der Board-Palette nach dem Farbton (Hex aus Canvas/Excalidraw, Canvas-Vorgaben „1“…„6“).

type Rgb = [number, number, number];
const hexRgb = (hex: string): Rgb | undefined => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** Farbname der Board-Palette; `undefined` für transparent/unlesbar. `dark`: fast Schwarz → „ink“ (nur Striche). */
export function boardColorName(value: string | undefined, use: "stroke" | "fill"): string | undefined {
  if (value === undefined || value === "" || value === "transparent") return undefined;
  const preset: Record<string, string> = { "1": "red", "2": "orange", "3": "orange", "4": "green", "5": "blue", "6": "purple" };
  if (preset[value]) return preset[value];
  const rgb = hexRgb(value);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.08) {
    if (use === "stroke" && l < 0.3) return "ink";
    return l > 0.97 && use === "fill" ? undefined : "gray";
  }
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 340) return l < 0.35 ? "brown" : "red";
  if (hue < 45) return l < 0.4 ? "brown" : "orange";
  if (hue < 70) return "orange"; // Gelb gibt es auf dem Board nicht (die Marker-Farbe gehört den Agenten).
  if (hue < 170) return "green";
  if (hue < 250) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

const plainLinks = (md: string) =>
  md.replace(/!?\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
    const bar = inner.indexOf("|");
    const label = bar < 0 ? inner : inner.slice(bar + 1);
    return (bar < 0 ? label.replace(/#.*$/, "").replace(/\.md$/i, "").split("/").pop() ?? label : label).trim();
  });

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ---------------------------------------------------------------------------------------------------------------
// Obsidian Canvas

const SIDES = new Set(["top", "right", "bottom", "left"]);

/** Objekte eines Canvas (JSON-Text). Wirft bei unlesbarem JSON. */
export function canvasToBoard(json: string, ctx: BoardImportContext, label: string): WBObject[] {
  const data = JSON.parse(json) as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(data.nodes) ? (data.nodes as Record<string, unknown>[]) : [];
  const edges = Array.isArray(data.edges) ? (data.edges as Record<string, unknown>[]) : [];
  // Gruppen nach hinten, sonst in Dateireihenfolge (die Reihenfolge der Spec ist auch die Zeichenreihenfolge).
  const ordered = [...nodes.filter((n) => n.type === "group"), ...nodes.filter((n) => n.type !== "group")];
  const ids = new Map<string, string>();
  const shapes: WBObject[] = [];
  const skipped = new Map<string, number>();
  for (const n of ordered) {
    const id = ctx.newID();
    const base = { id, z: "", x: Math.round(num(n.x)), y: Math.round(num(n.y)), w: Math.max(8, Math.round(num(n.width, 240))), h: Math.max(8, Math.round(num(n.height, 120))), rot: 0 };
    const color = boardColorName(str(n.color), "fill");
    let o: WBShape | undefined;
    if (n.type === "text") {
      o = { ...base, kind: "shape", text: plainLinks(str(n.text) ?? ""), style: { shape: "rect", ...(color ? { color, fill: color } : {}) } };
    } else if (n.type === "group") {
      o = { ...base, kind: "frame", ...(str(n.label) ? { text: str(n.label)! } : {}), ...(color ? { style: { color } } : {}) };
    } else if (n.type === "link") {
      const url = str(n.url) ?? "";
      o = { ...base, kind: "shape", text: url ? `[${url}](${url})` : "", style: { shape: "rect", ...(color ? { color } : {}) } };
    } else if (n.type === "file") {
      const target = str(n.file) ?? "";
      const page = /\.(md|canvas)$/i.test(target) ? ctx.page(target) : undefined;
      const file = page ? undefined : ctx.file(target);
      if (page) o = { ...base, kind: "page", ref: page.id, text: page.title };
      else if (file) {
        const image = /^image\//.test(file.mime);
        o = { ...base, kind: image ? "image" : "file", ref: file.ref, style: { name: file.name, mime: file.mime, size: file.size } };
      } else {
        ctx.warn(`${label}: missing file “${target}” – kept as a card`);
        o = { ...base, kind: "shape", text: target, style: { shape: "rect" } };
      }
    } else {
      const t = String(n.type ?? "unknown");
      skipped.set(t, (skipped.get(t) ?? 0) + 1);
    }
    if (!o) continue;
    if (typeof n.id === "string") ids.set(n.id, id);
    shapes.push(o);
  }
  const connectors: WBObject[] = [];
  for (const e of edges) {
    const from = ids.get(String(e.fromNode)), to = ids.get(String(e.toNode));
    if (!from || !to) continue;
    const side = (v: unknown): ConnectorSide => (typeof v === "string" && SIDES.has(v) ? (v as ConnectorSide) : "auto");
    const color = boardColorName(str(e.color), "stroke");
    const style: Record<string, WBStyleValue> = {};
    if (color) style.color = color;
    connectors.push({
      id: ctx.newID(), z: "", kind: "connector", from: { id: from, side: side(e.fromSide) }, to: { id: to, side: side(e.toSide) }, shape: "curved",
      ...(str(e.label) ? { label: str(e.label)! } : {}), ...(Object.keys(style).length ? { style } : {}),
    });
  }
  for (const [t, n] of skipped) ctx.warn(`${label}: ${n} ${t} card${n === 1 ? "" : "s"} skipped`);
  return withZ([...shapes, ...connectors]);
}

function withZ(objs: WBObject[]): WBObject[] {
  const keys = keysBetween(objs.length, undefined, undefined);
  return objs.map((o, i) => ({ ...o, z: keys[i]! }) as WBObject);
}

// ---------------------------------------------------------------------------------------------------------------
// Excalidraw

/** Ist der Text eine Zeichnung des Obsidian-Excalidraw-Plugins? */
export const isExcalidrawMarkdown = (path: string, head: string) =>
  /\.excalidraw\.md$/i.test(path) || /^---\n[\s\S]*?\bexcalidraw-plugin:/.test(head.replaceAll("\r\n", "\n"));

export interface ExcalidrawScene {
  elements: Record<string, unknown>[];
  /** fileId → Pfad im Vault (aus „## Embedded Files“ des Plugins). */
  files: Map<string, string>;
}

/** Szene aus einer .excalidraw-Datei (JSON) oder einer Plugin-Notiz (```json bzw. ```compressed-json). */
export function readExcalidraw(text: string): ExcalidrawScene {
  const t = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const files = new Map<string, string>();
  for (const m of t.matchAll(/^([0-9a-f]{20,64}):\s*\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]\s*$/gim)) files.set(m[1]!.toLowerCase(), m[2]!.trim());
  let json: string | undefined;
  if (t.trimStart().startsWith("{")) json = t;
  else {
    const packed = /```compressed-json\n([\s\S]*?)```/.exec(t);
    if (packed) json = lzDecompressFromBase64(packed[1]!.replace(/\s+/g, "")) ?? undefined;
    else json = /```json\n([\s\S]*?)```/.exec(t)?.[1];
  }
  if (json === undefined) throw new Error("no drawing data");
  const scene = JSON.parse(json) as { elements?: unknown };
  const elements = Array.isArray(scene.elements) ? (scene.elements as Record<string, unknown>[]).filter((e) => e && typeof e === "object" && e.isDeleted !== true) : [];
  return { elements, files };
}

const SHAPES: Record<string, string> = { rectangle: "rect", ellipse: "oval", diamond: "diamond" };

/** Objekte einer Excalidraw-Szene. */
export function excalidrawToBoard(scene: ExcalidrawScene, ctx: BoardImportContext, label: string): WBObject[] {
  const els = scene.elements;
  const byID = new Map(els.map((e) => [String(e.id), e]));
  // Text, der in einer Form oder an einem Pfeil steht (containerId), wird deren Text bzw. Beschriftung.
  const bound = new Map<string, string>();
  for (const e of els) if (e.type === "text" && typeof e.containerId === "string" && byID.has(e.containerId)) bound.set(e.containerId, str(e.originalText) ?? str(e.text) ?? "");
  const ids = new Map<string, string>();
  const out: WBObject[] = [];
  const skipped = new Map<string, number>();
  const frames: WBObject[] = [];
  const rotation = (e: Record<string, unknown>) => Math.round(((num(e.angle) * 180) / Math.PI) * 100) / 100;
  const box = (e: Record<string, unknown>) => {
    let x = num(e.x), y = num(e.y), w = num(e.width), h = num(e.height);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x: Math.round(x), y: Math.round(y), w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) };
  };
  const inkOf = (e: Record<string, unknown>, closed = false): WBObject | undefined => {
    const pts = Array.isArray(e.points) ? (e.points as unknown[]) : [];
    const pressures = Array.isArray(e.pressures) ? (e.pressures as unknown[]) : [];
    const world: InkPoint[] = pts.flatMap((p, i) => (Array.isArray(p) && p.length >= 2 ? [{ x: num(e.x) + num(p[0]), y: num(e.y) + num(p[1]), p: Math.min(1, Math.max(0, num(pressures[i], 0.5))) }] : []));
    if (closed && world.length > 2) world.push({ ...world[0]! });
    if (world.length === 0) return undefined;
    const width = Math.min(64, Math.max(0.5, num(e.strokeWidth, 1) * (e.type === "freedraw" ? 1.2 : 1) * BOARD_PEN_WIDTHS[1]! / 2));
    const g = inkObjectGeometry(world, width);
    if (!g) return undefined;
    const color = boardColorName(str(e.strokeColor), "stroke") ?? "ink";
    return { id: ctx.newID(), z: "", kind: "ink", x: g.x, y: g.y, w: g.w, h: g.h, rot: 0, ink: encodeInk(g.points), style: { color, width, bw: g.w, bh: g.h } };
  };
  for (const e of els) {
    const type = String(e.type ?? "");
    if (type === "text" && typeof e.containerId === "string" && byID.has(e.containerId)) continue;
    const eid = String(e.id);
    let o: WBObject | undefined;
    if (SHAPES[type]) {
      const stroke = boardColorName(str(e.strokeColor), "stroke");
      const fill = boardColorName(str(e.backgroundColor), "fill");
      const text = bound.get(eid);
      o = { id: ctx.newID(), z: "", kind: "shape", ...box(e), rot: rotation(e), ...(text ? { text } : {}),
        style: { shape: SHAPES[type]!, ...(stroke && stroke !== "ink" ? { color: stroke } : {}), ...(fill ? { fill } : {}) } };
    } else if (type === "text") {
      const color = boardColorName(str(e.strokeColor), "stroke");
      o = { id: ctx.newID(), z: "", kind: "text", ...box(e), rot: rotation(e), text: str(e.originalText) ?? str(e.text) ?? "", ...(color && color !== "ink" ? { style: { color } } : {}) };
    } else if (type === "frame" || type === "magicframe") {
      const f: WBObject = { id: ctx.newID(), z: "", kind: "frame", ...box(e), rot: 0, ...(str(e.name) ? { text: str(e.name)! } : {}) };
      ids.set(eid, f.id);
      frames.push(f);
      continue;
    } else if (type === "image") {
      const target = scene.files.get(String(e.fileId ?? "").toLowerCase());
      const file = target ? ctx.file(target) : undefined;
      if (file) o = { id: ctx.newID(), z: "", kind: "image", ...box(e), rot: rotation(e), ref: file.ref, style: { name: file.name, mime: file.mime, size: file.size } };
      else { ctx.warn(`${label}: an image without its file was skipped`); continue; }
    } else if (type === "freedraw") {
      o = inkOf(e);
    } else if (type === "line" || type === "arrow") {
      const sb = (e.startBinding as { elementId?: unknown } | null | undefined)?.elementId;
      const eb = (e.endBinding as { elementId?: unknown } | null | undefined)?.elementId;
      if (typeof sb === "string" && typeof eb === "string" && byID.has(sb) && byID.has(eb) && sb !== eb) {
        // Verbindung zwischen zwei Formen: erst nach den Formen anlegen (die IDs müssen feststehen).
        continue;
      }
      o = inkOf(e);
    } else {
      skipped.set(type || "unknown", (skipped.get(type || "unknown") ?? 0) + 1);
      continue;
    }
    if (!o) continue;
    ids.set(eid, o.id);
    out.push(o);
  }
  const connectors: WBObject[] = [];
  for (const e of els) {
    if (e.type !== "line" && e.type !== "arrow") continue;
    const sb = (e.startBinding as { elementId?: unknown } | null | undefined)?.elementId;
    const eb = (e.endBinding as { elementId?: unknown } | null | undefined)?.elementId;
    const from = typeof sb === "string" ? ids.get(sb) : undefined, to = typeof eb === "string" ? ids.get(eb) : undefined;
    if (!from || !to || sb === eb) continue;
    const pts = Array.isArray(e.points) ? e.points.length : 2;
    const color = boardColorName(str(e.strokeColor), "stroke");
    const style: Record<string, WBStyleValue> = {};
    if (color && color !== "ink") style.color = color;
    const text = bound.get(String(e.id));
    connectors.push({ id: ctx.newID(), z: "", kind: "connector", from: { id: from, side: "auto" }, to: { id: to, side: "auto" }, shape: e.elbowed === true ? "elbow" : pts > 2 ? "curved" : "straight",
      ...(text ? { label: text } : {}), ...(Object.keys(style).length ? { style } : {}) });
  }
  for (const [t, n] of skipped) ctx.warn(`${label}: ${n} ${t} element${n === 1 ? "" : "s"} skipped`);
  return withZ([...frames, ...out, ...connectors]);
}

// ---------------------------------------------------------------------------------------------------------------
// LZ-String (Base64-Variante), nur Entpacken – so packt das Excalidraw-Plugin die Szene („compressed-json“).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** Entpackt `compressToBase64` von LZ-String; `null` bei kaputten Daten. */
export function lzDecompressFromBase64(input: string): string | null {
  if (input === "") return "";
  const value = (i: number) => {
    const v = B64.indexOf(input.charAt(i));
    return v < 0 ? 0 : v;
  };
  const dict: string[] = ["", "", ""];
  let enlargeIn = 4, dictSize = 4, numBits = 3;
  const out: string[] = [];
  let pos = 32, idx = 1, val = value(0);
  const bits = (n: number) => {
    let res = 0, power = 1;
    const max = 1 << n;
    while (power !== max) {
      const b = val & pos;
      pos >>= 1;
      if (pos === 0) { pos = 32; val = value(idx++); }
      res |= (b > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return res;
  };
  let c: string;
  switch (bits(2)) {
    case 0: c = String.fromCharCode(bits(8)); break;
    case 1: c = String.fromCharCode(bits(16)); break;
    case 2: return "";
    default: return null;
  }
  dict[3] = c;
  let w = c;
  out.push(c);
  for (;;) {
    if (idx > input.length + 1) return "";
    let cc = bits(numBits);
    switch (cc) {
      case 0: dict[dictSize++] = String.fromCharCode(bits(8)); cc = dictSize - 1; enlargeIn--; break;
      case 1: dict[dictSize++] = String.fromCharCode(bits(16)); cc = dictSize - 1; enlargeIn--; break;
      case 2: return out.join("");
    }
    if (enlargeIn === 0) { enlargeIn = 1 << numBits; numBits++; }
    let entry: string;
    if (dict[cc] !== undefined) entry = dict[cc]!;
    else if (cc === dictSize) entry = w + w.charAt(0);
    else return null;
    out.push(entry);
    dict[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 1 << numBits; numBits++; }
  }
}
