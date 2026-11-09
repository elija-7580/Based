// BSD-155: Einstieg – eine Datenbank mit ihren Ansichten als Tabs, Filter-Chips, Sortierung, Suche,
// Ansichts-Einstellungen und „New“. Eingehängt in Seiten (inline) oder als ganze Seite.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addRow, addView, plainText, setDatabaseTitle, viewsForBlock,
  type Block, type DatabaseView as View, type WorkspaceStore,
} from "@based/core";
import { DBContext, useDatabaseContext, useDB } from "./context.js";
import { countConditions, describeCondition, topConditions } from "./logic/filters.js";
import { FilterEditor } from "./menus/FilterEditor.js";
import { SortEditor } from "./menus/SortEditor.js";
import { ViewSettings } from "./menus/ViewSettings.js";
import { groupProperty, newRowValues } from "./layouts/shared.js";
import { Icon, MenuItem, Popover, VIEW_ICONS, type Anchor } from "./ui.js";
import { useQuery, ViewBody } from "./ViewBody.js";

export interface DatabaseViewProps {
  store: WorkspaceStore;
  databaseID: string;
  /** Anfangs (bzw. von außen gesteuert) gezeigte Ansicht; sonst die erste Ansicht des Blocks. */
  viewID?: string | undefined;
  /** Block, dessen Ansichten als Tabs erscheinen (verknüpfte Ansicht); Standard: der Block der Datenbank. */
  blockID?: string | undefined;
  /** Zeile/Seite öffnen (Titel, Relationen, Karten). */
  onOpenPage?: ((rowID: string) => void) | undefined;
  /** Der Nutzer hat eine andere Ansicht gewählt (zum Merken in der Shell). */
  onViewChange?: ((viewID: string) => void) | undefined;
  /** Agent-Strich: Standard ist `updatedBy` „agent…“/„based“. */
  isAgentEdit?: ((row: Block) => boolean) | undefined;
  /** Nur lesen (zusätzlich zur Sperre der Datenbank). */
  readOnly?: boolean | undefined;
  /** Titel der Datenbank über den Tabs zeigen (Standard: ja). */
  showTitle?: boolean | undefined;
  /** Höhe des Ganzen (Standard 100 % des Elternelements); die Ansicht scrollt darin. */
  height?: number | string | undefined;
  className?: string | undefined;
}

function Tabs({ views, active, onSelect, blockID }: { views: View[]; active: View; onSelect: (id: string) => void; blockID: string }) {
  const { store, locked } = useDB();
  const [add, setAdd] = useState<Anchor | null>(null);
  return (
    <div className="dbui-tabs" role="tablist" aria-label="Views">
      {views.map((v) => (
        <button key={v.id} type="button" role="tab" className="dbui-tab" aria-selected={v.id === active.id} onClick={() => onSelect(v.id)} data-view-id={v.id}>
          <Icon name={VIEW_ICONS[v.type] ?? "table"} size={14} />{v.name}
        </button>
      ))}
      {!locked && <button type="button" className="dbui-icon-btn" aria-label="Add view" onClick={(e) => setAdd(e.currentTarget)}><Icon name="plus" size={14} /></button>}
      {add && (
        <Popover anchor={add} onClose={() => setAdd(null)} role="menu" label="Add view">
          {["table", "board", "list", "gallery", "chart", "dashboard", "calendar", "timeline"].map((t) => (
            <MenuItem key={t} icon={<Icon name={VIEW_ICONS[t] ?? "table"} />} testID={`add-view-${t}`} onClick={() => {
              const id = addView(store, blockID, t);
              setAdd(null);
              if (id) onSelect(id);
            }}>{t[0]!.toUpperCase() + t.slice(1)}</MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}

function Toolbar({ view, search, setSearch, onNew }: { view: View; search: string; setSearch: (s: string) => void; onNew: () => void }) {
  const { store, db, locked } = useDB();
  const [filter, setFilter] = useState<Anchor | null>(null);
  const [sort, setSort] = useState<Anchor | null>(null);
  const [settings, setSettings] = useState<Anchor | null>(null);
  const [searching, setSearching] = useState(search !== "");
  const result = useQuery(view, search);
  const chips = topConditions(view.filter);
  const nested = countConditions(view.filter) - chips.length;
  const sorts = view.sorts ?? [];
  const sortName = sorts[0] ? db.properties.find((p) => p.id === sorts[0]!.propertyID)?.name ?? "?" : "";
  const gp = groupProperty(db, view);
  const groups = useMemo(() => {
    if (!gp) return [];
    const opts = (gp.options ?? []).map((o) => ({ id: o.id, title: o.name }));
    return ["select", "status", "multiSelect"].includes(gp.type) ? [{ id: "", title: `No ${gp.name}` }, ...opts] : (result.groups ?? []).map((g) => ({ id: g.id, title: g.title }));
  }, [gp, result.groups]);
  const live = store.views.get(view.id) ?? view;
  const showsRows = view.type !== "dashboard";
  return (
    <div className="dbui-actions">
      {showsRows && chips.map(({ condition }) => (
        <button key={condition.id} type="button" className="dbui-chip" data-testid="filter-chip" onClick={(e) => setFilter(e.currentTarget)} aria-label={`Filter: ${describeCondition(store, db, condition)}`}>
          {describeCondition(store, db, condition)}
        </button>
      ))}
      {showsRows && nested > 0 && <button type="button" className="dbui-chip" onClick={(e) => setFilter(e.currentTarget)}>+{nested} rules</button>}
      {showsRows && <button type="button" className="dbui-chip ghost" onClick={(e) => setFilter(e.currentTarget)}><Icon name="filter" size={14} />Filter</button>}
      {showsRows && (sorts.length
        ? <button type="button" className="dbui-chip" onClick={(e) => setSort(e.currentTarget)}><Icon name="sort" size={14} />{sorts.length > 1 ? `${sorts.length} sorts` : `${sortName} ${sorts[0]!.ascending ? "↑" : "↓"}`}</button>
        : <button type="button" className="dbui-chip ghost" onClick={(e) => setSort(e.currentTarget)}><Icon name="sort" size={14} />Sort</button>)}
      {showsRows && (searching
        ? <input className="dbui-input dbui-search" type="search" placeholder="Search" aria-label="Search this view" value={search} autoFocus onChange={(e) => setSearch(e.target.value)}
            onBlur={() => { if (!search) setSearching(false); }} onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearching(false); } }} />
        : <button type="button" className="dbui-icon-btn" aria-label="Search" onClick={() => setSearching(true)}><Icon name="search" size={14} /></button>)}
      {showsRows && <span className="dbui-data dbui-rowcount" aria-label="Pages in view">{result.rows.length.toLocaleString("en-US")}</span>}
      <button type="button" className="dbui-icon-btn" aria-label="View settings" onClick={(e) => setSettings(e.currentTarget)}><Icon name="settings" size={14} /></button>
      {!locked && showsRows && <button type="button" className="dbui-chip primary" onClick={onNew}>New</button>}
      {locked && <span className="dbui-hint" role="status">Locked</span>}
      {filter && <FilterEditor view={live} anchor={filter} onClose={() => setFilter(null)} />}
      {sort && <SortEditor view={live} anchor={sort} onClose={() => setSort(null)} />}
      {settings && <ViewSettings view={live} anchor={settings} onClose={() => setSettings(null)} groups={groups} />}
    </div>
  );
}

function Title() {
  const { store, db, locked } = useDB();
  const [text, setText] = useState(plainText(db.title));
  useEffect(() => setText(plainText(db.title)), [db.title]);
  return locked
    ? <h2 className="dbui-title">{text || "Untitled"}</h2>
    : <input className="dbui-title" aria-label="Database title" placeholder="Untitled" value={text}
        onChange={(e) => { setText(e.target.value); setDatabaseTitle(store, db.id, e.target.value); }} />;
}

function Inner({ blockID, viewID, onViewChange, showTitle }: { blockID: string; viewID: string | undefined; onViewChange: ((id: string) => void) | undefined; showTitle: boolean }) {
  const { store, db, version } = useDB();
  const views = useMemo(() => {
    const list = viewsForBlock(store, blockID);
    return list.length ? list : [...store.views.values()].filter((v) => v.databaseID === db.id && v.widgetOf === undefined);
  }, [store, blockID, db.id, version]);
  const [selected, setSelected] = useState<string | undefined>(viewID);
  useEffect(() => { if (viewID) setSelected(viewID); }, [viewID]);
  const active = views.find((v) => v.id === selected) ?? views[0];
  const [search, setSearch] = useState("");
  const [requestEdit, setRequestEdit] = useState<{ rowID: string } | undefined>(undefined);
  const select = useCallback((id: string) => { setSelected(id); onViewChange?.(id); }, [onViewChange]);
  const { onOpenPage } = useDB();
  if (!active) return <div className="dbui-empty">This database has no views.</div>;
  const onNew = () => {
    const id = addRow(store, db.id, { values: newRowValues(db, active, groupProperty(db, active), null) });
    if (!id) return;
    if (active.type === "table") setRequestEdit({ rowID: id });
    else onOpenPage?.(id);
  };
  return (
    <>
      <div className="dbui-head">
        {showTitle && <Title />}
        <div className="dbui-toolbar">
          <Tabs views={views} active={active} onSelect={select} blockID={blockID} />
          <Toolbar view={active} search={search} setSearch={setSearch} onNew={onNew} />
        </div>
      </div>
      <div className="dbui-body" role="tabpanel" aria-label={active.name} data-view-type={active.type}>
        <ViewBody key={active.id} view={active} search={search} requestEdit={requestEdit} />
      </div>
    </>
  );
}

/**
 * Eine Datenbank mit Ansichten. Alle Änderungen laufen über Store-Transaktionen; neu gerechnet wird nur,
 * wenn sich diese Datenbank oder eine über Relationen gelesene ändert.
 */
export function DatabaseView(props: DatabaseViewProps) {
  const { store, databaseID } = props;
  const ctx = useDatabaseContext(store, databaseID, { readOnly: props.readOnly, onOpenPage: props.onOpenPage, isAgentEdit: props.isAgentEdit });
  const style = { height: props.height ?? "100%" };
  if (!ctx) return <div className="dbui-root dbui-empty" style={style} role="status">Database not found.</div>;
  return (
    <DBContext.Provider value={ctx}>
      <div className={"dbui-root" + (props.className ? " " + props.className : "")} style={style} data-testid="database-view">
        <Inner blockID={props.blockID ?? ctx.db.blockID} viewID={props.viewID} onViewChange={props.onViewChange} showTitle={props.showTitle !== false} />
      </div>
    </DBContext.Provider>
  );
}
