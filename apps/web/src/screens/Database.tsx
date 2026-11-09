// Datenbank: Ansichten als Tabs, Filter-Chips, Tabelle mit Haarlinien, Mono für IDs/Zeiten; Board mit Spalten
// als Flächen. Geänderte Zeilen/Karten tragen den Agent-Strich.
import { useState } from "react";
import { ROWS, STATUS_CLASS, type Status } from "../data.js";

const COLUMNS: Status[] = ["Ready", "In progress", "Review", "Backlog"];

export function Database() {
  const [view, setView] = useState<"table" | "board">("table");
  return (
    <>
      <div className="db-head">
        <div>
          <h1 className="t-title">Based Backlog</h1>
          <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>Ready and autonomous items run tonight.</p>
        </div>
        <div className="db-toolbar">
          <div role="tablist" aria-label="Views" style={{ display: "flex" }}>
            {(["table", "board"] as const).map((v) => (
              <button key={v} type="button" role="tab" className="view-tab" aria-selected={view === v} onClick={() => setView(v)}>
                {v === "table" ? "Table" : "Board"}
              </button>
            ))}
          </div>
          <div className="db-actions">
            <button type="button" className="chip">Status is not Done</button>
            <button type="button" className="chip ghost">Sort</button>
            <button type="button" className="chip primary">New</button>
          </div>
        </div>
      </div>
      <div className="db-body" role="tabpanel">
        {view === "table" ? (
          <table className="db-table">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Changed by Based</span></th>
                <th scope="col">ID</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Area</th><th scope="col">Owner</th>
                <th scope="col" className="right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.id}>
                  <td className="bar">{r.changed ? <span className="changed" role="img" aria-label="Changed by Based" /> : <span />}</td>
                  <td className="t-data">{r.id}</td>
                  <td className="title">{r.title}</td>
                  <td><span className={`status ${STATUS_CLASS[r.status]}`}>{r.status}</span></td>
                  <td className="muted">{r.area}</td>
                  <td>{r.owner}</td>
                  <td className="right t-data">{r.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="board">
            {COLUMNS.map((c) => {
              const items = ROWS.filter((r) => r.status === c);
              return (
                <section key={c} className="board-col" aria-label={c}>
                  <div className="board-col-head"><span className={`status ${STATUS_CLASS[c]}`}>{c}</span><span className="t-desc">{items.length}</span></div>
                  {items.slice(0, 4).map((i) => (
                    <div key={i.id} className="card">
                      <span className={i.changed ? "card-bar changed" : "card-bar"} {...(i.changed ? { role: "img", "aria-label": "Changed by Based" } : { "aria-hidden": true })} />
                      <strong>{i.title}</strong>
                      <span className="card-foot"><span className="t-data">{i.id}</span><span className="t-meta">{i.owner}</span></span>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
