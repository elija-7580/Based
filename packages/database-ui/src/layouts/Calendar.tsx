// BSD-8: Kalender – Monat (fortlaufende Wochen, virtualisiert) und Woche (Spuren virtualisiert). Einträge nach
// Datums-Property inkl. Zeitraum bzw. Ende-Property, mehrtägig als durchgehende Balken über die Tageszellen,
// „+N more“ öffnet die Liste des Tages, Ziehen verschiebt Beginn und Ende (eine Transaktion), Klick auf einen
// leeren Tag legt eine Zeile mit diesem Datum an. Wochenbeginn aus den Einstellungen bzw. dem Locale.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  addMonths, addRowOnDay, calendarDateProperty, formatDay, layoutLanes, moveRowSpan, spanLabel, startOfMonth, startOfWeek, updateView, values, ymdOf,
  type Block, type DatabaseView, type LanePlacement, type QueryResult, type RowSpan,
} from "@based/core";
import { useDB } from "../context.js";
import { Icon, Popover, type Anchor } from "../ui.js";
import { useDateDrag, dayFromPoint, type DateDrag } from "./dateDrag.js";
import { EmptyState, groupProperty, newRowValues } from "./shared.js";
import { rowTitle, spansIn, useToday, useViewSpans, type ViewSpans } from "./spans.js";

/** Höhen in px (für den Virtualisierer; die CSS-Klassen nutzen dieselben Werte über Inline-Stile). */
const WEEK_HEAD = 28;
const LANE_H = 24;
const MORE_H = 20;
const MIN_WEEK_H = 112;
const WEEKS_VISIBLE = 5;
const YEARS_AROUND = 5;
const POP_ITEM_H = 32;

type Mode = "month" | "week";

const pct = (n: number) => `${(n * 100) / 7}%`;

function timeOf(s: RowSpan): string {
  return s.includeTime ? values.toJSDate(s.startAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
}

interface EntryActions {
  writable: boolean;
  begin: (e: ReactPointerEvent<HTMLElement>, rowID: string, kind: "move") => void;
  open: (rowID: string) => void;
  nudge: (rowID: string, delta: number) => void;
  isAgentEdit: (row: Block) => boolean;
}

const Entry = memo(function Entry({ span, from, to, top, before, after, dragging, a }: {
  span: RowSpan; from: number; to: number; top: number; before: boolean; after: boolean; dragging: boolean; a: EntryActions;
}) {
  const title = rowTitle(span.row);
  const time = timeOf(span);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); a.open(span.row.id); }
    else if (a.writable && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); a.nudge(span.row.id, e.key === "ArrowLeft" ? -1 : 1); }
  };
  return (
    <div className={"dbui-cal-entry" + (before ? " before" : "") + (after ? " after" : "") + (dragging ? " dragging" : "") + (a.writable ? " movable" : "")}
      data-row-id={span.row.id} role="button" tabIndex={0} aria-label={`${title}, ${spanLabel(span)}`} title={`${title} · ${spanLabel(span)}`}
      style={{ left: `calc(${pct(from)} + ${before ? 0 : 3}px)`, width: `calc(${pct(to - from + 1)} - ${(before ? 0 : 3) + (after ? 0 : 3)}px)`, top }}
      onPointerDown={a.writable ? (e) => a.begin(e, span.row.id, "move") : undefined}
      onClick={() => a.open(span.row.id)} onKeyDown={onKey}>
      {a.isAgentEdit(span.row) && <span className="dbui-agent-bar" role="img" aria-label="Changed by Based" />}
      {time && <span className="dbui-cal-time">{time}</span>}
      <span className="dbui-cal-entry-title">{title}</span>
    </div>
  );
});

// MARK: Listen in Popovern (Tag, ohne Datum) – virtualisiert

function RowList({ rows, label, onOpen, describe }: { rows: Block[]; label: string; onOpen: (id: string) => void; describe?: (row: Block) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => POP_ITEM_H, overscan: 8 });
  return (
    <div className="dbui-cal-poplist" ref={ref} role="list" aria-label={label} style={{ height: Math.min(rows.length, 10) * POP_ITEM_H }}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]!;
          return (
            <button key={row.id} type="button" role="listitem" className="dbui-cal-popitem" data-list-row-id={row.id}
              style={{ transform: `translateY(${vi.start}px)`, height: POP_ITEM_H }} onClick={() => onOpen(row.id)}>
              <span className="dbui-cal-entry-title">{rowTitle(row)}</span>
              {describe && <span className="dbui-hint">{describe(row)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// MARK: Monat

const DayCell = memo(function DayCell({ day, out, isToday, writable, onCreate, height }: {
  day: number; out: boolean; isToday: boolean; writable: boolean; onCreate: (day: number) => void; height?: number;
}) {
  const { day: n } = ymdOf(day);
  const label = formatDay(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return (
    <div className={"dbui-cal-day" + (out ? " out" : "") + (isToday ? " today" : "") + (writable ? " creatable" : "")} data-day={day} role="gridcell" aria-label={label}
      style={height ? { height } : undefined}
      onClick={(e) => { if (writable && !(e.target as HTMLElement).closest("button")) onCreate(day); }}>
      <div className="dbui-cal-day-head" style={{ height: WEEK_HEAD }}>
        {writable && <button type="button" className="dbui-cal-add" aria-label={`New page on ${formatDay(day, { month: "short", day: "numeric" })}`} onClick={() => onCreate(day)}><Icon name="plus" size={12} /></button>}
        <span className="dbui-cal-num" aria-current={isToday ? "date" : undefined}>{n === 1 ? formatDay(day, { month: "short", day: "numeric" }) : n}</span>
      </div>
    </div>
  );
});

const WeekRow = memo(function WeekRow({ first, top, height, lanes, focusMonth, todayDay, v, drag, a, onCreate, onMore }: {
  first: number; top: number; height: number; lanes: number; focusMonth: number; todayDay: number; v: ViewSpans; drag: DateDrag | null;
  a: EntryActions; onCreate: (day: number) => void; onMore: (day: number, el: HTMLElement) => void;
}) {
  const spans = useMemo(() => spansIn(v, first, first + 6, drag), [v, first, drag]);
  const layout = useMemo(() => layoutLanes(spans, first, 7, lanes), [spans, first, lanes]);
  return (
    <div className="dbui-cal-week" role="row" style={{ transform: `translateY(${top}px)`, height }} data-week={first}>
      {Array.from({ length: 7 }, (_, i) => {
        const d = first + i;
        const { year, month } = ymdOf(d);
        return <DayCell key={d} day={d} out={year * 12 + month !== focusMonth} isToday={d === todayDay} writable={a.writable} onCreate={onCreate} />;
      })}
      <div className="dbui-cal-layer">
        {layout.placements.filter((p) => p.lane < lanes).map((p) => (
          <Entry key={p.span.row.id} span={p.span} from={p.from} to={p.to} top={WEEK_HEAD + p.lane * LANE_H} before={p.continuesBefore} after={p.continuesAfter}
            dragging={drag?.rowID === p.span.row.id} a={a} />
        ))}
        {layout.hiddenPerDay.map((n, i) => n > 0 && (
          <button key={i} type="button" className="dbui-cal-more" style={{ left: pct(i), width: pct(1), top: WEEK_HEAD + lanes * LANE_H, height: MORE_H }}
            aria-label={`${n} more on ${formatDay(first + i, { month: "long", day: "numeric" })}`} onClick={(e) => onMore(first + i, e.currentTarget)}>
            +{n} more
          </button>
        ))}
      </div>
    </div>
  );
});

function useHeight(ref: React.RefObject<HTMLElement>): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

interface ViewProps {
  v: ViewSpans; todayDay: number; weekStart: number; a: EntryActions; drag: DateDrag | null;
  onCreate: (day: number) => void; onMore: (day: number, el: HTMLElement) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Kopfzeile (Titel und Blättern) – je Modus. */
  header: (title: string, prev: () => void, next: () => void, goToday: () => void) => React.ReactNode;
}

function MonthView({ v, todayDay, weekStart, a, drag, onCreate, onMore, scrollRef, header }: ViewProps) {
  const height = useHeight(scrollRef);
  const weekH = Math.max(MIN_WEEK_H, Math.floor((height || MIN_WEEK_H * WEEKS_VISIBLE) / WEEKS_VISIBLE));
  const lanes = Math.max(1, Math.floor((weekH - WEEK_HEAD - MORE_H - 2) / LANE_H));
  const range = useMemo(() => {
    const limit = 366 * 50;
    const lo = Math.max(todayDay - limit, Math.min(todayDay - 366 * YEARS_AROUND, v.index.min ?? todayDay));
    const hi = Math.min(todayDay + limit, Math.max(todayDay + 366 * YEARS_AROUND, v.index.max ?? todayDay));
    const first = startOfWeek(lo, weekStart);
    return { first, count: Math.floor((hi - first) / 7) + 1 };
  }, [v.index, todayDay, weekStart]);
  const weekIndex = (day: number) => Math.floor((startOfWeek(day, weekStart) - range.first) / 7);
  const virtualizer = useVirtualizer({ count: range.count, getScrollElement: () => scrollRef.current, estimateSize: () => weekH, overscan: 2 });
  // Anker: welche Woche oben steht (bleibt beim Ändern der Wochenhöhe oder des Bereichs erhalten).
  const anchor = useRef<number | null>(null);
  const shown = useRef({ weekH, first: range.first });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !height) return;
    if (anchor.current === null) anchor.current = weekIndex(startOfMonth(todayDay));
    else if (shown.current.weekH !== weekH || shown.current.first !== range.first) {
      anchor.current = el.scrollTop / shown.current.weekH + (shown.current.first - range.first) / 7;
    } else return;
    shown.current = { weekH, first: range.first };
    virtualizer.measure();
    el.scrollTop = anchor.current * weekH;
  }, [height, weekH, range.first]);

  const offset = virtualizer.scrollOffset ?? 0;
  const focusDay = range.first + (Math.floor((offset + weekH / 2) / weekH) + 1) * 7 + 3;
  const { year, month } = ymdOf(focusDay);
  const jump = (day: number) => { const el = scrollRef.current; if (el) el.scrollTop = weekIndex(day) * weekH; };
  const goToday = () => {
    const ms = startOfMonth(todayDay);
    const fits = (weekIndex(todayDay) - weekIndex(ms) + 1) * weekH <= (scrollRef.current?.clientHeight ?? 0);
    jump(fits ? ms : todayDay);
  };
  return (
    <>
      {header(formatDay(focusDay, { month: "long", year: "numeric" }), () => jump(addMonths(startOfMonth(focusDay), -1)), () => jump(addMonths(startOfMonth(focusDay), 1)), goToday)}
      <Weekdays weekStart={weekStart} />
      <div className="dbui-cal-scroll" ref={scrollRef} data-testid="calendar-scroll" role="grid" aria-label="Calendar" aria-readonly={!a.writable}>
        <div className="dbui-cal-inner" style={{ height: virtualizer.getTotalSize() }}>
          {height > 0 && virtualizer.getVirtualItems().map((vi) => (
            <WeekRow key={vi.index} first={range.first + vi.index * 7} top={vi.start} height={weekH} lanes={lanes} focusMonth={year * 12 + month}
              todayDay={todayDay} v={v} drag={drag} a={a} onCreate={onCreate} onMore={onMore} />
          ))}
        </div>
      </div>
    </>
  );
}

function Weekdays({ weekStart, days }: { weekStart: number; days?: number }) {
  return (
    <div className="dbui-cal-weekdays" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => {
        // 4. Januar 1970 war ein Sonntag (Tag 3)
        const d = days !== undefined ? days + i : 3 + ((weekStart + i) % 7);
        return <span key={i}>{formatDay(d, { weekday: "short" })}{days !== undefined ? " " + ymdOf(d).day : ""}</span>;
      })}
    </div>
  );
}

// MARK: Woche

/** Eine Spur der Wochenansicht als eigener Container (≤ 7 Einträge): Ein- und Ausblenden beim Scrollen fasst nur Spuren an. */
const Lane = memo(function Lane({ placements, top, drag, a }: { placements: LanePlacement[]; top: number; drag: DateDrag | null; a: EntryActions }) {
  const d = drag && placements.some((p) => p.span.row.id === drag.rowID) ? drag : null;
  return (
    <div className="dbui-cal-lane" style={{ transform: `translateY(${top}px)`, height: LANE_H }}>
      {placements.map((p) => (
        <Entry key={p.span.row.id} span={p.span} from={p.from} to={p.to} top={0} before={p.continuesBefore} after={p.continuesAfter} dragging={d?.rowID === p.span.row.id} a={a} />
      ))}
    </div>
  );
});

function WeekView({ v, todayDay, weekStart, a, drag, onCreate, scrollRef, header }: ViewProps) {
  const [first, setFirst] = useState(() => startOfWeek(todayDay, weekStart));
  const height = useHeight(scrollRef);
  const layout = useMemo(() => layoutLanes(spansIn(v, first, first + 6, drag), first, 7), [v, first, drag]);
  const byLane = useMemo(() => {
    const out: (typeof layout.placements)[] = Array.from({ length: layout.lanes }, () => []);
    for (const p of layout.placements) out[p.lane]!.push(p);
    return out;
  }, [layout]);
  const virtualizer = useVirtualizer({ count: layout.lanes, getScrollElement: () => scrollRef.current, estimateSize: () => LANE_H, overscan: 6, paddingStart: 8 });
  const total = Math.max(virtualizer.getTotalSize() + LANE_H * 2, height);
  const last = first + 6;
  const title = ymdOf(first).month === ymdOf(last).month
    ? `${formatDay(first, { month: "short", day: "numeric" })} – ${ymdOf(last).day}, ${ymdOf(last).year}`
    : `${formatDay(first, { month: "short", day: "numeric" })} – ${formatDay(last, { month: "short", day: "numeric", year: "numeric" })}`;
  return (
    <>
      {header(title, () => setFirst(first - 7), () => setFirst(first + 7), () => setFirst(startOfWeek(todayDay, weekStart)))}
      <Weekdays weekStart={weekStart} days={first} />
      <div className="dbui-cal-scroll week" ref={scrollRef} data-testid="calendar-scroll" role="grid" aria-label="Calendar week" aria-readonly={!a.writable}>
        <div className="dbui-cal-inner" style={{ height: total }}>
          <div className="dbui-cal-week tall" role="row" style={{ height: total }}>
            {Array.from({ length: 7 }, (_, i) => <DayCell key={i} day={first + i} out={false} isToday={first + i === todayDay} writable={a.writable} onCreate={onCreate} height={total} />)}
          </div>
          <div className="dbui-cal-layer">
            {virtualizer.getVirtualItems().map((vi) => (
              <Lane key={vi.index} placements={byLane[vi.index]!} top={vi.start + WEEK_HEAD} drag={drag} a={a} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// MARK: Kalender

function Calendar({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { store, db, locked, weekStart, onOpenPage, isAgentEdit } = useDB();
  const v = useViewSpans(view, result);
  const todayDay = useToday();
  const [mode, setModeState] = useState<Mode>(view.calendarMode === "week" ? "week" : "month");
  useEffect(() => { setModeState(view.calendarMode === "week" ? "week" : "month"); }, [view.calendarMode]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ kind: "day"; day: number; anchor: Anchor } | { kind: "undated"; anchor: Anchor } | null>(null);
  const writable = v.writable;
  const props = v.props;

  const { drag, begin } = useDateDrag({
    dayAt: (x, y) => dayFromPoint(x, y, scrollRef.current),
    scrollEl: () => scrollRef.current,
    onDrop: (d) => { if (props && d.kind === "move" && d.delta !== 0) moveRowSpan(store, d.rowID, props, d.delta); },
  });
  const open = useCallback((id: string) => onOpenPage?.(id), [onOpenPage]);
  const nudge = useCallback((id: string, delta: number) => { if (props) moveRowSpan(store, id, props, delta); }, [store, props]);
  const a: EntryActions = useMemo(() => ({ writable, begin, open, nudge, isAgentEdit }), [writable, begin, open, nudge, isAgentEdit]);
  const onCreate = useCallback((day: number) => {
    if (!props || !writable) return;
    const id = addRowOnDay(store, db.id, props, day, { values: newRowValues(db, view, groupProperty(db, view), null) });
    if (id) onOpenPage?.(id);
  }, [store, db, view, props, writable, onOpenPage]);
  const onMore = useCallback((day: number, el: HTMLElement) => setPop({ kind: "day", day, anchor: el }), []);
  const setMode = (m: Mode) => {
    setModeState(m);
    if (!locked && view.calendarMode !== m) updateView(store, view.id, (x) => { x.calendarMode = m; }, "Calendar range");
  };

  const header = (title: string, prev: () => void, next: () => void, goToday: () => void) => (
    <div className="dbui-cal-bar">
      <strong className="dbui-cal-title" aria-live="polite" data-testid="calendar-title">{title}</strong>
      {v.undated.length > 0 && (
        <button type="button" className="dbui-chip ghost" onClick={(e) => setPop({ kind: "undated", anchor: e.currentTarget })}>No date ({v.undated.length.toLocaleString("en-US")})</button>
      )}
      <div className="dbui-seg" role="radiogroup" aria-label="Calendar range">
        {(["month", "week"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className="dbui-seg-item" onClick={() => setMode(m)}>{m === "month" ? "Month" : "Week"}</button>
        ))}
      </div>
      <button type="button" className="dbui-icon-btn" aria-label={mode === "month" ? "Previous month" : "Previous week"} onClick={prev}><Icon name="chevronLeft" size={14} /></button>
      <button type="button" className="dbui-chip" onClick={goToday}>Today</button>
      <button type="button" className="dbui-icon-btn" aria-label={mode === "month" ? "Next month" : "Next week"} onClick={next}><Icon name="chevronRight" size={14} /></button>
    </div>
  );

  const vp: ViewProps = { v, todayDay, weekStart, a, drag, onCreate, onMore, scrollRef, header };
  const dayRows = pop?.kind === "day" ? v.index.query(pop.day, pop.day).map((s) => s.row) : [];
  return (
    <div className={"dbui-calendar" + (drag ? " dragging" : "")} data-testid="calendar" data-mode={mode}>
      {mode === "month" ? <MonthView key="m" {...vp} /> : <WeekView key="w" {...vp} />}
      {pop?.kind === "day" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} label={formatDay(pop.day, { weekday: "long", month: "long", day: "numeric" })} className="dbui-cal-pop">
          <div className="dbui-menu-heading">{formatDay(pop.day, { weekday: "long", month: "long", day: "numeric" })} · {dayRows.length}</div>
          <RowList rows={dayRows} label="Pages on this day" onOpen={(id) => { setPop(null); open(id); }} describe={(r) => { const s = v.byID.get(r.id); return s ? spanLabel(s) : ""; }} />
          {writable && <button type="button" className="dbui-new-row" onClick={() => { const d = pop.day; setPop(null); onCreate(d); }}><Icon name="plus" size={14} />New</button>}
        </Popover>
      )}
      {pop?.kind === "undated" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} label="No date" className="dbui-cal-pop">
          <div className="dbui-menu-heading">No date · {v.undated.length.toLocaleString("en-US")}</div>
          <RowList rows={v.undated} label="Pages without a date" onOpen={(id) => { setPop(null); open(id); }} />
        </Popover>
      )}
    </div>
  );
}

export function CalendarLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { db } = useDB();
  if (!calendarDateProperty(db, view)) return <EmptyState>Add a date property to use the calendar layout.</EmptyState>;
  return <Calendar view={view} result={result} />;
}
