// BSD-155: Einstieg – eine Datenbank mit ihren Ansichten als Tabs, Filter-Chips, Sortierung, Suche,
// Ansichts-Einstellungen und „New“. Eingehängt in Seiten (inline) oder als ganze Seite.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addRow, addRowOnDay, addView, calendarDateProperty, calendarEndProperty, plainText, today, setDatabaseTitle, viewsForBlock,
  type Block, type DatabaseView as View, type WorkspaceStore,
} from "@based/core";
import { DBContext, ShellSlots, useDatabaseContext, useDB, type FormRenderProps } from "./context.js";
import { countConditions, describeCondition, topConditions } from "./logic/filters.js";
import { openModeOf, parsePeek, peekPosition, peekShortcut, restorePeek, rowOrder, serializePeek, type OpenMode, type PeekState } from "./logic/peek.js";
import { FilterEditor } from "./menus/FilterEditor.js";
import { SortEditor } from "./menus/SortEditor.js";
import { ViewSettings } from "./menus/ViewSettings.js";
import { groupProperty, newRowValues } from "./layouts/shared.js";
import { Icon, MenuItem, Popover, VIEW_ICONS, type Anchor } from "./ui.js";
import { useQuery, ViewBody } from "./ViewBody.js";

/** Was die Hülle eines Peeks (Drawer/Dialog der Shell) braucht. Gerendert wird im DBContext der Datenbank. */
export interface PeekRenderProps {
  store: WorkspaceStore;
  rowID: string;
  /** Die Zeile; `undefined`, wenn sie inzwischen gelöscht wurde. */
  row: Block | undefined;
  mode: Exclude<OpenMode, "fullPage">;
  /** Stelle in der Ansicht (0-basiert, -1 = nicht mehr in der Ansicht) und Anzahl der Zeilen der Ansicht. */
  index: number;
  total: number;
  onPrev: (() => void) | undefined;
  onNext: (() => void) | undefined;
  onClose: () => void;
  /** „Open as full page“; `undefined`, wenn die Shell keine Seiten öffnen kann. */
  onOpenFull: (() => void) | undefined;
  locked: boolean;
}

/** Zeilen als Peek öffnen: Hülle der Shell, Speicher fürs Neuladen, Ausnahme (z. B. ⌘-Klick → neuer Tab). */
export interface PeekOptions {
  render: (p: PeekRenderProps) => ReactNode;
  storage?: { get(): string | null; set(value: string | null): void } | undefined;
  /** `true`: diese Zeile nicht als Peek, sondern direkt über `onOpenPage` öffnen. */
  bypass?: (() => boolean) | undefined;
}

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
  /** Erster Wochentag für Kalender und Timeline (0 = Sonntag … 6 = Samstag) aus den App-Einstellungen; sonst aus dem Locale. */
  weekStart?: number | undefined;
  /** Nur lesen (zusätzlich zur Sperre der Datenbank). */
  readOnly?: boolean | undefined;
  /** Titel der Datenbank über den Tabs zeigen (Standard: ja). */
  showTitle?: boolean | undefined;
  /** Höhe des Ganzen (Standard 100 % des Elternelements); die Ansicht scrollt darin. */
  height?: number | string | undefined;
  className?: string | undefined;
  /** Formular-Ansicht aus dem Komponenten-Baukasten der Shell (Astryx); ohne das ein Hinweis. */
  renderForm?: ((p: FormRenderProps) => ReactNode) | undefined;
  /** Zeilen als Side/Center Peek öffnen (je Ansicht „Open pages in“); ohne das öffnet alles über `onOpenPage`. */
  peek?: PeekOptions | undefined;
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
          {["table", "board", "list", "gallery", "chart", "dashboard", "calendar", "timeline", "form", "map"].map((t) => (
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
  const isForm = view.type === "form";
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
      {!locked && showsRows && !isForm && <button type="button" className="dbui-chip primary" onClick={onNew}>New</button>}
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

/** Offener Peek: Reihenfolge laut seiner Ansicht (nur gerechnet, solange er offen ist), Vor/Zurück, Kürzel. */
function Peek({ state, view, search, options, onChange }: { state: PeekState; view: View; search: string; options: PeekOptions; onChange: (s: PeekState | undefined) => void }) {
  const { store, locked } = useDB();
  const outer = useContext(OuterOpenPage);
  const result = useQuery(view, search);
  const order = useMemo(() => rowOrder(result), [result]);
  const last = useRef(-1);
  const pos = peekPosition(order, state.rowID, last.current);
  if (pos.index >= 0) last.current = pos.index;
  const go = (id: string | undefined) => (id ? () => onChange({ rowID: id, viewID: state.viewID }) : undefined);
  const onPrev = go(pos.prev), onNext = go(pos.next);
  const nav = useRef({ onPrev, onNext });
  nav.current = { onPrev, onNext };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = peekShortcut(e);
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      (dir === "prev" ? nav.current.onPrev : nav.current.onNext)?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const mode = openModeOf(view);
  return <>{options.render({
    store, rowID: state.rowID, row: store.blocks.get(state.rowID), mode: mode === "fullPage" ? "sidePeek" : mode, index: pos.index, total: pos.total,
    onPrev, onNext, onClose: () => onChange(undefined), locked,
    onOpenFull: outer ? () => { onChange(undefined); outer(state.rowID); } : undefined,
  })}</>;
}

/** `onOpenPage` der Shell (im Kontext steckt die Variante, die Zeilen als Peek öffnet). */
const OuterOpenPage = createContext<((rowID: string) => void) | undefined>(undefined);

function Inner({ blockID, viewID, onViewChange, showTitle, peek: peekOptions }: { blockID: string; viewID: string | undefined; onViewChange: ((id: string) => void) | undefined; showTitle: boolean; peek: PeekOptions | undefined }) {
  const ctx = useDB();
  const { store, db, version } = ctx;
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
  const outerOpen = ctx.onOpenPage;

  // Peek: Zustand hier, damit er Ansichtswechsel überlebt; gespeichert über `peek.storage` (Neuladen).
  const [peek, setPeekState] = useState<PeekState | undefined>(undefined);
  const storage = peekOptions?.storage;
  const setPeek = useCallback((s: PeekState | undefined) => { setPeekState(s); storage?.set(serializePeek(s)); }, [storage]);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !peekOptions || !active) return;
    restored.current = true;
    const s = restorePeek(parsePeek(storage?.get()), {
      rowIDs: (id) => { const b = store.blocks.get(id); return !!b && b.parent === "d:" + db.id && b.trashedAt === undefined; },
      viewIDs: views.map((v) => v.id), activeViewID: active.id,
    });
    if (s) setPeekState(s);
    else storage?.set(null);
  }, [peekOptions, storage, active, views, store, db.id]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const openRow = useCallback((rowID: string) => {
    const view = activeRef.current;
    const row = store.blocks.get(rowID);
    const mode = openModeOf(view);
    if (!peekOptions || !view || !row || row.parent !== "d:" + db.id || mode === "fullPage" || peekOptions.bypass?.()) { outerOpen?.(rowID); return; }
    setPeek({ rowID, viewID: view.id });
  }, [peekOptions, store, db.id, outerOpen, setPeek]);
  const inner = useMemo(() => (peekOptions ? { ...ctx, onOpenPage: openRow } : ctx), [ctx, peekOptions, openRow]);
  const onOpenPage = inner.onOpenPage;
  if (!active) return <div className="dbui-empty">This database has no views.</div>;
  const peekView = peek ? views.find((v) => v.id === peek.viewID) ?? active : undefined;
  const onNew = () => {
    const values = newRowValues(db, active, groupProperty(db, active), null);
    // BSD-8: in Kalender und Timeline bekommt die neue Zeile heute als Datum (sonst landet sie unter „No date“).
    const dateProp = active.type === "calendar" || active.type === "timeline" ? calendarDateProperty(db, active) : undefined;
    const endProp = calendarEndProperty(db, active);
    const id = dateProp?.type === "date" && (!endProp || endProp.type === "date")
      ? addRowOnDay(store, db.id, { dateID: dateProp.id, ...(endProp && endProp.id !== dateProp.id ? { endID: endProp.id } : {}) }, today(), { values })
      : addRow(store, db.id, { values });
    if (!id) return;
    if (active.type === "table") setRequestEdit({ rowID: id });
    else onOpenPage?.(id);
  };
  return (
    <DBContext.Provider value={inner}>
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
      {peek && peekView && peekOptions && (
        <OuterOpenPage.Provider value={outerOpen}>
          <Peek state={peek} view={peekView} search={peekView.id === active.id ? search : ""} options={peekOptions} onChange={setPeek} />
        </OuterOpenPage.Provider>
      )}
    </DBContext.Provider>
  );
}

/**
 * Eine Datenbank mit Ansichten. Alle Änderungen laufen über Store-Transaktionen; neu gerechnet wird nur,
 * wenn sich diese Datenbank oder eine über Relationen gelesene ändert.
 */
export function DatabaseView(props: DatabaseViewProps) {
  const { store, databaseID } = props;
  const ctx = useDatabaseContext(store, databaseID, { readOnly: props.readOnly, onOpenPage: props.onOpenPage, isAgentEdit: props.isAgentEdit, weekStart: props.weekStart });
  const style = { height: props.height ?? "100%" };
  const slots = useMemo(() => ({ renderForm: props.renderForm }), [props.renderForm]);
  if (!ctx) return <div className="dbui-root dbui-empty" style={style} role="status">Database not found.</div>;
  return (
    <DBContext.Provider value={ctx}>
      <ShellSlots.Provider value={slots}>
      <div className={"dbui-root" + (props.className ? " " + props.className : "")} style={style} data-testid="database-view">
        <Inner blockID={props.blockID ?? ctx.db.blockID} viewID={props.viewID} onViewChange={props.onViewChange} showTitle={props.showTitle !== false} peek={props.peek} />
      </div>
      </ShellSlots.Provider>
    </DBContext.Provider>
  );
}
