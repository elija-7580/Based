// BSD-155: Dashboard (Swift DashboardLayout): Zeilen mit bis zu 4 Widgets auf 12 Spalten; jedes Widget ist
// eine eigene Ansicht (Diagramm, Tabelle, Board …), auch aus anderen Datenbanken.
import { useState } from "react";
import { addDashboardWidget, WIDGET_TYPES, type DatabaseView } from "@based/core";
import { DBContext, useDatabaseContext, useDB } from "../context.js";
import { ViewSettings } from "../menus/ViewSettings.js";
import { Icon, MenuItem, Popover, VIEW_ICONS, type Anchor } from "../ui.js";
import { EmptyState } from "./shared.js";
import { ViewBody } from "../ViewBody.js";

const ROW_HEIGHT = 320;

function WidgetFrame({ view, height }: { view: DatabaseView; height: number }) {
  const { locked } = useDB();
  const [settings, setSettings] = useState<Anchor | null>(null);
  return (
    <section className="dbui-widget" aria-label={view.name} data-testid="dashboard-widget">
      <header className="dbui-widget-head">
        <Icon name={VIEW_ICONS[view.type] ?? "table"} size={14} />
        <span className="dbui-widget-title">{view.name}</span>
        {!locked && <button type="button" className="dbui-icon-btn" aria-label={`Settings of ${view.name}`} onClick={(e) => setSettings(e.currentTarget)}><Icon name="settings" size={14} /></button>}
      </header>
      <div className="dbui-widget-body" style={{ height }}>
        <ViewBody view={view} search="" compact />
      </div>
      {settings && <ViewSettings view={view} anchor={settings} onClose={() => setSettings(null)} groups={[]} />}
    </section>
  );
}

function Widget({ viewID, height }: { viewID: string; height: number }) {
  const ctx = useDB();
  const view = ctx.store.views.get(viewID);
  if (!view) return <section className="dbui-widget missing"><EmptyState>This widget's view was deleted.</EmptyState></section>;
  if (view.databaseID === ctx.db.id) return <WidgetFrame view={view} height={height} />;
  return <ForeignWidget view={view} height={height} />;
}

/** Widget aus einer anderen Datenbank: eigener Kontext (eigene Beobachtung und Engine). */
function ForeignWidget({ view, height }: { view: DatabaseView; height: number }) {
  const outer = useDB();
  const ctx = useDatabaseContext(outer.store, view.databaseID, { readOnly: outer.locked, onOpenPage: outer.onOpenPage, isAgentEdit: outer.isAgentEdit });
  if (!ctx) return <section className="dbui-widget missing"><EmptyState>The database of this widget is gone.</EmptyState></section>;
  return <DBContext.Provider value={ctx}><WidgetFrame view={view} height={height} /></DBContext.Provider>;
}

export function DashboardLayout({ view }: { view: DatabaseView }) {
  const { store, locked } = useDB();
  const [add, setAdd] = useState<Anchor | null>(null);
  const rows = view.dashboard?.rows ?? [];
  return (
    <div className="dbui-scroll dbui-dashboard" data-testid="dashboard">
      {rows.length === 0 && <EmptyState>Add a widget to start this dashboard.</EmptyState>}
      {rows.map((r) => (
        <div key={r.id} className="dbui-dash-row">
          {r.widgets.map((w) => (
            <div key={w.id} className="dbui-dash-cell" style={{ gridColumn: `span ${Math.max(1, Math.min(12, w.width))}` }}>
              <Widget viewID={w.viewID} height={r.height ?? ROW_HEIGHT} />
            </div>
          ))}
        </div>
      ))}
      {!locked && <button type="button" className="dbui-new-row" onClick={(e) => setAdd(e.currentTarget)}><Icon name="plus" size={14} />Add widget</button>}
      {add && (
        <Popover anchor={add} onClose={() => setAdd(null)} role="menu" label="Add widget">
          {WIDGET_TYPES.filter((t) => t !== "map").map((t) => (
            <MenuItem key={t} icon={<Icon name={VIEW_ICONS[t] ?? "table"} />} onClick={() => { addDashboardWidget(store, view.id, t); setAdd(null); }}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
