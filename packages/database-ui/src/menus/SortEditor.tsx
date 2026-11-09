// BSD-155: Sortierung einer Ansicht (mehrere Regeln, Reihenfolge, auf-/absteigend). Schreibt über setSorts.
import { setSorts, type DatabaseView } from "@based/core";
import { useDB } from "../context.js";
import { Icon, Popover, type Anchor } from "../ui.js";

export function SortEditor({ view, anchor, onClose }: { view: DatabaseView; anchor: Anchor; onClose: () => void }) {
  const { store, db } = useDB();
  const sorts = view.sorts ?? [];
  const save = (next: typeof sorts) => setSorts(store, view.id, next);
  const free = db.properties.filter((p) => p.type !== "button" && !sorts.some((s) => s.propertyID === p.id));
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-sort-editor" label="Sorts">
      {sorts.map((s, i) => (
        <div key={s.propertyID} className="dbui-filter-row" data-testid="sort-rule">
          <div className="dbui-reorder">
            <button type="button" className="dbui-icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => { const l = [...sorts]; [l[i - 1], l[i]] = [l[i]!, l[i - 1]!]; save(l); }}><Icon name="arrowUp" size={12} /></button>
            <button type="button" className="dbui-icon-btn" aria-label="Move down" disabled={i === sorts.length - 1} onClick={() => { const l = [...sorts]; [l[i + 1], l[i]] = [l[i]!, l[i + 1]!]; save(l); }}><Icon name="arrowDown" size={12} /></button>
          </div>
          <select className="dbui-select" aria-label="Sort property" value={s.propertyID} onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, propertyID: e.target.value } : x)))}>
            {db.properties.filter((p) => p.id === s.propertyID || free.includes(p)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {!db.properties.some((p) => p.id === s.propertyID) && <option value={s.propertyID}>Deleted property</option>}
          </select>
          <select className="dbui-select" aria-label="Direction" value={s.ascending ? "asc" : "desc"} onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, ascending: e.target.value === "asc" } : x)))}>
            <option value="asc">Ascending</option><option value="desc">Descending</option>
          </select>
          <button type="button" className="dbui-icon-btn" aria-label="Remove sort" onClick={() => save(sorts.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <div className="dbui-row-actions">
        {free.length > 0 && (
          <select className="dbui-select" aria-label="Add sort" value="" onChange={(e) => e.target.value && save([...sorts, { propertyID: e.target.value, ascending: true }])}>
            <option value="">+ Add sort</option>
            {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {sorts.length > 0 && <button type="button" className="dbui-btn ghost danger" onClick={() => save([])}>Delete sort</button>}
      </div>
    </Popover>
  );
}
