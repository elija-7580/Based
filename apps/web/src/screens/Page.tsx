// Seite: Breadcrumb, Titel, Metazeile, Randspalte für Agent-Notizen, Text max. 720 px.
import { useState } from "react";
import { AgentBlock, AgentTag } from "../components/AgentMark.js";

const Z = [["90 %", "1.645"], ["95 %", "1.960"], ["99 %", "2.576"]] as const;
const TODOS = ["Why √n and not n?", "When to use t instead of z", "Ask about exercise 4.3 on Thursday"];

export function Page() {
  const [done, setDone] = useState<Record<number, boolean>>({ 0: true });
  return (
    <>
      <header className="topbar t-desc">
        <nav aria-label="Breadcrumb" style={{ display: "flex", gap: "var(--space-2)" }}>
          <span>University</span><span aria-hidden="true">/</span><span>Statistics</span><span aria-hidden="true">/</span>
          <span style={{ color: "var(--ink)" }} aria-current="page">Lecture 4</span>
        </nav>
        <span className="spacer">Saved</span>
        <button type="button" className="btn">Share</button>
      </header>
      <article className="page">
        <div className="page-grid">
          <div className="spacer-cell" />
          <div style={{ marginBottom: "var(--space-4)" }}>
            <h1 className="t-title">Lecture 4 — Confidence intervals</h1>
            <div className="meta-line t-desc"><span>3 Nov 2026</span><span>Recording 84 min</span><span>3 linked pages</span></div>
          </div>

          <AgentTag origin="from your recording" />
          <AgentBlock>
            <div className="prose t-body">
              <p>A confidence interval gives a range that, over many repeated samples, contains the true parameter a chosen share of the time — usually 95 %. It says nothing about one single interval being “95 % likely” to be right.</p>
              <p>Width shrinks with the square root of the sample size, so halving the width needs four times the data.</p>
            </div>
          </AgentBlock>

          <div className="spacer-cell" />
          <div className="code-block t-code">CI = x̄ ± z · σ / √n</div>

          <div className="spacer-cell" />
          <table className="simple-table">
            <thead><tr><th scope="col">Confidence</th><th scope="col" className="num">z</th></tr></thead>
            <tbody>{Z.map(([c, z]) => <tr key={c}><td>{c}</td><td className="num t-data" style={{ color: "var(--ink)" }}>{z}</td></tr>)}</tbody>
          </table>

          <div className="spacer-cell" />
          <h2 className="t-heading" style={{ marginTop: "var(--space-4)" }}>Open questions</h2>

          <div className="spacer-cell" />
          <div className="t-body">
            {TODOS.map((text, i) => (
              <label key={text} className={done[i] ? "todo done" : "todo"}>
                <input type="checkbox" checked={!!done[i]} onChange={() => setDone({ ...done, [i]: !done[i] })} />
                <span>{text}</span>
              </label>
            ))}
          </div>
        </div>
      </article>
    </>
  );
}
