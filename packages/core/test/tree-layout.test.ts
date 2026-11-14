// BSD-262 Teil 2 (Kern): Baum-Layout des Seitengraphen – Ebenen, Eltern mittig, Wälder, mehrere Eltern, Zyklen,
// tiefe Ketten ohne Stack-Überlauf und 5 000 Seiten unter 200 ms.
import { describe, expect, it } from "vitest";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";
import { treeLayout, type GraphEdge, type PageGraph } from "../src/index.js";

const node = (id: string) => ({ id, title: id, kind: "page" as const, top: false, section: "private", edited: 0 });
const graph = (ids: string[], edges: [string, string, GraphEdge["k"]?][]): PageGraph =>
  ({ nodes: ids.map(node), edges: edges.map(([s, t, k]) => ({ s, t, k: k ?? "child" })) });

describe("Baum-Layout", () => {
  it("Ebenen von oben nach unten, Eltern mittig über den Kindern, Reihenfolge wie die Kanten", () => {
    const t = treeLayout(graph(["r", "a", "b", "a1", "a2"], [["r", "a"], ["r", "b"], ["a", "a1"], ["a", "a2"]]), { columnGap: 10, levelGap: 100 });
    expect(Object.fromEntries(t.positions)).toEqual({
      a1: { x: 0, y: 200 }, a2: { x: 10, y: 200 }, a: { x: 5, y: 100 }, b: { x: 20, y: 100 }, r: { x: 12.5, y: 0 },
    });
    expect(t.roots).toEqual(["r"]);
    expect(t.edges).toEqual([["r", "a"], ["a", "a1"], ["a", "a2"], ["r", "b"]]);
    expect(t.depth.get("a2")).toBe(2);
  });

  it("mehrere Wurzeln nebeneinander; Erwähnungen zählen nicht, Relationen nur auf Wunsch", () => {
    const g = graph(["x", "y", "z"], [["x", "z", "mention"], ["y", "z", "relation"]]);
    expect(treeLayout(g).roots).toEqual(["x", "y", "z"]);
    const rel = treeLayout(g, { kinds: ["child", "relation"], columnGap: 1 });
    expect(rel.roots).toEqual(["x", "y"]);
    expect(rel.positions.get("z")).toEqual({ x: 1, y: 120 });
  });

  it("mehrere Eltern: hängt am ersten; Zyklen und Selbstkanten brechen nicht", () => {
    const multi = treeLayout(graph(["p", "q", "c"], [["p", "c"], ["q", "c"]]));
    expect(multi.edges).toEqual([["p", "c"]]);
    const cyc = treeLayout(graph(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"], ["a", "a"]]));
    expect(cyc.positions.size).toBe(3);
    expect(cyc.roots).toEqual(["a"]);
    expect(cyc.edges).toEqual([["a", "b"], ["b", "c"]]);
    // Kanten zu unbekannten Knoten werden ignoriert
    expect(treeLayout(graph(["a"], [["a", "ghost"]])).positions.size).toBe(1);
  });

  it("tiefe Kette (20 000 Ebenen) ohne Stack-Überlauf", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => "n" + i);
    const t = treeLayout(graph(ids, ids.slice(1).map((id, i) => [ids[i]!, id] as [string, string])));
    expect(t.depth.get("n19999")).toBe(19_999);
    expect(t.positions.get("n0")).toEqual({ x: 0, y: 0 });
  });

  it("5 000 Seiten (Fächer 4) unter 200 ms", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => "N" + i);
    const g = graph(ids, ids.slice(1).map((id, i) => [ids[Math.floor(i / 4)]!, id] as [string, string]));
    let size = 0;
    expectWithinBudget("Baum-Layout 5.000", { layout: 200 }, () => ({ layout: cpuTime(() => { size = treeLayout(g).positions.size; }) }));
    expect(size).toBe(5000);
  });
});
