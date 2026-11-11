// BSD-155: Dashboard (Swift DashboardLayout): Zeilen mit bis zu 4 Widgets auf 12 Spalten; jedes Widget ist
// eine eigene Ansicht (Diagramm, Tabelle, Board …), auch aus anderen Datenbanken.
import { useContext, useEffect, useRef, useState } from "react";
import {
  addDashboardWidget, moveDashboardWidget, plainText, removeDashboardWidget, setDashboardRowHeight, setDashboardWidgetWidth, WIDGET_TYPES, type DatabaseView,
} from "@based/core";
import { DBContext, ShellSlots, useDatabaseContext, useDB } from "../context.js";
import { ViewSettings } from "../menus/ViewSettings.js";
import { Icon, MenuItem, MenuLabel, MenuSeparator, Popover, VIEW_ICONS, type Anchor } from "../ui.js";
import { EmptyState } from "./shared.js";
import { ViewBody } from "../ViewBody.js";

const ROW_HEIGHT = 320;
/** BSD-216: Zeilenhöhen und Breiten zur Wahl (12-Spalten-Raster wie Swift DashboardLayout). */
export const ROW_HEIGHTS: { label: string; px: number | undefined }[] = [{ label: "Small", px: 220 }, { label: "Medium", px: undefined }, { label: "Large", px: 460 }];
export const WIDGET_WIDTHS: { label: string; cols: number }[] = [{ label: "Quarter", cols: 3 }, { label: "Third", cols: 4 }, { label: "Half", cols: 6 }, { label: "Two thirds", cols: 8 }, { label: "Full", cols: 12 }];

/** Wo steht das Widget? (Zeile, Stelle, Anzahl Zeilen/Widgets) – für die Menüeinträge „Move …“. */
interface Place { dashboardID: string; row: number; index: number; rows: number; inRow: number; rowID: string; width: number; height: number | undefined }

function WidgetMenu({ view, place, anchor, onClose, onSettings }: { view: DatabaseView; place: Place; anchor: Anchor; onClose: () => void; onSettings: () => void }) {
  const { store } = useDB();
  const run = (f: () => void) => () => { f(); onClose(); };
  const move = (row: number, index?: number, newRow = false) => moveDashboardWidget(store, place.dashboardID, view.id, row, index, newRow);
  return (
    <Popover anchor={anchor} onClose={onClose} role="menu" label={`Widget ${view.name}`}>
      <MenuItem icon={<Icon name="settings" />} onClick={run(onSettings)}>View settings</MenuItem>
      <MenuSeparator />
      {place.index > 0 && <MenuItem icon={<Icon name="chevronLeft" />} testID="widget-move-left" onClick={run(() => move(place.row, place.index - 1))}>Move left</MenuItem>}
      {/* dashboardMove zählt in derselben Zeile den Index vor dem Herausnehmen: eins nach rechts = +2 */}
      {place.index < place.inRow - 1 && <MenuItem icon={<Icon name="chevronRight" />} testID="widget-move-right" onClick={run(() => move(place.row, place.index + 2))}>Move right</MenuItem>}
      {place.row > 0 && <MenuItem icon={<Icon name="arrowUp" />} testID="widget-move-up" onClick={run(() => move(place.row - 1))}>Move to the row above</MenuItem>}
      {(place.row < place.rows - 1 || place.inRow > 1) && <MenuItem icon={<Icon name="arrowDown" />} testID="widget-move-down" onClick={run(() => (place.row < place.rows - 1 ? move(place.row + 1) : move(place.row + 1, undefined, true)))}>Move to the row below</MenuItem>}
      <MenuSeparator />
      <MenuLabel>Width</MenuLabel>
      {WIDGET_WIDTHS.map((w) => (
        <MenuItem key={w.cols} testID={`widget-width-${w.cols}`} selected={place.width === w.cols} onClick={run(() => setDashboardWidgetWidth(store, place.dashboardID, view.id, w.cols))}>{w.label}</MenuItem>
      ))}
      <MenuLabel>Row height</MenuLabel>
      {ROW_HEIGHTS.map((h) => (
        <MenuItem key={h.label} testID={`row-height-${h.label.toLowerCase()}`} selected={place.height === h.px} onClick={run(() => setDashboardRowHeight(store, place.dashboardID, place.rowID, h.px))}>{h.label}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<Icon name="trash" />} danger testID="widget-remove" onClick={run(() => removeDashboardWidget(store, place.dashboardID, view.id))}>Remove widget</MenuItem>
    </Popover>
  );
}

function WidgetFrame({ view, height, place }: { view: DatabaseView; height: number; place: Place }) {
  const { locked } = useDB();
  const [settings, setSettings] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const head = useRef<HTMLElement>(null);
  return (
    <section className="dbui-widget" aria-label={view.name} data-testid="dashboard-widget">
      <header className="dbui-widget-head" ref={head}>
        <Icon name={VIEW_ICONS[view.type] ?? "table"} size={14} />
        <span className="dbui-widget-title">{view.name}</span>
        {!locked && <button type="button" className="dbui-icon-btn" aria-label={`Settings of ${view.name}`} onClick={(e) => setSettings(e.currentTarget)}><Icon name="settings" size={14} /></button>}
        {!locked && <button type="button" className="dbui-icon-btn" aria-label={`Actions for ${view.name}`} data-testid="widget-actions" onClick={(e) => setMenu(e.currentTarget)}><Icon name="more" size={14} /></button>}
      </header>
      <div className="dbui-widget-body" style={{ height }}>
        <ViewBody view={view} search="" compact />
      </div>
      {settings && <ViewSettings view={view} anchor={settings} onClose={() => setSettings(null)} groups={[]} />}
      {menu && <WidgetMenu view={view} place={place} anchor={menu} onClose={() => setMenu(null)} onSettings={() => head.current && setSettings(head.current)} />}
    </section>
  );
}

function Widget({ viewID, height, place }: { viewID: string; height: number; place: Place }) {
  const ctx = useDB();
  const view = ctx.store.views.get(viewID);
  if (!view) return <section className="dbui-widget missing"><EmptyState>This widget's view was deleted.</EmptyState></section>;
  if (view.databaseID === ctx.db.id) return <WidgetFrame view={view} height={height} place={place} />;
  return <ForeignWidget view={view} height={height} place={place} />;
}

/** Widget aus einer anderen Datenbank: eigener Kontext (eigene Beobachtung und Engine). */
function ForeignWidget({ view, height, place }: { view: DatabaseView; height: number; place: Place }) {
  const outer = useDB();
  const ctx = useDatabaseContext(outer.store, view.databaseID, { readOnly: outer.locked, onOpenPage: outer.onOpenPage, isAgentEdit: outer.isAgentEdit, weekStart: outer.weekStart });
  if (!ctx) return <section className="dbui-widget missing"><EmptyState>The database of this widget is gone.</EmptyState></section>;
  return <DBContext.Provider value={ctx}><WidgetFrame view={view} height={height} place={place} /></DBContext.Provider>;
}

export function DashboardLayout({ view }: { view: DatabaseView }) {
  const { store, db, locked } = useDB();
  const [add, setAdd] = useState<Anchor | null>(null);
  const [source, setSource] = useState<string | undefined>(undefined);
  // BSD-216: Quelle wählbar – diese oder eine andere Datenbank des Workspaces (die Shell liefert die Liste und holt
  // die gewählte in den Store dieser Seite)
  const { databases } = useContext(ShellSlots);
  const [listed, setListed] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!add || !databases) return;
    let live = true;
    databases.list().then((l) => { if (live) setListed(l); }, () => undefined);
    return () => { live = false; };
  }, [add, databases]);
  const sources = [{ id: db.id, title: plainText(db.title) || "Untitled" }, ...listed.filter((d) => d.id !== db.id)];
  const addWidget = async (t: string) => {
    const src = source && source !== db.id ? source : undefined;
    if (src && !store.databases.has(src) && databases) await databases.include(src);
    addDashboardWidget(store, view.id, t, src ? { databaseID: src } : {});
  };
  const rows = view.dashboard?.rows ?? [];
  return (
    <div className="dbui-scroll dbui-dashboard" data-testid="dashboard">
      {rows.length === 0 && <EmptyState>Add a widget to start this dashboard.</EmptyState>}
      {rows.map((r, ri) => (
        <div key={r.id} className="dbui-dash-row" data-testid="dashboard-row">
          {r.widgets.map((w, wi) => (
            <div key={w.id} className="dbui-dash-cell" style={{ gridColumn: `span ${Math.max(1, Math.min(12, w.width))}` }} data-width={w.width}>
              <Widget viewID={w.viewID} height={r.height ?? ROW_HEIGHT}
                place={{ dashboardID: view.id, row: ri, index: wi, rows: rows.length, inRow: r.widgets.length, rowID: r.id, width: w.width, height: r.height }} />
            </div>
          ))}
        </div>
      ))}
      {!locked && <button type="button" className="dbui-new-row" onClick={(e) => setAdd(e.currentTarget)}><Icon name="plus" size={14} />Add widget</button>}
      {add && (
        <Popover anchor={add} onClose={() => { setAdd(null); setSource(undefined); }} role="menu" label="Add widget">
          {sources.length > 1 && (
            <>
              <MenuLabel>Source</MenuLabel>
              {sources.map((d) => (
                <MenuItem key={d.id} icon={<Icon name="table" />} selected={(source ?? db.id) === d.id} testID="widget-source" onClick={() => setSource(d.id)}>{d.id === db.id ? `${d.title} (this database)` : d.title}</MenuItem>
              ))}
              <MenuSeparator />
              <MenuLabel>Widget</MenuLabel>
            </>
          )}
          {WIDGET_TYPES.filter((t) => t !== "map").map((t) => (
            <MenuItem key={t} icon={<Icon name={VIEW_ICONS[t] ?? "table"} />} testID={`add-widget-${t}`} onClick={() => { void addWidget(t); setAdd(null); setSource(undefined); }}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
