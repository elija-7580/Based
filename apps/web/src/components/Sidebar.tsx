// Seitenleiste (v8) auf echten Daten: Navigation, dann Favoriten, Teamspaces und Private als virtualisierter Baum
// (nur sichtbare Zeilen im DOM, Titel getrennt von der Struktur), unten der Sync-Status. Aktiver Eintrag als
// weiße Pille. Seiten: auf-/zuklappen, neue Seite, umbenennen, Favorit, Papierkorb, Ziehen zum Umsortieren.
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { VirtualList } from "@based/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import "./teamspaces.css";
import markLight from "../../../../docs/design/logo/based-mark-small.svg?url";
import markDark from "../../../../docs/design/logo/based-mark-small-on-dark.svg?url";
import { Icon, type IconName } from "../icons.js";
import { MoveDialog } from "./MoveDialog.js";
import { DeleteTeamspaceDialog, TeamspaceDialog, type TeamspaceEdit } from "./TeamspaceDialog.js";
import type { Route } from "../shell/router.js";
import { ancestorsInOutline, dropZone, flattenSidebar, rowIndexOf, type SidebarRow } from "../shell/sidebarModel.js";
import { collapsedSections, expandedPages } from "../shell/storage.js";
import { assetsLabel } from "../assetBridge.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import type { SyncState } from "../worker/protocol.js";

/** Nur geschlossene Formen werden im aktiven Zustand gefüllt (Lupe und Zahnrad nicht). */
const FILLABLE = new Set<IconName>(["home", "graph", "trash"]);
const PRIVATE = "private";
const DRAG_TYPE = "application/x-based-page";

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
  onNavigate: (r: Route) => void;
  onOpenPage: (id: string) => void;
  onNewPage: (opts?: { parent?: string; section?: string }) => Promise<string | undefined>;
  onQuickFind: () => void;
}

interface Menu {
  id: string;
  x: number;
  y: number;
}

export function Sidebar({ client, state, route, onNavigate, onOpenPage, onNewPage, onQuickFind }: Props) {
  const { outline, titles, status } = state;
  const [expanded, setExpanded] = useState<Set<string>>(expandedPages.get);
  const [collapsed, setCollapsed] = useState<Set<string>>(collapsedSections.get);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [menu, setMenu] = useState<Menu | undefined>();
  const [drop, setDrop] = useState<{ key: string; zone: "before" | "inside" | "after" } | undefined>();
  const [moving, setMoving] = useState<string[] | undefined>();
  const [editTeamspace, setEditTeamspace] = useState<TeamspaceEdit | undefined>();
  const [deleteTeamspace, setDeleteTeamspace] = useState<{ id: string; name: string; pages: number } | undefined>();
  const dragging = useRef<string | undefined>(undefined);
  const height = useMemo(rowHeight, []);
  const activeID = route.name === "page" ? route.id : undefined;

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
        favorite={outline?.favorites.includes(row.id) ?? false}
        renaming={renaming === row.id && !row.key.startsWith("fav/")}
        dropClass={dropClass}
        onOpen={onOpenPage}
        onToggle={toggle}
        onAdd={addInside}
        onMenu={(id, x, y) => setMenu({ id, x, y })}
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
  type NavEntry = { name: string; icon: IconName; cut?: IconName; active: boolean; key?: string; badge?: string; go: () => void };
  const nav: NavEntry[] = [
    { name: "Home", icon: "home", cut: "homeDoor", active: route.name === "home", go: () => onNavigate({ name: "home" }) },
    { name: "Search", icon: "search", active: false, key: "⌘K", go: onQuickFind },
    { name: "Chat", icon: "chat", active: route.name === "chat", key: "⌘J", go: () => onNavigate({ name: "chat" }) },
    { name: "Tasks", icon: "agent", active: route.name === "tasks", go: () => onNavigate({ name: "tasks" }) },
    { name: "Graph", icon: "graph", active: route.name === "graph", go: () => onNavigate({ name: "graph" }) },
  ];
  // Fuß wie in der Swift-App: Library · Trash · Settings
  const footer: NavEntry[] = [
    { name: "Library", icon: "library", active: route.name === "library", go: () => onNavigate({ name: "library" }) },
    { name: "Trash", icon: "trash", active: route.name === "trash", ...(trashCount ? { badge: String(trashCount) } : {}), go: () => onNavigate({ name: "trash" }) },
    { name: "Settings", icon: "settings", active: route.name === "settings", key: "⌘,", go: () => onNavigate({ name: "settings" }) },
  ];
  const navButton = (n: NavEntry) => (
    <button key={n.name} type="button" className="nav-item" aria-current={n.active ? "page" : undefined} onClick={n.go}>
      <Icon name={n.icon} filled={n.active && FILLABLE.has(n.icon)} {...(n.cut ? { cut: n.cut } : {})} />
      {n.name}
      {n.badge ? <span className="badge" aria-label={`${n.badge} in Trash`}>{n.badge}</span> : n.key ? <span className="key t-data">{n.key}</span> : null}
    </button>
  );
  const menuSection = menu ? outline?.nodes[menu.id]?.section : undefined;

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="brand">
        <img className="on-light" src={markLight} alt="" />
        <img className="on-dark" src={markDark} alt="" />
        <span className="wordmark">based</span>
      </div>
      {nav.map(navButton)}
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
      <div className="sidebar-footer" role="group" aria-label="Workspace tools">{footer.map(navButton)}</div>
      <div className="synced t-meta" data-testid="sync-status" data-state={status.state} data-assets={assetsLabel(status.assets) || undefined} title={[status.detail ?? SYNC_LABEL[status.state], assetsLabel(status.assets)].filter(Boolean).join(" · ")}>
        <span className={`dot ${status.state === "synced" ? "synced-dot" : status.state === "error" || status.state === "readonly" ? "error-dot" : ""}`} aria-hidden="true" />
        {SYNC_LABEL[status.state]}
        {status.assets ? <span data-testid="sync-assets"> · {assetsLabel(status.assets)}</span> : null}
      </div>
      {menu ? (
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
          quickMoves={(outline?.nodes[menu.id]?.parent === undefined ? outline?.sections ?? [] : []).filter((x) => x.id !== menuSection).map((x) => ({ id: x.id, label: `Move to ${x.name}` }))}
          onQuickMove={(section) => void client.command({ op: "moveToSection", ids: [menu.id], section })}
          onTrash={() => {
            void client.command({ op: "trash", ids: [menu.id] });
            if (activeID === menu.id) onNavigate({ name: "home" });
          }}
        />
      ) : null}
      {moving && state.outline ? <MoveDialog client={client} state={state} ids={moving} onClose={() => setMoving(undefined)} /> : null}
      {editTeamspace ? (
        <TeamspaceDialog client={client} teamspace={editTeamspace} onClose={() => setEditTeamspace(undefined)} onSaved={() => {
          // neuer Teamspace ist sichtbar: „Teamspaces“ aufklappen
          if (collapsed.has("teamspaces")) toggleSection("teamspaces");
        }} />
      ) : null}
      {deleteTeamspace ? <DeleteTeamspaceDialog client={client} {...deleteTeamspace} onClose={() => setDeleteTeamspace(undefined)} /> : null}
    </nav>
  );
}

const indent = (depth: number) => `calc(${depth} * var(--space-4) + var(--space-1))`;

interface RowProps {
  row: Extract<SidebarRow, { kind: "page" }>;
  style: CSSProperties;
  title: string;
  icon: string | undefined;
  active: boolean;
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
    else if (e.key === "ArrowRight" && !row.expanded) p.onToggle(row.id);
    else if (e.key === "ArrowLeft" && row.expanded) p.onToggle(row.id);
  };
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren || row.expanded ? row.expanded : undefined}
      aria-selected={p.active}
      aria-label={p.title}
      tabIndex={p.active ? 0 : -1}
      className={"tree-row" + (p.active ? " active" : "") + p.dropClass}
      style={{ ...p.style, paddingLeft: indent(row.depth) }}
      draggable={!p.renaming}
      data-row=""
      onClick={() => p.onOpen(row.id)}
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

function PageMenu({ menu, favorite, canNest, onClose, onFavorite, onRename, onAdd, onTrash, onMove, onDuplicate, quickMoves, onQuickMove }: {
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
      {item("Rename", "page", onRename)}
      {canNest ? item("Add a page inside", "plus", onAdd) : null}
      {item("Duplicate", "duplicate", onDuplicate)}
      {item("Move to…", "move", onMove)}
      {quickMoves.slice(0, 4).map((q) => <span key={q.id} style={{ display: "contents" }}>{item(q.label, q.id === PRIVATE ? "lock" : "teamspace", () => onQuickMove(q.id))}</span>)}
      {item("Move to Trash", "trash", onTrash)}
    </div>
  );
}
