// Seite: Vor/Zurück, Breadcrumb, Titel, Metazeile; Inhalt im Steckplatz für @based/editor (bis dahin Lese-Darstellung),
// Datenbankseiten im Steckplatz für @based/database-ui (bis dahin Platzhalter). Die Inhalte kommen aus einer
// Seiten-Replik (StoreClient.openPage), der Titel aus der Titel-Tabelle des Workers.
import { importPendingSource, pageFormat, pageTextStats, rowsOf, setPageFormat, setPageIcon, subtree, type Outline, type PageFont, type PageFormatPatch, type WorkspaceStore } from "@based/core";
import { EmojiPicker, isEmojiIcon, isOutlineHidden, setOutlineHidden } from "@based/editor";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { isChatPanelOpen, subscribeChatPanel, toggleChatPanel } from "../chat/runtime.js";
import { BlockView } from "../components/BlockView.js";
import { aiSetting } from "../shell/ai.js";
import { openPageWindow } from "../desktop.js";
import { FindBar } from "../components/FindBar.js";
import { ExportDialog } from "../components/ImportExport.js";
import { MoveDialog } from "../components/MoveDialog.js";
import { CoverPicker, PageCoverBand, uploadPageIcon, useImageURL } from "../components/PageCover.js";
import { ShareButton } from "../components/Share.js";
import { VersionHistory } from "../components/VersionHistory.js";
import { SYNC_LABEL } from "../components/Sidebar.js";
import { Icon } from "../icons.js";
import { hybridImport } from "../worker/notionHybridClient.js";
import { fromSwift, longDate, relative } from "../shell/format.js";
import { mayDeleteForever } from "../shell/guest.js";
import { routeToHash, type History, type Route } from "../shell/router.js";
import { FIND_EVENT, type ShortcutAction } from "../shell/shortcuts.js";
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
  /** BSD-101: Sprungziel aus einem Block-Link. */
  focusBlock?: string | undefined;
}

const noop = () => () => undefined;

function useRevision(store: WorkspaceStore | undefined) {
  return useSyncExternalStore(store ? (fn) => store.observe(() => fn()) : noop, () => store?.revision ?? -1);
}

export function PageView({ client, state, pageID, history, onOpenPage, onNavigate, focusBlock }: Props) {
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
  const [moving, setMoving] = useState(false);
  const [restored, setRestored] = useState<HistoryRestoreResult | undefined>();
  useSyncExternalStore(history.subscribe, () => `${history.canBack}${history.canForward}`);

  // BSD-206: Suchen in der Seite (⌘F, ⌘G / ⇧⌘G).
  const article = useRef<HTMLElement>(null);
  const [find, setFind] = useState<{ focus: number; step: { n: number; delta: 1 | -1 } } | undefined>();
  useEffect(() => {
    const on = (e: Event) => {
      const a = (e as CustomEvent<ShortcutAction>).detail;
      e.preventDefault();
      // Sofort zeichnen: das Feld hat den Fokus, bevor die nächste Taste kommt.
      flushSync(() => setFind((f) => {
        if (a.kind === "findStep" && f) return { ...f, step: { n: f.step.n + 1, delta: a.delta } };
        return { focus: (f?.focus ?? 0) + 1, step: f?.step ?? { n: 0, delta: 1 } };
      }));
    };
    window.addEventListener(FIND_EVENT, on);
    return () => window.removeEventListener(FIND_EVENT, on);
  }, []);
  const findRoot = useRef(() => article.current).current;
  // Wie Notion: ↑ in der ersten Textzeile (oder Rücktaste in einer leeren ersten Zeile) geht in den Titel.
  useEffect(() => {
    const el = article.current;
    if (!el) return;
    const on = (e: Event) => {
      const field = el.querySelector<HTMLTextAreaElement>(".title-input");
      if (!field) return;
      e.preventDefault();
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    };
    el.addEventListener("bx:leave-top", on);
    return () => el.removeEventListener("bx:leave-top", on);
  }, []);

  const store = replica?.store;
  const page = store?.blocks.get(pageID);
  const title = state.titles.get(pageID) ?? "";
  const outline = state.outline;
  const trashed = page?.trashedAt !== undefined;
  // BSD-201: Seiten-Optionen (Icon, Schrift, Small text, Full width, Sperre) aus den Block-Props.
  const format = store && page ? pageFormat(store, pageID) : { font: "default" as const, smallText: false, fullWidth: false, locked: false };
  const icon = typeof page?.props?.icon === "string" && isEmojiIcon(page.props.icon) ? page.props.icon : undefined;
  const [iconPicker, setIconPicker] = useState(false);
  // BSD-201 Teil 2: Bild als Icon (Swift PageIcon.asset / .url) und Cover.
  const rawIcon = page?.props?.icon as { asset?: { id: string; name: string }; url?: string } | string | undefined;
  const iconImage = rawIcon && typeof rawIcon === "object" ? (rawIcon.asset ? { asset: rawIcon.asset } : rawIcon.url ? { url: rawIcon.url } : undefined) : undefined;
  const iconImageURL = useImageURL(iconImage);
  const [coverPicker, setCoverPicker] = useState(false);
  const iconFile = useRef<HTMLInputElement>(null);
  const storeReadOnly = trashed || state.status.state === "readonly";
  // BSD-317: Seite aus dem Notion-Import, deren Inhalt noch nachgeladen wird – gesperrt, Öffnen zieht sie vor.
  const pendingImport = importPendingSource(page) !== undefined;
  useEffect(() => { if (pendingImport) hybridImport.prioritize(pageID); }, [pendingImport, pageID]);
  const readOnly = storeReadOnly || format.locked || pendingImport;

  // Breadcrumb: Abschnitt und Elternseiten aus der Seitenleisten-Struktur.
  const crumbs: { id?: string; label: string }[] = [];
  const node = outline?.nodes[pageID];
  // BSD-168: Datenbank-Zeilen fehlen in der Seitenleisten-Struktur – ihre Kette (Datenbankseite, Seiten darüber)
  // fragt die Seite beim Worker nach.
  const [rowChain, setRowChain] = useState<string[]>();
  const outsideOutline = outline !== undefined && !node;
  useEffect(() => {
    if (!outsideOutline) return setRowChain(undefined);
    let live = true;
    void client.command<string[]>({ op: "pageAncestors", id: pageID }).then((c) => { if (live) setRowChain(c); }, () => undefined);
    return () => { live = false; };
  }, [client, pageID, outsideOutline, state.titles]);
  if (!node && rowChain) for (const id of rowChain) crumbs.push({ id, label: state.titles.get(id) ?? "Untitled" });
  if (node) {
    const chain: string[] = [];
    for (let p = node.parent, n = 0; p && n < 100; p = outline?.nodes[p]?.parent, n++) chain.unshift(p);
    const section = outline?.sections.find((s) => s.id === node.section);
    if (section && (outline?.sections.length ?? 0) > 1) crumbs.push({ label: section.name });
    for (const id of chain) crumbs.push({ id, label: state.titles.get(id) ?? "Untitled" });
  }

  const [crumbMenu, setCrumbMenu] = useState<CrumbMenuState | undefined>();
  const toggleCrumb = (e: MouseEvent<HTMLElement>, m: Omit<CrumbMenuState, "top" | "left">) => {
    const r = e.currentTarget.getBoundingClientRect();
    setCrumbMenu((open) => (open?.key === m.key ? undefined : { ...m, top: r.bottom + 4, left: r.left }));
  };
  useEffect(() => setCrumbMenu(undefined), [pageID]);

  const favorite = outline?.favorites.includes(pageID) ?? false;
  const chatOpen = useSyncExternalStore(subscribeChatPanel, isChatPanelOpen);
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  const subpages = outline?.children[pageID]?.length ?? 0;
  // BSD-255: eine Inline-Datenbank lässt sich per „Open as full page“ wie eine Datenbankseite öffnen.
  const dbID = page?.type === "databasePage" || page?.type === "databaseInline" ? page.props?.databaseID : undefined;
  const edited = store && page ? editedLabel(lastEdited(store, pageID)) : undefined;

  const loading = !store && !failed;
  let body;
  if (failed) body = <p className="t-desc">Couldn't open this page: {failed}</p>;
  else if (!store) body = <p className="t-desc page-opening" aria-busy="true">Opening…</p>;
  else if (!page) body = <p className="t-desc">This page was deleted.</p>;
  else if (dbID) {
    const View = slots.DatabaseView;
    body = View
      ? <View store={store} blockID={pageID} databaseID={dbID} readOnly={readOnly} onOpenPage={onOpenPage} asPage />
      : <DatabasePlaceholder store={store} databaseID={dbID} title={title} />;
  } else {
    const Editor = slots.PageEditor;
    body = Editor
      ? <Editor store={store} pageID={pageID} readOnly={readOnly} onOpenPage={onOpenPage} focusBlock={focusBlock} />
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
          {/* BSD-301: tiefe Seiten – erster und die zwei letzten Vorfahren, dazwischen „…“ (wie Notion); jeder Teil
              kürzt mit „…“, der volle Name steht im Tooltip. Ein Klick klappt die Seite mit ihren Unterseiten auf
              (wie Notion), „…“ die ausgelassenen Vorfahren. */}
          {(crumbs.length > 3 ? [crumbs[0]!, { label: "…", hidden: crumbs.slice(1, -2) }, ...crumbs.slice(-2)] : crumbs).map((c, i) => (
            <span key={i} className="crumb">
              {"hidden" in c ? (
                <button type="button" className="crumb-link crumb-more" aria-label="Show hidden pages" title={c.hidden.map((h) => h.label).join(" / ")} data-menu-trigger="" aria-haspopup="menu"
                  aria-expanded={crumbMenu?.key === "more"} onClick={(e) => toggleCrumb(e, { key: "more", pages: c.hidden.flatMap((h) => (h.id ? [h.id] : [])) })}>…</button>
              ) : c.id ? (
                <button type="button" className="crumb-link" title={c.label} data-menu-trigger="" aria-haspopup="menu" aria-expanded={crumbMenu?.key === c.id}
                  onClick={(e) => toggleCrumb(e, { key: c.id!, self: c.id!, pages: outline?.children[c.id!] ?? [] })}>
                  <CrumbIcon node={outline?.nodes[c.id]} /><span className="crumb-label">{c.label}</span>
                </button>
              ) : <span className="crumb-text" title={c.label}>{c.label}</span>}
              <span aria-hidden="true">/</span>
            </span>
          ))}
          <span className="crumb-current" aria-current="page" title={title || "Untitled"}>{title || "Untitled"}</span>
        </nav>
        <span className="spacer" data-testid="page-edited" title={state.status.state === "synced" || state.status.state === "local" ? "Saved" : undefined}>{state.status.state === "synced" || state.status.state === "local" ? (edited ?? "Saved") : SYNC_LABEL[state.status.state]}</span>
        {page && !trashed ? (
          <>
            <button type="button" className="icon-btn ghost" aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"} aria-pressed={favorite} title="Favorite" onClick={() => void client.command({ op: "favorite", ids: [pageID], on: !favorite })}>
              <Icon name="star" size={18} filled={favorite} />
            </button>
            <ShareButton pageID={pageID} title={title} onNavigate={onNavigate} />
            {/* BSD-168: AI-Knopf wie Swift NotionChrome – öffnet/schließt das Chat-Panel (⌘J), aktiv solange es offen ist. */}
            {ai ? (
              <button type="button" className="icon-btn ghost" aria-label="AI chat" title="AI chat (⌘J)" aria-pressed={chatOpen} data-testid="topbar-ai" onClick={toggleChatPanel}>
                <Icon name="chat" size={18} filled={chatOpen} />
              </button>
            ) : null}
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
      {crumbMenu && outline ? <CrumbMenu menu={crumbMenu} outline={outline} titles={state.titles} current={pageID} onClose={() => setCrumbMenu(undefined)} onOpen={(id) => { setCrumbMenu(undefined); onOpenPage(id); }} /> : null}
      {menu ? (
        <PageMenu pos={menu} onClose={() => setMenu(undefined)} onHistory={() => { setMenu(undefined); setHistoryOpen(true); }}
          outline={store && page && !dbID && !readOnly ? { hidden: isOutlineHidden(store, pageID), toggle: () => { setMenu(undefined); setOutlineHidden(store, pageID, !isOutlineHidden(store, pageID)); } } : undefined}
          options={store && page && !storeReadOnly ? { format, isDatabase: dbID !== undefined, set: (patch) => setPageFormat(store, pageID, patch) } : undefined}
          actions={page && !trashed ? {
            copyLink: () => void copyPageLink(pageID),
            openWindow: () => void openPageWindow(routeToHash({ name: "page", id: pageID }), title),
            duplicate: () => void client.command({ op: "duplicate", ids: [pageID] }),
            move: () => setMoving(true),
            favorite: { on: favorite, toggle: () => void client.command({ op: "favorite", ids: [pageID], on: !favorite }) },
            exportPage: () => setExporting(true),
            find: () => setFind((f) => ({ focus: (f?.focus ?? 0) + 1, step: f?.step ?? { n: 0, delta: 1 } })),
            stats: store && !dbID ? pageTextStats(store, pageID) : undefined,
            trash: () => { void client.command({ op: "trash", ids: [pageID] }); onNavigate({ name: "home" }); },
            edited,
          } : undefined} />
      ) : null}
      {moving && outline ? (
        <MoveDialog client={client} state={state} ids={[pageID]} onClose={() => setMoving(false)} />
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
          {mayDeleteForever() ? (
            <button type="button" className="btn ghost" onClick={() => {
              void client.command({ op: "deleteForever", ids: [pageID] });
              onNavigate({ name: "trash" });
            }}>Delete forever</button>
          ) : null}
        </div>
      ) : null}
      {find ? <FindBar root={findRoot} focusSignal={find.focus} step={find.step} onClose={() => setFind(undefined)} /> : null}
      <article ref={article} className={dbID ? "page page-database" : "page"} onMouseDown={(e) => {
        // Wie Notion: Klick in die leere Fläche unter dem Inhalt setzt die Schreibmarke ans Ende (neue Zeile, wenn
        // die letzte nicht leer ist).
        if (e.button !== 0 || readOnly || dbID) return;
        const t = e.target as Element;
        const bodyEl = e.currentTarget.querySelector(".page-body");
        // Menüs des Editors sind Portale: ihre Klicks kommen in React hier an, liegen im DOM aber außerhalb der Seite.
        if (!bodyEl || !e.currentTarget.contains(t) || t.closest(".bn-editor, .bx2-editor, button, input, textarea, select, a, [role=menu], [role=dialog], [role=listbox]")) return;
        if (e.clientY > bodyEl.getBoundingClientRect().bottom && intoBody(e.currentTarget, { at: "end" })) e.preventDefault();
      }} data-font={format.font} data-small-text={format.smallText ? "" : undefined}
        data-full-width={format.fullWidth ? "" : undefined} data-locked={format.locked ? "" : undefined}>
        {store && page && page.props?.cover ? <PageCoverBand store={store} pageID={pageID} readOnly={readOnly} position={typeof page.props?.format?.coverPosition === "number" ? page.props.format.coverPosition : 0.5} /> : null}
        <div className="page-grid">
          <div className="spacer-cell" />
          <div className="page-head">
            {/* Solange die Seite lädt, hält eine leere Zeile den Platz frei – sonst springt der Titel beim Öffnen. */}
            {loading && state.status.state !== "readonly" ? <div className="page-icon-row" aria-hidden="true" /> : null}
            {icon || iconImage || (!readOnly && page) ? (
              <div className="page-icon-row">
                {icon ? (
                  <button type="button" className="page-icon" aria-label="Page icon" aria-haspopup="dialog" disabled={readOnly} onClick={() => setIconPicker((o) => !o)}>{icon}</button>
                ) : iconImage ? (
                  <button type="button" className="page-icon" aria-label="Page icon" aria-haspopup="dialog" disabled={readOnly} onClick={() => setIconPicker((o) => !o)}>
                    {iconImageURL ? <img className="page-icon-img" src={iconImageURL} alt="" data-testid="page-icon-image" /> : null}
                  </button>
                ) : (
                  <button type="button" className="page-add-icon btn ghost" onClick={() => setIconPicker(true)}>Add icon</button>
                )}
                {!readOnly && page && !page.props?.cover ? <button type="button" className="page-add-icon btn ghost" onClick={() => setCoverPicker((o) => !o)}>Add cover</button> : null}
                {iconPicker && !readOnly ? (
                  <>
                    <button type="button" className="btn ghost" onClick={() => iconFile.current?.click()}>Upload image</button>
                    <input ref={iconFile} type="file" accept="image/*" hidden data-testid="icon-file" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f && store && await uploadPageIcon(store, pageID, f)) setIconPicker(false);
                    }} />
                  </>
                ) : null}
                {iconPicker && store ? (
                  <EmojiPicker className="page-icon-picker" current={icon} onClose={() => setIconPicker(false)}
                    onPick={(e) => { setPageIcon(store, pageID, e); setIconPicker(false); }} />
                ) : null}
                {coverPicker && store ? <CoverPicker store={store} pageID={pageID} hasCover={false} onClose={() => setCoverPicker(false)} /> : null}
              </div>
            ) : null}
            {pendingImport ? (
              <div className="page-locked t-desc" role="status" data-testid="import-pending">
                <Icon name="history" size={14} /> Content is still importing from Notion — this page unlocks when it arrives
              </div>
            ) : null}
            {format.locked ? (
              <div className="page-locked t-desc" role="status">
                <Icon name="lock" size={14} /> Locked
                {!storeReadOnly && store ? <button type="button" className="btn ghost" onClick={() => setPageFormat(store, pageID, { locked: false })}>Unlock</button> : null}
              </div>
            ) : null}
            <TitleField id={pageID} title={title} readOnly={readOnly || !page} onRename={(t) => void client.command({ op: "rename", id: pageID, title: t })} />
            {page ? (
              <div className="meta-line t-desc">
                <span>Edited {relative(fromSwift(page.updatedAt))}</span>
                <span>Created {longDate(fromSwift(page.createdAt))}</span>
                {subpages ? <span>{subpages} {subpages === 1 ? "sub-page" : "sub-pages"}</span> : null}
              </div>
            ) : loading ? <div className="meta-line t-desc" aria-hidden="true">&nbsp;</div> : null}
          </div>
          <div className="spacer-cell" />
          <div className="page-body" data-testid="page-content">{body}</div>
        </div>
      </article>
      {exporting ? <ExportDialog client={client} pageID={pageID} onClose={() => setExporting(false)} /> : null}
    </>
  );
}

/** Menü der Kopfzeile: Fokus auf den ersten Eintrag, ↑/↓ wandern, Escape und Klick daneben schließen. */
function useMenuKeys(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const down = (e: globalThis.MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.("[data-menu-trigger]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // BSD-238: ↑/↓ zwischen den Einträgen.
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ref.current?.contains(document.activeElement)) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("[role^=menuitem]")];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [ref, onClose]);
}

/** Aufgeklappter Breadcrumb-Teil: die Seite selbst (`self`) und darunter ihre Unterseiten bzw. die ausgelassenen Vorfahren. */
interface CrumbMenuState { key: string; self?: string; pages: readonly string[]; top: number; left: number }

/** So viele Unterseiten zeigt das Breadcrumb-Menü sofort; der Rest hinter „N more“. */
const CRUMB_MENU_FIRST = 5;

function CrumbIcon({ node }: { node: Outline["nodes"][string] | undefined }) {
  return <span className="crumb-icon" aria-hidden="true">{node?.icon && isEmojiIcon(node.icon) ? node.icon : <Icon name={node?.kind === "database" ? "database" : "page"} size={16} />}</span>;
}

function CrumbMenu({ menu, outline, titles, current, onClose, onOpen }: { menu: CrumbMenuState; outline: Outline; titles: ReadonlyMap<string, string>; current: string; onClose: () => void; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeys(ref, onClose);
  const [all, setAll] = useState(false);
  const shown = all ? menu.pages : menu.pages.slice(0, CRUMB_MENU_FIRST);
  const rest = menu.pages.length - shown.length;
  const row = (id: string, self: boolean) => (
    <button key={id} type="button" role="menuitem" className="menu-item crumb-menu-item" aria-current={id === current ? "page" : undefined} data-self={self ? "" : undefined} title={titles.get(id) ?? "Untitled"} onClick={() => onOpen(id)}>
      <CrumbIcon node={outline.nodes[id]} /><span className="crumb-menu-title">{titles.get(id) ?? "Untitled"}</span>
    </button>
  );
  return (
    <div ref={ref} role="menu" aria-label="Pages" className="menu crumb-menu" data-testid="crumb-menu" style={{ top: menu.top, left: menu.left }}>
      {menu.self ? row(menu.self, true) : null}
      {menu.self && shown.length ? <div className="menu-sep" role="separator" /> : null}
      {shown.map((id) => row(id, false))}
      {rest > 0 ? <button type="button" role="menuitem" className="menu-item crumb-menu-more" onClick={() => setAll(true)}>{rest} more</button> : null}
    </div>
  );
}

/** Seitenmenü (⋯) in der Kopfzeile. */
interface PageOptionsMenu { format: ReturnType<typeof pageFormat>; isDatabase: boolean; set: (patch: PageFormatPatch) => void }

const FONTS: readonly { id: PageFont; label: string }[] = [{ id: "default", label: "Default" }, { id: "serif", label: "Serif" }, { id: "mono", label: "Mono" }];

/** BSD-204: Seitenaktionen im •••-Menü (wie Notion): Link kopieren, Duplizieren, Verschieben, Favorit, Export, Papierkorb. */
interface PageActions {
  copyLink: () => void;
  openWindow: () => void;
  duplicate: () => void;
  move: () => void;
  favorite: { on: boolean; toggle: () => void };
  exportPage: () => void;
  find: () => void;
  /** Wortzahl (nur Seiten mit Text). */
  stats?: { words: number; characters: number } | undefined;
  trash: () => void;
  /** „Edited …“ als Fußzeile. */
  edited?: string | undefined;
}

/** Letzte Änderung an der Seite oder ihrem Inhalt (Swift-Zeit), `undefined` ohne Zeitstempel. */
function lastEdited(store: WorkspaceStore, pageID: string): number | undefined {
  let t = store.blocks.get(pageID)?.updatedAt;
  for (const id of subtree(store, pageID, false)) {
    const u = store.blocks.get(id)?.updatedAt;
    if (u !== undefined && (t === undefined || u > t)) t = u;
  }
  return t;
}

/** „Edited just now“, „Edited 5 min ago“, „Edited yesterday“, „Edited 3 Nov“. */
export function editedLabel(t: number | undefined, now = new Date()): string | undefined {
  if (t === undefined || !(t > 0)) return undefined;
  const r = relative(fromSwift(t), now);
  if (r === "just now") return "Edited just now";
  if (r === "Yesterday") return "Edited yesterday";
  if (/^\d+ (min|h)$/.test(r)) return `Edited ${r} ago`;
  return `Edited ${r}`;
}

const count = (n: number, unit: string) => `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;

async function copyPageLink(pageID: string) {
  const url = new URL(globalThis.location.href);
  url.hash = routeToHash({ name: "page", id: pageID });
  try {
    await navigator.clipboard.writeText(url.toString());
  } catch { /* ohne Zwischenablage-Recht: nichts */ }
}

function PageMenu({ pos, onClose, onHistory, outline, options, actions }: { pos: { top: number; right: number }; onClose: () => void; onHistory: () => void; outline?: { hidden: boolean; toggle: () => void } | undefined; options?: PageOptionsMenu | undefined; actions?: PageActions | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeys(ref, onClose);
  return (
    <div ref={ref} role="menu" aria-label="Page menu" className="menu page-menu" style={{ top: pos.top, right: pos.right }}>
      {actions ? (
        <>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.copyLink(); }}><Icon name="link" size={18} />Copy link</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.openWindow(); }}><Icon name="expand" size={18} />Open in new window</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.find(); }}><Icon name="search" size={18} />Find in page<kbd className="menu-kbd t-meta">⌘F</kbd></button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.duplicate(); }}><Icon name="duplicate" size={18} />Duplicate</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.move(); }}><Icon name="move" size={18} />Move to…</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.favorite.toggle(); }}><Icon name="star" size={18} />{actions.favorite.on ? "Remove from Favorites" : "Add to Favorites"}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); actions.exportPage(); }}><Icon name="export" size={18} />Export…</button>
          <div className="menu-sep" role="separator" />
        </>
      ) : null}
      <button type="button" role="menuitem" className="menu-item" onClick={onHistory}><Icon name="restore" size={18} />Version history</button>
      {outline ? <button type="button" role="menuitem" className="menu-item" onClick={outline.toggle}><Icon name="outline" size={18} />{outline.hidden ? "Show outline" : "Hide outline"}</button> : null}
      {options ? (
        <>
          {!options.isDatabase ? (
            <div className="page-font-row" role="group" aria-label="Font">
              {FONTS.map((f) => (
                <button key={f.id} type="button" role="menuitemradio" aria-checked={options.format.font === f.id} className="page-font" data-font={f.id}
                  onClick={() => options.set({ font: f.id })}>
                  <span className="page-font-sample" aria-hidden="true">Ag</span>{f.label}
                </button>
              ))}
            </div>
          ) : null}
          {!options.isDatabase ? (
            <button type="button" role="menuitemcheckbox" aria-checked={options.format.smallText} className="menu-item" onClick={() => options.set({ smallText: !options.format.smallText })}>
              <Icon name="textSize" size={18} />Small text{options.format.smallText ? <span className="menu-check" aria-hidden="true">✓</span> : null}
            </button>
          ) : null}
          <button type="button" role="menuitemcheckbox" aria-checked={options.format.fullWidth} className="menu-item" onClick={() => options.set({ fullWidth: !options.format.fullWidth })}>
            <Icon name="width" size={18} />Full width{options.format.fullWidth ? <span className="menu-check" aria-hidden="true">✓</span> : null}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={options.format.locked} className="menu-item" onClick={() => { options.set({ locked: !options.format.locked }); onClose(); }}>
            <Icon name="lock" size={18} />Lock page{options.format.locked ? <span className="menu-check" aria-hidden="true">✓</span> : null}
          </button>
        </>
      ) : null}
      {actions ? (
        <>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item danger" onClick={() => { onClose(); actions.trash(); }}><Icon name="trash" size={18} />Move to Trash</button>
          {actions.stats ? <p className="menu-foot t-meta" data-testid="page-menu-words">{count(actions.stats.words, "word")} · {count(actions.stats.characters, "character")}</p> : null}
          {actions.edited ? <p className="menu-foot t-meta" data-testid="page-menu-edited">{actions.edited}</p> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Titel als Eingabefeld; Änderungen gehen sofort an den Worker (dort zu einem Undo-Schritt zusammengefasst).
 * BSD-301: ein mehrzeiliges Feld, das mit dem Text wächst – lange Titel brechen um wie in Notion, statt rechts
 * abgeschnitten zu werden. Enter beendet die Eingabe (kein Zeilenumbruch im Titel).
 */
/** Fokus in den Text der Seite geben (Ereignis „bx:focus“ des Editors). `false`: kein Editor da oder nicht übernommen. */
function intoBody(from: Element, detail: { at: "start" | "end"; insert?: boolean; text?: string }): boolean {
  const host = from.closest(".page")?.querySelector(".page-body .bx-editor, .page-body .bx2-editor");
  return host ? !host.dispatchEvent(new CustomEvent("bx:focus", { cancelable: true, detail })) : false;
}

/** Steht die Schreibmarke in der letzten Zeile des (evtl. umbrochenen) Titels? Einzeilig: immer. */
function onLastLine(el: HTMLTextAreaElement): boolean {
  const line = parseFloat(getComputedStyle(el).lineHeight);
  if (!(line > 0) || el.scrollHeight < line * 1.5) return true;
  return el.selectionEnd === el.value.length;
}

function TitleField({ id, title, readOnly, onRename }: { id: string; title: string; readOnly: boolean; onRename: (t: string) => void }) {
  const [value, setValue] = useState(title);
  const focused = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focused.current) setValue(title === "Untitled" ? "" : title);
  }, [title, id]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [value]);
  return (
    <h1 className="t-title page-title">
      <textarea
        ref={field}
        aria-label="Page title"
        className="title-input title-wrap"
        placeholder="Untitled"
        rows={1}
        value={value}
        readOnly={readOnly}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => {
          const next = e.target.value.replace(/[\r\n]+/g, " ");
          setValue(next);
          onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
          const el = e.currentTarget;
          // Wie Notion: Enter legt unter dem Titel eine neue erste Zeile an (mit dem Text hinter der Schreibmarke),
          // ↓ in der letzten Zeile des Titels geht in den Text. Ohne Editor (Datenbankseite): Enter verlässt das Feld.
          if (e.key === "Enter") {
            e.preventDefault();
            const before = value.slice(0, el.selectionStart), after = readOnly ? "" : value.slice(el.selectionEnd);
            if (!intoBody(el, { at: "start", insert: true, text: after })) el.blur();
            else if (!readOnly && before !== value) {
              setValue(before);
              onRename(before);
            }
          } else if (e.key === "ArrowDown" && !e.shiftKey && onLastLine(el) && intoBody(el, { at: "start" })) e.preventDefault();
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

