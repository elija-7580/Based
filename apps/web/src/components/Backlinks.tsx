// Backlinks am Seitenende: Seiten, die diese Seite erwähnen oder verlinken (Index im Store-Worker). Frischt sich
// auf, wenn sich Titel oder Seitenstruktur ändern und wenn das Fenster wieder in den Vordergrund kommt; unverlinkte
// Erwähnungen nur, wenn sich der eigene Titel ändert (sie durchsuchen den ganzen Text).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconView } from "@based/editor";
import { BasedButton } from "@based/ui/astryx";
import { Icon } from "../icons.js";
import type { StoreClient } from "../worker/client.js";
import type { PageInfo, UnlinkedMentionInfo } from "../worker/protocol.js";
import "./backlinks.css";

/** Nach einer Änderung kurz warten: Tippen im Titel fragt nicht je Taste neu (unverlinkte Erwähnungen gehen über
 *  den ganzen Text des Workspaces, bei 20 000 Seiten ~120 ms im Store-Worker). */
const REFRESH_DELAY_MS = 400;

/**
 * `load` ausführen, wenn sich `deps` ändern: sofort beim ersten Mal und wenn sich `now` ändert (andere Seite, Fenster
 * wieder vorn, „Link“ geklickt), sonst gesammelt nach REFRESH_DELAY_MS. Eine abgebrochene sofortige Anfrage (React
 * baut den Effekt im Entwicklungsmodus doppelt auf) gilt als nicht gestellt.
 */
function useRefresh<T>(now: string, deps: readonly unknown[], load: () => Promise<T>, set: (v: T) => void) {
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    let alive = true, done = false;
    const run = () => void load().then((r) => { done = true; if (alive) set(r); }, () => { done = true; });
    const immediate = shown.current !== now;
    shown.current = now;
    const t = immediate ? (run(), undefined) : setTimeout(run, REFRESH_DELAY_MS);
    return () => {
      alive = false;
      if (t !== undefined) clearTimeout(t);
      else if (!done) shown.current = undefined;
    };
  }, [now, ...deps]); // `deps` bestimmt der Aufrufer (gleich lang bei jedem Aufruf)
}

export function Backlinks({ client, pageID, onOpenPage }: { client: StoreClient; pageID: string; onOpenPage: (id: string) => void }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [links, setLinks] = useState<PageInfo[]>([]);
  // BSD-90: unverlinkte Erwähnungen (eingeklappt wie in Obsidian; „Link“ macht die Stelle zur Erwähnung)
  const [unlinked, setUnlinked] = useState<UnlinkedMentionInfo[]>([]);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  const now = `${pageID}\u0001${tick}`;
  // Backlinks kommen aus einem Index (billig) und zeigen Titel anderer Seiten: bei Titel- und Strukturänderungen neu.
  useRefresh(now, [client, state.titles, state.outline], () => client.backlinks(pageID), setLinks);
  // Unverlinkte Erwähnungen hängen am Titel dieser Seite (gesucht wird er im Text der anderen): nur neu fragen, wenn
  // er sich ändert, die Seite wechselt oder das Fenster wieder nach vorn kommt – nicht bei jedem anderen Titel.
  useRefresh(now, [client, state.titles.get(pageID)], () => client.unlinkedMentions(pageID), setUnlinked);
  if (links.length === 0 && unlinked.length === 0) return null;
  const link = (m: UnlinkedMentionInfo) => {
    void client.command({ op: "linkMention", blockID: m.blockID, start: m.start, length: m.length, pageID }).then(() => setTick((n) => n + 1), () => undefined);
  };
  return (
    <section className="backlinks" aria-label="Backlinks" data-testid="backlinks">
      {links.length > 0 ? <h2 className="t-meta backlinks-head">{links.length} {links.length === 1 ? "backlink" : "backlinks"}</h2> : null}
      <ul className="backlinks-list">
        {links.map((p) => (
          <li key={p.id}>
            <button type="button" className="backlink" onClick={() => onOpenPage(p.id)}>
              <span className="backlink-icon" aria-hidden="true"><IconView icon={p.icon} fallback={<Icon name={p.kind === "database" ? "database" : "page"} size={18} />} /></span>
              <span className="backlink-title">{p.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {unlinked.length > 0 ? (
        <>
          <button type="button" className="t-meta backlinks-head backlinks-toggle" aria-expanded={showUnlinked} onClick={() => setShowUnlinked((v) => !v)} data-testid="unlinked-toggle">
            <Icon name="chevron" size={14} />{unlinked.length} unlinked {unlinked.length === 1 ? "mention" : "mentions"}
          </button>
          {showUnlinked ? (
            <ul className="backlinks-list" data-testid="unlinked-list">
              {unlinked.map((m) => (
                <li key={`${m.blockID}:${m.start}`} className="unlinked">
                  <button type="button" className="backlink" onClick={() => onOpenPage(m.pageID)}>
                    <span className="backlink-icon" aria-hidden="true"><Icon name="page" size={18} /></span>
                    <span className="backlink-title">{m.pageTitle}</span>
                    <span className="t-desc unlinked-snippet">{m.snippet}</span>
                  </button>
                  <BasedButton label="Link" variant="ghost" ariaLabel={`Link the mention in ${m.pageTitle}`} onClick={() => link(m)} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
