// Seitenleiste (v8) auf echten Daten: Navigation, dann Favoriten, Teamspaces und Private als virtualisierter Baum
// (nur sichtbare Zeilen im DOM, Titel getrennt von der Struktur), unten der Sync-Status. Aktiver Eintrag als
// weiße Pille. Seiten: auf-/zuklappen, neue Seite, umbenennen, Favorit, Papierkorb, Ziehen zum Umsortieren.
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { VirtualList } from "@based/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import "./teamspaces.css";
import markLight from "../../../../docs/design/logo/based-mark-small.svg?url";
import markDark from "../../../../docs/design/logo/based-mark-small-on-dark.svg?url";
import { Icon, type IconName } from "../icons.js";
import { MoveDialog } from "./MoveDialog.js";
import { DeleteTeamspaceDialog, TeamspaceDialog, type TeamspaceEdit } from "./TeamspaceDialog.js";
import { routeToHash, type Route } from "../shell/router.js";
import { openPageWindow } from "../desktop.js";
import { ancestorsInOutline, dropZone, flattenSidebar, pickRange, rowIndexOf, type SidebarRow } from "../shell/sidebarModel.js";
import { collapsedSections, expandedPages, sidebarNavPrefs, startPage } from "../shell/storage.js";
import { cleanNavPrefs, FOOTER_STYLE, hideNav, moveNav, NAV, navLayout, navPlace, pinNav, showNav, unpinNav, type NavID, type NavPrefs } from "../shell/sidebarNav.js";
import { applySidebar, isSidebarToggle, SIDEBAR_MAX, SIDEBAR_MIN, sidebarSize } from "../shell/sidebarSize.js";
import { assetsLabel } from "../assetBridge.js";
import { meetingHost } from "../editorSlot.js";
import { keyLabel } from "../shell/keyHints.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import type { SyncState } from "../worker/protocol.js";

/** Nur geschlossene Formen werden im aktiven Zustand gefüllt (Lupe und Zahnrad nicht). */
const FILLABLE = new Set<IconName>(["home", "graph", "trash", "chat", "settings", "library", "search"]);
const PRIVATE = "private";
const DRAG_TYPE = "application/x-based-page";
const NAV_DRAG_TYPE = "application/x-based-nav";

/** Zeilenhöhe aus dem Token (`--space-6`), damit Virtualisierung und CSS übereinstimmen. */
function rowHeight(): number {
  if (typeof document === "undefined") return 32;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-6"));
  return Number.isFinite(v) && v > 0 ? v : 32;
}

export const SYNC_LABEL: Record<SyncState, string> = {
  starting: "Opening…",
  local: "On this device",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  error: "Sync error",
  readonly: "Read-only",
  memory: "Not saved",
};

interface Props {
  client: StoreClient;
  state: ShellState;
  route: Route;
  /** Als Home gewählte Seite (sonst führt Home zum Dashboard). */
  homePage?: string | undefined;
  onHome?: () => void;
  onNavigate: (r: Route) => void;
  onOpenPage: (id: string) => void;
  onNewPage: (opts?: { parent?: string; section?: string }) => Promise<string | undefined>;
  onQuickFind: () => void;
  /** BSD-281: erweiterter Agenten-Modus („Show agent details“) – nur dann steht Coding in der Leiste. */
  advanced?: boolean;
}

interface Menu {
  id: string;
  x: number;
  y: number;
}

export function Sidebar({ client, state, route, homePage, onHome, onNavigate, onOpenPage, onNewPage, onQuickFind, advanced = false }: Props) {
  const { outline, titles, status } = state;
  const [expanded, setExpanded] = useState<Set<string>>(expandedPages.get);
  const [collapsed, setCollapsed] = useState<Set<string>>(collapsedSections.get);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [menu, setMenu] = useState<Menu | undefined>();
  const [drop, setDrop] = useState<{ key: string; zone: "before" | "inside" | "after" } | undefined>();
  const [moving, setMoving] = useState<string[] | undefined>();
  // BSD-203: Mehrfachauswahl (⇧-Klick, ⇧↑/⇧↓) für Sammelaktionen; Esc oder ein normaler Klick hebt sie auf.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const pickAnchor = useRef<string | undefined>(undefined);
  const [editTeamspace, setEditTeamspace] = useState<TeamspaceEdit | undefined>();
  const [deleteTeamspace, setDeleteTeamspace] = useState<{ id: string; name: string; pages: number } | undefined>();
  const dragging = useRef<string | undefined>(undefined);
  const height = useMemo(rowHeight, []);
  const activeID = route.name === "page" ? route.id : undefined;

  // Breite ziehen (gemerkt), ⌘\ blendet die Seitenleiste aus und wieder ein.
  const [width, setWidth] = useState(sidebarSize.width);
  const [hidden, setHidden] = useState(sidebarSize.hidden);
  // BSD-203: eingeklappt → Zeiger an den linken Rand (oder über „Show sidebar“) zeigt sie schwebend (Hover-Peek).
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peekOpen = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const peekClose = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 240);
  };
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current); }, []);
  useEffect(() => { if (!hidden) setPeek(false); }, [hidden]);
  const drag = useRef<{ x: number; w: number } | undefined>(undefined);
  useEffect(() => applySidebar(width, hidden), [width, hidden]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSidebarToggle(e)) return;
      e.preventDefault();
      setHidden((h) => {
        sidebarSize.setHidden(!h);
        return !h;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const resize = (w: number) => setWidth(sidebarSize.setWidth(w));

  const setExp = useCallback((f: (s: Set<string>) => void) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      f(next);
      expandedPages.set(next);
      return next;
    });
  }, []);

  // Die aktive Seite ist in der Seitenleiste sichtbar: Vorfahren aufklappen.
  useEffect(() => {
    if (!outline || !activeID) return;
    const missing = ancestorsInOutline(outline, activeID).filter((a) => !expanded.has(a));
    if (missing.length) setExp((s) => missing.forEach((a) => s.add(a)));
  }, [outline, activeID]);

  const rows = useMemo(() => (outline ? flattenSidebar(outline, expanded, collapsed) : []), [outline, expanded, collapsed]);
  const pageRowIDs = useMemo(() => rows.flatMap((r) => (r.kind === "page" && !r.key.startsWith("fav/") ? [r.id] : [])), [rows]);
  const pick = useCallback((id: string, mode: "toggle" | "range") => {
    setPicked((prev) => {
      // ⇧-Klick: Bereich vom Anker (zuletzt gewählt, sonst die offene Seite) bis hier – wie im Finder.
      const anchor = pickAnchor.current ?? activeID;
      if (mode === "range" && anchor) {
        const ids = pickRange(pageRowIDs, anchor, id);
        if (ids.length) {
          if (!pickAnchor.current) pickAnchor.current = anchor;
          return new Set(ids);
        }
      }
      const next = new Set(prev);
      // Die gerade offene Seite zählt beim ersten ⇧-Klick mit (wie im Finder).
      if (next.size === 0 && activeID && activeID !== id) next.add(activeID);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      pickAnchor.current = id;
      return next;
    });
  }, [pageRowIDs, activeID]);
  const clearPicked = useCallback(() => {
    pickAnchor.current = undefined;
    setPicked((p) => (p.size ? new Set() : p));
  }, []);
  const open = useCallback((id: string) => {
    clearPicked();
    onOpenPage(id);
  }, [clearPicked, onOpenPage]);
  useEffect(() => {
    if (!picked.size) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !menu) clearPicked(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, menu, clearPicked]);
  // Gelöschte oder nicht mehr sichtbare Seiten fallen aus der Auswahl.
  useEffect(() => {
    if (!picked.size || !outline) return;
    const live = [...picked].filter((id) => outline.nodes[id] && !outline.trash.some((t) => t.id === id));
    if (live.length !== picked.size) setPicked(new Set(live));
  }, [outline, picked]);
  const reveal = useMemo(() => rowIndexOf(rows, activeID), [rows, activeID]);

  const toggle = useCallback((id: string) => setExp((s) => (s.has(id) ? s.delete(id) : s.add(id))), [setExp]);
  const toggleSection = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      collapsedSections.set(next);
      return next;
    });
  }, []);

  const addInside = useCallback(async (parent: string) => {
    setExp((s) => s.add(parent));
    await onNewPage({ parent });
  }, [onNewPage, setExp]);

  const commitRename = useCallback((id: string, title: string) => {
    setRenaming(undefined);
    if (title !== (titles.get(id) ?? "")) void client.command({ op: "rename", id, title });
  }, [client, titles]);

  const onDragOver = (e: DragEvent<HTMLElement>, row: SidebarRow) => {
    if (!dragging.current || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = row.kind === "page" ? dropZone(e.clientY - rect.top, rect.height, !row.database) : "inside";
    if (drop?.key !== row.key || drop.zone !== zone) setDrop({ key: row.key, zone });
  };
  const onDrop = (e: DragEvent<HTMLElement>, row: SidebarRow) => {
    const id = dragging.current ?? e.dataTransfer.getData(DRAG_TYPE);
    const zone = drop?.key === row.key ? drop.zone : "inside";
    setDrop(undefined);
    dragging.current = undefined;
    if (!id) return;
    e.preventDefault();
    if (row.kind === "page") {
      if (row.id === id) return;
      if (zone === "inside") setExp((s) => s.add(row.id));
      void client.command({ op: "drop", ids: [id], target: row.id, zone });
    } else if (row.kind === "header" && row.section) {
      void client.command({ op: "moveToSection", ids: [id], section: row.section });
    } else if (row.kind === "teamspace") {
      void client.command({ op: "moveToSection", ids: [id], section: row.id });
    }
  };

  const renderRow = (i: number, style: CSSProperties) => {
    const row = rows[i]!;
    const dropClass = drop?.key === row.key ? ` drop-${drop.zone}` : "";
    if (row.kind === "header") {
      const add = row.group === "teamspaces"
        ? { label: "New teamspace", run: () => setEditTeamspace({ name: "" }) }
        : row.section ? { label: `New page in ${row.label}`, run: () => void onNewPage({ section: row.section! }) } : undefined;
      return (
        <div className={"tree-header t-meta" + dropClass} style={style} onDragOver={row.section ? (e) => onDragOver(e, row) : undefined} onDrop={row.section ? (e) => onDrop(e, row) : undefined} onDragLeave={() => setDrop(undefined)}>
          <button type="button" className="tree-header-label" aria-expanded={!row.collapsed} onClick={() => toggleSection(row.group)}>{row.label}</button>
          {add ? (
            <button type="button" className="tree-action" aria-label={add.label} title={add.label} onClick={add.run}>
              <Icon name="plus" size={16} />
            </button>
          ) : null}
        </div>
      );
    }
    if (row.kind === "action") {
      return (
        <button type="button" className="tree-row tree-create t-desc" style={{ ...style, paddingLeft: indent(1) }} onClick={() => setEditTeamspace({ name: "" })}>
          <Icon name="plus" size={16} />
          {row.label}
        </button>
      );
    }
    if (row.kind === "teamspace") {
      return (
        <div
          role="treeitem"
          aria-level={1}
          aria-expanded={!row.collapsed}
          aria-selected={false}
          aria-label={row.name}
          data-teamspace={row.id}
          className={"tree-row tree-teamspace" + dropClass}
          style={{ ...style, paddingLeft: indent(0) }}
          onClick={() => toggleSection(row.id)}
          onDragOver={(e) => onDragOver(e, row)}
          onDrop={(e) => onDrop(e, row)}
          onDragLeave={() => setDrop(undefined)}
        >
          <button type="button" className={"twisty" + (row.collapsed ? "" : " open")} aria-label={row.collapsed ? "Expand" : "Collapse"} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggleSection(row.id); }}>
            <Icon name="right" size={14} />
          </button>
          <span className="tree-icon" aria-hidden="true">{row.icon ?? <Icon name="teamspace" size={16} />}</span>
          <span className="tree-title">{row.name}</span>
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu
              hasChevron={false}
              menuWidth={200}
              renderTrigger={(p) => (
                <button type="button" className="tree-action" aria-label={`Teamspace actions for ${row.name}`} title="Rename, icon, delete…" {...p}>
                  <Icon name="more" size={16} />
                </button>
              )}
              items={[
                { label: "Edit name and icon…", icon: <Icon name="edit" size={16} />, onClick: () => setEditTeamspace({ id: row.id, name: row.name, ...(row.icon ? { icon: row.icon } : {}) }) },
                { label: "Add a page", icon: <Icon name="plus" size={16} />, onClick: () => { if (row.collapsed) toggleSection(row.id); void onNewPage({ section: row.id }); } },
                { type: "divider" },
                { label: "Delete teamspace…", icon: <Icon name="trash" size={16} />, variant: "destructive", onClick: () => setDeleteTeamspace({ id: row.id, name: row.name, pages: row.count }) },
              ]}
            />
            <button type="button" className="tree-action" aria-label={`New page in ${row.name}`} title="New page" onClick={() => { if (row.collapsed) toggleSection(row.id); void onNewPage({ section: row.id }); }}>
              <Icon name="plus" size={16} />
            </button>
          </span>
        </div>
      );
    }
    if (row.kind === "empty") {
      return <div className="tree-empty t-desc" style={{ ...style, paddingLeft: indent(row.depth) }}>No pages inside</div>;
    }
    return (
      <PageRow
        row={row}
        style={style}
        title={titles.get(row.id) ?? "Untitled"}
        icon={outline?.nodes[row.id]?.icon}
        active={row.id === activeID}
        picked={picked.has(row.id)}
        onPick={pick}
        favorite={outline?.favorites.includes(row.id) ?? false}
        renaming={renaming === row.id && !row.key.startsWith("fav/")}
        dropClass={dropClass}
        onOpen={open}
        onToggle={toggle}
        onAdd={addInside}
        onMenu={(id, x, y) => {
          // Rechtsklick außerhalb der Auswahl: nur diese Seite.
          if (picked.size && !picked.has(id)) clearPicked();
          setMenu({ id, x, y });
        }}
        onRename={commitRename}
        onCancelRename={() => setRenaming(undefined)}
        onDragStart={(e) => {
          dragging.current = row.id;
          e.dataTransfer.setData(DRAG_TYPE, row.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragging.current = undefined;
          setDrop(undefined);
        }}
        onDragOver={(e) => onDragOver(e, row)}
        onDrop={(e) => onDrop(e, row)}
      />
    );
  };

  const trashCount = outline?.trash.length ?? 0;
  // BSD-281: oben Search, Home, Chat (+ Angepinntes), unten Library · Trash · Settings als Icon-Zeile; Rechtsklick pinnt/blendet aus
  const [navPrefs, setNavPrefs] = useState<NavPrefs>(() => cleanNavPrefs(sidebarNavPrefs.get()));
  const [navMenu, setNavMenu] = useState<{ id: NavID; x: number; y: number } | undefined>();
  const changeNav = (f: (p: NavPrefs) => NavPrefs) => setNavPrefs((p) => {
    const next = f(p);
    sidebarNavPrefs.set(next);
    return next;
  });
  type NavEntry = { id: NavID; name: string; icon: IconName; cut?: IconName; active: boolean; key?: string; badge?: string; go: () => void };
  const entries: Record<NavID, NavEntry> = {
    search: { id: "search", name: "Search", icon: "search", active: false, key: keyLabel("k"), go: onQuickFind },
    home: { id: "home", name: "Home", icon: "home", cut: "homeDoor", active: route.name === "home" || (homePage !== undefined && route.name === "page" && route.id === homePage), go: onHome ?? (() => onNavigate({ name: "home" })) },
    chat: { id: "chat", name: "Chat", icon: "chat", active: route.name === "chat", key: keyLabel("j"), go: () => onNavigate({ name: "chat" }) },
    tasks: { id: "tasks", name: "Tasks", icon: "agent", active: route.name === "tasks", go: () => onNavigate({ name: "tasks" }) },
    coding: { id: "coding", name: "Coding", icon: "terminal", active: route.name === "coding", go: () => onNavigate({ name: "coding" }) },
    graph: { id: "graph", name: "Graph", icon: "graph", active: route.name === "graph", go: () => onNavigate({ name: "graph" }) },
    library: { id: "library", name: "Library", icon: "library", active: route.name === "library", go: () => onNavigate({ name: "library" }) },
    trash: { id: "trash", name: "Trash", icon: "trash", active: route.name === "trash", ...(trashCount ? { badge: String(trashCount) } : {}), go: () => onNavigate({ name: "trash" }) },
    settings: { id: "settings", name: "Settings", icon: "settings", active: route.name === "settings", key: keyLabel(","), go: () => onNavigate({ name: "settings" }) },
  };
  const layout = navLayout(navPrefs, { advanced });
  const onNavMenu = (id: NavID) => (e: React.MouseEvent) => {
    e.preventDefault();
    setNavMenu({ id, x: e.clientX, y: e.clientY });
  };
  // Einträge ziehen: umsortieren und zwischen oben und Fuß verschieben (pro Gerät gemerkt, wie Anpinnen/Ausblenden).
  const navDragging = useRef<NavID | undefined>(undefined);
  const [navDrop, setNavDrop] = useState<{ id: NavID; side: "before" | "after" } | undefined>();
  const navDrag = (id: NavID, list: "top" | "footer") => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      navDragging.current = id;
      e.dataTransfer.setData(NAV_DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      navDragging.current = undefined;
      setNavDrop(undefined);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!navDragging.current || navDragging.current === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      // oben stehen die Einträge untereinander, im Fuß (Icon-Zeile) nebeneinander
      const first = list === "top" || FOOTER_STYLE !== "icons" ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      const side = first ? "before" : "after";
      if (navDrop?.id !== id || navDrop.side !== side) setNavDrop({ id, side });
    },
    onDragLeave: () => setNavDrop((d) => (d?.id === id ? undefined : d)),
    onDrop: (e: DragEvent<HTMLElement>) => {
      const moved = navDragging.current;
      const side = navDrop?.id === id ? navDrop.side : "before";
      navDragging.current = undefined;
      setNavDrop(undefined);
      if (!moved || moved === id) return;
      e.preventDefault();
      const ids = list === "top" ? layout.top : layout.footer;
      const before = side === "before" ? id : ids[ids.indexOf(id) + 1];
      changeNav((p) => moveNav(p, moved, list, before === moved ? ids[ids.indexOf(moved) + 1] : before, { advanced }));
    },
  });
  const dropClass = (id: NavID) => (navDrop?.id === id ? ` nav-drop-${navDrop.side}` : "");
  const navButton = (n: NavEntry) => (
    <button key={n.id} type="button" className={"nav-item" + dropClass(n.id)} aria-current={n.active ? "page" : undefined} onClick={n.go} onContextMenu={onNavMenu(n.id)} {...navDrag(n.id, "top")}>
      <Icon name={n.icon} filled={n.active && FILLABLE.has(n.icon)} {...(n.cut ? { cut: n.cut } : {})} />
      {n.name}
      {n.badge ? <span className="badge" aria-label={`${n.badge} in Trash`}>{n.badge}</span> : n.key ? <span className="key t-data">{n.key}</span> : null}
    </button>
  );
  const iconButton = (n: NavEntry) => (
    <button key={n.id} type="button" className={"icon-btn ghost nav-icon" + dropClass(n.id)} aria-label={n.badge ? `${n.name}, ${n.badge} pages` : n.name} title={n.key ? `${n.name} (${n.key})` : n.name}
      aria-current={n.active ? "page" : undefined} onClick={n.go} onContextMenu={onNavMenu(n.id)} {...navDrag(n.id, "footer")}>
      <Icon name={n.icon} size={18} filled={n.active && FILLABLE.has(n.icon)} />
      {n.badge ? <span className="nav-icon-badge" aria-hidden="true">{n.badge}</span> : null}
      {n.key ? <span className="key-badge above" aria-hidden="true">{n.key}</span> : null}
    </button>
  );
  const syncStatus = (
    <div className="synced t-meta" data-testid="sync-status" data-state={status.state} data-sync={status.sync ?? status.state} data-assets={assetsLabel(status.assets) || undefined} title={[status.detail ?? SYNC_LABEL[status.state], assetsLabel(status.assets)].filter(Boolean).join(" · ")}>
      <span className={`dot ${status.state === "synced" ? "synced-dot" : status.state === "error" || status.state === "readonly" ? "error-dot" : ""}`} aria-hidden="true" />
      <span className="synced-text">
        {SYNC_LABEL[status.state]}
        {status.assets ? <span data-testid="sync-assets"> · {assetsLabel(status.assets)}</span> : null}
      </span>
    </div>
  );
  const menuSection = menu ? outline?.nodes[menu.id]?.section : undefined;

  return (
    <>
    {hidden ? (
      <>
        <div className="sidebar-peek-zone" aria-hidden="true" data-testid="sidebar-peek-zone" onMouseEnter={peekOpen} onMouseLeave={peekClose} />
        <button type="button" className="sidebar-show icon-btn ghost" aria-label="Show sidebar" title={`Show sidebar (${keyLabel("\\")})`} data-testid="sidebar-show"
          onMouseEnter={peekOpen} onMouseLeave={peekClose} onClick={() => {
            sidebarSize.setHidden(false);
            setHidden(false);
          }}>
          <Icon name="sidebar" size={18} />
        </button>
      </>
    ) : null}
    <nav className={"sidebar" + (hidden && peek ? " peek" : "")} aria-label="Workspace" hidden={hidden && !peek} data-picked={picked.size || undefined}
      onMouseEnter={hidden ? peekOpen : undefined} onMouseLeave={hidden ? peekClose : undefined}>
      <div className="brand">
        <img className="on-light" src={markLight} alt="" />
        <img className="on-dark" src={markDark} alt="" />
        <span className="wordmark">based</span>
        {outline?.workspaceIcon ? <span className="ws-icon" data-testid="workspace-icon-badge" title={outline.workspaceName} aria-label={`Workspace ${outline.workspaceName}`}>{outline.workspaceIcon}</span> : null}
        {/* sichtbarer Knopf zum Ausblenden – das Kürzel allein findet niemand (und ⌘\ gibt es nicht auf jeder Tastatur) */}
        <button type="button" className="sidebar-hide icon-btn ghost" data-testid="sidebar-hide"
          aria-label={hidden ? "Keep sidebar open" : "Hide sidebar"} title={hidden ? "Keep sidebar open" : `Hide sidebar (${keyLabel("\\")})`}
          onClick={() => {
            sidebarSize.setHidden(!hidden);
            setHidden(!hidden);
          }}>
          <Icon name="sidebar" size={18} />
        </button>
      </div>
      <RecordingPill onOpenPage={onOpenPage} />
      {layout.top.map((id) => navButton(entries[id]))}
      <VirtualList
        className="tree"
        role="tree"
        aria-label="Pages"
        count={rows.length}
        rowHeight={height}
        rowKey={(i) => rows[i]!.key}
        renderRow={renderRow}
        revealIndex={reveal}
      />
      {FOOTER_STYLE === "icons" ? (
        <div className="sidebar-footer icons" role="group" aria-label="Workspace tools">
          {syncStatus}
          <span className="nav-icons">{layout.footer.map((id) => iconButton(entries[id]))}</span>
        </div>
      ) : (
        <>
          <div className="sidebar-footer" role="group" aria-label="Workspace tools">{layout.footer.map((id) => navButton(entries[id]))}</div>
          {syncStatus}
        </>
      )}
      {navMenu ? (
        <NavMenu menu={navMenu} place={navPlace(navMenu.id, navPrefs, { advanced })} advanced={advanced} prefs={navPrefs} onClose={() => setNavMenu(undefined)}
          onPin={() => changeNav((p) => pinNav(p, navMenu.id))} onUnpin={() => changeNav((p) => unpinNav(p, navMenu.id))} onHide={() => changeNav((p) => hideNav(p, navMenu.id))}
          onToggle={(id, on) => changeNav((p) => (on ? showNav(p, id) : hideNav(p, id)))}
          onLower={() => changeNav((p) => moveNav(p, navMenu.id, "footer", undefined, { advanced }))}
          onReset={() => changeNav(() => ({ pinned: [], hidden: [] }))} />
      ) : null}
      {menu && picked.size > 1 && picked.has(menu.id) ? (
        <BulkMenu
          menu={menu}
          count={picked.size}
          allFavorite={[...picked].every((id) => outline?.favorites.includes(id))}
          onClose={() => setMenu(undefined)}
          onFavorite={(on) => void client.command({ op: "favorite", ids: [...picked], on })}
          onDuplicate={() => void client.command({ op: "duplicate", ids: [...picked] })}
          onMove={() => setMoving([...picked])}
          onTrash={() => {
            const ids = [...picked];
            void client.command({ op: "trash", ids });
            clearPicked();
            if (activeID && ids.includes(activeID)) onNavigate({ name: "home" });
          }}
        />
      ) : menu ? (
        <PageMenu
          menu={menu}
          favorite={outline?.favorites.includes(menu.id) ?? false}
          canNest={outline?.nodes[menu.id]?.kind === "page"}
          onClose={() => setMenu(undefined)}
          onFavorite={(on) => void client.command({ op: "favorite", ids: [menu.id], on })}
          onRename={() => setRenaming(menu.id)}
          onAdd={() => void addInside(menu.id)}
          onMove={() => setMoving([menu.id])}
          onDuplicate={() => void client.command({ op: "duplicate", ids: [menu.id] })}
          onOpenWindow={() => void openPageWindow(routeToHash({ name: "page", id: menu.id }), titles.get(menu.id) ?? "")}
          isHome={homePage === menu.id}
          onHome={(on) => startPage.set(on ? menu.id : undefined)}
          quickMoves={(outline?.nodes[menu.id]?.parent === undefined ? outline?.sections ?? [] : []).filter((x) => x.id !== menuSection).map((x) => ({ id: x.id, label: `Move to ${x.name}` }))}
          onQuickMove={(section) => void client.command({ op: "moveToSection", ids: [menu.id], section })}
          onTrash={() => {
            void client.command({ op: "trash", ids: [menu.id] });
            if (activeID === menu.id) onNavigate({ name: "home" });
          }}
        />
      ) : null}
      {moving && state.outline ? <MoveDialog client={client} state={state} ids={moving} onClose={() => setMoving(undefined)} onMoved={() => clearPicked()} /> : null}
      {editTeamspace ? (
        <TeamspaceDialog client={client} teamspace={editTeamspace} onClose={() => setEditTeamspace(undefined)} onSaved={() => {
          // neuer Teamspace ist sichtbar: „Teamspaces“ aufklappen
          if (collapsed.has("teamspaces")) toggleSection("teamspaces");
        }} />
      ) : null}
      {deleteTeamspace ? <DeleteTeamspaceDialog client={client} {...deleteTeamspace} onClose={() => setDeleteTeamspace(undefined)} /> : null}
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        title={`Drag to resize · click to hide (${keyLabel("\\")})`}
        data-testid="sidebar-resize"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.w + e.clientX - drag.current.x);
        }}
        onPointerUp={(e) => {
          const moved = drag.current ? Math.abs(e.clientX - drag.current.x) > 3 : true;
          drag.current = undefined;
          if (!moved) {
            sidebarSize.setHidden(true);
            setHidden(true);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") resize(width - 16);
          else if (e.key === "ArrowRight") resize(width + 16);
        }}
      />
    </nav>
    </>
  );
}

/** Einrückung; ab der fünften Ebene nur noch Drittel-Schritte, damit auch tief verschachtelte Seiten (BSD-301) ihren
 *  Titel zeigen statt nur Pfeil und Symbol. */
const indent = (depth: number) => `calc(${depth <= 4 ? depth : 4 + (depth - 4) / 3} * var(--space-4) + var(--space-1))`;

interface RowProps {
  row: Extract<SidebarRow, { kind: "page" }>;
  style: CSSProperties;
  title: string;
  icon: string | undefined;
  active: boolean;
  picked: boolean;
  onPick: (id: string, mode: "toggle" | "range") => void;
  favorite: boolean;
  renaming: boolean;
  dropClass: string;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

const PageRow = memo(function PageRow(p: RowProps) {
  const { row } = p;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") p.onOpen(row.id);
    else if (e.key === " " && e.shiftKey) { e.preventDefault(); p.onPick(row.id, "toggle"); }
    else if (e.key === "ArrowRight" && !row.expanded) p.onToggle(row.id);
    else if (e.key === "ArrowLeft" && row.expanded) p.onToggle(row.id);
  };
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren || row.expanded ? row.expanded : undefined}
      aria-selected={p.active || p.picked}
      aria-label={p.title}
      tabIndex={p.active ? 0 : -1}
      className={"tree-row" + (p.active ? " active" : "") + (p.picked ? " picked" : "") + p.dropClass}
      data-picked={p.picked ? "" : undefined}
      style={{ ...p.style, paddingLeft: indent(row.depth) }}
      draggable={!p.renaming}
      data-row=""
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          p.onPick(row.id, e.altKey ? "toggle" : "range");
        } else p.onOpen(row.id);
      }}
      onKeyDown={onKey}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(row.id, e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className={"twisty" + (row.expanded ? " open" : "")}
        aria-label={row.expanded ? "Collapse" : "Expand"}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggle(row.id);
        }}
      >
        <Icon name="right" size={14} />
      </button>
      <span className="tree-icon" aria-hidden="true">{p.icon ?? <Icon name={row.database ? "database" : "page"} size={16} />}</span>
      {p.renaming ? (
        <input
          className="tree-rename"
          aria-label="Page name"
          defaultValue={p.title === "Untitled" ? "" : p.title}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => p.onRename(row.id, e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") p.onCancelRename();
          }}
        />
      ) : (
        <span className="tree-title">{p.title}</span>
      )}
      <span className="tree-actions">
        <button
          type="button"
          className="tree-action"
          aria-label={`Actions for ${p.title}`}
          title="Delete, rename, favorite…"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            p.onMenu(row.id, r.left, r.bottom);
          }}
        >
          <Icon name="more" size={16} />
        </button>
        {!row.database ? (
          <button
            type="button"
            className="tree-action"
            aria-label={`Add a page inside ${p.title}`}
            title="Add a page inside"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              p.onAdd(row.id);
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        ) : null}
      </span>
    </div>
  );
});

/** Sammelaktionen für mehrere ausgewählte Seiten (wie Notion). */
function BulkMenu({ menu, count, allFavorite, onClose, onFavorite, onDuplicate, onMove, onTrash }: {
  menu: Menu; count: number; allFavorite: boolean; onClose: () => void;
  onFavorite: (on: boolean) => void; onDuplicate: () => void; onMove: () => void; onTrash: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const item = (label: string, icon: IconName, run: () => void) => (
    <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); run(); }}>
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
  return (
    <div ref={ref} role="menu" aria-label={`Actions for ${count} pages`} className="menu" style={{ left: menu.x, top: menu.y }}>
      <p className="menu-foot t-meta">{count} pages selected</p>
      {item(allFavorite ? "Remove from Favorites" : "Add to Favorites", "star", () => onFavorite(!allFavorite))}
      {item("Duplicate", "duplicate", onDuplicate)}
      {item("Move to…", "move", onMove)}
      {item("Move to Trash", "trash", onTrash)}
    </div>
  );
}

const NO_RECORDING = () => () => undefined;
const NOT_RECORDING = () => undefined;

/** BSD-281: laufende Aufnahme als Pille oben in der Seitenleiste; ein Klick führt zur Seite mit dem Meeting. */
function RecordingPill({ onOpenPage }: { onOpenPage: (id: string) => void }) {
  const host = meetingHost();
  const s = useSyncExternalStore(host?.subscribe ?? NO_RECORDING, host?.getState ?? NOT_RECORDING);
  const page = host?.recordingPage();
  if (!s?.recording || !page) return null;
  const t = Math.max(0, Math.floor(s.elapsed));
  const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  return (
    <button type="button" className="rec-pill" data-testid="recording-pill" data-paused={s.paused ? "" : undefined} onClick={() => onOpenPage(page)}
      aria-label={`${s.paused ? "Recording paused" : "Recording"}, ${clock} — open meeting`}>
      <span className="rec-dot" aria-hidden="true" />
      {s.paused ? "Paused" : "Recording"}
      <span className="t-data rec-time">{clock}</span>
    </button>
  );
}

/** BSD-281: Rechtsklick auf einen Eintrag der Leiste – oben anpinnen/lösen, ausblenden, und alle Einträge ein-/ausblenden. */
function NavMenu({ menu, place, advanced, prefs, onClose, onPin, onUnpin, onHide, onToggle, onLower, onReset }: {
  menu: { id: NavID; x: number; y: number };
  place: "top" | "footer" | "none";
  advanced: boolean;
  prefs: NavPrefs;
  onClose: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
  onToggle: (id: NavID, on: boolean) => void;
  onLower: () => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  const def = NAV.find((n) => n.id === menu.id)!;
  const l = navLayout(prefs, { advanced });
  const visible = new Set<NavID>([...l.top, ...l.footer]);
  const pinned = prefs.pinned.includes(menu.id);
  const keyNav = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div ref={ref} role="menu" aria-label={`${def.name} in the sidebar`} className="menu" style={{ left: menu.x, top: menu.y }} data-testid="nav-menu" onKeyDown={keyNav}>
      {place !== "top" ? <button type="button" role="menuitem" className="menu-item" onClick={run(onPin)}><Icon name="plus" size={16} />Pin to top</button> : null}
      {place === "top" && pinned ? <button type="button" role="menuitem" className="menu-item" onClick={run(onUnpin)}><Icon name="back" size={16} />{def.home === "footer" ? "Move back to the bottom" : "Unpin from top"}</button> : null}
      {place === "top" && def.home === "top" ? <button type="button" role="menuitem" className="menu-item" onClick={run(onLower)}><Icon name="back" size={16} />Move to the bottom</button> : null}
      <button type="button" role="menuitem" className="menu-item" onClick={run(onHide)}><Icon name="close" size={16} />Hide from sidebar</button>
      <div className="menu-sep" role="separator" />
      <span className="menu-label t-meta">Show in sidebar</span>
      {NAV.filter((n) => n.id !== "coding" || advanced).map((n) => {
        const on = visible.has(n.id);
        return (
          <button key={n.id} type="button" role="menuitemcheckbox" aria-checked={on} className="menu-item" onClick={run(() => onToggle(n.id, !on))}>
            {n.name}<span className="menu-check" aria-hidden="true">{on ? <Icon name="check" size={16} /> : null}</span>
          </button>
        );
      })}
      {prefs.pinned.length || prefs.hidden.length || prefs.lowered?.length || prefs.order?.length || prefs.footerOrder?.length ? (
        <>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={run(onReset)}><Icon name="restore" size={16} />Reset sidebar</button>
        </>
      ) : null}
    </div>
  );
}

function PageMenu({ menu, favorite, canNest, onClose, onFavorite, onRename, onAdd, onTrash, onMove, onDuplicate, onOpenWindow, isHome, onHome, quickMoves, onQuickMove }: {
  menu: Menu;
  favorite: boolean;
  canNest: boolean;
  onClose: () => void;
  onFavorite: (on: boolean) => void;
  onRename: () => void;
  onAdd: () => void;
  onTrash: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  /** BSD-202: in eigenem Fenster (Hülle) bzw. neuem Browser-Fenster. */
  onOpenWindow: () => void;
  /** Diese Seite ist Home bzw. soll es werden (aus: zurück zum Dashboard). */
  isHome: boolean;
  onHome: (on: boolean) => void;
  /** Direkt in einen anderen Abschnitt (Private, Teamspaces) – nur für Seiten der obersten Ebene. */
  quickMoves: { id: string; label: string }[];
  onQuickMove: (section: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const item = (label: string, icon: IconName, run: () => void) => (
    <button type="button" role="menuitem" className="menu-item" onClick={() => {
      onClose();
      run();
    }}>
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
  const pos: CSSProperties = { left: menu.x, top: menu.y };
  return (
    <div ref={ref} role="menu" aria-label="Page actions" className="menu" style={pos}>
      {item(favorite ? "Remove from Favorites" : "Add to Favorites", "star", () => onFavorite(!favorite))}
      {item(isHome ? "Use dashboard as Home" : "Set as Home", "home", () => onHome(!isHome))}
      {item("Rename", "page", onRename)}
      {canNest ? item("Add a page inside", "plus", onAdd) : null}
      {item("Duplicate", "duplicate", onDuplicate)}
      {item("Open in new window", "expand", onOpenWindow)}
      {item("Move to…", "move", onMove)}
      {quickMoves.slice(0, 4).map((q) => <span key={q.id} style={{ display: "contents" }}>{item(q.label, q.id === PRIVATE ? "lock" : "teamspace", () => onQuickMove(q.id))}</span>)}
      {item("Move to Trash", "trash", onTrash)}
    </div>
  );
}
