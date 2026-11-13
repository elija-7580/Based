// BSD-207: „Move to“ aus dem Blockmenü – Zielseite suchen (Seitenverzeichnis der Shell, leer = zuletzt benutzt) und
// wählen; Pfeiltasten und Enter wie im @-Menü, Esc schließt. Das Verschieben selbst macht moveBlocksToPage.
import { useEffect, useRef, useState } from "react";
import { IconView } from "./phosphor.js";
import type { PageDirectory, PageRef } from "./env.js";
import { moveTargetAllowed } from "./blockActions.js";

export interface MovePickerProps {
  pages: PageDirectory;
  /** Seite des Editors (kein Ziel). */
  selfID: string;
  /** Die bewegten Blöcke (eine bewegte Unterseite ist kein Ziel). */
  moving: readonly string[];
  onPick: (page: PageRef) => void;
  onClose: () => void;
}

export function MovePicker(props: MovePickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PageRef[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { pages, selfID, moving } = props;
  useEffect(() => {
    let live = true;
    void pages.search(query).then((r) => {
      if (!live) return;
      setResults(r.filter((p) => !p.trashed && moving.length > 0 && moveTargetAllowed(p.kind, p.id, selfID, moving)).slice(0, 8));
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [pages, query, selfID, moving]);
  useEffect(() => input.current?.focus(), []);
  const n = moving.length;
  return (
    <div className="bx-move-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="bx-move" role="dialog" aria-label="Move to" data-testid="block-move">
        <input ref={input} className="bx-field" placeholder={n === 1 ? "Move block to…" : `Move ${n} blocks to…`} aria-label="Find a page"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") props.onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              const hit = results[active];
              if (hit) props.onPick(hit);
            }
          }} />
        <ul className="bx-picker-list" role="listbox" aria-label="Pages">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button type="button" className="bx-move-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(p)}>
                <span className="bx-move-icon" aria-hidden="true"><IconView icon={p.icon} fallback="📄" /></span>
                <span className="bx-move-text">
                  <span className="bx-move-title">{p.title || "Untitled"}</span>
                  {p.path ? <span className="bx-move-path">{p.path}</span> : null}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="bx-muted bx-move-empty">No matching page.</li> : null}
        </ul>
      </div>
    </div>
  );
}

/** BSD-212: eine Datenbank für „Linked view of database“. */
export interface DatabaseRef {
  id: string;
  title: string;
  /** Pfad über dem Datenbank-Block. */
  path?: string | undefined;
}

/** Alle Datenbanken des Workspaces (Auswahl für verknüpfte Ansichten); `include` holt eine in den Store des Editors. */
export interface DatabaseSource {
  list(query: string): Promise<DatabaseRef[]>;
  include?: ((databaseID: string) => Promise<boolean>) | undefined;
}

/** BSD-212: „Linked view of database“ – Datenbank suchen und wählen, Bedienung wie „Move to“. */
export function DatabasePicker(props: { source: DatabaseSource; onPick: (db: DatabaseRef) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DatabaseRef[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { source } = props;
  useEffect(() => {
    let live = true;
    void source.list(query).then((r) => {
      if (!live) return;
      setResults(r.slice(0, 8));
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [source, query]);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="bx-move-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="bx-move" role="dialog" aria-label="Linked view of database" data-testid="database-link-picker">
        <input ref={input} className="bx-field" placeholder="Link to a database…" aria-label="Find a database"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") props.onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              const hit = results[active];
              if (hit) props.onPick(hit);
            }
          }} />
        <ul className="bx-picker-list" role="listbox" aria-label="Databases">
          {results.map((d, i) => (
            <li key={d.id} role="option" aria-selected={i === active}>
              <button type="button" className="bx-move-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(d)}>
                <span className="bx-move-icon" aria-hidden="true">▦</span>
                <span className="bx-move-text">
                  <span className="bx-move-title">{d.title || "Untitled"}</span>
                  {d.path ? <span className="bx-move-path">{d.path}</span> : null}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="bx-muted bx-move-empty">No matching database.</li> : null}
        </ul>
      </div>
    </div>
  );
}

/** BSD-210: eine Seite als Ziel wählen (Button „Open page“), Bedienung wie „Move to“. */
export function PageTargetPicker(props: { pages: PageDirectory; onPick: (page: PageRef) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PageRef[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { pages } = props;
  useEffect(() => {
    let live = true;
    void pages.search(query).then((r) => {
      if (!live) return;
      setResults(r.filter((p) => !p.trashed && !p.missing && p.kind !== "database").slice(0, 8));
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [pages, query]);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="bx-move-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="bx-move" role="dialog" aria-label="Choose a page" data-testid="page-target-picker">
        <input ref={input} className="bx-field" placeholder="Open which page…" aria-label="Find a page"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") props.onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              const hit = results[active];
              if (hit) props.onPick(hit);
            }
          }} />
        <ul className="bx-picker-list" role="listbox" aria-label="Pages">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button type="button" className="bx-move-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(p)}>
                <span className="bx-move-icon" aria-hidden="true"><IconView icon={p.icon} fallback="📄" /></span>
                <span className="bx-move-text">
                  <span className="bx-move-title">{p.title || "Untitled"}</span>
                  {p.path ? <span className="bx-move-path">{p.path}</span> : null}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="bx-muted bx-move-empty">No matching page.</li> : null}
        </ul>
      </div>
    </div>
  );
}
