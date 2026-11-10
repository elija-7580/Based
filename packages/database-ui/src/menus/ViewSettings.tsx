// BSD-155: Einstellungen einer Ansicht (Swift ViewSettingsView): Name, Layout, Properties, Gruppierung,
// Karten, Diagramm, Dashboard-Widgets, Sperre, Duplizieren/Löschen. Alles über Store-Transaktionen.
import {
  CALENDAR_PROPERTY_TYPES, DASHBOARD_COLUMNS, PROPERTY_TYPE_LABELS, TIMELINE_SCALES, calendarDateProperty, addDashboardWidget, deleteView, duplicateView, movePropertyInView, removeDashboardWidget,
  renameView, setAllPropertiesVisible, setDashboardWidgetWidth, setDatabaseLocked, setGroupBy, setGroupHidden, setPropertyVisible,
  setViewType, updateChart, updateView, visiblePropertyIDs, valueCase, WIDGET_TYPES,
  type DatabaseView,
} from "@based/core";
import { useDB } from "../context.js";
import { openModeOf } from "../logic/peek.js";
import { Icon, MenuLabel, MenuSeparator, Popover, VIEW_ICONS, type Anchor } from "../ui.js";

export const LAYOUTS = ["table", "board", "list", "gallery", "chart", "calendar", "timeline"];
const LAYOUT_LABELS: Record<string, string> = { table: "Table", board: "Board", list: "List", gallery: "Gallery", chart: "Chart", calendar: "Calendar", timeline: "Timeline", dashboard: "Dashboard" };

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <label className="dbui-toggle"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

function PropertiesSection({ view }: { view: DatabaseView }) {
  const { store, db } = useDB();
  const visible = visiblePropertyIDs(view, db);
  const ordered = [...visible.flatMap((id) => db.properties.find((p) => p.id === id) ?? []), ...db.properties.filter((p) => !visible.includes(p.id))];
  return (
    <section className="dbui-config-section" aria-label="Properties">
      <div className="dbui-row-actions">
        <MenuLabel>Properties</MenuLabel>
        <button type="button" className="dbui-btn ghost small" onClick={() => setAllPropertiesVisible(store, view.id, true)}>Show all</button>
        <button type="button" className="dbui-btn ghost small" onClick={() => setAllPropertiesVisible(store, view.id, false)}>Hide all</button>
      </div>
      {ordered.map((p) => {
        const on = visible.includes(p.id);
        const i = visible.indexOf(p.id);
        return (
          <div key={p.id} className="dbui-prop-line">
            <span className="dbui-menu-label">{p.name}</span>
            <span className="dbui-hint">{PROPERTY_TYPE_LABELS[p.type] ?? p.type}</span>
            {on && <button type="button" className="dbui-icon-btn" aria-label={`Move ${p.name} up`} disabled={i <= 0} onClick={() => movePropertyInView(store, view.id, p.id, Math.max(0, i - 1))}><Icon name="arrowUp" size={12} /></button>}
            {on && <button type="button" className="dbui-icon-btn" aria-label={`Move ${p.name} down`} disabled={i >= visible.length - 1} onClick={() => movePropertyInView(store, view.id, p.id, i + 1)}><Icon name="arrowDown" size={12} /></button>}
            <button type="button" className="dbui-icon-btn" aria-label={`${on ? "Hide" : "Show"} ${p.name}`} aria-pressed={on} disabled={p.type === "title"}
              onClick={() => setPropertyVisible(store, view.id, p.id, !on)}><Icon name={on ? "eye" : "eyeOff"} size={14} /></button>
          </div>
        );
      })}
    </section>
  );
}

function GroupSection({ view, groups }: { view: DatabaseView; groups: { id: string; title: string }[] }) {
  const { store, db } = useDB();
  const g = view.groupBy;
  const p = g ? db.properties.find((x) => x.id === g.propertyID) : undefined;
  return (
    <section className="dbui-config-section" aria-label="Group">
      <label className="dbui-field"><span className="dbui-field-label">Group by</span>
        <select className="dbui-select" aria-label="Group by" value={g?.propertyID ?? ""} onChange={(e) => setGroupBy(store, view.id, e.target.value ? { propertyID: e.target.value } : undefined)}>
          <option value="">None</option>
          {db.properties.filter((x) => !["button", "files", "relation", "rollup", "formula"].includes(x.type)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      {g && p && ["date", "createdTime", "lastEditedTime"].includes(p.type) && (
        <label className="dbui-field"><span className="dbui-field-label">Date by</span>
          <select className="dbui-select" aria-label="Date grouping" value={g.dateGrouping ?? "relative"} onChange={(e) => setGroupBy(store, view.id, { ...g, dateGrouping: e.target.value as never })}>
            {["relative", "day", "week", "month", "year"].map((x) => <option key={x} value={x}>{x[0]!.toUpperCase() + x.slice(1)}</option>)}
          </select>
        </label>
      )}
      {g && <Toggle label="Hide empty groups" checked={g.hideEmptyGroups === true} onChange={(on) => setGroupBy(store, view.id, { ...g, hideEmptyGroups: on })} />}
      {g && groups.length > 0 && (
        <div className="dbui-hidden-groups">
          {groups.map((x) => {
            const hidden = g.hiddenGroups?.includes(x.id) ?? false;
            return (
              <div key={x.id} className="dbui-prop-line">
                <span className="dbui-menu-label">{x.title}</span>
                <button type="button" className="dbui-icon-btn" aria-label={`${hidden ? "Show" : "Hide"} group ${x.title}`} aria-pressed={!hidden} onClick={() => setGroupHidden(store, view.id, x.id, !hidden)}>
                  <Icon name={hidden ? "eyeOff" : "eye"} size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CardSection({ view }: { view: DatabaseView }) {
  const { store, db } = useDB();
  const cover = valueCase(view.cardCover as never);
  const coverValue = !cover ? (view.type === "gallery" ? "pageContent" : "none") : cover[0] === "property" ? "p:" + String(cover[1]) : cover[0];
  return (
    <section className="dbui-config-section" aria-label="Cards">
      <label className="dbui-field"><span className="dbui-field-label">Card preview</span>
        <select className="dbui-select" aria-label="Card preview" value={coverValue} onChange={(e) => updateView(store, view.id, (v) => {
          const x = e.target.value;
          v.cardCover = (x.startsWith("p:") ? { property: { _0: x.slice(2) } } : { [x]: {} }) as never;
        }, "Card preview")}>
          <option value="none">None</option><option value="pageCover">Page cover</option><option value="pageContent">Page content</option><option value="pageIcon">Page icon</option>
          {db.properties.filter((p) => p.type === "files").map((p) => <option key={p.id} value={"p:" + p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="dbui-field"><span className="dbui-field-label">Card size</span>
        <select className="dbui-select" aria-label="Card size" value={view.cardSize ?? "medium"} onChange={(e) => updateView(store, view.id, (v) => { v.cardSize = e.target.value as never; }, "Card size")}>
          <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
        </select>
      </label>
    </section>
  );
}

function ChartSection({ view }: { view: DatabaseView }) {
  const { store, db } = useDB();
  const c = view.chart;
  const set = (f: (x: NonNullable<DatabaseView["chart"]>) => void) => updateChart(store, view.id, f);
  const numeric = db.properties.filter((p) => ["number", "formula", "rollup", "uniqueID"].includes(p.type));
  return (
    <section className="dbui-config-section" aria-label="Chart">
      <label className="dbui-field"><span className="dbui-field-label">Chart</span>
        <select className="dbui-select" aria-label="Chart type" value={c?.kind ?? "bar"} onChange={(e) => set((x) => { x.kind = e.target.value; })}>
          {[["bar", "Vertical bar"], ["horizontalBar", "Horizontal bar"], ["line", "Line"], ["area", "Area"], ["donut", "Donut"], ["pie", "Pie"], ["number", "Number"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {c?.kind !== "number" && (
        <label className="dbui-field"><span className="dbui-field-label">X axis</span>
          <select className="dbui-select" aria-label="X axis" value={c?.xPropertyID ?? ""} onChange={(e) => set((x) => { if (e.target.value) x.xPropertyID = e.target.value; else delete x.xPropertyID; })}>
            <option value="">None</option>
            {db.properties.filter((p) => p.type !== "button").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <label className="dbui-field"><span className="dbui-field-label">Y axis</span>
        <select className="dbui-select" aria-label="Y axis" value={c?.yPropertyID ?? ""} onChange={(e) => set((x) => { if (e.target.value) x.yPropertyID = e.target.value; else delete x.yPropertyID; })}>
          <option value="">Count</option>
          {numeric.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {c?.yPropertyID && (
        <label className="dbui-field"><span className="dbui-field-label">Aggregate</span>
          <select className="dbui-select" aria-label="Aggregate" value={c.aggregate} onChange={(e) => set((x) => { x.aggregate = e.target.value; })}>
            {["sum", "average", "median", "min", "max", "count"].map((a) => <option key={a} value={a}>{a[0]!.toUpperCase() + a.slice(1)}</option>)}
          </select>
        </label>
      )}
      <label className="dbui-field"><span className="dbui-field-label">Dates by</span>
        <select className="dbui-select" aria-label="Date bucket" value={c?.dateBucket ?? "month"} onChange={(e) => set((x) => { x.dateBucket = e.target.value; })}>
          {["day", "week", "month", "quarter", "year"].map((a) => <option key={a} value={a}>{a[0]!.toUpperCase() + a.slice(1)}</option>)}
        </select>
      </label>
      <Toggle label="Show values" checked={c?.showValues ?? true} onChange={(on) => set((x) => { x.showValues = on; })} />
      <Toggle label="Show legend" checked={c?.showLegend ?? true} onChange={(on) => set((x) => { x.showLegend = on; })} />
      <Toggle label="Sort by value" checked={c?.sortByValue ?? false} onChange={(on) => set((x) => { x.sortByValue = on; })} />
      <label className="dbui-field"><span className="dbui-field-label">Show top</span>
        <input className="dbui-input small" type="number" min={0} aria-label="Limit" defaultValue={c?.limit ?? ""} onBlur={(e) => set((x) => { const n = Number(e.target.value); if (n > 0) x.limit = Math.floor(n); else delete x.limit; })} />
      </label>
      <label className="dbui-field"><span className="dbui-field-label">Caption</span>
        <input className="dbui-input" aria-label="Caption" defaultValue={c?.caption ?? ""} onBlur={(e) => set((x) => { const t = e.target.value.trim(); if (t) x.caption = t; else delete x.caption; })} />
      </label>
    </section>
  );
}

/** BSD-8: Kalender/Timeline – Datums-Property, Ende, Bereich (Monat/Woche) bzw. Zoom und Tabelle. */
function DatesSection({ view }: { view: DatabaseView }) {
  const { store, db } = useDB();
  const current = calendarDateProperty(db, view);
  const dateProps = db.properties.filter((p) => CALENDAR_PROPERTY_TYPES.includes(p.type));
  const endProps = db.properties.filter((p) => p.type === "date" && p.id !== current?.id);
  const set = (f: (v: DatabaseView) => void, name: string) => updateView(store, view.id, f, name);
  const what = view.type === "calendar" ? "calendar" : "timeline";
  return (
    <section className="dbui-config-section" aria-label="Dates">
      <label className="dbui-field"><span className="dbui-field-label">Show {what} by</span>
        <select className="dbui-select" aria-label="Date property" value={current?.id ?? ""} onChange={(e) => set((v) => {
          v.datePropertyID = e.target.value;
          if (v.endDatePropertyID === e.target.value) delete v.endDatePropertyID;
        }, "Date property")}>
          {!current && <option value="">None</option>}
          {dateProps.map((p) => <option key={p.id} value={p.id}>{p.name} ({PROPERTY_TYPE_LABELS[p.type] ?? p.type})</option>)}
        </select>
      </label>
      <label className="dbui-field"><span className="dbui-field-label">End date</span>
        <select className="dbui-select" aria-label="End date property" value={view.endDatePropertyID ?? ""} onChange={(e) => set((v) => {
          if (e.target.value) v.endDatePropertyID = e.target.value; else delete v.endDatePropertyID;
        }, "End date property")}>
          <option value="">Date range of {current?.name ?? "the date"}</option>
          {endProps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {current && current.type !== "date" && <p className="dbui-hint">{current.name} is computed – entries can’t be moved.</p>}
      {view.type === "calendar" && (
        <label className="dbui-field"><span className="dbui-field-label">Show</span>
          <select className="dbui-select" aria-label="Calendar range" value={view.calendarMode === "week" ? "week" : "month"} onChange={(e) => set((v) => { v.calendarMode = e.target.value; }, "Calendar range")}>
            <option value="month">Month</option><option value="week">Week</option>
          </select>
        </label>
      )}
      {view.type === "timeline" && (
        <>
          <label className="dbui-field"><span className="dbui-field-label">Zoom</span>
            <select className="dbui-select" aria-label="Timeline zoom" value={typeof view.timelineScale === "string" ? view.timelineScale : "week"} onChange={(e) => set((v) => { v.timelineScale = e.target.value; }, "Timeline zoom")}>
              {TIMELINE_SCALES.map((t) => <option key={t} value={t}>{t[0]!.toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <Toggle label="Show table" checked={view.timelineShowTable === true} onChange={(on) => set((v) => { if (on) v.timelineShowTable = true; else delete v.timelineShowTable; }, "Timeline table")} />
        </>
      )}
    </section>
  );
}

function DashboardSection({ view }: { view: DatabaseView }) {
  const { store } = useDB();
  const rows = view.dashboard?.rows ?? [];
  return (
    <section className="dbui-config-section" aria-label="Widgets">
      <MenuLabel>Widgets</MenuLabel>
      {rows.flatMap((r) => r.widgets).map((w) => {
        const v = store.views.get(w.viewID);
        return (
          <div key={w.id} className="dbui-prop-line">
            <span className="dbui-menu-label">{v?.name ?? "Missing view"}</span>
            <select className="dbui-select small" aria-label={`Width of ${v?.name}`} value={w.width} onChange={(e) => setDashboardWidgetWidth(store, view.id, w.viewID, Number(e.target.value))}>
              {Array.from({ length: DASHBOARD_COLUMNS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}/12</option>)}
            </select>
            <button type="button" className="dbui-icon-btn" aria-label={`Remove ${v?.name}`} onClick={() => removeDashboardWidget(store, view.id, w.viewID)}><Icon name="trash" size={14} /></button>
          </div>
        );
      })}
      <select className="dbui-select" aria-label="Add widget" value="" onChange={(e) => e.target.value && addDashboardWidget(store, view.id, e.target.value)}>
        <option value="">+ Add widget</option>
        {WIDGET_TYPES.filter((t) => t !== "map").map((t) => <option key={t} value={t}>{LAYOUT_LABELS[t] ?? t}</option>)}
      </select>
    </section>
  );
}

export function ViewSettings({ view, anchor, onClose, groups, onDeleted }: {
  view: DatabaseView; anchor: Anchor; onClose: () => void; groups: { id: string; title: string }[]; onDeleted?: () => void;
}) {
  const { store, db } = useDB();
  const isWidget = view.widgetOf !== undefined;
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-view-settings" label="View settings">
      <label className="dbui-field"><span className="dbui-field-label">Name</span>
        <input className="dbui-input" aria-label="View name" defaultValue={view.name} onBlur={(e) => renameView(store, view.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") renameView(store, view.id, e.currentTarget.value); }} />
      </label>
      {view.type !== "dashboard" && (
        <div className="dbui-layouts" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={view.type === t} className="dbui-layout" onClick={() => setViewType(store, view.id, t)}>
              <Icon name={VIEW_ICONS[t] ?? "table"} />{LAYOUT_LABELS[t]}
            </button>
          ))}
        </div>
      )}
      <MenuSeparator />
      {view.type === "dashboard" ? <DashboardSection view={view} /> : view.type === "chart" ? <ChartSection view={view} /> : (
        <>
          {(view.type === "calendar" || view.type === "timeline") && <DatesSection view={view} />}
          {view.type !== "calendar" && <PropertiesSection view={view} />}
          {["table", "board", "list", "gallery", "timeline"].includes(view.type) && <GroupSection view={view} groups={groups} />}
          {(view.type === "board" || view.type === "gallery") && <CardSection view={view} />}
          <section className="dbui-config-section" aria-label="Display">
            {view.type === "table" && <Toggle label="Wrap all content" checked={view.wrapCells === true} onChange={(on) => updateView(store, view.id, (v) => { if (on) v.wrapCells = true; else delete v.wrapCells; }, "Wrap cells")} />}
            <Toggle label="Show page icon" checked={view.showIcons !== false} onChange={(on) => updateView(store, view.id, (v) => { if (on) delete v.showIcons; else v.showIcons = false; }, "Icons")} />
            <label className="dbui-field"><span className="dbui-field-label">Open pages in</span>
              <select className="dbui-select" aria-label="Open pages in" value={openModeOf(view)} onChange={(e) => updateView(store, view.id, (v) => { v.openIn = e.target.value; }, "Open pages in")}>
                <option value="sidePeek">Side peek</option><option value="centerPeek">Center peek</option><option value="fullPage">Full page</option>
              </select>
            </label>
          </section>
        </>
      )}
      <MenuSeparator />
      {!isWidget && <Toggle label="Lock database" checked={db.locked === true} onChange={(on) => setDatabaseLocked(store, db.id, on)} />}
      <div className="dbui-row-actions">
        {!isWidget && <button type="button" className="dbui-btn ghost" onClick={() => { duplicateView(store, view.id); onClose(); }}><Icon name="copy" size={14} />Duplicate view</button>}
        <button type="button" className="dbui-btn ghost danger" onClick={() => { deleteView(store, view.id); onClose(); onDeleted?.(); }}><Icon name="trash" size={14} />{isWidget ? "Remove widget" : "Delete view"}</button>
      </div>
    </Popover>
  );
}
