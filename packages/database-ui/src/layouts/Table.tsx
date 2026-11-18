// BSD-155: Tabelle – virtualisierte Zeilen (@tanstack/react-virtual), klebender Kopf mit Property-Menüs,
// Spaltenbreite ziehen, Gruppen, „+ New“, Berechnungen in der Fußzeile, Tastatur (Pfeile, Enter, Tippen,
// Entf), Agent-Strich für von Agenten geänderte Zeilen.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { dbops, deleteRows, plainText,
  CALCULATION_LABELS, calculationOptions, calculationText, propertyOf, pv, setCalculation, setColumnWidth, setValue, valueCase,
  setValues, visiblePropertyIDs, type Block, type DatabaseView, type PropertySchema, type QueryResult,
} from "@based/core";
import { cellString, decodeTSV, encodeTSV, isMulti, pasteable, planPaste, rangeRect, type CellRange } from "../logic/cellRange.js";
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
  /** Spalten des Zellbereichs in dieser Zeile („c0:c1“), sonst leer. Als Text, damit `memo` greift. */
  range: string;
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

/** BSD-544: ID der aktiven Zelle für aria-activedescendant – der Fokus bleibt am Raster, Screenreader und der
 *  Tab-Durchlauf sehen die Zelle mit dem einen Fokusrahmen (docs/design/elements.md, Abschnitt 3). */
const activeCellID = (rowID: string, col: number) => `dbui-active-${rowID}-${col}`;

const TableRow = memo(function TableRow({ row, from, to, lead, props, widths, activeCol, range, agent, wrap, onCell, onMenu, onOpen, onToggle, selected, onSelect }: RowProps) {
  const [c0, c1] = range ? range.split(":").map(Number) as [number, number] : [-1, -2];
  return (
    <>
      {/* BSD-444: Rand mit Kästchen und Zeilenmenü ist eine eigene Zelle – Knöpfe liegen nie direkt in role=row */}
      <div className="dbui-gutter" role="gridcell" aria-label="Row controls">
        {agent && <span className="dbui-agent-bar" role="img" aria-label="Changed by Based" />}
        {onSelect && (
          <input type="checkbox" className="dbui-row-check" tabIndex={-1} checked={selected} aria-label={`Select ${plainText(row.text) || "Untitled"}`}
            // BSD-359: kein preventDefault – sonst setzt der Browser das Häkchen nach dem Klick zurück und die gewählte Zeile
            // zeigt ein leeres Kästchen; der Zustand kommt ohnehin aus `selected`.
            onClick={(e) => onSelect(row, e.shiftKey)} onChange={() => undefined} />
        )}
        <button type="button" className="dbui-row-handle" aria-label="Row actions" tabIndex={-1} onClick={(e) => onMenu(row, e.currentTarget)}><Icon name="more" size={14} /></button>
      </div>
      {lead > 0 && <div className="dbui-col-spacer" style={{ width: lead }} aria-hidden />}
      {props.slice(from, to).map((p, i) => { const col = from + i; return (
        <div key={p.id} role="gridcell" className={"dbui-cell" + (col === activeCol ? " active" : "") + (col >= c0 && col <= c1 ? " in-range" : "") + (p.type === "title" ? " title" : "")} style={{ width: widths[col] }}
          data-cell={`${row.id}:${col}`} id={col === activeCol ? activeCellID(row.id, col) : undefined} aria-selected={col === activeCol || (col >= c0 && col <= c1)} onClick={(e) => onCell(row, col, e.currentTarget)}>
          <CellView row={row} prop={p} wrap={wrap} blankEmptyTitle onToggleCheckbox={() => onToggle(row, p)} />
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
  const { store, db, engine, locked, onOpenPage, isAgentEdit } = useDB();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Zellbereich (⇧-Pfeile, Ziehen, ⇧-Klick): Kopieren, Einfügen, Leeren wie in Notion.
  const [range, setRange] = useState<CellRange | null>(null);
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

  // BSD-536: Zwischen dem ersten getippten Zeichen und dem Fokus des Zelleneditors kommen weitere Tasten noch bei der
  // Tabelle an. Sie werden hier gesammelt und vom Editor beim Öffnen übernommen (null = nichts offen).
  const typeAhead = useRef<string | null>(null);
  useEffect(() => { if (!editing) typeAhead.current = null; }, [editing]);
  const beginEdit = useCallback((rowID: string, col: number, initialText?: string) => {
    const row = store.blocks.get(rowID);
    const p = props[col];
    typeAhead.current = null;
    if (!row || !p || locked) return;
    if (initialText !== undefined && p.type !== "place") typeAhead.current = initialText;
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

  // BSD-372: Ein Klick auf eine Zelle fokussiert die Tabelle selbst. Der Fokus-Handler darf dann nicht „erste Zelle“
  // setzen – sein `active` ist noch der alte Stand (nach Escape leer), und die Auswahl sprang an den Anfang statt auf
  // die Zeile unter der Maus.
  const focusByPointer = useRef(false);
  const suppressClick = useRef(false);
  const onCell = useCallback((row: Block, col: number, el: HTMLElement) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    setRange(null);
    setActive({ rowID: row.id, col });
    focusByPointer.current = true;
    gridRef.current?.focus({ preventScroll: true });
    focusByPointer.current = false;
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

  /** Zeilen-IDs in Anzeigereihenfolge (ohne Gruppenköpfe und „+ New“) – Grundlage für Bereiche. */
  const visibleOrder = useMemo(() => items.flatMap((it) => (it.kind === "row" ? [it.row.id] : [])), [items]);

  /** Nächste Zelle für Tab/⇧Tab: am Rand weiter in die nächste/vorige Zeile; `null` am Ende des Rasters. */
  const tabFrom = (cell: Active, dir: 1 | -1): { cell: Active; index: number } | null => {
    const col = cell.col + dir;
    const i = rowIndex(cell.rowID);
    if (col >= 0 && col < props.length) return { cell: { rowID: cell.rowID, col }, index: i };
    const n = nextRowIndex(items, i, dir);
    const it = n >= 0 ? items[n] : undefined;
    return it?.kind === "row" ? { cell: { rowID: it.row.id, col: dir > 0 ? 0 : props.length - 1 }, index: n } : null;
  };

  const goTo = (cell: Active, extend: boolean) => {
    const idx = rowIndex(cell.rowID);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
    revealCol(cell.col);
    if (extend && active) setRange((r) => ({ anchor: r?.anchor ?? active, head: cell }));
    else { setRange(null); setActive(cell); }
  };

  /** Zellen im Bereich leeren (ein Undo-Schritt); Spalten ohne Eingabe (Formel, Rollup …) bleiben. */
  const clearRange = (r: CellRange) => {
    // über `clip` lesen: wird auch aus dem Ausschneiden-Handler (einmal gebunden) aufgerufen
    const { visibleOrder: order, props: ps, locked: ro } = clip.current;
    const rect = rangeRect(r, order);
    if (!rect || ro) return;
    const edits = [];
    for (let i = rect.r0; i <= rect.r1; i++) for (let j = rect.c0; j <= rect.c1; j++) {
      const p = ps[j];
      if (p && pasteable(p)) edits.push({ rowID: order[i]!, propertyID: p.id, value: p.type === "checkbox" ? pv("checkbox", false) : null });
    }
    setValues(store, edits, "Clear cells");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // BSD-536: Der Editor öffnet gerade – Zeichen, die noch an der Tabelle selbst ankommen, gehören ins Feld.
    if (typeAhead.current !== null && e.target === e.currentTarget && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      typeAhead.current += e.key;
      return;
    }
    if (editing) return;
    if (!active) {
      if (e.target === e.currentTarget && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        setActive(firstCell());
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    // Bei ⇧ bewegt sich das freie Ende des Bereichs, sonst die aktive Zelle.
    const from = e.shiftKey && range ? range.head : active;
    const fi = rowIndex(from.rowID);
    const firstRow = nextRowIndex(items, -1, 1), lastRow = nextRowIndex(items, items.length, -1);
    const rowAt = (idx: number) => { const it = items[idx]; return it?.kind === "row" ? it.row.id : undefined; };
    const vertical = (target: number) => { const id = target >= 0 ? rowAt(target) : undefined; if (id) goTo({ rowID: id, col: from.col }, e.shiftKey); };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); vertical(mod ? lastRow : nextRowIndex(items, fi, 1)); break;
      case "ArrowUp": e.preventDefault(); vertical(mod ? firstRow : nextRowIndex(items, fi, -1)); break;
      case "ArrowRight": e.preventDefault(); goTo({ rowID: from.rowID, col: mod ? props.length - 1 : Math.min(props.length - 1, from.col + 1) }, e.shiftKey); break;
      case "ArrowLeft": e.preventDefault(); goTo({ rowID: from.rowID, col: mod ? 0 : Math.max(0, from.col - 1) }, e.shiftKey); break;
      case "Home": e.preventDefault(); if (mod) vertical(firstRow); else goTo({ rowID: from.rowID, col: 0 }, e.shiftKey); break;
      case "End": e.preventDefault(); if (mod) vertical(lastRow); else goTo({ rowID: from.rowID, col: props.length - 1 }, e.shiftKey); break;
      case "PageDown": case "PageUp": {
        e.preventDefault();
        const dir = e.key === "PageDown" ? 1 : -1;
        let n = fi;
        for (let k = 0; k < 10; k++) { const m = nextRowIndex(items, n, dir); if (m < 0) break; n = m; }
        vertical(n);
        break;
      }
      case "Enter": e.preventDefault(); setRange(null); beginEdit(active.rowID, active.col); break;
      // BSD-238: Tab/⇧Tab wandern durch die Zellen (am Rand weiter in die nächste Zeile, am Ende raus aus dem Raster).
      case "Tab": {
        if (mod || e.altKey) break;
        const next = tabFrom(active, e.shiftKey ? -1 : 1);
        if (next) { e.preventDefault(); goTo(next.cell, false); } else { setRange(null); setActive(null); }
        break;
      }
      // Leertaste öffnet die Zeile (Peek bzw. Seite), wie in Notion.
      case " ": if (onOpenPage && !mod) { e.preventDefault(); onOpenPage(active.rowID); } break;
      case "Escape": if (isMulti(range)) setRange(null); else setActive(null); break;
      // BSD-238: ⇧F10 / Menütaste öffnet das Zeilenmenü der aktiven Zeile.
      case "F10": case "ContextMenu": {
        if (e.key === "F10" && !e.shiftKey) break;
        const handle = gridRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(active.rowID)}"] .dbui-row-handle`);
        if (handle) { e.preventDefault(); handle.click(); }
        break;
      }
      case "Backspace": case "Delete": {
        e.preventDefault();
        if (isMulti(range)) { clearRange(range); break; }
        const p = props[active.col];
        if (p && !locked && isEditable(p.type)) setValue(store, active.rowID, p.id, null);
        break;
      }
      default: {
        if (mod && !e.altKey && e.key.toLowerCase() === "a" && !locked) {
          // ⌘A: alle Zeilen wählen (wie Notion), für Sammelaktionen
          e.preventDefault();
          setSelected(new Set(rowOrder));
          break;
        }
        const p = props[active.col];
        if (e.key.length === 1 && !mod && !e.altKey && p && ["title", "text", "number", "url", "email", "phone", "place"].includes(p.type)) {
          e.preventDefault();
          setRange(null);
          beginEdit(active.rowID, active.col, e.key);
        }
      }
    }
  };

  // ⌘C/⌘X/⌘V auf dem Raster: Kopieren/Einfügen von Zellen als TSV (verträgt sich mit Excel, Numbers, Sheets, Notion).
  // Das Raster hat keine Textauswahl – das Ereignis geht an body, also auf dem Dokument hören und den Fokus prüfen.
  const clip = useRef({ active, range, visibleOrder, props, locked });
  clip.current = { active, range, visibleOrder, props, locked };
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const doc = grid.ownerDocument;
    const rectNow = () => {
      const { active: a, range: r, visibleOrder: order } = clip.current;
      if (r && isMulti(r)) return rangeRect(r, order);
      if (!a) return undefined;
      const k = order.indexOf(a.rowID);
      return k < 0 ? undefined : { r0: k, r1: k, c0: a.col, c1: a.col };
    };
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (doc.activeElement !== grid || !e.clipboardData) return;
      const rect = rectNow();
      if (!rect) return;
      const { visibleOrder: order, props: ps } = clip.current;
      const table: string[][] = [];
      for (let r = rect.r0; r <= rect.r1; r++) {
        const row = store.blocks.get(order[r]!);
        if (!row) continue;
        const line: string[] = [];
        for (let c = rect.c0; c <= rect.c1; c++) { const p = ps[c]; line.push(p ? cellString(store, engine, db, row, p) : ""); }
        table.push(line);
      }
      e.preventDefault();
      e.clipboardData.setData("text/plain", encodeTSV(table));
      if (cut && !clip.current.locked) {
        const a = { rowID: order[rect.r0]!, col: rect.c0 }, b = { rowID: order[rect.r1]!, col: rect.c1 };
        clearRange({ anchor: a, head: b });
      }
    };
    const onCopy = (e: ClipboardEvent) => copy(e, false);
    const onCut = (e: ClipboardEvent) => copy(e, true);
    const onPaste = (e: ClipboardEvent) => {
      if (doc.activeElement !== grid || clip.current.locked) return;
      const text = e.clipboardData?.getData("text/plain");
      const rect = rectNow();
      if (!text || !rect) return;
      e.preventDefault();
      const grid_ = decodeTSV(text);
      setValues(store, planPaste(grid_, rect, clip.current.visibleOrder, clip.current.props), "Paste");
      // Eingefügten Bereich markieren (wie Tabellenprogramme)
      const single = grid_.length === 1 && grid_[0]!.length === 1;
      if (!single) {
        const order = clip.current.visibleOrder, ps = clip.current.props;
        const r1 = Math.min(order.length - 1, rect.r0 + grid_.length - 1);
        const c1 = Math.min(ps.length - 1, rect.c0 + Math.max(...grid_.map((r) => r.length)) - 1);
        if (r1 > rect.r0 || c1 > rect.c0) setRange({ anchor: { rowID: order[rect.r0]!, col: rect.c0 }, head: { rowID: order[r1]!, col: c1 } });
      }
    };
    doc.addEventListener("copy", onCopy);
    doc.addEventListener("cut", onCut);
    doc.addEventListener("paste", onPaste);
    return () => { doc.removeEventListener("copy", onCopy); doc.removeEventListener("cut", onCut); doc.removeEventListener("paste", onPaste); };
  // clearRange liest nur Store/Props über `clip`; neu binden, wenn sich Datenbank oder Store ändern
  }, [store, engine, db]);

  // Mit der Maus über Zellen ziehen wählt einen Bereich; ⇧-Klick erweitert vom aktiven Feld aus.
  const cellAt = (x: number, y: number): Active | null => {
    const el = gridRef.current?.ownerDocument.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell]");
    if (!el || !gridRef.current?.contains(el)) return null;
    const v = el.dataset.cell!, k = v.lastIndexOf(":");
    return { rowID: v.slice(0, k), col: Number(v.slice(k + 1)) };
  };
  const onGridPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, button, a, [contenteditable]")) return;
    const start = cellAt(e.clientX, e.clientY);
    if (!start) return;
    if (e.shiftKey && active) {
      e.preventDefault();
      suppressClick.current = true;
      setRange({ anchor: active, head: start });
      return;
    }
    const doc = e.currentTarget.ownerDocument;
    const scroller = scrollRef.current;
    let moved = false;
    let last = { x: e.clientX, y: e.clientY };
    let frame = 0;
    const update = () => {
      frame = 0;
      const c = cellAt(last.x, last.y);
      if (c && (moved || c.rowID !== start.rowID || c.col !== start.col)) {
        if (!moved) { moved = true; setActive(start); }
        setRange((r) => (r && r.head.rowID === c.rowID && r.head.col === c.col && r.anchor === start ? r : { anchor: start, head: c }));
      }
      // Am Rand des eigenen Scrollbereichs weiterrollen
      if (moved && scroller) {
        const b = scroller.getBoundingClientRect(), edge = 40;
        const dx = last.x > b.right - edge ? 12 : last.x < b.left + edge ? -12 : 0;
        const dy = last.y > b.bottom - edge && scroller.scrollHeight > scroller.clientHeight ? 12 : last.y < b.top + edge + ROW_HEIGHT && scroller.scrollTop > 0 ? -12 : 0;
        if (dx || dy) { scroller.scrollBy(dx, dy); frame = requestAnimationFrame(update); }
      }
    };
    const onMove = (ev: PointerEvent) => { last = { x: ev.clientX, y: ev.clientY }; if (!frame) frame = requestAnimationFrame(update); };
    const onUp = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      doc.removeEventListener("pointercancel", onUp);
      if (frame) cancelAnimationFrame(frame);
      // letzte Position sicher auswerten (schnelle Bewegung, rAF noch nicht gelaufen)
      last = { x: ev.clientX, y: ev.clientY };
      update();
      if (frame) cancelAnimationFrame(frame);
      if (moved) {
        // Der folgende Klick (falls er auf einer Zelle landet) öffnet keinen Editor.
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
      }
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
    doc.addEventListener("pointercancel", onUp);
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
  const rect = isMulti(range) ? rangeRect(range, visibleOrder) : undefined;
  const rangeOf = (rowID: string) => {
    if (!rect) return "";
    const k = visibleOrder.indexOf(rowID);
    return k >= rect.r0 && k <= rect.r1 ? `${rect.c0}:${rect.c1}` : "";
  };

  return (
    <div className="dbui-scroll" ref={scrollRef} data-testid="table-scroll" onKeyDown={(e) => { if (e.key === "Escape" && selected.size && !editing) { setSelected(new Set()); } }}>
      {selected.size > 0 && <SelectionBar ids={[...selected]} onClear={() => setSelected(new Set())} />}
      <div className="dbui-table" role="grid" aria-label={view.name} aria-rowcount={result.rows.length + 1} aria-colcount={props.length}
        aria-activedescendant={active && !editing ? activeCellID(active.rowID, active.col) : undefined}
        tabIndex={0} ref={gridRef} onKeyDown={onKeyDown} onPointerDown={onGridPointerDown} data-range={rect ? "" : undefined} onFocus={(e) => { if (e.target === e.currentTarget && !focusByPointer.current && !editing) setActive((a) => a ?? firstCell()); }}
        onMouseDown={(e) => {
          // BSD-372: Nativer Fokus beim Drücken würde die (sehr hohe) Tabelle „in Sicht“ rollen – WebKit verschiebt
          // dabei den Inhalt zwischen mousedown und click, der Klick traf die Zeile darüber. Fokus ohne Rollen.
          const t = e.target as HTMLElement;
          if (e.button !== 0 || t.closest("input, textarea, select, button, a, [contenteditable]")) return;
          e.preventDefault();
          if (document.activeElement !== e.currentTarget) { focusByPointer.current = true; e.currentTarget.focus({ preventScroll: true }); focusByPointer.current = false; }
        }} style={{ width: total, height: virtualizer.getTotalSize() + ROW_HEIGHT }}>
        <div className="dbui-thead" role="row" style={{ width: total }}>
          <div className="dbui-gutter" role="columnheader">
            {!locked && rowOrder.length > 0 && (
              <input type="checkbox" className={"dbui-row-check" + (selected.size ? " shown" : "")} tabIndex={-1} aria-label="Select all"
                checked={allSelected} ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(rowOrder))} />
            )}
          </div>
          {props.map((p, i) => <HeaderCell key={p.id} p={p} width={widths[i]!} view={view} onResize={resize(p.id)} />)}
          {!locked && <div className="dbui-contents" role="columnheader"><button type="button" className="dbui-th-add" aria-label="Add property" onClick={(e) => setAddProp(e.currentTarget)}><Icon name="plus" size={14} /></button></div>}
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
              <div key={vi.key} className="dbui-vrow new" role="row" style={style} data-index={vi.index}>
                <div className="dbui-contents" role="gridcell">
                  <button type="button" className="dbui-new-row" onClick={() => newRow(it.groupID)}><Icon name="plus" size={14} />New</button>
                </div>
              </div>
            );
          }
          if (it.kind !== "row") return null;
          return (
            <div key={vi.key} role="row" className={"dbui-vrow" + (wrap ? " wrap" : "") + (selected.has(it.row.id) ? " selected" : "")} aria-selected={selected.has(it.row.id) || undefined} style={style} data-index={vi.index} data-row-id={it.row.id}
              aria-rowindex={vi.index + 2} ref={wrap ? virtualizer.measureElement : undefined}>
              <TableRow row={it.row} from={from} to={to} lead={lead} props={props} widths={widths} activeCol={active?.rowID === it.row.id ? active.col : -1} range={rangeOf(it.row.id)} agent={isAgentEdit(it.row)} wrap={wrap}
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
      {/* BSD-444: Fuß liegt außerhalb des Grids – also keine Zeile, sondern eine benannte Gruppe */}
      <div className="dbui-tfoot" style={{ width: total }} role="group" aria-label="Calculations">
        <div className="dbui-gutter" />
        {props.map((p, i) => <CalcCell key={p.id} p={p} width={widths[i]!} view={view} rows={result.rows} />)}
      </div>
      {editing && editingRow && editingProp && (
        <CellEditor row={editingRow} prop={editingProp} anchor={editing.anchor} initialText={editing.initialText} typeAhead={typeAhead}
          onClose={() => { typeAhead.current = null; setEditing(null); gridRef.current?.focus({ preventScroll: true }); }}
          onTab={(dir) => {
            const next = tabFrom({ rowID: editing.rowID, col: editing.col }, dir);
            if (next) goTo(next.cell, false);
          }}
          onCommitNext={() => {
            setRange(null);
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
