// Hauptthread-Seite des Graph-Layouts: startet den Layout-Worker, hält die zuletzt gemeldeten Positionen zum Zeichnen
// und Treffen. Ohne Worker (Tests, alte Umgebungen) rechnet ForceLayout im Hauptthread mit einem Budget je Frame.
import { ForceLayout, layoutBounds, nodeAtPoint } from "@based/core";

export type LayoutWorkerRequest =
  | { type: "start"; generation: number; ids: string[]; links: [number, number][]; initial?: { ids: string[]; x: Float32Array; y: Float32Array }; alpha?: number }
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

// BSD-262 Teil 1: das zuletzt fertige Layout merken (im Speicher und pro Gerät im localStorage), damit der Graph beim
// nächsten Öffnen sofort dasselbe Bild zeigt; nur neue Knoten werden eingepasst, „Re-layout“ fängt neu an.
type Positions = { ids: string[]; x: Float32Array; y: Float32Array };
const LAYOUT_KEY = "based.graph.positions";
let remembered: Positions | undefined;

export function rememberPositions(p: Positions) {
  remembered = p;
  try {
    const r = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 10) / 10);
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({ ids: p.ids, x: r(p.x), y: r(p.y) }));
  } catch { /* nur für diese Sitzung */ }
}

export function recalledPositions(): Positions | undefined {
  if (remembered) return remembered;
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { ids?: unknown; x?: unknown; y?: unknown };
    if (!Array.isArray(v.ids) || !Array.isArray(v.x) || !Array.isArray(v.y) || v.x.length !== v.ids.length || v.y.length !== v.ids.length) return undefined;
    remembered = { ids: v.ids.map(String), x: Float32Array.from(v.x as number[]), y: Float32Array.from(v.y as number[]) };
    return remembered;
  } catch {
    return undefined;
  }
}

export function forgetPositions() {
  remembered = undefined;
  try { globalThis.localStorage?.removeItem(LAYOUT_KEY); } catch { /* egal */ }
}

/** Kennt das gemerkte Layout jeden Knoten? Dann startet das Layout ruhend (Bild bleibt genau so). */
export const coversAll = (ids: readonly string[], p: Positions | undefined) => {
  if (!p || ids.length === 0) return false;
  const known = new Set(p.ids);
  return ids.every((id) => known.has(id));
};

/** Startet ein Layout für `ids`/`links`, bekannte Knoten behalten ihren Platz aus `previous` (sonst aus dem gemerkten). */
export function startLayout(ids: string[], links: [number, number][], previous: GraphLayout | undefined, useWorker = true): GraphLayout {
  const initial = previous?.positions() ?? recalledPositions();
  const still = coversAll(ids, initial);
  const w = useWorker ? sharedWorker() : undefined;
  if (!w) {
    const map = new Map<string, { x: number; y: number }>();
    if (initial) initial.ids.forEach((id, i) => map.set(id, { x: initial.x[i]!, y: initial.y[i]! }));
    const l = new ForceLayout(ids, links, still ? { alpha: 0 } : {}, map.size ? map : undefined);
    let changed = true;
    return {
      ids,
      get x() { return l.x; },
      get y() { return l.y; },
      get settled() { return l.settled; },
      takeChanged() { const c = changed; changed = false; return c; },
      tick(budget) { if (!l.settled) { l.run(budget); changed = true; } },
      pin(index, x, y) { l.pinned = index; if (index >= 0) { l.x[index] = x; l.y[index] = y; l.reheat(0.25); changed = true; } },
      bounds: () => l.bounds(),
      nodeAt: (px, py, r) => l.nodeAt(px, py, r),
      positions: () => ({ ids: [...ids], x: l.x.slice(), y: l.y.slice() }),
      dispose() {},
    };
  }
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
    dispose() { listeners.delete(gen); },
  };
  const req: LayoutWorkerRequest = { type: "start", generation: gen, ids, links, ...(initial ? { initial } : {}), ...(still ? { alpha: 0 } : {}) };
  w.postMessage(req);
  return layout;
}
