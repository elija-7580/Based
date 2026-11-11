// Graph auf echten Daten: Knoten = Seiten, Datenbanken und Zeilen, Kanten = Unterseiten, Erwähnungen/Links und
// Relationen. Der Graph wird im Store-Worker gebaut und zugeschnitten (`client.graph(filter)`, Logik in @based/core),
// das Kraft-Layout (ForceLayout aus @based/core) rechnet in einem eigenen Layout-Worker, hier wird nur auf Canvas
// gezeichnet – flüssig auch bei 5.000 Knoten. Klick öffnet die Seite, Überfahren hebt die Nachbarn hervor, die Suche findet Seiten.
// Farben und Schrift kommen zur Laufzeit aus den Design-Tokens (CSS-Variablen), keine Literale.
// Design: Seiten der obersten Ebene gefüllt in Tinte, Seiten darunter als Ringe (docs/design/README.md). Der Marker
// (Agent-Änderungen) bleibt frei, bis Records die Herkunft „Agent“ tragen.
import { graphStep } from "./graphKeys.js";
import { LibraryTabs } from "../components/LibraryTabs.js";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { TextInput } from "@astryxdesign/core/TextInput";
import { GRAPH_EDGE_KINDS, graphAdjacency, type GraphEdgeKind, type GraphFilter, type GraphNode, type PageGraph } from "@based/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons.js";
import { fromSwift, relative } from "../shell/format.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import { forgetPositions, rememberPositions, startLayout, type GraphLayout } from "../worker/layoutClient.js";
import type { GraphResult } from "../worker/protocol.js";
import "./graph.css";

interface Props {
  client: StoreClient;
  state: ShellState;
  onOpenPage: (id: string) => void;
  /** BSD-281: Reiter Pages/Graph. */
  onSwitch?: (to: "library" | "graph" | "meetings") => void;
}

const ALL = "all";
const EDGE_LABEL: Record<GraphEdgeKind, string> = { child: "Sub-pages", mention: "Mentions and links", relation: "Relations" };
const KIND_LABEL: Record<GraphNode["kind"], string> = { page: "Page", database: "Database", row: "Row" };
const FRAME_BUDGET_MS = 7;
const MAX_LABELS = 260;

/** Farben und Schrift aus den Tokens (zur Laufzeit gelesen; ändern sich mit Theme, Stil, Marker). */
interface Paint {
  ink: string; ink2: string; muted: string; line: string; bg: string; surface: string; selected: string;
  font: string; fontStrong: string; labelSize: number;
}
function readPaint(): Paint {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const size = parseFloat(v("--type-meta-size")) || 12;
  const family = v("--font-sans") || "sans-serif";
  return {
    ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted"), line: v("--line"), bg: v("--bg"), surface: v("--surface-soft"), selected: v("--selected"),
    font: `${v("--type-meta-weight") || 500} ${size}px ${family}`, fontStrong: `${v("--weight-heading") || 600} ${size}px ${family}`, labelSize: size,
  };
}

interface View { k: number; x: number; y: number }

/** Alles, was die Zeichenschleife braucht (außerhalb von React, damit Frames nichts neu rendern). */
interface Scene {
  graph: PageGraph;
  layout: GraphLayout;
  neighbors: number[][];
  index: Map<string, number>;
  links: [number, number][];
  radius: Float32Array;
  /** Knoten nach Grad absteigend (für Beschriftungen von weit weg). */
  byDegree: number[];
}

function buildScene(graph: PageGraph, previous: GraphLayout | undefined): Scene {
  const adj = graphAdjacency(graph);
  const layout = startLayout(graph.nodes.map((n) => n.id), adj.links, previous);
  const radius = new Float32Array(graph.nodes.length);
  graph.nodes.forEach((n, i) => {
    const deg = adj.neighbors[i]!.length;
    const base = n.kind === "row" ? 2.6 : 3.6;
    radius[i] = Math.min(13, base + Math.sqrt(deg) * 1.5 + (n.top ? 1.4 : 0));
  });
  const byDegree = graph.nodes.map((_, i) => i).sort((a, b) => adj.neighbors[b]!.length - adj.neighbors[a]!.length || a - b);
  return { graph, layout, neighbors: adj.neighbors, index: adj.index, links: adj.links, radius, byDegree };
}

export function Graph({ client, state, onOpenPage, onSwitch }: Props) {
  const [result, setResult] = useState<GraphResult | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [section, setSection] = useState(ALL);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [kinds, setKinds] = useState<readonly GraphEdgeKind[]>(GRAPH_EDGE_KINDS);
  const [focus, setFocus] = useState<string | undefined>();
  const [depth, setDepth] = useState(1);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | undefined>();
  const [hovered, setHovered] = useState<string | undefined>();
  const [settled, setSettled] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | undefined>(undefined);
  const view = useRef<View>({ k: 1, x: 0, y: 0 });
  const autoFit = useRef(true);
  const dirty = useRef(true);
  const paint = useRef<Paint | undefined>(undefined);
  const hover = useRef(-1);
  const live = useRef({ selected: undefined as string | undefined, matches: new Set<number>(), query: "" });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const settledRef = useRef(false);
  /** Messwerte der letzten Frames (ms) für Tests und Diagnose. */
  const stats = useRef({ frames: 0, layoutMs: 0, drawMs: 0, maxFrameMs: 0 });

  const sections = state.outline?.sections ?? [];
  const activeSection = section !== ALL && sections.some((s) => s.id === section) ? section : ALL;
  const filter: GraphFilter = useMemo(() => {
    const f: GraphFilter = { connectedOnly, kinds: [...kinds] };
    if (activeSection !== ALL) f.section = activeSection;
    if (focus) { f.focus = focus; f.depth = depth; }
    return f;
  }, [connectedOnly, kinds, activeSection, focus, depth]);

  // Graph aus dem Worker; bei Änderungen im Workspace nach kurzer Pause neu (Tippen ändert Titel bei jedem Zeichen).
  const first = useRef(true);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      client.graph(filter).then((r) => {
        if (!alive) return;
        setFailed(undefined);
        setResult(r);
      }, (e: Error) => alive && setFailed(e.message));
    }, first.current ? 0 : 350);
    first.current = false;
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, filter, state.outline, state.titles]);

  // Neuer Graph: Layout mit den bisherigen Plätzen fortsetzen.
  useEffect(() => {
    if (!result) return;
    const prev = scene.current?.layout;
    scene.current = buildScene(result.graph, prev);
    prev?.dispose();
    hover.current = -1;
    setHovered(undefined);
    settledRef.current = scene.current.layout.settled;
    setSettled(settledRef.current);
    dirty.current = true;
  }, [result]);

  const graph = result?.graph;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!graph || !q) return [];
    return graph.nodes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 200);
  }, [graph, query]);

  useEffect(() => {
    const s = scene.current;
    live.current = { selected, query: query.trim(), matches: new Set(matches.map((m) => s?.index.get(m.id) ?? -1)) };
    dirty.current = true;
  }, [selected, matches, query, result]);

  const fit = useCallback(() => {
    const s = scene.current;
    const { w, h } = size.current;
    if (!s || w === 0 || h === 0) return;
    const b = s.layout.bounds();
    const pad = 48;
    const gw = Math.max(1, b.maxX - b.minX), gh = Math.max(1, b.maxY - b.minY);
    const k = Math.min(2.2, Math.max(0.02, Math.min((w - pad * 2) / gw, (h - pad * 2) / gh)));
    view.current = { k, x: w / 2 - ((b.minX + b.maxX) / 2) * k, y: h / 2 - ((b.minY + b.maxY) / 2) * k };
    dirty.current = true;
  }, []);

  const centerOn = useCallback((id: string) => {
    const s = scene.current;
    const i = s?.index.get(id);
    if (!s || i === undefined) return;
    const { w, h } = size.current;
    const k = Math.max(view.current.k, 1.1);
    view.current = { k, x: w / 2 - s.layout.x[i]! * k, y: h / 2 - s.layout.y[i]! * k };
    autoFit.current = false;
    dirty.current = true;
  }, []);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    const { w, h } = size.current;
    const px = cx ?? w / 2, py = cy ?? h / 2;
    const v = view.current;
    const k = Math.min(6, Math.max(0.02, v.k * factor));
    view.current = { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    autoFit.current = false;
    dirty.current = true;
  }, []);

  // BSD-238 Teil 3: Tastatur auf der Fläche – Pfeile wandern zwischen Knoten, Enter öffnet, +/−/0 zoomen, Esc hebt auf.
  const onCanvasKey = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const s = scene.current;
    const dir = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : undefined;
    if (dir && s && s.graph.nodes.length) {
      e.preventDefault();
      const cur = selected !== undefined ? s.index.get(selected) : undefined;
      const next = cur === undefined ? (s.byDegree[0] ?? 0) : graphStep(s.layout.x, s.layout.y, cur, dir);
      if (next < 0) return;
      const id = s.graph.nodes[next]!.id;
      setSelected(id);
      centerOn(id);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      onOpenPage(selected);
    } else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.4); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.4); }
    else if (e.key === "0") { e.preventDefault(); autoFit.current = true; fit(); }
    else if (e.key === "Escape" && selected) { e.preventDefault(); setSelected(undefined); }
  };

  // Zeichenschleife: Layout im Budget weiterrechnen, nur zeichnen, wenn sich etwas geändert hat.
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint.current = readPaint();
    const themeWatch = new MutationObserver(() => {
      paint.current = readPaint();
      dirty.current = true;
    });
    themeWatch.observe(document.documentElement, { attributes: true });
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (autoFit.current) fit();
      dirty.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const s = scene.current;
      if (!s) return;
      const t0 = performance.now();
      s.layout.tick(FRAME_BUDGET_MS);
      if (s.layout.takeChanged()) {
        if (autoFit.current) fit();
        dirty.current = true;
      }
      const t1 = performance.now();
      if (s.layout.settled !== settledRef.current) {
        settledRef.current = s.layout.settled;
        setSettled(settledRef.current);
        // BSD-262: fertiges Layout merken, damit das nächste Öffnen sofort dasselbe Bild zeigt
        if (settledRef.current) rememberPositions(s.layout.positions());
      }
      if (!dirty.current) return;
      dirty.current = false;
      draw(ctx, s, view.current, size.current, paint.current!, hover.current, live.current);
      const t2 = performance.now();
      const st = stats.current;
      st.frames += 1;
      st.layoutMs = t1 - t0;
      st.drawMs = t2 - t1;
      st.maxFrameMs = Math.max(st.maxFrameMs, t2 - t0);
    };
    raf = requestAnimationFrame(frame);
    // Für E2E-Tests: Bildschirmposition eines Knotens.
    (canvas as HTMLCanvasElement & { __basedGraph?: unknown }).__basedGraph = {
      stats: () => ({ ...stats.current }),
      position(id: string) {
        const s = scene.current;
        const i = s?.index.get(id);
        if (!s || i === undefined) return undefined;
        const v = view.current;
        return { x: s.layout.x[i]! * v.k + v.x, y: s.layout.y[i]! * v.k + v.y };
      },
      /** Lage im Layout (ohne Ansicht) – BSD-262: bleibt beim erneuten Öffnen gleich. */
      layoutPosition(id: string) {
        const s = scene.current;
        const i = s?.index.get(id);
        return s && i !== undefined ? { x: s.layout.x[i]!, y: s.layout.y[i]! } : undefined;
      },
    };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeWatch.disconnect();
      scene.current?.layout.dispose();
    };
  }, [fit]);

  // Zeiger: Überfahren, Ziehen (Knoten oder Fläche), Klick öffnet.
  const drag = useRef<{ kind: "pan" | "node"; node: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | undefined>(undefined);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pick = (x: number, y: number): number => {
    const s = scene.current;
    if (!s) return -1;
    const v = view.current;
    return s.layout.nodeAt((x - v.x) / v.k, (y - v.y) / v.k, Math.max(9 / v.k, 13));
  };
  const setHover = (i: number) => {
    if (i === hover.current) return;
    hover.current = i;
    setHovered(i >= 0 ? scene.current?.graph.nodes[i]?.id : undefined);
    dirty.current = true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    const i = pick(p.x, p.y);
    drag.current = { kind: i >= 0 ? "node" : "pan", node: i, sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const d = drag.current;
    if (!d) { setHover(pick(p.x, p.y)); return; }
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 4) return;
    d.moved = true;
    autoFit.current = false;
    const s = scene.current;
    if (d.kind === "pan") view.current = { ...view.current, x: d.vx + p.x - d.sx, y: d.vy + p.y - d.sy };
    else if (s) {
      const v = view.current;
      s.layout.pin(d.node, (p.x - v.x) / v.k, (p.y - v.y) / v.k);
    }
    dirty.current = true;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = undefined;
    const s = scene.current;
    if (s && d?.kind === "node" && d.moved) s.layout.pin(-1, 0, 0);
    if (!d || d.moved || d.kind !== "node" || !s) return;
    const node = s.graph.nodes[d.node];
    if (node && e.type === "pointerup") onOpenPage(node.id);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // nicht passiv: das Rad zoomt den Graph statt die Seite zu rollen
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const nodeByID = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const shownID = hovered ?? selected;
  const shown = shownID ? nodeByID.get(shownID) : undefined;
  const degree = useMemo(() => {
    if (!graph || !shown) return { in: 0, out: 0 };
    let i = 0, o = 0;
    for (const e of graph.edges) {
      if (e.t === shown.id) i += 1;
      if (e.s === shown.id) o += 1;
    }
    return { in: i, out: o };
  }, [graph, shown]);
  const focusNode = focus ? nodeByID.get(focus) : undefined;
  const sectionName = (id: string) => sections.find((s) => s.id === id)?.name ?? "Private";
  const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
  const nodes = graph?.nodes.length ?? 0, edges = graph?.edges.length ?? 0;
  const cut = result !== undefined && nodes < result.totalNodes;

  return (
    <div className="gx" data-testid="graph">
      <section className="gx-stage" aria-label="Page graph">
        <div className="gx-title">
          {onSwitch ? <LibraryTabs value="graph" onNavigate={onSwitch} /> : null}
          <h1 className="t-heading">Graph</h1>
          <span className="t-desc" role="status" data-testid="graph-stats">
            {result === undefined ? (failed ? `Couldn't build the graph: ${failed}` : "Building…") : `${count(nodes, "page")} · ${count(edges, "link")}${cut ? ` of ${result.totalNodes.toLocaleString("en-US")}` : ""}`}
          </span>
        </div>
        <div className="gx-zoom" role="group" aria-label="Zoom">
          <IconButton label="Zoom in" size="sm" icon={<Icon name="plus" size={16} />} onClick={() => zoomBy(1.4)} />
          <IconButton label="Zoom out" size="sm" icon={<span className="gx-minus" aria-hidden="true" />} onClick={() => zoomBy(1 / 1.4)} />
          <Button label="Fit" size="sm" onClick={() => { autoFit.current = true; fit(); }} />
          {/* BSD-262: gemerktes Layout verwerfen und neu anordnen */}
          <Button label="Re-layout" size="sm" onClick={() => {
            if (!result) return;
            forgetPositions();
            const prev = scene.current?.layout;
            scene.current = buildScene(result.graph, undefined);
            prev?.dispose();
            settledRef.current = scene.current.layout.settled;
            setSettled(settledRef.current);
            autoFit.current = true;
            dirty.current = true;
          }} />
        </div>
        <div ref={wrapRef} className="gx-canvas">
          <canvas
            ref={canvasRef}
            role="img"
            tabIndex={0}
            aria-label={`Graph of ${count(nodes, "page")} and ${count(edges, "link")}. Arrow keys move between pages, Enter opens, + and − zoom, 0 fits, Esc clears.`}
            onKeyDown={onCanvasKey}
            data-testid="graph-canvas"
            data-nodes={nodes}
            data-edges={edges}
            data-settled={settled ? "" : undefined}
            data-hovered={hovered}
            className={hovered ? "pointing" : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => { if (!drag.current) setHover(-1); }}
          />
        </div>
        {result !== undefined && nodes === 0 ? (
          <p className="gx-empty t-desc">{result.totalNodes === 0 ? "No pages yet." : "No pages match these filters."}</p>
        ) : null}
      </section>

      <aside className="gx-side" aria-label="Graph options">
        <div className="gx-block">
          <TextInput type="search" label="Find a page" placeholder="Find a page" value={query} onChange={setQuery} hasClear onEnter={() => { const m = matches[0]; if (m) { setSelected(m.id); centerOn(m.id); } }} />
          {query.trim() ? (
            matches.length ? (
              <ul className="gx-results" aria-label="Matching pages">
                {matches.slice(0, 8).map((m) => (
                  <li key={m.id}>
                    <button type="button" className={"gx-result" + (selected === m.id ? " active" : "")} onClick={() => { setSelected(m.id); centerOn(m.id); }} onDoubleClick={() => onOpenPage(m.id)}>
                      <span className="gx-result-title">{m.title}</span>
                      <span className="t-desc">{KIND_LABEL[m.kind]}</span>
                    </button>
                  </li>
                ))}
                {matches.length > 8 ? <li className="t-desc gx-more">{matches.length - 8}{matches.length === 200 ? "+" : ""} more highlighted in the graph</li> : null}
              </ul>
            ) : <p className="t-desc">No page with that title in this view.</p>
          ) : null}
        </div>

        {shown ? (
          <div className="gx-block" data-testid="graph-selected">
            <span className="t-meta">{hovered ? "Under the pointer" : "Selected"}</span>
            <h2 className="t-heading gx-name">{shown.icon ? `${shown.icon} ` : ""}{shown.title}</h2>
            <div className="gx-facts t-desc">
              <span>Type</span><span>{KIND_LABEL[shown.kind]}</span>
              <span>In</span><span>{sectionName(shown.section)}</span>
              <span>Links</span><span>{degree.in} in · {degree.out} out</span>
              <span>Edited</span><span>{relative(fromSwift(shown.edited))}</span>
            </div>
            {!hovered || selected === shown.id ? (
              <div className="gx-actions">
                <Button label="Open page" variant="primary" size="sm" onClick={() => onOpenPage(shown.id)} />
                {focus === shown.id
                  ? <Button label="Show whole graph" size="sm" onClick={() => setFocus(undefined)} />
                  : <Button label="Show neighbourhood" size="sm" onClick={() => { setFocus(shown.id); autoFit.current = true; }} />}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="gx-block">
          <h2 className="t-section">Show</h2>
          <Selector
            label="Teamspace"
            value={activeSection}
            onChange={(v) => { setSection(v ?? ALL); autoFit.current = true; }}
            options={[{ value: ALL, label: "All pages" }, ...sections.map((s) => ({ value: s.id, label: s.name }))]}
          />
          <Switch label="Only connected pages" description="Hide pages without any link." value={connectedOnly} onChange={(v) => { setConnectedOnly(v); autoFit.current = true; }} />
          {focusNode ? (
            <div className="gx-focus">
              <span className="t-desc">Around “{focusNode.title}”</span>
              <SegmentedControl label="Depth" value={String(depth)} onChange={(v) => { setDepth(Number(v)); autoFit.current = true; }}>
                <SegmentedControlItem value="1" label="1 step" />
                <SegmentedControlItem value="2" label="2 steps" />
                <SegmentedControlItem value="3" label="3 steps" />
              </SegmentedControl>
              <Button label="Show whole graph" size="sm" variant="ghost" onClick={() => { setFocus(undefined); autoFit.current = true; }} />
            </div>
          ) : null}
        </div>

        <div className="gx-block">
          <h2 className="t-section">Links</h2>
          {GRAPH_EDGE_KINDS.map((k) => (
            <CheckboxInput key={k} label={EDGE_LABEL[k]} value={kinds.includes(k)} onChange={(on) => setKinds(on ? GRAPH_EDGE_KINDS.filter((x) => x === k || kinds.includes(x)) : kinds.filter((x) => x !== k))} />
          ))}
        </div>

        <ul className="gx-legend t-desc" aria-label="Legend">
          <li><span className="gx-key filled" aria-hidden="true" />Top-level pages and databases</li>
          <li><span className="gx-key ring" aria-hidden="true" />Pages inside them</li>
          <li><span className="gx-key dot" aria-hidden="true" />Database rows</li>
        </ul>
        <p className="t-desc">Click a page to open it. Drag to move, scroll to zoom.</p>
      </aside>
    </div>
  );
}

function draw(ctx: CanvasRenderingContext2D, s: Scene, v: View, size: { w: number; h: number; dpr: number }, p: Paint, hover: number, live: { selected: string | undefined; matches: Set<number>; query: string }) {
  const { w, h, dpr } = size;
  const { layout, graph, radius, neighbors } = s;
  const n = graph.nodes.length;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (n === 0) return;
  const X = (i: number) => layout.x[i]! * v.k + v.x;
  const Y = (i: number) => layout.y[i]! * v.k + v.y;
  const sel = live.selected !== undefined ? (s.index.get(live.selected) ?? -1) : -1;
  // Hervorgehoben: der Knoten unter dem Zeiger (sonst der gewählte) mit Nachbarn; bei einer Suche die Treffer.
  const center = hover >= 0 ? hover : sel;
  const searching = live.query !== "";
  let lit: Set<number> | undefined;
  if (center >= 0) lit = new Set([center, ...neighbors[center]!]);
  else if (searching) lit = live.matches;
  const dim = lit !== undefined;
  // Knoten wachsen beim Hineinzoomen nur gedämpft
  const scale = Math.max(0.55, Math.min(1.6, Math.sqrt(v.k)));
  const visible = (i: number, m = 20) => { const x = X(i), y = Y(i); return x > -m && x < w + m && y > -m && y < h + m; };

  // Kanten
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.line;
  ctx.globalAlpha = dim ? 0.45 : 1;
  ctx.beginPath();
  for (const [a, b] of s.links) {
    if (center >= 0 && (a === center || b === center)) continue;
    ctx.moveTo(X(a), Y(a));
    ctx.lineTo(X(b), Y(b));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (center >= 0) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.ink2;
    ctx.beginPath();
    for (const b of neighbors[center]!) {
      ctx.moveTo(X(center), Y(center));
      ctx.lineTo(X(b), Y(b));
    }
    ctx.stroke();
  }

  // Knoten in drei Durchgängen (je Stil ein Pfad): Zeilen als Punkte, Seiten als Ringe, oberste Ebene gefüllt.
  const pass = (want: (node: GraphNode) => boolean, alpha: number, only: ((i: number) => boolean) | undefined, style: () => void) => {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (!want(graph.nodes[i]!) || (only && !only(i)) || !visible(i)) continue;
      const r = radius[i]! * scale;
      ctx.moveTo(X(i) + r, Y(i));
      ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
    }
    style();
    ctx.globalAlpha = 1;
  };
  const isRow = (x: GraphNode) => x.kind === "row";
  const isRing = (x: GraphNode) => x.kind !== "row" && !x.top;
  const isTop = (x: GraphNode) => x.kind !== "row" && x.top;
  const rows = () => { ctx.fillStyle = p.muted; ctx.fill(); };
  const rings = () => { ctx.fillStyle = p.bg; ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = p.muted; ctx.stroke(); };
  const tops = () => { ctx.fillStyle = p.ink; ctx.fill(); };
  if (dim) {
    const off = (i: number) => !lit!.has(i), on = (i: number) => lit!.has(i);
    pass(isRow, 0.22, off, rows); pass(isRing, 0.22, off, rings); pass(isTop, 0.22, off, tops);
    pass(isRow, 1, on, rows); pass(isRing, 1, on, rings); pass(isTop, 1, on, tops);
  } else {
    pass(isRow, 0.8, undefined, rows); pass(isRing, 1, undefined, rings); pass(isTop, 1, undefined, tops);
  }

  // Gewählter Knoten und Knoten unter dem Zeiger: kräftiger Ring in Tinte
  for (const i of new Set([sel, hover])) {
    if (i < 0 || i >= n) continue;
    const r = radius[i]! * scale + 3;
    ctx.beginPath();
    ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.ink;
    ctx.stroke();
  }

  // Beschriftungen: hervorgehobene immer; sonst die größten Naben, beim Hineinzoomen alle sichtbaren (gedeckelt).
  const labels: number[] = [];
  if (lit) for (const i of lit) { if (i >= 0 && i < n && visible(i, 0)) labels.push(i); if (labels.length >= MAX_LABELS) break; }
  else {
    const all = v.k >= 1.15;
    const cap = all ? MAX_LABELS : Math.min(n, n > 400 ? 14 : 40);
    for (const i of s.byDegree) {
      if (labels.length >= cap) break;
      if (!all && neighbors[i]!.length === 0 && n > 60) break;
      if (visible(i, 0)) labels.push(i);
    }
  }
  if (sel >= 0 && !labels.includes(sel)) labels.push(sel);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  for (const i of labels) {
    const node = graph.nodes[i]!;
    const strong = i === center || i === sel || (node.top && node.kind !== "row");
    ctx.font = strong ? p.fontStrong : p.font;
    const text = node.title.length > 34 ? node.title.slice(0, 33) + "…" : node.title;
    const x = X(i), y = Y(i) + radius[i]! * scale + 5;
    // Halo in der Flächenfarbe, damit die Schrift über Kanten lesbar bleibt
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.surface;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = strong ? p.ink : p.muted;
    ctx.fillText(text, x, y);
  }
}
