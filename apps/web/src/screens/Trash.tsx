// Papierkorb: gelöschte Seiten, Datenbanken und Zeilen (neueste zuerst) – wiederherstellen oder endgültig löschen.
import { useState } from "react";
import { Icon } from "../icons.js";
import { fromSwift, relative } from "../shell/format.js";
import type { ShellState, StoreClient } from "../worker/client.js";

export function Trash({ client, state, onOpenPage }: { client: StoreClient; state: ShellState; onOpenPage: (id: string) => void }) {
  const entries = state.outline?.trash ?? [];
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="content">
      <div className="column">
        <header className="trash-head">
          <div>
            <h1 className="t-title">Trash</h1>
            <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>Pages stay here until you delete them forever.</p>
          </div>
          {entries.length ? (
            confirm ? (
              <span className="actions">
                <button type="button" className="btn primary" onClick={() => { setConfirm(false); void client.command({ op: "emptyTrash" }); }}>
                  Delete {entries.length} forever
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirm(true)}>Empty Trash</button>
            )
          ) : null}
        </header>
        {entries.length === 0 ? (
          <p className="t-desc">The Trash is empty.</p>
        ) : (
          <ul className="group" aria-label="Pages in Trash">
            {entries.map((e) => {
              const title = state.titles.get(e.id) ?? "Untitled";
              return (
                <li key={e.id} className="row" aria-label={title}>
                  <span className="tile"><Icon name="page" /></span>
                  <button type="button" className="grow link-button" onClick={() => onOpenPage(e.id)}>
                    <strong>{title}</strong>
                    <span className="t-desc" style={{ display: "block" }}>{e.from ? `in ${e.from} · ` : ""}deleted {relative(fromSwift(e.trashedAt))}</span>
                  </button>
                  <button type="button" className="btn" onClick={() => void client.command({ op: "restore", ids: [e.id] })}>
                    <Icon name="restore" size={16} />Restore
                  </button>
                  <button type="button" className="btn ghost" onClick={() => void client.command({ op: "deleteForever", ids: [e.id] })}>Delete forever</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
