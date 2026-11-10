// Seite: Vor/Zurück, Breadcrumb, Titel, Metazeile; Inhalt im Steckplatz für @based/editor (bis dahin Lese-Darstellung),
// Datenbankseiten im Steckplatz für @based/database-ui (bis dahin Platzhalter). Die Inhalte kommen aus einer
// Seiten-Replik (StoreClient.openPage), der Titel aus der Titel-Tabelle des Workers.
import { rowsOf, type WorkspaceStore } from "@based/core";
import { isOutlineHidden, setOutlineHidden } from "@based/editor";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BlockView } from "../components/BlockView.js";
import { ExportDialog } from "../components/ImportExport.js";
import { VersionHistory } from "../components/VersionHistory.js";
import { SYNC_LABEL } from "../components/Sidebar.js";
import { Icon } from "../icons.js";
import { fromSwift, longDate, relative } from "../shell/format.js";
import type { History, Route } from "../shell/router.js";
import { slots } from "../slots.js";
import type { PageReplica, ShellState, StoreClient } from "../worker/client.js";
import type { HistoryRestoreResult } from "../worker/protocol.js";

interface Props {
  client: StoreClient;
  state: ShellState;
  pageID: string;
  history: History;
  onOpenPage: (id: string) => void;
  onNavigate: (r: Route) => void;
}

const noop = () => () => undefined;

function useRevision(store: WorkspaceStore | undefined) {
  return useSyncExternalStore(store ? (fn) => store.observe(() => fn()) : noop, () => store?.revision ?? -1);
}

export function PageView({ client, state, pageID, history, onOpenPage, onNavigate }: Props) {
  const [replica, setReplica] = useState<PageReplica | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    let alive = true;
    let opened: PageReplica | undefined;
    client.openPage(pageID).then((r) => {
      if (alive) {
        opened = r;
        setReplica(r);
      } else r.close();
    }, (e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
      opened?.close();
    };
  }, [client, pageID]);
  useRevision(replica?.store);
  const [menu, setMenu] = useState<{ top: number; right: number } | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restored, setRestored] = useState<HistoryRestoreResult | undefined>();
  useSyncExternalStore(history.subscribe, () => `${history.canBack}${history.canForward}`);

  const store = replica?.store;
  const page = store?.blocks.get(pageID);
  const title = state.titles.get(pageID) ?? "";
  const outline = state.outline;
  const trashed = page?.trashedAt !== undefined;
  const readOnly = trashed || state.status.state === "readonly";

  // Breadcrumb: Abschnitt und Elternseiten aus der Seitenleisten-Struktur.
  const crumbs: { id?: string; label: string }[] = [];
  const node = outline?.nodes[pageID];
  if (node) {
    const chain: string[] = [];
    for (let p = node.parent, n = 0; p && n < 100; p = outline?.nodes[p]?.parent, n++) chain.unshift(p);
    const section = outline?.sections.find((s) => s.id === node.section);
    if (section && (outline?.sections.length ?? 0) > 1) crumbs.push({ label: section.name });
    for (const id of chain) crumbs.push({ id, label: state.titles.get(id) ?? "Untitled" });
  }

  const favorite = outline?.favorites.includes(pageID) ?? false;
  const subpages = outline?.children[pageID]?.length ?? 0;
  const dbID = page?.type === "databasePage" ? page.props?.databaseID : undefined;

  let body;
  if (failed) body = <p className="t-desc">Couldn't open this page: {failed}</p>;
  else if (!store) body = <p className="t-desc" aria-busy="true">Opening…</p>;
  else if (!page) body = <p className="t-desc">This page was deleted.</p>;
  else if (dbID) {
    const View = slots.DatabaseView;
    body = View
      ? <View store={store} blockID={pageID} databaseID={dbID} readOnly={readOnly} onOpenPage={onOpenPage} />
      : <DatabasePlaceholder store={store} databaseID={dbID} title={title} />;
  } else {
    const Editor = slots.PageEditor;
    body = Editor
      ? <Editor store={store} pageID={pageID} readOnly={readOnly} onOpenPage={onOpenPage} />
      : <BlockView store={store} pageID={pageID} readOnly={readOnly} onOpenPage={onOpenPage} />;
  }

  return (
    <>
      <header className="topbar t-desc">
        <div className="history-buttons">
          <button type="button" className="icon-btn ghost" aria-label="Back" title="Back (⌘[)" disabled={!history.canBack} onClick={() => history.back()}><Icon name="back" size={18} /></button>
          <button type="button" className="icon-btn ghost" aria-label="Forward" title="Forward (⌘])" disabled={!history.canForward} onClick={() => history.forward()}><Icon name="forward" size={18} /></button>
        </div>
        <nav aria-label="Breadcrumb" className="breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {c.id ? <button type="button" className="crumb-link" onClick={() => onOpenPage(c.id!)}>{c.label}</button> : <span>{c.label}</span>}
              <span aria-hidden="true">/</span>
            </span>
          ))}
          <span className="crumb-current" aria-current="page">{title || "Untitled"}</span>
        </nav>
        <span className="spacer">{state.status.state === "synced" || state.status.state === "local" ? "Saved" : SYNC_LABEL[state.status.state]}</span>
        {page && !trashed ? (
          <>
            <button type="button" className="icon-btn ghost" aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"} aria-pressed={favorite} title="Favorite" onClick={() => void client.command({ op: "favorite", ids: [pageID], on: !favorite })}>
              <Icon name="star" size={18} filled={favorite} />
            </button>
            <button type="button" className="btn ghost" onClick={() => setExporting(true)}>Export</button>
            <button type="button" className="icon-btn ghost" aria-label="Page menu" data-menu-trigger="" aria-haspopup="menu" aria-expanded={menu !== undefined} title="More" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? undefined : { top: r.bottom + 4, right: window.innerWidth - r.right });
            }}>
              <Icon name="more" size={18} />
            </button>
            <button type="button" className="icon-btn ghost" aria-label="Move to Trash" title="Move to Trash" onClick={() => {
              void client.command({ op: "trash", ids: [pageID] });
              onNavigate({ name: "home" });
            }}>
              <Icon name="trash" size={18} />
            </button>
          </>
        ) : null}
      </header>
      {menu ? (
        <PageMenu pos={menu} onClose={() => setMenu(undefined)} onHistory={() => { setMenu(undefined); setHistoryOpen(true); }}
          outline={store && page && !dbID && !readOnly ? { hidden: isOutlineHidden(store, pageID), toggle: () => { setMenu(undefined); setOutlineHidden(store, pageID, !isOutlineHidden(store, pageID)); } } : undefined} />
      ) : null}
      {historyOpen ? (
        <VersionHistory client={client} pageID={pageID} current={store} onClose={() => setHistoryOpen(false)} onRestored={(r) => {
          setHistoryOpen(false);
          setRestored(r);
        }} />
      ) : null}
      {restored ? (
        <div className="vh-toast" role="status" data-testid="restored-banner">
          <span>Version restored. The previous state is kept in Version history.{restored.copied ? ` ${restored.copied} ${restored.copied === 1 ? "block lives" : "blocks live"} on another page now and came back as a copy.` : ""}</span>
          <button type="button" className="btn" onClick={() => {
            setRestored(undefined);
            void client.command({ op: "undo" });
          }}>Undo</button>
          <button type="button" className="btn ghost" onClick={() => setRestored(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {trashed ? (
        <div className="trash-banner" role="status">
          <span>This page is in the Trash.</span>
          <button type="button" className="btn" onClick={() => void client.command({ op: "restore", ids: [pageID] })}>Restore</button>
          <button type="button" className="btn ghost" onClick={() => {
            void client.command({ op: "deleteForever", ids: [pageID] });
            onNavigate({ name: "trash" });
          }}>Delete forever</button>
        </div>
      ) : null}
      <article className="page">
        <div className="page-grid">
          <div className="spacer-cell" />
          <div className="page-head">
            <TitleField id={pageID} title={title} readOnly={readOnly || !page} onRename={(t) => void client.command({ op: "rename", id: pageID, title: t })} />
            {page ? (
              <div className="meta-line t-desc">
                <span>Edited {relative(fromSwift(page.updatedAt))}</span>
                <span>Created {longDate(fromSwift(page.createdAt))}</span>
                {subpages ? <span>{subpages} {subpages === 1 ? "sub-page" : "sub-pages"}</span> : null}
              </div>
            ) : null}
          </div>
          <div className="spacer-cell" />
          <div className="page-body" data-testid="page-content">{body}</div>
        </div>
      </article>
      {exporting ? <ExportDialog client={client} pageID={pageID} onClose={() => setExporting(false)} /> : null}
    </>
  );
}

/** Seitenmenü (⋯) in der Kopfzeile. */
function PageMenu({ pos, onClose, onHistory, outline }: { pos: { top: number; right: number }; onClose: () => void; onHistory: () => void; outline?: { hidden: boolean; toggle: () => void } | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.("[data-menu-trigger]")) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" aria-label="Page menu" className="menu page-menu" style={{ top: pos.top, right: pos.right }}>
      <button type="button" role="menuitem" className="menu-item" onClick={onHistory}><Icon name="restore" size={18} />Version history</button>
      {outline ? <button type="button" role="menuitem" className="menu-item" onClick={outline.toggle}><Icon name="page" size={18} />{outline.hidden ? "Show outline" : "Hide outline"}</button> : null}
    </div>
  );
}

/** Titel als Eingabefeld; Änderungen gehen sofort an den Worker (dort zu einem Undo-Schritt zusammengefasst). */
function TitleField({ id, title, readOnly, onRename }: { id: string; title: string; readOnly: boolean; onRename: (t: string) => void }) {
  const [value, setValue] = useState(title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(title === "Untitled" ? "" : title);
  }, [title, id]);
  return (
    <h1 className="t-title page-title">
      <input
        aria-label="Page title"
        className="title-input"
        placeholder="Untitled"
        value={value}
        readOnly={readOnly}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => {
          setValue(e.target.value);
          onRename(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </h1>
  );
}

/** Bis @based/database-ui eingesteckt ist: Titel und Zeilenzahl. */
function DatabasePlaceholder({ store, databaseID, title }: { store: WorkspaceStore; databaseID: string; title: string }) {
  const db = store.databases.get(databaseID);
  const rows = db ? rowsOf(store, databaseID).length : 0;
  const views = [...store.views.values()].filter((v) => v.databaseID === databaseID).length;
  return (
    <div className="group db-placeholder" data-testid="database-placeholder">
      <div className="row">
        <span className="tile"><Icon name="database" /></span>
        <span className="grow">
          <strong>{title || "Untitled database"}</strong>
          <span className="t-desc" style={{ display: "block" }}>{rows} {rows === 1 ? "row" : "rows"} · {views} {views === 1 ? "view" : "views"} · table view coming with the database package</span>
        </span>
      </div>
    </div>
  );
}

