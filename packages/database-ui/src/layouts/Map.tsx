// Karten-Ansicht (Notion „Map“): Zeilen mit Place-Property als Pins, nahe Pins als Cluster, Auswahl zeigt die
// Zeilenkarte, daneben „No location“. Ganz offline: eigene Web-Mercator-Projektion (map/geo.ts), Basiskarte aus
// Natural-Earth-Küstenlinien im Repo (map/land.ts) plus Gradnetz – keine Kacheln, kein Geocoder.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { plainText, propertyOf, type Block, type Database, type DatabaseView, type PropertySchema, type QueryResult } from "@based/core";
import { CellEditor } from "../cells/CellEditor.js";
import { CellView } from "../cells/CellView.js";
import { useDB } from "../context.js";
import { cluster, clampViewport, fitBounds, graticuleStep, mapHeightUnits, pan, project, ringsToPath, toScreen, unproject, worldSize, zoomAt, type Pt, type Size, type Viewport } from "../map/geo.js";
import { LAND_RINGS } from "../map/land.js";
import { mapRows, type LocatedRow } from "../map/rows.js";
import { Icon, type Anchor } from "../ui.js";
import { CardBody, cardProperties, EmptyState } from "./shared.js";

const CLUSTER_RADIUS = 40;
const LIST_PAGE = 100;
let landPath: string | undefined;
const land = () => (landPath ??= ringsToPath(LAND_RINGS));

/** Eigenschaft, nach der die Karte auslegt (`mapPropertyID`, sonst die erste Place-Property). */
export function mapProperty(db: Database, view: DatabaseView): PropertySchema | undefined {
  const p = view.mapPropertyID ? db.properties.find((x) => x.id === view.mapPropertyID) : undefined;
  return p?.type === "place" ? p : db.properties.find((x) => x.type === "place");
}

function useSize(ref: React.RefObject<HTMLElement | null>): Size | undefined {
  const [size, setSize] = useState<Size>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s && s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    read();
    const o = new ResizeObserver(read);
    o.observe(el);
    return () => o.disconnect();
  }, [ref]);
  return size;
}

const Graticule = memo(function Graticule({ vp, size }: { vp: Viewport; size: Size }) {
  const step = graticuleStep(vp.zoom);
  const tl = unproject({ x: vp.cx - size.width / 2 / worldSize(vp.zoom), y: Math.max(0, vp.cy - size.height / 2 / worldSize(vp.zoom)) });
  const br = unproject({ x: vp.cx + size.width / 2 / worldSize(vp.zoom), y: Math.min(1, vp.cy + size.height / 2 / worldSize(vp.zoom)) });
  const lines: string[] = [];
  for (let lon = Math.ceil(tl.lon / step) * step; lon <= br.lon && lines.length < 400; lon += step) {
    const x = toScreen(project({ lon, lat: 0 }), vp, size).x;
    lines.push(`M${x.toFixed(1)} 0V${size.height}`);
  }
  for (let lat = Math.ceil(br.lat / step) * step; lat <= tl.lat && lines.length < 800; lat += step) {
    const y = toScreen(project({ lon: 0, lat }), vp, size).y;
    lines.push(`M0 ${y.toFixed(1)}H${size.width}`);
  }
  return <path className="dbui-map-grid" d={lines.join("")} />;
});

function Basemap({ vp, size }: { vp: Viewport; size: Size }) {
  const w = worldSize(vp.zoom);
  const tx = size.width / 2 - vp.cx * w, ty = size.height / 2 - vp.cy * w;
  // Welt dreimal nebeneinander, damit es beim Verschieben über die Datumsgrenze keine Lücke gibt.
  const first = Math.floor(-tx / w);
  const copies = [first - 1, first, first + 1, first + 2].filter((k) => tx + (k + 1) * w > 0 && tx + k * w < size.width);
  return (
    <svg className="dbui-map-svg" width={size.width} height={size.height} aria-hidden>
      <rect className="dbui-map-water" width={size.width} height={size.height} />
      <g transform={`translate(${tx} ${ty}) scale(${w})`}>
        {copies.map((k) => <path key={k} className="dbui-map-land" d={land()} transform={`translate(${k} 0)`} vectorEffect="non-scaling-stroke" />)}
      </g>
      <Graticule vp={vp} size={size} />
    </svg>
  );
}

function SelectedCard({ rows, view, onClose, onFocus }: { rows: LocatedRow[]; view: DatabaseView; onClose: () => void; onFocus: (r: LocatedRow) => void }) {
  const { db, onOpenPage } = useDB();
  const props = cardProperties(view, db);
  const [i, setI] = useState(0);
  const cur = rows[Math.min(i, rows.length - 1)];
  if (!cur) return null;
  return (
    <div className="dbui-map-card" role="dialog" aria-label="Selected page" data-testid="map-card">
      <div className="dbui-map-card-head">
        {rows.length > 1 && <span className="dbui-data">{i + 1} / {rows.length}</span>}
        {rows.length > 1 && <button type="button" className="dbui-icon-btn" aria-label="Previous page here" disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="chevronLeft" size={14} /></button>}
        {rows.length > 1 && <button type="button" className="dbui-icon-btn" aria-label="Next page here" disabled={i >= rows.length - 1} onClick={() => setI(i + 1)}><Icon name="chevronRight" size={14} /></button>}
        <span className="dbui-spacer" />
        <button type="button" className="dbui-icon-btn" aria-label="Center on map" onClick={() => onFocus(cur)}><Icon name="target" size={14} /></button>
        {onOpenPage && <button type="button" className="dbui-icon-btn" aria-label="Open page" onClick={() => onOpenPage(cur.row.id)}><Icon name="open" size={14} /></button>}
        <button type="button" className="dbui-icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <div className="dbui-card dbui-map-card-body"><CardBody row={cur.row} props={props} /></div>
    </div>
  );
}

function NoLocation({ rows, onEdit }: { rows: { row: Block; label: string }[]; onEdit: ((row: Block, el: HTMLElement) => void) | undefined }) {
  const { db, onOpenPage } = useDB();
  const [limit, setLimit] = useState(LIST_PAGE);
  const title = propertyOf(db, "title") ?? db.properties.find((p) => p.type === "title")!;
  return (
    <section className="dbui-map-side" aria-label="No location" data-testid="map-no-location">
      <div className="dbui-map-side-head"><span className="dbui-menu-label">No location</span><span className="dbui-count">{rows.length.toLocaleString("en-US")}</span></div>
      {rows.length === 0 && <p className="dbui-hint">Every page has coordinates.</p>}
      <ul className="dbui-map-side-list">
        {rows.slice(0, limit).map(({ row, label }) => (
          <li key={row.id} className="dbui-map-side-row">
            <button type="button" className="dbui-list-title" onClick={() => onOpenPage?.(row.id)}><CellView row={row} prop={title} /></button>
            {label && <span className="dbui-hint dbui-clip" title="No coordinates">{label}</span>}
            {onEdit && <button type="button" className="dbui-btn ghost small" onClick={(e) => onEdit(row, e.currentTarget)} aria-label={`Add location to ${plainText(row.text) || "Untitled"}`}>Add location</button>}
          </li>
        ))}
      </ul>
      {rows.length > limit && <button type="button" className="dbui-btn ghost" onClick={() => setLimit(limit + LIST_PAGE)}>Show {Math.min(LIST_PAGE, rows.length - limit)} more</button>}
    </section>
  );
}

export function MapLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { db, locked } = useDB();
  const prop = mapProperty(db, view);
  const { located, unlocated } = useMemo(() => mapRows(result.rows, prop?.id), [result.rows, prop?.id]);
  const projected = useMemo(() => located.map((r) => ({ r, p: project(r.place) })), [located]);
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const [vp, setVp] = useState<Viewport | undefined>();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<{ row: Block; anchor: Anchor } | null>(null);
  const fitted = useRef(false);

  const fitAll = useCallback(() => { if (size) setVp(fitBounds(located.map((l) => l.place), size, { singleZoom: 11 })); }, [located, size]);
  useEffect(() => {
    if (!size) return;
    if (!fitted.current) { fitted.current = true; fitAll(); }
    else setVp((v) => v && clampViewport(v, size));
  }, [size, fitAll]);

  // Pins im Bild, zu Clustern zusammengefasst (nur Sichtbares wird gerechnet und gezeichnet).
  const clusters = useMemo(() => {
    if (!vp || !size) return [];
    const m = CLUSTER_RADIUS;
    const pts = projected.flatMap(({ r, p }) => {
      const s = toScreen(p, vp, size);
      return s.x < -m || s.y < -m || s.x > size.width + m || s.y > size.height + m ? [] : [{ item: r, x: s.x, y: s.y }];
    });
    return cluster(pts, CLUSTER_RADIUS);
  }, [projected, vp, size]);

  const byID = useMemo(() => new Map(located.map((l) => [l.row.id, l])), [located]);
  const selectedRows = (selected ?? []).flatMap((id) => byID.get(id) ?? []);

  // Wheel: nicht passiv, damit die Seite nicht mitscrollt.
  useEffect(() => {
    const el = box.current;
    if (!el || !size) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025);
      setVp((v) => v && zoomAt(v, Math.max(-1, Math.min(1, delta)), { x: e.clientX - r.left, y: e.clientY - r.top }, size));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [size]);

  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const onDown = (e: RPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".dbui-map-controls, .dbui-map-card")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !size) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; box.current?.setPointerCapture(e.pointerId); }
    d.x = e.clientX; d.y = e.clientY;
    setVp((v) => v && pan(v, dx, dy, size));
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) { box.current?.releasePointerCapture(e.pointerId); e.preventDefault(); }
  };
  const zoomBy = (delta: number) => size && setVp((v) => v && zoomAt(v, delta, { x: size.width / 2, y: size.height / 2 }, size));
  const onKey = (e: React.KeyboardEvent) => {
    if (!size || e.target !== e.currentTarget) return;
    const step = 80;
    const moves: Record<string, Pt> = { ArrowLeft: { x: step, y: 0 }, ArrowRight: { x: -step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } };
    if (moves[e.key]) { e.preventDefault(); const m = moves[e.key]!; setVp((v) => v && pan(v, m.x, m.y, size)); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1); }
    else if (e.key === "-") { e.preventDefault(); zoomBy(-1); }
    else if (e.key === "Escape" && selected) { e.preventDefault(); setSelected(null); }
  };

  const openCluster = (items: LocatedRow[]) => {
    if (!size || !vp) return;
    const same = items.every((x) => x.place.lat === items[0]!.place.lat && x.place.lon === items[0]!.place.lon);
    if (items.length === 1 || same || vp.zoom >= 16) { setSelected(items.map((x) => x.row.id)); return; }
    setVp(fitBounds(items.map((x) => x.place), size, { padding: 80, maxZoom: 16 }));
  };

  if (!prop) return <EmptyState>Add a Place property to show pages on a map.</EmptyState>;
  const heightUnits = mapHeightUnits(view.mapHeight);
  return (
    <div className="dbui-map" data-testid="map-view">
      <div className="dbui-map-stage" style={{ height: `calc(var(--space-8) * ${heightUnits})` }}>
        <div className="dbui-map-canvas" ref={box} role="application" aria-roledescription="map" aria-label={`Map of ${prop.name}`} tabIndex={0}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey} data-zoom={vp?.zoom.toFixed(2)}>
          {vp && size && <Basemap vp={vp} size={size} />}
          {vp && size && clusters.map((c) => {
            const one = c.items.length === 1 ? c.items[0]! : undefined;
            const isSel = one ? selected?.includes(one.row.id) : false;
            return one ? (
              <button key={one.row.id} type="button" className={"dbui-map-pin" + (isSel ? " selected" : "")} style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
                aria-label={`Pin: ${plainText(one.row.text) || "Untitled"}`} data-row-id={one.row.id} data-testid="map-pin"
                onClick={() => { if (!drag.current?.moved) openCluster([one]); }}>
                <Icon name="pin" size={22} />
              </button>
            ) : (
              <button key={"c:" + c.items[0]!.row.id} type="button" className="dbui-map-cluster" style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
                aria-label={`${c.items.length} pages here`} data-testid="map-cluster" onClick={() => openCluster(c.items)}>
                <span className="dbui-data">{c.items.length > 999 ? Math.round(c.items.length / 100) / 10 + "k" : c.items.length}</span>
              </button>
            );
          })}
          <div className="dbui-map-controls">
            <button type="button" className="dbui-icon-btn" aria-label="Zoom in" onClick={() => zoomBy(1)}><Icon name="plus" size={14} /></button>
            <button type="button" className="dbui-icon-btn" aria-label="Zoom out" onClick={() => zoomBy(-1)}><Icon name="minus" size={14} /></button>
            <button type="button" className="dbui-icon-btn" aria-label="Show all pins" onClick={fitAll}><Icon name="target" size={14} /></button>
          </div>
          <span className="dbui-map-credit">Coastlines: Natural Earth · {located.length.toLocaleString("en-US")} on map</span>
          {selectedRows.length > 0 && (
            <SelectedCard key={selected!.join(",")} rows={selectedRows} view={view} onClose={() => setSelected(null)}
              onFocus={(r) => { const p = project(r.place); if (size) setVp((v) => clampViewport({ cx: p.x, cy: p.y, zoom: Math.max(v?.zoom ?? 0, 12) }, size)); }} />
          )}
        </div>
        <NoLocation rows={unlocated} onEdit={locked ? undefined : (row, el) => setEditing({ row, anchor: el })} />
      </div>
      {editing && <CellEditor row={editing.row} prop={prop} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}
