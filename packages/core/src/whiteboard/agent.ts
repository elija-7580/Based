// BSD-93 (Entscheidung Elija, 17.11.2026): Agenten bedienen das Whiteboard über Text – wenige Token, kein Browser.
// Vorbild ist das Prinzip „Diagramm als Text“ (Mermaid, Excalidraw-Import): der Agent sagt, WAS es gibt und was womit
// zusammenhängt; die Anordnung rechnet Based. Geschrieben wird direkt in die Records des Boards (über MCP, lokal oder
// am Server) – ein offenes Board zeigt es sofort, ein geschlossenes beim Öffnen.
// Elija 18.11.: „Alles, was der Mensch kann, muss auch der Agent können – extrem effizient und verlässlich.“ Darum
// kennt das Skript auch Farben, feste Stellen und Größen, Drehen, Feststecken, Ebenen, freies Zeichnen (SVG-Pfad),
// Bilder und Dateien sowie den Hintergrund. Was nicht geht, steht mit Grund in `errors`; der Rest gilt trotzdem.
//
// Lesen – `boardOutline`: eine Zeile je Objekt (Kennung, Art, Text, Stelle, Größe, Stil), Verbindungen als Pfeile.
// Schreiben – `planBoardScript`: eine Anweisung je Zeile, `BOARD_SCRIPT_HELP` beschreibt sie für Agenten.
import { keyBetween } from "../sortkeys.js";
import { duplicateObjects } from "./geometry.js";
import { danglingConnectors, type ConnectorShape, type WBConnector, type WBObject, type WBShape, type WBStyleValue } from "./model.js";
import { encodeInk, decodeInk } from "./ink.js";
import { inkObjectGeometry } from "./stroke.js";
import { PathError, pathToStrokes, type PathPoint } from "./path.js";
import { boardFileParts, type BoardFileInfo } from "./placefile.js";
import { BOARD_FILL_COLORS, BOARD_HIGHLIGHT_COLORS, BOARD_HIGHLIGHT_WIDTHS, BOARD_PEN_WIDTHS, BOARD_STROKE_COLORS, BOARD_WIDTH_NAMES } from "./style.js";
import type { BoardBackground } from "./records.js";

const isShape = (o: WBObject): o is WBShape => o.kind !== "connector";
const oneLine = (s: string, max = 80) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

/** Kurzbeschreibung des Skripts für Agenten (Werkzeugbeschreibung von draw_board, MCP und Baseds eigene Agenten). */
export const BOARD_SCRIPT_HELP = [
  "One statement per line. Create: note a: text | box a: text | oval a: text | diamond a: text | text a: text | page a: <page id> | image a: <file ref> | file a: <file ref> | ink a: <SVG path d or x,y x,y …>",
  "Connect: a -> b: optional label (a, b: names from this script or handles from read_board). Group: frame f: Title { a b c }",
  "Change: set <handle>: new text | set <handle> {attrs} | del <handle> | background dots|lines|grid|plain",
  "Copy: copy <handle> [<handle> …] as c {at=x,y from=<board id>} – copies objects (a frame with what is inside, lines between copied objects too); without at= offset by 16 px, from another board beside what is there.",
  "Attributes go last in braces, on create, set, -> and frame lines: {color=green fill=blue at=120,40 size=200x100 rot=15 pin=true z=front}",
  `color: ${BOARD_STROKE_COLORS.join(" ")} (text, shape border, line, pen); on notes and frames a fill: ${BOARD_FILL_COLORS.join(" ")}; highlighter: ${BOARD_HIGHLIGHT_COLORS.join(" ")}. fill= (shapes): fill colors.`,
  "at=x,y is the top-left corner in board px (read_board shows @x,y and WxH); without it Based lays things out beside what is there. z=front|back. shape=rect|oval|diamond. line=curved|straight|elbow (on ->). full=true shows a whole page.",
  "ink draws freehand like the pen: {tool=pen|highlighter width=thin|medium|thick|<px> color=…}. Path coordinates are relative to at= (at=0,0 → board coordinates); every M starts a new stroke. Supports M L H V C S Q T A Z.",
  "image/file take a ref from list_files or upload_file; a PDF becomes one object per page ({page=N} for one page).",
  "Text in notes, shapes and text objects is Markdown (# heading, **bold**, *italic*, `code`, - list, - [ ] task, > quote). Write line breaks as \\n.",
].join("\n");

/** Kürzeste eindeutige Kennung je Objekt (mindestens 4 Zeichen vom Anfang der ID). */
export function boardHandles(objs: readonly WBObject[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = objs.map((o) => o.id).sort();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const prefix = (o: string | undefined) => { if (!o) return 0; let n = 0; while (n < id.length && n < o.length && id[n] === o[n]) n += 1; return n; };
    // Nachbarn in sortierter Reihenfolge haben die längsten gemeinsamen Anfänge.
    const n = Math.max(4, prefix(ids[i - 1]) + 1, prefix(ids[i + 1]) + 1);
    out.set(id, id.slice(0, Math.min(n, id.length)));
  }
  return out;
}

/** Ink-Striche, die einzeln im Umriss stehen; darüber nur noch als Zahl. */
export const OUTLINE_INK_MAX = 80;

function styleNote(o: WBShape): string {
  const s = o.style ?? {};
  const parts: string[] = [];
  if (o.kind === "ink") {
    if (s.tool === "hl") parts.push("tool=highlighter");
    if (s.color !== undefined && s.color !== "ink") parts.push(`color=${String(s.color)}`);
  } else if (o.kind === "note") { if (s.color !== undefined && s.color !== "blue") parts.push(`color=${String(s.color)}`); }
  else if (s.color !== undefined) parts.push(`color=${String(s.color)}`);
  if (o.kind === "shape" && s.fill !== undefined) parts.push(`fill=${String(s.fill)}`);
  if (o.rot) parts.push(`rot=${Math.round(o.rot)}`);
  if (s.pin === true) parts.push("pin=true");
  if (o.kind === "page" && s.full === true) parts.push("full=true");
  if (s.agent === true) parts.push("agent");
  return parts.length ? ` {${parts.join(" ")}}` : "";
}

/** Das Board als knapper Text für einen Agenten. `titles`: Seitentitel für Seitenkarten. */
export function boardOutline(objs: readonly WBObject[], titles: (pageID: string) => string | undefined = () => undefined, background?: BoardBackground): string {
  if (objs.length === 0) return background && background !== "dots" ? `(empty board, background ${background})` : "(empty board)";
  const h = boardHandles(objs);
  const lines: string[] = [];
  if (background && background !== "dots") lines.push(`background ${background}`);
  let ink = 0;
  const shapes = objs.filter(isShape).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of shapes) {
    const at = `@${Math.round(o.x)},${Math.round(o.y)} ${Math.round(o.w)}x${Math.round(o.h)}`;
    const id = h.get(o.id)!;
    if (o.kind === "ink") {
      ink += 1;
      if (ink <= OUTLINE_INK_MAX) lines.push(`${id} ink ${at}${styleNote(o)}`);
      continue;
    }
    if (o.kind === "page") lines.push(`${id} page ${o.ref ?? "?"} "${oneLine(titles(o.ref ?? "") ?? o.text ?? "")}" ${at}${styleNote(o)}`);
    else if (o.kind === "image" || o.kind === "file") {
      const page = o.style?.view === "pdf" ? ` p${String(o.style.page)}` : "";
      lines.push(`${id} ${o.kind} "${oneLine(String(o.style?.name ?? ""))}"${page} ${o.ref ?? ""} ${at}${styleNote(o)}`.replace("  ", " "));
    } else lines.push(`${id} ${o.kind === "shape" ? String(o.style?.shape ?? "rect").replace("rect", "box") : o.kind} "${oneLine(o.text ?? "")}" ${at}${styleNote(o)}`);
  }
  if (ink > OUTLINE_INK_MAX) lines.push(`(+${ink - OUTLINE_INK_MAX} more ink strokes)`);
  for (const o of objs) if (!isShape(o)) {
    const extra = [o.shape !== "curved" ? `line=${o.shape}` : "", o.style?.color !== undefined ? `color=${String(o.style.color)}` : ""].filter(Boolean).join(" ");
    lines.push(`${h.get(o.from.id) ?? "?"} -> ${h.get(o.to.id) ?? "?"}${o.label ? `: ${oneLine(o.label)}` : ""}${extra ? ` {${extra}}` : ""} [${h.get(o.id)}]`);
  }
  return lines.join("\n");
}

export interface BoardPlan {
  add: WBObject[];
  patch: Map<string, Record<string, unknown>>;
  remove: string[];
  /** Name im Skript → ID des neuen Objekts (bei mehreren Objekten je Name: das erste). */
  names: Map<string, string>;
  /** Neuer Hintergrund des Boards. */
  background?: BoardBackground;
  /** Zeilen, die nicht ausgeführt wurden, mit Grund (der Rest gilt trotzdem). */
  errors: string[];
}

export interface BoardScriptOptions {
  /** Was über eine Datei bekannt ist (Name, Art, Maße, PDF-Seiten); `undefined`: keine solche Datei. */
  files?: (ref: string) => BoardFileInfo | undefined;
  /** Objekte eines anderen Boards (für `copy … {from=…}`); `undefined`: kein Board, das der Agent sehen darf. */
  boardObjects?: (boardID: string) => readonly WBObject[] | undefined;
}

const SIZES = { note: { w: 168, h: 150 }, shape: { w: 180, h: 72 }, text: { w: 320, h: 26 }, page: { w: 240, h: 72 } } as const;
const PAGE_FULL = { w: 520, h: 620 };
const GAP_X = 88, GAP_Y = 32, FRAME_PAD = 24, FRAME_TOP = 52;
/** Höchstens so viele Anweisungen je Aufruf. */
export const BOARD_SCRIPT_MAX = 400;
const BACKGROUNDS = new Set<BoardBackground>(["dots", "lines", "grid", "plain"]);

/** Ein Objekt, das das Skript anlegt, noch ohne Stelle: Teile relativ zu (0, 0) des Knotens. */
interface Node {
  name: string;
  w: number;
  h: number;
  at?: { x: number; y: number };
  parts: Omit<WBShape, "id" | "z">[];
  z?: "front" | "back";
}

type Attrs = Map<string, string>;
const ATTRS = /\s*\{((?:\s*[a-z]+=[^\s{}=]+)+)\s*\}\s*$/;

/** Attribute am Zeilenende abtrennen: `text {a=1 b=2}` → Text und Attribute. */
function splitAttrs(row: string): { body: string; attrs: Attrs } {
  const m = ATTRS.exec(row);
  if (!m) return { body: row, attrs: new Map() };
  const attrs: Attrs = new Map();
  for (const kv of m[1]!.trim().split(/\s+/)) { const i = kv.indexOf("="); attrs.set(kv.slice(0, i), kv.slice(i + 1)); }
  return { body: row.slice(0, m.index).trimEnd(), attrs };
}

const FILE_REF = /^(?:based-asset:)?([0-9a-f]{64})$/i;
const normalRef = (ref: string) => { const m = FILE_REF.exec(ref.trim()); return m ? `based-asset:${m[1]!.toLowerCase()}` : ref.trim(); };

/**
 * Ein Skript in Änderungen übersetzen (ohne sie auszuführen). Neue Objekte ohne `at=` werden in Spalten entlang der
 * Verbindungen angeordnet (Quelle links, Ziel rechts) und rechts neben den vorhandenen Inhalt gesetzt. Alles Neue
 * trägt `style.agent` – die Fläche zeigt es mit dem Marker-Strich.
 */
export function planBoardScript(script: string, existing: readonly WBObject[], newID: () => string, opts: BoardScriptOptions = {}): BoardPlan {
  const plan: BoardPlan = { add: [], patch: new Map(), remove: [], names: new Map(), errors: [] };
  const nodes = new Map<string, Node>();
  const edges: { from: string; to: string; label?: string; attrs: Attrs; row: string }[] = [];
  const frames: { name: string; title: string; members: string[]; attrs: Attrs; row: string }[] = [];
  const zMoves: { id: string; to: "front" | "back" }[] = [];
  const copies: { name: string; handles: string[]; attrs: Attrs; row: string }[] = [];
  const byID = new Map(existing.map((o) => [o.id, o]));
  const find = (handle: string): WBObject | undefined => {
    const exact = byID.get(handle);
    if (exact) return exact;
    const hits = handle.length >= 4 ? existing.filter((o) => o.id.startsWith(handle)) : [];
    return hits.length === 1 ? hits[0] : undefined;
  };
  const rows = script.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  for (const raw of rows.slice(0, BOARD_SCRIPT_MAX)) {
    const { body: row, attrs } = splitAttrs(raw);
    const bad = (why: string) => plan.errors.push(`${raw} — ${why}`);
    let m: RegExpExecArray | null;
    try {
      if ((m = /^(note|box|oval|diamond|text|page|image|file|ink)\s+([\w.-]+)\s*:\s*([\s\S]+)$/.exec(row))) {
        const [, kind, name, rest] = m as unknown as [string, string, string, string];
        if (nodes.has(name)) { bad(`name “${name}” is used twice`); continue; }
        const node = makeNode(kind, name, rest, attrs, opts);
        nodes.set(name, node);
      } else if ((m = /^([\w.-]+)\s*->\s*([\w.-]+)\s*(?::\s*(.+))?$/.exec(row))) {
        edges.push({ from: m[1]!, to: m[2]!, ...(m[3] ? { label: m[3].trim() } : {}), attrs, row: raw });
      } else if ((m = /^frame\s+([\w.-]+)\s*:\s*(.*?)\s*\{([^}=]*)\}$/.exec(row))) {
        frames.push({ name: m[1]!, title: m[2]! || "Frame", members: m[3]!.split(/[\s,]+/).filter(Boolean), attrs, row: raw });
      } else if ((m = /^set\s+([\w.-]+)\s*(?::\s*([\s\S]*))?$/.exec(row))) {
        const o = find(m[1]!);
        if (!o) { bad(`no single object matches “${m[1]}”`); continue; }
        const fields: Record<string, unknown> = { ...(plan.patch.get(o.id) ?? {}) };
        if (m[2] !== undefined) fields[isShape(o) ? "text" : "label"] = m[2].replace(/\\n/g, "\n") || undefined;
        const z = applyAttrs(o, attrs, fields);
        if (z) zMoves.push({ id: o.id, to: z });
        if (Object.keys(fields).length) plan.patch.set(o.id, fields);
      } else if ((m = /^del\s+([\w.-]+)$/.exec(row))) {
        const o = find(m[1]!);
        if (!o) bad(`no single object matches “${m[1]}”`); else plan.remove.push(o.id);
      } else if ((m = /^copy\s+([\w.\- ]+?)\s+as\s+([\w.-]+)$/.exec(row))) {
        if (nodes.has(m[2]!) || copies.some((c) => c.name === m![2])) { bad(`name “${m[2]}” is used twice`); continue; }
        for (const k of attrs.keys()) if (k !== "at" && k !== "from") throw new ScriptError("copy takes at= and from= only");
        copies.push({ name: m[2]!, handles: m[1]!.split(/\s+/).filter(Boolean), attrs, row: raw });
      } else if ((m = /^background\s+(\w+)$/.exec(row))) {
        if (!BACKGROUNDS.has(m[1] as BoardBackground)) bad("background is dots, lines, grid or plain");
        else plan.background = m[1] as BoardBackground;
      } else bad("not understood");
    } catch (e) {
      bad(e instanceof ScriptError || e instanceof PathError ? e.message : "not understood");
    }
  }
  if (rows.length > BOARD_SCRIPT_MAX) plan.errors.push(`only the first ${BOARD_SCRIPT_MAX} lines were used`);

  // Spalten: längster Weg von einer Quelle (Kreise brechen nach so vielen Schritten ab, wie es Knoten gibt).
  const auto = [...nodes.values()].filter((n) => !n.at);
  const autoNames = new Set(auto.map((n) => n.name));
  const rank = new Map<string, number>(auto.map((n) => [n.name, 0]));
  for (let i = 0; i < auto.length; i++) {
    let moved = false;
    for (const e of edges) {
      if (!autoNames.has(e.from) || !autoNames.has(e.to) || e.from === e.to) continue;
      const r = rank.get(e.from)! + 1;
      if (r > rank.get(e.to)! && r < auto.length) { rank.set(e.to, r); moved = true; }
    }
    if (!moved) break;
  }
  // Ohne jede Verbindung: als Raster statt als eine lange Spalte.
  const linked = new Set(edges.filter((e) => autoNames.has(e.from) && autoNames.has(e.to)).flatMap((e) => [e.from, e.to]));
  const loose = auto.filter((n) => !linked.has(n.name));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
  const cols = new Map<number, Node[]>();
  for (const n of auto) if (linked.has(n.name)) { const r = rank.get(n.name)!; cols.set(r, [...(cols.get(r) ?? []), n]); }

  let right = -Infinity, top = Infinity;
  for (const o of existing) if (isShape(o)) { right = Math.max(right, o.x + o.w); top = Math.min(top, o.y); }
  for (const n of nodes.values()) if (n.at) { right = Math.max(right, n.at.x + n.w); top = Math.min(top, n.at.y); }
  const ox = Number.isFinite(right) ? Math.round(right + 96) : 0, oy = Number.isFinite(top) ? Math.round(top) : 0;
  let z = existing.reduce<string | undefined>((mx, o) => (mx === undefined || o.z > mx ? o.z : mx), undefined);
  const nextZ = () => (z = keyBetween(z, undefined));
  // Ganz nach hinten: hinter alles Vorhandene und alles, was dieses Skript schon angelegt hat.
  const minZ = (list: readonly WBObject[], from: string | undefined) => list.reduce<string | undefined>((mn, o) => (mn === undefined || o.z < mn ? o.z : mn), from);
  const backZ = () => keyBetween(undefined, minZ(plan.add, minZ(existing, undefined)));
  const placed = new Map<string, WBShape>();
  const put = (n: Node, x: number, y: number) => {
    n.parts.forEach((p, i) => {
      const id = newID();
      const o: WBShape = { ...p, id, z: n.z === "back" ? backZ() : nextZ(), x: Math.round(x + p.x), y: Math.round(y + p.y) };
      if (i === 0) { placed.set(n.name, o); plan.names.set(n.name, id); }
      plan.add.push(o);
    });
  };
  for (const n of nodes.values()) if (n.at) put(n, n.at.x, n.at.y);
  let x = ox, bottom = oy;
  for (const r of [...cols.keys()].sort((a, b) => a - b)) {
    let y = oy;
    const col = cols.get(r)!;
    for (const n of col) { put(n, x, y); y += n.h + GAP_Y; }
    bottom = Math.max(bottom, y);
    x += Math.max(...col.map((n) => n.w)) + GAP_X;
  }
  let gx = ox, gy = cols.size ? bottom + GAP_Y : oy, rowH = 0;
  loose.forEach((n, i) => {
    if (i > 0 && i % perRow === 0) { gx = ox; gy += rowH + GAP_Y; rowH = 0; }
    put(n, gx, gy);
    gx += n.w + GAP_Y;
    rowH = Math.max(rowH, n.h);
  });

  // Kopien: wie ⌘D (16 px versetzt) oder an at=; von einem anderen Board neben das Vorhandene.
  for (const c of copies) {
    try {
      const fromID = c.attrs.get("from");
      const source = fromID !== undefined ? opts.boardObjects?.(fromID) : existing;
      if (!source) throw new ScriptError(`no board ${fromID ?? ""} to copy from`);
      const pick = (h: string) => { const hit = source.filter((o) => o.id === h || (h.length >= 4 && o.id.startsWith(h))); return hit.length === 1 ? hit[0] : undefined; };
      const ids = new Set<string>();
      for (const h of c.handles) { const o = pick(h); if (!o) throw new ScriptError(`no single object matches “${h}”`); ids.add(o.id); }
      // Ein Rahmen nimmt mit, was ganz in ihm liegt (wie beim Verschieben).
      for (const id of [...ids]) {
        const f = source.find((o) => o.id === id);
        if (f && isShape(f) && f.kind === "frame") for (const o of source) if (isShape(o) && o.kind !== "frame" && inside(o, f)) ids.add(o.id);
      }
      // Verbindungen zwischen kopierten Objekten kommen mit.
      for (const o of source) if (!isShape(o) && ids.has(o.from.id) && ids.has(o.to.id)) ids.add(o.id);
      const shapes = source.filter((o): o is WBShape => isShape(o) && ids.has(o.id));
      if (shapes.length === 0) throw new ScriptError("nothing to copy");
      const x0 = Math.min(...shapes.map((o) => o.x)), y0 = Math.min(...shapes.map((o) => o.y));
      const at = c.attrs.has("at") ? pair(c.attrs.get("at")!, ",", "at") : fromID !== undefined ? [ox, gy + (loose.length ? GAP_Y : 0)] : undefined;
      const offset = at ? { x: Math.round(at[0]! - x0), y: Math.round(at[1]! - y0) } : { x: 16, y: 16 };
      const made = duplicateObjects(source, ids, newID, offset).map((o) => ({ ...o, z: nextZ(), style: { ...(o.style ?? {}), agent: true } }) as WBObject);
      plan.add.push(...made);
      const first = made.find(isShape);
      if (first) { placed.set(c.name, first); plan.names.set(c.name, first.id); }
    } catch (err) { plan.errors.push(`${c.row} — ${err instanceof Error ? err.message : "not understood"}`); }
  }

  const endOf = (name: string): string | undefined => placed.get(name)?.id ?? (() => { const o = find(name); return o && isShape(o) ? o.id : undefined; })();
  for (const e of edges) {
    const from = endOf(e.from), to = endOf(e.to);
    if (!from || !to || from === to) { plan.errors.push(`${e.row} — ${from === to && from ? "connects an object to itself" : "unknown object"}`); continue; }
    try {
      const style: Record<string, WBStyleValue> = { agent: true };
      const color = e.attrs.get("color");
      if (color !== undefined) style.color = oneOf(color, BOARD_STROKE_COLORS, "color");
      const line = e.attrs.get("line");
      const shape: ConnectorShape = line === undefined ? "curved" : (oneOf(line, ["curved", "straight", "elbow"] as const, "line"));
      const c: WBConnector = { id: newID(), kind: "connector", z: nextZ(), from: { id: from, side: "auto" }, to: { id: to, side: "auto" }, shape, style, ...(e.label ? { label: e.label } : {}) };
      plan.add.push(c);
    } catch (err) { plan.errors.push(`${e.row} — ${err instanceof Error ? err.message : "not understood"}`); }
  }
  // Rahmen liegen hinter allem.
  for (const f of frames) {
    const members = f.members.map((n) => placed.get(n) ?? find(n)).filter((o): o is WBShape => o !== undefined && isShape(o));
    if (members.length === 0) { plan.errors.push(`${f.row} — none of its members exist`); continue; }
    const x0 = Math.min(...members.map((o) => o.x)), y0 = Math.min(...members.map((o) => o.y));
    const x1 = Math.max(...members.map((o) => o.x + o.w)), y1 = Math.max(...members.map((o) => o.y + o.h));
    const style: Record<string, WBStyleValue> = { agent: true };
    try {
      const color = f.attrs.get("color") ?? f.attrs.get("fill");
      if (color !== undefined) style.color = oneOf(color, BOARD_FILL_COLORS, "color");
    } catch (err) { plan.errors.push(`${f.row} — ${err instanceof Error ? err.message : ""}`); }
    const id = newID();
    plan.names.set(f.name, id);
    plan.add.push({ id, kind: "frame", z: backZ(), x: x0 - FRAME_PAD, y: y0 - FRAME_TOP, w: x1 - x0 + FRAME_PAD * 2, h: y1 - y0 + FRAME_TOP + FRAME_PAD, rot: 0, text: f.title, style });
  }
  // Ein verschobener Rahmen nimmt mit, was ganz in ihm lag (wie beim Ziehen mit der Hand).
  for (const [id, fields] of [...plan.patch]) {
    const f = byID.get(id);
    if (!f || !isShape(f) || f.kind !== "frame" || (fields.x === undefined && fields.y === undefined)) continue;
    const dx = Number(fields.x ?? f.x) - f.x, dy = Number(fields.y ?? f.y) - f.y;
    if (!dx && !dy) continue;
    for (const o of existing) {
      if (!isShape(o) || o.kind === "frame" || !inside(o, f)) continue;
      const own = plan.patch.get(o.id) ?? {};
      if (own.x !== undefined || own.y !== undefined) continue;
      plan.patch.set(o.id, { ...own, x: o.x + dx, y: o.y + dy });
    }
  }
  // Nach vorn / nach hinten (bestehende Objekte).
  for (const mv of zMoves) {
    const fields = plan.patch.get(mv.id) ?? {};
    fields.z = mv.to === "front" ? nextZ() : backZ();
    plan.patch.set(mv.id, fields);
  }
  // Mit einem gelöschten Objekt gehen seine Verbindungen.
  if (plan.remove.length) plan.remove.push(...danglingConnectors(existing, new Set(plan.remove)).filter((id) => !plan.remove.includes(id)));
  return plan;
}

class ScriptError extends Error {}

const inside = (o: WBShape, f: WBShape) => o.x >= f.x && o.y >= f.y && o.x + o.w <= f.x + f.w && o.y + o.h <= f.y + f.h;

function oneOf<T extends string>(v: string, list: readonly T[], what: string): T {
  if ((list as readonly string[]).includes(v)) return v as T;
  throw new ScriptError(`${what} “${v}” is not one of ${list.join(", ")}`);
}
const num = (v: string, what: string, min = -1e7, max = 1e7): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ScriptError(`${what} “${v}” is not a number in range`);
  return n;
};
const pair = (v: string, sep: string, what: string): [number, number] => {
  const p = v.split(sep);
  if (p.length !== 2) throw new ScriptError(`${what} is written ${what === "size" ? "WxH" : "x,y"}`);
  return [num(p[0]!, what), num(p[1]!, what)];
};
const bool = (v: string, what: string) => { if (v !== "true" && v !== "false") throw new ScriptError(`${what} is true or false`); return v === "true"; };

const KNOWN_ATTRS = new Set(["color", "fill", "at", "size", "rot", "pin", "z", "shape", "line", "tool", "width", "full", "page"]);
function checkAttrs(attrs: Attrs) {
  for (const k of attrs.keys()) if (!KNOWN_ATTRS.has(k)) throw new ScriptError(`unknown attribute “${k}”`);
}

/** Stil und Maße aus den Attributen für ein neues Objekt der Art `kind`. */
function shapeStyle(kind: WBShape["kind"], attrs: Attrs, base: Record<string, WBStyleValue>): Record<string, WBStyleValue> {
  const style: Record<string, WBStyleValue> = { ...base };
  const color = attrs.get("color");
  if (color !== undefined) {
    if (kind === "note" || kind === "frame") style.color = oneOf(color, BOARD_FILL_COLORS, "color");
    else if (kind === "ink" && style.tool === "hl") style.color = oneOf(color, BOARD_HIGHLIGHT_COLORS, "color");
    else if (kind === "text" || kind === "shape" || kind === "ink") style.color = oneOf(color, BOARD_STROKE_COLORS, "color");
    else throw new ScriptError(`a ${kind} has no color`);
  }
  const fill = attrs.get("fill");
  if (fill !== undefined) {
    if (kind === "shape") style.fill = oneOf(fill, BOARD_FILL_COLORS, "fill");
    else if (kind === "note" || kind === "frame") style.color = oneOf(fill, BOARD_FILL_COLORS, "fill");
    else throw new ScriptError(`a ${kind} has no fill`);
  }
  const shape = attrs.get("shape");
  if (shape !== undefined) {
    if (kind !== "shape") throw new ScriptError("shape= is only for shapes");
    style.shape = oneOf(shape, ["rect", "oval", "diamond"] as const, "shape");
  }
  const pin = attrs.get("pin");
  if (pin !== undefined) { if (bool(pin, "pin")) style.pin = true; else delete style.pin; }
  const full = attrs.get("full");
  if (full !== undefined) {
    if (kind !== "page") throw new ScriptError("full= is only for page cards");
    if (bool(full, "full")) style.full = true; else delete style.full;
  }
  return style;
}

function makeNode(kind: string, name: string, rest: string, attrs: Attrs, opts: BoardScriptOptions): Node {
  checkAttrs(attrs);
  const at = attrs.has("at") ? (([x, y]) => ({ x, y }))(pair(attrs.get("at")!, ",", "at")) : undefined;
  const size = attrs.has("size") ? pair(attrs.get("size")!, "x", "size") : undefined;
  if (size && (size[0] < 4 || size[1] < 4 || size[0] > 20000 || size[1] > 20000)) throw new ScriptError("size is between 4 and 20000 px per side");
  const rot = attrs.has("rot") ? num(attrs.get("rot")!, "rot") % 360 : 0;
  const zAttr = attrs.get("z");
  const z = zAttr === undefined ? undefined : oneOf(zAttr, ["front", "back"] as const, "z");
  if (attrs.has("line")) throw new ScriptError("line= is only for connectors (->)");
  const text = rest.replace(/\\n/g, "\n").trim();
  const node = (w: number, h: number, parts: Node["parts"]): Node => ({ name, w, h, parts, ...(at ? { at } : {}), ...(z ? { z } : {}) });
  const one = (k: WBShape["kind"], w: number, h: number, extra: Partial<WBShape>, base: Record<string, WBStyleValue>): Node => {
    const [W, H] = size ?? [w, h];
    return node(W, H, [{ kind: k, x: 0, y: 0, w: W, h: H, rot, style: shapeStyle(k, attrs, { ...base, agent: true }), ...extra }]);
  };
  if (kind !== "ink" && (attrs.has("tool") || attrs.has("width"))) throw new ScriptError("tool= and width= are only for ink");
  if (kind !== "file" && kind !== "image" && attrs.has("page")) throw new ScriptError("page= is only for files");
  switch (kind) {
    case "note": return one("note", SIZES.note.w, Math.max(SIZES.note.h, 28 + Math.ceil(text.length / 16) * 21), { text }, { color: "blue" });
    case "text": return one("text", SIZES.text.w, Math.max(1, text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 38)), 0)) * 26, { text }, {});
    case "box": case "oval": case "diamond":
      return one("shape", SIZES.shape.w, Math.max(SIZES.shape.h, 32 + Math.ceil(text.length / 20) * 20), { text }, { shape: kind === "box" ? "rect" : kind });
    case "page": {
      const full = attrs.get("full") === "true";
      return one("page", full ? PAGE_FULL.w : SIZES.page.w, full ? PAGE_FULL.h : SIZES.page.h, { ref: text }, {});
    }
    case "image": case "file": {
      const ref = normalRef(text);
      const info = opts.files?.(ref);
      if (!info) throw new ScriptError(`no file ${ref} — use list_files or upload_file first`);
      let parts = boardFileParts({ ...info, ref });
      if (kind === "image" && parts[0]!.kind !== "image") throw new ScriptError(`${info.name} is not an image — use file`);
      if (attrs.has("page")) {
        const p = num(attrs.get("page")!, "page", 1, 10000);
        const hit = parts.find((x) => x.style.page === p);
        if (!hit) throw new ScriptError(`${info.name} has no page ${p}`);
        parts = [hit];
      }
      let y = 0;
      const out: Node["parts"] = [];
      for (const p of parts) {
        // size= gilt für ein einzelnes Objekt; ein Bild behält ohne Angabe sein Seitenverhältnis.
        const [W, H] = size && parts.length === 1 ? size : [p.size.w, p.size.h];
        out.push({ kind: p.kind, x: 0, y, w: W, h: H, rot, ref, style: shapeStyle(p.kind, attrs, { ...p.style, agent: true }) });
        y += H + 16;
      }
      return node(Math.max(...out.map((o) => o.w)), y - 16, out);
    }
    case "ink": {
      const tool = attrs.get("tool") === undefined ? "pen" : oneOf(attrs.get("tool")!, ["pen", "highlighter"] as const, "tool");
      const widths = tool === "pen" ? BOARD_PEN_WIDTHS : BOARD_HIGHLIGHT_WIDTHS;
      const wv = attrs.get("width");
      const width = wv === undefined ? widths[1] : (BOARD_WIDTH_NAMES as readonly string[]).includes(wv) ? widths[(BOARD_WIDTH_NAMES as readonly string[]).indexOf(wv)]! : num(wv, "width", 0.5, 64);
      if (size) throw new ScriptError("ink takes its size from the path — scale the coordinates instead");
      const strokes = pathToStrokes(text);
      const base: Record<string, WBStyleValue> = { width, ...(tool === "highlighter" ? { tool: "hl", color: "sky" } : { color: "ink" }) };
      return inkNode(name, strokes, width, shapeStyle("ink", attrs, { ...base, agent: true }), rot, at, z);
    }
  }
  throw new ScriptError("not understood");
}

/** Striche als Knoten: jeder Strich ein Ink-Objekt wie vom Stift (Punkte relativ zu seiner Ecke, Druck 0.5). */
function inkNode(name: string, strokes: PathPoint[][], width: number, style: Record<string, WBStyleValue>, rot: number, at: { x: number; y: number } | undefined, z: "front" | "back" | undefined): Node {
  const geos = strokes.map((s) => inkObjectGeometry(s.map((p) => ({ x: p.x, y: p.y, p: 0.5 })), width)).filter((g): g is NonNullable<typeof g> => g !== undefined);
  if (geos.length === 0) throw new ScriptError("ink has no points");
  const minX = Math.min(...geos.map((g) => g.x)), minY = Math.min(...geos.map((g) => g.y));
  const maxX = Math.max(...geos.map((g) => g.x + g.w)), maxY = Math.max(...geos.map((g) => g.y + g.h));
  // Mit at=: Pfad-Koordinaten gelten ab at (also bleibt der Versatz der Striche erhalten). Ohne: Knoten ab (0, 0).
  const shift = at ? { x: 0, y: 0 } : { x: -minX, y: -minY };
  const parts: Node["parts"] = geos.map((g) => ({
    kind: "ink", x: g.x + shift.x, y: g.y + shift.y, w: g.w, h: g.h, rot, ink: encodeInk(g.points), style: { ...style, bw: g.w, bh: g.h },
  }));
  return { name, w: maxX - minX, h: maxY - minY, parts, ...(at ? { at } : {}), ...(z ? { z } : {}) };
}

/** `set <handle> {…}`: Felder für ein bestehendes Objekt; gibt einen Ebenenwechsel zurück (z rechnet der Plan). */
function applyAttrs(o: WBObject, attrs: Attrs, fields: Record<string, unknown>): "front" | "back" | undefined {
  if (attrs.size === 0) return undefined;
  checkAttrs(attrs);
  const style: Record<string, WBStyleValue> = { ...((fields.style as Record<string, WBStyleValue> | undefined) ?? o.style ?? {}) };
  if (!isShape(o)) {
    for (const k of attrs.keys()) if (k !== "color" && k !== "line" && k !== "z") throw new ScriptError(`a connector takes color=, line= and z= only`);
    if (attrs.has("color")) style.color = oneOf(attrs.get("color")!, BOARD_STROKE_COLORS, "color");
    if (attrs.has("line")) fields.shape = oneOf(attrs.get("line")!, ["curved", "straight", "elbow"] as const, "line");
    fields.style = style;
    const z = attrs.get("z");
    return z === undefined ? undefined : oneOf(z, ["front", "back"] as const, "z");
  }
  if (attrs.has("line")) throw new ScriptError("line= is only for connectors");
  if (attrs.has("tool")) throw new ScriptError("tool= cannot change on an existing stroke");
  if (attrs.has("page")) throw new ScriptError("page= cannot change on an existing file");
  Object.assign(style, shapeStyle(o.kind, attrs, style));
  for (const k of ["pin", "full"] as const) if (attrs.get(k) === "false") delete style[k];
  if (o.kind === "ink" && attrs.has("width")) {
    const wv = attrs.get("width")!;
    const widths = style.tool === "hl" ? BOARD_HIGHLIGHT_WIDTHS : BOARD_PEN_WIDTHS;
    style.width = (BOARD_WIDTH_NAMES as readonly string[]).includes(wv) ? widths[(BOARD_WIDTH_NAMES as readonly string[]).indexOf(wv)]! : num(wv, "width", 0.5, 64);
  } else if (attrs.has("width")) throw new ScriptError("width= is only for ink");
  fields.style = style;
  if (attrs.has("at")) { const [x, y] = pair(attrs.get("at")!, ",", "at"); fields.x = Math.round(x); fields.y = Math.round(y); }
  if (attrs.has("size")) {
    const [w, h] = pair(attrs.get("size")!, "x", "size");
    if (w < 4 || h < 4 || w > 20000 || h > 20000) throw new ScriptError("size is between 4 and 20000 px per side");
    fields.w = Math.round(w); fields.h = Math.round(h);
  }
  if (o.kind === "page" && attrs.has("full") && !attrs.has("size")) {
    const full = style.full === true;
    fields.w = full ? PAGE_FULL.w : SIZES.page.w; fields.h = full ? PAGE_FULL.h : SIZES.page.h;
  }
  if (attrs.has("rot")) fields.rot = num(attrs.get("rot")!, "rot") % 360;
  const z = attrs.get("z");
  return z === undefined ? undefined : oneOf(z, ["front", "back"] as const, "z");
}

/** Punkte eines Ink-Objekts (für Tests und Agenten-Werkzeuge). */
export const inkPointsOfObject = (o: WBShape) => (o.ink ? decodeInk(o.ink) : []);
