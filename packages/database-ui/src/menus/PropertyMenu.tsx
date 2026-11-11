// BSD-155: Menü einer Property (Spaltenkopf): umbenennen, Typ ändern (mit Verlust-Warnung über
// conversionLoss), Einstellungen je Typ (Optionen, Zahlformat, Formel, Relation, Rollup, Datum, ID),
// sortieren, filtern, gruppieren, verstecken, duplizieren, löschen.
import { useContext, useRef, useState } from "react";
import {
  ADDABLE_PROPERTY_TYPES, CALCULATION_LABELS, ENUMS, NUMBER_FORMAT_LABELS, NUMBER_FORMATS, PROPERTY_TYPE_LABELS, addOption, addProperty,
  changePropertyType, conversionLoss, deleteOption, deleteProperty, duplicateProperty, filledCellCount, makeRelationTwoWay, plainText,
  relationLimitViolations, renameProperty, setFilter, setGroupBy, setPropertyVisible, setRelationLimitOne, setRelationTarget, setRollup,
  setSorts, titleOf, updateOption, updateProperty, wouldCreateRollupCycle,
  type DatabaseView, type PropertySchema,
} from "@based/core";
import { ShellSlots, useDB } from "../context.js";
import { AUTOFILL_TYPES, runAutofill, type AutofillProgress } from "../logic/autofill.js";
import { addItem, conditionItem, EMPTY_FILTER, newCondition } from "../logic/filters.js";
import { Confirm, Icon, MenuItem, MenuLabel, MenuSeparator, OptionPill, PROPERTY_ICONS, Popover, type Anchor } from "../ui.js";
import { useResultType } from "./FilterEditor.js";

const DATE_FORMATS: [string, string][] = [["", "Full date"], ["MMM D, YYYY", "Month day, year"], ["MM/DD/YYYY", "Month/Day/Year"], ["DD/MM/YYYY", "Day/Month/Year"], ["YYYY/MM/DD", "Year/Month/Day"], ["YYYY-MM-DD", "ISO"]];
const COLORS = ENUMS.TColor.filter((c) => !c.endsWith("Background"));

export function TypeMenu({ current, onPick }: { current?: string; onPick: (type: string) => void }) {
  return (
    <div className="dbui-menu-scroll" role="menu" aria-label="Property type">
      {ADDABLE_PROPERTY_TYPES.map((t) => (
        <MenuItem key={t} icon={<Icon name={PROPERTY_ICONS[t] ?? "text"} />} selected={t === current} onClick={() => onPick(t)} testID={`type-${t}`}>
          {PROPERTY_TYPE_LABELS[t] ?? t}
        </MenuItem>
      ))}
    </div>
  );
}

function OptionsConfig({ p }: { p: PropertySchema }) {
  const { store, db } = useDB();
  const [name, setName] = useState("");
  const groupOf = (id: string) => p.statusGroups?.find((g) => g.optionIDs.includes(id))?.id;
  return (
    <div className="dbui-config-section">
      <MenuLabel>Options</MenuLabel>
      {(p.options ?? []).map((o) => (
        <div key={o.id} className="dbui-option-config">
          <OptionPill name={o.name} color={o.color} status={p.type === "status"} />
          <input className="dbui-input small" aria-label={`Rename ${o.name}`} defaultValue={o.name}
            onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== o.name) updateOption(store, db.id, p.id, o.id, (x) => { x.name = t; }); }} />
          <select className="dbui-select small" aria-label={`Color of ${o.name}`} value={o.color} onChange={(e) => updateOption(store, db.id, p.id, o.id, (x) => { x.color = e.target.value; })}>
            {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {p.type === "status" && p.statusGroups && (
            <select className="dbui-select small" aria-label={`Group of ${o.name}`} value={groupOf(o.id) ?? ""} onChange={(e) => updateProperty(store, db.id, p.id, (s) => {
              for (const g of s.statusGroups ?? []) g.optionIDs = g.optionIDs.filter((x) => x !== o.id);
              s.statusGroups?.find((g) => g.id === e.target.value)?.optionIDs.push(o.id);
            }, "Move option")}>
              {p.statusGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <button type="button" className="dbui-icon-btn" aria-label={`Delete option ${o.name}`} onClick={() => deleteOption(store, db.id, p.id, o.id)}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <input className="dbui-input" placeholder="Add an option" aria-label="Add an option" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { addOption(store, db.id, p.id, name); setName(""); } }} />
    </div>
  );
}

function FormulaConfig({ p }: { p: PropertySchema }) {
  const { store, db, engine } = useDB();
  const [src, setSrc] = useState(p.formula ?? "");
  const first = engine.store.children("d:" + db.id)[0];
  const err = first ? (engine.valueById(first, p.id), engine.error(first, p.id)) : undefined;
  return (
    <div className="dbui-config-section">
      <MenuLabel>Formula</MenuLabel>
      <textarea className="dbui-input dbui-code" rows={4} aria-label="Formula" value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} />
      <div className="dbui-row-actions">
        <span className="dbui-hint">{db.properties.filter((x) => x.id !== p.id).slice(0, 6).map((x) => `prop("${x.name}")`).join(" · ")}</span>
        <button type="button" className="dbui-btn primary" onClick={() => updateProperty(store, db.id, p.id, (x) => { x.formula = src; }, "Edit formula")}>Done</button>
      </div>
      {err && src === p.formula && <p className="dbui-hint danger" role="alert">{err.message}</p>}
    </div>
  );
}

function RelationConfig({ p }: { p: PropertySchema }) {
  const { store, db } = useDB();
  const rel = p.relation;
  const target = rel ? store.databases.get(rel.databaseID) : undefined;
  const violations = rel?.limitOne ? relationLimitViolations(store, db.id, p.id).length : 0;
  return (
    <div className="dbui-config-section">
      <MenuLabel>Related database</MenuLabel>
      <select className="dbui-select" aria-label="Related database" value={rel?.databaseID ?? ""} onChange={(e) => setRelationTarget(store, db.id, p.id, e.target.value || undefined)}>
        <option value="">Choose…</option>
        {[...store.databases.values()].map((d) => <option key={d.id} value={d.id}>{plainText(d.title) || titleOf(store, d.blockID)}</option>)}
      </select>
      {rel && (
        <>
          <label className="dbui-toggle"><input type="checkbox" checked={rel.limitOne === true} onChange={(e) => setRelationLimitOne(store, db.id, p.id, e.target.checked)} />Limit to 1 page</label>
          {violations > 0 && <p className="dbui-hint">{violations} pages link more than one</p>}
          {rel.syncedPropertyID
            ? <p className="dbui-hint">Shown on {target ? plainText(target.title) || "Untitled" : "?"} as “{target?.properties.find((x) => x.id === rel.syncedPropertyID)?.name}”</p>
            : <button type="button" className="dbui-btn" onClick={() => makeRelationTwoWay(store, db.id, p.id)}>Show on {target ? plainText(target.title) || "Untitled" : "other database"}</button>}
        </>
      )}
    </div>
  );
}

function RollupConfig({ p }: { p: PropertySchema }) {
  const { store, db } = useDB();
  const relations = db.properties.filter((x) => x.type === "relation" && x.relation);
  const cfg = p.rollup;
  const rel = relations.find((x) => x.id === cfg?.relationPropertyID) ?? relations[0];
  const target = rel?.relation ? store.databases.get(rel.relation.databaseID) : undefined;
  const fn = cfg?.function ?? "showOriginal";
  const targetProp = cfg?.targetPropertyID ?? target?.properties[0]?.id ?? "title";
  const save = (relationPropertyID: string, targetPropertyID: string, f: string) => setRollup(store, db.id, p.id, { relationPropertyID, targetPropertyID, function: f });
  if (!rel) return <p className="dbui-hint">Add a relation first.</p>;
  const cycle = wouldCreateRollupCycle(store, db.id, p.id, rel.id, targetProp);
  return (
    <div className="dbui-config-section">
      <label className="dbui-field"><span className="dbui-field-label">Relation</span>
        <select className="dbui-select" aria-label="Rollup relation" value={rel.id} onChange={(e) => save(e.target.value, "title", fn)}>
          {relations.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label className="dbui-field"><span className="dbui-field-label">Property</span>
        <select className="dbui-select" aria-label="Rollup property" value={targetProp} onChange={(e) => save(rel.id, e.target.value, fn)}>
          {(target?.properties ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="dbui-field"><span className="dbui-field-label">Calculate</span>
        <select className="dbui-select" aria-label="Rollup function" value={fn} onChange={(e) => save(rel.id, targetProp, e.target.value)}>
          {Object.entries(CALCULATION_LABELS).filter(([k]) => k !== "none").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {cycle && <p className="dbui-hint danger" role="alert">This rollup would depend on itself.</p>}
      {!cfg && <button type="button" className="dbui-btn" onClick={() => save(rel.id, targetProp, fn)}>Apply</button>}
    </div>
  );
}

/** Einstellungen je Typ (ohne Umbenennen/Typ). */
export function PropertyConfig({ p }: { p: PropertySchema }) {
  const { store, db } = useDB();
  switch (p.type) {
    case "select": case "multiSelect": case "status": return <OptionsConfig p={p} />;
    case "formula": return <FormulaConfig p={p} />;
    case "relation": return <RelationConfig p={p} />;
    case "rollup": return <RollupConfig p={p} />;
    case "number":
      return (
        <label className="dbui-field"><span className="dbui-field-label">Number format</span>
          <select className="dbui-select" aria-label="Number format" value={p.numberFormat ?? "number"} onChange={(e) => updateProperty(store, db.id, p.id, (x) => { if (e.target.value === "number") delete x.numberFormat; else x.numberFormat = e.target.value; }, "Number format")}>
            {NUMBER_FORMATS.map((f) => <option key={f} value={f}>{NUMBER_FORMAT_LABELS[f]}</option>)}
          </select>
        </label>
      );
    case "date": case "createdTime": case "lastEditedTime":
      return (
        <label className="dbui-field"><span className="dbui-field-label">Date format</span>
          <select className="dbui-select" aria-label="Date format" value={p.dateFormat ?? ""} onChange={(e) => updateProperty(store, db.id, p.id, (x) => { if (e.target.value) x.dateFormat = e.target.value; else delete x.dateFormat; }, "Date format")}>
            {DATE_FORMATS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}
          </select>
        </label>
      );
    case "uniqueID":
      return (
        <label className="dbui-field"><span className="dbui-field-label">Prefix</span>
          <input className="dbui-input" aria-label="ID prefix" defaultValue={p.idPrefix ?? ""} onBlur={(e) => updateProperty(store, db.id, p.id, (x) => { const t = e.target.value.trim(); if (t) x.idPrefix = t; else delete x.idPrefix; }, "ID prefix")} />
        </label>
      );
    default: return null;
  }
}

/** Menü am Spaltenkopf bzw. in den Ansichts-Einstellungen. */
export function PropertyMenu({ p, view, anchor, onClose }: { p: PropertySchema; view: DatabaseView; anchor: Anchor; onClose: () => void }) {
  const { store, db, locked } = useDB();
  const rt = useResultType();
  const [page, setPage] = useState<"main" | "type" | "config">("main");
  const [confirm, setConfirm] = useState<{ message: string; label: string; run: () => void } | null>(null);
  const [name, setName] = useState(p.name);
  const isTitle = p.type === "title";
  const { ai } = useContext(ShellSlots);
  const [fill, setFill] = useState<AutofillProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pickType = (type: string) => {
    if (type === p.type) return setPage("main");
    const loss = conversionLoss(store, db.id, p.id, type);
    const run = () => { changePropertyType(store, db.id, p.id, type); setPage("config"); };
    if (loss > 0) setConfirm({ message: `${loss} ${loss === 1 ? "cell" : "cells"} will lose ${loss === 1 ? "its value" : "their values"}. Change the type to ${PROPERTY_TYPE_LABELS[type] ?? type}?`, label: "Change type", run });
    else run();
  };
  const remove = () => {
    const n = filledCellCount(store, db.id, p.id);
    const run = () => { deleteProperty(store, db.id, p.id); onClose(); };
    if (n > 0) setConfirm({ message: `Delete “${p.name}”? ${n} ${n === 1 ? "page has" : "pages have"} a value.`, label: "Delete", run });
    else run();
  };
  return (
    <Popover anchor={anchor} onClose={() => { if (name.trim() && name !== p.name) renameProperty(store, db.id, p.id, name); onClose(); }} className="dbui-property-menu" label={`Property ${p.name}`}>
      {page === "main" && (
        <>
          <div className="dbui-option-field">
            <span className="dbui-menu-icon" aria-hidden><Icon name={PROPERTY_ICONS[p.type] ?? "text"} /></span>
            <input className="dbui-input bare" aria-label="Property name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { renameProperty(store, db.id, p.id, name); } }} />
          </div>
          {!locked && !isTitle && <MenuItem icon={<Icon name="settings" />} onClick={() => setPage("type")} hint={PROPERTY_TYPE_LABELS[p.type] ?? p.type} testID="property-type">Type</MenuItem>}
          {!locked && ["select", "multiSelect", "status", "formula", "relation", "rollup", "number", "date", "createdTime", "lastEditedTime", "uniqueID"].includes(p.type) &&
            <MenuItem icon={<Icon name="settings" />} onClick={() => setPage("config")} testID="property-edit">Edit property</MenuItem>}
          <MenuSeparator />
          <MenuItem icon={<Icon name="arrowUp" />} onClick={() => { setSorts(store, view.id, [{ propertyID: p.id, ascending: true }]); onClose(); }}>Sort ascending</MenuItem>
          <MenuItem icon={<Icon name="arrowDown" />} onClick={() => { setSorts(store, view.id, [{ propertyID: p.id, ascending: false }]); onClose(); }}>Sort descending</MenuItem>
          <MenuItem icon={<Icon name="filter" />} onClick={() => { setFilter(store, view.id, addItem(view.filter ?? EMPTY_FILTER, [], conditionItem(newCondition(p, rt(p))))); onClose(); }}>Filter</MenuItem>
          {p.type !== "button" && <MenuItem icon={<Icon name="group" />} onClick={() => { setGroupBy(store, view.id, { propertyID: p.id }); onClose(); }}>Group</MenuItem>}
          {!isTitle && <MenuItem icon={<Icon name="eyeOff" />} onClick={() => { setPropertyVisible(store, view.id, p.id, false); onClose(); }}>Hide in view</MenuItem>}
          {!locked && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Icon name="plus" />} onClick={() => { addProperty(store, db.id, "Property", "text", { after: p.id, showIn: view.id }); onClose(); }}>Insert right</MenuItem>
              {AUTOFILL_TYPES.has(p.type) && ai?.available() ? (
                fill ? (
                  <MenuItem icon={<Icon name="close" />} onClick={() => abort.current?.abort()} testID="property-autofill-stop">
                    {`Filling ${fill.done} of ${fill.total}… Stop`}
                  </MenuItem>
                ) : (
                  <MenuItem icon={<Icon name="sparkle" />} testID="property-autofill" onClick={() => {
                    const c = new AbortController();
                    abort.current = c;
                    setFill({ done: 0, total: 0, filled: 0 });
                    void runAutofill(store, db, p, ai, c.signal, setFill).finally(() => { setFill(null); onClose(); });
                  }}>Autofill with AI</MenuItem>
                )
              ) : null}
              {!isTitle && <MenuItem icon={<Icon name="copy" />} onClick={() => { duplicateProperty(store, db.id, p.id); onClose(); }}>Duplicate property</MenuItem>}
              {!isTitle && <MenuItem icon={<Icon name="trash" />} danger onClick={remove} testID="property-delete">Delete property</MenuItem>}
            </>
          )}
        </>
      )}
      {page === "type" && (
        <>
          <button type="button" className="dbui-back" onClick={() => setPage("main")}><Icon name="chevronRight" size={12} /> Type</button>
          <TypeMenu current={p.type} onPick={pickType} />
        </>
      )}
      {page === "config" && (
        <>
          <button type="button" className="dbui-back" onClick={() => setPage("main")}><Icon name="chevronRight" size={12} /> {p.name}</button>
          <LiveConfig id={p.id} />
        </>
      )}
      {confirm && <Confirm anchor={anchor} message={confirm.message} confirmLabel={confirm.label} onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </Popover>
  );
}

/** Einstellungen der aktuellen Fassung der Property (nach Typwechsel neu gelesen). */
function LiveConfig({ id }: { id: string }) {
  const { db } = useDB();
  const p = db.properties.find((x) => x.id === id);
  return p ? <><PropertyConfig p={p} /><DescriptionField p={p} /></> : null;
}

function DescriptionField({ p }: { p: PropertySchema }) {
  const { store, db } = useDB();
  return (
    <label className="dbui-field"><span className="dbui-field-label">Description</span>
      <input className="dbui-input" aria-label="Description" defaultValue={p.description ?? ""}
        onBlur={(e) => { const t = e.target.value.trim(); if (t !== (p.description ?? "")) updateProperty(store, db.id, p.id, (x) => { if (t) x.description = t; else delete x.description; }, "Description"); }} />
    </label>
  );
}

/** „+“ im Tabellenkopf: Typ wählen → Property anlegen (sichtbar in dieser Ansicht) → Menü der neuen Property. */
export function AddPropertyMenu({ view, anchor, onClose, onAdded }: { view: DatabaseView; anchor: Anchor; onClose: () => void; onAdded?: (id: string) => void }) {
  const { store, db } = useDB();
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-property-menu" label="New property">
      <MenuLabel>New property</MenuLabel>
      <TypeMenu onPick={(type) => {
        const id = addProperty(store, db.id, PROPERTY_TYPE_LABELS[type] ?? "Property", type, { showIn: view.id });
        onClose();
        if (id) onAdded?.(id);
      }} />
    </Popover>
  );
}
