// BSD-93 (Entscheidung Elija, 17.11.2026): Agenten bedienen das Whiteboard über Text – wenige Token, keine
// Koordinaten, kein Browser. Vorbild ist das Prinzip „Diagramm als Text“ (Mermaid, Excalidraw-Import): der Agent
// sagt, WAS es gibt und was womit zusammenhängt; die Anordnung rechnet Based. Geschrieben wird direkt in die Records
// des Boards (über MCP, lokal oder am Server) – ein offenes Board zeigt es sofort, ein geschlossenes beim Öffnen.
//
// Lesen – `boardOutline`: eine Zeile je Objekt, kurze Kennung (eindeutiger Anfang der ID), Tinte nur als Zahl.
// Schreiben – `planBoardScript`: eine Anweisung je Zeile:
//   note a: Text            Zettel            box|oval|diamond b: Text      Form
//   text t: Text            freier Text       page p: <Seiten-ID>           Seitenkarte (live verknüpft)
//   a -> b: Beschriftung    Verbindung (a, b: Namen aus diesem Skript oder Kennungen aus dem Lesen)
//   frame f: Titel { a b }  Rahmen um Objekte
//   set <Kennung>: Text     Text ändern       del <Kennung>                 löschen
import { keyBetween } from "../sortkeys.js";
import { danglingConnectors, type WBConnector, type WBObject, type WBShape } from "./model.js";

const isShape = (o: WBObject): o is WBShape => o.kind !== "connector";
const oneLine = (s: string, max = 80) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

/** Kürzeste eindeutige Kennung je Objekt (mindestens 4 Zeichen vom Anfang der ID). */
export function boardHandles(objs: readonly WBObject[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of objs) {
    let n = 4;
    while (n < o.id.length && objs.some((p) => p !== o && p.id.startsWith(o.id.slice(0, n)))) n += 1;
    out.set(o.id, o.id.slice(0, n));
  }
  return out;
}

/** Das Board als knapper Text für einen Agenten. `titles`: Seitentitel für Seitenkarten. */
export function boardOutline(objs: readonly WBObject[], titles: (pageID: string) => string | undefined = () => undefined): string {
  if (objs.length === 0) return "(empty board)";
  const h = boardHandles(objs);
  const lines: string[] = [];
  let ink = 0;
  const shapes = objs.filter(isShape).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of shapes) {
    if (o.kind === "ink") { ink += 1; continue; }
    const at = `@${Math.round(o.x)},${Math.round(o.y)}`;
    const id = h.get(o.id)!;
    if (o.kind === "page") lines.push(`${id} page ${o.ref ?? "?"} "${oneLine(titles(o.ref ?? "") ?? o.text ?? "")}" ${at}`);
    else if (o.kind === "image" || o.kind === "file") {
      const page = o.style?.view === "pdf" ? ` p${String(o.style.page)}` : "";
      lines.push(`${id} ${o.kind} "${oneLine(String(o.style?.name ?? ""))}"${page} ${at}`);
    } else lines.push(`${id} ${o.kind === "shape" ? String(o.style?.shape ?? "rect").replace("rect", "box") : o.kind} "${oneLine(o.text ?? "")}" ${at}${o.kind === "frame" ? ` ${Math.round(o.w)}x${Math.round(o.h)}` : ""}`);
  }
  for (const o of objs) if (!isShape(o)) lines.push(`${h.get(o.from.id) ?? "?"} -> ${h.get(o.to.id) ?? "?"}${o.label ? `: ${oneLine(o.label)}` : ""}`);
  if (ink) lines.push(`(${ink} handwritten stroke${ink === 1 ? "" : "s"})`);
  return lines.join("\n");
}

export interface BoardPlan {
  add: WBObject[];
  patch: Map<string, Record<string, unknown>>;
  remove: string[];
  /** Name im Skript → ID des neuen Objekts. */
  names: Map<string, string>;
  /** Zeilen, die nicht ausgeführt wurden, mit Grund (der Rest gilt trotzdem). */
  errors: string[];
}

const SIZES = { note: { w: 168, h: 150 }, shape: { w: 180, h: 72 }, text: { w: 320, h: 26 }, page: { w: 240, h: 72 } } as const;
const GAP_X = 88, GAP_Y = 32, FRAME_PAD = 24, FRAME_TOP = 52;
/** Höchstens so viele Anweisungen je Aufruf. */
export const BOARD_SCRIPT_MAX = 400;

interface Node { name: string; kind: "note" | "shape" | "text" | "page"; shape?: string; text: string; ref?: string; w: number; h: number }

/**
 * Ein Skript in Änderungen übersetzen (ohne sie auszuführen). Neue Objekte werden in Spalten entlang der Verbindungen
 * angeordnet (Quelle links, Ziel rechts) und rechts neben den vorhandenen Inhalt gesetzt. Alles Neue trägt
 * `style.agent` – die Fläche zeigt es mit dem Marker-Strich.
 */
export function planBoardScript(script: string, existing: readonly WBObject[], newID: () => string): BoardPlan {
  const plan: BoardPlan = { add: [], patch: new Map(), remove: [], names: new Map(), errors: [] };
  const nodes = new Map<string, Node>();
  const edges: { from: string; to: string; label?: string }[] = [];
  const frames: { name: string; title: string; members: string[] }[] = [];
  const find = (handle: string): WBObject | undefined => {
    const hits = existing.filter((o) => o.id === handle || (handle.length >= 4 && o.id.startsWith(handle)));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const rows = script.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  for (const row of rows.slice(0, BOARD_SCRIPT_MAX)) {
    let m: RegExpExecArray | null;
    if ((m = /^(note|box|oval|diamond|text|page)\s+([\w-]+)\s*:\s*(.+)$/.exec(row))) {
      const [, kind, name, rest] = m as unknown as [string, string, string, string];
      if (nodes.has(name)) { plan.errors.push(`${row} — name “${name}” is used twice`); continue; }
      const text = rest.replace(/\\n/g, "\n").trim();
      if (kind === "page") nodes.set(name, { name, kind: "page", text: "", ref: text, ...SIZES.page });
      else if (kind === "note") nodes.set(name, { name, kind: "note", text, w: SIZES.note.w, h: Math.max(SIZES.note.h, 28 + Math.ceil(text.length / 16) * 21) });
      else if (kind === "text") nodes.set(name, { name, kind: "text", text, w: SIZES.text.w, h: Math.max(1, Math.ceil(text.length / 38)) * 26 });
      else nodes.set(name, { name, kind: "shape", shape: kind === "box" ? "rect" : kind, text, w: SIZES.shape.w, h: Math.max(SIZES.shape.h, 32 + Math.ceil(text.length / 20) * 20) });
    } else if ((m = /^([\w-]+)\s*->\s*([\w-]+)\s*(?::\s*(.+))?$/.exec(row))) {
      edges.push({ from: m[1]!, to: m[2]!, ...(m[3] ? { label: m[3].trim() } : {}) });
    } else if ((m = /^frame\s+([\w-]+)\s*:\s*(.*?)\s*\{([^}]*)\}$/.exec(row))) {
      frames.push({ name: m[1]!, title: m[2]! || "Frame", members: m[3]!.split(/[\s,]+/).filter(Boolean) });
    } else if ((m = /^set\s+([\w-]+)\s*:\s*(.*)$/.exec(row))) {
      const o = find(m[1]!);
      if (!o) plan.errors.push(`${row} — no single object matches “${m[1]}”`);
      else plan.patch.set(o.id, { [isShape(o) ? "text" : "label"]: m[2]!.replace(/\\n/g, "\n") || undefined });
    } else if ((m = /^del\s+([\w-]+)$/.exec(row))) {
      const o = find(m[1]!);
      if (!o) plan.errors.push(`${row} — no single object matches “${m[1]}”`); else plan.remove.push(o.id);
    } else plan.errors.push(`${row} — not understood`);
  }
  if (rows.length > BOARD_SCRIPT_MAX) plan.errors.push(`only the first ${BOARD_SCRIPT_MAX} lines were used`);

  // Spalten: längster Weg von einer Quelle (Kreise brechen nach so vielen Schritten ab, wie es Knoten gibt).
  const rank = new Map<string, number>([...nodes.keys()].map((n) => [n, 0]));
  for (let i = 0; i < nodes.size; i++) {
    let moved = false;
    for (const e of edges) {
      if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
      const r = rank.get(e.from)! + 1;
      if (r > rank.get(e.to)! && r < nodes.size) { rank.set(e.to, r); moved = true; }
    }
    if (!moved) break;
  }
  // Ohne jede Verbindung: als Raster statt als eine lange Spalte.
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const loose = [...nodes.keys()].filter((n) => !linked.has(n));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
  const cols = new Map<number, Node[]>();
  for (const n of nodes.values()) if (linked.has(n.name)) { const r = rank.get(n.name)!; cols.set(r, [...(cols.get(r) ?? []), n]); }

  let right = -Infinity, top = Infinity;
  for (const o of existing) if (isShape(o)) { right = Math.max(right, o.x + o.w); top = Math.min(top, o.y); }
  const ox = Number.isFinite(right) ? Math.round(right + 96) : 0, oy = Number.isFinite(top) ? Math.round(top) : 0;
  let z = existing.reduce<string | undefined>((mx, o) => (mx === undefined || o.z > mx ? o.z : mx), undefined);
  const nextZ = () => (z = keyBetween(z, undefined));
  const placed = new Map<string, WBShape>();
  const put = (n: Node, x: number, y: number) => {
    const id = newID();
    const style: Record<string, string | boolean> = n.kind === "note" ? { color: "blue", agent: true } : n.kind === "shape" ? { shape: n.shape ?? "rect", agent: true } : { agent: true };
    const o: WBShape = { id, kind: n.kind, z: nextZ(), x: Math.round(x), y: Math.round(y), w: n.w, h: n.h, rot: 0, style, ...(n.text ? { text: n.text } : {}), ...(n.ref ? { ref: n.ref } : {}) };
    placed.set(n.name, o);
    plan.names.set(n.name, id);
    plan.add.push(o);
  };
  let x = ox, bottom = oy;
  for (const r of [...cols.keys()].sort((a, b) => a - b)) {
    let y = oy;
    const col = cols.get(r)!;
    for (const n of col) { put(n, x, y); y += n.h + GAP_Y; }
    bottom = Math.max(bottom, y);
    x += Math.max(...col.map((n) => n.w)) + GAP_X;
  }
  let gx = ox, gy = cols.size ? bottom + GAP_Y : oy, rowH = 0;
  loose.forEach((name, i) => {
    const n = nodes.get(name)!;
    if (i > 0 && i % perRow === 0) { gx = ox; gy += rowH + GAP_Y; rowH = 0; }
    put(n, gx, gy);
    gx += n.w + GAP_Y;
    rowH = Math.max(rowH, n.h);
  });

  const endOf = (name: string): string | undefined => placed.get(name)?.id ?? (() => { const o = find(name); return o && isShape(o) ? o.id : undefined; })();
  for (const e of edges) {
    const from = endOf(e.from), to = endOf(e.to);
    if (!from || !to || from === to) { plan.errors.push(`${e.from} -> ${e.to} — ${from === to && from ? "connects an object to itself" : "unknown object"}`); continue; }
    const c: WBConnector = { id: newID(), kind: "connector", z: nextZ(), from: { id: from, side: "auto" }, to: { id: to, side: "auto" }, shape: "curved", style: { agent: true }, ...(e.label ? { label: e.label } : {}) };
    plan.add.push(c);
  }
  // Rahmen liegen hinter allem.
  let back = existing.reduce<string | undefined>((mn, o) => (mn === undefined || o.z < mn ? o.z : mn), plan.add[0]?.z);
  for (const f of frames) {
    const members = f.members.map((n) => placed.get(n) ?? find(n)).filter((o): o is WBShape => o !== undefined && isShape(o));
    if (members.length === 0) { plan.errors.push(`frame ${f.name} — none of its members exist`); continue; }
    const x0 = Math.min(...members.map((o) => o.x)), y0 = Math.min(...members.map((o) => o.y));
    const x1 = Math.max(...members.map((o) => o.x + o.w)), y1 = Math.max(...members.map((o) => o.y + o.h));
    back = keyBetween(undefined, back);
    const id = newID();
    plan.names.set(f.name, id);
    plan.add.push({ id, kind: "frame", z: back, x: x0 - FRAME_PAD, y: y0 - FRAME_TOP, w: x1 - x0 + FRAME_PAD * 2, h: y1 - y0 + FRAME_TOP + FRAME_PAD, rot: 0, text: f.title, style: { agent: true } });
  }
  // Mit einem gelöschten Objekt gehen seine Verbindungen.
  if (plan.remove.length) plan.remove.push(...danglingConnectors(existing, new Set(plan.remove)).filter((id) => !plan.remove.includes(id)));
  return plan;
}
