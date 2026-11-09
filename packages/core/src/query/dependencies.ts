// BSD-155: Welche Store-Änderungen eine Datenbank-Ansicht betreffen. Ansichten rechnen nur neu, wenn sich
// die eigene Datenbank (Schema, Zeilen, Ansichten) oder eine Datenbank ändert, aus der sie über Relationen
// liest (Titel verknüpfter Seiten, Rollups, Formeln mit `prop("Rel")`).
import type { StoreChange, WorkspaceStore } from "../store/store.js";
import { parseKey } from "../store/store.js";

/** Die Datenbank selbst und alle, die sie über Relationen (transitiv) erreicht. */
export function databaseDependencies(store: WorkspaceStore, databaseID: string): Set<string> {
  const out = new Set<string>();
  const todo = [databaseID];
  while (todo.length) {
    const id = todo.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const db = store.databases.get(id);
    for (const p of db?.properties ?? []) if (p.relation?.databaseID && !out.has(p.relation.databaseID)) todo.push(p.relation.databaseID);
  }
  return out;
}

/**
 * Betrifft `change` eine der Datenbanken in `deps`? Gelöschte Records zählen vorsichtshalber immer
 * (ihr früherer Elternteil ist nicht mehr lesbar); Workspace-Änderungen nie.
 */
export function changeAffects(store: WorkspaceStore, deps: Set<string>, change: StoreChange): boolean {
  for (const key of change.keys) {
    const { kind, id } = parseKey(key);
    switch (kind) {
      case "database": if (deps.has(id)) return true; break;
      case "view": {
        const v = store.views.get(id);
        if (!v || deps.has(v.databaseID)) return true;
        break;
      }
      case "block": {
        const b = store.blocks.get(id);
        if (!b) return true;
        if (b.parent.startsWith("d:") && deps.has(b.parent.slice(2))) return true;
        const own = b.props?.databaseID;
        if (own && deps.has(own) && store.databases.get(own)?.blockID === b.id) return true;
        break;
      }
      default: break;
    }
  }
  return false;
}

/**
 * Beobachtet den Store gefiltert auf eine Datenbank: `onChange` läuft nur bei Änderungen, die ihre
 * Ansichten betreffen. Die Abhängigkeiten werden nach jeder relevanten Änderung neu bestimmt
 * (eine neue Relation macht eine weitere Datenbank relevant). Gibt die Abmeldung zurück.
 */
export function watchDatabase(store: WorkspaceStore, databaseID: string, onChange: (change: StoreChange) => void): () => void {
  let deps = databaseDependencies(store, databaseID);
  return store.observe((change) => {
    if (!changeAffects(store, deps, change)) return;
    deps = databaseDependencies(store, databaseID);
    onChange(change);
  });
}
