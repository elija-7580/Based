// Graph: Projekte gefüllt in Tinte, Seiten als Ringe, Agent-Änderungen im Marker.
import { AREAS, GRAPH_EDGES, GRAPH_NODES } from "../data.js";

const RADIUS = { p: 12, s: 13, c: 7, n: 7, d: 4 } as const;
const NODE_CLASS = { p: "node-project", s: "node-selected", c: "node-agent", n: "node-page", d: "node-dot" } as const;

export function Graph() {
  const max = Math.max(...AREAS.map(([, n]) => n));
  return (
    <div className="graph">
      <section className="graph-canvas" aria-label="Page graph">
        <div className="graph-title"><h1 className="t-heading">Graph</h1><span className="t-desc">412 pages · 1 108 links</span></div>
        <svg role="img" aria-label="Linked pages around Graph view" viewBox="0 0 800 640" preserveAspectRatio="xMidYMid meet">
          {GRAPH_EDGES.map(([a, b]) => {
            const [x1, y1] = GRAPH_NODES[a]!, [x2, y2] = GRAPH_NODES[b]!;
            return <line key={a + b} x1={x1} y1={y1} x2={x2} y2={y2} className={a === "graph" || b === "graph" ? "edge sel" : "edge"} />;
          })}
          {Object.entries(GRAPH_NODES).map(([k, [x, y, label, t]]) => {
            const r = RADIUS[t];
            return (
              <g key={k}>
                <circle cx={x} cy={y} r={r} className={NODE_CLASS[t]} />
                {label ? <text x={x} y={y + r + 14} textAnchor="middle" className={`node-label${t === "n" ? " minor" : ""}${t === "p" || t === "s" ? " strong" : ""}`}>{label}</text> : null}
              </g>
            );
          })}
        </svg>
      </section>
      <aside className="graph-side">
        <div>
          <span className="t-meta">Selected</span>
          <h2 className="t-heading" style={{ margin: "var(--space-1) 0 var(--space-2)" }}>Graph view</h2>
          <div className="facts t-desc"><span>Links</span><span style={{ color: "var(--ink)" }}>9 in · 4 out</span><span>Last edit</span><span style={{ color: "var(--ink)" }}>Researcher, 16:21</span></div>
        </div>
        <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <h2 className="t-section">Open items by area</h2>
          {AREAS.map(([name, n]) => (
            <div key={name} className="bar-row t-desc">
              <span>{name}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${(n / max) * 100}%` }} /></span>
              <span className="t-data" style={{ textAlign: "right", color: "var(--ink)" }}>{n}</span>
            </div>
          ))}
        </section>
        <p className="t-desc">Nodes with a marker were changed by an agent since you last looked.</p>
      </aside>
    </div>
  );
}
