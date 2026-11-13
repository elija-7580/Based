// Papierkorb: gelöschte Seiten, Datenbanken und Zeilen (neueste zuerst) – wiederherstellen oder endgültig löschen.
import { BasedButton } from "@based/ui/astryx";
import { useState } from "react";
import { Icon } from "../icons.js";
import { fromSwift, relative } from "../shell/format.js";
import { mayDeleteForever } from "../shell/guest.js";
import type { ShellState, StoreClient } from "../worker/client.js";

const PAGE = 100;

export function Trash({ client, state, onOpenPage }: { client: StoreClient; state: ShellState; onOpenPage: (id: string) => void }) {
  const entries = state.outline?.trash ?? [];
  const [confirm, setConfirm] = useState(false);
  const forever = mayDeleteForever();
  // Nach „alles löschen“ liegen hier Tausende Seiten; alle als Zeilen zu zeichnen machte jeden Klick träge.
  // Erst eine Seite voll, auf Wunsch mehr. „Empty Trash“ gilt immer für alle.
  const [shown, setShown] = useState(PAGE);
  // „Papierkorb leeren“ mit Tausenden Seiten dauert: sofort zeigen, dass es läuft, und nicht doppelt auslösen.
  const [emptying, setEmptying] = useState<number | undefined>();
  const empty = () => {
    setConfirm(false);
    setEmptying(entries.length);
    void client.command({ op: "emptyTrash" }).finally(() => setEmptying(undefined));
  };
  return (
    <div className="content">
      <div className="column">
        <header className="trash-head">
          <div>
            <h1 className="t-title">Trash</h1>
            <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>{forever ? "Pages stay here until you delete them forever." : "Pages stay here until the owner deletes them."}</p>
          </div>
          {emptying !== undefined ? (
            <span className="t-desc" role="status" data-testid="trash-emptying">Deleting {emptying} {emptying === 1 ? "page" : "pages"} forever…</span>
          ) : entries.length && forever ? (
            confirm ? (
              <span className="actions">
                <BasedButton label={`Delete ${entries.length} forever`} variant="danger" onClick={empty} />
                <BasedButton label="Cancel" variant="ghost" onClick={() => setConfirm(false)} />
              </span>
            ) : (
              <BasedButton label="Empty Trash" onClick={() => setConfirm(true)} />
            )
          ) : null}
        </header>
        {entries.length === 0 ? (
          <p className="t-desc">The Trash is empty.</p>
        ) : (
          <ul className="group" aria-label="Pages in Trash">
            {entries.slice(0, shown).map((e) => {
              const title = state.titles.get(e.id) ?? "Untitled";
              return (
                <li key={e.id} className="row" aria-label={title}>
                  <span className="tile"><Icon name="page" /></span>
                  <button type="button" className="grow link-button" onClick={() => onOpenPage(e.id)}>
                    <strong>{title}</strong>
                    <span className="t-desc" style={{ display: "block" }}>{e.from ? `in ${e.from} · ` : ""}deleted {relative(fromSwift(e.trashedAt))}</span>
                  </button>
                  <BasedButton label="Restore" size="sm" icon={<Icon name="restore" size={16} />} onClick={() => void client.command({ op: "restore", ids: [e.id] })} />
                  {forever ? <BasedButton label="Delete forever" size="sm" variant="ghost" onClick={() => void client.command({ op: "deleteForever", ids: [e.id] })} /> : null}
                </li>
              );
            })}
          </ul>
        )}
        {entries.length > shown ? (
          <p className="t-desc trash-more" data-testid="trash-more">
            {entries.length - shown} more in Trash.{" "}
            <BasedButton label="Show more" size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE * 5)} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
