// Elija 17.11.: Seiten und Boards ineinander – ein Board mitten in einer Seite (/whiteboard) und eine ganze,
// bearbeitbare Seite auf einem Board. Beide öffnen ihre eigene Replik der Seite (wie PageView) und zeigen den
// Editor bzw. die Board-Fläche der App. Tiefe begrenzt: ein Board in einer Seite in einem Board … endet nach zwei Stufen.
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { BoardView } from "@based/editor";
import type { WorkspaceStore } from "@based/core";
import { assets } from "../assetBridge.js";
import { slots } from "../slots.js";
import { pickPage } from "../shell/pagePick.js";
import type { PageReplica, StoreClient } from "../worker/client.js";

const Depth = createContext(0);
export const EMBED_DEPTH_MAX = 2;

function useReplica(client: StoreClient, pageID: string): { store?: WorkspaceStore; failed?: boolean } {
  const [state, setState] = useState<{ store?: WorkspaceStore; failed?: boolean }>({});
  useEffect(() => {
    let alive = true;
    let opened: PageReplica | undefined;
    client.openPage(pageID).then((r) => {
      if (alive) { opened = r; setState({ store: r.store }); } else r.close();
    }, () => alive && setState({ failed: true }));
    return () => { alive = false; opened?.close(); };
  }, [client, pageID]);
  const store = state.store;
  useSyncExternalStore(store ? (fn) => store.observe(() => fn()) : () => () => undefined, () => store?.revision ?? -1);
  return state;
}

/** Eine ganze Seite (Editor der App) – auf einem Board. `editable`: die Karte ist gewählt. */
export function EmbeddedPage({ client, pageID, editable, onOpenPage }: { client: StoreClient; pageID: string; editable: boolean; onOpenPage: (id: string) => void }) {
  const depth = useContext(Depth);
  const { store, failed } = useReplica(client, pageID);
  const Editor = slots.PageEditor;
  if (failed) return <p className="t-desc">This page can't be shown here.</p>;
  if (!store || !Editor) return <p className="t-desc" aria-busy="true">Loading…</p>;
  if (depth >= EMBED_DEPTH_MAX) return <p className="t-desc">Open the page to see more.</p>;
  return (
    <Depth.Provider value={depth + 1}>
      <Editor store={store} pageID={pageID} readOnly={!editable || store.isReadOnly} onOpenPage={onOpenPage} embedded />
    </Depth.Provider>
  );
}

/** Ein Board mitten in einer Seite (Board-Unterseite). */
export function EmbeddedBoard({ client, pageID, onOpenPage }: { client: StoreClient; pageID: string; onOpenPage: (id: string) => void }) {
  const depth = useContext(Depth);
  const { store, failed } = useReplica(client, pageID);
  const titles = useSyncExternalStore(client.subscribe, () => client.getState().titles);
  if (failed) return <p className="t-desc">This board can't be shown here.</p>;
  if (!store) return <p className="t-desc" aria-busy="true">Loading…</p>;
  if (depth >= EMBED_DEPTH_MAX) return <p className="t-desc">Open the board to see more.</p>;
  const files = assets();
  return (
    <Depth.Provider value={depth + 1}>
      <BoardView store={store} pageID={pageID} readOnly={store.isReadOnly} onOpenPage={onOpenPage} pageTitles={titles} pickPage={pickPage}
        renderPage={(id, editable) => <EmbeddedPage client={client} pageID={id} editable={editable} onOpenPage={onOpenPage} />}
        {...(files ? { uploadFile: (f: File) => files.uploadFile(f), resolveFileUrl: (u: string) => files.resolveFileUrl(u) } : {})} />
    </Depth.Provider>
  );
}
