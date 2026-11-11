// BSD-155: Board – Spalten als Flächen (surface-raised, Radius 18), jede Spalte virtualisiert und für sich
// scrollbar; Karten per Drag & Drop in andere Spalten bzw. an andere Stellen (moveRowToGroup, ein Undo-Schritt).
import { memo, useContext, useMemo, useRef, useState, type DragEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { moveRowToGroup, setGroupHidden, type Block, type DatabaseView, type PropertySchema, type QueryResult, type RowGroup } from "@based/core";
import { CellEditor } from "../cells/CellEditor.js";
import { InlineView, useDB } from "../context.js";
import { Icon, OptionPill, type Anchor } from "../ui.js";
import { cardKeys } from "../cardKeys.js";
import { CardBody, cardProperties, EmptyState, groupProperty, RowMenu, useAddRow } from "./shared.js";

const CARD_ESTIMATE = 72;
const CARD_GAP = 8;
const DRAG_TYPE = "application/x-based-row";

let dragging: { rowID: string; from: string } | null = null;

const Card = memo(function Card({ row, props, agent, draggable, groupID, onMenu, onEditTitle }: {
  row: Block; props: PropertySchema[]; agent: boolean; draggable: boolean; groupID: string;
  onMenu: (row: Block, el: HTMLElement) => void; onEditTitle: (row: Block, el: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="dbui-card" data-row-id={row.id} draggable={draggable} role="listitem"
      onDragStart={(e) => { dragging = { rowID: row.id, from: groupID }; e.dataTransfer.setData(DRAG_TYPE, row.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => { dragging = null; }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(row, e.currentTarget); }}>
      {agent ? <span className="dbui-card-bar changed" role="img" aria-label="Changed by Based" /> : <span className="dbui-card-bar" aria-hidden />}
      <CardBody row={row} props={props} onEditTitle={() => ref.current && onEditTitle(row, ref.current)} />
      <button type="button" className="dbui-card-menu" aria-label="Card actions" onClick={(e) => onMenu(row, e.currentTarget)}><Icon name="more" size={14} /></button>
    </div>
  );
});

function Column({ group, gp, view, props, onMenu, onEditTitle }: {
  group: RowGroup; gp: PropertySchema; view: DatabaseView; props: PropertySchema[];
  onMenu: (row: Block, el: HTMLElement) => void; onEditTitle: (row: Block, el: HTMLElement) => void;
}) {
  const { store, locked, isAgentEdit } = useDB();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ before: string | null } | null>(null);
  const addRow = useAddRow(view);
  // BSD-255 Teil 2: inline wächst die Spalte mit der Seite (kein eigener Scroller), „Load more“ je Spalte.
  const inline = useContext(InlineView);
  const [limit, setLimit] = useState(inline?.pageSize ?? Infinity);
  const rows = inline ? group.rows.slice(0, limit) : group.rows;
  const hiddenCards = group.rows.length - rows.length;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    getItemKey: (i) => rows[i]?.id ?? i,
    gap: CARD_GAP,
    overscan: 6,
  });
  const sorted = (view.sorts?.length ?? 0) > 0;
  const isOption = ["select", "status", "multiSelect"].includes(gp.type) && group.id !== "";

  const target = (e: DragEvent<HTMLElement>): { before: string | null } => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    if (!card || !scrollRef.current?.contains(card)) return { before: null };
    const r = card.getBoundingClientRect();
    const id = card.dataset.rowId!;
    if (e.clientY < r.top + r.height / 2) return { before: id };
    const i = rows.findIndex((x) => x.id === id);
    return { before: rows[i + 1]?.id ?? null };
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (locked || !dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const t = target(e);
    if (t.before !== drop?.before || !drop) setDrop(t);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    const d = dragging;
    const t = target(e);
    setDrop(null);
    dragging = null;
    if (!d || locked) return;
    const last = rows[rows.length - 1];
    const position = sorted ? undefined : t.before ? { before: t.before } : last && last.id !== d.rowID ? { after: last.id } : undefined;
    moveRowToGroup(store, d.rowID, gp.id, d.from, group.id, position);
  };

  return (
    <section className={"dbui-board-col" + (drop ? " drop" : "")} aria-label={group.title} data-group-id={group.id}
      onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }} onDrop={onDrop}>
      <header className="dbui-board-head">
        {isOption ? <OptionPill name={group.title} color={group.color} status={gp.type === "status"} /> : <span className="dbui-group-title">{group.title}</span>}
        <span className="dbui-count">{group.rows.length}</span>
        {!locked && <button type="button" className="dbui-icon-btn" aria-label={`Hide ${group.title}`} onClick={() => setGroupHidden(store, view.id, group.id, true)}><Icon name="eyeOff" size={14} /></button>}
        {!locked && <button type="button" className="dbui-icon-btn" aria-label={`New in ${group.title}`} onClick={() => addRow(group.id)}><Icon name="plus" size={14} /></button>}
      </header>
      <div className="dbui-board-scroll" ref={scrollRef} role="list" aria-label={`${group.title} cards`}>
        {inline ? (
          <div className="dbui-board-inner static">
            {rows.map((row) => (
              <div key={row.id} className={"dbui-card-slot static" + (drop?.before === row.id ? " drop-before" : "")}>
                <Card row={row} props={props} agent={isAgentEdit(row)} draggable={!locked} groupID={group.id} onMenu={onMenu} onEditTitle={onEditTitle} />
              </div>
            ))}
          </div>
        ) : (
        <div className="dbui-board-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            return (
              <div key={vi.key} className={"dbui-card-slot" + (drop?.before === row.id ? " drop-before" : "")} data-index={vi.index} ref={virtualizer.measureElement}
                style={{ transform: `translateY(${vi.start}px)` }}>
                <Card row={row} props={props} agent={isAgentEdit(row)} draggable={!locked} groupID={group.id} onMenu={onMenu} onEditTitle={onEditTitle} />
              </div>
            );
          })}
        </div>
        )}
        {drop && drop.before === null && <div className="dbui-drop-end" aria-hidden />}
      </div>
      {hiddenCards > 0 ? (
        <button type="button" className="dbui-load-more" onClick={() => setLimit((l) => l + (inline?.pageSize ?? 25))}>
          Load more <span className="dbui-count">{Math.min(hiddenCards, inline?.pageSize ?? 25)} of {hiddenCards}</span>
        </button>
      ) : null}
      {!locked && <button type="button" className="dbui-new-row" onClick={() => addRow(group.id)}><Icon name="plus" size={14} />New</button>}
    </section>
  );
}

export function BoardLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { store, db, locked } = useDB();
  const gp = groupProperty(db, view);
  const props = useMemo(() => cardProperties(view, db), [view, db]);
  const [menu, setMenu] = useState<{ rowID: string; anchor: Anchor } | null>(null);
  const [editing, setEditing] = useState<{ rowID: string; anchor: Anchor } | null>(null);
  const onMenu = useMemo(() => (row: Block, el: HTMLElement) => setMenu({ rowID: row.id, anchor: el }), []);
  const onEditTitle = useMemo(() => (row: Block, el: HTMLElement) => setEditing({ rowID: row.id, anchor: el }), []);
  if (!gp || !result.groups) return <EmptyState>Group this board by a Status or Select property (View settings → Group by).</EmptyState>;
  const hidden = view.groupBy?.hiddenGroups ?? [];
  const hiddenNames = hidden.map((id) => ({ id, name: id === "" ? `No ${gp.name}` : gp.options?.find((o) => o.id === id)?.name ?? id }));
  const menuRow = menu ? store.blocks.get(menu.rowID) : undefined;
  const editRow = editing ? store.blocks.get(editing.rowID) : undefined;
  const title = db.properties.find((p) => p.type === "title") ?? { id: "title", name: "Name", type: "title" };
  return (
    <div className="dbui-board" data-testid="board" onKeyDown={cardKeys}>
      {result.groups.map((g) => <Column key={g.id} group={g} gp={gp} view={view} props={props} onMenu={onMenu} onEditTitle={onEditTitle} />)}
      {hiddenNames.length > 0 && (
        <section className="dbui-board-hidden" aria-label="Hidden groups">
          <span className="dbui-field-label">Hidden groups</span>
          {hiddenNames.map((h) => (
            <button key={h.id} type="button" className="dbui-btn ghost small" disabled={locked} onClick={() => setGroupHidden(store, view.id, h.id, false)}>
              <Icon name="eye" size={14} />{h.name}
            </button>
          ))}
        </section>
      )}
      {menu && menuRow && <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {editing && editRow && <CellEditor row={editRow} prop={title} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}
