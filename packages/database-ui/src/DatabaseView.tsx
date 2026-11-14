// BSD-155: Einstieg – eine Datenbank mit ihren Ansichten als Tabs, Filter-Chips, Sortierung, Suche,
// Ansichts-Einstellungen und „New“. Eingehängt in Seiten (inline) oder als ganze Seite.
import type { AutofillWriter } from "./logic/autofill.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  deleteView, duplicateView, renameView,
  addRow, addRowOnDay, addTemplate, addView, calendarDateProperty, calendarEndProperty, dbops, plainText, today, setDatabaseTitle, viewsForBlock,
  type Block, type DatabaseView as View, type WorkspaceStore,
} from "@based/core";
import { DBContext, INLINE_PAGE_SIZE, InlineView, ShellSlots, useDatabaseContext, useDB, type DatabaseSource, type FileHost, type FormRenderProps, type RowActions } from "./context.js";
import { countConditions, describeCondition, topConditions } from "./logic/filters.js";
import { openModeOf, parsePeek, peekPosition, peekShortcut, restorePeek, rowOrder, serializePeek, type OpenMode, type PeekState } from "./logic/peek.js";
import { FilterEditor } from "./menus/FilterEditor.js";
import { SortEditor } from "./menus/SortEditor.js";
import { ViewSettings } from "./menus/ViewSettings.js";
import { groupProperty, newRowValues } from "./layouts/shared.js";
import { Icon, MenuItem, MenuSeparator, Popover, VIEW_ICONS, type Anchor } from "./ui.js";
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
  /** BSD-208: Asset-Speicher für Datei-Uploads in der Files-&-Media-Property; ohne: nur Links. */
  files?: FileHost | undefined;
  /** BSD-225 Teil 2: Modell für „Autofill with AI“ im Property-Menü (fehlt = kein Menüpunkt). */
  ai?: AutofillWriter | undefined;
  /** BSD-216: andere Datenbanken als Dashboard-Quelle. */
  databases?: DatabaseSource | undefined;
  /** BSD-216: bekannte Personen (Namen) für die Personen-Auswahl. */
  people?: (() => Promise<string[]>) | undefined;
  /** Erster Wochentag für Kalender und Timeline (0 = Sonntag … 6 = Samstag) aus den App-Einstellungen; sonst aus dem Locale. */
  weekStart?: number | undefined;
  /** BSD-213: Sammelaktionen der Shell für ausgewählte Zeilen (in Tabs öffnen, Links kopieren). */
  rowActions?: RowActions | undefined;
  /** Nur lesen (zusätzlich zur Sperre der Datenbank). */
  readOnly?: boolean | undefined;
  /** Titel der Datenbank über den Tabs zeigen (Standard: ja). */
  showTitle?: boolean | undefined;
  /** Höhe des Ganzen (Standard 100 % des Elternelements); die Ansicht scrollt darin. */
  height?: number | string | undefined;
  /**
   * BSD-255: inline in einer Seite – kein Rahmen, kein eigener senkrechter Scroller in Tabelle (Zeilen mit „Load more“),
   * Werkzeuge erst beim Überfahren, „Open as full page“ über `onOpenPage(blockID)`. Andere Ansichten behalten eine Höhe.
   */
  inline?: boolean | undefined;
  className?: string | undefined;
  /** Formular-Ansicht aus dem Komponenten-Baukasten der Shell (Astryx); ohne das ein Hinweis. */
  renderForm?: ((p: FormRenderProps) => ReactNode) | undefined;
  /** Zeilen als Side/Center Peek öffnen (je Ansicht „Open pages in“); ohne das öffnet alles über `onOpenPage`. */
  peek?: PeekOptions | undefined;
}

/**
 * Menü eines Ansichts-Tabs (Rechtsklick oder Klick auf den aktiven Tab, wie Notion): Name direkt ändern, Ansicht
 * bearbeiten, duplizieren, löschen. Gleiche Bausteine wie das Spaltenmenü.
 */
function ViewMenu({ view, anchor, onClose, onEdit, canDelete, onSelect }: {
  view: View; anchor: Anchor; onClose: () => void; onEdit: (a: Anchor) => void; canDelete: boolean; onSelect: (id: string) => void;
}) {
  const { store, locked } = useDB();
  const [name, setName] = useState(view.name);
  const commit = () => { if (name.trim() && name !== view.name) renameView(store, view.id, name.trim()); };
  return (
    <Popover anchor={anchor} onClose={() => { commit(); onClose(); }} className="dbui-property-menu" label={`View ${view.name}`} role="menu">
      <div className="dbui-option-field">
        <span className="dbui-menu-icon" aria-hidden><Icon name={VIEW_ICONS[view.type] ?? "table"} /></span>
        <input className="dbui-input bare" aria-label="View name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(); onClose(); } }} />
      </div>
      <MenuItem icon={<Icon name="settings" />} testID="view-menu-edit" onClick={() => { commit(); onClose(); onEdit(anchor); }}>Edit view</MenuItem>
      {!locked && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Icon name="copy" />} testID="view-menu-duplicate" onClick={() => { commit(); const id = duplicateView(store, view.id); onClose(); if (id) onSelect(id); }}>Duplicate view</MenuItem>
          <MenuItem icon={<Icon name="trash" />} danger disabled={!canDelete} testID="view-menu-delete" onClick={() => { deleteView(store, view.id); onClose(); }}>Delete view</MenuItem>
        </>
      )}
    </Popover>
  );
}

function Tabs({ views, active, onSelect, blockID, inline, onEdit }: { views: View[]; active: View; onSelect: (id: string) => void; blockID: string; inline?: boolean | undefined; onEdit: (a: Anchor) => void }) {
  const { store, locked } = useDB();
  const [add, setAdd] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<{ view: View; anchor: Anchor } | null>(null);
  // Inline mit nur einer Ansicht: kein einzelner Tab („Table“) – wie Notion; „+“ bleibt beim Überfahren erreichbar.
  const single = inline && views.length === 1;
  return (
    <div className={"dbui-tabs" + (single ? " single" : "")} role="tablist" aria-label="Views">
      {!single && views.map((v) => (
        <button key={v.id} type="button" role="tab" className="dbui-tab" aria-selected={v.id === active.id} aria-haspopup="menu" data-view-id={v.id}
          onClick={(e) => { if (v.id === active.id) setMenu({ view: v, anchor: e.currentTarget }); else onSelect(v.id); }}
          onContextMenu={(e) => { e.preventDefault(); onSelect(v.id); setMenu({ view: v, anchor: e.currentTarget }); }}>
          <Icon name={VIEW_ICONS[v.type] ?? "table"} size={14} />{v.name}
        </button>
      ))}
      {!locked && <button type="button" className="dbui-icon-btn" aria-label="Add view" onClick={(e) => setAdd(e.currentTarget)}><Icon name="plus" size={14} /></button>}
      {menu && <ViewMenu view={menu.view} anchor={menu.anchor} onClose={() => setMenu(null)} onEdit={onEdit} canDelete={views.length > 1} onSelect={onSelect} />}
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

/**
 * BSD-212: Vorlagen am „New“-Knopf (wie Notion): neue Seite aus einer Vorlage oder leer, Vorlage anlegen, bearbeiten
 * (öffnet sie wie eine Zeile), als Standard setzen, löschen. Vorlagen sind Zeilen mit `isTemplate` (nie in Ansichten).
 */
function TemplateMenu({ anchor, onClose, onNew }: { anchor: Anchor; onClose: () => void; onNew: (template: string) => void }) {
  const { store, db, onOpenPage } = useDB();
  const [editing, setEditing] = useState<string | null>(null);
  const templates = dbops.templatesOf(store, db.id);
  const def = db.defaultTemplateID && templates.some((t) => t.id === db.defaultTemplateID) ? db.defaultTemplateID : undefined;
  const open = (id: string) => { onClose(); onOpenPage?.(id); };
  const tpl = editing ? templates.find((t) => t.id === editing) : undefined;
  if (tpl) {
    const name = plainText(tpl.text) || "Untitled";
    return (
      <Popover anchor={anchor} onClose={onClose} className="dbui-property-menu" label={`Template ${name}`} role="menu">
        <MenuItem icon={<Icon name="chevronLeft" size={14} />} onClick={() => setEditing(null)}>{name}</MenuItem>
        <div className="dbui-menu-sep" role="separator" />
        <MenuItem onClick={() => open(tpl.id)}>Edit template</MenuItem>
        {def === tpl.id
          ? <MenuItem onClick={() => { dbops.setDefaultTemplate(store, db.id, undefined); setEditing(null); }}>Remove as default</MenuItem>
          : <MenuItem onClick={() => { dbops.setDefaultTemplate(store, db.id, tpl.id); setEditing(null); }}>Set as default</MenuItem>}
        <MenuItem danger onClick={() => { dbops.deleteTemplate(store, db.id, tpl.id); setEditing(null); }}>Delete template</MenuItem>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-property-menu" label="Templates" role="menu">
      <MenuItem selected={!def} hint={!def ? "Default" : undefined} onClick={() => { onClose(); onNew(""); }}>Empty page</MenuItem>
      {templates.map((t) => (
        <div key={t.id} className="dbui-template-row">
          <MenuItem selected={def === t.id} hint={def === t.id ? "Default" : undefined} testID="template-item" onClick={() => { onClose(); onNew(t.id); }}>{plainText(t.text) || "Untitled"}</MenuItem>
          <button type="button" className="dbui-icon-btn" aria-label={`Template options for ${plainText(t.text) || "Untitled"}`} onClick={() => setEditing(t.id)}><Icon name="more" size={14} /></button>
        </div>
      ))}
      <div className="dbui-menu-sep" role="separator" />
      <MenuItem icon={<Icon name="plus" size={14} />} onClick={() => { const id = addTemplate(store, db.id); if (id) open(id); }}>New template</MenuItem>
    </Popover>
  );
}

function Toolbar({ view, search, setSearch, onNew, settingsRequest, onSettingsShown }: {
  view: View; search: string; setSearch: (s: string) => void; onNew: (template?: string) => void; settingsRequest?: Anchor | null; onSettingsShown?: () => void;
}) {
  const { store, db, locked } = useDB();
  const [templates, setTemplates] = useState<Anchor | null>(null);
  const [filter, setFilter] = useState<Anchor | null>(null);
  const [sort, setSort] = useState<Anchor | null>(null);
  const [settings, setSettings] = useState<Anchor | null>(null);
  // „Edit view“ aus dem Tab-Menü öffnet dieselben Ansichts-Einstellungen am Tab.
  useEffect(() => { if (settingsRequest) { setSettings(settingsRequest); onSettingsShown?.(); } }, [settingsRequest, onSettingsShown]);
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
      {showsRows && <button type="button" className="dbui-chip ghost" aria-label="Filter" onClick={(e) => setFilter(e.currentTarget)}><Icon name="filter" size={14} /><span className="dbui-chip-label">Filter</span></button>}
      {showsRows && (sorts.length
        ? <button type="button" className="dbui-chip" onClick={(e) => setSort(e.currentTarget)}><Icon name="sort" size={14} />{sorts.length > 1 ? `${sorts.length} sorts` : `${sortName} ${sorts[0]!.ascending ? "↑" : "↓"}`}</button>
        : <button type="button" className="dbui-chip ghost" aria-label="Sort" onClick={(e) => setSort(e.currentTarget)}><Icon name="sort" size={14} /><span className="dbui-chip-label">Sort</span></button>)}
      {showsRows && (searching
        ? <input className="dbui-input dbui-search" type="search" placeholder="Search" aria-label="Search this view" value={search} autoFocus onChange={(e) => setSearch(e.target.value)}
            onBlur={() => { if (!search) setSearching(false); }} onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearching(false); } }} />
        : <button type="button" className="dbui-icon-btn" aria-label="Search" onClick={() => setSearching(true)}><Icon name="search" size={14} /></button>)}
      {showsRows && <span className="dbui-data dbui-rowcount" aria-label="Pages in view">{result.rows.length.toLocaleString("en-US")}</span>}
      <button type="button" className="dbui-icon-btn" aria-label="View settings" onClick={(e) => setSettings(e.currentTarget)}><Icon name="settings" size={14} /></button>
      {!locked && showsRows && !isForm && (
        <span className="dbui-split">
          <button type="button" className="dbui-chip primary" onClick={() => onNew()}>New</button>
          <button type="button" className="dbui-chip primary dbui-split-more" aria-label="New page templates" aria-haspopup="menu" onClick={(e) => setTemplates(e.currentTarget)}><Icon name="chevronDown" size={14} /></button>
        </span>
      )}
      {templates && <TemplateMenu anchor={templates} onClose={() => setTemplates(null)} onNew={onNew} />}
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
  // Ein langer Titel bricht um (in schmalen Spalten wurde er sonst abgeschnitten): einzeiliges Textfeld, das mitwächst.
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const fit = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
    fit();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text]);
  return locked
    ? <h2 className="dbui-title">{text || "Untitled"}</h2>
    : <textarea ref={field} className="dbui-title" aria-label="Database title" placeholder="Untitled" value={text} rows={1} spellCheck={false}
        onChange={(e) => { const t = e.target.value.replace(/[\r\n]+/g, " "); setText(t); setDatabaseTitle(store, db.id, t); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />;
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

function Inner({ blockID, viewID, onViewChange, showTitle, peek: peekOptions, inline }: { blockID: string; viewID: string | undefined; onViewChange: ((id: string) => void) | undefined; showTitle: boolean; peek: PeekOptions | undefined; inline?: boolean | undefined }) {
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
  const [editView, setEditView] = useState<Anchor | null>(null);
  const clearEditView = useCallback(() => setEditView(null), []);
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
  const titled = showTitle && !(inline && active.showTitle === false);
  const peekView = peek ? views.find((v) => v.id === peek.viewID) ?? active : undefined;
  const onNew = (template?: string) => {
    const values = newRowValues(db, active, groupProperty(db, active), null);
    // BSD-8: in Kalender und Timeline bekommt die neue Zeile heute als Datum (sonst landet sie unter „No date“).
    const dateProp = active.type === "calendar" || active.type === "timeline" ? calendarDateProperty(db, active) : undefined;
    const endProp = calendarEndProperty(db, active);
    const id = dateProp?.type === "date" && (!endProp || endProp.type === "date")
      ? addRowOnDay(store, db.id, { dateID: dateProp.id, ...(endProp && endProp.id !== dateProp.id ? { endID: endProp.id } : {}) }, today(), { values, ...(template !== undefined ? { template } : {}) })
      : addRow(store, db.id, { values, ...(template !== undefined ? { template } : {}) });
    if (!id) return;
    if (active.type === "table" && !template) setRequestEdit({ rowID: id });
    else onOpenPage?.(id);
  };
  return (
    <DBContext.Provider value={inner}>
      {/* Inline lässt sich der Titel je Ansicht ausblenden (wie Notions „Show database title“); dann nur noch die Liste. */}
      <div className={"dbui-head" + (titled ? "" : " untitled")}>
        {titled && <Title />}
        <div className="dbui-toolbar">
          <Tabs views={views} active={active} onSelect={select} blockID={blockID} inline={inline} onEdit={setEditView} />
          <Toolbar view={active} search={search} setSearch={setSearch} onNew={onNew} settingsRequest={editView} onSettingsShown={clearEditView} />
          {inline && outerOpen ? (
            <button type="button" className="dbui-icon-btn dbui-open-full" aria-label="Open as full page" title="Open as full page" onClick={() => outerOpen(blockID)}>
              <Icon name="open" size={14} />
            </button>
          ) : null}
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
  const ctx = useDatabaseContext(store, databaseID, { readOnly: props.readOnly, onOpenPage: props.onOpenPage, isAgentEdit: props.isAgentEdit, weekStart: props.weekStart, rowActions: props.rowActions });
  const style = { height: props.height ?? (props.inline ? "auto" : "100%") };
  const inline = useMemo(() => (props.inline ? { pageSize: INLINE_PAGE_SIZE } : null), [props.inline]);
  const slots = useMemo(() => ({ renderForm: props.renderForm, files: props.files, ai: props.ai, databases: props.databases, people: props.people }), [props.renderForm, props.files, props.ai, props.databases, props.people]);
  // BSD-293: ⌘Z/⇧⌘Z (⌘Y) für Änderungen in der Datenbank, solange der Fokus nicht in einem Textfeld oder Editor liegt.
  // Mehrere Ansichten derselben Seite teilen den Store: die erste nimmt die Taste (preventDefault), die anderen nicht.
  useEffect(() => {
    if (props.readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const k = undoKey(e);
      if (!k || e.defaultPrevented || isEditable(e.target)) return;
      e.preventDefault();
      if (k === "undo") store.undo();
      else store.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, props.readOnly]);
  if (!ctx) return <div className="dbui-root dbui-empty" style={style} role="status">Database not found.</div>;
  return (
    <DBContext.Provider value={ctx}>
      <ShellSlots.Provider value={slots}>
      <InlineView.Provider value={inline}>
      <div className={"dbui-root" + (props.inline ? " inline" : "") + (props.className ? " " + props.className : "")} style={style} data-testid="database-view">
        <Inner blockID={props.blockID ?? ctx.db.blockID} viewID={props.viewID} onViewChange={props.onViewChange} showTitle={props.showTitle !== false} peek={props.peek} inline={props.inline} />
      </div>
      </InlineView.Provider>
      </ShellSlots.Provider>
    </DBContext.Provider>
  );
}

/** ⌘Z → undo, ⇧⌘Z oder ⌘Y → redo (Strg statt ⌘ außerhalb von Apple). */
export function undoKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): "undo" | "redo" | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return undefined;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return undefined;
}

/** Textfelder und Editoren behalten ihr eigenes Undo. */
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && typeof el.closest === "function" && !!el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
}
