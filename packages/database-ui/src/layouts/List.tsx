// BSD-155: Liste und Galerie – virtualisiert (Zeilen bzw. Kartenreihen), mit Gruppen und „+ New“.
import { cardKeys } from "../cardKeys.js";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { plainText, propertyOf, valueCase, type Block, type DatabaseView, type PropertySchema, type QueryResult } from "@based/core";
import { CellView } from "../cells/CellView.js";
import { CellEditor } from "../cells/CellEditor.js";
import { InlineView, useDB } from "../context.js";
import { flatten, galleryColumns, limitRows, type FlatItem } from "../logic/layout.js";
import { hrefOf, optionTone, storedFiles } from "../logic/values.js";
import { Icon, type Anchor } from "../ui.js";
import { CardBody, cardProperties, EmptyState, GroupHeader, groupProperty, RowMenu, useAddRow } from "./shared.js";

const LIST_ROW = 40;
const GROUP_ROW = 44;

const ListRow = memo(function ListRow({ row, props, agent, onMenu }: { row: Block; props: PropertySchema[]; agent: boolean; onMenu: (row: Block, el: HTMLElement) => void }) {
  const { db, onOpenPage } = useDB();
  const title = propertyOf(db, "title") ?? db.properties.find((p) => p.type === "title")!;
  return (
    <div className="dbui-list-row" role="listitem" data-row-id={row.id} onContextMenu={(e) => { e.preventDefault(); onMenu(row, e.currentTarget); }}>
      {agent ? <span className="dbui-agent-bar" role="img" aria-label="Changed by Based" /> : <span className="dbui-agent-bar off" aria-hidden />}
      <button type="button" className="dbui-list-title" onClick={() => onOpenPage?.(row.id)}><CellView row={row} prop={title} /></button>
      <span className="dbui-list-props">
        {props.map((p) => <span key={p.id} className="dbui-list-prop" title={p.name}><CellView row={row} prop={p} compact /></span>)}
      </span>
      <button type="button" className="dbui-row-handle" aria-label="Row actions" onClick={(e) => onMenu(row, e.currentTarget)}><Icon name="more" size={14} /></button>
    </div>
  );
});

function useMenus() {
  const [menu, setMenu] = useState<{ rowID: string; anchor: Anchor } | null>(null);
  const onMenu = useMemo(() => (row: Block, el: HTMLElement) => setMenu({ rowID: row.id, anchor: el }), []);
  return { menu, setMenu, onMenu };
}

function Virtual(props: {
  items: FlatItem[]; estimate: (it: FlatItem) => number; render: (it: FlatItem) => React.ReactNode; label: string; testID: string;
}) {
  // BSD-255 Teil 2: inline in einer Seite ohne eigenen Scroller – alles im Fluss der Seite, begrenzt mit „Load more“.
  const inline = useContext(InlineView);
  return inline ? <Flow {...props} pageSize={inline.pageSize} /> : <Scrolled {...props} />;
}

function Flow({ items: all, render, label, testID, pageSize }: { items: FlatItem[]; render: (it: FlatItem) => React.ReactNode; label: string; testID: string; pageSize: number }) {
  const [limit, setLimit] = useState(pageSize);
  const { items, hidden } = useMemo(() => limitRows(all, limit), [all, limit]);
  return (
    <div className="dbui-flow" data-testid={testID}>
      <div className="dbui-vlist static" role="list" aria-label={label} onKeyDown={cardKeys}>
        {items.map((it) => <div key={it.key} className="dbui-vitem static">{render(it)}</div>)}
      </div>
      {hidden > 0 ? (
        <button type="button" className="dbui-load-more" onClick={() => setLimit((l) => l + pageSize)}>
          Load more <span className="dbui-count">{Math.min(hidden, pageSize)} of {hidden}</span>
        </button>
      ) : null}
    </div>
  );
}

function Scrolled({ items, estimate, render, label, testID }: {
  items: FlatItem[]; estimate: (it: FlatItem) => number; render: (it: FlatItem) => React.ReactNode; label: string; testID: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(items[i]!),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 6,
  });
  return (
    <div className="dbui-scroll" ref={scrollRef} data-testid={testID}>
      <div className="dbui-vlist" role="list" aria-label={label} style={{ height: virtualizer.getTotalSize() }} onKeyDown={cardKeys}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div key={vi.key} className="dbui-vitem" data-index={vi.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${vi.start}px)` }}>
            {render(items[vi.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}

function useGroups(result: QueryResult, locked: boolean, columns?: number) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const items = useMemo(() => flatten(result, { collapsed, newRow: !locked, ...(columns ? { columns } : {}) }), [result, collapsed, locked, columns]);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { items, toggle };
}

export function ListLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { store, db, locked, isAgentEdit } = useDB();
  const props = useMemo(() => cardProperties(view, db), [view, db]);
  const { items, toggle } = useGroups(result, locked);
  const { menu, setMenu, onMenu } = useMenus();
  const addRow = useAddRow(view);
  const gp = groupProperty(db, view);
  const menuRow = menu ? store.blocks.get(menu.rowID) : undefined;
  return (
    <>
      <Virtual items={items} label={view.name} testID="list-scroll" estimate={(it) => (it.kind === "group" ? GROUP_ROW : LIST_ROW)} render={(it) => {
        if (it.kind === "group") return <GroupHeader group={it.group} prop={gp} collapsed={it.collapsed} onToggle={() => toggle(it.group.id)} />;
        if (it.kind === "new") return <button type="button" className="dbui-new-row" onClick={() => addRow(it.groupID)}><Icon name="plus" size={14} />New</button>;
        if (it.kind === "row") return <ListRow row={it.row} props={props} agent={isAgentEdit(it.row)} onMenu={onMenu} />;
        return null;
      }} />
      {result.rows.length === 0 && <EmptyState>No pages.</EmptyState>}
      {menu && menuRow && <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Vorschau oben auf der Karte: Seiteninhalt, Icon, Cover oder Bild aus einer Files-Property. */
function Cover({ row, view }: { row: Block; view: DatabaseView }) {
  const { store, db } = useDB();
  const c = valueCase(view.cardCover as never);
  const kind = c?.[0] ?? (view.type === "gallery" ? "pageContent" : "none");
  if (kind === "none") return null;
  if (kind === "property") {
    const p = propertyOf(db, String(c?.[1]));
    const f = p ? storedFiles(row, p).find((x) => x.url) : undefined;
    return <div className="dbui-cover">{f?.url ? <img src={hrefOf(f.url)} alt="" loading="lazy" /> : null}</div>;
  }
  if (kind === "pageIcon") {
    const icon = row.props?.icon;
    const e = typeof icon === "string" ? icon : icon?.emoji;
    return <div className="dbui-cover icon">{e ?? <Icon name="file" size={28} />}</div>;
  }
  if (kind === "pageCover") {
    const cover = valueCase(row.props?.cover as never);
    const url = cover?.[0] === "url" ? String(cover[1]) : undefined;
    return <div className={"dbui-cover" + (cover?.[0] === "color" ? ` tone-${optionTone(String(cover[1]))}` : "")}>{url ? <img src={hrefOf(url)} alt="" loading="lazy" /> : null}</div>;
  }
  const text = store.children("b:" + row.id).slice(0, 6).map((id) => plainText(store.blocks.get(id)?.text)).filter(Boolean).join("\n");
  return <div className="dbui-cover content">{text}</div>;
}

const CARD_HEIGHT: Record<string, number> = { small: 180, medium: 220, large: 280 };

export function GalleryLayout({ view, result }: { view: DatabaseView; result: QueryResult }) {
  const { store, db, locked, isAgentEdit } = useDB();
  const props = useMemo(() => cardProperties(view, db), [view, db]);
  const outer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 48));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = galleryColumns(width, view.cardSize);
  const { items, toggle } = useGroups(result, locked, columns);
  const { menu, setMenu, onMenu } = useMenus();
  const [editing, setEditing] = useState<{ rowID: string; anchor: Anchor } | null>(null);
  const addRow = useAddRow(view);
  const gp = groupProperty(db, view);
  const menuRow = menu ? store.blocks.get(menu.rowID) : undefined;
  const editRow = editing ? store.blocks.get(editing.rowID) : undefined;
  const title = db.properties.find((p) => p.type === "title") ?? { id: "title", name: "Name", type: "title" };
  return (
    <div className="dbui-gallery-wrap" ref={outer} onKeyDown={cardKeys}>
      <Virtual items={items} label={view.name} testID="gallery-scroll" estimate={(it) => (it.kind === "cards" ? (CARD_HEIGHT[view.cardSize ?? "medium"] ?? 220) + 16 : GROUP_ROW)} render={(it) => {
        if (it.kind === "group") return <GroupHeader group={it.group} prop={gp} collapsed={it.collapsed} onToggle={() => toggle(it.group.id)} />;
        if (it.kind === "new") return <button type="button" className="dbui-new-row" onClick={() => addRow(it.groupID)}><Icon name="plus" size={14} />New</button>;
        if (it.kind !== "cards") return null;
        return (
          <div className="dbui-gallery-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {it.rows.map((row) => (
              <div key={row.id} className={"dbui-card gallery size-" + (view.cardSize ?? "medium")} data-row-id={row.id} role="listitem"
                onContextMenu={(e) => { e.preventDefault(); onMenu(row, e.currentTarget); }}>
                {isAgentEdit(row) ? <span className="dbui-card-bar changed" role="img" aria-label="Changed by Based" /> : <span className="dbui-card-bar" aria-hidden />}
                <Cover row={row} view={view} />
                <div className="dbui-card-text">
                  <CardBody row={row} props={props} onEditTitle={() => { const el = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"]`); if (el) setEditing({ rowID: row.id, anchor: el }); }} />
                </div>
                <button type="button" className="dbui-card-menu" aria-label="Card actions" onClick={(e) => onMenu(row, e.currentTarget)}><Icon name="more" size={14} /></button>
              </div>
            ))}
          </div>
        );
      }} />
      {result.rows.length === 0 && <EmptyState>No pages.</EmptyState>}
      {menu && menuRow && <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {editing && editRow && <CellEditor row={editRow} prop={title} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}
