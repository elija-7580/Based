// BSD-155: Tabelle – virtualisierte Zeilen (@tanstack/react-virtual), klebender Kopf mit Property-Menüs,
// Spaltenbreite ziehen, Gruppen, „+ New“, Berechnungen in der Fußzeile, Tastatur (Pfeile, Enter, Tippen,
// Entf), Agent-Strich für von Agenten geänderte Zeilen.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { dbops, deleteRows, plainText,
  CALCULATION_LABELS, calculationOptions, calculationText, propertyOf, pv, setCalculation, setColumnWidth, setValue, valueCase,
  visiblePropertyIDs, type Block, type DatabaseView, type PropertySchema, type QueryResult,
} from "@based/core";
import { CellEditor, isEditable } from "../cells/CellEditor.js";
import { CellView } from "../cells/CellView.js";
import { InlineView, useDB } from "../context.js";
import { columnWidth, flatten, limitRows, MIN_COLUMN_WIDTH, nextRowIndex, type FlatItem } from "../logic/layout.js";
import { AddPropertyMenu, PropertyMenu } from "../menus/PropertyMenu.js";
import { Icon, MenuItem, Popover, PROPERTY_ICONS, type Anchor } from "../ui.js";
import { EmptyState, GroupHeader, groupProperty, RowMenu, useAddRow } from "./shared.js";

export const ROW_HEIGHT = 36;
const GROUP_HEIGHT = 44;
const GUTTER = 48; // Auswahl-Kästchen + Zeilen-Menü (BSD-213)

interface Active { rowID: string; col: number }
interface Editing extends Active { anchor: Anchor; initialText?: string }

interface RowProps {
  row: Block;
  /** Sichtbare Spalten [from, to) – Spalten werden horizontal virtualisiert. */
  from: number;
  to: number;
  lead: number;
  props: PropertySchema[];
  widths: number[];
  activeCol: number;
  agent: boolean;
  wrap: boolean;
  onCell: (row: Block, col: number, el: HTMLElement) => void;
  onMenu: (row: Block, el: HTMLElement) => void;
  onOpen: ((id: string) => void) | undefined;
  onToggle: (row: Block, p: PropertySchema) => void;
  /** BSD-213: Zeile ausgewählt (Kästchen); `onSelect(row, shift)`. Fehlt: keine Auswahl (gesperrt). */
  selected: boolean;
  onSelect: ((row: Block, shift: boolean) => void) | undefined;
}

const TableRow = memo(function TableRow({ row, from, to, lead, props, widths, activeCol, agent, wrap, onCell, onMenu, onOpen, onToggle, selected, onSelect }: RowProps) {
  return (
    <>
      <div className="dbui-gutter" role="presentation">
        {agent && <span className="dbui-agent-bar" role="img" aria-label="Changed by Based" />}
        {onSelect && (
          <input type="checkbox" className="dbui-row-check" tabIndex={-1} checked={selected} aria-label={`Select ${plainText(row.text) || "Untitled"}`}
            onClick={(e) => { e.preventDefault(); onSelect(row, e.shiftKey); }} onChange={() => undefined} />
        )}
        <button type="button" className="dbui-row-handle" aria-label="Row actions" tabIndex={-1} onClick={(e) => onMenu(row, e.currentTarget)}><Icon name="more" size={14} /></button>
      </div>
      {lead > 0 && <div className="dbui-col-spacer" style={{ width: lead }} aria-hidden />}
      {props.slice(from, to).map((p, i) => { const col = from + i; return (
        <div key={p.id} role="gridcell" className={"dbui-cell" + (col === activeCol ? " active" : "") + (p.type === "title" ? " title" : "")} style={{ width: widths[col] }}
          data-cell={`${row.id}:${col}`} aria-selected={col === activeCol} onClick={(e) => onCell(row, col, e.currentTarget)}>
          <CellView row={row} prop={p} wrap={wrap} onToggleCheckbox={() => onToggle(row, p)} />
          {p.type === "title" && onOpen && (
            <button type="button" className="dbui-open-btn" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onOpen(row.id); }} aria-label={`Open ${plainText(row.text) || "Untitled"}`}>
              <Icon name="open" size={12} />Open
            </button>
          )}
        </div>
      ); })}
    </>
  );
});

/** BSD-213: Leiste über der Tabelle, solange Zeilen ausgewählt sind. Duplizieren/Löschen je ein Undo-Schritt. */
function SelectionBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { store, locked, rowActions } = useDB();
  const n = ids.length;
  return (
    <div className="dbui-selection-bar" role="toolbar" aria-label="Selected pages" data-testid="selection-bar">
      <span className="dbui-data">{n} selected</span>
      {rowActions?.openInTabs && <button type="button" className="dbui-chip" onClick={() => rowActions.openInTabs!(ids)}>Open in new tabs</button>}
      {rowActions?.copyLinks && <button type="button" className="dbui-chip" onClick={() => rowActions.copyLinks!(ids)}>Copy links</button>}
      {!locked && <button type="button" className="dbui-chip" onClick={() => { dbops.duplicateRows(store, ids); onClear(); }}>Duplicate</button>}
      {!locked && <button type="button" className="dbui-chip danger" onClick={() => { deleteRows(store, ids); onClear(); }}>Delete</button>}
      <button type="button" className="dbui-icon-btn" aria-label="Clear selection" onClick={onClear}><Icon name="close" size={14} /></button>
    </div>
  );
}

function HeaderCell({ p, width, view, onResize }: { p: PropertySchema; width: number; view: DatabaseView; onResize: (w: number, done: boolean) => void }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const start = useRef<{ x: number; w: number } | null>(null);
  const down = (e: RPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
  };
  const move = (e: RPointerEvent) => { if (start.current) onResize(Math.max(MIN_COLUMN_WIDTH, start.current.w + e.clientX - start.current.x), false); };
  const up = (e: RPointerEvent) => { if (start.current) { onResize(Math.max(MIN_COLUMN_WIDTH, start.current.w + e.clientX - start.current.x), true); start.current = null; } };
  return (
    <div role="columnheader" className="dbui-th" style={{ width }}>
      <button type="button" className="dbui-th-btn" onClick={(e) => setAnchor(e.currentTarget)} title={p.description}>
        <Icon name={PROPERTY_ICONS[p.type] ?? "text"} size={14} /><span className="dbui-clip">{p.name}</span>
      </button>
      <span className="dbui-resize" role="separator" aria-orientation="vertical" aria-label={`Resize ${p.name}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      {anchor && <LivePropertyMenu id={p.id} view={view} anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}

function LivePropertyMenu({ id, view, anchor, onClose }: { id: string; view: DatabaseView; anchor: Anchor; onClose: () => void }) {
  const { db, store } = useDB();
  const p = propertyOf(db, id);
  const v = store.views.get(view.id) ?? view;
  useEffect(() => { if (!p) onClose(); }, [p, onClose]);
  return p ? <PropertyMenu p={p} view={v} anchor={anchor} onClose={onClose} /> : null;
}

function CalcCell({ p, width, view, rows }: { p: PropertySchema; width: number; view: DatabaseView; rows: Block[] }) {
  const { engine, db, store, locked } = useDB();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const fn = view.calculations?.[p.id] ?? "none";
  const text = fn !== "none" ? calculationText(engine, fn, p, rows, db) : undefined;
  return (
    <div className="dbui-calc" style={{ width }}>
      <button type="button" className={"dbui-calc-btn" + (text === undefined ? " idle" : "")} onClick={(e) => !locked && setAnchor(e.currentTarget)} aria-label={`Calculate ${p.name}`}>
        {text !== undefined ? <><span className="dbui-calc-label">{CALCULATION_LABELS[fn]}</span><span className="dbui-data">{text}</span></> : "Calculate"}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} role="menu" label={`Calculate ${p.name}`}>
          {calculationOptions(p.type).map((c) => <MenuItem key={c} selected={c === fn} onClick={() => { setCalculation(store, view.id, p.id, c); setAnchor(null); }}>{CALCULATION_LABELS[c]}</MenuItem>)}
        </Popover>
      )}
    </div>
  );
}

export function TableLayout({ view, result, requestEdit }: { view: DatabaseView; result: QueryResult; requestEdit?: { rowID: string } | undefined }) {
  const { store, db, locked, onOpenPage, isAgentEdit } = useDB();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ row: Block; anchor: Anchor } | null>(null);
  const [addProp, setAddProp] = useState<Anchor | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  // BSD-213: Zeilen-Mehrfachauswahl (Kästchen, ⇧-Klick = Bereich, alle wählen) mit Sammelaktionen.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const selectAnchor = useRef<string | null>(null);
  const addRow = useAddRow(view);
  const wrap = view.wrapCells === true;

  const propIDs = visiblePropertyIDs(view, db).join("\u0001");
  const props = useMemo(() => propIDs.split("\u0001").flatMap((id) => propertyOf(db, id) ?? []), [propIDs, db]);
  const widthKey = props.map((p) => liveWidths[p.id] ?? columnWidth(view, db, p.id)).join(",");
  const widths = useMemo(() => widthKey.split(",").map(Number), [widthKey]);
  const total = GUTTER + widths.reduce((a, b) => a + b, 0) + 40;
  // Horizontale Virtualisierung: nur Spalten im sichtbaren Bereich (plus Puffer) rendern.
  const offsets = useMemo(() => { const o = [GUTTER]; for (const w of widths) o.push(o[o.length - 1]! + w); return o; }, [widths]);
  const [view_, setView_] = useState({ left: 0, width: 1600 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setView_((v) => (Math.abs(v.left - el.scrollLeft) < 40 && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, []);
  const overscanPx = 400;
  let from = 0;
  while (from < widths.length - 1 && offsets[from + 1]! < view_.left - overscanPx) from++;
  let to = from;
  while (to < widths.length && offsets[to]! < view_.left + view_.width + overscanPx) to++;
  const lead = offsets[from]! - GUTTER;
  // BSD-255: inline in einer Seite nur die ersten Zeilen, „Load more“ holt die nächsten (kein eigener Scroller).
  const inline = useContext(InlineView);
  const [limit, setLimit] = useState(inline?.pageSize ?? Infinity);
  const all = useMemo(() => flatten(result, { collapsed, newRow: !locked }), [result, collapsed, locked]);
  const { items, hidden } = useMemo(() => (inline ? limitRows(all, limit) : { items: all, hidden: 0 }), [all, inline, limit]);
  const gp = groupProperty(db, view);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
    paddingStart: ROW_HEIGHT,
  });

  const rowIndex = useCallback((rowID: string) => items.findIndex((it) => it.kind === "row" && it.row.id === rowID), [items]);

  const cellEl = (rowID: string, col: number) => gridRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(rowID)}:${col}"]`) ?? null;

  const revealCol = useCallback((col: number) => {
    const el = scrollRef.current;
    const a = offsets[col], b = offsets[col + 1];
    if (!el || a === undefined || b === undefined) return;
    if (a - GUTTER < el.scrollLeft) el.scrollLeft = a - GUTTER;
    else if (b > el.scrollLeft + el.clientWidth) el.scrollLeft = b - el.clientWidth + GUTTER;
  }, [offsets]);
  useEffect(() => { if (active) revealCol(active.col); }, [active, revealCol]);

  const beginEdit = useCallback((rowID: string, col: number, initialText?: string) => {
    const row = store.blocks.get(rowID);
    const p = props[col];
    if (!row || !p || locked) return;
    if (p.type === "checkbox") {
      const c = valueCase(row.values?.[p.id]);
      setValue(store, row.id, p.id, pv("checkbox", !(c?.[0] === "checkbox" && c[1] === true)));
      return;
    }
    if (!isEditable(p.type)) return;
    let el = cellEl(rowID, col);
    if (!el) {
      // Spalte (noch) nicht gerendert: hinscrollen, dann im nächsten Frame öffnen.
      revealCol(col);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el = cellEl(rowID, col);
        if (el) setEditing({ rowID, col, anchor: el, ...(initialText !== undefined ? { initialText } : {}) });
      }));
      return;
    }
    if (el) setEditing({ rowID, col, anchor: el, ...(initialText !== undefined ? { initialText } : {}) });
  }, [store, props, locked, revealCol]);

  const onCell = useCallback((row: Block, col: number, el: HTMLElement) => {
    setActive({ rowID: row.id, col });
    gridRef.current?.focus({ preventScroll: true });
    const p = props[col];
    if (p && p.type !== "checkbox" && isEditable(p.type) && !locked) setEditing({ rowID: row.id, col, anchor: el });
  }, [props, locked]);
  const onMenu = useCallback((row: Block, el: HTMLElement) => setMenu({ row, anchor: el }), []);
  const onToggle = useCallback((row: Block, p: PropertySchema) => {
    const c = valueCase(row.values?.[p.id]);
    setValue(store, row.id, p.id, pv("checkbox", !(c?.[0] === "checkbox" && c[1] === true)));
  }, [store]);

  // Neue Zeile: hinscrollen und den Titel bearbeiten, sobald sie gerendert ist.
  useEffect(() => {
    if (!pendingEdit) return;
    const i = rowIndex(pendingEdit);
    if (i < 0) { setPendingEdit(null); return; }
    virtualizer.scrollToIndex(i, { align: "auto" });
    const id = requestAnimationFrame(() => {
      const titleCol = props.findIndex((p) => p.type === "title");
      setActive({ rowID: pendingEdit, col: Math.max(0, titleCol) });
      beginEdit(pendingEdit, Math.max(0, titleCol));
      setPendingEdit(null);
    });
    return () => cancelAnimationFrame(id);
  }, [pendingEdit, rowIndex, virtualizer, props, beginEdit]);

  useEffect(() => { if (requestEdit) setPendingEdit(requestEdit.rowID); }, [requestEdit]);

  const newRow = (groupID: string | null) => {
    const id = addRow(groupID);
    if (id) setPendingEdit(id);
  };

  /** BSD-238: erste Zelle, wenn das Raster per Tastatur den Fokus bekommt und noch keine Zelle aktiv ist. */
  const firstCell = (): Active | null => {
    const n = nextRowIndex(items, -1, 1);
    const it = n >= 0 ? items[n] : undefined;
    return it?.kind === "row" ? { rowID: it.row.id, col: 0 } : null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (!active) {
      if (e.target === e.currentTarget && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        setActive(firstCell());
      }
      return;
    }
    const i = rowIndex(active.rowID);
    const move = (rowIdx: number, col: number) => {
      const it = items[rowIdx];
      if (!it || it.kind !== "row") return;
      setActive({ rowID: it.row.id, col });
      virtualizer.scrollToIndex(rowIdx, { align: "auto" });
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); { const n = nextRowIndex(items, i, 1); if (n >= 0) move(n, active.col); } break;
      case "ArrowUp": e.preventDefault(); { const n = nextRowIndex(items, i, -1); if (n >= 0) move(n, active.col); } break;
      case "ArrowRight": e.preventDefault(); setActive({ ...active, col: Math.min(props.length - 1, active.col + 1) }); break;
      case "ArrowLeft": e.preventDefault(); setActive({ ...active, col: Math.max(0, active.col - 1) }); break;
      case "Enter": e.preventDefault(); beginEdit(active.rowID, active.col); break;
      // BSD-238: Tab/⇧Tab wandern durch die Zellen (am Rand weiter in die nächste Zeile, am Ende raus aus dem Raster).
      case "Tab": {
        if (e.metaKey || e.ctrlKey || e.altKey) break;
        const dir = e.shiftKey ? -1 : 1;
        const col = active.col + dir;
        if (col >= 0 && col < props.length) { e.preventDefault(); setActive({ ...active, col }); break; }
        const n = nextRowIndex(items, i, dir);
        if (n >= 0) { e.preventDefault(); move(n, dir > 0 ? 0 : props.length - 1); } else setActive(null);
        break;
      }
      // Leertaste öffnet die Zeile (Peek bzw. Seite), wie in Notion.
      case " ": if (onOpenPage && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpenPage(active.rowID); } break;
      case "Escape": setActive(null); break;
      // BSD-238: ⇧F10 / Menütaste öffnet das Zeilenmenü der aktiven Zeile.
      case "F10": case "ContextMenu": {
        if (e.key === "F10" && !e.shiftKey) break;
        const handle = gridRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(active.rowID)}"] .dbui-row-handle`);
        if (handle) { e.preventDefault(); handle.click(); }
        break;
      }
      case "Backspace": case "Delete": {
        const p = props[active.col];
        if (p && !locked && isEditable(p.type)) { e.preventDefault(); setValue(store, active.rowID, p.id, null); }
        break;
      }
      default: {
        const p = props[active.col];
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && p && ["title", "text", "number", "url", "email", "phone", "place"].includes(p.type)) {
          e.preventDefault();
          beginEdit(active.rowID, active.col, e.key);
        }
      }
    }
  };

  const resize = useCallback((id: string) => (w: number, done: boolean) => {
    if (done) {
      setColumnWidth(store, view.id, id, Math.round(w));
      setLiveWidths((m) => { const n = { ...m }; delete n[id]; return n; });
    } else setLiveWidths((m) => ({ ...m, [id]: w }));
  }, [store, view.id]);

  const rowOrder = useMemo(() => result.rows.map((r) => r.id), [result.rows]);
  // Gelöschte oder herausgefilterte Zeilen fallen aus der Auswahl.
  useEffect(() => {
    if (!selected.size) return;
    const live = rowOrder.filter((id) => selected.has(id));
    if (live.length !== selected.size) setSelected(new Set(live));
  }, [rowOrder, selected]);
  const onSelect = useCallback((row: Block, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = selectAnchor.current;
      if (shift && anchor && anchor !== row.id) {
        const a = rowOrder.indexOf(anchor), b = rowOrder.indexOf(row.id);
        if (a >= 0 && b >= 0) for (const id of rowOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(id);
      } else if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      selectAnchor.current = row.id;
      return next;
    });
  }, [rowOrder]);
  const allSelected = rowOrder.length > 0 && selected.size === rowOrder.length;

  const editingRow = editing ? store.blocks.get(editing.rowID) : undefined;
  const editingProp = editing ? props[editing.col] : undefined;
  const menuRow = menu ? store.blocks.get(menu.row.id) : undefined;
  const vItems = virtualizer.getVirtualItems();

  return (
    <div className="dbui-scroll" ref={scrollRef} data-testid="table-scroll" onKeyDown={(e) => { if (e.key === "Escape" && selected.size && !editing) { setSelected(new Set()); } }}>
      {selected.size > 0 && <SelectionBar ids={[...selected]} onClear={() => setSelected(new Set())} />}
      <div className="dbui-table" role="grid" aria-label={view.name} aria-rowcount={result.rows.length + 1} aria-colcount={props.length}
        tabIndex={0} ref={gridRef} onKeyDown={onKeyDown} onFocus={(e) => { if (e.target === e.currentTarget && !active && !editing) setActive(firstCell()); }} style={{ width: total, height: virtualizer.getTotalSize() + ROW_HEIGHT }}>
        <div className="dbui-thead" role="row" style={{ width: total }}>
          <div className="dbui-gutter">
            {!locked && rowOrder.length > 0 && (
              <input type="checkbox" className={"dbui-row-check" + (selected.size ? " shown" : "")} tabIndex={-1} aria-label="Select all"
                checked={allSelected} ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(rowOrder))} />
            )}
          </div>
          {props.map((p, i) => <HeaderCell key={p.id} p={p} width={widths[i]!} view={view} onResize={resize(p.id)} />)}
          {!locked && <button type="button" className="dbui-th-add" aria-label="Add property" onClick={(e) => setAddProp(e.currentTarget)}><Icon name="plus" size={14} /></button>}
        </div>
        {vItems.map((vi) => {
          const it = items[vi.index] as FlatItem;
          const style = { transform: `translateY(${vi.start}px)`, width: total };
          if (it.kind === "group") {
            return (
              <div key={vi.key} className="dbui-vrow group" style={style} data-index={vi.index} ref={wrap ? virtualizer.measureElement : undefined}>
                <GroupHeader group={it.group} prop={gp} collapsed={it.collapsed} onToggle={() => setCollapsed((s) => { const n = new Set(s); if (n.has(it.group.id)) n.delete(it.group.id); else n.add(it.group.id); return n; })} />
              </div>
            );
          }
          if (it.kind === "new") {
            return (
              <div key={vi.key} className="dbui-vrow new" style={style} data-index={vi.index}>
                <button type="button" className="dbui-new-row" onClick={() => newRow(it.groupID)}><Icon name="plus" size={14} />New</button>
              </div>
            );
          }
          if (it.kind !== "row") return null;
          return (
            <div key={vi.key} role="row" className={"dbui-vrow" + (wrap ? " wrap" : "") + (selected.has(it.row.id) ? " selected" : "")} aria-selected={selected.has(it.row.id) || undefined} style={style} data-index={vi.index} data-row-id={it.row.id}
              aria-rowindex={vi.index + 2} ref={wrap ? virtualizer.measureElement : undefined}>
              <TableRow row={it.row} from={from} to={to} lead={lead} props={props} widths={widths} activeCol={active?.rowID === it.row.id ? active.col : -1} agent={isAgentEdit(it.row)} wrap={wrap}
                onCell={onCell} onMenu={onMenu} onOpen={onOpenPage} onToggle={onToggle} selected={selected.has(it.row.id)} onSelect={locked ? undefined : onSelect} />
            </div>
          );
        })}
      </div>
      {hidden > 0 && inline && (
        <button type="button" className="dbui-load-more" onClick={() => setLimit((l) => l + inline.pageSize)}>
          Load more <span className="dbui-count">{Math.min(hidden, inline.pageSize)} of {hidden}</span>
        </button>
      )}
      {result.rows.length === 0 && <EmptyState>{view.filter?.items.length ? "No pages match the filters." : "No pages yet."}</EmptyState>}
      <div className="dbui-tfoot" style={{ width: total }} role="row" aria-label="Calculations">
        <div className="dbui-gutter" />
        {props.map((p, i) => <CalcCell key={p.id} p={p} width={widths[i]!} view={view} rows={result.rows} />)}
      </div>
      {editing && editingRow && editingProp && (
        <CellEditor row={editingRow} prop={editingProp} anchor={editing.anchor} initialText={editing.initialText}
          onClose={() => { setEditing(null); gridRef.current?.focus({ preventScroll: true }); }}
          onCommitNext={() => {
            const n = nextRowIndex(items, rowIndex(editing.rowID), 1);
            const it = n >= 0 ? items[n] : undefined;
            if (it?.kind === "row") { setActive({ rowID: it.row.id, col: editing.col }); virtualizer.scrollToIndex(n, { align: "auto" }); }
          }} />
      )}
      {menu && menuRow && <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {addProp && <AddPropertyMenu view={view} anchor={addProp} onClose={() => setAddProp(null)} />}
    </div>
  );
}
