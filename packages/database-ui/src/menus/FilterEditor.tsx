// BSD-155: Filter bearbeiten – Bedingungen und verschachtelte Gruppen mit und/oder, Operatoren nach Typ
// (Formeln/Rollups nach Ergebnistyp, BSD-9), Wertfelder je Art. Schreibt über setFilter (ein Undo-Schritt).
import { useState } from "react";
import {
  FILTER_OP_LABELS, RELATIVE_DATE_LABELS, filterOps, propertyOf, setFilter,
  type DatabaseView, type FilterCondition, type FilterGroup, type PropertySchema,
} from "@based/core";
import { useDB } from "../context.js";
import {
  EMPTY_FILTER, addItem, conditionItem, conditionOf, groupItem, groupOf, newCondition, removeItem, replaceItem, setCombinator, valueKind,
  type Path,
} from "../logic/filters.js";
import { fromInputValue, toInputValue } from "../logic/values.js";
import { Icon, OptionPill, Popover, type Anchor } from "../ui.js";

type Case = [string, unknown];
const caseOf = (v: unknown): Case | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const k = Object.keys(v);
  const inner = (v as Record<string, unknown>)[k[0]!];
  return k.length === 1 ? [k[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined] : undefined;
};

export function useResultType() {
  const { engine, db } = useDB();
  return (p: PropertySchema | undefined) => (p && (p.type === "formula" || p.type === "rollup") ? engine.resultType(db, p) : undefined);
}

function ValueField({ cond, prop, onChange }: { cond: FilterCondition; prop: PropertySchema | undefined; onChange: (value: unknown) => void }) {
  const resultType = useResultType()(prop);
  const kind = valueKind(prop, cond.op, resultType);
  const v = caseOf(cond.value);
  switch (kind) {
    case "none": return null;
    case "checkbox":
      return (
        <select className="dbui-select" aria-label="Value" value={v?.[1] === false ? "false" : "true"} onChange={(e) => onChange({ bool: { _0: e.target.value === "true" } })}>
          <option value="true">Checked</option><option value="false">Unchecked</option>
        </select>
      );
    case "number":
      return <input className="dbui-input" aria-label="Value" inputMode="decimal" defaultValue={v?.[0] === "number" ? String(v[1]) : ""}
        onChange={(e) => { const n = Number(e.target.value.replaceAll(",", "")); if (e.target.value.trim() === "") onChange(undefined); else if (Number.isFinite(n)) onChange({ number: { _0: n } }); }} />;
    case "date": {
      const rel = v?.[0] === "relative" ? (v[1] as string) : v?.[0] === "date" ? "exact" : "";
      return (
        <span className="dbui-inline">
          <select className="dbui-select" aria-label="Date" value={rel} onChange={(e) => {
            const x = e.target.value;
            if (x === "exact") onChange({ date: { _0: fromInputValue(toInputValue(Date.now() / 1000 - 978_307_200, false))! } });
            else if (x) onChange({ relative: { _0: x } });
            else onChange(undefined);
          }}>
            <option value="">Choose…</option>
            {Object.entries(RELATIVE_DATE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            <option value="exact">Exact date</option>
          </select>
          {v?.[0] === "date" && <input className="dbui-input" type="date" aria-label="Exact date" value={toInputValue(v[1] as number, false)}
            onChange={(e) => { const s = fromInputValue(e.target.value); if (s !== undefined) onChange({ date: { _0: s } }); }} />}
        </span>
      );
    }
    case "options": {
      const ids = v?.[0] === "options" ? (v[1] as string[]) : [];
      const toggle = (id: string) => { const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]; onChange(next.length ? { options: { _0: next } } : undefined); };
      return (
        <div className="dbui-option-choices" role="group" aria-label="Options">
          {(prop?.options ?? []).map((o) => (
            <button key={o.id} type="button" className="dbui-choice" aria-pressed={ids.includes(o.id)} onClick={() => toggle(o.id)}>
              <OptionPill name={o.name} color={o.color} status={prop?.type === "status"} />
            </button>
          ))}
        </div>
      );
    }
    default: {
      const text = v?.[0] === "text" ? String(v[1]) : v?.[0] === "options" ? (v[1] as string[]).join(", ") : "";
      return <input className="dbui-input" aria-label="Value" defaultValue={text} placeholder="Value"
        onChange={(e) => onChange(e.target.value ? (kind === "people" || kind === "relation" ? { options: { _0: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } } : { text: { _0: e.target.value } }) : undefined)} />;
    }
  }
}

function ConditionRow({ cond, path, root, onSave }: { cond: FilterCondition; path: Path; root: FilterGroup; onSave: (g: FilterGroup) => void }) {
  const { db } = useDB();
  const rt = useResultType();
  const prop = propertyOf(db, cond.propertyID);
  const ops = prop ? filterOps(prop.type, rt(prop)) : ["isEmpty", "isNotEmpty"];
  const put = (c: FilterCondition) => onSave(replaceItem(root, path, conditionItem(c)));
  return (
    <div className="dbui-filter-row" data-testid="filter-condition">
      <select className="dbui-select" aria-label="Property" value={cond.propertyID} onChange={(e) => {
        const p = propertyOf(db, e.target.value);
        if (p) put({ ...newCondition(p, rt(p)), id: cond.id });
      }}>
        {!prop && <option value={cond.propertyID}>Deleted property</option>}
        {db.properties.filter((p) => p.type !== "button").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select className="dbui-select" aria-label="Operator" value={cond.op} onChange={(e) => {
        const next: FilterCondition = { ...cond, op: e.target.value };
        const before = valueKind(prop, cond.op, rt(prop)), after = valueKind(prop, next.op, rt(prop));
        if (after === "none" || before !== after) delete next.value;
        if (after === "checkbox" && next.value === undefined) next.value = { bool: { _0: true } };
        put(next);
      }}>
        {ops.map((op) => <option key={op} value={op}>{FILTER_OP_LABELS[op] ?? op}</option>)}
      </select>
      <ValueField key={cond.propertyID + ":" + cond.op} cond={cond} prop={prop} onChange={(value) => { const next = { ...cond } as FilterCondition; if (value === undefined) delete next.value; else next.value = value as FilterCondition["value"]; put(next); }} />
      <button type="button" className="dbui-icon-btn" aria-label="Remove filter" onClick={() => onSave(removeItem(root, path))}><Icon name="trash" size={14} /></button>
    </div>
  );
}

function GroupEditor({ group, path, root, onSave, depth }: { group: FilterGroup; path: Path; root: FilterGroup; onSave: (g: FilterGroup) => void; depth: number }) {
  const { db } = useDB();
  const rt = useResultType();
  const first = db.properties.find((p) => p.type !== "button")!;
  return (
    <div className={"dbui-filter-group" + (depth > 0 ? " nested" : "")}>
      {group.items.map((item, i) => {
        const c = conditionOf(item), g = groupOf(item);
        return (
          <div key={c?.id ?? i} className="dbui-filter-line">
            <span className="dbui-filter-join">
              {i === 0 ? "Where" : i === 1 ? (
                <select className="dbui-select small" aria-label="Combine" value={group.combinator} onChange={(e) => onSave(setCombinator(root, path, e.target.value as "and" | "or"))}>
                  <option value="and">and</option><option value="or">or</option>
                </select>
              ) : group.combinator}
            </span>
            {c ? <ConditionRow cond={c} path={[...path, i]} root={root} onSave={onSave} />
              : g ? <GroupEditor group={g} path={[...path, i]} root={root} onSave={onSave} depth={depth + 1} />
              : <span className="dbui-hint">Filter from a newer version</span>}
          </div>
        );
      })}
      <div className="dbui-row-actions">
        <button type="button" className="dbui-btn ghost" onClick={() => onSave(addItem(root, path, conditionItem(newCondition(first, rt(first)))))}><Icon name="plus" size={14} />Add filter rule</button>
        {depth === 0 && (
          <button type="button" className="dbui-btn ghost" onClick={() => onSave(addItem(root, path, groupItem({ combinator: "and", items: [conditionItem(newCondition(first, rt(first)))] })))}>
            <Icon name="plus" size={14} />Add filter group
          </button>
        )}
      </div>
    </div>
  );
}

/** Popover mit allen Filtern einer Ansicht. */
export function FilterEditor({ view, anchor, onClose }: { view: DatabaseView; anchor: Anchor; onClose: () => void }) {
  const { store } = useDB();
  // Eingaben laufen lokal und werden sofort gespeichert (Undo-Schritt je Änderung).
  const [draft, setDraft] = useState<FilterGroup>(view.filter ?? EMPTY_FILTER);
  const save = (g: FilterGroup) => { setDraft(g); setFilter(store, view.id, g); };
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-filter-editor" label="Filters">
      <GroupEditor group={draft} path={[]} root={draft} onSave={save} depth={0} />
      {draft.items.length > 0 && <button type="button" className="dbui-btn ghost danger" onClick={() => save(EMPTY_FILTER)}>Delete all filters</button>}
    </Popover>
  );
}
