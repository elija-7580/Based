// Backlinks am Seitenende: Seiten, die diese Seite erwähnen oder verlinken (Index im Store-Worker). Frischt sich
// auf, wenn sich Titel oder Seitenstruktur ändern und wenn das Fenster wieder in den Vordergrund kommt.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconView } from "@based/editor";
import { BasedButton } from "@based/ui/astryx";
import { Icon } from "../icons.js";
import type { StoreClient } from "../worker/client.js";
import type { PageInfo, UnlinkedMentionInfo } from "../worker/protocol.js";
import "./backlinks.css";

/** Ruhe nach Änderungen an Titeln/Outline, bevor neu abgefragt wird. */
const REFRESH_MS = 1500;
/** Fensterfokus fragt höchstens so oft neu ab. */
const FOCUS_MS = 30_000;

export function Backlinks({ client, pageID, onOpenPage }: { client: StoreClient; pageID: string; onOpenPage: (id: string) => void }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [links, setLinks] = useState<PageInfo[]>([]);
  // BSD-90: unverlinkte Erwähnungen (eingeklappt wie in Obsidian; „Link“ macht die Stelle zur Erwähnung)
  const [unlinked, setUnlinked] = useState<UnlinkedMentionInfo[]>([]);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [tick, setTick] = useState(0);
  // Feedback 20. 11.: Jede Sync-Änderung (Titel, Outline) und jedes Zurückkommen ins Fenster fragte Backlinks und
  // unverlinkte Erwähnungen sofort neu ab. Die Abfragen stellen sich im Store-Worker vor alles andere – Seiten aus
  // Suche und Seitenleiste öffneten dann erst nach dem zweiten, dritten Klick. Jetzt: beim Öffnen einmal, danach
  // gebündelt (Ruhe von REFRESH_MS), beim Fokus höchstens alle FOCUS_MS.
  const last = useRef(0);
  useEffect(() => {
    const again = () => { if (Date.now() - last.current >= FOCUS_MS) setTick((n) => n + 1); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  const seen = useRef<{ titles: unknown; outline: unknown } | undefined>(undefined);
  useEffect(() => {
    const prev = seen.current;
    seen.current = { titles: state.titles, outline: state.outline };
    if (!prev) return;
    const t = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearTimeout(t);
  }, [state.titles, state.outline]);
  useEffect(() => {
    let alive = true;
    last.current = Date.now();
    void client.backlinks(pageID).then((r) => alive && setLinks(r), () => undefined);
    void client.unlinkedMentions(pageID).then((r) => alive && setUnlinked(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [client, pageID, tick]);
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
