// Quick Find (⌘K): sucht im Store-Worker über den Volltextindex (Titel, Inhalt mit Snippet, Zeilen). Jede Eingabe bricht die vorige
// Suche ab; ohne Eingabe stehen die zuletzt geöffneten Seiten da. Pfeiltasten wählen, Enter öffnet, Esc schließt.
// BSD-206: Filter wie in Notion – nur Titel, in der aktuellen Seite, Zeitraum, Sortierung (shell/quickFindFilters.ts).
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BasedButton, BasedChip, BasedKeys } from "@based/ui/astryx";
import { fold, typoBudget, typoDistance } from "@based/core";
import { useRestoreFocus } from "../shell/restoreFocus.js";
import { Icon, type IconName } from "../icons.js";
import { aiSetting } from "../shell/ai.js";
import { diagnosticsLog } from "../shell/diagnostics.js";
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

/**
 * Review 20.11.: Muss Enter auf die Treffer warten? Ja, wenn die Auswahl auf einer Seite steht (nicht auf einem Befehl –
 * die passen immer zur Eingabe) und die gezeigten Seiten noch nicht zur aktuellen Eingabe gehören.
 */
export function enterWaits(cur: number, commandCount: number, hitsCurrent: boolean): boolean {
  return cur >= commandCount && !hitsCurrent;
}

export function QuickFind({ client, titles, recent, currentPage, onOpen, onClose, onCommand }: Props) {
  const [filters, setFilters] = useState<QuickFindFilters>({ titleOnly: false, inPage: false, date: "any", sort: "bestMatch" });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<QuickFindHit[] | undefined>();
  const [took, setTook] = useState<number | undefined>();
  const [selected, setSelected] = useState(0);
  const listID = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // BSD-304/421/438: Fokus (samt Schreibmarke) beim Schließen dorthin zurück, wo er vorher war (Seitenleiste,
  // Editor …) – außer man hat eine Seite oder einen Befehl geöffnet, dann bestimmt das Ziel den Fokus.
  const opened = useRef(false);
  useRestoreFocus(() => opened.current);
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    void client.warmSearch().catch(() => undefined);
    return () => client.cancelSearch();
  }, [client]);

  // Review 20.11. (Beta-Weg 6): Enter, bevor die Treffer zur Eingabe da sind, öffnete den obersten Eintrag der alten Liste
  // (zuletzt geöffnete Seiten oder Treffer der vorigen Eingabe) – meist die Seite, die schon offen war. Jetzt wartet
  // Enter auf die Treffer genau dieser Eingabe; Befehle stehen sofort fest und öffnen gleich.
  const searchKey = query.trim() ? JSON.stringify([query, filters, currentPage?.id]) : "";
  const shownFor = useRef("");
  const pendingEnter = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!query.trim()) {
      setHits(undefined);
      setTook(undefined);
      shownFor.current = "";
      return;
    }
    let alive = true;
    const t0 = performance.now();
    void client.search(query, undefined, { filters: toSearchFilters(filters, currentPage?.id), sort: filters.sort }).then((r) => {
      if (!alive || !r) return;
      shownFor.current = searchKey;
      setHits(r.hits);
      setTook(performance.now() - t0);
      setSelected(0);
    }).catch((e: unknown) => {
      // BSD-643: Die Suche ist gescheitert (Worker-Fehler). Ohne das bliebe ein wartendes Enter für immer stehen:
      // leere Liste zu dieser Eingabe zeigen (das wartende Enter verfällt dann ohne Treffer), Grund ins Diagnose-Log.
      if (!alive) return;
      diagnosticsLog.add("warning", `quick find: search failed (${e instanceof Error ? e.message : String(e)})`);
      shownFor.current = searchKey;
      setHits([]);
      setTook(undefined);
      setSelected(0);
    });
    return () => {
      alive = false;
    };
  }, [client, query, filters, currentPage?.id]);

  const pages: QuickFindHit[] = hits ?? recent.filter((r) => titles.has(r.id)).slice(0, 8).map((r) => ({ pageID: r.id, title: titles.get(r.id)!, path: "", kind: "page" }));
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  const commands: NavCommand[] = onCommand ? matchCommands(query, { ai }) : [];
  // Befehle stehen vor den Seiten; die Auswahl läuft über beide
  const items: (QuickFindHit | { command: NavCommand })[] = [...commands.map((c) => ({ command: c })), ...pages];
  // BSD-439: Befehle fallen beim Tippen sofort weg, Treffer kommen später – die Auswahl bleibt nie hinter dem Listenende.
  const cur = Math.min(selected, Math.max(0, items.length - 1));
  // Die Auswahl bleibt sichtbar, wenn man mit den Pfeiltasten über den Rand der Liste hinausgeht.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [cur, items.length]);
  const filtered = filters.titleOnly || filters.inPage || filters.date !== "any";
  const setFilter = (next: Partial<QuickFindFilters>) => {
    setFilters((f) => ({ ...f, ...next }));
    input.current?.focus(); // nach „Clear filters“ weitertippen können
  };
  const open = (i: number) => {
    const it = items[i];
    if (!it) return;
    opened.current = true;
    if ("command" in it) onCommand?.(it.command.id);
    else onOpen(it.pageID);
  };
  const enter = () => {
    if (enterWaits(cur, commands.length, shownFor.current === searchKey)) pendingEnter.current = cur;
    else open(cur);
  };
  // Die Treffer zur Eingabe sind da: ein wartendes Enter öffnet jetzt (gleiche Stelle in der neuen Liste).
  useEffect(() => {
    const i = pendingEnter.current;
    if (i === undefined || shownFor.current !== searchKey) return;
    pendingEnter.current = undefined;
    open(i);
  }, [hits, searchKey]);

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
            aria-activedescendant={items[cur] ? `${listID}-${cur}` : undefined}
            aria-label="Search pages"
            placeholder="Search pages and content…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); pendingEnter.current = undefined; }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected(Math.min(items.length - 1, cur + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected(Math.max(0, cur - 1));
              } else if (e.key === "PageDown" || e.key === "PageUp") {
                e.preventDefault();
                setSelected(Math.max(0, Math.min(items.length - 1, cur + (e.key === "PageDown" ? PAGE : -PAGE))));
              } else if (e.key === "Enter") {
                e.preventDefault();
                enter();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="qf-filters" role="group" aria-label="Filters">
          <BasedChip label="Title only" pressed={filters.titleOnly} onChange={(on) => setFilters((f) => ({ ...f, titleOnly: on }))} />
          {currentPage ? (
            <BasedChip label="In this page" pressed={filters.inPage} tooltip={`Only “${currentPage.title}” and its sub-pages`} onChange={(on) => setFilters((f) => ({ ...f, inPage: on }))} />
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
        <div className="qf-head t-meta" data-testid="qf-head">{hits ? (items.length ? (hits.length > 0 && hits.every((h) => h.approx) ? "Closest matches" : "Best matches") : "") : pages.length ? "Recent" : ""}</div>
        <ul ref={list} id={listID} role="listbox" aria-label="Results" className="qf-list" data-took={took === undefined ? undefined : took.toFixed(1)}>
          {items.map((h, i) => "command" in h ? (
            <li key={"cmd:" + h.command.id} id={`${listID}-${i}`} role="option" aria-selected={i === cur} className="qf-item" data-testid="qf-command"
              onMouseMove={() => setSelected(i)} onClick={() => open(i)}>
              <span className="tile"><Icon name={COMMAND_ICON[h.command.id] ?? "right"} size={18} /></span>
              <span className="grow"><strong>{h.command.label}</strong><span className="t-desc qf-path"> — {h.command.id === "meeting" ? "Command" : "Go to"}</span></span>
            </li>
          ) : (
            <li
              key={h.pageID}
              id={`${listID}-${i}`}
              role="option"
              aria-selected={i === cur}
              className="qf-item"
              onMouseMove={() => setSelected(i)}
              onClick={() => open(i)}
            >
              <span className="tile"><Icon name={h.kind === "page" ? "page" : "database"} size={18} /></span>
              <span className="grow">
                <strong><Highlight text={h.title} query={query} /></strong>
                {h.path ? <span className="t-desc qf-path"> — {h.path}</span> : null}
                {h.snippet ? <span className="t-desc qf-snippet" data-testid="qf-snippet"><Highlight text={h.snippet} query={query} /></span> : null}
              </span>
            </li>
          ))}
          {hits && hits.length === 0 && commands.length === 0 ? (
            <li className="qf-none" data-testid="qf-none">
              <strong>No results for “{query.trim()}”</strong>
              <span className="t-desc">{filtered ? "The filters above narrow the search." : "Check the spelling, or try fewer or different words."}</span>
              {filtered ? <BasedButton label="Clear filters" onClick={() => setFilter({ titleOnly: false, inPage: false, date: "any" })} /> : null}
            </li>
          ) : null}
        </ul>
        <div className="qf-foot t-meta" aria-hidden="true">
          <span><BasedKeys keys="ArrowUp / ArrowDown" /> Select</span>
          <span><BasedKeys keys="Enter" /> Open</span>
          <span><BasedKeys keys="Escape" /> Close</span>
        </div>
      </div>
    </div>
  );
}

const COMMAND_ICON: Record<string, IconName> = { home: "home", chat: "chat", tasks: "agent", coding: "terminal", graph: "graph", meetings: "mic", meeting: "plus", library: "library", trash: "trash", settings: "settings" };

const PAGE = 8;

/**
 * Markiert, was die Suche gemeint hat: die Begriffe selbst (Groß/klein und Akzente egal) und – wenn ein Begriff so
 * nicht vorkommt – das Wort, das ihm bis auf Tippfehler gleicht (gleiche Regel wie die Suche im Worker).
 */
export function highlightRanges(text: string, query: string): [number, number][] {
  const terms = fold(query.trim()).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const folded = fold(text);
  // `fold` kann die Länge ändern (ß → ss): dann lieber nichts markieren als an der falschen Stelle.
  if (folded.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (const t of terms) {
    let found = false;
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) { ranges.push([i, i + t.length]); found = true; }
    const budget = typoBudget(t);
    if (found || budget === 0) continue;
    const letters = (x: string) => [...x].sort().join("");
    for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
      const w = m[0];
      // drei Buchstaben: nur vertauscht (wie die Suche), sonst träfe fast jedes kurze Wort
      const near = t.length === 3
        ? w.length === 3 && letters(w) === letters(t) && typoDistance(w, t, 1) <= 1
        : typoDistance(w, t, budget) <= budget || (w.length > t.length && typoDistance(w.slice(0, t.length), t, budget) <= budget);
      if (w.length >= 3 && near) ranges.push([m.index, m.index + w.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, z] of ranges) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a}>{text.slice(a, z)}</mark>);
    at = z;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
