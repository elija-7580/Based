// Backlinks am Seitenende: Seiten, die diese Seite erwähnen oder verlinken (Index im Store-Worker). Frischt sich
// auf, wenn sich Titel oder Seitenstruktur ändern und wenn das Fenster wieder in den Vordergrund kommt.
import { useEffect, useState, useSyncExternalStore } from "react";
import { isEmojiIcon } from "@based/editor";
import { Icon } from "../icons.js";
import type { StoreClient } from "../worker/client.js";
import type { PageInfo } from "../worker/protocol.js";
import "./backlinks.css";

export function Backlinks({ client, pageID, onOpenPage }: { client: StoreClient; pageID: string; onOpenPage: (id: string) => void }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [links, setLinks] = useState<PageInfo[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    let alive = true;
    void client.backlinks(pageID).then((r) => alive && setLinks(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [client, pageID, state.titles, state.outline, tick]);
  if (links.length === 0) return null;
  return (
    <section className="backlinks" aria-label="Backlinks" data-testid="backlinks">
      <h2 className="t-meta backlinks-head">{links.length} {links.length === 1 ? "backlink" : "backlinks"}</h2>
      <ul className="backlinks-list">
        {links.map((p) => (
          <li key={p.id}>
            <button type="button" className="backlink" onClick={() => onOpenPage(p.id)}>
              <span className="backlink-icon" aria-hidden="true">{isEmojiIcon(p.icon) ? p.icon : <Icon name={p.kind === "database" ? "database" : "page"} size={18} />}</span>
              <span className="backlink-title">{p.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
