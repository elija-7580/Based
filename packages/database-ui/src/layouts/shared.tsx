// BSD-155: Gemeinsames der Layouts: Zeilenmenü, neue Zeile (mit Gruppen- und Filterwerten), Gruppenkopf,
// Agent-Strich, Kartenfelder.
import { memo, useState } from "react";
import {
  addRow, deleteRows, duplicateRow, propertyOf, setValue, pv, valueCase, valueForGroup, visiblePropertyIDs,
  type Block, type Database, type DatabaseView, type PropertySchema, type PropertyValue, type RowGroup,
} from "@based/core";
import { CellView } from "../cells/CellView.js";
import { useDB } from "../context.js";
import { conditionOf } from "../logic/filters.js";
import { Icon, MenuItem, MenuSeparator, OptionPill, Popover, type Anchor } from "../ui.js";

/** Werte einer neuen Zeile: Gruppe, in der sie entsteht, und eindeutige „ist“-Filter (damit sie sichtbar bleibt). */
export function newRowValues(db: Database, view: DatabaseView, groupProp: PropertySchema | undefined, groupID: string | null): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  const f = view.filter;
  if (f && f.combinator === "and") {
    for (const item of f.items) {
      const c = conditionOf(item);
      const p = c && propertyOf(db, c.propertyID);
      const v = valueCase(c?.value as never);
      if (!c || !p || !v || (c.op !== "equals" && c.op !== "contains")) continue;
      if ((p.type === "select" || p.type === "status") && v[0] === "options" && (v[1] as string[]).length === 1) out[p.id] = pv(p.type, (v[1] as string[])[0]);
      else if (p.type === "multiSelect" && v[0] === "options" && (v[1] as string[]).length >= 1) out[p.id] = pv("multiSelect", [(v[1] as string[])[0]]);
      else if (p.type === "checkbox" && v[0] === "bool") out[p.id] = pv("checkbox", v[1]);
      else if (["text", "url", "email", "phone"].includes(p.type) && v[0] === "text" && c.op === "equals") out[p.id] = pv(p.type, v[1]);
    }
  }
  if (groupProp && groupID !== null && groupProp.type !== "title") {
    const v = valueForGroup({ id: "", type: "page", parent: "", sk: "", createdAt: 0, updatedAt: 0 }, groupProp, undefined, groupID);
    if (v) out[groupProp.id] = v;
    else if (v === null) delete out[groupProp.id];
  }
  return out;
}

/** Property, nach der eine Ansicht gruppiert (auch die implizite Status-Gruppe eines Boards). */
export function groupProperty(db: Database, view: DatabaseView): PropertySchema | undefined {
  if (view.groupBy) return propertyOf(db, view.groupBy.propertyID);
  if (view.type === "board") return db.properties.find((p) => p.type === "status" || p.type === "select");
  return undefined;
}

/** Neue Zeile anlegen; gibt die ID zurück. */
export function useAddRow(view: DatabaseView) {
  const { store, db } = useDB();
  return (groupID: string | null, position?: { before: string } | { after: string }) =>
    addRow(store, db.id, { values: newRowValues(db, view, groupProperty(db, view), groupID), ...(position ? { position } : {}) });
}

export function RowMenu({ row, anchor, onClose }: { row: Block; anchor: Anchor; onClose: () => void }) {
  const { store, onOpenPage, locked } = useDB();
  return (
    <Popover anchor={anchor} onClose={onClose} role="menu" label="Row actions">
      {onOpenPage && <MenuItem icon={<Icon name="open" />} onClick={() => { onClose(); onOpenPage(row.id); }}>Open</MenuItem>}
      {!locked && (
        <>
          <MenuItem icon={<Icon name="copy" />} onClick={() => { duplicateRow(store, row.id); onClose(); }}>Duplicate</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Icon name="trash" />} danger onClick={() => { deleteRows(store, [row.id]); onClose(); }} testID="row-delete">Delete</MenuItem>
        </>
      )}
    </Popover>
  );
}

/** Kopf einer Gruppe (Tabelle, Liste, Galerie): Auf/Zu, Name als Pille, Anzahl. */
export function GroupHeader({ group, prop, collapsed, onToggle }: { group: RowGroup; prop: PropertySchema | undefined; collapsed: boolean; onToggle: () => void }) {
  const isOption = prop && ["select", "status", "multiSelect"].includes(prop.type) && group.id !== "";
  return (
    <div className="dbui-group-head" role="row" aria-expanded={!collapsed}>
      <button type="button" className="dbui-icon-btn" aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.title}`} onClick={onToggle}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
      </button>
      {isOption ? <OptionPill name={group.title} color={group.color} status={prop?.type === "status"} /> : <span className="dbui-group-title">{group.title}</span>}
      <span className="dbui-count">{group.rows.length}</span>
    </div>
  );
}

/** Kartenfelder (Board, Galerie): sichtbare Properties außer Titel, nur nicht-leere. */
export function cardProperties(view: DatabaseView, db: Database): PropertySchema[] {
  return visiblePropertyIDs(view, db).flatMap((id) => {
    const p = propertyOf(db, id);
    return p && p.type !== "title" ? [p] : [];
  });
}

function hasValue(row: Block, p: PropertySchema): boolean {
  if (["formula", "rollup", "createdTime", "lastEditedTime", "createdBy", "lastEditedBy", "button"].includes(p.type)) return true;
  return row.values?.[p.id] !== undefined;
}

/** Inhalt einer Karte: Titel und Felder; Klick auf den Titel öffnet die Seite. */
export const CardBody = memo(function CardBody({ row, props, onEditTitle }: { row: Block; props: PropertySchema[]; onEditTitle?: () => void }) {
  const { store, db, onOpenPage, locked } = useDB();
  const title = propertyOf(db, "title") ?? db.properties.find((p) => p.type === "title")!;
  return (
    <>
      <div className="dbui-card-title">
        <button type="button" className="dbui-card-open" onClick={() => (onOpenPage ? onOpenPage(row.id) : !locked && onEditTitle?.())} onDoubleClick={() => !locked && onEditTitle?.()}>
          <CellView row={row} prop={title} wrap />
        </button>
      </div>
      {props.filter((p) => hasValue(row, p)).map((p) => (
        <div key={p.id} className="dbui-card-field" title={p.name}>
          <CellView row={row} prop={p} compact onToggleCheckbox={() => {
            const c = valueCase(row.values?.[p.id]);
            setValue(store, row.id, p.id, pv("checkbox", !(c?.[0] === "checkbox" && c[1] === true)));
          }} />
        </div>
      ))}
    </>
  );
});

/** Zustand „welche Zeile hat ein offenes Menü“. */
export function useRowMenu() {
  const [menu, setMenu] = useState<{ rowID: string; anchor: Anchor } | null>(null);
  return [menu, setMenu] as const;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="dbui-empty" role="status">{children}</div>;
}
