// Quick Find (⌘K): sucht im Store-Worker über den Volltextindex (Titel, Inhalt mit Snippet, Zeilen). Jede Eingabe bricht die vorige
// Suche ab; ohne Eingabe stehen die zuletzt geöffneten Seiten da. Pfeiltasten wählen, Enter öffnet, Esc schließt.
// BSD-206: Filter wie in Notion – nur Titel, in der aktuellen Seite, Zeitraum, Sortierung (shell/quickFindFilters.ts).
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../icons.js";
import { matchCommands, type NavCommand } from "../shell/sidebarNav.js";
import { DATE_OPTIONS, SORT_OPTIONS, toSearchFilters, type QuickFindFilters } from "../shell/quickFindFilters.js";
import type { RecentEntry } from "../shell/storage.js";
import type { StoreClient } from "../worker/client.js";
import type { QuickFindHit } from "../worker/protocol.js";

interface Props {
  client: StoreClient;
  titles: ReadonlyMap<string, string>;
  recent: RecentEntry[];
  /** Offene Seite: bietet „In this page“ an. */
  currentPage?: { id: string; title: string } | undefined;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** BSD-281: Befehle („All tasks“, „Graph“, „Settings“ …) – alles bleibt über ⌘K erreichbar. */
  onCommand?: (id: string) => void;
}

export function QuickFind({ client, titles, recent, currentPage, onOpen, onClose, onCommand }: Props) {
  const [filters, setFilters] = useState<QuickFindFilters>({ titleOnly: false, inPage: false, date: "any", sort: "bestMatch" });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<QuickFindHit[] | undefined>();
  const [took, setTook] = useState<number | undefined>();
  const [selected, setSelected] = useState(0);
  const listID = useId();
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
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
    void client.search(query, undefined, { filters: toSearchFilters(filters, currentPage?.id), sort: filters.sort }).then((r) => {
      if (!alive || !r) return;
      setHits(r.hits);
      setTook(performance.now() - t0);
      setSelected(0);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, query, filters, currentPage?.id]);

  const pages: QuickFindHit[] = hits ?? recent.filter((r) => titles.has(r.id)).slice(0, 8).map((r) => ({ pageID: r.id, title: titles.get(r.id)!, path: "", kind: "page" }));
  const commands: NavCommand[] = onCommand ? matchCommands(query) : [];
  // Befehle stehen vor den Seiten; die Auswahl läuft über beide
  const items: (QuickFindHit | { command: NavCommand })[] = [...commands.map((c) => ({ command: c })), ...pages];
  const open = (i: number) => {
    const it = items[i];
    if (!it) return;
    if ("command" in it) onCommand?.(it.command.id);
    else onOpen(it.pageID);
  };

  return (
    <div className="qf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Quick Find" className="qf" onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
        // BSD-304: Tab bleibt im Dialog (aria-modal) – vom letzten Element zurück zum ersten und umgekehrt.
        if (e.key === "Tab") {
          const focusables = [...e.currentTarget.querySelectorAll<HTMLElement>("input, button, [href], select, textarea, [tabindex]:not([tabindex='-1'])")]
            .filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
          const first = focusables[0], last = focusables[focusables.length - 1];
          if (!first || !last) return;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
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
        <div className="qf-filters" role="group" aria-label="Filters">
          <button type="button" className="qf-chip" aria-pressed={filters.titleOnly} onClick={() => setFilters((f) => ({ ...f, titleOnly: !f.titleOnly }))}>Title only</button>
          {currentPage ? (
            <button type="button" className="qf-chip" aria-pressed={filters.inPage} title={`Only “${currentPage.title}” and its sub-pages`} onClick={() => setFilters((f) => ({ ...f, inPage: !f.inPage }))}>In this page</button>
          ) : null}
          <label className="qf-chip qf-select" data-active={filters.date !== "any" ? "" : undefined}>
            <span className="sr-only">Edited</span>
            <select aria-label="Edited" value={filters.date} onChange={(e) => setFilters((f) => ({ ...f, date: e.target.value as QuickFindFilters["date"] }))}>
              {DATE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <Icon name="chevron" size={14} />
          </label>
          <label className="qf-chip qf-select" data-active={filters.sort !== "bestMatch" ? "" : undefined}>
            <span className="sr-only">Sort</span>
            <select aria-label="Sort" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as QuickFindFilters["sort"] }))}>
              {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <Icon name="chevron" size={14} />
          </label>
        </div>
        <div className="qf-head t-meta">{hits ? (items.length ? "Best matches" : "") : pages.length ? "Recent" : ""}</div>
        <ul id={listID} role="listbox" aria-label="Results" className="qf-list" data-took={took === undefined ? undefined : took.toFixed(1)}>
          {items.map((h, i) => "command" in h ? (
            <li key={"cmd:" + h.command.id} id={`${listID}-${i}`} role="option" aria-selected={i === selected} className="qf-item" data-testid="qf-command"
              onMouseMove={() => setSelected(i)} onClick={() => open(i)}>
              <span className="tile"><Icon name={COMMAND_ICON[h.command.id] ?? "right"} size={18} /></span>
              <span className="grow"><strong>{h.command.label}</strong><span className="t-desc qf-path"> — {h.command.id === "meeting" ? "Command" : "Go to"}</span></span>
            </li>
          ) : (
            <li
              key={h.pageID}
              id={`${listID}-${i}`}
              role="option"
              aria-selected={i === selected}
              className="qf-item"
              onMouseMove={() => setSelected(i)}
              onClick={() => open(i)}
            >
              <span className="tile"><Icon name={h.kind === "page" ? "page" : "database"} size={18} /></span>
              <span className="grow">
                <strong>{h.title}</strong>
                {h.path ? <span className="t-desc qf-path"> — {h.path}</span> : null}
                {h.snippet ? <span className="t-desc qf-snippet" data-testid="qf-snippet"><Highlight text={h.snippet} query={query} /></span> : null}
              </span>
            </li>
          ))}
          {hits && hits.length === 0 && commands.length === 0 ? <li className="qf-none t-desc">No results</li> : null}
        </ul>
      </div>
    </div>
  );
}

const COMMAND_ICON: Record<string, IconName> = { home: "home", chat: "chat", tasks: "agent", coding: "terminal", graph: "graph", meetings: "mic", meeting: "plus", library: "library", trash: "trash", settings: "settings" };

/** Suchbegriffe im Snippet markieren (Groß/klein egal). */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}</>;
}
