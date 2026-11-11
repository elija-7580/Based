// BSD-8: Timeline – Zeitachse in Tagen, Wochen, Monaten oder Quartalen; Balken von Beginn bis Ende, verschieben
// und an beiden Enden ziehen (je eine Transaktion), Zeilen ohne Datum in einer Seitenleiste (auf die Achse ziehen
// gibt ihnen ein Datum), optional Tabellenspalten links, Gruppierung. Virtualisiert in beiden Richtungen: Zeilen
// über den Virtualisierer, Balken, Ticks und Gitterlinien nur im sichtbaren Zeitfenster.
import { cardKeys } from "../cardKeys.js";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TIMELINE_SCALES, calendarDateProperty, formatDay, moveRowSpan, propertyOf, resizeRowSpan, setRowSpan, spanLabel, timelineRange,
  timelineTicks, updateView, visiblePropertyIDs,
  type Block, type DatabaseView, type PropertySchema, type QueryResult, type RowGroup, type RowSpan, type TimelineScale,
} from "@based/core";
import { CellView } from "../cells/CellView.js";
import { useDB } from "../context.js";
import { columnWidth } from "../logic/layout.js";
import { Icon, OptionPill } from "../ui.js";
import { useDateDrag, type DateDrag, type DragKind } from "./dateDrag.js";
import { EmptyState, groupProperty, RowMenu, useRowMenu } from "./shared.js";
import { previewSpan, rowTitle, useToday, useViewSpans } from "./spans.js";

/** Pixel je Tag pro Skala. */
export const SCALE_PX: Record<TimelineScale, number> = { day: 40, week: 20, month: 5, quarter: 2 };
const SCALE_LABELS: Record<TimelineScale, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };
/** Neue Dauer (Tage), wenn eine Zeile ohne Datum auf die Achse gezogen wird. */
const PLACE_DAYS: Record<TimelineScale, number> = { day: 1, week: 3, month: 7, quarter: 14 };
const ROW_H = 36;
const GROUP_H = 40;
const HEAD_H = 52;
const BAR_H = 24;
const SIDE_ITEM_H = 34;
const MIN_TITLE_W = 72;
/** Rand links/rechts des sichtbaren Fensters, in dem trotzdem gerendert wird (px). */
const X_OVERSCAN = 400;
const X_STEP = 160;

const isScale = (s: unknown): s is TimelineScale => typeof s === "string" && (TIMELINE_SCALES as readonly string[]).includes(s);

type Item = { kind: "group"; key: string; group: RowGroup; count: number; collapsed: boolean } | { kind: "row"; key: string; span: RowSpan };

interface BarActions {
  writable: boolean;
  begin: (e: ReactPointerEvent<HTMLElement>, rowID: string, kind: DragKind, originDay?: number) => void;
  open: (rowID: string) => void;
  nudge: (rowID: string, kind: "move" | "start" | "end", delta: number) => void;
  isAgentEdit: (row: Block) => boolean;
  onMenu: (row: Block, el: HTMLElement) => void;
}

const Bar = memo(function Bar({ span, left, width, dragging, a }: { span: RowSpan; left: number; width: number; dragging: boolean; a: BarActions }) {
  const title = rowTitle(span.row);
  const label = spanLabel(span);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); a.open(span.row.id); return; }
    if (!a.writable || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    if (!e.altKey) return;
    e.preventDefault();
    a.nudge(span.row.id, e.shiftKey ? "end" : "move", e.key === "ArrowLeft" ? -1 : 1);
  };
  return (
    <div className={"dbui-tl-bar" + (dragging ? " dragging" : "") + (a.writable ? " movable" : "") + (width < MIN_TITLE_W ? " narrow" : "")}
      data-row-id={span.row.id} role="button" tabIndex={0} aria-label={`${title}, ${label}`} title={`${title} · ${label}`}
      style={{ left, width, top: (ROW_H - BAR_H) / 2, height: BAR_H }}
      onPointerDown={a.writable ? (e) => a.begin(e, span.row.id, "move") : undefined}
      onClick={() => a.open(span.row.id)} onKeyDown={onKey}
      onContextMenu={(e) => { e.preventDefault(); a.onMenu(span.row, e.currentTarget); }}>
      {a.isAgentEdit(span.row) && <span className="dbui-agent-bar" role="img" aria-label="Changed by Based" />}
      {a.writable && <span className="dbui-tl-handle start" data-testid="bar-start" aria-hidden onPointerDown={(e) => a.begin(e, span.row.id, "start")} />}
      <span className="dbui-tl-bar-title">{title}</span>
      {a.writable && <span className="dbui-tl-handle end" data-testid="bar-end" aria-hidden onPointerDown={(e) => a.begin(e, span.row.id, "end")} />}
    </div>
  );
});

const TableCells = memo(function TableCells({ row, cols, widths, onOpen }: { row: Block; cols: PropertySchema[]; widths: number[]; onOpen: (id: string) => void }) {
  return (
    <div className="dbui-tl-cells" role="presentation">
      {cols.map((p, i) => (
        <div key={p.id} className={"dbui-tl-cell" + (p.type === "title" ? " title" : "")} style={{ width: widths[i] }} role="gridcell">
          {p.type === "title"
            ? <button type="button" className="dbui-tl-open" onClick={() => onOpen(row.id)}><CellView row={row} prop={p} /></button>
            : <CellView row={row} prop={p} compact />}
        </div>
      ))}
    </div>
  );
});

const Row = memo(function Row({ span, top, rowW, left, barW, visible, side, dragging, a, cols, widths, tableW, onJump }: {
  span: RowSpan; top: number; rowW: number; left: number; barW: number; visible: boolean; side: "before" | "after" | null; dragging: boolean;
  a: BarActions; cols: PropertySchema[]; widths: number[]; tableW: number; onJump: (day: number) => void;
}) {
  return (
    <div className="dbui-tl-row" style={{ transform: `translateY(${top}px)`, height: ROW_H, width: rowW }} role="row" data-tl-row={span.row.id}>
      {visible && <Bar span={span} left={left} width={barW} dragging={dragging} a={a} />}
      {cols.length > 0 && <TableCells row={span.row} cols={cols} widths={widths} onOpen={a.open} />}
      {side && (
        <button type="button" className={"dbui-tl-jump " + side} style={side === "before" ? { left: tableW + 4 } : undefined} tabIndex={-1}
          aria-label={`Scroll to ${rowTitle(span.row)}`} onClick={() => onJump(span.start)}>
          {side === "before" && <Icon name="chevronLeft" size={12} />}<span>{rowTitle(span.row)}</span>{side === "after" && <Icon name="chevronRight" size={12} />}
        </button>
      )}
    </div>
  );
});

function Sidebar({ rows, begin, open, writable }: { rows: Block[]; begin: BarActions["begin"]; open: (id: string) => void; writable: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => SIDE_ITEM_H, overscan: 8 });
  return (
    <aside className="dbui-tl-side" aria-label="No date">
      <div className="dbui-tl-side-head"><span className="dbui-field-label">No date</span><span className="dbui-count">{rows.length.toLocaleString("en-US")}</span></div>
      {writable && rows.length > 0 && <p className="dbui-hint">Drag onto the timeline to schedule.</p>}
      <div className="dbui-tl-side-scroll" ref={ref} role="list" aria-label="Pages without a date">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            return (
              <div key={row.id} role="listitem" className={"dbui-tl-side-item" + (writable ? " movable" : "")} data-undated-id={row.id} tabIndex={0}
                style={{ transform: `translateY(${vi.start}px)`, height: SIDE_ITEM_H }}
                onPointerDown={writable ? (e) => begin(e, row.id, "place", 0) : undefined} onClick={() => open(row.id)}
                onKeyDown={(e) => { if (e.key === "Enter") open(row.id); }}>
                {rowTitle(row)}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function Timeline({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { store, db, locked, weekStart, onOpenPage, isAgentEdit } = useDB();
  const v = useViewSpans(view, result);
  const todayDay = useToday();
  const [scale, setScaleState] = useState<TimelineScale>(isScale(view.timelineScale) ? view.timelineScale : "week");
  useEffect(() => { if (isScale(view.timelineScale)) setScaleState(view.timelineScale); }, [view.timelineScale]);
  const showTable = view.timelineShowTable === true;
  const [sideOpen, setSideOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useRowMenu();
  const scrollRef = useRef<HTMLDivElement>(null);
  const px = SCALE_PX[scale];
  const range = useMemo(() => timelineRange(v.index, todayDay, scale, weekStart), [v.index, todayDay, scale, weekStart]);
  const width = (range.to - range.from + 1) * px;

  const cols = useMemo(() => (showTable ? visiblePropertyIDs(view, db).flatMap((id) => propertyOf(db, id) ?? []) : []), [showTable, view, db]);
  const widths = useMemo(() => cols.map((p) => columnWidth(view, db, p.id)), [cols, view, db]);
  const tableW = widths.reduce((a, b) => a + b, 0);

  const gp = groupProperty(db, view);
  const items = useMemo<Item[]>(() => {
    if (!result.groups) return v.dated.map((s) => ({ kind: "row", key: s.row.id, span: s }));
    const out: Item[] = [];
    for (const g of result.groups) {
      const spans = g.rows.flatMap((r) => v.byID.get(r.id) ?? []);
      const c = collapsed.has(g.id);
      out.push({ kind: "group", key: "g:" + g.id, group: g, count: spans.length, collapsed: c });
      if (!c) for (const s of spans) out.push({ kind: "row", key: g.id + ":" + s.row.id, span: s });
    }
    return out;
  }, [result.groups, v, collapsed]);

  const virtualizer = useVirtualizer({
    count: items.length, getScrollElement: () => scrollRef.current, paddingStart: HEAD_H, overscan: 6,
    estimateSize: (i) => (items[i]?.kind === "group" ? GROUP_H : ROW_H), getItemKey: (i) => items[i]?.key ?? i,
  });

  // Sichtbares Zeitfenster (in Schritten, damit nicht jedes Scroll-Ereignis neu rendert)
  const [win, setWin] = useState({ left: 0, w: 1200 });
  const center = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth - tableW;
    center.current = range.from + (el.scrollLeft + w / 2) / px;
    const left = Math.floor(el.scrollLeft / X_STEP) * X_STEP;
    setWin((o) => (o.left === left && o.w === el.clientWidth ? o : { left, w: el.clientWidth }));
  }, [tableW, range.from, px]);
  // Beim Start heute ins Bild; beim Wechsel der Skala bleibt der Tag in der Mitte stehen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth - tableW;
    const c = center.current ?? todayDay + w / 6 / px;
    el.scrollLeft = (c - range.from) * px - w / 2;
    onScroll();
  }, [scale, range.from, tableW]);

  const visFrom = range.from + Math.floor((win.left - X_OVERSCAN) / px);
  const visTo = range.from + Math.ceil((win.left + win.w - tableW + X_OVERSCAN) / px);
  const ticks = useMemo(() => timelineTicks(scale, Math.max(range.from, visFrom), Math.min(range.to, visTo), weekStart), [scale, range, visFrom, visTo, weekStart]);
  // Genau sichtbares Fenster (ohne Rand): außerhalb zeigt die Zeile einen Pfeil zum Balken.
  const winFrom = range.from + Math.floor(win.left / px) + 1;
  const winTo = range.from + Math.floor((win.left + win.w - tableW) / px) - 1;
  const scrollToDay = useCallback((day: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = (day - range.from) * px - Math.min(80, (el.clientWidth - tableW) / 4);
  }, [range.from, px, tableW]);
  const x = (day: number) => tableW + (day - range.from) * px;

  const dayAt = useCallback((cx: number, cy: number) => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    if (cx < r.left + tableW || cx > r.right || cy < r.top || cy > r.bottom) return undefined;
    return range.from + Math.floor((cx - r.left - tableW + el.scrollLeft) / px);
  }, [range.from, px, tableW]);
  const props = v.props;
  const { drag, begin } = useDateDrag({
    dayAt, scrollEl: () => scrollRef.current,
    onDrop: (d) => {
      if (!props) return;
      if (d.kind === "move") { if (d.delta !== 0) moveRowSpan(store, d.rowID, props, d.delta); }
      else if (d.kind === "start" || d.kind === "end") { if (d.day !== undefined) resizeRowSpan(store, d.rowID, props, d.kind, d.day); }
      else if (d.kind === "place" && d.day !== undefined) setRowSpan(store, d.rowID, props, d.day, d.day + PLACE_DAYS[scale] - 1);
    },
  });
  const open = useCallback((id: string) => onOpenPage?.(id), [onOpenPage]);
  const nudge = useCallback((id: string, kind: "move" | "start" | "end", delta: number) => {
    if (!props) return;
    if (kind === "move") moveRowSpan(store, id, props, delta);
    else { const s = v.byID.get(id); if (s) resizeRowSpan(store, id, props, kind, (kind === "end" ? s.end : s.start) + delta); }
  }, [store, props, v.byID]);
  const onMenu = useCallback((row: Block, el: HTMLElement) => setMenu({ rowID: row.id, anchor: el }), [setMenu]);
  const a: BarActions = useMemo(() => ({ writable: v.writable, begin, open, nudge, isAgentEdit, onMenu }), [v.writable, begin, open, nudge, isAgentEdit, onMenu]);

  const setScale = (s: TimelineScale) => {
    setScaleState(s);
    if (!locked && view.timelineScale !== s) updateView(store, view.id, (x) => { x.timelineScale = s; }, "Timeline zoom");
  };
  const scrollByView = (dir: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft += dir * Math.max(px, (el.clientWidth - tableW) * 0.75);
  };
  const goToday = () => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = (todayDay - range.from) * px - (el.clientWidth - tableW) / 3;
  };

  const total = virtualizer.getTotalSize();
  const menuRow = menu ? store.blocks.get(menu.rowID) : undefined;
  const dropDay = drag?.kind === "place" ? drag.day : undefined;
  return (
    <div className={"dbui-timeline" + (drag ? " dragging" : "")} data-testid="timeline" data-scale={scale}>
      <div className="dbui-cal-bar">
        <div className="dbui-seg" role="radiogroup" aria-label="Zoom">
          {TIMELINE_SCALES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scale === s} className="dbui-seg-item" onClick={() => setScale(s)}>{SCALE_LABELS[s]}</button>
          ))}
        </div>
        <button type="button" className="dbui-icon-btn" aria-label="Earlier" onClick={() => scrollByView(-1)}><Icon name="chevronLeft" size={14} /></button>
        <button type="button" className="dbui-chip" onClick={goToday}>Today</button>
        <button type="button" className="dbui-icon-btn" aria-label="Later" onClick={() => scrollByView(1)}><Icon name="chevronRight" size={14} /></button>
        <span className="dbui-cal-spacer" />
        {!locked && <button type="button" className="dbui-chip ghost" aria-pressed={showTable} onClick={() => updateView(store, view.id, (x) => { if (showTable) delete x.timelineShowTable; else x.timelineShowTable = true; }, "Timeline table")}>
          <Icon name="table" size={14} />Table</button>}
        <button type="button" className="dbui-chip ghost" aria-pressed={sideOpen} onClick={() => setSideOpen(!sideOpen)}>No date ({v.undated.length.toLocaleString("en-US")})</button>
      </div>
      <div className="dbui-tl-main">
        <div className="dbui-tl-scroll" ref={scrollRef} onScroll={onScroll} data-testid="timeline-scroll" role="grid" aria-label={`Timeline by ${SCALE_LABELS[scale].toLowerCase()}`}
          aria-rowcount={items.length} onKeyDown={cardKeys}>
          <div className="dbui-tl-inner" style={{ width: tableW + width, height: Math.max(total, HEAD_H) }}>
            {/* Gitter, heute, Ablage-Linie: nur im sichtbaren Fenster */}
            {ticks.minor.map((t) => <div key={"l" + t.day} className="dbui-tl-line" style={{ left: x(t.day), top: HEAD_H, height: Math.max(0, total - HEAD_H) }} aria-hidden />)}
            {todayDay >= range.from && todayDay <= range.to && <div className="dbui-tl-today" style={{ left: x(todayDay) + px / 2, top: HEAD_H - 6, height: Math.max(0, total - HEAD_H + 6) }} aria-hidden />}
            {dropDay !== undefined && <div className="dbui-tl-drop" style={{ left: x(dropDay), width: PLACE_DAYS[scale] * px, top: HEAD_H, height: Math.max(0, total - HEAD_H) }} aria-hidden />}
            <div className="dbui-tl-head" style={{ height: HEAD_H, width: tableW + width }} role="row">
              <div className="dbui-tl-axis" style={{ left: tableW, width }} aria-hidden>
                {ticks.major.map((t, i) => {
                  const l = Math.max(0, (t.day - range.from) * px);
                  const r = ((ticks.major[i + 1]?.day ?? range.to + 1) - range.from) * px;
                  return (
                    <div key={"M" + t.day} className="dbui-tl-major" style={{ left: l, width: Math.max(0, r - l) }}>
                      <span style={{ left: tableW }}>{t.label}</span>
                    </div>
                  );
                })}
                {ticks.minor.map((t) => (
                  <div key={"m" + t.day} className={"dbui-tl-minor" + (t.day === todayDay ? " today" : "")} style={{ left: (t.day - range.from) * px }}>
                    {(scale !== "day" || px >= 24) && t.label}
                  </div>
                ))}
              </div>
              {showTable && (
                <div className="dbui-tl-corner" style={{ width: tableW }}>
                  {cols.map((p, i) => <div key={p.id} className="dbui-tl-colhead" style={{ width: widths[i] }} role="columnheader">{p.name}</div>)}
                </div>
              )}
            </div>
            {virtualizer.getVirtualItems().map((vi) => {
              const it = items[vi.index]!;
              if (it.kind === "group") {
                const isOption = gp && ["select", "status", "multiSelect"].includes(gp.type) && it.group.id !== "";
                return (
                  <div key={vi.key} className="dbui-tl-group" style={{ transform: `translateY(${vi.start}px)`, height: GROUP_H, width: tableW + width }} role="row" aria-expanded={!it.collapsed}>
                    <div className="dbui-tl-group-label">
                      <button type="button" className="dbui-icon-btn" aria-label={`${it.collapsed ? "Expand" : "Collapse"} ${it.group.title}`}
                        onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(it.group.id)) n.delete(it.group.id); else n.add(it.group.id); return n; })}>
                        <Icon name={it.collapsed ? "chevronRight" : "chevronDown"} size={14} />
                      </button>
                      {isOption ? <OptionPill name={it.group.title} color={it.group.color} status={gp?.type === "status"} /> : <span className="dbui-group-title">{it.group.title}</span>}
                      <span className="dbui-count">{it.count}</span>
                    </div>
                  </div>
                );
              }
              const s = previewSpan(it.span, drag);
              return (
                <Row key={vi.key} span={s} top={vi.start} rowW={tableW + width} left={x(s.start)} barW={(s.end - s.start + 1) * px}
                  visible={s.end >= visFrom && s.start <= visTo} side={s.end < winFrom ? "before" : s.start > winTo ? "after" : null}
                  dragging={drag?.rowID === s.row.id} a={a} cols={cols} widths={widths} tableW={tableW} onJump={scrollToDay} />
              );
            })}
          </div>
          {items.length === 0 && <div className="dbui-empty dbui-tl-empty">No pages with a date in this view.</div>}
        </div>
        {sideOpen && <Sidebar rows={v.undated} begin={begin} open={open} writable={v.writable} />}
      </div>
      {menu && menuRow && <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      <span className="dbui-sr" aria-live="polite">{drag && drag.day !== undefined ? formatDay(drag.day, { month: "long", day: "numeric", year: "numeric" }) : ""}</span>
    </div>
  );
}

export function TimelineLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { db } = useDB();
  if (!calendarDateProperty(db, view)) return <EmptyState>Add a date property to use the timeline layout.</EmptyState>;
  return <Timeline view={view} result={result} />;
}

export type { DateDrag };
