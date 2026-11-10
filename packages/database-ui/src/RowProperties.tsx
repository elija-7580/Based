// Property-Liste einer Zeile (Seitenkopf im Peek): Name links, Wert rechts; Klick öffnet den Zellen-Editor.
// Läuft im DBContext der Datenbank.
import { useState } from "react";
import { pv, setValue, valueCase, type Block, type PropertySchema } from "@based/core";
import { CellEditor, isEditable } from "./cells/CellEditor.js";
import { CellView } from "./cells/CellView.js";
import { useDB } from "./context.js";
import { Icon, PROPERTY_ICONS } from "./ui.js";

const COMPUTED = new Set(["formula", "rollup", "createdTime", "lastEditedTime", "createdBy", "lastEditedBy", "uniqueID"]);

function isEmptyCell(row: Block, p: PropertySchema): boolean {
  if (COMPUTED.has(p.type) || p.type === "checkbox") return false;
  const c = valueCase(row.values?.[p.id]);
  if (!c) return true;
  return Array.isArray(c[1]) ? c[1].length === 0 : c[1] === "";
}

export function RowProperties({ rowID }: { rowID: string }) {
  const { store, db, locked } = useDB();
  const row = store.blocks.get(rowID);
  const [editing, setEditing] = useState<{ propID: string; anchor: HTMLElement } | null>(null);
  if (!row) return null;
  const props = db.properties.filter((p) => p.type !== "title" && p.type !== "button" && p.type !== "verification");
  const editingProp = editing ? props.find((p) => p.id === editing.propID) : undefined;
  const toggle = (p: PropertySchema) => {
    const c = valueCase(row.values?.[p.id]);
    setValue(store, row.id, p.id, pv("checkbox", !(c?.[0] === "checkbox" && c[1] === true)));
  };
  return (
    <div className="dbui-rowprops" role="list" aria-label="Properties" data-testid="row-properties">
      {props.map((p) => {
        const canEdit = !locked && isEditable(p.type);
        const open = (el: HTMLElement) => setEditing({ propID: p.id, anchor: el });
        return (
          <div key={p.id} className="dbui-rowprop" role="listitem">
            <span className="dbui-rowprop-name" title={p.description ?? p.name}><Icon name={PROPERTY_ICONS[p.type] ?? "text"} size={14} /><span className="dbui-clip">{p.name}</span></span>
            <div className={"dbui-rowprop-value" + (canEdit ? " editable" : "")} {...(canEdit ? {
              role: "button", tabIndex: 0, "aria-label": `Edit ${p.name}`,
              onClick: (e: React.MouseEvent<HTMLElement>) => { if (!(e.target as HTMLElement).closest("a")) open(e.currentTarget); },
              onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(e.currentTarget); } },
            } : {})}>
              {isEmptyCell(row, p)
                ? <span className="dbui-hint">Empty</span>
                : <CellView row={row} prop={p} wrap {...(!locked && p.type === "checkbox" ? { onToggleCheckbox: () => toggle(p) } : {})} />}
            </div>
          </div>
        );
      })}
      {editing && editingProp && <CellEditor row={row} prop={editingProp} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}
