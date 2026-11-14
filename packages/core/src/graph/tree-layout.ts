// BSD-262 Teil 2 (Kern): Baum-Ansicht des Seitengraphen („Stammbaum“). Ebenen von oben nach unten, Geschwister
// nebeneinander in der Reihenfolge der Kanten, Eltern mittig über ihren Kindern; mehrere Wurzeln stehen
// nebeneinander. Rein und O(n): jedes Blatt bekommt eine Spalte, ein Elternknoten die Mitte seiner Kinder.
// Kanten: `child` (Unterseite) ergibt den Baum; mit `kinds: ["child", "relation"]` auch ein Relationsbaum. Ein Knoten
// mit mehreren Eltern hängt am ersten; Zyklen werden gebrochen (Knoten, die schon platziert sind, zählen nicht).
import type { Point } from "./layout.js";
import type { GraphEdgeKind, PageGraph } from "./page-graph.js";

export interface TreeLayoutOptions {
  /** Welche Kanten Eltern → Kind sind (Standard: nur `child`). */
  kinds?: readonly GraphEdgeKind[];
  /** Abstand zwischen Spalten bzw. Ebenen (Graph-Einheiten). */
  columnGap?: number;
  levelGap?: number;
}

export interface TreeLayout {
  positions: Map<string, Point>;
  /** Ebene je Knoten (Wurzel = 0). */
  depth: Map<string, number>;
  /** Eltern → Kind, so wie gezeichnet (nur Baumkanten). */
  edges: [string, string][];
  /** Wurzeln in Zeichenreihenfolge. */
  roots: string[];
}

export function treeLayout(g: PageGraph, opts: TreeLayoutOptions = {}): TreeLayout {
  const kinds = new Set(opts.kinds ?? ["child"]);
  const colGap = opts.columnGap ?? 160, levelGap = opts.levelGap ?? 120;
  const known = new Set(g.nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of g.edges) {
    if (!kinds.has(e.k) || e.s === e.t || !known.has(e.s) || !known.has(e.t) || hasParent.has(e.t)) continue;
    hasParent.add(e.t);
    const list = children.get(e.s);
    if (list) list.push(e.t);
    else children.set(e.s, [e.t]);
  }
  const positions = new Map<string, Point>();
  const depth = new Map<string, number>();
  const edges: [string, string][] = [];
  const roots: string[] = [];
  let column = 0;
  // Iterativ (tiefe Bäume sprengen sonst den Stack): erst Kinder, dann der Elternknoten über ihnen.
  const place = (root: string) => {
    roots.push(root);
    depth.set(root, 0);
    const stack: { id: string; next: number; kids: string[] }[] = [{ id: root, next: 0, kids: [] }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const all = children.get(top.id) ?? [];
      if (top.next < all.length) {
        const c = all[top.next++]!;
        if (depth.has(c)) continue; // Zyklus oder schon platziert
        depth.set(c, depth.get(top.id)! + 1);
        top.kids.push(c);
        edges.push([top.id, c]);
        stack.push({ id: c, next: 0, kids: [] });
        continue;
      }
      stack.pop();
      const d = depth.get(top.id)!;
      let x: number;
      if (top.kids.length === 0) x = column++ * colGap;
      else x = (positions.get(top.kids[0]!)!.x + positions.get(top.kids[top.kids.length - 1]!)!.x) / 2;
      positions.set(top.id, { x, y: d * levelGap });
    }
  };
  for (const n of g.nodes) if (!hasParent.has(n.id) && !depth.has(n.id)) place(n.id);
  // Was nur in Zyklen hängt (jeder hat einen Elternteil), bekommt die erste Seite des Zyklus als Wurzel.
  for (const n of g.nodes) if (!depth.has(n.id)) place(n.id);
  return { positions, depth, edges, roots };
}
