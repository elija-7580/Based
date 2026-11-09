// Quick Find (⌘K): sucht im Store-Worker über den Volltextindex (Titel, Inhalt mit Snippet, Zeilen). Jede Eingabe bricht die vorige
// Suche ab; ohne Eingabe stehen die zuletzt geöffneten Seiten da. Pfeiltasten wählen, Enter öffnet, Esc schließt.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons.js";
import type { RecentEntry } from "../shell/storage.js";
import type { StoreClient } from "../worker/client.js";
import type { QuickFindHit } from "../worker/protocol.js";

interface Props {
  client: StoreClient;
  titles: ReadonlyMap<string, string>;
  recent: RecentEntry[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

export function QuickFind({ client, titles, recent, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<QuickFindHit[] | undefined>();
  const [took, setTook] = useState<number | undefined>();
  const [selected, setSelected] = useState(0);
  const listID = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void client.warmSearch().catch(() => undefined);
    return () => client.cancelSearch();
  }, [client]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(undefined);
      setTook(undefined);
      return;
    }
    let alive = true;
    const t0 = performance.now();
    void client.search(query).then((r) => {
      if (!alive || !r) return;
      setHits(r.hits);
      setTook(performance.now() - t0);
      setSelected(0);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, query]);

  const items: QuickFindHit[] = hits ?? recent.filter((r) => titles.has(r.id)).slice(0, 8).map((r) => ({ pageID: r.id, title: titles.get(r.id)!, path: "", kind: "page" }));
  const open = (i: number) => {
    const it = items[i];
    if (it) onOpen(it.pageID);
  };

  return (
    <div className="qf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Quick Find" className="qf">
        <div className="qf-field">
          <Icon name="search" size={18} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listID}
            aria-activedescendant={items[selected] ? `${listID}-${selected}` : undefined}
            aria-label="Search pages"
            placeholder="Search pages and content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                open(selected);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="qf-head t-meta">{hits ? (hits.length ? "Best matches" : "") : items.length ? "Recent" : ""}</div>
        <ul id={listID} role="listbox" aria-label="Results" className="qf-list" data-took={took === undefined ? undefined : took.toFixed(1)}>
          {items.map((h, i) => (
            <li
              key={h.pageID}
              id={`${listID}-${i}`}
              role="option"
              aria-selected={i === selected}
              className="qf-item"
              onMouseMove={() => setSelected(i)}
              onClick={() => open(i)}
            >
              <span className="tile"><Icon name={h.kind === "database" ? "database" : "page"} size={18} /></span>
              <span className="grow">
                <strong>{h.title}</strong>
                {h.path ? <span className="t-desc qf-path"> — {h.path}</span> : null}
                {h.snippet ? <span className="t-desc qf-snippet" data-testid="qf-snippet"><Highlight text={h.snippet} query={query} /></span> : null}
              </span>
            </li>
          ))}
          {hits && hits.length === 0 ? <li className="qf-none t-desc">No results</li> : null}
        </ul>
      </div>
    </div>
  );
}

/** Suchbegriffe im Snippet markieren (Groß/klein egal). */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}</>;
}
