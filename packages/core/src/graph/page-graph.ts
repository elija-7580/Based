// Seitengraph: Knoten = Seiten, Datenbanken und Zeilen; Kanten = Unterseiten, Erwähnungen/Links und Relationen.
// Port von Swift Graph/PageGraph.swift (`pageGraph()`), ohne die Eigenschaftswerte für Farben/Größen der Swift-Ansicht.
// Reine Funktionen: `buildPageGraph` liest den Store, `filterGraph` schneidet zu (nur verbundene, Tiefe um eine
// Seite, Teamspace, Kantenarten). Reihenfolge der Knoten und Kanten ist stabil (nach ID), damit das Layout ruhig bleibt.
import { pageIDFromLink } from "../interop/html.js";
import { titleOf } from "../query/engine.js";
import type { Block } from "../model/records.js";
import { PRIVATE_SECTION } from "../store/outline.js";
import type { WorkspaceStore } from "../store/store.js";

export type GraphNodeKind = "page" | "database" | "row";
export type GraphEdgeKind = "child" | "mention" | "relation";
export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = ["child", "mention", "relation"];

export interface GraphNode {
  id: string;
  title: string;
  kind: GraphNodeKind;
  /** Oberste Ebene der Seitenleiste (im Graph gefüllt gezeichnet). */
  top: boolean;
  /** `private` oder Teamspace-ID (Abschnitt der obersten Seite darüber). */
  section: string;
  icon?: string;
  /** Zuletzt bearbeitet (Swift-Datum). */
  edited: number;
}

export interface GraphEdge {
  /** Von (Elternseite, erwähnende Seite, Zeile mit der Relation) … */
  s: string;
  /** … nach. */
  t: string;
  k: GraphEdgeKind;
}

export interface PageGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilter {
  /** Knoten ohne jede Kante ausblenden. */
  connectedOnly?: boolean;
  /** Nur die Umgebung dieser Seite … */
  focus?: string;
  /** … bis zu so vielen Kanten Abstand (Standard 1). */
  depth?: number;
  /** Nur Seiten dieses Abschnitts (`private` oder Teamspace-ID). */
  section?: string;
  /** Kantenarten (Standard: alle). */
  kinds?: readonly GraphEdgeKind[];
}

const byID = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Der ganze Graph eines Stands (ohne Papierkorb). */
export function buildPageGraph(store: WorkspaceStore): PageGraph {
  const teamspaces = new Set((store.workspace.teamspaces ?? []).map((t) => t.id));
  // Papierkorb und Abschnitt über die Elternkette, gemerkt.
  const state = new Map<string, { trashed: boolean; section: string }>();
  const stateOf = (b: Block): { trashed: boolean; section: string } => {
    const chain: Block[] = [];
    let cur: Block | undefined = b;
    let base: { trashed: boolean; section: string } | undefined;
    for (let n = 0; cur && n < 10_000; n++) {
      const known = state.get(cur.id);
      if (known) { base = known; break; }
      chain.push(cur);
      const p: string = cur.parent;
      if (p === "w") {
        const t = cur.props?.teamspace;
        base = { trashed: false, section: t && teamspaces.has(t) ? t : PRIVATE_SECTION };
        break;
      }
      const up: string | undefined = p.startsWith("b:") ? p.slice(2) : store.databases.get(p.slice(2))?.blockID;
      cur = up ? store.blocks.get(up) : undefined;
      if (!cur) base = { trashed: true, section: PRIVATE_SECTION };
    }
    let st = base ?? { trashed: true, section: PRIVATE_SECTION };
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i]!;
      st = { trashed: st.trashed || c.trashedAt !== undefined, section: st.section };
      state.set(c.id, st);
    }
    return state.get(b.id) ?? st;
  };

  const isNode = new Set<string>();
  for (const b of store.blocks.values()) {
    if ((b.type === "page" || b.type === "databasePage") && !stateOf(b).trashed) isNode.add(b.id);
  }

  // Nächste Seite über einem Block (gemerkt) – für Unterseiten und für Erwähnungen im Inhalt.
  const owner = new Map<string, string | undefined>();
  const owningPage = (id: string): string | undefined => {
    if (owner.has(id)) return owner.get(id);
    const chain: string[] = [];
    let cur: string | undefined = id;
    let result: string | undefined;
    for (let n = 0; cur !== undefined && n < 10_000; n++) {
      if (cur !== id && isNode.has(cur)) { result = cur; break; }
      if (owner.has(cur)) { result = owner.get(cur); break; }
      chain.push(cur);
      const b = store.blocks.get(cur);
      if (!b || b.parent === "w") break;
      cur = b.parent.startsWith("b:") ? b.parent.slice(2) : store.databases.get(b.parent.slice(2))?.blockID;
    }
    for (const c of chain) owner.set(c, result);
    return result;
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (s: string, t: string, k: GraphEdgeKind) => {
    if (s === t || !isNode.has(s) || !isNode.has(t)) return;
    const key = k + "\u0001" + s + "\u0001" + t;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ s, t, k });
  };

  for (const id of isNode) {
    const b = store.blocks.get(id)!;
    const node: GraphNode = {
      id, title: titleOf(store, id), kind: b.type === "databasePage" ? "database" : b.parent.startsWith("d:") ? "row" : "page",
      top: b.parent === "w", section: stateOf(b).section, edited: b.updatedAt,
    };
    const icon = b.props?.icon;
    const emoji = typeof icon === "string" ? icon : icon?.emoji;
    if (emoji) node.icon = emoji;
    nodes.push(node);
    const parent = owningPage(id);
    if (parent) edge(parent, id, "child");
    // Relationen einer Zeile
    if (b.parent.startsWith("d:") && b.values) {
      const db = store.databases.get(b.parent.slice(2));
      for (const p of db?.properties ?? []) {
        if (p.type !== "relation") continue;
        const targets = (b.values[p.id] as { relation?: { _0?: unknown } } | undefined)?.relation?._0;
        if (Array.isArray(targets)) for (const t of targets) if (typeof t === "string") edge(id, t, "relation");
      }
    }
  }

  // Erwähnungen und Seitenlinks im Inhalt: von der Seite, die den Block enthält, zur genannten Seite.
  for (const b of store.blocks.values()) {
    const targets: string[] = [];
    if (Array.isArray(b.text)) {
      for (const r of b.text) {
        const m = (r.mention as { page?: { _0?: unknown } } | undefined)?.page?._0;
        if (typeof m === "string") targets.push(m);
        const link = r.m?.link;
        if (link && link.startsWith("based:")) {
          // `pageIDFromLink` schreibt UUIDs klein; IDs aus Based sind groß geschrieben.
          const t = pageIDFromLink(link);
          if (t) targets.push(isNode.has(t) ? t : isNode.has(t.toUpperCase()) ? t.toUpperCase() : t);
        }
      }
    }
    if (b.type === "linkToPage" && b.props?.linkTarget) targets.push(b.props.linkTarget);
    if (targets.length === 0) continue;
    const st = stateOf(b);
    if (st.trashed) continue;
    const from = isNode.has(b.id) ? b.id : owningPage(b.id);
    if (!from) continue;
    for (const t of targets) edge(from, t, "mention");
  }

  nodes.sort(byID);
  edges.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return { nodes, edges };
}

/** Schneidet den Graph zu. Reihenfolge der Filter: Kantenarten, Abschnitt, Umgebung, „nur verbundene“. */
export function filterGraph(g: PageGraph, f: GraphFilter = {}): PageGraph {
  let nodes = g.nodes;
  let edges = g.edges;
  if (f.kinds && f.kinds.length < GRAPH_EDGE_KINDS.length) {
    const kinds = new Set(f.kinds);
    edges = edges.filter((e) => kinds.has(e.k));
  }
  if (f.section !== undefined) {
    nodes = nodes.filter((n) => n.section === f.section);
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.s) && keep.has(e.t));
  }
  if (f.focus !== undefined && nodes.some((n) => n.id === f.focus)) {
    const depth = Math.max(0, Math.floor(f.depth ?? 1));
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const l = adj.get(a);
      if (l) l.push(b);
      else adj.set(a, [b]);
    };
    for (const e of edges) { link(e.s, e.t); link(e.t, e.s); }
    const keep = new Set<string>([f.focus]);
    let frontier = [f.focus];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const o of adj.get(id) ?? []) if (!keep.has(o)) { keep.add(o); next.push(o); }
      frontier = next;
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.s) && keep.has(e.t));
  }
  if (f.connectedOnly) {
    const linked = new Set<string>();
    for (const e of edges) { linked.add(e.s); linked.add(e.t); }
    nodes = nodes.filter((n) => linked.has(n.id) || n.id === f.focus);
  }
  return { nodes, edges };
}

/** Nachbarn je Knoten (Index in `nodes`), für Hervorheben und Layout. */
export function graphAdjacency(g: PageGraph): { index: Map<string, number>; links: [number, number][]; neighbors: number[][] } {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const neighbors: number[][] = g.nodes.map(() => []);
  const links: [number, number][] = [];
  const seen = new Set<number>();
  const n = g.nodes.length;
  for (const e of g.edges) {
    const a = index.get(e.s), b = index.get(e.t);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) continue; // mehrere Kantenarten zwischen zwei Seiten: eine Feder
    seen.add(key);
    links.push([a, b]);
    neighbors[a]!.push(b);
    neighbors[b]!.push(a);
  }
  return { index, links, neighbors };
}
