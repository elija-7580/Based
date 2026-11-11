// Hauptthread-Seite des Graph-Layouts: startet den Layout-Worker, hält die zuletzt gemeldeten Positionen zum Zeichnen
// und Treffen. Ohne Worker (Tests, alte Umgebungen) rechnet ForceLayout im Hauptthread mit einem Budget je Frame.
import { ForceLayout, layoutBounds, nodeAtPoint } from "@based/core";

export type LayoutWorkerRequest =
  | { type: "start"; generation: number; ids: string[]; links: [number, number][]; initial?: { ids: string[]; x: Float32Array; y: Float32Array }; alpha?: number; keepKnown?: boolean }
  /** Knoten festhalten und dorthin setzen (Ziehen); `index` −1 lässt los. */
  | { type: "pin"; generation: number; index: number; x: number; y: number };

export type LayoutWorkerEvent = { type: "positions"; generation: number; x: Float32Array; y: Float32Array; settled: boolean; steps: number };

export interface GraphLayout {
  readonly ids: readonly string[];
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly settled: boolean;
  /** Neue Positionen seit dem letzten Zeichnen? (setzt sich beim Lesen zurück) */
  takeChanged(): boolean;
  /** Im Hauptthread-Fallback: im Budget weiterrechnen. Mit Worker: nichts. */
  tick(budgetMs: number): void;
  pin(index: number, x: number, y: number): void;
  bounds(): { minX: number; minY: number; maxX: number; maxY: number };
  nodeAt(px: number, py: number, radius: number): number;
  positions(): { ids: string[]; x: Float32Array; y: Float32Array };
  dispose(): void;
}

let worker: Worker | undefined;
let generation = 0;
const listeners = new Map<number, (e: LayoutWorkerEvent) => void>();

function sharedWorker(): Worker | undefined {
  if (worker) return worker;
  if (typeof Worker === "undefined") return undefined;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module", name: "based-graph-layout" });
    worker.addEventListener("message", (e: MessageEvent<LayoutWorkerEvent>) => listeners.get(e.data.generation)?.(e.data));
    return worker;
  } catch {
    return undefined;
  }
}

// BSD-262: fertige Plätze merken (im Speicher und pro Gerät im localStorage), damit der Graph beim nächsten Öffnen
// sofort dasselbe Bild zeigt. Gemerkt wird je Knoten (nicht je Bild): ein gefilterter Graph oder eine gelöschte Seite
// nimmt den übrigen Knoten ihren Platz nicht weg, und kommt eine Seite dazu, sucht nur sie sich einen Platz.
// „Re-layout“ fängt neu an.
type Positions = { ids: string[]; x: Float32Array; y: Float32Array };
const LAYOUT_KEY = "based.graph.positions";
/** Obergrenze für gemerkte Knoten; darüber zählt nur noch das aktuelle Bild. */
const REMEMBER_MAX = 60_000;
let remembered: Map<string, { x: number; y: number }> | undefined;

function loadRemembered(): Map<string, { x: number; y: number }> {
  if (remembered) return remembered;
  const map = new Map<string, { x: number; y: number }>();
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    const v = raw ? (JSON.parse(raw) as { ids?: unknown; x?: unknown; y?: unknown }) : undefined;
    if (v && Array.isArray(v.ids) && Array.isArray(v.x) && Array.isArray(v.y) && v.x.length === v.ids.length && v.y.length === v.ids.length) {
      for (let i = 0; i < v.ids.length; i++) {
        const x = Number(v.x[i]), y = Number(v.y[i]);
        if (Number.isFinite(x) && Number.isFinite(y)) map.set(String(v.ids[i]), { x, y });
      }
    }
  } catch { /* unlesbar: von vorn */ }
  remembered = map;
  return map;
}

export function rememberPositions(p: Positions) {
  let map = loadRemembered();
  if (map.size + p.ids.length > REMEMBER_MAX) map = remembered = new Map();
  for (let i = 0; i < p.ids.length; i++) {
    const x = p.x[i]!, y = p.y[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) map.set(p.ids[i]!, { x, y });
  }
  try {
    const r = (v: number) => Math.round(v * 10) / 10;
    const ids = [...map.keys()];
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({ ids, x: ids.map((id) => r(map.get(id)!.x)), y: ids.map((id) => r(map.get(id)!.y)) }));
  } catch { /* nur für diese Sitzung */ }
}

export function recalledPositions(): Positions | undefined {
  const map = loadRemembered();
  if (map.size === 0) return undefined;
  const ids = [...map.keys()];
  return { ids, x: Float32Array.from(ids, (id) => map.get(id)!.x), y: Float32Array.from(ids, (id) => map.get(id)!.y) };
}

export function forgetPositions() {
  remembered = new Map();
  try { globalThis.localStorage?.removeItem(LAYOUT_KEY); } catch { /* egal */ }
}

/** Kennt das gemerkte Layout jeden Knoten? Dann startet das Layout ruhend (Bild bleibt genau so). */
export const coversAll = (ids: readonly string[], p: Positions | undefined) => {
  if (!p || ids.length === 0) return false;
  const known = new Set(p.ids);
  return ids.every((id) => known.has(id));
};

/** Plätze für `ids`: zuerst aus dem laufenden Layout, sonst aus dem Gemerkten. */
function knownPositions(ids: readonly string[], previous: GraphLayout | undefined): Positions | undefined {
  const map = loadRemembered();
  const prev = previous?.positions();
  const at = prev ? new Map(prev.ids.map((id, i) => [id, i])) : undefined;
  const out: Positions = { ids: [], x: new Float32Array(ids.length), y: new Float32Array(ids.length) };
  for (const id of ids) {
    const j = at?.get(id);
    const p = j !== undefined ? { x: prev!.x[j]!, y: prev!.y[j]! } : map.get(id);
    if (!p) continue;
    out.x[out.ids.length] = p.x;
    out.y[out.ids.length] = p.y;
    out.ids.push(id);
  }
  if (out.ids.length === 0) return undefined;
  return { ids: out.ids, x: out.x.slice(0, out.ids.length), y: out.y.slice(0, out.ids.length) };
}

/**
 * Startet ein Layout für `ids`/`links`. Bekannte Knoten behalten ihren Platz (aus `previous`, sonst aus dem
 * Gemerkten): sind alle bekannt, startet es ruhend; kommen Knoten dazu, bewegen sich nur die neuen. Ein Layout, das
 * noch nicht zur Ruhe gekommen war, rechnet weiter.
 */
export function startLayout(ids: string[], links: [number, number][], previous: GraphLayout | undefined, useWorker = true): GraphLayout {
  const initial = knownPositions(ids, previous);
  const rested = previous ? previous.settled : true;
  const still = rested && coversAll(ids, initial);
  const keepKnown = rested && !still && initial !== undefined;
  const w = useWorker ? sharedWorker() : undefined;
  if (!w) {
    const map = new Map<string, { x: number; y: number }>();
    if (initial) initial.ids.forEach((id, i) => map.set(id, { x: initial.x[i]!, y: initial.y[i]! }));
    const l = new ForceLayout(ids, links, still ? { alpha: 0 } : { keepKnown }, map.size ? map : undefined);
    let changed = true;
    return {
      ids,
      get x() { return l.x; },
      get y() { return l.y; },
      get settled() { return l.settled; },
      takeChanged() { const c = changed; changed = false; return c; },
      tick(budget) { if (!l.settled) { l.run(budget); changed = true; } },
      pin(index, x, y) { l.pinned = index; if (index >= 0) { l.x[index] = x; l.y[index] = y; l.release(); l.reheat(0.25); changed = true; } },
      bounds: () => l.bounds(),
      nodeAt: (px, py, r) => l.nodeAt(px, py, r),
      positions: () => ({ ids: [...ids], x: l.x.slice(), y: l.y.slice() }),
      dispose() {},
    };
  }
  // Der Worker rechnet immer nur das neueste Layout; ältere Zuhörer (auch geparkte, s. dispose) sind damit hinfällig.
  listeners.clear();
  const gen = ++generation;
  // bis die ersten Positionen kommen: bekannte Plätze, sonst Ursprung (der Worker meldet sofort nach dem Start)
  let x: Float32Array = new Float32Array(ids.length), y: Float32Array = new Float32Array(ids.length);
  // gemerktes Layout deckt alles ab: sofort ruhend (kein Neuaufbau, kein Springen)
  let settled = still;
  let changed = true;
  if (initial) {
    const at = new Map(initial.ids.map((id, i) => [id, i]));
    ids.forEach((id, i) => { const j = at.get(id); if (j !== undefined) { x[i] = initial.x[j]!; y[i] = initial.y[j]!; } });
  }
  listeners.set(gen, (e) => {
    x = e.x;
    y = e.y;
    settled = e.settled;
    changed = true;
  });
  const layout: GraphLayout = {
    ids,
    get x() { return x; },
    get y() { return y; },
    get settled() { return settled; },
    takeChanged() { const c = changed; changed = false; return c; },
    tick() {},
    pin(index, px, py) {
      if (index >= 0) { x[index] = px; y[index] = py; changed = true; }
      w.postMessage({ type: "pin", generation: gen, index, x: px, y: py } satisfies LayoutWorkerRequest);
    },
    bounds: () => layoutBounds(x, y, ids.length),
    nodeAt: (px, py, r) => nodeAtPoint(x, y, ids.length, px, py, r),
    positions: () => ({ ids: [...ids], x: x.slice(), y: y.slice() }),
    dispose() {
      // Graph verlassen, bevor das Layout ruht: der Worker rechnet zu Ende, das Ergebnis wird gemerkt – beim
      // nächsten Öffnen steht das fertige Bild da, statt von vorn zu beginnen.
      if (settled || gen !== generation) { listeners.delete(gen); return; }
      listeners.set(gen, (e) => {
        if (!e.settled) return;
        listeners.delete(gen);
        rememberPositions({ ids: [...ids], x: e.x, y: e.y });
      });
    },
  };
  const req: LayoutWorkerRequest = { type: "start", generation: gen, ids, links, ...(initial ? { initial } : {}), ...(still ? { alpha: 0 } : {}), ...(keepKnown ? { keepKnown } : {}) };
  w.postMessage(req);
  return layout;
}
